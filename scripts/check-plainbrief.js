#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// check-plainbrief.js — the [PB] toggle is only worth having if pressing it
// actually enforces something.
//
// The feature spans two repos' worth of files: the button and the state file
// live here, the two hooks that ENFORCE it live in ~/.claude. Nothing links
// them at runtime except a path string, so either half can be renamed, moved or
// unregistered and the button keeps lighting up while enforcing nothing. That
// is the worst possible failure for a guard -- a toggle that lies -- so this
// check walks the whole chain and fails on the first broken link.
//
// Run: node scripts/check-plainbrief.js   (part of `npm run check`)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOME = os.homedir();
const HOOKS = path.join(HOME, '.claude', 'hooks');
const SKILL = path.join(HOME, '.claude', 'skills', 'plain-brief');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

const problems = [];
const notes = [];

function read(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function must(cond, msg) { if (!cond) problems.push(msg); }

// ── 1. the store ─────────────────────────────────────────────────────────────
const libSrc = read(path.join(ROOT, 'lib', 'plainBrief.js'));
must(libSrc, 'lib/plainBrief.js is missing');
if (libSrc) {
    must(/data['"],\s*['"]plain-brief\.json/.test(libSrc),
        'lib/plainBrief.js no longer writes data/plain-brief.json — the hooks read that exact path');
}

// ── 2. the routes ────────────────────────────────────────────────────────────
const server = require('./serverSource')();
must(/require\(['"]\.\/lib\/plainBrief['"]\)/.test(server),
    'server.js does not require ./lib/plainBrief');
must(server.includes("'/api/plainbrief'"), 'server.js is missing GET /api/plainbrief');
must(server.includes("'/api/plainbrief/toggle'"), 'server.js is missing POST /api/plainbrief/toggle');

// ── 3. the buttons ───────────────────────────────────────────────────────────
const indexHtml = read(path.join(ROOT, 'src', 'index.html')) || '';
must(/id="pb-toggle"[\s\S]{0,200}togglePlainBrief\(\)|togglePlainBrief\(\)[\s\S]{0,200}id="pb-toggle"/.test(indexHtml)
     || (indexHtml.includes('id="pb-toggle"') && indexHtml.includes('togglePlainBrief()')),
    'the mobile [PB] button (#pb-toggle -> togglePlainBrief) is not in index.html');

const appJs = read(path.join(ROOT, 'src', 'js', 'app.js')) || '';
must(/function\s+togglePlainBrief\s*\(/.test(appJs), 'togglePlainBrief() is not defined in app.js');
must(/function\s+refreshPlainBrief\s*\(/.test(appJs), 'refreshPlainBrief() is not defined in app.js');

// desktop.js plus the files cut out of it (cleanup P2 #11)
const desktopJs = ['desktop.js', 'desktop-sessions.js'].map(f => read(path.join(ROOT, 'src', 'js', f)) || '').join('\n');
must(desktopJs.includes('id="pc-pb-toggle"'), 'the desktop [PB] button (#pc-pb-toggle) is not in desktop.js');
must(/refreshPlainBrief/.test(desktopJs),
    'desktop.js never calls refreshPlainBrief() — the button would report the session you just left');

// ── 4. the rules file the gate injects ───────────────────────────────────────
const rules = read(path.join(SKILL, 'RULES.md'));
must(rules, `${SKILL}/RULES.md is missing — the gate injects it verbatim and would inject nothing`);
if (rules) must(rules.trim().length > 200, 'RULES.md is suspiciously short — the gate would inject almost nothing');

// ── 5. the hooks themselves ──────────────────────────────────────────────────
for (const f of ['plain-brief-gate.sh', 'plain-brief-check.sh', 'plain-brief-check.py']) {
    const p = path.join(HOOKS, f);
    if (!fs.existsSync(p)) { problems.push(`hook missing: ${p}`); continue; }
    try {
        fs.accessSync(p, fs.constants.X_OK);
    } catch {
        problems.push(`hook is not executable: ${p}`);
    }
}

// The gate and the check must agree with the store on WHERE the state lives.
for (const f of ['plain-brief-gate.sh', 'plain-brief-check.sh']) {
    const src = read(path.join(HOOKS, f));
    if (src) must(src.includes('data/plain-brief.json'),
        `${f} does not point at data/plain-brief.json — the toggle would write somewhere nothing reads`);
}

// [PB] is plain-brief AND leon-speak (2026-10-05, Leon: "i need that button to
// also require the use of /leon-speak combined"). The gate injects the skill
// file itself, never a copy of it (a copy is the one that goes stale).
const gateSh = read(path.join(HOOKS, 'plain-brief-gate.sh')) || '';
must(gateSh.includes('skills/leon-speak/SKILL.md'), 'plain-brief-gate.sh does not inject leon-speak — [PB] would be plain-brief alone');
must(read(path.join(HOME, '.claude', 'skills', 'leon-speak', 'SKILL.md')), 'the leon-speak skill file is missing — [PB] would inject nothing for it');
// One send-back only: a second squeeze is where the facts got cut.
must(/^MAX_BLOCKS=1$/m.test(read(path.join(HOOKS, 'plain-brief-check.sh')) || ''), 'plain-brief-check.sh sends an answer back more than once');

// jq's `//` falls through on FALSE as well as null, so `.ok // true` silently
// turns every failing verdict into a pass. It shipped that way once; this makes
// sure it cannot come back.
// Comment lines are stripped first: the fix is DOCUMENTED in that file, and
// matching the explanation of a bug as the bug is its own kind of false alarm.
const checkSh = (read(path.join(HOOKS, 'plain-brief-check.sh')) || '')
    .split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
must(!/\.ok\s*\/\/\s*true/.test(checkSh),
    "plain-brief-check.sh uses `.ok // true` — jq treats false as absent, so the gate would pass everything");

// ── 6. registered in settings.json, or none of the above runs ────────────────
let settings = null;
try { settings = JSON.parse(read(SETTINGS) || 'null'); } catch { /* reported below */ }
if (!settings) {
    problems.push(`${SETTINGS} is missing or does not parse`);
} else {
    const commands = (ev) => (settings.hooks?.[ev] || [])
        .flatMap(e => (e.hooks || []).map(h => h.command || ''));
    must(commands('UserPromptSubmit').some(c => c.includes('plain-brief-gate.sh')),
        'plain-brief-gate.sh is not registered under hooks.UserPromptSubmit — the rules would never be injected');
    must(commands('Stop').some(c => c.includes('plain-brief-check.sh')),
        'plain-brief-check.sh is not registered under hooks.Stop — nothing would enforce the cap');
}

// ── 7. the checker still measures what it claims ─────────────────────────────
const selftest = path.join(HOOKS, 'plain-brief-selftest.py');
if (fs.existsSync(selftest)) {
    try {
        const out = execFileSync('python3', [selftest], { encoding: 'utf8' });
        notes.push('[check-plainbrief] ' + out.trim().split('\n').pop());
    } catch (e) {
        problems.push('the checker self-test FAILED:\n' + String(e.stdout || e.message).trim());
    }
} else {
    problems.push(`checker self-test missing: ${selftest}`);
}

// ── report ───────────────────────────────────────────────────────────────────
notes.forEach(n => console.log(n));
if (problems.length) {
    console.error('[check-plainbrief] FAIL — the [PB] toggle would not enforce anything:');
    problems.forEach(p => console.error('  - ' + p));
    process.exit(1);
}
console.log('[check-plainbrief] OK — button, route, store, rules file, both hooks and their registration');
