#!/usr/bin/env node
// CLAUDE.md stays short AND keeps every rule that has bitten (cleanup P5 #22).
//
// CLAUDE.md is loaded into every session, so it is for rules and pointers; the long
// write-ups live in DOCUMENTATION.md. Shortening it must never drop a rule: each
// entry below is a sentence a future session needs before it touches that code.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const docs = fs.readFileSync(path.join(ROOT, 'DOCUMENTATION.md'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  [x] ' + msg); } };

const lines = claude.split('\n').length;
ok(lines <= 380, `CLAUDE.md is ${lines} lines (ceiling 380): it is read by every session; move the write-up to DOCUMENTATION.md and keep the rule`);

const MUST_KEEP = [
    ['isRemoteRequest()', 'the only guard in front of the local-only routes'],
    ['default-deny', 'isRemoteRequest must stay default-deny'],
    ['[READY]', 'the launcher waits for this exact line'],
    ['Bedrock only', 'the SecretCo contract'],
    ['assertNotRestricted', 'the SecretCo guard functions'],
    ['A prompt is not a guard', 'why the SecretCo filters exist'],
    ['`toClaude` is OFF by default', 'it once typed into a live session'],
    ['automations.bootLoop()', 'a new loop the [@] tab cannot pause otherwise'],
    ['BOTH key lists', 'layout memory keys'],
    ['`CFG` option', 'the orb is shared with Ghost Runner'],
    ['test-tesla.mjs', 'the runner test for orb changes'],
    ['CACHE_NAME', 'every frontend change bumps the service worker'],
    ['NOT_MINE', 'how route groups work'],
    ['lib/stateFile.js', 'where runtime state lives'],
    ['must be exported', 'functions shared across the desktop files go through window.*'],
    ['DOCUMENTATION.md §9o', 'the pointer to the full Tesla/clock write-up'],
];
for (const [phrase, why] of MUST_KEEP) ok(claude.includes(phrase), `CLAUDE.md lost "${phrase}" (${why})`);
ok(/^## 9o\. /m.test(docs), 'DOCUMENTATION.md has no §9o, so the pointer in CLAUDE.md leads nowhere');

// The two counts CLAUDE.md states, read from the files they describe (round 4:
// it said 33 checks while the suite ran 36).
const all = fs.readFileSync(path.join(__dirname, 'check-all.js'), 'utf8');
const checks = (/const CHECKS = \[([\s\S]*?)\];/.exec(all) || [, ''])[1].match(/'check-[\w-]+'/g) || [];
const said = /\*\*(\d+) checks\*\*/.exec(claude);
ok(said && Number(said[1]) === checks.length, `CLAUDE.md says ${said ? said[1] : 'no number of'} checks, scripts/check-all.js runs ${checks.length}`);
const cache = /CACHE_NAME\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'));
ok(cache && claude.includes(`\`${cache[1]}\``), `CLAUDE.md does not name the current sw.js cache (${cache ? cache[1] : '?'})`);

console.log(`check-docs: ${pass}/${pass + fail} ${fail ? 'FAILED' : 'ok'} - CLAUDE.md ${lines} lines`);
process.exit(fail ? 1 : 0);
