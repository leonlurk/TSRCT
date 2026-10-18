#!/usr/bin/env node
'use strict';
// check-setup.js — the .env reader and the installer's pure steps.
//
// The README says `cp .env.example .env`, and the example explains each setting
// with a comment at the end of its line. The server's old reader kept that
// comment as part of the value, so a copied example gave BIND_HOST "127.0.0.1
// # keep it local; ..." and a restricted-projects list whose only name was
// "secretco # comma-separated names". These run the real reader on the real
// example, and the installer's steps on files in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  [x] ' + m); } };

const envFile = require(path.join(ROOT, 'lib', 'envFile'));

// ── the reader, on the example as shipped ───────────────────────────────────
const example = envFile.parse(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'));
ok(example.BIND_HOST === '127.0.0.1', `BIND_HOST reads as "${example.BIND_HOST}"`);
ok(example.TMUX_SESSION === '', `an empty value with a comment reads as empty, not "${example.TMUX_SESSION}"`);
ok(example.WIN_HOME === '', `WIN_HOME must stay empty (it turns the Windows features on), got "${example.WIN_HOME}"`);
for (const [k, v] of Object.entries(example)) ok(!/\s#/.test(v), `${k} kept its comment: "${v}"`);

// ── the reader's edge cases ─────────────────────────────────────────────────
const p = envFile.parse([
    '# a whole-line comment',
    'TOKEN=abc#def',                       // a # with no space before it is part of the value
    'SPACED = value with spaces   # note',
    'QUOTED="has # inside"   # and a note',
    "SINGLE='x # y'",
    'EMPTY=',
    'export EXPORTED=1',
    'not a setting',
].join('\n'));
ok(p.TOKEN === 'abc#def', `a # inside a value survives (${p.TOKEN})`);
ok(p.SPACED === 'value with spaces', `spaces inside a value survive (${p.SPACED})`);
ok(p.QUOTED === 'has # inside', `a quoted value keeps its # (${p.QUOTED})`);
ok(p.SINGLE === 'x # y', `single quotes too (${p.SINGLE})`);
ok(p.EMPTY === '' && p.EXPORTED === '1', 'empty values and "export" lines');
ok(!('not a setting' in p) && Object.keys(p).length === 6, `only settings are read (${Object.keys(p).join(',')})`);

// ── the server reads .env through it ────────────────────────────────────────
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
ok(/require\('\.\/lib\/envFile'\)/.test(server), 'server.js loads .env through lib/envFile.js');

// ── the installer's steps (scripts/setup-lib.js) ────────────────────────────
let setup = null;
try { setup = require(path.join(ROOT, 'scripts', 'setup-lib')); } catch (e) { ok(false, 'scripts/setup-lib.js does not load: ' + e.message); }
if (setup) {
    const t1 = setup.makeToken(), t2 = setup.makeToken();
    ok(t1.length >= 40 && /^[A-Za-z0-9_-]+$/.test(t1) && t1 !== t2, 'a token is long, url-safe and new each time');
    const topic = setup.makeTopic();
    ok(/^tsrct-[a-z0-9]{16,}$/.test(topic), `an ntfy topic is unguessable (${topic})`);

    // Writing .env changes only what was asked and never a value already set.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsrct-setup-'));
    const env = path.join(tmp, '.env');
    fs.writeFileSync(env, 'BRIDGE_TOKEN=keep-me\n# a comment he wrote\nPROJECTS_ROOT=/old\n');
    const r = setup.writeEnv(env, { BRIDGE_TOKEN: 'new', PROJECTS_ROOT: '/new', NTFY_TOPIC: 'tsrct-x' }, { keep: ['BRIDGE_TOKEN'] });
    const after = fs.readFileSync(env, 'utf8');
    ok(/^BRIDGE_TOKEN=keep-me$/m.test(after), 'an existing token is never replaced');
    ok(/^PROJECTS_ROOT=\/new$/m.test(after) && !/\/old/.test(after), 'a setting he chose again is updated in place');
    ok(/^NTFY_TOPIC=tsrct-x$/m.test(after), 'a new setting is added');
    ok(after.includes('# a comment he wrote'), 'his comments stay');
    ok(r.backup && fs.existsSync(r.backup), 'the old file is backed up first');
    ok((fs.statSync(env).mode & 0o077) === 0, '.env is readable by its owner only');

    // The example's placeholder is not a token to keep: a copied .env.example
    // must leave setup with a real one, never the public "change-me" string.
    const fresh = path.join(tmp, '.env.fresh');
    fs.copyFileSync(path.join(ROOT, '.env.example'), fresh);
    setup.writeEnv(fresh, { BRIDGE_TOKEN: 'a-real-token', PROJECTS_ROOT: '/p' }, { keep: ['BRIDGE_TOKEN'] });
    const ft = envFile.parse(fs.readFileSync(fresh, 'utf8'));
    ok(ft.BRIDGE_TOKEN === 'a-real-token', `the example's placeholder token was kept: "${ft.BRIDGE_TOKEN}"`);
    const nb = setup.writeEnv(fresh, { MORNING_AT: '07:00' }, { backup: false });
    ok(nb.backup === null, 'a write asked not to back up makes no copy');

    // Claude Code hooks: added next to his own, never twice, with the real path.
    const settings = path.join(tmp, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ model: 'x', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
    const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude-hooks-config.json'), 'utf8'));
    setup.installHooks(settings, tpl, '/opt/TSRCT');
    setup.installHooks(settings, tpl, '/opt/TSRCT');
    const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const cmds = Object.values(s.hooks).flat().flatMap(h => h.hooks.map(x => x.command));
    ok(s.model === 'x', 'his other settings stay');
    ok(cmds.includes('echo mine'), 'his own hooks stay');
    ok(cmds.filter(c => c.includes('/opt/TSRCT/permission-hook.sh')).length === 1, 'the permission hook is added once, even when run twice');
    ok(!cmds.some(c => c.includes('/path/to/TSRCT')), 'the placeholder path is replaced');
    ok(fs.readdirSync(tmp).some(f => f.startsWith('settings.json.bak-')), 'settings.json is backed up first');
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`[check-setup] ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
