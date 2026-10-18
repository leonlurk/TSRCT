// ─────────────────────────────────────────────────────────────────────────
// lib/uiActions.js — THE SECOND HAND: the buttons that live in the page.
//
// lib/actions.js can only reach what the SERVER owns: tmux, files, git, the
// morning routine. Most of TSRCT is not there. Which tab is open, which session
// is on screen, the rooms, focus mode, the permission card he has to approve —
// all of that is state in his browser, and the server cannot call pcSwitchTab().
//
// The audit on 2026-09-20 counted it: 667 handler call sites, 465 distinct
// function names, ~120 real capabilities once the four skins of the same quick
// bar collapse into one. The assistant could reach EIGHT of them.
//
// So: a second catalogue, the same shape and the same gate as the first one.
//
//   THE MODEL STILL NEVER EXECUTES. It names an action; this file turns that
//   into {press, args} and puts it on a queue; the browser takes it off the
//   queue on its next poll and calls the handler — and the browser keeps its
//   OWN allowlist of handler names (src/js/ui-actions.js), so a name that is
//   not in both lists calls nothing. scripts/check-ui.js asserts the two lists
//   agree and that every handler still reaches a real, exported function.
//
//   IT SAYS WHAT HAPPENED, NOT WHAT IT MEANT. Before anything is queued this
//   file checks that a panel is actually polling; with TSRCT closed it refuses
//   in words instead of queueing into the void. If the page reports back a
//   failure afterwards, the assistant says so out loud — it does not leave a
//   "listo" standing over something that did not happen.
//
//   NO MODEL TURN FOR A BUTTON. Each action carries the sentence to say when it
//   is done, so pressing a button costs zero GPU. The voice is for the answers
//   that need one.
//
// What deliberately does NOT get a handle here: git rollback, deleting the
// gallery, purging permissions, restarting the server. The assistant may OPEN
// those dialogs; the finger presses the button.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const understand = require('./understand');

// Is anybody looking? talk.js knows when a panel last polled.
let deps = { alive: () => false };
function configure(d) { deps = { ...deps, ...(d || {}) }; }

// ── what he calls the places ────────────────────────────────────────────────
// The canonical value is on the left (what the code wants); everything on the
// right is a way he says it out loud. This is the whole "pasame a tareas"
// feature: the spoken word never has to be the technical one.
const WORDS = {
    tab: {
        terminal: ['terminal', 'consola', 'la sesion', 'claude'],
        notifs: ['notificaciones', 'notifs', 'avisos', 'alertas'],
        automations: ['automatizaciones', 'automations', 'automaticos'],
        codemap: ['codemap', 'mapa', 'mapa del codigo'],
        handson: ['hands on', 'handson', 'manos', 'modo manos'],
    },
    room: {
        remote: ['remoto', 'escritorio', 'windows', 'la pc', 'escritorio remoto'],
        runners: ['runners', 'runner', 'corredores'],
        sfcli: ['salesforce', 'sf', 'orgs', 'la cli'],
    },
    answer: {
        yes: ['si', 'que si', 'dale', 'aceptalo', 'acepta', 'aprobalo'],
        no: ['no', 'que no', 'negale'],
        skip: ['saltealo', 'skip', 'salta', 'pasalo', 'salteala', 'skipealo'],
    },
    slash: {
        '/compact': ['compacta', 'compactalo', 'compact', 'comprimi', 'achica el contexto'],
        '/clear': ['limpia', 'clear', 'borra el contexto', 'empeza de cero'],
        '/help': ['ayuda', 'help', 'comandos'],
    },
    size: {
        1: ['chica', 'chico', 'mas chica', 'small', 'achica', 'achicala', 'achicame'],
        2: ['normal', 'mediana', 'media'],
        3: ['grande', 'mas grande', 'agranda', 'agrandala', 'agrandame'],
        4: ['gigante', 'enorme', 'extra grande'],
    },
};

// Spoken -> canonical. Exact first, then "he said a word that is in the phrase",
// so "pasame a la de tareas" lands on tasks without a model and without a
// fifty-line synonym list per tab.
function match(kind, spoken) {
    const table = WORDS[kind] || {};
    const said = understand.flat(spoken);
    if (!said) return '';
    for (const [value, words] of Object.entries(table)) {
        if (understand.flat(value) === said) return value;
        if (words.some(w => understand.flat(w) === said)) return value;
    }
    const tokens = said.split(' ').filter(Boolean);
    let best = '', bestLen = 0;
    for (const [value, words] of Object.entries(table)) {
        for (const w of [value, ...words]) {
            const f = understand.flat(w);
            if (!f) continue;
            // the longest listed phrase that is actually inside what he said
            const hit = f.includes(' ') ? said.includes(f) : tokens.includes(f);
            if (hit && f.length > bestLen) { best = value; bestLen = f.length; }
        }
    }
    return best;
}

function options(kind) { return Object.keys(WORDS[kind] || {}); }

// What to CALL it out loud. "Listo, te puse tasks" is the internal name read
// back at him; he said tareas, and that is the word he should hear.
function label(kind, value) {
    const words = (WORDS[kind] || {})[value];
    return (words && words[0]) || value;
}

// ── the queue ───────────────────────────────────────────────────────────────
// One short list of things the page has not done yet. It is drained by the poll
// the orb already makes, and by the answer to /api/talk/ask, so in practice the
// button is pressed before he has finished hearing the sentence.
let queue = [];
let seq = 0;
const DONE_MS = 20000;      // unclaimed after this long: the page is not there
let onFail = null;          // talk.js hands it the voice for a failure report

function press(fn, args, say) {
    if (!deps.alive()) {
        const e = new Error('no tengo TSRCT abierto adelante, asi que eso no lo puedo tocar');
        e.soft = true;          // a sentence for him, not a crash
        throw e;
    }
    seq += 1;
    const item = { id: seq, fn, args: args || {}, at: Date.now() };
    queue.push(item);
    if (queue.length > 10) queue = queue.slice(-10);
    return { queued: item.id, fn, say };
}

// What the page has not run yet (and has not gone stale).
function pending() {
    const now = Date.now();
    queue = queue.filter(x => now - x.at < DONE_MS);
    return queue.map(x => ({ id: x.id, fn: x.fn, args: x.args }));
}

// The page reporting back. A success is silent — he watched it happen. A
// failure is spoken, because the assistant has already said "listo".
function report(id, ok, why) {
    const i = queue.findIndex(x => x.id === Number(id));
    const item = i >= 0 ? queue[i] : null;
    if (i >= 0) queue.splice(i, 1);
    if (!ok && onFail) {
        onFail(`No pude ${item ? item.fn.replace(/_/g, ' ') : 'hacerlo'}: ${String(why || 'la pantalla no me dejo').slice(0, 120)}`);
    }
    return { ok: true, known: !!item };
}

function onFailure(fn) { onFail = fn; }

// ── the catalogue ───────────────────────────────────────────────────────────
// `press` is the name of a handler in src/js/ui-actions.js — never a raw global,
// so the browser half can pick the mobile or the desktop control for the same
// spoken sentence. `done` is what it says out loud, so none of these costs a
// model turn.
const CATALOG = [
    {
        name: 'go_tab',
        says: 'cambiar de pantalla en TSRCT: terminal, notificaciones, automatizaciones, codemap, hands on',
        args: { tab: 'tab' },
        readOnly: true,
        verify: { ui: 'go_tab' },
        run: ({ tab }) => press('go_tab', { tab }, `Listo, te puse ${label('tab', tab)}.`),
    },
    {
        name: 'open_room',
        says: 'abrir una pantalla grande: el escritorio remoto, los runners o salesforce',
        args: { room: 'room' },
        readOnly: true,
        verify: { ui: 'open_room' },
        run: ({ room }) => press('open_room', { room }, `Abriendo ${label('room', room)}.`),
    },
    {
        name: 'close_room',
        says: 'cerrar la pantalla grande que este abierta y volver a la terminal',
        args: {},
        readOnly: true,
        verify: { ui: 'close_room' },
        run: () => press('close_room', {}, 'Listo, la cerre.'),
    },
    {
        name: 'show_session',
        says: 'poner otra sesion en pantalla, sin abrir ni cerrar nada',
        args: { session: 'session' },
        readOnly: true,
        verify: { ui: 'show_session' },
        run: ({ session }) => press('show_session', { session }, `Te puse ${session} en pantalla.`),
    },
    {
        // The PROJECTOR window (2026-10-12): a session's separate browser, live.
        name: 'show_projector',
        says: 'abrir la ventana proyector, que muestra en vivo el navegador aparte de una sesion (session = la sesion que nombro; el de Tesla es hands)',
        args: { session: 'text?' },
        readOnly: true,
        verify: { ui: 'show_projector' },
        run: ({ session }) => {
            const s = /^[A-Za-z0-9._-]{1,60}$/.test(String(session || '')) ? String(session) : '';
            return press('show_projector', s ? { session: s } : {}, 'Ahi esta el proyector.');
        },
    },
    {
        // "en esta misma terminal" (2026-10-08): the split panel he is looking at,
        // not the main view. Swaps what that panel shows; closes nothing.
        name: 'put_in_panel',
        says: 'poner una sesion en el panel donde esta otra (place = la que estas mirando, si no dice cual), en su mismo lugar; no abre ni cierra nada',
        args: { session: 'session', place: 'session' },
        readOnly: true,
        verify: { ui: 'put_in_panel' },
        run: ({ session, place }) => press('put_in_panel', { session, place }, `Puse ${session} donde estaba ${place}.`),
    },
    {
        name: 'scroll_bottom',
        says: 'bajar la terminal hasta lo ultimo que salio',
        args: {},
        readOnly: true,
        verify: { ui: 'scroll_bottom' },
        run: () => press('scroll_bottom', {}, 'Listo.'),
    },
    {
        name: 'focus_mode',
        says: 'prender o apagar el modo foco, que esconde las carpetas sin sesion',
        args: {},
        readOnly: true,
        verify: { ui: 'focus_mode' },
        run: () => press('focus_mode', {}, 'Cambie el modo foco.'),
    },
    {
        name: 'show_brief',
        says: 'abrir o cerrar el resumen de la maniana en pantalla',
        args: {},
        readOnly: true,
        verify: { ui: 'show_brief' },
        run: () => press('show_brief', {}, 'Ahi esta el resumen.'),
    },
    {
        name: 'mute_voices',
        says: 'silenciar o volver a habilitar todas las voces de TSRCT',
        args: {},
        readOnly: true,
        verify: { ui: 'mute_voices' },
        run: () => press('mute_voices', {}, 'Listo.'),
    },
    {
        name: 'font_size',
        says: 'agrandar o achicar la letra de la terminal',
        args: { size: 'size' },
        readOnly: true,
        verify: { ui: 'font_size' },
        run: ({ size }) => press('font_size', { size }, 'Listo, cambie la letra.'),
    },
    {
        name: 'eye_protect',
        says: 'prender o apagar el filtro de luz azul',
        args: {},
        readOnly: true,
        verify: { ui: 'eye_protect' },
        run: () => press('eye_protect', {}, 'Listo.'),
    },
    {
        name: 'sessions_panel',
        says: 'mostrar la lista de sesiones para elegir una',
        args: {},
        readOnly: true,
        verify: { ui: 'sessions_panel' },
        run: () => press('sessions_panel', {}, 'Ahi tenes la lista.'),
    },
    {
        name: 'new_session_dialog',
        says: 'abrir el cuadro para crear una sesion a mano',
        args: {},
        readOnly: true,
        verify: { ui: 'new_session_dialog' },
        run: () => press('new_session_dialog', {}, 'Te abri el cuadro.'),
    },
    {
        name: 'restart_dialog',
        says: 'abrir el cartel para reiniciar el servidor (abrirlo nada mas, no reinicia)',
        args: {},
        readOnly: true,
        verify: { ui: 'restart_dialog' },
        run: () => press('restart_dialog', {}, 'Te abri el cartel. El boton lo apretas vos.'),
    },
    {
        // "redactame un prompt para..." — Haiku writes it, it lands in his input
        // box UNSENT. Nothing reaches a session until he presses send himself,
        // which is why this one does not ask first.
        name: 'draft_prompt',
        says: 'dejarle escrito en su caja de texto un prompt que redactaste vos, SIN mandarlo, para que lo revise (en la sesion que diga, o en la que esta)',
        args: { text: 'text', session: 'session?' },
        readOnly: true,
        verify: { ui: 'draft_prompt' },
        run: ({ text, session }) => press('draft_prompt', { text, session: session || '' },
            `Te lo deje escrito${session ? ` en ${session}` : ''}. Revisalo y mandalo cuando quieras.`),
    },
    // ── the ones that touch the session, and therefore ASK first ────────────
    {
        name: 'approve_permission',
        says: 'aprobar el permiso que Claude esta pidiendo en pantalla',
        confirmSays: () => 'aprobar el permiso que esta pidiendo en pantalla',
        args: {},
        readOnly: false,
        verify: { ui: 'approve_permission' },
        run: () => press('approve_permission', {}, 'Aprobado.'),
    },
    {
        name: 'deny_permission',
        says: 'rechazar el permiso que Claude esta pidiendo en pantalla',
        confirmSays: () => 'rechazar el permiso que esta pidiendo en pantalla',
        args: {},
        readOnly: false,
        verify: { ui: 'deny_permission' },
        run: () => press('deny_permission', {}, 'Rechazado.'),
    },
    {
        name: 'quick_answer',
        says: 'contestarle a la sesion que si, que no, o que saltee',
        confirmSays: ({ answer }) => `contestarle "${answer}" a la sesion que esta en pantalla`,
        args: { answer: 'answer' },
        readOnly: false,
        verify: { ui: 'quick_answer' },
        run: ({ answer }) => press('quick_answer', { answer }, 'Listo, se lo dije.'),
    },
    {
        name: 'slash_command',
        says: 'mandarle a la sesion un comando de Claude: compactar, limpiar el contexto o pedir ayuda',
        confirmSays: ({ cmd }) => `mandarle ${cmd} a la sesion que esta en pantalla`,
        args: { cmd: 'slash' },
        readOnly: false,
        verify: { ui: 'slash_command' },
        run: ({ cmd }) => press('slash_command', { cmd }, `Le mande ${cmd}.`),
    },
    {
        // Escape and Ctrl+C are the two that CANCEL. They inject no text, and
        // asking "seguro?" while something runs away is the wrong moment for a
        // question — so these are the one write-shaped thing that does not wait.
        name: 'stop_session',
        says: 'frenar lo que la sesion esta haciendo ahora (escape o control c)',
        args: {},
        readOnly: true,
        verify: { ui: 'stop_session' },
        run: () => press('stop_session', {}, 'Le mande escape.'),
    },
];

module.exports = { configure, CATALOG, WORDS, match, options, label, pending, report, onFailure };
