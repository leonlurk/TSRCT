#!/usr/bin/env node
'use strict';
// ── The buttons in the page, checked the same way as the ones in the server ──
//
// lib/uiActions.js says what the assistant may press. src/js/ui-actions.js is
// what presses it, and it keeps its OWN allowlist so a name arriving over the
// wire can never become a call to an arbitrary global. Two lists means two ways
// to drift, so this asserts:
//
//   1. every declared action has a handler in the page, and every handler is
//      declared — no action that does nothing, no handler nobody can reach;
//   2. every function a handler calls still EXISTS as a global, by the same
//      rules check-handlers.js uses (window.* assignment, or a top-level
//      declaration in a classic non-IIFE script). This is the "valida cada
//      botoncito contra el codigo de TSRCT" half: rename pcSwitchTab and the
//      build fails instead of the voice;
//   3. nothing destructive got a voice handle by accident.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const uiActions = require(path.join(ROOT, 'lib/uiActions.js'));

let bad = 0, checks = 0;
const fail = (m) => { console.error(`  [x] ${m}`); bad++; };
const ok = () => { checks++; };

const src = fs.readFileSync(path.join(ROOT, 'src/js/ui-actions.js'), 'utf8');

// ── 1. the two allowlists ───────────────────────────────────────────────────
const body = src.slice(src.indexOf('const HANDLERS = {'));
const handlers = new Set([...body.matchAll(/^\s{8}([a-z_]+):\s*\(/gm)].map(m => m[1]));
const declared = new Set(uiActions.CATALOG.map(a => a.verify && a.verify.ui).filter(Boolean));

for (const name of declared) {
    if (!handlers.has(name)) fail(`lib/uiActions.js declara "${name}" y la pagina no lo tiene: la accion no haria nada`);
    else ok();
}
for (const name of handlers) {
    if (!declared.has(name)) fail(`src/js/ui-actions.js tiene el handler "${name}" que ninguna accion declara: nadie lo puede pedir`);
    else ok();
}
for (const a of uiActions.CATALOG) {
    if (!a.verify || !a.verify.ui) fail(`${a.name}: no declara verify.ui`); else ok();
    if (!a.says || a.says.length < 10) fail(`${a.name}: "says" es lo que el modelo lee para elegirla`); else ok();
    if (!a.readOnly && typeof a.confirmSays !== 'function') fail(`${a.name}: cambia algo y no puede preguntar por lo concreto`); else ok();
}

// ── 2. the globals those handlers press ─────────────────────────────────────
// Same two rules as check-handlers.js: an explicit window assignment, or a
// top-level declaration in a file that is not an IIFE and not a module.
// The same global name set check-handlers.js builds, required rather than
// reimplemented: the subtle half of those rules (a declaration at brace depth
// zero inside a classic script that happens to be indented) is exactly the half
// a second copy gets wrong — my copy lost eleven live functions.
const { globals } = require(path.join(ROOT, 'scripts/check-handlers.js'));

// every name the page reaches for: call('x', ...) and window.X / bare Globals
const pressed = new Set([
    ...[...body.matchAll(/call\('([A-Za-z_$][\w$]*)'/g)].map(m => m[1]),
    ...[...body.matchAll(/\bWorldManager\.([a-z]+)/g)].map(() => 'WorldManager'),
]);
for (const name of pressed) {
    if (!globals.has(name)) fail(`src/js/ui-actions.js llama a ${name}(), que no existe como global: ese boton esta muerto`);
    else ok();
}

// ── 3. nothing destructive has a voice handle ───────────────────────────────
const FORBIDDEN = ['gitRollback', 'galleryConfirmRun', 'purgeAllPermissions', 'confirmRestart', 'galleryAskEmpty', 'clearAllAutoAccept'];
for (const f of FORBIDDEN) {
    if (new RegExp(`['"]${f}['"]`).test(src)) fail(`la voz no puede apretar ${f}() — eso lo aprieta el dedo`);
    else ok();
}

// ── 4. Tesla's microphone is a mirror of his prompt input's ─────────────────
// 2026-09-24: "asegurate de que funcione exactamente igual que el dictador que
// uso en mi input normal". The settings that decide what Chrome hears, compared.
{
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const block = (src, anchor, n) => { const i = src.indexOf(anchor); return i < 0 ? "" : src.slice(i, i + (n || 2600)); };
    const mine = block(read('src/js/assistant.js'), 'window.createSpeechRecognizer({', 5000);
    const his = block(read('src/js/desktop.js'), 'const rec = createSpeechRecognizer({');
    const setting = (b, k) => { const m = new RegExp(`${k}:\\s*([^,\\n]+)`).exec(b); return m ? m[1].trim() : null; };
    // Strict again (2026-10-05): interim results were turned on for one night to
    // tell he was mid-phrase, and on the phone every phrase came out repeated.
    for (const k of ['continuous', 'interimResults']) {
        if (setting(mine, k) !== setting(his, k)) fail(`el microfono de Tesla usa ${k}: ${setting(mine, k)} y el de su input ${setting(his, k)}`);
        else ok();
    }
    if (!/Desktop\.voice\.lang/.test(read('src/js/assistant.js').slice(read('src/js/assistant.js').indexOf('const inputLang')))) fail('Tesla no escucha en el idioma de su input (Desktop.voice.lang)'); else ok();
    if (!/toLowerCase\(\)\.trim\(\)/.test(mine) || !/results\.length - 1\]/.test(mine)) fail('Tesla no toma el resultado como su input (el ultimo, final, en minuscula)'); else ok();
}

// ── 5. never over him (2026-10-14) ──────────────────────────────────────────
// "progress updates from Tesla never interrupt Leon while he is speaking": while
// the orb hears him or his prompt dictation is on, her updates queue, and they are
// read after ~2 s of silence. A permission request still goes at once. The rule is
// one pure function in assistant.js, run here on the real situations.
{
    const a = fs.readFileSync(path.join(ROOT, 'src/js/assistant.js'), 'utf8');
    const i = a.indexOf('// <hold-rule>'), j = a.indexOf('// </hold-rule>');
    let holdLine = null;
    try { holdLine = i < 0 || j < 0 ? null : new Function(`${a.slice(i, j)}; return holdLine;`)(); } catch (e) { fail(`the hold rule does not compile: ${e.message}`); }
    if (typeof holdLine !== 'function') fail('assistant.js has no holdLine() between // <hold-rule> markers');
    else {
        const now = 100000;
        const quiet = { now, talking: false, pauseOn: false, heard: '', voiceAt: 0, awaitUntil: 0, dictating: false, dictAt: 0 };
        const progress = { kind: 'live', text: 'sigue con los tests' };
        const perm = { kind: 'offer', urgent: true, text: 'Harbor pide permiso, ¿lo apruebo?' };
        const cases = [
            ['he is mid-phrase', progress, { talking: true }, true],
            ['his words are waiting to be sent', progress, { pauseOn: true, heard: 'abrime el' }, true],
            ['he stopped 1 s ago', progress, { voiceAt: now - 1000 }, true],
            ['he stopped 1.9 s ago', { kind: 'bg', text: 'listo el informe' }, { voiceAt: now - 1900 }, true],
            ['he stopped 2.1 s ago', progress, { voiceAt: now - 2100 }, false],
            ['nobody talking', { kind: 'session', text: 'termino el turno' }, {}, false],
            ['his prompt dictation is on', progress, { dictating: true, dictAt: now }, true],
            ['his dictation ended 1 s ago', progress, { dictAt: now - 1000 }, true],
            ['his dictation ended 2.5 s ago', progress, { dictAt: now - 2500 }, false],
            ['she is waiting for his answer', progress, { awaitUntil: now + 5000 }, true],
            ['a permission while he talks', perm, { talking: true, heard: 'y despues', pauseOn: true, voiceAt: now }, false],
            ['a permission while he dictates', perm, { dictating: true, dictAt: now }, false],
        ];
        for (const [what, item, s, want] of cases) {
            const got = !!holdLine(item, { ...quiet, ...s });
            if (got !== want) fail(`${what}: "${item.text}" should ${want ? 'wait' : 'be said now'}`); else ok();
        }
    }
    const drainSrc = a.slice(a.indexOf('async function drain()'), a.indexOf('async function drain()') + 1500);
    if (!/holdLine\(/.test(drainSrc)) fail('drain() does not ask holdLine() before speaking'); else ok();
    if (!/Desktop\.voice\.wantRecording/.test(a.slice(a.indexOf('function dictating'), a.indexOf('function dictating') + 600))) fail('the orb does not see his prompt dictation (Desktop.voice.wantRecording)'); else ok();
}

// ── 6. the handoffs tag never sits on the phone's quick keys (2026-10-17) ───
// It docks beside the terminal's FREEZE toggle. Drawn before the terminal was on
// screen (boot, a room open) it fell back to the screen corner, over ATT, until
// the next weights poll - up to 15 s. The real dockPill() is run on a fake page:
// no terminal yet, then the terminal appears, then one second passes.
{
    const w = fs.readFileSync(path.join(ROOT, 'src/js/session-weight.js'), 'utf8');
    const starts = ['let redockTimer', 'function dockPill'].map(s => w.indexOf(s)).filter(n => n >= 0);
    const i = Math.min(...starts), j = w.indexOf('function namesOf');
    const timers = [];
    const page = { toggles: [] };
    const fakeEl = () => {
        const cls = new Set();
        return { style: {}, parentElement: null, offsetWidth: 60, offsetParent: {},
            classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
            appendChild(c) { c.parentElement = this; } };
    };
    const body = fakeEl();
    const document = { body, querySelectorAll: () => page.toggles };
    const getComputedStyle = () => ({ right: '10px' });
    const setTimeout = (fn, ms) => { timers.push([fn, ms]); return timers.length; };
    let dockPill = null;
    try { dockPill = new Function('document', 'getComputedStyle', 'setTimeout', `${w.slice(i, j)}; return dockPill;`)(document, getComputedStyle, setTimeout); } catch (e) { fail(`dockPill does not compile: ${e.message}`); }
    if (typeof dockPill !== 'function') fail('session-weight.js has no dockPill()');
    else {
        const pill = fakeEl();
        pill.classList.add('visible');
        dockPill(pill);
        if (pill.classList.contains('sw-docked')) fail('the tag docked with no terminal on screen'); else ok();
        const host = fakeEl();
        const toggle = fakeEl(); host.appendChild(toggle);
        page.toggles.push(toggle);
        for (const [fn, ms] of timers.splice(0)) if (ms <= 1000) fn();
        if (!pill.classList.contains('sw-docked')) fail('the handoffs tag stays in the corner (over ATT) after the terminal appears, until the next poll');
        else ok();
        if (pill.classList.contains('sw-docked') && pill.parentElement !== host) fail('the tag docked outside the terminal'); else ok();
    }
}

// ── 7. Tesla's button never sits on the phone's keys (2026-10-18) ───────────
// Its default spot was a fixed 76 px from the bottom, but the phone's key area
// is ~120 px tall, so the orb covered the TOOLS tab and the ENT key (visible in
// the README screenshot). With no spot saved by a drag, it now sits just above
// the typing row, on the left where no button lives.
{
    const a = fs.readFileSync(path.join(ROOT, 'src/js/assistant.js'), 'utf8');
    const i = a.indexOf('function phoneDefaultPos');
    let fn = null;
    if (i >= 0) {
        const end = a.indexOf('\n    }\n', i);
        try { fn = new Function(`${a.slice(i, end + 6)}; return phoneDefaultPos;`)(); } catch (e) { fail(`phoneDefaultPos does not compile: ${e.message}`); }
    }
    if (typeof fn !== 'function') fail('assistant.js has no phoneDefaultPos(): the orb keeps its fixed spot over the phone keys');
    else {
        const p = fn(844, 669);
        if (!p || p.side !== 'l' || p.vert !== 'b') fail(`the default phone spot is ${JSON.stringify(p)}, not bottom-left`); else ok();
        if (p && 844 - p.y <= 669 - 4) ok(); else fail(`the orb's bottom edge (${p && 844 - p.y}) is not above the typing row (669)`);
        if (fn(844, null) !== null) fail('with no typing row on screen there must be no default (the CSS spot stays)'); else ok();
    }
    const mm = a.indexOf('function makeMovable');
    if (mm < 0 || !/placePhoneDefault\(|phoneDefaultPos\(/.test(a.slice(mm, mm + 900))) fail('makeMovable does not use phoneDefaultPos when nothing was dragged'); else ok();
}

if (bad) {
    console.error(`\n[check-ui] ${bad} failure(s). Las dos listas son lib/uiActions.js y src/js/ui-actions.js.`);
    process.exit(1);
}
console.log(`[check-ui] ${checks}/${checks} — ${declared.size} botones de la pagina, ${pressed.size} funciones reales, ${FORBIDDEN.length} destructivas fuera de alcance`);
