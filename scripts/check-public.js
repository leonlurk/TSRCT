#!/usr/bin/env node
// The release gate: nothing private may be in this repository.
//
// It blocks the names of the private projects, clients and people this code was first
// built around (stored below only as salted fingerprints, so the gate cannot leak them
// itself), personal machine paths, private hostnames, real email addresses and anything
// shaped like a secret. Run on every push. A hit is fixed in the file, never by
// widening this list of exceptions.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FP = s => crypto.createHash('sha256').update('tsrct-public:' + s).digest('hex').slice(0, 16);
const WORDS = new Set(["00742776455253e1","02b6b71bafef3941","11a8de71234765fe","121ba0d1f11db84f","147cd7d06a3496b3","17ea9b6593247305","1a125621000f4df5","22c1af32d972fd42","241f904ef07f0594","2b056fcbf7dc746d","2c112083710a4216","3a444fe8138d1a78","3a996928cbf3c3b0","477ceeb3f0ffe9dd","4ce66274606f6da8","4d4565fe15813315","525a1af4e15ca5ec","673fbf6c7a701841","72fdd1d23a18978b","822a62c6fcc14b97","87da1e94728288ce","88c5bbc3c5dc8a99","8947aa995203ecd5","8a1fc4e3394d03b7","9bbec2f6a5f704b3","9cf7f4d1c571bab1","9e8512fd1cc22127","b3e7f3cb1c67e4cd","b8414a968cf6f6a4","c34faaa91cb2eb55","cbbb6691e215c3eb","d95711ac61df16be","db03f20cfb794499","de2eab6cc60d5f38","e499b996b6082582","e51a47301948eb1b","ec45344d60e04c72","f39b761a7cc59c1a","f843483b3f2b7e7b"]);
const PAIRS = new Set(["1ee63a29d97ac350","3f2353760d29060f","432d93a6d5d3cfce","4a13c39c49172a9b","7f0f1527ccc28ad6","8decbfbe6678330b","a0b5ef79e805d731","a8c71a93138f151b","e6c7b2d306bbf4c8"]);
const PATTERNS = [
    // placeholders allowed: <you>, you, USERNAME and "..." (as in /mnt/c/Users/...)
    ['a personal Windows path', /\/mnt\/c\/Users\/(?!<you>|you\b|USERNAME\b|\.\.\.)[\w.-]+|[A-Z]:\\\\?Users\\\\?(?!<you>|you\b|USERNAME\b|\.\.\.)[\w.-]+/],
    ['a personal home path', /\/home\/(?!user\b|<you>|you\b)[a-z][\w-]*/],
    ['a private hostname', /\b[\w-]+\.ts\.net\b/i],
    // allowed: example.com/.org, and no-reply senders of public services (not a person)
    ['an email address', /(?<![\w.+-])(?!no-?reply@)[\w.+-]+@(?!example\.(?:com|org)\b)[\w-]+\.[a-z]{2,}/i],
    ['a secret', /xox[bpa]-[\w-]{10,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_\w{30,}|BEGIN [A-Z ]*PRIVATE KEY/],
];
const SKIP_DIR = new Set(['.git', 'node_modules']);
const BINARY = /\.(png|jpe?g|gif|ico|ttf|woff2?|mp3|mp4|webm|pdf)$/i;
const SELF = path.relative(ROOT, __filename);

// Only what a push can carry: tracked files plus new ones git would add. Ignored runtime state
// (data/, .tsrct/, logs/) is written by every local run and never leaves the machine; scanning it
// made the gate red on any copy that had been started once.
function published() {
    const r = require('child_process').spawnSync('git', ['ls-files', '-co', '--exclude-standard'],
        { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

function* files(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir ? dir + '/' + e.name : e.name;
        if (SKIP_DIR.has(e.name)) continue;
        if (e.isDirectory()) yield* files(rel);
        else yield rel;
    }
}

const hits = [];
for (const rel of published() || files('')) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;   // deleted but not yet committed
    if (rel === SELF || BINARY.test(rel) || /^src\/js\/vendor\//.test(rel)) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
        // regex escapes (\b, \w, \d...) glue onto the next word: /\bname\b/ must read as "name"
        // and a name glued into an identifier (FooUtils, fooBar) is split at its capitals
        const toks = line.replace(/\\[a-zA-Z]/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) || [];
        toks.forEach((t, k) => {
            if (WORDS.has(FP(t))) hits.push(`${rel}:${i + 1} a private name`);
            if (k > 0 && PAIRS.has(FP(toks[k - 1] + ' ' + t))) hits.push(`${rel}:${i + 1} a private name`);
        });
        for (const [what, re] of PATTERNS) if (re.test(line)) hits.push(`${rel}:${i + 1} ${what}`);
    });
}
const byFile = {};
for (const h of hits) { const f = h.split(':')[0]; byFile[f] = (byFile[f] || 0) + 1; }
const worst = Object.entries(byFile).sort((a, b) => b[1] - a[1]);
for (const [f, n] of worst.slice(0, process.argv.includes('--all') ? 999 : 15)) console.log(`  [x] ${String(n).padStart(4)}  ${f}`);
if (process.argv.includes('--lines')) for (const h of hits) console.log('      ' + h);
console.log(`check-public: ${hits.length ? hits.length + ' private thing(s) in ' + worst.length + ' file(s) FAILED' : 'nothing private ok'}`);
process.exit(hits.length ? 1 : 0);
