#!/usr/bin/env node
// A dead-code RATCHET (cleanup round 4, 2026-10-24).
//
// Two counts, each with a ceiling:
//   exports  - a name in a lib/ module's `module.exports` that no OTHER file reads
//              (as `.name`, `['name']` or destructured from a require). Checks count
//              as readers: a constant exported for a test is not dead.
//   loaded   - a member of server.js's `dispatcher` / `studio` objects that nothing
//              reads as `.member`: a module required at every boot for nobody.
// The match is generous (any `.name` anywhere counts as a use), so a count here is
// a floor of what is dead, never an overstatement. A count may go down freely;
// above its ceiling is red. Lower a ceiling when you delete; raising one is a
// decision - write down why next to the number. `--list` prints the names.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CEILINGS = {
    exports: 139,  // measured 2026-10-24 (public copy)
    // measured 2026-10-24: priorityScorer, claudePolish (Slack half deleted
    // 2026-09-19), outputParser, promptTemplates (required directly where used)
    loaded: 4,
};
const LIST = process.argv.includes('--list');

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(js|mjs|html)$/.test(f) && !f.includes('vendor/') && fs.existsSync(path.join(ROOT, f)));
const text = new Map(files.map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));

const esc = (s) => s.replace(/[$]/g, '\\$');
function readElsewhere(name, except, extraSkip) {
    const dot = new RegExp(`\\.${esc(name)}\\b|\\[['"]${esc(name)}['"]\\]`);
    const destructured = new RegExp(`\\{[^}]*\\b${esc(name)}\\b[^}]*\\}\\s*=\\s*(?:require|S\\b|deps\\b)`);
    for (const [f, t] of text) {
        if (f === except) continue;
        const body = extraSkip ? t.replace(extraSkip, '') : t;
        if (dot.test(body) || destructured.test(body)) return true;
    }
    return false;
}

// The comma-separated entries of an object literal's body, ignoring the commas
// inside a method or a nested object (`getX(a, b) { ... }` is one entry).
function topLevelParts(body) {
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of body) {
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    return parts;
}

// exports
const deadExports = [];
for (const f of files.filter(f => f.startsWith('lib/') && f.endsWith('.js'))) {
    const m = /module\.exports\s*=\s*\{([\s\S]*?)\};/.exec(text.get(f));
    if (!m) continue;
    const names = new Set();
    for (const part of topLevelParts(m[1].replace(/\/\/[^\n]*/g, ''))) {
        const n = /^\s*(?:get\s+)?([A-Za-z_$][\w$]*)/.exec(part);
        if (n && n[1] !== 'get') names.add(n[1]);
    }
    for (const n of names) if (!readElsewhere(n, f)) deadExports.push(`${f}: ${n}`);
}

// loaded
const deadLoaded = [];
const server = text.get('server.js');
// The public copy has no studio, so a missing object is skipped; finding neither
// means this scan read nothing, which must not pass as "nothing is dead".
let found = 0;
for (const obj of ['dispatcher', 'studio']) {
    const block = new RegExp(`\\b${obj}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`).exec(server);
    if (!block) continue;
    found++;
    const members = [...block[1].matchAll(/^\s*(\w+)\s*:\s*require\(/gm)].map(x => x[1]);
    for (const n of members) {
        // the member's own `name: require(...)` line is not a read
        if (!readElsewhere(n, null, new RegExp(`^\\s*${n}\\s*:\\s*require\\([^)]*\\),?`, 'gm'))) deadLoaded.push(`${obj}.${n}`);
    }
}
if (!found) { console.log('  [x] found neither the dispatcher nor the studio object in server.js'); process.exit(1); }

let fail = 0;
for (const [kind, list] of [['exports', deadExports], ['loaded', deadLoaded]]) {
    const max = CEILINGS[kind];
    if (list.length > max) { fail++; console.log(`  [x] ${kind}: ${list.length} unused, ceiling ${max}: delete the new unused code, or use it (node scripts/check-dead.js --list)`); }
    else if (list.length < max) console.log(`  [i] ${kind}: ${list.length} unused, ceiling ${max}: lower the ceiling to ${list.length}`);
    if (LIST) for (const x of list) console.log(`      ${x}`);
}
console.log(`check-dead: exports ${deadExports.length}/${CEILINGS.exports}, loaded ${deadLoaded.length}/${CEILINGS.loaded}${fail ? ' FAILED' : ''}`);
process.exit(fail ? 1 : 0);
