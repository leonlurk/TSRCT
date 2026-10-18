#!/usr/bin/env node
'use strict';
// ── Every declared button must still be a real button ───────────────────────
//
// lib/actions.js is the list of things a model is allowed to ask for. A list of
// capabilities written by hand drifts away from the code within weeks — the
// function gets renamed, the module gets deleted, and the catalogue goes on
// advertising something that no longer exists. Then the model picks it, the
// call throws, and the assistant says "no pude" for a reason nobody can see.
//
// Leon's requirement, and the reason this file exists: "valida cada botoncito
// que le habilites contra el codigo de TSRCT."
//
// So each action declares `verify: { fn: 'path/to/file.js:exportName' }`, and
// this asserts the module loads and the export is a function. It also asserts
// the shape of the catalogue itself: every argument has a known type, every
// action that changes something is marked `confirm`, and the manifest handed to
// the model leaks nothing but names.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const actions = require(path.join(ROOT, 'lib/actions.js'));

let failures = 0;
const fail = (m) => { console.error(`  [x] ${m}`); failures++; };
let checks = 0;
const ok = () => { checks++; };

const names = new Set();
for (const a of actions.CATALOG) {
    // ── identity ──
    if (!a.name || !/^[a-z][a-z0-9_]*$/.test(a.name)) { fail(`bad action name: ${a.name}`); continue; }
    if (names.has(a.name)) fail(`duplicate action: ${a.name}`); else ok();
    names.add(a.name);
    if (!a.says || a.says.length < 10) fail(`${a.name}: "says" is what the model matches a sentence against — it cannot be this short`);
    else ok();
    if (typeof a.run !== 'function') fail(`${a.name}: has no run()`); else ok();
    // A write action must be able to ASK about the specific thing it will do.
    // "do you want me to type something into a session?" is not a question a
    // person can answer safely; "send 'run the tests' to harbor" is.
    if (!a.readOnly && typeof a.confirmSays !== 'function') {
        fail(`${a.name}: changes something but has no confirmSays(args) — its confirmation would name the capability, not the act`);
    } else if (!a.readOnly) ok();

    // ── every argument has a type the gate knows how to refuse ──
    for (const [key, type] of Object.entries(a.args || {})) {
        const t = type.endsWith('?') ? type.slice(0, -1) : type;
        if (!actions.TYPES[t]) fail(`${a.name}.${key}: unknown type "${t}" — the gate could not validate it`);
        else ok();
    }

    // ── THE POINT: the code it names still exists ──
    // A button that lives in the PAGE names a handler instead of a module
    // export, and scripts/check-ui.js is what proves that handler exists and
    // still reaches a real global. Here it only has to have declared one.
    if (a.verify && a.verify.ui) {
        if (typeof a.verify.ui !== 'string') fail(`${a.name}: verify.ui no nombra un handler`); else ok();
        continue;
    }
    if (!a.verify || !a.verify.fn) { fail(`${a.name}: declares no verify.fn — it cannot be checked against the code`); continue; }
    const [rel, fnName] = String(a.verify.fn).split(':');
    let mod;
    try {
        mod = require(path.join(ROOT, rel));
    } catch (e) {
        fail(`${a.name}: ${rel} does not load (${e.message.split('\n')[0]})`);
        continue;
    }
    if (typeof mod[fnName] !== 'function') {
        fail(`${a.name}: ${rel} has no exported function "${fnName}" — the button points at nothing`);
    } else ok();
}

// ── the manifest must not leak the machinery ──
const m = actions.manifest();
if (m.length !== actions.CATALOG.length) fail('manifest() drops actions'); else ok();
for (const entry of m) {
    for (const k of Object.keys(entry)) {
        if (!['name', 'says', 'args', 'confirm', 'choices'].includes(k)) {
            fail(`manifest exposes "${k}" — the model is shown names and plain words, never internals`);
        }
    }
    const src = actions.CATALOG.find(a => a.name === entry.name);
    if (entry.confirm !== !src.readOnly) fail(`${entry.name}: confirm flag does not match readOnly`);
    else ok();
}

// ── a write action must never run unconfirmed ──
(async () => {
    const write = actions.CATALOG.find(a => !a.readOnly);
    if (write) {
        // Args are intentionally empty: the gate must refuse BEFORE the action
        // runs, whichever way it refuses.
        let ran = false;
        const realRun = write.run;
        write.run = () => { ran = true; };
        try { await actions.run(write.name, {}, {}); } catch (e) { /* refusing is a pass */ }
        write.run = realRun;
        if (ran) fail(`${write.name} executed without confirmation — a write action must not`);
        else ok();
    }

    // ── an invented action goes nowhere ──
    try {
        await actions.run('definitely_not_a_real_action', {}, { confirmed: true });
        fail('an unknown action name did not throw — the allowlist is not closed');
    } catch (e) { ok(); }

    // A missing argument must come back as a question a person can be asked — it
    // once reached him as: A 'opensession' le falta project.
    for (const a of actions.CATALOG) {
        const required = Object.entries(a.args).filter(([, t]) => !t.endsWith('?'));
        if (!required.length) continue;
        try {
            actions.validate(a.name, {});
            fail(`${a.name}: ran validation with no arguments and did not complain`);
        } catch (e) {
            if (!e.missing || e.missing.key !== required[0][0]) fail(`${a.name}: a missing argument is not reported as .missing`);
            else if (e.message.includes(a.name) || e.message.includes(required[0][0])) fail(`${a.name}: the question leaks an internal name: "${e.message}"`);
            else ok();
        }
    }

    // ── actions.js must CALL its dependencies correctly ──
    // `nextSessionName(name)` type-checked, resolved, and still crashed at run time
    // ("exists is not a function") because it takes the existence test as a second
    // argument. Nothing here runs the actions, so nothing caught it until he did.
    {
        const REAL = {
            tmux: require('../lib/dispatcher/tmuxAdapter'),
            sessionSpawn: require('../lib/sessionSpawn'),
            projectRegistry: require('../lib/projectRegistry'),
            projectMemory: require('../lib/projectMemory'),
            morningRoutine: require('../lib/morningRoutine'),
            permissionDesk: require('../lib/permissionDesk'),
            sessionWeight: require('../lib/sessionWeight'),
            usage: require('../lib/usage'),
            paneKeys: require('../lib/paneKeys'),
        };
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'actions.js'), 'utf8');
        const call = /deps\.([A-Za-z]+)\.([A-Za-z]+)\s*\(/g;
        let m;
        while ((m = call.exec(src))) {
            const [, mod, fn] = m;
            const real = REAL[mod];
            if (!real) continue;                       // gpu and friends: nothing to compare against
            if (typeof real[fn] !== 'function') { fail(`actions.js calls deps.${mod}.${fn}(), which ${mod} does not export`); continue; }
            // count the arguments at this call site
            let i = call.lastIndex, depth = 1, args = 0, seen = false, q = null;
            for (; i < src.length && depth > 0; i++) {
                const c = src[i];
                if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
                if (c === '"' || c === "'" || c === '`') { q = c; seen = true; continue; }
                if ('([{'.includes(c)) { depth++; seen = true; continue; }
                if (')]}'.includes(c)) { depth--; if (depth > 0) seen = true; continue; }
                if (c === ',' && depth === 1) { args++; continue; }
                if (!/\s/.test(c)) seen = true;
            }
            if (seen) args++;
            if (args < real[fn].length) fail(`actions.js calls deps.${mod}.${fn}() with ${args} argument(s); it requires ${real[fn].length}`);
            else ok();
        }
    }

    // ── BULK (2026-09-24): many sessions, one yes, and only what he agreed to ──
    {
        const desk = require('../lib/permissionDesk');
        const keys = require('../lib/paneKeys');
        const q = new Map();
        const card = (id, session, command) => q.set(id, { id, session, tool: 'Bash', command, status: 'pending', timestamp: Date.now() + q.size });
        card('a', 'harbor', 'npm test'); card('b', 'tsrct', 'git status');
        desk.configure({ queue: () => q });
        const live = ['harbor', 'tsrct', 'pv', 'ro', 'billy', 'wr'];
        const sent = [];
        const tmuxCalls = [];
        keys.configure({ tmux: (args) => { tmuxCalls.push(args); return ''; }, serverSession: () => 'tsrct' });
        actions.configure({
            tmux: { listSessions: () => live.map(name => ({ name, cwd: '/x/' + name })), captureSession: () => '', sendToSession: (s, t) => sent.push([s, t]) },
            permissionDesk: desk, paneKeys: keys, sessionWeight: { all: () => ({ sessions: [{ session: 'pv', ctx: 150000, level: 'heavy' }] }) },
        });
        // "aproba todo": asks once, naming both cards
        const r1 = await actions.run('answer_permissions', { decision: 'si' }, {});
        if (!r1.needsConfirm || !/aprobar 2 permisos/.test(r1.says) || !/npm test/.test(r1.says)) fail(`answer_permissions question: ${JSON.stringify(r1.says)}`); else ok();
        // a card that arrives AFTER the question is not one he agreed to
        card('c', 'pv', 'rm -rf build');
        const r2 = await actions.run('answer_permissions', r1.args, { confirmed: true });
        if (q.get('a').decision !== 'approve' || q.get('b').decision !== 'approve') fail('the two cards he was asked about were not approved'); else ok();
        if (q.get('c').decision) fail('a card that arrived after his yes was decided too'); else ok();
        if (!/Aprobe 2/.test(r2.value.plain)) fail(`answer_permissions said ${r2.value.plain}`); else ok();
        // "todas" across six sessions is allowed where it is cheap...
        try { const v = actions.validate('stop_sessions', { session: 'todas' }); if (v.args.session.length !== 6) fail('stop_sessions "todas" did not reach all six'); else ok(); }
        catch (e) { fail('stop_sessions "todas" with six open: ' + e.message); }
        // ...and still capped where each one costs a Claude
        try { actions.validate('refresh_sessions', { session: 'todas' }); fail('refresh_sessions accepted six at once'); } catch (e) { if (e.askAgain) ok(); else fail('refresh_sessions cap: ' + e.message); }
        // the overview sorts them without a model
        const ov = await actions.run('sessions_overview', {}, {});
        if (!/piden permiso: pv/.test(ov.value.plain) || !/pesadas: pv/.test(ov.value.plain)) fail(`overview: ${ov.value.plain}`); else ok();
        // slash to many: typed literally, then Enter, per pane
        tmuxCalls.length = 0;
        await actions.run('slash_to_sessions', { session: 'harbor, pv', cmd: '/compact' }, { confirmed: true });
        const lit = tmuxCalls.filter(a => a.includes('-l') && a.includes('/compact')).length;
        if (lit !== 2) fail(`slash_to_sessions typed /compact into ${lit} panes, not 2`); else ok();
        // the brains, SecretCo and TSRCT's own session are refused below the gate too
        for (const [fn, why] of [[() => keys.press('tesla-general', ['Escape']), 'a hidden brain'], [() => keys.press('secretco', ['Escape']), 'SecretCo']]) {
            try { fn(); fail(`paneKeys pressed a key in ${why}`); } catch { ok(); }
        }
        if (keys.rename('tsrct', 'x').ok) fail('paneKeys renamed the server session'); else ok();
        // verdict hears him
        for (const [said, want] of [['aprobalos', 'approve'], ['si', 'approve'], ['rechazalos', 'deny'], ['no', 'deny']]) {
            if (actions.TYPES.verdict(said) !== want) fail(`verdict("${said}") != ${want}`); else ok();
        }
    }

    // ── a send that worked is reported as sent ──
    // The REAL tmuxAdapter.sendToSession returns undefined on success and throws on
    // failure. The stub above returned a number, so nobody saw that "undefined" was
    // read as "not sent" - and Tesla said "No le llego" after every send (2026-09-25).
    {
        actions.configure({ tmux: { listSessions: () => [{ name: 'harbor', cwd: '/x/harbor' }, { name: 'pv', cwd: '/x/pv' }], captureSession: () => '', sendToSession: () => undefined } });
        const one = await actions.run('say_to_session', { session: 'harbor', text: 'corre los tests' }, { confirmed: true });
        if (!one.value || one.value.sent !== true) fail(`say_to_session reported a send that worked as ${JSON.stringify(one.value)}`); else ok();
        const many = await actions.run('say_to_sessions', { session: 'harbor, pv', text: 'corran los tests' }, { confirmed: true });
        if (!many.value || !many.value.ok) fail(`say_to_sessions reported sends that worked as ${JSON.stringify(many.value)}`); else ok();
    }

    // ── the buttons `hands` showed were missing (2026-09-25) ──
    {
        const os = require('os');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'past-'));
        process.env.CLAUDE_PROJECTS_DIR = root;
        delete require.cache[require.resolve('../lib/pastSessions')];
        const past = require('../lib/pastSessions');
        const cwd = '/x/PROJECTS/HARBOR';
        const dir = past.dirFor(cwd);
        fs.mkdirSync(dir, { recursive: true });
        const conv = (name, rows, age) => {
            const f = path.join(dir, `${name}.jsonl`);
            fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
            const t = Date.now() / 1000 - age; fs.utimesSync(f, t, t);
        };
        const u = (text, ts) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
        const a = (text, ts) => ({ type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
        conv('real', [u('prepara la demo para Paul', '2026-09-24T20:00:00Z'), a('Lista.', '2026-09-24T20:01:00Z'),
            u('This session is being continued from a previous conversation...', '2026-09-24T21:00:00Z'), u('/compact', '2026-09-24T21:01:00Z'),
            a('La demo quedo limpia, falta el mensaje a Paul.', '2026-09-24T21:05:00Z')], 300);
        conv('brain', [u('Sesion: harbor (termino y esta esperando)\nUltimo de su pantalla', 'x'), a('ok', 'x')], 100);
        conv('hands', [u('TAREA DE TESLA hands-1. Leon se la pidio', 'x'), a('RESULTADO {}', 'x')], 50);
        const got = past.forFolder({ project: 'HARBOR', cwd });
        if (got.length !== 1 || got[0].id !== 'real') fail(`past sessions did not skip Tesla's own: ${JSON.stringify(got.map(g => g.id))}`); else ok();
        if (!got[0] || got[0].asked !== 'prepara la demo para Paul' || !/falta el mensaje a Paul/.test(got[0].answer)) fail(`past session read wrong: ${JSON.stringify(got[0])}`); else ok();
        try { past.forFolder({ project: 'SecretCoSandbox', cwd: '/x/PROJECTS/SecretCoSandbox' }); fail('past sessions listed an SecretCo folder'); } catch { ok(); }
        fs.rmSync(root, { recursive: true, force: true });

        const started = [];
        actions.configure({ teslaHands: { start: (o) => { started.push(o); return { key: 'k', model: 'Sonnet', changes: false }; } } });
        await actions.run('day_status', {}, {});
        await actions.run('store_messages', {}, {});
        const d = await actions.run('draft_reply', { person: 'Jacqueline', about: 'que le ayudo a pagar' }, {});
        const [ds, sm, dr] = started;
        if (!ds || ds.recipe !== 'day_status' || ds.changes || !/Gmail/.test(ds.task) || !/ClickUp/.test(ds.task)) fail(`day_status recipe: ${JSON.stringify(ds)}`); else ok();
        if (!sm || sm.recipe !== 'store_messages' || !/mailer\.shopify\.com/.test(sm.task)) fail(`store_messages recipe: ${JSON.stringify(sm)}`); else ok();
        if (!dr || dr.changes || !/NO lo mandes/.test(dr.task) || !/Jacqueline/.test(dr.task) || d.needsConfirm) fail(`draft_reply must be read-only and never send: ${JSON.stringify(dr)}`); else ok();
    }

    // ── the router is shown EVERY project, not the first 40 ──
    // 47 projects alphabetically put "tsrct" at 43, and a slice(0, 40) meant Tesla
    // told him TSRCT was not a project (2026-09-24).
    {
        const many = Array.from({ length: 60 }, (_, i) => `p${String(i).padStart(2, '0')}`).concat('tsrct');
        actions.configure({ projectRegistry: { list: () => many.map(project => ({ project, known: true })) } });
        const open = actions.manifest().find(a => a.name === 'open_session');
        if (!open || !open.choices.project || !open.choices.project.includes('tsrct')) fail('open_session choices cut the project list short - "tsrct" (61st) is missing');
        else ok();
        const talkSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'talk.js'), 'utf8');
        if (/choices\[k\]\.slice\(/.test(talkSrc)) fail('talk.js catalogueText slices the choices again - Haiku would not see every project');
        else ok();
    }

    // ── one list of sessions per manifest (Tesla review #6, 2026-10-09) ─────
    // TSRCT froze 2-3.5 s every time Tesla opened or answered with no session
    // attached (logs/stalls.jsonl, 4 times in 10 min, no slow child process
    // recorded): manifest() asked tmux for the session list once PER ARGUMENT
    // that takes a session, and the registry for the projects once per project
    // argument - each call small, all of them blocking the one server thread.
    {
        let tmuxLists = 0, registryLists = 0;
        actions.configure({
            tmux: { listSessions: () => { tmuxLists++; return [{ name: 'harbor' }, { name: 'pv' }]; }, captureSession: () => '', sendToSession: () => undefined },
            projectRegistry: { list: () => { registryLists++; return [{ project: 'harbor', known: true }]; } },
        });
        const m = actions.manifest();
        if (!m.length) fail('manifest() came back empty');
        else if (tmuxLists > 1 || registryLists > 1) fail(`one manifest asked tmux for the sessions ${tmuxLists} times and the registry ${registryLists} times (must be once each)`);
        else ok();
        const open = m.find(a => a.name === 'open_session');
        // Tesla review #8 (2026-10-09 22:01-22:17, on his run): "puedes aprobarlos" ->
        // "no tengo TSRCT abierto adelante" - approve_permission is a SCREEN button,
        // and from the runner app there is no screen. Six permissions went through
        // "mandale si" instead, ~20 of his turns. One session's permission is now
        // approved from the server: its card if there is one, else the dialog on its
        // screen (Enter, the first option - the screen button's own key), and only
        // when a dialog is really there.
        {
            const one = actions.CATALOG.find(a => a.name === 'approve_session_permission');
            if (!one) fail('there is no server-side action to approve one session\'s permission');
            else {
                const dialog = ['  Bash command', '    grep -rn "rutina" vault/projects/running-log.md', '  Do you want to proceed?', '  ❯ 1. Yes', '    2. Yes, and don\'t ask again for grep commands', '    3. No, and tell Claude what to do differently (esc)'].join('\n');
                const pressed = [];
                let screen = dialog, cards = [];
                actions.configure({
                    tmux: { listSessions: () => [{ name: 'personal-runner-app' }], captureSession: () => screen, sendToSession: () => undefined },
                    paneKeys: { press: (s, k) => { pressed.push([s, ...k]); return true; } },
                    permissionDesk: { pending: () => cards, decide: (ids, d) => cards.filter(c => ids.includes(c.id)).map(c => ({ ...c, decision: d })), describe: (c) => c.tool },
                });
                if (one.readOnly) fail('approving a permission changes something: it must ask first');
                const r1 = await one.run({ session: 'personal-runner-app' });
                if (pressed.length !== 1 || pressed[0][0] !== 'personal-runner-app' || pressed[0][1] !== 'Enter') fail(`a dialog on screen is answered with Enter on that session (pressed ${JSON.stringify(pressed)})`);
                else ok();
                pressed.length = 0; screen = '❯ ahora decime que sigue'; cards = [];
                const r2 = await one.run({ session: 'personal-runner-app' });
                if (pressed.length || !/no (veo|hay)/i.test((r2 && r2.plain) || '')) fail(`no dialog and no card: nothing is pressed, and it says so (got ${JSON.stringify(r2)}, pressed ${pressed.length})`);
                else ok();
                cards = [{ id: 'c1', session: 'personal-runner-app', tool: 'Bash' }];
                const r3 = await one.run({ session: 'personal-runner-app' });
                if (pressed.length || !(r3 && r3.decided && r3.decided.length === 1)) fail(`a TSRCT card is decided through the desk, never by a key (got ${JSON.stringify(r3)})`);
                else ok();
                void r1;
            }
        }
        // Tesla review #7 (2026-10-09 21:20): "doce de las trece sesiones te estan
        // esperando: ... run-ghost-runner, tesla-general" - her own hidden brain and
        // the runner app's server counted as his work.
        actions.configure({
            tmux: { listSessions: () => [{ name: 'harbor' }, { name: 'tesla-general' }, { name: 'run-ghost-runner' }, { name: 'ro-atelier-1' }], captureSession: () => '', sendToSession: () => undefined },
            permissionDesk: { pending: () => [] }, sessionWeight: null,
        });
        const ov = actions.CATALOG.find(a => a.name === 'sessions_overview').run({});
        const names = (ov.sessions || []).map(r => r.session);
        if (names.join(',') !== 'harbor') fail(`sessions_overview lists ${names.join(', ')} - only his own sessions belong there`);
        else ok();
        if (!open || !open.choices || !(open.choices.project || []).includes('harbor')) fail('the project names still reach the manifest');
        else ok();
    }

    // ── fifteen at once (Tesla review, 2026-10-14) ──
    // "mandales a cada una" reached 4 of 16, and "abrilas todas de nuevo" (15) was
    // answered "cuales 4?". A send goes to all; a big open runs in the background,
    // one at a time, says when it is done, and skips an SecretCo name instead of
    // refusing the other fourteen.
    {
        const live = Array.from({ length: 16 }, (_, i) => ({ name: `s${i + 1}x`, cwd: '/x' }));
        const projs = Array.from({ length: 15 }, (_, i) => `proj${String.fromCharCode(97 + i)}`);
        const spawned = []; const said = [];
        let inFlight = 0, maxInFlight = 0;
        actions.configure({
            tmux: { listSessions: () => live, captureSession: () => '', sendToSession: () => undefined, sessionExists: () => false },
            projectRegistry: { list: () => projs.map(p => ({ project: p })), resolve: (p) => ({ project: p, cwd: `/x/${p}` }) },
            sessionSpawn: {
                nextSessionName: (b) => b + '-2',
                createPrimedSession: async ({ name }) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(r => setTimeout(r, 2)); inFlight--; spawned.push(name); return { ok: true }; },
            },
            say: (l) => said.push(l),
        });
        const all = await actions.run('say_to_sessions', { session: 'todas', text: 'actualiza la doc' }, { confirmed: true });
        if (!all.value || (all.value.sent || []).length !== 16) fail(`a send to all 16 sessions reached ${(all.value && all.value.sent || []).length}`); else ok();

        const v = actions.validate('open_session', { project: [...projs, 'secretco-sand'] });
        if (v.args.project.length !== 15) fail(`15 projects + an SecretCo one validated to ${v.args.project.length}`); else ok();
        if (!/de a una/.test(v.action.confirmSays(v.args))) fail('a big batch does not say it opens one by one'); else ok();
        const r = await actions.run('open_session', { project: projs, name: projs.map(p => `old-${p}`) }, { confirmed: true });
        if (!r.value || r.value.queued !== 15 || !r.value.say) fail(`a 15-session open did not answer at once: ${JSON.stringify(r.value)}`); else ok();
        for (let i = 0; i < 200 && !said.length; i++) await new Promise(res => setTimeout(res, 5));
        if (spawned.length !== 15) fail(`the batch opened ${spawned.length} of 15`); else ok();
        if (maxInFlight !== 1) fail(`the batch opened ${maxInFlight} at the same time`); else ok();
        if (spawned[0] !== 'old-proja') fail(`per-session names were not kept: ${spawned[0]}`); else ok();
        if (!said.length || !/abri 15 de 15/.test(said[0])) fail(`the end of the batch was not spoken: ${said[0]}`); else ok();
        actions.configure({ say: null });
    }

    // ── reopen as they were (2026-10-14) ──
    // Name, folder and conversation come from lib/sessionFolders.js; "todas" is the
    // ones that closed together, and each resumes its own conversation.
    {
        const os = require('os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-'));
        const file = path.join(dir, 'sf.json');
        const now = Date.now();
        const id = (n) => `0000000${n}-0000-0000-0000-000000000000`;
        fs.writeFileSync(file, JSON.stringify({
            alive: { cwd: '/x/a', at: now },
            nrsite: { cwd: '/x/nrsite', sessionId: id(1), at: now - 60000 },
            gaap: { cwd: '/x/ledgerly-quirks', sessionId: id(2), at: now - 30000 },
            old: { cwd: '/x/old', sessionId: id(3), at: now - 5 * 3600 * 1000 },
        }));
        process.env.TSRCT_SESSION_FOLDERS = file;
        delete require.cache[require.resolve('../lib/sessionFolders')];
        delete require.cache[require.resolve('../lib/actions')];
        const acts = require('../lib/actions');
        const cmds = [];
        acts.configure({
            tmux: { listSessions: () => [{ name: 'alive' }], captureSession: () => '', sessionExists: () => false },
            sessionSpawn: { nextSessionName: (b) => b + '-2', createPrimedSession: async (o) => { cmds.push(o); return { ok: true }; } },
        });
        const v = acts.validate('reopen_sessions', { session: 'todas' });
        const got = v.args.session.map(r => r.name).sort().join(',');
        if (got !== 'gaap,nrsite') fail(`"todas" reopened ${got} - only the ones that closed together`); else ok();
        // His "si" re-runs the action with the args the question was built from,
        // which are the ROWS, not his words (Tesla review 2026-10-15: "si" twice,
        // "No tengo ninguna sesion cerrada con ese nombre" twice, nothing reopened).
        const asked = await acts.run('reopen_sessions', { session: 'todas' });
        let again = null;
        try { again = acts.validate('reopen_sessions', asked.args); } catch (e) { again = e; }
        const againNames = again && again.args ? again.args.session.map(r => r.name).sort().join(',') : String(again && again.message);
        if (againNames !== 'gaap,nrsite') fail(`his yes to "reabrir todas" was answered: ${againNames}`); else ok();
        await acts.run('reopen_sessions', asked.args, { confirmed: true });
        const g =cmds.find(c => c.name === 'gaap');
        if (!g || g.cwd !== '/x/ledgerly-quirks' || g.command !== `claude --resume ${id(2)}` || g.prompt) fail(`gaap was not reopened in its folder with its conversation: ${JSON.stringify(g)}`); else ok();
        // While a batch is opening, asking again says so instead of "no la encuentro".
        let release; const slow = new Promise(r => { release = r; });
        acts.configure({ say: () => {}, projectRegistry: { list: () => [{ project: 'proja' }], resolve: (p) => ({ project: p, cwd: '/x/' + p }) }, sessionSpawn: { nextSessionName: (b) => b + '-2', createPrimedSession: async () => { await slow; return { ok: true }; } } });
        const many = ['a1', 'a2', 'a3', 'a4', 'a5'].map(n => n);
        await acts.run('open_session', { project: many.map(() => 'proja') }, { confirmed: true }).catch(() => null);
        let busy = null;
        try { acts.validate('reopen_sessions', { session: 'la 13 de a 1' }); } catch (e) { busy = e; }
        if (!busy || !/estoy abriendo/.test(busy.message)) fail(`a repeat during a batch was answered "${busy && busy.message}"`); else ok();
        release();
        for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 5));
        const one = acts.validate('reopen_sessions', { session: 'old' });
        if (one.args.session[0].name !== 'old') fail('a named closed session was not found'); else ok();
        delete process.env.TSRCT_SESSION_FOLDERS;
    }

    if (failures) {
        console.error(`\n[check-actions] ${failures} failure(s). The catalogue is lib/actions.js.`);
        process.exit(1);
    }
    console.log(`[check-actions] ${checks}/${checks} — ${actions.CATALOG.length} actions, every one pointing at code that exists`);
})();
