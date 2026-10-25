#!/usr/bin/env node
'use strict';
// Research is checked with every connector on (CONNECTORS is per machine).
process.env.CONNECTORS = 'clickup,slack,gmail,calendar';
// ── The sentences he actually says, and what each one has to do ─────────────
//
// This is the regression suite for the assistant's UNDERSTANDING, and it is the
// reason the catalogue can keep growing without the thing getting dumber. Every
// mistake he has caught becomes a line in here, and then it cannot come back:
//
//   "que si que si bro"                    was heard as neither yes nor no
//   "cual es el estado actual del proyecto" was answered with "abro una sesion?"
//   "No no quiero"                          was followed by doing it anyway
//
// It runs with no Ollama, no tmux and no GPU: lib/understand.js is pure, and the
// world it is given is a fixture. That is what makes it runnable in `npm run
// check` on every change.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const understand = require(path.join(ROOT, 'lib/understand.js'));
const talk = require(path.join(ROOT, 'lib/talk.js'));
const actions = require(path.join(ROOT, 'lib/actions.js'));

let bad = 0, checks = 0;
const fail = (m) => { console.error(`  [x] ${m}`); bad++; };
const ok = () => { checks++; };
const TASKS_ASYNC = [];
const await_ = (p) => p;

// The world as it is on a normal afternoon: five sessions, six projects, TSRCT
// looking at `trudy`, and `harbor` the last thing that was named out loud.
const WORLD = {
    sessions: ['tsrct', 'trudy', 'harbor', 'probill', 'personal'],
    projects: ['tsrct', 'harbor', 'probill', 'personal-factory', 'verde-soap', 'anvil'],
    here: 'trudy',
    last: { session: 'harbor', project: 'tsrct' },
};

// [ what he said, the action it must produce (null = talk to him, do nothing),
//   and optionally the arguments that must come out of it ]
const SAID = [
    // ── opening ──
    ['abrime una sesion en tsrct', 'open_session', { project: 'tsrct' }],
    ['abri una sesion nueva en probill', 'open_session', { project: 'probill' }],
    ['creame una sesion en harbor', 'open_session', { project: 'harbor' }],
    ['levanta una sesion de verde soap', 'open_session', { project: 'verde soap' }],
    ['abrime dos sesiones, personal y probill', 'open_session'],
    ['abrime una sesion', 'open_session', {}],                 // no project: it must ASK
    ['arranca una sesion en anvil', 'open_session', { project: 'anvil' }],
    ['abrila', 'open_session'],
    ['necesito que abras una sesion en tsrct', 'open_session', { project: 'tsrct' }],

    // ── closing ──
    ['cerra la sesion de harbor', 'close_session', { session: 'harbor' }],
    ['cerra las dos que abriste', 'close_session'],
    ['mata esa sesion', 'close_session', { session: 'trudy' }],   // "esa" = the one on screen
    ['cerra esa', 'close_session', { session: 'trudy' }],
    ['baja probill', 'close_session', { session: 'probill' }],
    ['termina la sesion trudy', 'close_session', { session: 'trudy' }],

    // ── typing into a session (the one that writes) ──
    ['decile a harbor que corra los tests', 'say_to_session', { session: 'harbor', text: 'corra los tests' }],
    ['mandale a tsrct que compacte', 'say_to_session', { session: 'tsrct', text: 'compacte' }],
    ['decile que pare', 'say_to_session', { session: 'trudy', text: 'pare' }],
    ['escribile a probill que revise el sdd', 'say_to_session', { session: 'probill', text: 'revise el sdd' }],
    ['pedile que me explique lo que hizo', 'say_to_session', { session: 'trudy' }],
    ['dile que cargue la documentacion del proyecto', 'say_to_session', { session: 'trudy' }],

    // ── asking about a project or a session ──
    ['cual es el estado actual del proyecto', 'project_status'],
    ['cual es el estado actual del proyecto trudy', 'project_status', { project: 'trudy' }],
    ['como va tsrct', 'project_status', { project: 'tsrct' }],
    ['como viene harbor', 'project_status', { project: 'harbor' }],
    ['en que anda probill', 'project_status', { project: 'probill' }],
    ['que onda con verde soap', 'project_status', { project: 'verde soap' }],
    ['donde quedo eso', 'project_status'],
    ['como esta el proyecto personal factory', 'project_status', { project: 'personal factory' }],

    // ── asking about the screen ──
    ['que esta haciendo', 'read_session', { session: 'trudy' }],
    ['que esta haciendo harbor', 'read_session', { session: 'harbor' }],
    ['ya termino?', 'read_session'],
    ['que dice la pantalla de tsrct', 'read_session', { session: 'tsrct' }],
    ['mira que hay en probill', 'read_session', { session: 'probill' }],
    ['fijate en harbor', 'read_session', { session: 'harbor' }],
    ['sigue trabajando?', 'read_session'],

    // ── the small ones ──
    ['que sesiones tengo abiertas', 'list_sessions'],
    ['cuantas sesiones hay', 'list_sessions'],
    ['que tengo abierto ahora', 'list_sessions'],
    ['leeme el resumen de la maniana', 'read_brief'],
    ['que decia el brief', 'read_brief'],
    ['cuanta memoria le queda a la placa', 'gpu_free'],
    ['como esta la gpu', 'gpu_free'],

    // ── talking TO it vs talking ABOUT it: one letter, opposite consequences ──
    ['contame que hizo', 'read_session'],
    ['contale que ya esta', 'say_to_session'],
    ['decime que paso', 'read_session'],
    ['decile que ya esta', 'say_to_session'],

    // ── the buttons in the page (phase 1) ──
    ['pasame a tareas', 'go_tab', { tab: 'tareas' }],
    // ── what to do today (2026-09-21: these fell to the model, which asked
    // "which project?" and then trapped every next sentence as the answer) ──
    ['Dame la lista de tareas que deberíamos embajador', 'today_tasks'],
    ['me refiero Cuál es la lista del área que debería completar para hoy', 'today_tasks'],
    ['ferretería A cuál es la lista de tareas que tengo que completar para hoy', 'today_tasks'],
    ['Qué es lo próximo que debería hacer', 'today_tasks'],
    ['que tengo que hacer hoy', 'today_tasks'],
    ['mostrame las tareas', 'today_tasks'],
    ['anda a notificaciones', 'go_tab', { tab: 'notificaciones' }],
    ['llevame a la terminal', 'go_tab'],
    ['abrime el escritorio remoto', 'open_room'],
    ['abri los runners', 'open_room'],
    ['mostrame salesforce', 'open_room'],
    ['aproba eso', 'approve_permission'],
    ['dale permiso', 'approve_permission'],
    ['rechazalo', 'deny_permission'],
    ['frena eso', 'stop_session'],
    ['mandale escape', 'stop_session'],
    ['compactala', 'slash_command'],
    ['limpiale el contexto', 'slash_command'],
    ['mostrame el resumen', 'show_brief'],
    // and the one that must NOT become a tab
    ['pasale a harbor que corra los tests', 'say_to_session', { session: 'harbor' }],
    ['abrime una sesion en tsrct', 'open_session', { project: 'tsrct' }],

    // ── the rest of the page ──
    ['achica la letra', 'font_size'],
    ['letra mas grande', 'font_size'],
    ['decile que si', 'quick_answer'],
    ['decile que no', 'quick_answer'],
    ['saltealo', 'quick_answer'],
    ['modo foco', 'focus_mode'],
    ['volve a la terminal', 'close_room'],
    ['silencia las voces', 'mute_voices'],
    ['mostrame las sesiones', 'sessions_panel'],
    ['reinicia el servidor', 'restart_dialog'],
    ['baja del todo', 'scroll_bottom'],

    // ── the morning call ──
    ['abri las que dijiste', 'open_morning'],
    ['abri el plan', 'open_morning'],
    ['dale con el plan', 'open_morning'],
    ['abri las sesiones del resumen', 'open_morning'],

    // ── setups and several sessions at once (phase 3) ──
    ['prepara mi setup de la maniana', 'run_setup'],
    ['armame el board de harbor', 'run_setup'],
    ['guarda esto como mi setup de la maniana', 'save_setup', { name: 'maniana' }],
    ['decile a las dos que corran los tests', 'say_to_sessions', { session: 'las dos', text: 'corran los tests' }],
    ['mandale a todas que compacten', 'say_to_sessions', { session: 'todas' }],
    ['decile a harbor que compacte', 'say_to_session', { session: 'harbor' }],

    // ── his PC (2026-10-10): the session table must not take these ──
    // A plain look is look_at_screen; anything else is the brain's (null here).
    ['que tengo abierto en la pantalla', 'look_at_screen'],
    ['que dice ese mail', 'look_at_screen'],
    ['mira mi pantalla', 'look_at_screen'],
    ['que ves en el monitor dos', 'look_at_screen', { screen: '2' }],
    ['que hay en mi pc', 'look_at_screen'],
    // a known program alone: straight to open_app, no brain, no question
    ['abri spotify', 'open_app', { name: 'spotify' }],
    ['abrir spotify', 'open_app', { name: 'spotify' }],
    ['traeme el chrome', 'open_app', { name: 'chrome' }],
    ['abrime whatsapp por favor', 'open_app', { name: 'whatsapp' }],
    ['abrime el excel de ventas', null],
    ['abri chrome y entra a clickup', null],
    ['cerra spotify', null],
    ['cerra esa ventana', null],
    ['escribile a paul por whatsapp que llego tarde', null],
    ['abri la carpeta de descargas', null],
    ['buscame el archivo del contrato de harbor y abrilo', null],
    ['abri el proyecto de harbor en vs code', null],
    ['hace clic en aceptar', null],
    ['abri el mail de paul', null],
    // ...and his sessions are still his sessions
    ['cerra la sesion harbor', 'close_session', { session: 'harbor' }],
    ['abrime el escritorio remoto', 'open_room'],

    // ── conversation: none of these may touch anything ──
    ['no abras nada todavia', null],
    ['ni se te ocurra cerrar esa sesion', null],
    ['hola', null],
    ['gracias bro', null],
    ['jajaja', null],
    ['esto quedo perfecto', null],
    ['me parece que eso no esta bien', null],
    ['cabron', null],
    ['despues vemos lo de las sesiones', null],
    ['el proyecto anda bien', null],
];

console.log('[check-talk] understanding');
for (const [said, want, args] of SAID) {
    const got = understand.parse(said, WORLD);
    const name = got ? got.name : null;
    if (name !== want) { fail(`"${said}" -> ${name} (queria ${want})`); continue; }
    if (args) {
        for (const [k, v] of Object.entries(args)) {
            const real = got.args[k];
            if (v === undefined) continue;
            if (String(real || '') !== String(v)) { fail(`"${said}" -> ${k}="${real}" (queria "${v}")`); continue; }
        }
    }
    ok();
}

// ── yes and no, which is where it ignored him three times in a row ──────────
console.log('[check-talk] yes / no');
const ANSWERS = [
    ['que si que si bro', 'yes'], ['si si si si si si si si', 'yes'], ['si', 'yes'],
    ['dale', 'yes'], ['de una', 'yes'], ['por supuesto', 'yes'], ['ok listo', 'yes'],
    ['obvio', 'yes'], ['hacelo', 'yes'], ['confirmo', 'yes'],
    ['no', 'no'], ['no no quiero', 'no'], ['claro que no', 'no'], ['mejor no', 'no'],
    ['ni ahi', 'no'], ['no, dejalo', 'no'], ['cancelalo', 'no'],
    ['no veo que hayas abierto la sesion', null],
    ['cual es el estado actual del proyecto', null],
    ['abrime una sesion en tsrct', null],
    ['si abris eso se rompe todo', null],
];
for (const [said, want] of ANSWERS) {
    const got = talk.decide(said);
    if (got !== want) fail(`decide("${said}") = ${got} (queria ${want})`); else ok();
}

// A dot inside a web address is not the end of a sentence (Tesla review #10:
// "La pagina farmproweb.vercel." - the rest of the answer was cut).
{
    const s = require('../lib/speech');
    const said = s.shape('La pagina farmproweb.vercel.app es de FarmPro, una automatizacion. La abri en Chrome.');
    if (!/farmproweb\.vercel\.app es de FarmPro/.test(said)) fail(`shape cut a web address: "${said}"`); else ok();
    const three = s.shape('Uno. Dos. Tres.');
    if (three !== 'Uno. Dos.') fail(`shape still keeps two sentences: "${three}"`); else ok();
}

// A list he asks for is told WHOLE (Tesla review #10, 16:44: "me puedes listar
// los problemas que detecto" -> "Son ocho problemas. Los mas graves: ..." and two
// of the eight; he had to ask "y que mas"). Short is for PC results, not for
// what he asked to hear. Leon: "tiene que resumir de manera muy inteligente ...
// pero tampoco que me corte informacion".
for (const [said, want] of [
    ['me puedes listar los problemas que detectó', true],
    ['y qué más', true],
    ['cuales son los pendientes de hoy', true],
    ['decime todos los errores', true],
    ['resumime lo que hizo', true],
    ['abri spotify', false],
    ['como va harbor', false],
]) {
    if (talk._wantsDetail(said) !== want) fail(`wantsDetail("${said}") should be ${want}`); else ok();
}

// With Haiku as the brain, the yes/no question is Haiku's own sentence; the
// template only when it did not ask anything.
{
    const own = 'Abro tsrct, harbor, personal y probill, dale?';
    if (talk._haikuConfirm(own, 'x') !== own) fail('haikuConfirm dropped Haiku\'s own question'); else ok();
    const t = talk._haikuConfirm('Listo.', 'abrir una sesion nueva en tsrct');
    // Short (2026-10-10, "la pregunta de confirmacion es super larga ... delay al pedo"):
    // the bare question, no "Queres que haga esto: ... Decime si o no." around it.
    if (t !== '¿Abrir una sesion nueva en tsrct?') fail(`haikuConfirm fallback = "${t}"`); else ok();
}

// ── nothing with a side effect fires without a word asking for it ───────────
console.log('[check-talk] orders vs questions');
const ORDERS = [
    ['cual es el estado actual del proyecto', false], ['como viene tsrct', false],
    ['que esta haciendo esa sesion', false], ['que sesiones tengo', false],
    ['abrime una sesion en tsrct', true], ['cerra las dos que abriste', true],
    ['decile que corra los tests', true], ['mandale el prompt a harbor', true],
];
for (const [said, want] of ORDERS) {
    if (talk.ORDER.test(said) !== want) fail(`ORDER("${said}") = ${!want}`); else ok();
}

// ── how it sounds (lib/speech.js) ───────────────────────────────────────────
// The persona has asked for short spoken answers since the day it was written
// and a 7B still writes a paragraph with a list in it about one turn in five.
// A prompt is a request; these are the rule.
console.log('[check-talk] la forma de lo que dice');
const speech = require(path.join(ROOT, 'lib/speech.js'));
const SHAPED = [
    // a list becomes a sentence, and stops after three
    ['Termino:\n- corrio los tests\n- toco tres archivos\n- fallo uno\n- espera respuesta',
        'Termino: corrio los tests, toco tres archivos, fallo uno y una mas.'],
    // markdown never survives
    ['Mire la pantalla y **termino** el `check`.', 'Mire la pantalla y termino el check.'],
    // two sentences, cut at a boundary and never rewritten
    ['Uno. Dos. Tres. Cuatro.', 'Uno. Dos.'],
    ['Listo, te puse tareas.', 'Listo, te puse tareas.'],
];
for (const [raw, want] of SHAPED) {
    const got = speech.shape(raw);
    if (got !== want) fail(`shape("${raw.slice(0, 30)}...") = "${got}"\n        queria  "${want}"`); else ok();
}
const SPOKEN = [
    ['tsrct quedo listo', 'teseract quedo listo'],
    ['termino a las 18:29', 'termino a las seis y 29'],
    ['esta en 14:00', 'esta en dos en punto'],
    ['mira /mnt/c/Users/you/PROJECTS/TSRCT/server.js', 'mira server.js'],
    ['la gpu tiene lugar', 'la ge pe u tiene lugar'],
];
for (const [raw, want] of SPOKEN) {
    const got = speech.forVoice(raw);
    if (got !== want) fail(`forVoice("${raw}") = "${got}" (queria "${want}")`); else ok();
}

// ── several sessions from one sentence ──────────────────────────────────────
// 2026-09-22: "abrime cuatro sesiones en personal" opened ONE — the number was
// dropped before it reached the catalogue — and "tsrct, harbor y probill"
// failed because the recognizer's commas are gone by then. Sentence to the
// confirmation he hears, through the real gate, with a fixture project list.
console.log('[check-talk] several at once');
actions.configure({
    tmux: { listSessions: () => [], sessionExists: () => false },
    projectRegistry: { list: () => WORLD.projects.map(project => ({ project })), resolve: p => ({ project: p, cwd: '/fixture/' + p }) },
});
const MANY_AT_ONCE = [
    ['abrime cuatro sesiones en mi carpeta personal', 'abrir 4 sesiones nuevas en personal-factory'],
    ['abri 4 sesiones en tsrct', 'abrir 4 sesiones nuevas en tsrct'],
    ['abrime dos sesiones en tsrct y dos en harbor', 'abrir 4 sesiones nuevas: 2 en tsrct, 2 en harbor'],
    ['abrime tsrct, harbor y probill', 'abrir 3 sesiones nuevas: tsrct, harbor, probill'],
    ['abrime una sesion en tsrct otra en harbor y otra en probill', 'abrir 3 sesiones nuevas: tsrct, harbor, probill'],
    ['abrime dos sesiones, tsrct y probill', 'abrir 2 sesiones nuevas: tsrct, probill'],
    ['abrime dos en tsrct y una en harbor', 'abrir 3 sesiones nuevas: 2 en tsrct, harbor'],
    ['levanta una sesion de verde soap', 'abrir una sesion nueva en verde-soap'],
    // Over 4 opens in the background, one at a time (2026-10-14: 15 were refused).
    ['abrime cinco sesiones en tsrct', 'abrir 5 sesiones nuevas en tsrct, de a una y en segundo plano; te aviso cuando esten'],
    ['abrime tres sesiones, tsrct y harbor', null],      // three said, two named: asks
];
for (const [said, want] of MANY_AT_ONCE) {
    const p = understand.parse(said, WORLD);
    let got = null;
    try { const v = actions.validate(p.name, p.args); got = v.action.confirmSays(v.args); } catch (e) { if (!e.askAgain) got = 'ERROR ' + e.message; }
    if (got !== want) fail(`"${said}" -> ${JSON.stringify(got)} (queria ${JSON.stringify(want)})`); else ok();
}

// ── the ANSWER to "cuales?" is a list, and has no verb (2026-09-24) ─────────
// "abrime cinco sesiones en personal" -> "Abro hasta 4. Cuales 4?" -> "una en
// personal otra en tsrc". Six words, so the answer-to-a-question rule (at most
// four) threw it away and it went to the model, which was loading.
const ANSWERED = [
    ['una en personal otra en tsrc', 'abrir 2 sesiones nuevas: personal-factory, tsrct'],
    ['dos en tsrct y dos en harbor', 'abrir 4 sesiones nuevas: 2 en tsrct, 2 en harbor'],
    ['tsrct harbor y probill', 'abrir 3 sesiones nuevas: tsrct, harbor, probill'],
];
for (const [said, want] of ANSWERED) {
    const need = { name: 'open_session', key: 'project', args: {} };
    if (!talk._answerFits(need, said)) { fail(`"${said}" should be read as the answer to "cuales?"`); continue; }
    let got = null;
    try { const v = actions.validate('open_session', { project: said }); got = v.action.confirmSays(v.args); } catch (e) { got = 'ERROR ' + e.message; }
    if (got !== want) fail(`answer "${said}" -> ${JSON.stringify(got)} (queria ${JSON.stringify(want)})`); else ok();
}
// "mandale ..." is its own yes - for sending, and only in HIS words.
{
    const say = { name: 'say_to_session', args: { session: 'harbor', text: 'x' } };
    const res = { name: 'research_prompt', args: { goal: 'x' } };
    const resSend = { name: 'research_prompt', args: { goal: 'x', send: true } };
    const CASES = [
        ['mandale un prompt diciendo que corra los tests', say, true],
        ['enviale a harbor que revise el deploy', say, true],
        ['mandá', say, true],
        ['decile que pare', say, true],
        ['no le mandes nada todavia', say, false],
        ['que le podria decir a harbor?', say, false],
        ['redactame un prompt para arreglar el login', res, true],
        ['armame un prompt para harbor', res, true],
        ['investigá y armá un prompt para el deploy', res, true],
        ['armalo y mandaselo a harbor', resSend, true],
        ['armame un prompt', resSend, false],        // send needs a send word
        ['cerra harbor', { name: 'close_session', args: {} }, false],   // never for anything else
    ];
    for (const [said, pend, want] of CASES) {
        if (talk._saidDirectly(said, pend) !== want) fail(`saidDirectly("${said}", ${pend.name}) != ${want}`); else ok();
    }
}
// Opus's prompt lands where he asked: his box, or the session when he said send.
{
    const pw = require('../lib/promptWriter');
    const said = [], drafted = [], sent = [];
    pw.configure({ say: (l) => said.push(l), draft: (t, s) => drafted.push([t, s]), send: (t, s) => sent.push([t, s]) });
    pw._jobs.set('k1', { session: 'harbor', send: false, startedAt: 1 });
    pw._finish('k1', { ok: true, value: { prompt: 'Goal: fix login', summary: 'arregla el login' } });
    if (drafted.length !== 1 || sent.length) fail('a drafted prompt did not land only in his box'); else ok();
    pw._jobs.set('k2', { session: 'harbor', send: true, startedAt: 2 });
    pw._finish('k2', { ok: true, value: { prompt: 'Goal: deploy', summary: '' } });
    if (sent.length !== 1 || sent[0][1] !== 'harbor') fail('a prompt he said to send did not reach the session'); else ok();
    pw._jobs.set('k3', { session: 'harbor', send: true, startedAt: 3 });
    pw._finish('k3', { ok: true, value: { prompt: 'revisa secretco sandbox', summary: '' } });
    if (sent.length !== 1) fail('an SecretCo prompt was sent'); else ok();
    if (!/SecretCo/.test(said[said.length - 1])) fail('the SecretCo refusal was not said'); else ok();
}
// Background work is never silent (2026-09-24: Opus finished in 2 min, the
// prompt never reached him, and Haiku guessed "en progreso" six minutes later).
{
    const fs = require('fs'), os = require('os');
    const pw = require('../lib/promptWriter');
    const jsonJob = require('../lib/jsonJob');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-'));
    fs.mkdirSync(path.join(ws, 'out'));
    const journal = path.join(ws, 'jobs.jsonl');
    const said = [], drafted = [];
    pw.configure({
        analyst: { WORKSPACE: ws, getActivitySteps: () => ({ running: true, key: 'wd1', steps: [{ label: 'read NOTE.md' }, { label: 'web search "sqlite"' }] }) },
        jsonJob, journal, say: (l) => said.push(l), draft: (t, s) => drafted.push(s), send: () => {},
    });
    const now = Date.now();
    // 1. the watchdog delivers from the output file when the normal path missed it
    pw._jobs.set('wd1', { goal: 'plataforma', session: 'personal', send: false, level: 'complex', model: 'Opus', startedAt: now - 180000, state: 'running' });
    pw._sweep(now);
    const running = pw.list(now).find(j => j.key === 'wd1');
    if (!running || running.step !== 'web search "sqlite"' || running.steps !== 2 || running.model !== 'Opus') fail(`progress not shown: ${JSON.stringify(running)}`); else ok();
    if (!/Opus: trabajando hace 3 min \(ultimo paso: web search/.test(pw.describe(now))) fail(`Haiku is not told the real state: ${pw.describe(now)}`); else ok();
    const f = path.join(ws, 'out', 'wd1.md');
    fs.writeFileSync(f, 'Leo la nota.\n```json\n{"prompt": "Objetivo: X", "summary": "pide X"}\n```');
    const old = (now - 90000) / 1000; fs.utimesSync(f, old, old);
    pw._sweep(now);
    if (pw._jobs.get('wd1').state !== 'drafted' || drafted.length !== 1) fail('the watchdog did not deliver a finished prompt the tick missed'); else ok();
    if (!/^Opus termino\. Te deje el prompt en tu caja para personal/.test(said[said.length - 1] || '')) fail(`the result was not told with its model: ${said[said.length - 1]}`); else ok();
    // 2. once only, whoever gets there second
    pw._finish('wd1', { ok: true, value: { prompt: 'otra vez' } });
    if (drafted.length !== 1 || said.length !== 1) fail('a job was delivered twice'); else ok();
    // 3. a fresh output file is left to the normal path (the tick polls every 8s)
    pw._jobs.set('wd2', { goal: 'g', session: 'personal', model: 'Sonnet', startedAt: now - 30000, state: 'running' });
    fs.writeFileSync(path.join(ws, 'out', 'wd2.md'), '{"prompt": "Y"}');
    pw._sweep(now);
    if (pw._jobs.get('wd2').state !== 'running') fail('the watchdog raced the normal path on a fresh file'); else ok();
    // 4. the time cap ends it OUT LOUD
    pw._jobs.set('wd3', { goal: 'g', session: '', model: 'Haiku', startedAt: now - 14 * 60000, state: 'running' });
    pw._sweep(now);
    if (pw._jobs.get('wd3').state !== 'failed' || !/Haiku no pudo armar el prompt: tardo demasiado/.test(said[said.length - 1])) fail(`a job past the cap did not fail loudly: ${said[said.length - 1]}`); else ok();
    // 5. the journal brings a running job back after a restart, and a finished one with its prompt
    const lines = fs.readFileSync(journal, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    if (!lines.some(l => l.key === 'wd1' && l.ev === 'drafted' && l.prompt === 'Objetivo: X')) fail('the journal lost the delivered prompt'); else ok();
    fs.appendFileSync(journal, JSON.stringify({ at: now, key: 'rs1', ev: 'start', state: 'running', model: 'Opus', session: 'harbor', startedAt: now - 60000 }) + '\n');
    pw._jobs.clear();
    pw._recover(now);
    if (!pw._jobs.get('rs1') || pw._jobs.get('rs1').state !== 'running' || !pw._jobs.get('rs1').restored) fail('a job running at restart was not picked up again'); else ok();
    if (!pw._jobs.get('wd1') || pw._jobs.get('wd1').state !== 'drafted' || pw.last().key !== 'rs1') fail('finished jobs did not come back from the journal'); else ok();
    pw._jobs.clear();
    fs.rmSync(ws, { recursive: true, force: true });
    // ...and it happens at boot by itself: configure() is the only call the server makes.
    const pwSrc = fs.readFileSync(path.join(ROOT, 'lib/promptWriter.js'), 'utf8');
    if (!/function configure[\s\S]{0,200}recover\(\)/.test(pwSrc)) fail('configure() no longer recovers the journal at boot'); else ok();
    if (!/journal: stateFile\('prompt-jobs\.jsonl', '\.tsrct-prompt-jobs\.jsonl'\)/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))) fail('server.js gives the prompt writer no journal'); else ok();
}
// The "Sam me pidio esto" flow: research says WHERE, the code checks it,
// his yes opens the session with the prompt (2026-09-24).
{
    const fs = require('fs'), os = require('os');
    const pw = require('../lib/promptWriter');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
    fs.mkdirSync(path.join(root, 'harbor'));
    fs.mkdirSync(path.join(root, 'files'));
    fs.writeFileSync(path.join(root, 'files', 'sam.png'), 'x');
    fs.writeFileSync(path.join(root, 'files', 'secretco-plan.pdf'), 'x');
    const said = [], spawned = [], offered = [];
    pw.configure({
        projectsRoot: root, uploadRoots: [path.join(root, 'files')],
        resolveProject: (n) => (n === 'harbor' ? { project: 'harbor', cwd: path.join(root, 'harbor') } : { error: 'no' }),
        sessionExists: (n) => n === 'sam-report', nextSessionName: (n) => `${n}-2`,
        spawn: async (o) => { spawned.push(o); return { ok: true }; },
        offer: (k) => offered.push(k), say: (l) => said.push(l), draft: () => {}, send: () => {}, journal: null,
    });
    const files = pw.cleanFiles([path.join(root, 'files', 'sam.png'), path.join(root, 'files', 'secretco-plan.pdf'), '/etc/passwd', path.join(root, 'files', '..', 'harbor')]);
    if (files.length !== 1 || !files[0].endsWith('sam.png')) fail(`attachments not filtered to stored, non-SecretCo files: ${JSON.stringify(files)}`); else ok();
    const mk = (key) => pw._jobs.set(key, { goal: 'reporte para sam', mode: 'task', model: 'Opus', startedAt: Date.now() - 60000, state: 'running' });
    // an existing project
    mk('t1');
    pw._finish('t1', { ok: true, value: { prompt: 'Objetivo: reporte', summary: 'Sam quiere un reporte.', project: 'harbor', newFolder: '', session: 'Sam Report', why: 'es de harbor' } });
    const j1 = pw._jobs.get('t1');
    if (j1.state !== 'waiting' || j1.plan.cwd !== path.join(root, 'harbor') || j1.plan.session !== 'sam-report' || j1.plan.isNew) fail(`existing-project plan wrong: ${JSON.stringify(j1.plan)}`); else ok();
    if (offered[0] !== 't1' || !/Opus termino\. Sam quiere un reporte\. Propone el proyecto harbor, en una sesion sam-report/.test(said[said.length - 1])) fail(`plan not offered/told: ${said[said.length - 1]}`); else ok();
    if (!/ESPERA SU SI.*proyecto harbor, sesion sam-report; job t1/.test(pw.describe())) fail(`Haiku is not told the waiting plan and its key: ${pw.describe()}`); else ok();
    // the gate: start_task only takes a key that names a waiting plan
    actions.configure({ promptWriter: pw });
    try { const v = actions.validate('start_task', { job: 't1' }); if (!/abrir la sesion sam-report en harbor con el prompt de Opus/.test(v.action.confirmSays(v.args))) fail(`start_task question: ${v.action.confirmSays(v.args)}`); else ok(); } catch (e) { fail('start_task refused a waiting plan: ' + e.message); }
    try { const v = actions.validate('start_task', { job: 'invented' }); if (v.args.job !== 't1') fail('with one plan waiting, "abrila" did not pick it'); else ok(); } catch (e) { fail('one waiting plan was not picked: ' + e.message); }
    // his yes: a free name, the prompt pasted AND sent
    const r1 = await_(pw.startTask('t1'));
    // a new folder
    mk('t2');
    pw._finish('t2', { ok: true, value: { prompt: 'Objetivo: landing', summary: 'Algo nuevo.', project: '', newFolder: 'Landing Sam', session: 'landing', why: 'no existe' } });
    const j2 = pw._jobs.get('t2');
    if (!j2.plan || !j2.plan.isNew || j2.plan.cwd !== path.join(root, 'landing-sam')) fail(`new-folder plan wrong: ${JSON.stringify(j2.plan)}`); else ok();
    // refusals: an SecretCo folder, a project that does not exist and no folder
    mk('t3');
    pw._finish('t3', { ok: true, value: { prompt: 'Objetivo: x', project: '', newFolder: 'secretco-extra', session: 's' } });
    if (pw._jobs.get('t3').state !== 'failed' || fs.existsSync(path.join(root, 'secretco-extra'))) fail('an SecretCo folder was planned'); else ok();
    mk('t4');
    pw._finish('t4', { ok: true, value: { prompt: 'Objetivo: x', project: 'nope', newFolder: '', session: 's' } });
    if (pw._jobs.get('t4').state !== 'failed' || !/no encontre el proyecto nope/.test(said[said.length - 1])) fail('an unknown project was planned'); else ok();
    TASKS_ASYNC.push((async () => {
        const a = await r1;
        if (!a.ok || a.session !== 'sam-report-2' || spawned[0].cwd !== path.join(root, 'harbor') || spawned[0].prompt !== 'Objetivo: reporte' || spawned[0].submit !== true) fail(`start_task did not open the planned session with the prompt: ${JSON.stringify({ a, s: spawned[0] })}`); else ok();
        if (pw._jobs.get('t1').state !== 'started') fail('a started plan is not marked started'); else ok();
        await pw.startTask('t2');
        if (!fs.existsSync(path.join(root, 'landing-sam')) || !fs.statSync(path.join(root, 'landing-sam')).isDirectory() || spawned[1].cwd !== path.join(root, 'landing-sam')) fail('the new folder was not created and used'); else ok();
        try { await pw.startTask('t1'); fail('a plan was started twice'); } catch { ok(); }
        pw._jobs.clear();
        fs.rmSync(root, { recursive: true, force: true });
    })());
}
// Research may look everywhere that is his, and change nothing.
{
    const pw = require('../lib/promptWriter');
    const tools = pw.researchTools();
    if (!tools.includes('WebSearch') || !tools.some(t => /Slack__slack_search/.test(t)) || !tools.some(t => /Gmail__search_threads/.test(t))) fail('research lost the web or the connectors'); else ok();
    const writes = tools.filter(t => /send|create|update|delete|trash|_add|post|label_|move|merge|schedule/i.test(t));
    if (writes.length) fail(`research can change things: ${writes.join(', ')}`); else ok();
    // SecretCo as a permission on every analyst job, not a sentence
    const an = require('../lib/dispatcher/clickupAnalyst');
    // a throwaway root holding a restricted project's folder (secretco is the example name)
    const denyRoot = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'tsrct-deny-'));
    require('fs').mkdirSync(path.join(denyRoot, 'secretco-sandbox'));
    const rules = an.restrictedDenyRules([denyRoot]);
    const nameGlob = `Read(/${denyRoot}/**/*[Ss][Ee][Cc][Rr][Ee][Tt][Cc][Oo]*)`;
    if (!rules.includes(`Read(/${path.join(denyRoot, 'secretco-sandbox')}/**)`) || !rules.includes(nameGlob)) fail(`the restricted-project deny rules miss the folder or the name in any case: ${rules.join(' ')}`); else ok();
    require('fs').rmSync(denyRoot, { recursive: true, force: true });
    const src = require('fs').readFileSync(path.join(ROOT, 'lib/dispatcher/clickupAnalyst.js'), 'utf8');
    if (!/permissions: \{ deny: restrictedDenyRules\(\) \}[\s\S]{0,200}flags\.push\('--settings'/.test(src)) fail('submitJob no longer attaches the SecretCo deny settings to every job'); else ok();
}
// 2026-09-24: "si entendiste procede" started nothing, and Haiku said "ya esta
// en marcha". The yes words, Haiku's own yes, and the false-claim guard.
{
    for (const s of ['procede', 'dale procede', 'si procede', 'metele', 'segui']) {
        if (talk.decide(s) !== 'yes') fail(`"${s}" is not a yes`); else ok();
    }
    if (talk.decide('no procede') === 'yes') fail('"no procede" read as a yes'); else ok();
    for (const s of ['La investigación ya está en marcha en segundo plano.', 'Ya lo lancé, te aviso.', 'Ya arranqué la investigación.']) {
        if (!talk._claimsStarted.test(s)) fail(`not caught as a false start claim: ${s}`); else ok();
    }
    for (const s of ['Queres que Opus investigue la tarea?', 'Te aviso cuando termine.', 'No hay nada corriendo ahora.']) {
        if (talk._claimsStarted.test(s)) fail(`honest sentence caught as a claim: ${s}`); else ok();
    }
    const src = require('fs').readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    if (!/if \(pend && d\.action && d\.action\.name === pend\.name\) \{[\s\S]{0,200}runAction\(d\.action\.name, d\.action\.args, true\)/.test(src)) fail('Haiku repeating the pending ACCION no longer counts as his yes'); else ok();
    // Review #14 moved the test into falseClaim() (a send of the turn before is not a lie).
    if (!/haikuReply && falseClaim\(haikuReply, \{ ranThisTurn: \(state\.runs \|\| 0\) !== runsBefore/.test(src) || !/CLAIMS_STARTED\.test\(reply\)/.test(src)) fail('the false-start guard is gone'); else ok();
    const hb = require('fs').readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
    if (!/manda la MISMA ACCION otra vez/.test(hb)) fail('Haiku is no longer told how to say yes'); else ok();
    const ui = require('fs').readFileSync(path.join(ROOT, 'src/js/assistant.js'), 'utf8');
    if (!/log\.scrollTop = \(!keep \|\| keep\.atBottom\) \? log\.scrollHeight : keep\.top/.test(ui)) fail('the orb log jumps to the bottom on every poll again'); else ok();
}
// No button for it (2026-09-25): the `hands` session does it, says so, logs it.
{
    const fs = require('fs'), os = require('os');
    process.env.HANDS_POLL_MS = '20';
    delete require.cache[require.resolve('../lib/teslaHands')];
    const hands = require('../lib/teslaHands');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-'));
    const said = [], typed = [], spawned = [];
    let answer = null;
    hands.configure({
        tmux: (args) => { if (args[0] === 'has-session') return ''; return ''; },
        spawn: async (o) => { spawned.push(o); return { ok: true }; },
        paste: (s, text) => { typed.push(text); setTimeout(() => { answer = 'Listo.\nRESULTADO {"ok": true, "dijo": "Te deje el pdf en files.", "como": "pandoc x.md -o x.pdf", "falta": "un boton exportar a pdf"}'; }, 30); return { success: true }; },
        readAnswer: () => answer,
        denyRules: () => ['Read(//x/SecretCoSandbox/**)'],
        cwdOf: () => '', projectsRoot: dir, dataDir: dir, logFile: path.join(dir, 'logs', 'w.md'),
        say: (l) => said.push(l),
    });
    const p = hands._parseResult('bla\nRESULTADO {"ok": false, "dijo": "No pude.", "como": "x", "falta": "y"}');
    if (p.ok !== false || p.said !== 'No pude.' || p.missing !== 'y') fail(`RESULTADO not parsed: ${JSON.stringify(p)}`); else ok();
    if (hands._parseResult('solo texto').said !== 'solo texto') fail('an answer without RESULTADO was lost'); else ok();
    try { hands.start({ task: 'borra lo de secretco-sandbox' }); fail('an SecretCo task reached the hands session'); } catch { ok(); }
    const r = hands.start({ task: 'pasame el reporte a pdf', why: 'no hay accion de exportar', level: 'medium', changes: true });
    if (r.model !== 'Sonnet' || !r.changes) fail(`hands start: ${JSON.stringify(r)}`); else ok();
    TASKS_ASYNC.push((async () => {
        for (let i = 0; i < 100 && !said.length; i++) await new Promise(res => setTimeout(res, 20));
        if (!/--model claude-sonnet-5-5 --session-id [0-9a-f-]+ --settings /.test(spawned[0] && spawned[0].command || '')) fail(`worker command: ${spawned[0] && spawned[0].command}`); else ok();
        const settings = JSON.parse(fs.readFileSync(path.join(dir, 'hands-settings.json'), 'utf8'));
        if (!settings.permissions.deny.includes('Read(//x/SecretCoSandbox/**)') || !settings.permissions.deny.includes('Edit(//x/SecretCoSandbox/**)')) fail('the worker session is not denied SecretCo (read and edit)'); else ok();
        if (!/pasame el reporte a pdf/.test(typed[0] || '') || !/Ya confirmo que se puede cambiar/.test(typed[0] || '') || !/RESULTADO/.test(typed[0] || '')) fail('the task was not typed with its rules'); else ok();
        // Only the result (Tesla review #10): no "Sonnet lo hizo por otro camino:" in front.
        if (said[0] !== 'Te deje el pdf en files.') fail(`not told: ${said[0]}`); else ok();
        if (/secretco/i.test(typed[0] || '')) fail('the worker instruction names SecretCo - the screen guard then refuses to watch hands'); else ok();
        if (!/YA ANOTADO solo en logs\/tesla-workarounds\.md/.test(hands.describe()) || !/tarea "pasame el reporte a pdf"/.test(hands.describe())) fail(`Haiku is not told the task and that it is logged: ${hands.describe()}`); else ok();
        const log = fs.existsSync(path.join(dir, 'logs', 'w.md')) ? fs.readFileSync(path.join(dir, 'logs', 'w.md'), 'utf8') : '';
        if (!/\*\*Asked:\*\* pasame el reporte a pdf/.test(log) || !/\*\*How:\*\* pandoc/.test(log) || !/\*\*Missing button:\*\* un boton exportar a pdf/.test(log)) fail(`workaround not logged: ${log.slice(0, 300)}`); else ok();
        const j = hands.list().find(x => x.key === r.key);
        if (!j || j.state !== 'done' || j.what !== 'workaround' || j.model !== 'Sonnet') fail(`the panel does not show it: ${JSON.stringify(j)}`); else ok();
        hands.stopWorker('test');
        fs.rmSync(dir, { recursive: true, force: true });
    })());
    // the gate: looking runs at once, changing asks first
    const look = actions.CATALOG.find(a => a.name === 'look_into'), change = actions.CATALOG.find(a => a.name === 'workaround');
    if (!look || look.readOnly !== true || !change || change.readOnly !== false) fail('look_into must run at once and workaround must ask'); else ok();
    const hb = fs.readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
    if (!/SIN BOTON/.test(hb) || /decile que eso todavia no lo podes hacer/.test(hb)) fail('Haiku still says "no puedo" instead of finding another way'); else ok();
}
// `hands` stays open while he keeps talking to it (2026-09-25: it was killed
// 15 min after the last TASK, between Tesla's question and his yes, while he
// had been asking it follow-ups the whole time).
TASKS_ASYNC.push((async () => {
    const fs = require('fs'), os = require('os');
    const saved = process.env.HANDS_IDLE_MS;
    process.env.HANDS_IDLE_MS = '300';
    delete require.cache[require.resolve('../lib/teslaHands')];
    const hands = require('../lib/teslaHands');
    process.env.HANDS_IDLE_MS = saved || '';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-idle-'));
    const transcript = path.join(dir, 't.jsonl');
    fs.writeFileSync(transcript, '');
    const killed = [];
    let answer = null;
    hands.configure({
        tmux: (args) => { if (args[0] === 'kill-session') killed.push(Date.now()); return ''; },
        spawn: async () => ({ ok: true }),
        paste: () => { setTimeout(() => { answer = 'RESULTADO {"ok": true, "dijo": "ok", "como": "x", "falta": ""}'; }, 20); return { success: true }; },
        readAnswer: (e) => { e.file = transcript; return answer; },
        denyRules: () => [], cwdOf: () => '', projectsRoot: dir, dataDir: dir, logFile: path.join(dir, 'w.md'), say: () => {},
    });
    hands.start({ task: 'mirame algo', level: 'simple' });
    for (let i = 0; i < 50 && hands.list().some(j => j.state !== 'done'); i++) await new Promise(r => setTimeout(r, 20));
    const before = killed.length;
    // he keeps talking to it for ~2x the idle window
    for (let i = 0; i < 6; i++) { fs.appendFileSync(transcript, '{}\n'); await new Promise(r => setTimeout(r, 100)); }
    if (killed.length !== before) fail('hands was closed while he was still talking to it'); else ok();
    // a follow-up asked straight to it, and what it did for it, reach the log
    fs.appendFileSync(transcript, [
        { type: 'user', message: { role: 'user', content: 'de donde sacaste lo de Jacqueline?' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__gmail__search_threads', input: { query: 'Jacqueline' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
        { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Del mail de Shopify Inbox.' }] } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    await new Promise(r => setTimeout(r, 900));
    if (killed.length === before) fail('hands never closed after going quiet'); else ok();
    const flog = fs.existsSync(path.join(dir, 'w.md')) ? fs.readFileSync(path.join(dir, 'w.md'), 'utf8') : '';
    if (!/follow-ups asked straight to hands/.test(flog) || !/\*\*Asked:\*\* de donde sacaste lo de Jacqueline/.test(flog)
        || !/\*\*Answered:\*\* Del mail de Shopify Inbox/.test(flog) || !/\*\*Used:\*\* mcp__gmail__search_threads \(Jacqueline\)/.test(flog)) fail(`follow-ups not logged: ${flog.slice(-400)}`); else ok();
    if (/RESULTADO/.test(flog.split('follow-ups')[1] || '')) fail('the task itself was logged again as a follow-up'); else ok();
    fs.rmSync(dir, { recursive: true, force: true });
})());
// 2026-09-25 session review: the brain hid a dialog, promised without acting,
// and had no way to open a session WITH a first instruction.
{
    const fs = require('fs');
    const hb = fs.readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
    if (!/--disallowedTools [^'"]*AskUserQuestion/.test(hb)) fail('the hidden brain may open a dialog nobody sees'); else ok();
    if (!/kill\(where\.name\);(\s*lastCall = [^\n]*)?\s*throw new Error\('Haiku did not answer in time'\)/.test(hb)) fail('a stuck brain is not restarted'); else ok();
    for (const s of ['Voy a revisar el estado del proyecto HARBOR.', 'Dejame ver que hizo.', 'Dale, voy a abrirla.']) {
        if (!talk._promises.test(s)) fail(`promise not caught: ${s}`); else ok();
    }
    for (const s of ['Listo, esta abierta.', 'Queres que la abra?', 'La demo es manana a las 12.']) {
        if (talk._promises.test(s)) fail(`not a promise, caught anyway: ${s}`); else ok();
    }
    const tk = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    if (!/PROMISES\.test\(d\.say\)[\s\S]{0,320}haiku\.nudge/.test(tk)) fail('a promise without an action is no longer nudged'); else ok();
    try {
        const v = actions.validate('open_session', { project: 'tsrct', prompt: 'revisa como quedo la demo' });
        if (!/y pedirle: revisa como quedo la demo$/.test(v.action.confirmSays(v.args))) fail(`open_session with a first message: ${v.action.confirmSays(v.args)}`); else ok();
    } catch (e) { fail('open_session refused a first message: ' + e.message); }
}
// Haiku is handed the background state every turn, and the orb's slow poll
// only carries background lines.
{
    const fs = require('fs');
    const hb = fs.readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
    if (!/Trabajo en segundo plano: \$\{background/.test(hb)) fail('haiku.decide is not given the background state'); else ok();
    if (!/background: backgroundText\(\)/.test(fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8'))) fail('talk.js does not pass the background state to haiku.decide'); else ok();
    talk.announce('prueba de fondo');
    const js = talk.jobsStatus({ since: 0 });
    if (!js.say.length || js.say.some(x => x.kind !== 'bg')) fail('jobsStatus leaks non-background lines or drops the background one'); else ok();
    if (!talk.someoneWatching()) fail('an orb polling for jobs does not count as someone watching'); else ok();
    // 2026-10-14: progress lines wait while he talks or dictates; a permission
    // request does not. The orb tells them apart by `urgent` on the spooled line.
    const before = talk.status({ since: 0 }).seq;
    talk.announce('sigue con los tests');
    talk.announce('Necesito tu permiso para seguir: borrar build.', { urgent: true });
    const lines = talk.status({ since: before }).say;
    if (lines.length !== 2 || lines[0].urgent || !lines[1].urgent) fail(`a progress line must not be urgent and a permission line must be (got ${JSON.stringify(lines.map(x => [x.text, !!x.urgent]))})`); else ok();
    const tk2 = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    const prop = tk2.slice(tk2.indexOf('function propose('), tk2.indexOf('function propose(') + 1800);
    if (!/pushSay\(line, 'offer', \{ urgent: \/permission\/\.test\(action\.name\) \}\)/.test(prop)) fail('an offer to approve a permission is not spooled as urgent'); else ok();
    const hands = fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8');
    if (!/deps\.say\(`Necesito tu permiso[^`]*`, \{ urgent: true \}\)/.test(hands)) fail('the hands worker\'s permission line is not urgent'); else ok();
}
// Haiku picks how hard the prompt is; the level picks the model that writes it.
{
    const pw = require('../lib/promptWriter');
    const want = { simple: /haiku/, medium: /sonnet-5/, complex: /opus-5-5/ };
    for (const [lvl, re] of Object.entries(want)) {
        if (!re.test(pw.MODELS[lvl])) fail(`level ${lvl} -> ${pw.MODELS[lvl]}`); else ok();
    }
    for (const [said, lvl] of [['simple', 'simple'], ['complex', 'complex'], ['medium', 'medium'], ['opus', 'complex'], ['cualquier cosa', 'medium']]) {
        if (actions.TYPES.level(said) !== lvl) fail(`level("${said}") != ${lvl}`); else ok();
    }
    const v = actions.validate('research_prompt', { goal: 'arreglar el login', level: 'complex' });
    if (!/^que Opus/.test(v.action.confirmSays(v.args))) fail(`research_prompt question: ${v.action.confirmSays(v.args)}`); else ok();
}
// A new session can be given a NAME ("una nueva con el nombre creators").
{
    let got;
    try { const v = actions.validate('open_session', { project: 'tsrct', name: 'Creators Lab' }); got = v.action.confirmSays(v.args); } catch (e) { got = 'ERROR ' + e.message; }
    if (got !== 'abrir una sesion nueva en tsrct con el nombre creators-lab') fail(`named session -> ${JSON.stringify(got)}`); else ok();
    try { actions.validate('open_session', { project: 'tsrct', name: 'tesla-x' }); fail('a session was allowed the hidden tesla- prefix'); } catch { ok(); }
    try { const v = actions.validate('open_session', { project: 'tsrct' }); if (v.args.name !== undefined) fail('name is optional and was invented'); else ok(); } catch (e) { fail('open_session without a name: ' + e.message); }
}
// ...and a whole new request is still NOT an answer.
if (talk._answerFits({ name: 'open_session', key: 'project', args: {} }, 'cual es la lista de tareas que tengo para hoy')) fail('a new request was read as the answer to "cuales?"'); else ok();
if (talk._answerFits({ name: 'say_to_session', key: 'session', args: {} }, 'no se la verdad dejame pensarlo un rato')) fail('a long ramble was read as a one-session answer'); else ok();

// ── only HE ends a conversation (2026-09-24) ────────────────────────────────
// "yo puedo estar en una conversacion durante un largo rato y no por eso voy a
// estar hablando ... la conversacion la deberia desactivar yo manualmente".
for (const said of ['tesla, terminamos', 'chau tesla', 'terminamos', 'tesla apagate', 'cortamos tesla', 'listo tesla, eso es todo', 'termina la conversacion']) {
    if (!talk._endsConversation(said)) fail(`"${said}" should end the conversation`); else ok();
}
for (const said of ['terminamos el deploy y despues vemos', 'decile que terminamos', 'chau', 'apaga la luz azul', 'eso es todo lo que hizo?']) {
    if (talk._endsConversation(said)) fail(`"${said}" must NOT end the conversation`); else ok();
}
{
    const MIN = 60000, now = Date.now();
    // Silent for two hours, with the panel open: stays open.
    if (talk._abandoned({ now, lastPollAt: now - 5000 })) fail('silence with a window open closed the conversation'); else ok();
    // No window has asked in 25 minutes (tab closed, laptop asleep): let go of the card.
    if (!talk._abandoned({ now, lastPollAt: now - 25 * MIN })) fail('a conversation nobody can hear was kept loaded'); else ok();
}

// ── tesla review 2026-10-05: his real sentences from that night ─────────────
console.log('[check-talk] review 2026-10-05');
{
    // 1. Six of eight sends asked "si o no?" after he had already given the order
    //    with a verb the code did not know: preguntale, pedirle, decirle.
    const say = { name: 'say_to_session', args: { session: 'skool-brain', text: 'x' } };
    const CASES = [
        ['pregúntale si los cambios de el cerebro de verde soap los subió a ws', true],
        ['okay le puedes pedir que corra el skill de declaración', true],
        ['okay pedirle que declare estos cambios', true],
        ['no ya está su decirle que lo subas que está perfecto que lo suba junto a lo otro', true],
        ['antes pregúntale si se refiere a ese conjunto de skills de marketing', true],
        ['no le preguntes nada', false],
        ['no le pidas eso', false],
        ['que le podria preguntar?', false],
    ];
    for (const [said, want] of CASES) {
        if (talk._saidDirectly(said, say) !== want) fail(`saidDirectly("${said}") != ${want}`); else ok();
    }
    // 2. "Ya está, le acabo de decir que lo suba" - and nothing was sent.
    for (const s of ['Ya está, le acabo de decir que lo suba junto con Traffic Ninjas.', 'Ya se lo dije.', 'Ya le pedí que lo suba.', 'Se lo acabo de mandar.']) {
        if (!talk._claimsStarted.test(s)) fail(`not caught as a false claim: ${s}`); else ok();
    }
    for (const s of ['Le digo que lo suba?', 'Claude dice que ya lo subió.']) {
        if (talk._claimsStarted.test(s)) fail(`honest sentence caught as a claim: ${s}`); else ok();
    }
    // 3. Watching winery-audits, "decirle que lo explique" went to skool-brain,
    //    the only session in "what you already did". Unnamed -> the one he watches.
    const fix = talk._fixSession;
    const said1 = 'okay ahora necesito que me lo expliquen de una forma básica decirle que lo explique en mis palabras';
    if (fix({ session: 'skool-brain', text: 'x' }, 'winery-audits', said1).session !== 'winery-audits') fail('an unnamed send did not go to the watched session'); else ok();
    if (fix({ session: 'harbor', text: 'x' }, 'winery-audits', 'decile a harbor que pare').session !== 'harbor') fail('a send he aimed BY NAME was moved'); else ok();
    if (fix({ session: 'skool-brain', text: 'x' }, '', said1).session !== 'skool-brain') fail('with nothing watched the session must stay'); else ok();
    if (fix({ session: 'marketing-seo', text: 'x' }, 'winery-audits', 'decile a la de seo que pare').session !== 'marketing-seo') fail('a partial name ("la de seo") counts as naming it'); else ok();
    // 4. "explicame bien todo de una manera sencilla": Haiku wrote 1866 characters
    //    and he heard two sentences, then "te estas quedando callada".
    const long = 'Dale, te cuento todo. Uno es esto. Dos es aquello. Tres es lo otro. Cuatro cierra.';
    if (!talk._wantsDetail('no pero eso no explica todo explícame bien todo de una manera sencilla')) fail('"explicame bien todo" is not read as asking for detail'); else ok();
    if (!talk._wantsDetail('me explicas con mis palabras los hallazgos')) fail('"me explicas" is not read as asking for detail'); else ok();
    if (talk._wantsDetail('en qué quedó esta sesión')) fail('a plain status question was read as asking for detail'); else ok();
    if (speech.shape(long, { long: true }) !== long) fail(`a long answer he asked for was cut: "${speech.shape(long, { long: true })}"`); else ok();
    if (speech.shape(long) !== 'Dale, te cuento todo. Uno es esto.') fail('the normal answer is no longer two sentences'); else ok();
    // 5. Cut off mid-dictation by a narration: what the page lost reaches the
    //    brain on his next turn, so "me interrumpiste, segui" has something to
    //    continue. Once, recent, and never SecretCo.
    talk._lost.length = 0;
    talk.noteLost('decile que revise el reporte de octubre y que');
    talk.noteLost('secretco sandbox deploy');
    const note = talk._lostNote();
    if (!/revise el reporte de octubre/.test(note)) fail(`a lost sentence does not reach the brain: "${note}"`); else ok();
    if (/secretco/i.test(note)) fail('an SecretCo sentence reached the lost-sentence note'); else ok();
    if (talk._lostNote() !== '') fail('a lost sentence was handed over twice'); else ok();
    talk._lost.push({ text: 'vieja', at: Date.now() - 20 * 60000 });
    if (talk._lostNote() !== '') fail('a lost sentence from 20 minutes ago was handed over'); else ok();
    // 7. Review #2 (23:51): watching personal-runner-app he said "pedile que se
    //    ponga a investigar como hacer un buen coach..." and was asked "que Sonnet
    //    investigue la tarea y te proponga donde abrir la sesion?" - a new-task
    //    plan, worded so it named nothing he said.
    const aimed = talk._askedOfSession;
    const coach = 'okay pedile que se ponga a investigar cómo hacer un buen coach por internet y ver si puede formar algún tipo de cerebro o skill';
    for (const n of ['plan_task', 'research_prompt', 'look_into', 'workaround']) {
        if (!aimed(n, coach, 'personal-runner-app')) fail(`"pedile que investigue..." while watching a session still goes to ${n}`); else ok();
    }
    if (aimed('plan_task', coach, '')) fail('with no session watched, "pedile" cannot be about one'); else ok();
    if (aimed('research_prompt', 'armale un prompt y mandaselo a harbor', 'personal-runner-app')) fail('"armale un prompt" is a prompt job, not a message'); else ok();
    if (aimed('plan_task', 'Sam me pidio un reporte nuevo, investigalo', 'personal-runner-app')) fail('a new job with no ask-verb was rerouted'); else ok();
    if (aimed('say_to_session', coach, 'personal-runner-app')) fail('a send was flagged as misrouted'); else ok();
    const plan = actions.CATALOG.find(a => a.name === 'plan_task');
    const says = plan.confirmSays({ goal: 'Investigar cómo armar un buen coach de correr para Leon por internet', level: 'medium' });
    if (!/coach de correr/.test(says)) fail(`the plan_task question does not say WHAT: "${says}"`); else ok();
    // 6. The orb must hold its own lines while he talks or owes an answer.
    const orb = require('fs').readFileSync(path.join(ROOT, 'src/js/assistant.js'), 'utf8');
    // 2026-10-14: the rule itself is now holdLine() (tested case by case in check-ui).
    if (!/function drain\(\) \{[\s\S]{0,500}otherSpeaking\(\) \? -1 : talk\.queue\.findIndex\(x => !holdLine\(x, s\)\)/.test(orb)) fail('the orb speaks a narration over him (drain does not ask holdLine)'); else ok();
    // Without interim results: those repeated every phrase on the phone.
    if (/interimResults: true/.test(orb) || !/me\.onspeechstart = /.test(orb)) fail('the orb must tell he is mid-phrase from speech events, never interim results'); else ok();
    if (!/awaitUntil = Date\.now\(\)/.test(orb)) fail('a question it asked him does not hold the narrations'); else ok();
}

// ── Tesla review #3 (2026-10-08) ─────────────────────────────────────────────
{
    const speech = require(path.join(ROOT, 'lib/speech.js'));
    const fs = require('fs');
    // 1. "me abre una sesion de teserac por favor" -> "no hay nada que se llame
    //    teserac" (20:54). Tesla SAYS tsrct as "teseract"; the recogniser hands
    //    back "teserac". The heard forms map back before anything reads him.
    const heard = typeof speech.fromVoice === 'function' ? speech.fromVoice : (s) => s;
    for (const s of ['me abre una sesión de teserac por favor', 'abrime una en teseract', 'la nueva sesión de tesseract', 'mandale a teserack']) {
        if (!/\btsrct\b/.test(heard(s))) fail(`"${s}" is not read as tsrct (got "${heard(s)}")`); else ok();
    }
    for (const s of ['tesla, terminamos', 'hola tesla', 'una tesis nueva']) {
        if (heard(s) !== s) fail(`"${s}" was rewritten to "${heard(s)}"`); else ok();
    }
    const tsrc = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    if (!/clean = speech\.fromVoice\(clean\)/.test(tsrc)) fail('askTurn does not map heard names back before reading him'); else ok();
    // 2. "decirle que haga la revision de tesla" -> "no la tengo en mi lista de
    //    sesiones" (20:56): the brain's action list, written ONCE when it starts,
    //    said `session (uno de: <the sessions at that moment>)`, and tsrct-2 was
    //    opened 30 s earlier. Session names must come from each turn's live line.
    const cat = typeof talk._catalogueText === 'function' ? talk._catalogueText() : '';
    const sts = (cat.match(/^- say_to_session:.*$/m) || [''])[0];
    if (!sts) fail('the catalogue has no say_to_session line');
    else if (/uno de:/.test(sts) || !/Sesiones abiertas ahora/.test(sts)) fail(`say_to_session still lists the sessions frozen at boot: ${sts.slice(0, 160)}`);
    else ok();
    // 3. The same narration spoken three times in a row (2026-10-07 00:50, id=2,
    //    he hushed it; 2026-10-08 20:52, id=7, twice). Two status polls in flight
    //    with the same `since` both queued it.
    const orb3 = fs.readFileSync(path.join(ROOT, 'src/js/assistant.js'), 'utf8');
    const tickBody = orb3.slice(orb3.indexOf('async function tick()'), orb3.indexOf('// ── the buttons it was asked to press'));
    if (!/if \(ticking\) return;/.test(tickBody)) fail('two status polls can still be in flight at once'); else ok();
    if (!/item\.id <= talk\.since\) continue;/.test(tickBody)) fail('a line already queued can be queued again'); else ok();
}

// ── Tesla review #4 (2026-10-08, evening) ────────────────────────────────────
{
    const fs = require('fs');
    const tsrc = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    // 1. Tesla: "Le escribo a la sesion daily-tasks que necesitas trabajar una
    //    tarea para Holly... Dale?" -> "yes please do that" -> the send was moved
    //    to hollysentials (the one on screen, not even open) and refused twice.
    const fix = talk._fixSession;
    const lastLine = 'Le escribo a la sesión daily-tasks que necesitás trabajar una tarea para Holly. ¿Dale?';
    if (fix({ session: 'daily-tasks', text: 'x' }, 'hollysentials', 'yes please do that', { recent: lastLine, open: ['daily-tasks', 'hollysentials'] }).session !== 'daily-tasks') fail('a session Tesla named in its own question was moved by his "yes"'); else ok();
    if (fix({ session: 'daily-tasks', text: 'x' }, 'hollysentials', 'yes please do that', { open: ['daily-tasks', 'pro-services'] }).session !== 'daily-tasks') fail('a send was moved to a watched session that is not open'); else ok();
    if (fix({ session: 'skool-brain', text: 'x' }, 'winery-audits', 'decirle que lo explique en mis palabras', { recent: 'El analisis cruzo todo contra Commerce7.', open: ['skool-brain', 'winery-audits'] }).session !== 'winery-audits') fail('the winery case regressed: an unnamed send must still go to the watched session'); else ok();
    if (!/fixSession\(d\.action\.args, target, clean, \{/.test(tsrc)) fail('talk.js does not hand fixSession the last exchange and the open sessions'); else ok();
    // 2. "Le escribo a ... Dale?" with NO ACCION behind it: the question guard
    //    skipped anything with a question mark, so his yes had nothing pending.
    const asks = talk._asksToAct;
    for (const s of [lastLine, 'Le mando a pro-services que corra /code-review, ¿dale?', 'Te abro una sesión nueva en tsrct, ¿dale?', 'Le voy a pedir a la sesión que cargue el contexto. ¿Le mando?']) {
        if (!asks || !asks.test(s)) fail(`a yes-question with no action is not caught: ${s}`); else ok();
    }
    for (const s of ['¿Te referís a TSRCT, la carpeta tsrct?', '¿Querés que la sesión se abra en esta terminal o en una nueva?', 'Listo, se lo mande a run.']) {
        if (asks && asks.test(s)) fail(`not a yes-question for an action, caught anyway: ${s}`); else ok();
    }
    if (!/ASKS_TO_ACT\.test\(d\.say\)/.test(tsrc)) fail('a yes-question with no ACCION is not nudged'); else ok();
    // 3. He spoke English (22:06-22:12) and it answered in Spanish, in the Spanish voice.
    // Tesla review #8 (on his run): she asked "Queres que le diga que si a esa sesion?"
    // with NO action behind it, so his "si por favor" only produced the action and
    // the gate asked again - every permission cost him three or four turns.
    {
        const asks = talk._asksToAct || { test: () => false };
        for (const said of ['Personal-runner-app pidió otro permiso: quiere revisar sus conversaciones anteriores. ¿Querés que le diga que sí a esa sesión?',
            '¿Querés que le mande que sí a personal-runner-app?', '¿Le apruebo el permiso a harbor?']) {
            if (!asks.test(said)) fail(`"${said.slice(-60)}" offers to act and must carry its action`); else ok();
        }
        if (asks.test('¿Querés que te cuente cómo va?')) fail('an offer to TELL him something is not an action'); else ok();
        const tsrc = require('fs').readFileSync(path.join(ROOT, 'lib', 'talk.js'), 'utf8');
        if (!/trace\('yes-to-her-question'/.test(tsrc)) fail('a plain yes to her own yes/no question runs the action she then names, without asking again'); else ok();
    }
    // Tesla review #8: 21:59 she sent his message to personal-runner-app while
    // watching nothing; 22:00 "y como va" -> "no tengo a la vista que esta haciendo",
    // and he asked "que te dijo" four times that run. A send she is not watching
    // the answer to now starts watching that session.
    {
        const tsrc = require('fs').readFileSync(path.join(ROOT, 'lib', 'talk.js'), 'utf8');
        const ra = tsrc.slice(tsrc.indexOf('async function runAction('), tsrc.indexOf('function sentSentence('));
        if (!/follow\(followTarget\(r\.action, r\.value\)\)/.test(ra)) fail('what she touches is what she watches, so its answer comes back by itself'); else ok();
        if (!/Te aviso cuando conteste/.test(tsrc)) fail('and she says she will tell him the answer'); else ok();
    }
    // 2026-10-24: no session picker any more. She follows the session she last
    // TOUCHED (wrote to, or opened), even over one she was watching; one she only
    // mentioned, or a batch of several, moves nothing.
    {
        const ft = talk._followTarget || (() => 'missing');
        const cases = [
            [['say_to_session', { sent: true, session: 'harbor' }], 'harbor', 'a send she made'],
            [['say_to_session', { sent: false, session: 'harbor' }], '', 'a send that did not arrive'],
            [['say_to_sessions', { sent: [{ ok: true, session: 'a' }, { ok: true, session: 'b' }] }], '', 'a send to several'],
            [['open_session', { opened: [{ session: 'tsrct-2', ok: true }] }], 'tsrct-2', 'a session she opened'],
            [['open_session', { opened: [{ session: 'x', ok: true }, { session: 'y', ok: true }] }], '', 'a batch she opened'],
            [['open_session', { opened: [{ session: 'x', ok: false }] }], '', 'a session that did not open'],
            [['reopen_sessions', { opened: [{ session: 'notes', ok: true }] }], 'notes', 'a session she reopened'],
            [['play_music', { ok: true }], '', 'anything else'],
        ];
        for (const [[name, v], want, what] of cases) {
            const got = ft(name, v);
            if (got !== want) fail(`followTarget: ${what} -> ${JSON.stringify(want)} (got ${JSON.stringify(got)})`); else ok();
        }
        const tsrc = require('fs').readFileSync(path.join(ROOT, 'lib', 'talk.js'), 'utf8');
        const fb = tsrc.slice(tsrc.indexOf('function follow('), tsrc.indexOf('function sentSentence('));
        if (/state\.session && state\.watch\) return/.test(fb)) fail('following must not refuse because another session is watched'); else ok();
        // "que hace esta sesion" still means the one on his screen: the page sends it
        // as `home`, and she LOOKS at it for that turn without watching it (the rule:
        // no news from a session she did not touch).
        const route = require('fs').readFileSync(path.join(ROOT, 'lib', 'routes', 'tesla.js'), 'utf8');
        if (!/talk\.ask\(\{[^}]*home: p\.home/.test(route)) fail('the say route passes the on-screen session as home'); else ok();
        const at = tsrc.slice(tsrc.indexOf('async function askTurn('), tsrc.indexOf('async function decideTurn('));
        if (!/if \(!target && home\)/.test(at)) fail('askTurn looks at the on-screen session only when it watches none'); else ok();
        if (/attach\(\{ session: home/.test(at) || /openLight\(home/.test(at)) fail('the on-screen session is looked at, never watched'); else ok();
    }
    // Pending since review #6 (2026-10-08 22:52): "okay le puedes pedir hasta" was
    // sent after the 2.5 s pause while he was still thinking; he said it all again
    // five minutes later. A sentence that ends on a word that cannot end one waits
    // longer. The orb is a browser file, so its rule is read out of it and run.
    {
        const orb = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'assistant.js'), 'utf8');
        const m = /const DANGLING = (\/.*\/[a-z]*);/.exec(orb);
        if (!m) fail('the orb has no rule for a sentence that stops mid-way');
        else {
            const re = eval(m[1]);
            for (const said of ['okay le puedes pedir hasta', 'decile que', 'mandale el archivo de', 'abrime una sesion en', 'send it to the']) { if (!re.test(said)) fail(`"${said}" is not finished: it should wait longer`); else ok(); }
            for (const said of ['si por favor', 'abrime una sesion en harbor', 'que esta haciendo tsrct', 'cómo va', 'okay ahora']) { if (re.test(said)) fail(`"${said}" is a whole sentence: it must not wait longer`); else ok(); }
        }
        if (!/DANGLING\.test\(t\)\s*\?\s*LONG_PAUSE_MS/.test(orb)) fail('pauseFor uses the longer pause for a sentence that stops mid-way'); else ok();
    }
    // Tesla review #6: what she answers to a line that was not for her is silence.
    {
        const nf = talk._notForMe || (() => false);
        for (const said of ['(silencio)', 'Silencio.', ' (silencio) ']) { if (!nf(said)) fail(`"${said}" should be taken as silence`); else ok(); }
        for (const said of ['silencio en la sesion de harbor, termino', 'Hola Leon, todo bien.']) { if (nf(said)) fail(`"${said}" is a real answer, not silence`); else ok(); }
    }
    const lang = talk._langOf || (() => null);
    for (const [s, want] of [
        ["i'm sorry what i wanted you to do is to open in this same session applaud session in the directory for daily tasks", 'en'],
        ["okay let's do that", 'en'], ['yes please do that', 'en'], ['no i wanted to be in this same terminal', 'en'],
        ['cómo va esto', 'es'], ['sí por favor', 'es'], ['okay decirle que proceda con los arreglos', 'es'],
        ['okay', null], ['tsrct', null],
    ]) {
        if (lang(s) !== want) fail(`language of "${s}" -> ${lang(s)}, want ${want}`); else ok();
    }
    if (!talk._voiceFor || talk._voiceFor('en') !== 'en_US-lessac-high' || talk._voiceFor('es') !== talk.VOICE) fail('English is not spoken with the English voice'); else ok();
    const sp = require(path.join(ROOT, 'lib/speech.js'));
    if (/seis/.test(sp.forVoice('the demo is at 18:30', 'en_US-lessac-high'))) fail('an English sentence gets the Spanish clock'); else ok();
    if (!/seis y media/.test(sp.forVoice('la demo es a las 18:30', talk.VOICE))) fail('the Spanish clock is gone'); else ok();
    // 6. "Queres que haga esto: abrir las 0 sesiones del plan de la maniana: ?" (2026-10-06 11:29)
    const om = actions.CATALOG.find(a => a.name === 'open_morning');
    if (!om || typeof om.offerable !== 'function' || om.offerable() === true) fail('the morning plan is offered with nothing in it'); else ok();
    if (!/offerable/.test(tsrc.slice(tsrc.indexOf('function propose('), tsrc.indexOf('function propose(') + 900))) fail('propose() does not ask the action whether there is anything to offer'); else ok();
    // 9. A bare "si" after it asked waited the full 2.5 s pause before going out.
    const orb4 = fs.readFileSync(path.join(ROOT, 'src/js/assistant.js'), 'utf8');
    // 11. "me abris una sesion en marketing stack en esta misma terminal" (22:43Z,
    //     after the restart): opened it as a separate session, "show" put it in
    //     the main view, and the split panel he meant - the one showing creators -
    //     never changed: "pero no es lo que te pedi". No button could swap what a
    //     split panel shows. put_in_panel does, and open_session takes `panel`.
    const pip = actions.CATALOG.find(a => a.name === 'put_in_panel');
    if (!pip || !pip.readOnly || !/session/.test(Object.values(pip.args || {}).join(' '))) fail('there is no read-only put_in_panel action'); else ok();
    const os = actions.CATALOG.find(a => a.name === 'open_session');
    if (!os || !('panel' in os.args)) fail('open_session cannot be told which panel to open in'); else ok();
    const asrc = fs.readFileSync(path.join(ROOT, 'lib/actions.js'), 'utf8');
    // The spawn loop lives in openNow() since 2026-10-14; the action calls it.
    const osRun = asrc.slice(asrc.indexOf("name: 'open_session'"), asrc.indexOf("name: 'close_session'"))
        + asrc.slice(asrc.indexOf('async function openNow'), asrc.indexOf('function sessionsUpTo'));
    if (!/put_in_panel/.test(osRun)) fail('open_session with a panel does not put the new session there'); else ok();
    const dsk = ['desktop', 'desktop-sessions'].map(n => fs.readFileSync(path.join(ROOT, `src/js/${n}.js`), 'utf8')).join('\n');
    if (!/function pcCombineReplaceSession\(/.test(dsk) || !/window\.pcCombineReplaceSession = pcCombineReplaceSession/.test(dsk)) fail('the page cannot swap the session a split panel shows'); else ok();
    const uia = fs.readFileSync(path.join(ROOT, 'src/js/ui-actions.js'), 'utf8');
    if (!/put_in_panel:[\s\S]{0,300}pcCombineReplaceSession/.test(uia)) fail('the page has no put_in_panel handler'); else ok();
    const hbs = fs.readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
    if (!/misma terminal[\s\S]{0,300}panel/.test(hbs)) fail('the brain is not told "esta misma terminal" means the panel he is watching'); else ok();
    // 10. Every status poll (each 3.5 s while the orb is open) froze the whole
    //     server 1.2-1.6 s ([STALL] in the boot log, 2026-10-08 22:27-22:34):
    //     it built the full action list - 16 tmux calls, 1223 ms - to count it.
    const statusBody = tsrc.slice(tsrc.indexOf('function status('), tsrc.indexOf('module.exports = {'));
    if (/manifest\(\)/.test(statusBody)) fail('status() builds the whole action list on every poll'); else ok();
    if (!/pauseTimer = setTimeout\(\(\) => \{[\s\S]{0,900}\}, pauseFor\(heard\)\)/.test(orb4) || !/function pauseFor\(/.test(orb4)) fail('a short yes still waits the full pause'); else ok();
}

// ── the table may only name actions that exist ──────────────────────────────
console.log('[check-talk] the table still points at the catalogue');
const real = new Set(actions.CATALOG.map(a => a.name));
for (const n of understand.actionsNamed()) {
    if (!real.has(n)) fail(`lib/understand.js routes to "${n}", which is not in the catalogue any more`);
    else ok();
}
// The verb table's idea of "this one writes" must match the catalogue's. If an
// action stops being read-only and nobody updates the table, "mostrame eso"
// starts reaching something that changes his machine.
const writes = new Set(understand.writingActions());
for (const a of actions.CATALOG) {
    const spokenHere = understand.actionsNamed().includes(a.name);
    if (!spokenHere) continue;
    if (!a.readOnly && !writes.has(a.name)) fail(`"${a.name}" cambia algo pero lib/understand.js no lo marca writes: true`);
    else if (a.readOnly && writes.has(a.name)) fail(`"${a.name}" es de solo lectura pero el verbo esta marcado writes: true`);
    else ok();
}

// And the other way: an action nobody can ask for by voice is a button with no
// handle. Not a failure — a list, so it is a decision and not an oversight.
const spoken = new Set(understand.actionsNamed());
const mute = actions.CATALOG.map(a => a.name).filter(n => !spoken.has(n));
if (mute.length) console.log(`  [i] sin frase propia todavia (cae al modelo): ${mute.join(', ')}`);

// ── Tesla review #14 (2026-10-12, the evening of 10-10 and the 11th) ─────────
{
    const fs = require('fs');
    const tsrc = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    // 1. 21:35 the PC worker asked "¿Confirmás que querés que haga los pasos del Plan
    //    GEO en tu PC?", he said "sí por favor", Haiku aimed it at hands (as it was
    //    told to) and fixSession moved it to marketing-seo, the session on screen.
    //    "confirmar" then sent it there; hands sat waiting until he said it a third time.
    const fix = talk._fixSession;
    if (fix({ session: 'hands', text: 'Si, confirmado' }, 'marketing-seo', 'sí por favor', { recent: '', open: ['hands', 'marketing-seo'], asking: ['hands'] }).session !== 'hands') fail('his yes to a question hands just asked was moved to the session on screen'); else ok();
    if (fix({ session: 'hands', text: 'x' }, 'marketing-seo', 'decile que siga', { recent: '', open: ['hands', 'marketing-seo'] }).session !== 'marketing-seo') fail('with no open question from hands, an unnamed send still goes to the session on screen'); else ok();
    if (!/asking: handsAsked\(\)/.test(tsrc)) fail('talk.js does not tell fixSession that hands just asked him something'); else ok();
    // 2. An either/or question, or "¿le paso algo?", names no action to attach: the
    //    guard nudged them and the retry came back as an apology for nothing.
    const asks = talk._asksToAct;
    for (const s of ['No te entendí bien, Leon. ¿Querés que le mande lo de ejecutar en tu PC a marketing-seo, o que se lo pida a Opus para que lo ejecute?',
        'Hola, Leon. Opus sigue trabajando en la PC desde hace veintiún minutos con el test de IA, y marketing-seo sigue esperando el aviso. ¿Querés que le pase algo a la sesión?']) {
        if (asks.test(s)) fail(`not one action to attach, nudged anyway: ${s.slice(-70)}`); else ok();
    }
    // 3. 19:01 "hola güera" -> "Tenés razón, me equivoqué: ... Leon dijo sólo 'hola güera'".
    //    A QUESTION claims nothing; when the retry brings no action, the question stays.
    const after = talk._afterNudge;
    const q = { say: '¿Querés que le pase algo a la sesión?', action: null };
    if (!after || after(q, { say: 'Tenés razón, me equivoqué: no hay nada que pasarle.', action: null }).say !== q.say) fail('a question the retry could not turn into an action must be kept as it was'); else ok();
    if (!after || !after(q, { say: 'Le paso esto, ¿dale?', action: { name: 'say_to_session', args: {} } }).action) fail('a retry that brings the action wins'); else ok();
    const p = { say: 'Voy a revisar la sesión.', action: null };
    if (!after || after(p, { say: 'No lo puedo mirar desde acá.', action: null }).say === p.say) fail('a PROMISE with no action is still replaced by the honest retry'); else ok();
    // 4. 21:36 "Ya le mandé tu confirmación a marketing-seo" - true, it was sent the
    //    turn before - became "Perdon, no lance nada todavia. Pedimelo de nuevo".
    const lie = talk._falseClaim;
    const now = Date.now();
    if (!lie || lie('Ya le mandé tu confirmación a marketing-seo.', { ranThisTurn: false, lastRunAt: now - 30000, pending: null, now })) fail('a claim about the send of the turn before was called false'); else ok();
    if (!lie || !lie('Ya está en marcha.', { ranThisTurn: false, lastRunAt: 0, pending: null, now })) fail('a start nothing backs is still a false claim'); else ok();
    if (!lie || !lie('Ya está en marcha.', { ranThisTurn: false, lastRunAt: now - 30000, pending: { name: 'do_on_pc' }, now })) fail('a start claimed while the action still waits for his yes is still false'); else ok();
    // 5. 19:20 "como superó los 30 minutos se cortó": the PC job was dropped at 30
    //    minutes while hands kept working; she said "está parada" while he watched it
    //    run, and its result was never announced (he had to tell her "opus ya terminó").
    const hsrc = fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8');
    const m = /const TASK_MS = Number\(process\.env\.HANDS_TASK_MS \|\| ([\d\s*]+)\)/.exec(hsrc);
    const taskMs = m ? eval(m[1]) : 0;
    if (taskMs < 2 * 60 * 60 * 1000) fail(`a PC job is still dropped after ${Math.round(taskMs / 60000)} min while hands keeps working`); else ok();
    if (!/STILL_WORKING_MS/.test(hsrc)) fail('a long PC job does not say once that it is still working'); else ok();
}

// ── music skips the brain (Tesla review #16, 2026-10-14) ─────────────────────
// "poneme algo de lo-fi en spotify por favor" waited 18.1 s (Haiku cold start) and
// Haiku picked spotify_search, which plays nothing. A sure play_music from the
// parser now runs before Haiku is asked.
{
    const fp = talk._fastPick;
    if (typeof fp !== 'function') fail('talk._fastPick is missing');
    else {
        for (const s of ['poneme algo de lo-fi en spotify por favor', 'poneme algo de Bad Omen en spotify', 'me pones un poco de sade en spotify', 'sorprendeme con algo en spotify']) {
            const p = fp(understand.flat ? understand.flat(s) : s.toLowerCase());
            if (!p || p.name !== 'play_music') fail(`"${s}" does not go straight to play_music (got ${p && p.name})`); else ok();
        }
        for (const s of ['decile a tsrct que ponga musica', 'busca bad bunny en spotify', 'abri spotify', 'sorprendeme']) {
            const p = fp(understand.flat ? understand.flat(s) : s.toLowerCase());
            if (p) fail(`"${s}" skipped the brain as ${p.name}`); else ok();
        }
    }
    // Review #18 (2026-10-16): an artist with no music word went to Haiku all five
    // times (12-24 s each), and once Haiku answered "no tengo una herramienta para
    // poner musica". "algo de X" / "un poco de X" after a play verb IS music.
    if (typeof fp === 'function') {
        for (const s of ['poneme algo de eminem', 'tesla poneme algo de eminem', 'pone un poco de SADE', 'ponme algo de bad bunny']) {
            const p = fp(understand.flat(s));
            if (!p || p.name !== 'play_music' || !p.args.query) fail(`"${s}" does not go straight to play_music with a query (got ${p && p.name} ${JSON.stringify(p && p.args)})`); else ok();
        }
        for (const s of ['pasame algo de info', 'poneme un poco de contexto en la sesion', 'pone algo de eso en el excel']) {
            const p = fp(understand.flat(s));
            if (p) fail(`"${s}" became ${p.name}`); else ok();
        }
        // "no me gusta" right after a song (typed 3 s after it started): about the song.
        const after = understand.parse('no me gusta', { last: { musicAt: Date.now() - 20000 } });
        if (!after || after.name !== 'music_react' || after.args.liked !== 'no') fail(`"no me gusta" right after a song is not music_react (got ${after && after.name})`); else ok();
        const later = understand.parse('no me gusta', { last: { musicAt: Date.now() - 30 * 60000 } });
        if (later && later.name === 'music_react') fail('"no me gusta" half an hour after a song still reads as about the song'); else ok();
        if (!/musicAt/.test(require('fs').readFileSync(path.join(ROOT, 'lib', 'talk.js'), 'utf8'))) fail('talk.js does not remember when music started'); else ok();
    }
    const tsrc = require('fs').readFileSync(path.join(ROOT, 'lib', 'talk.js'), 'utf8');
    const iFast = tsrc.indexOf('(fast = fastPick(clean))'), iHaiku = tsrc.indexOf('} else if (usingHaiku() && !wantClaude) {');
    if (!(iFast > 0 && iFast < iHaiku)) fail('askTurn does not try fastPick before asking Haiku'); else ok();
}

// ── the time limit follows what Ollama REALLY holds (2026-09-24) ──────────────
// The model unloaded itself after a quiet spell, TALK still believed it was warm,
// gave a cold load the 90s warm limit and hung up at 93s ("client connection
// closed before server finished loading") - which then read as "Ollama is down".
(async () => {
    const limitWith = (resident) => talk._answerLimit({ loaded: async () => resident });
    const cold = await limitWith(false), warm = await limitWith(true);
    if (!(cold > warm && cold >= 240000)) fail(`a model that is NOT loaded must get the cold limit (got ${cold} vs warm ${warm})`); else ok();
    if (await talk._answerLimit({ loaded: async () => { throw new Error('x'); } }) !== cold) fail('when Ollama cannot be asked, assume cold'); else ok();
    await Promise.all(TASKS_ASYNC);
    finish();
})();
function finish() {
if (bad) {
    console.error(`\n[check-talk] ${bad} failure(s) of ${bad + checks}. The table is lib/understand.js.`);
    process.exit(1);
}
console.log(`[check-talk] ${checks}/${checks} — ${SAID.length} frases suyas, ${ANSWERS.length} respuestas, ${ORDERS.length} ordenes`);
}
