#!/usr/bin/env node
// Runs every check, one after the other, and fails at the END.
//
// `npm run check` used to chain them with `&&`, so the first red one hid every
// check after it: on 2026-10-16 a date-dependent test in check-automations kept
// nine checks from running at all, and the suite still read as "one failure".
// A check that is not in this list does not run - add new ones here.
// check-projector-live stays out on purpose: it starts a real browser.
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const CHECKS = [
    'check-syntax', 'check-setup',
    'check-taste', 'check-assets', 'check-handlers', 'check-restricted', 'check-paneshape',
    'check-plainbrief', 'check-push', 'check-persona', 'check-actions', 'check-talk',
    'check-ui', 'check-automations', 'check-brain', 'check-tesla-log',
    'check-appkey', 'check-desk', 'check-desk-paths',
    'check-projector', 'check-layout', 'check-routes', 'check-state', 'check-css', 'check-size', 'check-dead', 'check-colors', 'check-docs', 'check-turns', 'check-functions', 'check-route-calls', 'check-public',
];

// --fast (the pre-commit hook) skips what is slow; the full run stays the gate.
const SLOW = new Set(['check-brain']);   // 60 of the suite's ~75 s (measured 2026-10-16)
const fast = process.argv.includes('--fast');
const run = fast ? CHECKS.filter(c => !SLOW.has(c)) : CHECKS;

const verbose = process.argv.includes('--verbose');
const failed = [];
for (const name of run) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(__dirname, name + '.js')], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 0;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${ok ? '[+]' : '[x]'} ${name} (${secs}s)`);
    if (!ok || verbose) {
        const lines = out.trimEnd().split('\n');
        console.log(lines.slice(ok ? -1 : -30).map(l => '      ' + l).join('\n'));
    }
    if (!ok) failed.push(name);
}

console.log(`\n${run.length - failed.length}/${run.length} checks green` +
    (fast ? ` (fast: skipped ${[...SLOW].join(', ')})` : '') +
    (failed.length ? ` - FAILED: ${failed.join(', ')}` : ''));
process.exit(failed.length ? 1 : 0);
