#!/usr/bin/env node
// Runtime state lives in ONE place, <repo>/.tsrct/ (cleanup P3 #15).
//
// Nine modules kept their state as .tsrct-<name>.json at the repo root, next to
// `.tsrct/` and `data/`: three homes for the same kind of file. lib/stateFile.js
// gives each its path inside .tsrct/ and, the first time, MOVES the old root file
// there, so nothing he set up (clients config, scheduler history, setups) is lost.
// The launcher's own files (.tsrct-boot.log, .tsrct-boot.lock, .tsrct-appid) stay at
// the root: PowerShell and bash read them before node is up.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  [x] ' + msg); } };

// ── every module asks lib/stateFile.js for its path ───────────────────────
const MODULES = [
    ['lib/automations.js', 'automations.json'],
    ['lib/clientHealth.js', 'clients.json'],
    ['lib/clientHealth.js', 'clients-config.json'],
    ['lib/morningRoutine.js', 'morning.json'],
    ['lib/progressReport.js', 'progress.json'],
    ['lib/scheduler.js', 'scheduler.json'],
    ['lib/setups.js', 'setups.json'],
    ['lib/shopWatch.js', 'shopwatch.json'],
    ['server.js', 'prompt-jobs.jsonl'],
];
for (const [file, name] of MODULES) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const legacy = '.tsrct-' + name;
    ok(src.includes(`stateFile('${name}', '${legacy}')`),
        `${file} must keep ${name} in .tsrct/ (stateFile('${name}', '${legacy}')), or his ${name} stays loose at the repo root`);
    ok(!new RegExp(`path\\.join\\([^)]*'${legacy.replace(/\./g, '\\.')}'\\)`).test(src),
        `${file} still builds the old root path ${legacy}: two places for the same state`);
}

// ── the helper: moves the old file once, never overwrites, invents nothing ──
let stateFile = null;
try { stateFile = require(path.join(ROOT, 'lib/stateFile.js')); } catch (e) { /* reported below */ }
ok(stateFile && typeof stateFile.stateFile === 'function', 'lib/stateFile.js must exist and export stateFile() (the three checks below cannot run without it)');
if (stateFile && typeof stateFile.stateFile === 'function') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsrct-state-'));
    try {
        // 0. Only the SERVER moves files. Anything else that loads these modules (the
        //    checks, the pre-commit hook, a script) uses the copy that exists and moves
        //    nothing: on 2026-10-16 the suite moved three files out from under the
        //    running server, which still read them at the root until its restart.
        stateFile.configure({ root: tmp, migrate: false });
        fs.writeFileSync(path.join(tmp, '.tsrct-progress.json'), 'P');
        const inPlace = stateFile.stateFile('progress.json', '.tsrct-progress.json');
        ok(inPlace === path.join(tmp, '.tsrct-progress.json') && fs.existsSync(inPlace),
            'outside the server an old root file is used where it is and NOT moved, or a check pulls it out from under the running server');
        ok(stateFile.stateFile('none.json', '.tsrct-none.json') === path.join(tmp, '.tsrct', 'none.json'),
            'outside the server, with no old file, the path is the new one');
        fs.rmSync(path.join(tmp, '.tsrct-progress.json'), { force: true });
        fs.rmSync(path.join(tmp, '.tsrct'), { recursive: true, force: true });
        stateFile.configure({ root: tmp, migrate: true });
        // 1. an old root file is moved, content intact
        fs.writeFileSync(path.join(tmp, '.tsrct-scheduler.json'), '{"jobs":{"x":1}}');
        const p = stateFile.stateFile('scheduler.json', '.tsrct-scheduler.json');
        ok(p === path.join(tmp, '.tsrct', 'scheduler.json'), `the path must be .tsrct/scheduler.json, got ${p}`);
        ok(fs.existsSync(p) && fs.readFileSync(p, 'utf8') === '{"jobs":{"x":1}}',
            'the old scheduler history must arrive in .tsrct/ byte for byte, or his job history is lost on the first start');
        ok(!fs.existsSync(path.join(tmp, '.tsrct-scheduler.json')), 'the old root file must be gone after the move, or two copies drift apart');
        // 2. both exist: the one written LAST wins, because something is still writing
        //    it. The case is real: the running (old) server keeps writing the root file
        //    after a check has already moved it, until TSRCT restarts.
        const setT = (f, s) => fs.utimesSync(f, s, s);
        fs.mkdirSync(path.join(tmp, '.tsrct'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.tsrct', 'setups.json'), 'MOVED-EARLIER');
        fs.writeFileSync(path.join(tmp, '.tsrct-setups.json'), 'WRITTEN-SINCE');
        setT(path.join(tmp, '.tsrct', 'setups.json'), 1000); setT(path.join(tmp, '.tsrct-setups.json'), 2000);
        stateFile.stateFile('setups.json', '.tsrct-setups.json');
        ok(fs.readFileSync(path.join(tmp, '.tsrct', 'setups.json'), 'utf8') === 'WRITTEN-SINCE',
            'a root copy written AFTER the move must win, or what the old server saved before the restart is lost');
        ok(!fs.existsSync(path.join(tmp, '.tsrct-setups.json')), 'and the root copy is gone once it has been taken');
        fs.writeFileSync(path.join(tmp, '.tsrct', 'clients.json'), 'CURRENT');
        fs.writeFileSync(path.join(tmp, '.tsrct-clients.json'), 'STALE');
        setT(path.join(tmp, '.tsrct', 'clients.json'), 2000); setT(path.join(tmp, '.tsrct-clients.json'), 1000);
        stateFile.stateFile('clients.json', '.tsrct-clients.json');
        ok(fs.readFileSync(path.join(tmp, '.tsrct', 'clients.json'), 'utf8') === 'CURRENT',
            'an OLDER root copy must never overwrite the file in .tsrct/');
        ok(!fs.existsSync(path.join(tmp, '.tsrct-clients.json')), 'and the stale root copy is cleared, so it cannot win later');
        // 3. neither exists: a path, and no file conjured up
        const q = stateFile.stateFile('morning.json', '.tsrct-morning.json');
        ok(q === path.join(tmp, '.tsrct', 'morning.json') && !fs.existsSync(q), 'no state file is created out of nothing');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

console.log(`check-state: ${pass}/${pass + fail} ${fail ? 'FAILED' : 'ok'}`);
process.exit(fail ? 1 : 0);
