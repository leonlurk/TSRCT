#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/check-restricted.js — the SecretCo contract must not erode.
//
// Run: node scripts/check-restricted.js        (exit 0 = clean, 1 = a guard is missing)
//
// WHY THIS EXISTS
// The contract (SecretCo/SecretCoSandbox is AWS-Bedrock-only) is enforced by convention:
// a human remembers to call restrictedGuard at each egress point. The 2026-08-14 audit
// showed how that decays -- guards were applied FORWARD ONLY. The newest route was
// exemplary while its twin from 1400 lines earlier had nothing, the analyst's
// completion and propose paths each had a check but the worklog / digest /
// note-route paths (same `claude -p`, same session) had none, and one comment
// described a guard that did not exist in the code at all.
//
// So this asserts the STRUCTURE, not the behaviour: that the choke points still
// exist and that no route family has grown a new member that bypasses them. It
// cannot prove a guard is correct -- the runtime tests do that -- but it does
// catch the failure mode that actually happens, which is someone adding route
// number 19 and not knowing there were 18.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const problems = [];
const notes = [];

// ── 1. the guard must be required standalone, not via the optional dispatcher ──
const server = require('./serverSource')();
if (!/^const restrictedGuard = require\('\.\/lib\/dispatcher\/restrictedGuard'\);/m.test(server)) {
    problems.push('server.js: restrictedGuard must be required at top level on its own — a security boundary must not depend on the dispatcher having loaded');
}

// ── 2. every /api/git/* route resolves its directory through gitCwd() ──
const lines = server.split('\n');
const gitRoutes = [];
let current = null;
for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/pathname === '(\/api\/git\/[^']+)'|pathname\.match\(\/\^\\\/api\\\/git\\\/([^)]*)\)/);
    if (m) { current = { route: m[1] || m[2], line: i + 1, guarded: false }; gitRoutes.push(current); }
    // a route ends at the next route branch of any kind
    else if (/pathname === '\/api\//.test(lines[i])) current = null;
    if (current && /gitCwd\(res,/.test(lines[i])) current.guarded = true;
}
for (const r of gitRoutes) {
    if (!r.guarded) problems.push(`server.js:${r.line}: ${r.route} does not call gitCwd(res, …) — its cwd is unguarded`);
}
// A floor, so the check cannot pass by finding nothing: on 2026-10-17 the routes moved to
// lib/routes/ and this read "0 routes, 0 guarded" - and passed.
if (gitRoutes.length < 18) problems.push(`only ${gitRoutes.length} /api/git/* routes found (there are 18): the scan is not reading the code where the routes live`);
notes.push(`${gitRoutes.length} /api/git/* routes, ${gitRoutes.filter(r => r.guarded).length} guarded`);
// and nobody may compute a git directory the old way
const raw = lines.filter((l) => /const gitPwd = getSessionPwd\(/.test(l)).length;
if (raw) problems.push(`server.js: ${raw} route(s) still derive gitPwd via getSessionPwd() directly — use gitCwd(res, …)`);

// ── 3. sf routes take their alias through sfAlias() ──
const sfSites = lines.filter((l) => /sfAlias\(res,/.test(l) && !/function sfAlias/.test(l)).length;
if (sfSites < 6) problems.push(`server.js: only ${sfSites} sfAlias(res, …) call sites — expected at least 6 (query, apex, workspace add-org, org health/open/login)`);
const rawAlias = lines.filter((l) => /alias\.replace\(\/\[\^a-zA-Z0-9_-\]/.test(l)).length;
if (rawAlias) problems.push(`server.js: ${rawAlias} site(s) sanitize an sf alias without the SecretCo check — use sfAlias(res, …)`);
notes.push(`${sfSites} sf alias sites guarded`);

// ── 4. the model-dispatch choke points ──
const mustGuard = [
    ['lib/dispatcher/clickupAnalyst.js', 'submitJob', 'every analyst job kind reaches `claude -p` here'],
    // 2026-09-30: worklogs may now CREATE a ClickUp task from a model-written name,
    // and the list catalogue is handed to the analyst job file and the browser.
    ['lib/dispatcher/clickupSync.js', 'createTask', 'a model-suggested task name/description is written to ClickUp here'],
    ['lib/dispatcher/clickupSync.js', 'listCatalogue', 'the list names reach the analyst job file and an HTTP response'],
    // promptPolisher: DELETED 2026-09-19 with the Slack intake pipeline (its UI
    // lived in the DISPATCHER tab). It dispatched `claude -p` on a non-Bedrock
    // session, so if a polisher comes back, it comes back with a guard and a
    // line here.
    // submitFollowup: DELETED 2026-09-19 with the reconciler. It inlined a LIVE
    // PANE CAPTURE into a prompt bound for the public API — the richest SecretCo
    // leak in the dispatcher — so if a follow-up polisher ever comes back, it
    // comes back with a guard and a line here.
];
for (const [file, fn, why] of mustGuard) {
    const src = read(file);
    const i = src.indexOf(`function ${fn}(`);
    if (i < 0) { problems.push(`${file}: ${fn}() not found — did it move? the guard assertion cannot be verified`); continue; }
    // the guard must appear in the first ~25 lines of the body, i.e. before the work
    const body = src.slice(i).split('\n').slice(0, 25).join('\n');
    if (!/restrictedGuard\.(assertNotRestricted|mentionsRestricted)\(/.test(body)) {
        problems.push(`${file}: ${fn}() has no restrictedGuard call at the top — ${why}`);
    }
}

// ── 4b. push notifications carry real content, so send() is an egress ──
// The guard must be INSIDE send(), not only in the route: the scheduler and the
// morning routine call the module directly, and a route-only check protects the
// one caller that happens to be an HTTP request.
{
    const src = read('lib/push.js');
    if (!/^const restrictedGuard = require\('\.\/dispatcher\/restrictedGuard'\);/m.test(src)) {
        problems.push("lib/push.js: restrictedGuard must be required standalone — a boundary cannot depend on the dispatcher");
    }
    const i = src.indexOf('async function send(');
    if (i < 0) problems.push('lib/push.js: send() not found — the push choke point cannot be verified');
    else {
        const body = src.slice(i).split('\n').slice(0, 15).join('\n');
        if (!/payloadIsRestricted\(/.test(body)) {
            problems.push('lib/push.js: send() does not check payloadIsRestricted() before sending — a notification now carries real detail');
        }
    }
    if (!/JSON\.stringify\(payload/.test(src)) {
        problems.push('lib/push.js: payloadIsRestricted() must scan the WHOLE payload, not a list of known fields');
    }
    notes.push('push send() guarded');
}

// ── 4c. TALK is a conversation, so BOTH directions are egress ──
// What he says goes into the local model; what the model says comes back over
// HTTP and is then spoken. The question, the history and the answer are three
// separate places the contract can leak, and the history one is the easy miss:
// a mention three turns back is still in the payload of every later turn.
{
    const src = read('lib/talk.js');
    if (!/^const restrictedGuard = require\('\.\/dispatcher\/restrictedGuard'\);/m.test(src)) {
        problems.push("lib/talk.js: restrictedGuard must be required standalone — a boundary cannot depend on the dispatcher");
    }
    // The turn itself is askTurn() since 2026-10-03; ask() only wraps it to log
    // the turn (lib/teslaLog.js) and must not grow a path around it.
    const i = src.indexOf('async function askTurn(');
    if (i < 0) problems.push('lib/talk.js: askTurn() not found — the TALK choke point cannot be verified');
    else if (!/r = await askTurn\(opts\)/.test(src.slice(src.indexOf('async function ask('), i))) {
        problems.push('lib/talk.js: ask() no longer goes through askTurn() — the guarded turn can be bypassed');
    }
    else {
        // To the NEXT top-level function, not a fixed number of characters: ask()
        // grew when TALK learned to attach to a session and a 3000-char window
        // stopped reaching the answer scan, which reported a guard that was
        // right there as missing. A check that cries wolf gets ignored.
        const rest = src.slice(i + 1);
        const end = rest.search(/\n(?:async )?function \w/);
        const body = end < 0 ? rest : rest.slice(0, end);
        if (!/assertNotRestricted\(/.test(body)) {
            problems.push('lib/talk.js: ask() does not assertNotRestricted() on what was said before sending it to the local model');
        }
        if (!/mentionsRestricted\(reply\)/.test(body)) {
            problems.push('lib/talk.js: ask() does not scan the model ANSWER — it is spoken and returned over HTTP');
        }
    }
    const h = read('lib/dispatcher/hermes.js');
    const j = h.indexOf('function ollamaChat(');
    if (j < 0) problems.push('hermes.js: ollamaChat() not found');
    else if (!/history/.test(h.slice(j, j + 600))) {
        problems.push('hermes.js: ollamaChat() guards system+user but not `history` — TALK sends prior turns with every call');
    }
    notes.push('talk ask() + history guarded');

    // 2026-09-19: TALK can be ATTACHED to a tmux session, which adds a third
    // direction — the PANE ITSELF goes to the model. /api/output is deliberately
    // open (driving the secretco pane from TSRCT is the sanctioned workflow), and
    // that is only safe while every path from a pane to a model is closed. This
    // is one of those paths, so it is checked by name, twice: the session, and
    // what is on its screen.
    const k = src.indexOf('function screenOf(');
    if (k < 0) {
        problems.push('lib/talk.js: screenOf() not found — the pane-to-model path cannot be verified');
    } else if (!/assertNotRestricted\(/.test(src.slice(k, k + 1200))) {
        problems.push('lib/talk.js: screenOf() hands a captured pane to the local model without assertNotRestricted()');
    }
    const g = src.indexOf('function sessionGuard(');
    if (g < 0) {
        problems.push('lib/talk.js: sessionGuard() not found — an attached session name is unchecked');
    } else if (!/assertNotRestricted\(/.test(src.slice(g, g + 600))) {
        problems.push('lib/talk.js: sessionGuard() does not refuse an SecretCo session by name');
    }
    const w = src.indexOf('async function watchTick(');
    // To the next top-level function, not a fixed window — same lesson as ask()
    // above: watchTick grew (the half-hour ceiling went in at the top) and a
    // character count reported a guard that was right there as missing.
    const wRest = w < 0 ? '' : src.slice(w + 1);
    const wEnd = wRest.search(/\n(?:async )?function \w/);
    const wBody = wEnd < 0 ? wRest : wRest.slice(0, wEnd);
    if (w < 0) {
        problems.push('lib/talk.js: watchTick() not found — the unattended narrator cannot be verified');
    } else if (!/mentionsRestricted\(reply\)/.test(wBody)) {
        problems.push('lib/talk.js: watchTick() speaks a narration it never scanned — nobody asked for that one, so nobody is reading it');
    }
    notes.push('talk session screen + name + watcher guarded');

    // 2026-09-19: the spoken narration is also handed the PROJECT's vault note,
    // its Decisions Log section and its last session log. Those are documents,
    // not panes — exactly what the contract is for — and they are selected by a
    // folder name that comes from a tmux session. Refused by name before a file
    // is opened, and the assembled block scanned after.
    const pmSrc = read('lib/projectMemory.js');
    if (!/^const restrictedGuard = require\('\.\/dispatcher\/restrictedGuard'\);/m.test(pmSrc)) {
        problems.push("lib/projectMemory.js: restrictedGuard must be required standalone");
    }
    const f = pmSrc.indexOf('function forProject(');
    if (f < 0) {
        problems.push('lib/projectMemory.js: forProject() not found — the vault-to-model path cannot be verified');
    } else {
        const body = pmSrc.slice(f, f + 1600);
        if (!/mentionsRestricted\(name\)/.test(body)) {
            problems.push('lib/projectMemory.js: forProject() opens vault files without refusing an SecretCo project by name');
        }
        if (!/mentionsRestricted\(blob\)/.test(body)) {
            problems.push('lib/projectMemory.js: forProject() does not scan the assembled vault text — a note can mention it even when the project does not');
        }
    }
    notes.push('project memory (vault note + decisions + session log) guarded');
}

// ── 4d. the ring fans ONE message out to TWO third parties ──
// ntfy.sh and Google, repeatedly. Both senders guard themselves, but a ring that
// starts and is only refused per-send would still have been scheduled, so the
// refusal belongs before the first one.
{
    const src = read('lib/ring.js');
    if (!/^const restrictedGuard = require\('\.\/dispatcher\/restrictedGuard'\);/m.test(src)) {
        problems.push("lib/ring.js: restrictedGuard must be required standalone");
    }
    const i = src.indexOf('async function start(');
    if (i < 0) problems.push('lib/ring.js: start() not found — the ring choke point cannot be verified');
    else if (!/assertNotRestricted\(/.test(src.slice(i, i + 1200))) {
        problems.push('lib/ring.js: start() does not assertNotRestricted() before the first ring leaves');
    }
    notes.push('ring start() guarded');
}

// ── 5. the runner (the unguarded twin of /api/hf/start) ──
const runnerIdx = server.indexOf("pathname === '/api/runner/start'");
if (runnerIdx < 0) problems.push('server.js: /api/runner/start not found');
else if (!/restrictedGuard\.mentionsRestricted\(/.test(server.slice(runnerIdx, runnerIdx + 2000))) {
    problems.push('server.js: /api/runner/start has no SecretCo check — a runner is a shell in an arbitrary cwd under the shared $HOME');
}

// ── 6. the PROJECTOR (2026-10-12): a browser a public-API session drives ──
// What it shows reaches his window, and what `read`/`look` print reaches that
// Claude session. Registration, listing, streaming and the CLI each refuse SecretCo.
{
    const lib = read('lib/projector.js');
    if (!/^const restrictedGuard = require\('\.\/dispatcher\/restrictedGuard'\);/m.test(lib)) problems.push('lib/projector.js: restrictedGuard must be required standalone');
    for (const fn of ['function register(', 'function sourcesFor(', 'async function watch(']) {
        const i = lib.indexOf(fn);
        if (i < 0) problems.push(`lib/projector.js: ${fn} not found`);
        else if (!/mentionsRestricted\(/.test(lib.slice(i, i + 900))) problems.push(`lib/projector.js: ${fn}) has no SecretCo check`);
    }
    if (!/Page\.frameNavigated[\s\S]{0,200}isBlocked\(/.test(lib)) problems.push('lib/projector.js: a navigation into SecretCo mid-stream is not checked');
    const cli = read('scripts/projector.js');
    for (const fn of ['function urlProblem(', 'function sessionName(', 'async function guardPage(']) {
        const i = cli.indexOf(fn);
        if (i < 0) problems.push(`scripts/projector.js: ${fn} not found`);
        else if (!/mentionsRestricted\(/.test(cli.slice(i, i + 700))) problems.push(`scripts/projector.js: ${fn}) has no SecretCo check`);
    }
    for (const fn of ['function uploadable(', 'async function download(']) {
        const i = cli.indexOf(fn);
        if (i < 0) problems.push(`scripts/projector.js: ${fn} not found`);
        else if (!/mentionsRestricted\(/.test(cli.slice(i, i + 700))) problems.push(`scripts/projector.js: ${fn}) has no SecretCo check`);
    }
    notes.push('projector (register/list/stream/CLI/upload/download) guarded');
}

// ── 7. session lists handed to a model (review #15, 2026-10-13) ──
// With `secretco-doc` open, its NAME rode in every Tesla question and the guard in
// askIn refused them all. The guard was right; the list must not carry the name.
{
    const server = require('./serverSource')();
    const lists = server.match(/sessions: \(\) => \{[\s\S]{0,400}?list-sessions[^\n]*\n?[^\n]*/g) || [];
    if (lists.length < 2) problems.push(`server.js: expected the talk and promptWriter session lists, found ${lists.length}`);
    for (const l of lists) if (!/mentionsRestricted\(n\)/.test(l)) problems.push('server.js: a session list handed to Tesla/promptWriter does not drop SecretCo names');
    if (!/Sesiones abiertas ahora: \$\{\(sessions \|\| \[\]\)\.filter\(n => !restrictedGuard\.mentionsRestricted\(n\)\)/.test(read('lib/haikuBrain.js')))
        problems.push('lib/haikuBrain.js: "Sesiones abiertas ahora" does not drop SecretCo names');
    notes.push('session lists drop SecretCo names');
}

// ── report ──
console.log(`[check-restricted] ${notes.join(' · ')}`);
if (!problems.length) {
    console.log('[check-restricted] OK — every known egress point still carries its guard');
    process.exit(0);
}
for (const p of problems) console.error('  [!] ' + p);
console.error(`[check-restricted] ${problems.length} problem(s). See CLAUDE.md "The SecretCo contract".`);
process.exit(1);
