#!/usr/bin/env node
'use strict';
// npm run setup — set TSRCT up step by step, asking before every change.
//
// What it does, in order: checks what you already have; offers to install what
// is missing (showing the exact command first) or opens the page where you do
// it yourself; writes .env (a fresh random token, your folders, your time
// zone); adds TSRCT's hooks to Claude Code next to your own; then asks, one by
// one, about the optional parts. Every file it changes is backed up first, and
// it is safe to run again: what is done is skipped.
//
//   --dry-run   say what would happen, change nothing
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const lib = require('./setup-lib');
const checks = require('./setup-checks');

const DRY = process.argv.includes('--dry-run');
const ROOT = checks.ROOT;
const say = (s = '') => console.log(s);

// ── asking ─────────────────────────────────────────────────────────────────
// Answers are queued as lines arrive, so typed or piped input both work, and a
// question asked after the input ended gets its default instead of hanging.
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
let waiting = null, closed = false;
rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(''); } });
function ask(q, def = '') {
    process.stdout.write(`${q}${def ? ` [${def}]` : ''} `);
    const got = (a) => { const v = String(a).trim(); if (closed && !v) say(''); return v || def; };
    if (lines.length) { const a = lines.shift(); say(a); return Promise.resolve(got(a)); }
    if (closed) return Promise.resolve(got(''));
    return new Promise(res => { waiting = (a) => res(got(a)); });
}
async function yes(q, def = false) {
    const a = (await ask(`${q} (y/n)`, def ? 'y' : 'n')).toLowerCase();
    return a.startsWith('y') || a.startsWith('s');
}

// ── doing ──────────────────────────────────────────────────────────────────
function runCmd(cmd) {
    say(`    $ ${cmd.join(' ')}`);
    if (DRY) { say('    (dry run: not run)'); return true; }
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
    return r.status === 0;
}

function openUrl(url) {
    const p = checks.platform();
    const cmd = p.wsl ? ['cmd.exe', '/c', 'start', '', url] : p.mac ? ['open', url] : ['xdg-open', url];
    say(`    opening ${url}`);
    if (DRY) return;
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' });
    if (r.status !== 0) say(`    could not open a browser here: open ${url} yourself`);
}

// Offer the fix for one check, then look again.
async function offerFix(c, recheck) {
    say(`\n[!] ${c.title}${c.detail ? ' - ' + c.detail : ''}`);
    if (c.fix.note) say(`    ${c.fix.note}`);
    if (c.fix.cmd && await yes('    Run this command now?', true)) runCmd(c.fix.cmd);
    else if (c.fix.url && await yes('    Open the page in your browser?', true)) {
        openUrl(c.fix.url);
        await ask('    Press Enter when you are done');
    }
    const again = recheck().find(x => x.id === c.id);
    say(again && again.ok ? '    [*] done' : '    [-] still missing: you can come back to it with `npm run setup`');
}

// ── the steps ──────────────────────────────────────────────────────────────
async function stepPrograms() {
    say('\n== 1. Programs TSRCT needs ==');
    for (const c of checks.all().core.filter(x => ['node', 'tmux', 'claude', 'git'].includes(x.id))) {
        if (c.ok) say(`[*] ${c.title}`); else await offerFix(c, () => checks.all().core);
    }
}

function guessWinHome() {
    const r = spawnSync('cmd.exe', ['/c', 'echo', '%USERNAME%'], { encoding: 'utf8' });
    const user = (r.stdout || '').trim();
    return user && !user.includes('%') && fs.existsSync(`/mnt/c/Users/${user}`) ? `/mnt/c/Users/${user}` : '';
}

async function stepSettings() {
    say('\n== 2. Settings (.env) ==');
    const file = checks.ENV_FILE;
    const had = checks.settings();
    if (!had && !DRY) fs.copyFileSync(path.join(ROOT, '.env.example'), file);
    const cur = checks.settings() || {};
    const values = { BRIDGE_TOKEN: lib.makeToken() };
    say('A long random password (BRIDGE_TOKEN) is created for you. You log in with it from this machine.');
    values.PROJECTS_ROOT = await ask('Folder that holds your projects:', cur.PROJECTS_ROOT && !cur.PROJECTS_ROOT.includes('/you/') ? cur.PROJECTS_ROOT : path.dirname(ROOT));
    values.VAULT_ROOT = cur.VAULT_ROOT && !cur.VAULT_ROOT.includes('/you/') ? cur.VAULT_ROOT : path.join(values.PROJECTS_ROOT, 'vault');
    values.TZ = await ask('Your time zone (the scheduler reads local time):', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    say('Restricted projects are never sent to any AI service and never leave this machine (a client under NDA, for example).');
    const restricted = await ask('Their names, comma-separated (Enter for none):', cur.RESTRICTED_PROJECTS === 'secretco' ? '' : (cur.RESTRICTED_PROJECTS || ''));
    values.RESTRICTED_PROJECTS = restricted;
    if (checks.platform().wsl) {
        const win = await ask('Your Windows user folder, for the PC features (Enter to skip):', cur.WIN_HOME || guessWinHome());
        values.WIN_HOME = win;
    }
    values.HEADLESS_DIR = cur.HEADLESS_DIR && !cur.HEADLESS_DIR.includes('/you/') ? cur.HEADLESS_DIR : path.join(os.homedir(), 'headless-chrome');
    if (DRY) { say(`    (dry run: would write ${Object.keys(values).join(', ')} to ${file})`); return; }
    // Back up only a file that was his before this run, not the copy just made.
    const r = lib.writeEnv(file, values, { keep: ['BRIDGE_TOKEN'], backup: !!had });
    say(`[*] ${file} written${r.backup ? ` (old copy: ${path.basename(r.backup)})` : ''}`);
}

async function stepHooks() {
    say('\n== 3. Claude Code hooks ==');
    const c = checks.all().core.find(x => x.id === 'hooks');
    if (c.ok) { say('[*] already installed'); return; }
    say('These let TSRCT see each session\'s permission requests so you can approve them from your phone.');
    say('They are added to ~/.claude/settings.json next to anything you already have (a backup is made).');
    if (!await yes('Add them?', true)) return;
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    if (DRY) { say(`    (dry run: would add the hooks to ${file})`); return; }
    const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude-hooks-config.json'), 'utf8'));
    const r = lib.installHooks(file, tpl, ROOT);
    say(`[*] ${r.added} hook(s) added${r.backup ? ` (old copy: ${path.basename(r.backup)})` : ''}`);
}

async function optPhone() {
    const topic = lib.makeTopic();
    say(`    Your private alert channel: ${topic} (keep it to yourself: anyone who knows it can read it)`);
    if (!DRY) lib.writeEnv(checks.ENV_FILE, { NTFY_SERVER: 'https://ntfy.sh', NTFY_TOPIC: topic }, { keep: ['NTFY_TOPIC'], backup: false });
    if (await yes('    Open the ntfy app page to install it on your phone?', true)) openUrl('https://ntfy.sh/app');
    say('    In the app, subscribe to the channel shown above (or the one already in your .env).');
}

async function optMorning() {
    const at = await ask('    At what time? (24h)', '06:00');
    if (!DRY) lib.writeEnv(checks.ENV_FILE, { MORNING_ENABLED: '1', MORNING_AT: at }, { backup: false });
    say('    It uses Claude Code\'s connectors (mail, calendar, task tools) that you have connected.');
}

async function stepOptional() {
    say('\n== 4. Optional parts ==  (each one is a yes or no; nothing breaks if you say no)');
    for (const c of checks.all().optional) {
        if (c.ok) { say(`[*] ${c.title}${c.detail ? ' - ' + c.detail : ''}`); continue; }
        if (!await yes(`\nSet up: ${c.title}?`)) continue;
        if (c.id === 'ntfy') await optPhone();
        else if (c.id === 'morning') await optMorning();
        else await offerFix(c, () => checks.all().optional);
    }
}

function finish() {
    const r = checks.all();
    const missing = r.core.filter(c => !c.ok);
    say('\n== Done ==');
    if (missing.length) say(`Still missing: ${missing.map(c => c.title).join('; ')}. Run npm run doctor to see how to fix each one.`);
    const port = (r.env && r.env.BRIDGE_PORT) || 3847;
    say(`Start it:  node server.js   then open http://127.0.0.1:${port} and log in with the BRIDGE_TOKEN in .env`);
    say('Before you use it from another device: set up Windows Hello / a passkey in TSRCT, or add the');
    say('2-factor key the server prints on its first start to your authenticator app.');
    say('Check everything again any time: npm run doctor');
}

(async () => {
    say('TSRCT setup' + (DRY ? ' (dry run: nothing will change)' : ''));
    say('Every step asks first. Ctrl+C stops at any point; what is done stays done.');
    await stepPrograms();
    await stepSettings();
    await stepHooks();
    await stepOptional();
    finish();
    rl.close();
})().catch(e => { console.error('\nsetup stopped: ' + e.message); rl.close(); process.exit(1); });
