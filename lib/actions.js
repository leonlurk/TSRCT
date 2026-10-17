// ─────────────────────────────────────────────────────────────────────────
// lib/actions.js — THE BUTTONS, DECLARED. One list, and it is the only thing a
// model is ever allowed to reach for.
//
// Leon's design, in his words: "no le podemos dar un simple codemap que le de
// acceso a todos los comandos o botones y que sea codigo determinista? ... sip,
// valida cada botoncito que le habilites contra el codigo de TSRCT".
//
// Both halves of that matter, and the second one is the load-bearing half:
//
//   1. THE MODEL NEVER EXECUTES. Its entire output is {action, args} — a name
//      from this list and some values. Everything after that is ordinary code.
//   2. WHAT IT PRODUCES IS VALIDATED AGAINST THIS FILE, AND THIS FILE IS
//      VALIDATED AGAINST THE SERVER. An action naming a function that no longer
//      exists fails `npm run check` (scripts/check-actions.js), so the catalogue
//      cannot quietly drift away from the code the way a hand-written list of
//      capabilities always does.
//
// That is what makes "the model invents things" stop being the risk it was:
// an invented action name is not in the list, an invented argument does not
// validate, and neither one reaches a function. What survives validation is a
// real action with real arguments — so the only remaining error is the HUMAN
// kind (the right button, the wrong session), which is why anything with a side
// effect is `confirm: true` and has to be agreed to before it runs.
//
// SecretCo: every argument that names a session, a project or free text goes
// through the guard before the action runs. Fail closed, like everywhere else.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const restrictedGuard = require('./dispatcher/restrictedGuard');
const paneShape = require('./paneShape');
// The other half of the catalogue: the buttons that live in his browser. Same
// shape, same gate — the only difference is that their run() queues a press for
// the page instead of calling something here.
const ui = require('./uiActions');
// The Automations tab's list (2026-09-24): what runs by itself, and its switches.
const automations = require('./automations');

// What IT opened, this conversation. "cerra las dos que abriste" is the way he
// actually says it, and guessing from the session list would close his work.
let opened = [];
// The permission cards named in the last "aprobar N permisos?" question. Only
// those are decided on his yes.
let offeredCards = [];
const LEVEL_NAME = { simple: 'Haiku', medium: 'Sonnet', complex: 'Opus' };

let deps = {
    tmux: null,            // { listSessions, captureSession, sendToSession }
    killSession: null,     // (name) => {ok} — server.js's argv tmux + its own guards
    sessionSpawn: null,
    projectRegistry: null,
    projectMemory: null,
    setups: null,          // the saved boards (lib/setups.js)
    recent: null,          // () => what this conversation has already DONE
    morningRoutine: null,
    gpu: null,
    // BULK (2026-09-24) — each one the function the matching button already uses.
    permissionDesk: null,  // lib/permissionDesk.js: the cards the phone shows
    sessionWeight: null,   // lib/sessionWeight.js: how full each context is, and the handoff
    usage: null,           // lib/usage.js: what today cost
    clientHealth: null,    // lib/clientHealth.js: the Clients tab
    paneKeys: null,        // lib/paneKeys.js: keys and renames through server.js's argv tmux
    gitSummary: null,      // (cwd) => {branch, changed, ahead, last} via gitCwd's rules
    serverSession: null,   // () => the session TSRCT itself runs in
    promptWriter: null,    // lib/promptWriter.js: Opus researches and writes a prompt
    pcDirect: null,        // lib/pcDirect.js: open/reveal/launch/move on his PC without the mouse
    deskWindows: null,     // lib/deskWindows.js: place windows, layouts, PowerToys workspaces and zones
    deskShortcuts: null,   // lib/deskShortcuts.js: named shortcuts, routines, links into Settings/Spotify
    spotify: null,         // lib/spotify.js (required on first use when not configured): music that plays
    taste: null,           // lib/tasteBrain.js (same): his taste, what he likes and why
    pastSessions: require('./pastSessions'),   // no state and no I/O at load: safe as the default
};
function configure(d) { deps = { ...deps, ...(d || {}) }; }

// What makes a PC task need his yes even when the brain calls it harmless.
const RISKY_PC = /\b(mand|envi|respond|contest|borr|elimin|pag|compr|public|post|firm|acept|instal|desinstal|guard|escrib|redact|tipe|complet|llen|formulari|mail|correo|whats|mensaje|chat|transfer|descarg|suscrib|cancel|cerr\w* sin)/i;

// The fixed task texts of the recipe actions. Each one is how `hands` actually
// did the job on 2026-09-25 (read off its transcript), turned into steps.
const RECIPES = {
    day_status: () => [
        `Como viene el dia de Leon AHORA (${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}), no el resumen de la maniana.`,
        '1. Sesiones: `tmux ls` y la pantalla de cada una (capture-pane -S -40 a un archivo en tu scratchpad, luego python3), sin las tesla-* ni hands. Para cada una: trabajando, esperando su OK, o con un mensaje escrito sin mandar.',
        '2. Mail: Gmail in:inbox newer_than:1d, y lo que el mando hoy (from:me newer_than:1d).',
        '3. Calendario: lo que le queda de hoy y el proximo dia habil.',
        '4. ClickUp: sus tareas que vencen hoy y las vencidas (asignadas a "me").',
        '5. El resumen de la maniana de hoy en vault/sessions/<fecha>-morning-brief.md, solo para comparar que cambio.',
        '"dijo": donde esta parado y la UNA cosa que sigue, en una o dos frases cortas. "como": que miraste y que no pudiste mirar.',
    ].join('\n'),
    store_messages: (store) => [
        `Los mensajes que dejaron clientes en el chat de la tienda${store ? ` (${store})` : ''} (Shopify Inbox), ultimos 3 dias.`,
        'No hay conector de Shopify Inbox: cada mensaje llega como mail de no-reply@mailer.shopify.com con asunto "You have a new message from <nombre>". Buscalos en Gmail (from:mailer.shopify.com newer_than:3d "new message") y abri cada hilo con get_thread.',
        'Para cada uno: quien, que dijo textual, cuando (hora de Argentina), y si hay rastro de respuesta (un mail de la tienda a esa persona despues). Si el conector de la tienda (shopify-pv) esta, busca a la persona con get-customers y sus pedidos, SOLO lectura.',
        'No contestes a nadie. "dijo": cuantos mensajes y cual es el mas urgente, en dos frases.',
    ].join('\n'),
    draft_reply: (to, about) => [
        `Un BORRADOR de respuesta para ${to}${about ? `, sobre: ${about}` : ''}. NO lo mandes, no crees borradores en Gmail: solo el texto.`,
        'Primero busca el mensaje real de esa persona (Gmail, Slack o el chat de la tienda via los mails de mailer.shopify.com) y leelo entero. Escribi en el idioma en que ESA PERSONA escribio.',
        'El texto: corto, amable, sin afirmar como un hecho nada que no verificaste (si la causa es una suposicion, pregunta en vez de afirmar). Firmalo "Leon".',
        'Texto plano, sin comillas ni ">" delante, listo para copiar. Ponelo entero en "como"; en "dijo", una frase de que dice y que supuestos tiene.',
    ].join('\n'),
    // Step one of "Tesla on my PC" (2026-10-10): look only. The ONLY way to see
    // the screen is scripts/desk.js, which carries the SecretCo wall (lib/desk.js).
    look_at_screen: (question, screen, detail) => [
        `Mira la pantalla de la PC de Leon (Windows) y contesta: ${question}`,
        `1. Corre: node ${DESK_CLI} look${Number(screen) > 0 ? ` --screen ${Number(screen)}` : ''}`,
        '   Imprime JSON: "shots" (un PNG por monitor, con su posicion), "titles" (las ventanas abiertas) y "refused" (monitores que NO se pueden mirar).',
        '2. Abri cada PNG de "shots" con Read y mira la imagen.',
        '3. Si dice ok:false o un monitor esta en "refused": NO intentes verlo de otra forma (nada de powershell, capturas propias, ni leer otros archivos para adivinar). Decile por que no se pudo, con la frase que vino.',
        // Tesla review #10: "abrir slack y fijarse el ultimo mensaje de sam" ran
        // only the open half, and "yo solo puedo mirar" (WhatsApp on another
        // chat) cost him another yes. Reading inside an app needs getting there.
        `Si la pregunta es sobre un programa (Slack, WhatsApp, el navegador...), primero brings the app forward: node ${DESK_CLI} focus --window <programa> (o open --app <programa> si no esta abierto).`,
        `PODES NAVEGAR para leer: focus, open, hacer clic para abrir un chat, una pestana o un mensaje, scroll, y las teclas esc / flechas / pageup / pagedown.`,
        `   Mas rapido que el mouse: node ${DESK_CLI} routine --name "slack ir a" --what CANAL (abre ese canal o chat de Slack) y node ${DESK_CLI} windows (que hay abierto, sin captura). Detalle en ${SKILLS_DIR}/pc-shortcuts/SKILL.md.`,
        // The syntax, so it never has to ask the command (review #13: it ran --help,
        // grep and "| head", and stopped on permission cards).
        `   node ${DESK_CLI} click --screen N --x X --y Y   |   scroll --screen N --x X --y Y --amount 5 (positivo = arriba, negativo = abajo)   |   key --keys pageup`,
        '   X/Y son pixeles del PNG de ese monitor a tamano completo (si Read lo muestra achicado, multiplica por el factor que dice). Corre el comando TAL CUAL: sin cd, sin && ni &, sin | head, sin > archivo y sin 2>&1.',
        'NUNCA escribas, mandes, borres, aceptes, pagues ni cierres nada, y no hagas clic en botones que hacen eso (Enviar, Borrar, Aceptar, Comprar...). Si para contestar hace falta eso, no lo hagas: decilo.',
        'Contesta lo que se ve, sin inventar lo que no se lee bien.',
        detail === 'textual'
            ? '"dijo": lo que pidio palabra por palabra, en orden (cada mensaje con quien lo mando y su texto tal cual; si no entra en pantalla, scrolleá y segui). Hasta 2500 caracteres. "como": que miraste.'
            : detail
                // Review #12 asked for the whole thing; review #13 (his rule): read it ALL,
                // then EXPLAIN it - 172 s of messages read one by one was hushed.
                ? '"dijo": lee TODO (si no entra en pantalla, scrolleá y segui) y EXPLICASELO: que le quisieron decir o pedir, ordenado por tema y no mensaje por mensaje, con todos los datos que importan (montos, fechas, pedidos, preguntas que quedaron sin contestar, notas de voz que no pudiste oir). Como hablando, hablale de vos ("Ale te conto...", nunca "Leon mando..."), unas 6 a 10 frases, sin listas. "como": que miraste.'
                : '"dijo": UNA frase corta con la respuesta, sin contar como la buscaste. "como": que miraste.',
    ].join('\n'),
    // Step two (2026-10-10): the hands. Same single door, lib/desk.js decides
    // what may be touched; this text decides how carefully.
    do_on_pc: (task) => [
        `Hace esto en la PC de Leon (Windows), como lo haria una persona con mouse y teclado: ${task}`,
        `Tu UNICA forma de ver y tocar la PC es: node ${DESK_CLI} <accion>. Nada de powershell, cmd.exe, AutoHotkey ni otro camino: si el comando se niega, no hay otro.`,
        'Corre ese comando TAL CUAL: sin cd, sin && y sin & al final, sin | head, sin > archivo y sin 2>&1 (asi no te frena un permiso).',
        '  look [--screen N]  ->  un PNG por monitor ("shots", con su tamano) y las ventanas abiertas. Abri cada PNG con Read.',
        '  click|double|right|move --screen N --x X --y Y   |   scroll --screen N --x X --y Y --amount -5 (negativo = abajo)',
        '  type --text "..." (o --text-file F)   |   key --keys ctrl+s   (enter, tab, esc, win, alt+tab, ctrl+l, f5...)',
        '  X/Y son pixeles del PNG de ESE monitor a tamano completo. Si Read te muestra la imagen achicada ("displayed at ..., multiply by K"), multiplica por K antes de hacer clic.',
        '  Cada accion vuelve a mirar sola y te devuelve los PNG nuevos y "front" (la ventana que quedo adelante): miralos antes del paso siguiente.',
        'COMO TRABAJAR:',
        '  focus --window spotify   ->  trae al frente una ventana YA abierta (aunque este minimizada), en un solo paso.',
        '  open --path RUTA | --reveal RUTA | --app NOMBRE | --url https://...   ->  abre un archivo/carpeta con su programa, lo muestra en su carpeta, abre un programa o una pagina. Sin mouse.',
        // 2026-10-11 (TESLA-PC-PATHS.md): windows, modes and shortcuts, ~1 s each, no screenshot.
        '  windows (que hay abierto y donde, sin captura) | place --window X --where "a la derecha del monitor" | solo --window X',
        '  layout --restore NOMBRE | layout --save NOMBRE | zones --layout columns --screen 2',
        '  shortcut --name "pestana nueva" (--list = todos) | routine --name "slack ir a" --what CANAL | settings --page sonido | spotify --query "..."',
        `  El detalle de cada uno esta en ${SKILLS_DIR}/<skill>/SKILL.md (pc-fast-paths, pc-windows, pc-modes, pc-shortcuts, pc-open, pc-media, pc-mouse). Leelo SOLO si dudas como se usa.`,
        'REGLA DE ORO: el camino mas directo primero, el mouse al final. Acomodar ventanas es place/solo/layout, NUNCA arrastrar; un menu con atajo es shortcut; Abrir algo es open; ir a una pagina es open --url; buscar un archivo es buscarlo con comandos (find/ls a un archivo, python3), no con el explorador; mover o copiar un archivo es mv/cp. El mouse y la pantalla solo para lo que pasa ADENTRO de un programa y no tiene otro camino.',
        '- Mira primero. Si el programa YA esta abierto (figura en "titles"), NO lo busques en Inicio: focus --window <nombre> y listo (si no tiene ventana, focus lo abre solo). En el navegador, ctrl+l para ir a una direccion.',
        '- Despues de abrir o traer algo, mira TODOS los monitores (look sin --screen): puede aparecer en el otro.',
        `- Musica y volumen sin mouse: node ${DESK_CLI} media --keys playpause|nexttrack|prevtrack|volumeup|volumedown|volumemute [--times N].`,
        '- Lo simple es simple: abrir o traer un programa es UN paso; no mires de mas ni expliques de mas.',
        '- ANTES de escribir, confirma en "front" que adelante esta la ventana correcta (no TSRCT, no otra sesion, no un archivo suyo que no tiene que ver). Si no, hace clic en el lugar donde va el texto y volve a mirar.',
        '- Nunca escribas en un documento o archivo suyo que ya tenia contenido salvo que la tarea lo pida; para algo nuevo, abri uno nuevo.',
        '- PARA y preguntale antes de cualquier paso que no se puede deshacer: mandar un mensaje o mail, publicar, pagar o comprar, borrar, enviar un formulario, aceptar algo, guardar encima de un archivo, cerrar algo sin guardar. Para preguntar: terminas con RESULTADO ok:false y en "dijo" la pregunta exacta ("Esta listo el mail a Paul, lo mando?"). Su si te llega en el proximo mensaje.',
        '- Si el comando dice que Leon movio el mouse y paro: mira la pantalla de nuevo (look) y segui la tarea desde donde esta.',
        '- Si el comando dice que Leon tomo el mouse: PARA en ese mismo momento y termina, contando hasta donde llegaste. No reintentes.',
        // Not by name: teslaHands.start refuses any task text that names it, and
        // naming it here broke EVERY do_on_pc (2026-10-10, his first "abri spotify").
        '- Si aparece algo del proyecto restringido (el que solo corre en AWS Bedrock) o el comando se niega por eso: para y deci solo que no podes seguir ahi.',
        '- Si despues de 3 intentos algo no sale, para y conta que viste.',
        '"dijo": UNA frase corta (menos de 15 palabras): el resultado, o hasta donde llegaste. Nada de como lo hiciste. "como": los pasos.',
    ].join('\n'),
    // The SEPARATE browser (2026-10-12, the PROJECTOR): web work without his
    // mouse. Same worker, another door: scripts/projector.js, a headless browser
    // of its own that he watches live in TSRCT's projector window.
    browser_task: (task) => [
        `Hace esto en PAGINAS WEB, en tu navegador APARTE (no en la PC de Leon): ${task}`,
        `Tu UNICA herramienta es: node ${PROJECTOR_CLI} <comando>. Nunca la PC de Leon: ni su mouse, ni su teclado, ni sus ventanas, ni powershell. Leon te mira en vivo en la ventana Proyector de TSRCT, eligiendo la sesion "hands".`,
        'Corre cada comando TAL CUAL: sin cd, sin && ni &, sin | head, sin > archivo y sin 2>&1 (asi no te frena un permiso).',
        `PRIMERO: node ${PROJECTOR_CLI} start  ->  abre tu navegador (si ya esta abierto lo dice). Despues:`,
        '  open URL  |  back  |  reload  |  tabs  |  tab N',
        '  look  ->  imprime la ruta de un PNG: abrilo con Read para ver la pagina (1280x800). look --full = la pagina entera.',
        '  read  ->  url, titulo y el texto de la pagina.  find TEXTO  ->  botones, links y campos que coinciden, con su x,y.',
        '  click X Y  |  click text=Guardar  |  click css=#id  |  dblclick X Y  |  rightclick X Y',
        '  type "texto"  (donde esta el cursor: primero click en el campo)  |  key Enter  (Tab, Escape, Control+A ...)',
        '  drag X1 Y1 X2 Y2  (un arrastre real; sirve para editores de arrastrar y soltar)  |  scroll 600  (negativo = arriba)',
        '  upload text=Subir /ruta/archivo.zip  (o upload css=input[type=file] ARCHIVO, o upload ARCHIVO si hay un solo campo de archivo)  |  download URL  ->  baja un archivo publico e imprime su ruta',
        `  El detalle esta en ${SKILLS_DIR}/pc-browser/SKILL.md. Leelo SOLO si dudas.`,
        'COMO TRABAJAR:',
        '- Primero find o look, despues click: X/Y son pixeles de la pagina (1280x800), los que da find.',
        '- Despues de cada paso que cambia algo, look o read para confirmar que paso. 3 intentos sin exito: para y conta que viste.',
        '- CONTRASENAS Y LOGIN: nunca las escribas ni las busques. Si una pagina pide iniciar sesion, PARA: RESULTADO ok:false y en "dijo": "Entra con tu usuario en el proyector y avisame" (el hace clic en la imagen y escribe). Su aviso te llega en el proximo mensaje; ahi segui. El navegador recuerda el login para la proxima vez.',
        '- PARA y preguntale antes de cualquier paso que no se puede deshacer: mandar, publicar, pagar, comprar, borrar, aceptar terminos, enviar un formulario o una entrega. RESULTADO ok:false y en "dijo" la pregunta exacta. Su si te llega en el proximo mensaje. Si la tarea ya dice que lo mandes o lo entregues, eso es su si.',
        '- Si aparece algo del proyecto restringido (el que solo corre en AWS Bedrock) o el comando se niega por eso: para y deci solo que no podes seguir ahi.',
        `- Al terminar NO cierres el navegador (el puede querer mirarlo); se cierra solo cuando esta sesion se cierra.`,
        '"dijo": UNA frase corta (menos de 15 palabras): el resultado, o hasta donde llegaste. "como": los pasos.',
    ].join('\n'),
};
const DESK_CLI = require('path').join(__dirname, '..', 'scripts', 'desk.js');
const PROJECTOR_CLI = require('path').join(__dirname, '..', 'scripts', 'projector.js');
// The PC skills (2026-10-11, Leon: "convertir en skills cada cosa ... para que tesla
// sepa exactamente como usarlas y actuar velozmente"): one sheet per tool, read by
// the worker only when it needs the detail; the recipe carries the commands.
const SKILLS_DIR = require('path').join(__dirname, '..', 'tesla-skills');

// ── hearing a name ──────────────────────────────────────────────────────────
// He does not say "tsrct". He says "la carpeta de mi aplicacion personal", the
// recogniser hears half of it, and the name that matters is one word somewhere
// in the middle. An exact-match gate answered that with "no conozco un proyecto
// llamado 'directorio de mi aplicacion'", which is correct and useless.
//
// So a spoken phrase is MATCHED against the real list — never trusted as a
// name. No model: filler words out, then exact, contained, token and
// edit-distance scores. One clear winner is the answer; anything else becomes a
// question that names the real options. It can only ever return a name that
// exists, so it widens what he can say without widening what can happen.
const sessionFolders = require('./sessionFolders');
const MAX_AT_ONCE = Number(process.env.TALK_MAX_OPEN || 4);
// More than MAX_AT_ONCE is no longer refused (Tesla review, 2026-10-14: he showed
// her a screenshot of 15 sessions and asked to reopen them all, and was told "cuales
// 4?"). A batch that big opens in the BACKGROUND, one at a time, and stops on its
// own when the machine runs short of memory: measured ~316 MB per Claude, so 15 is
// ~4.7 GB of the 11. She says when it is done.
const MAX_BATCH = Number(process.env.TALK_MAX_OPEN_BATCH || 20);
const MIN_FREE_MB = Number(process.env.TALK_OPEN_MIN_FREE_MB || 1500);
function freeMb() {
    try {
        const m = /MemAvailable:\s+(\d+)/.exec(require('fs').readFileSync('/proc/meminfo', 'utf8'));
        return m ? Math.round(Number(m[1]) / 1024) : Infinity;
    } catch { return Infinity; }
}
let batchRunning = false;

const FILLER = new Set(('el la los las lo un una unos unas de del en mi mis me a al y o que se es por para con '
    + 'proyecto proyectos sesion sesiones carpeta carpetas directorio directorios aplicacion app repo repositorio '
    + 'abrir abri abrime abre abra abierta abierto nueva nuevo nuevas claude favor llama llamada llamado nombre '
    + 'quiero queres podes puedes puede necesito dale ahi esa ese esta este').split(' '));

function plain(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function distance(a, b) {
    if (a === b) return 0;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let last = prev[0]; prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const keep = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
            last = keep;
        }
    }
    return prev[b.length];
}

function scoreName(phraseTokens, name) {
    const nameTokens = plain(name).split(' ').filter(Boolean);
    const p = phraseTokens.join(''), n = nameTokens.join('');
    if (!p || !n) return 0;
    if (p === n) return 1;
    let best = 0;
    if (n.length >= 3 && (p.includes(n) || n.includes(p))) best = 0.9 * Math.min(p.length, n.length) / Math.max(p.length, n.length);
    // how much of the NAME he said, word by word, forgiving one wrong letter
    const hit = nameTokens.filter(nt => phraseTokens.some(pt => pt === nt || (nt.length >= 4 && distance(pt, nt) <= 1))).length;
    const said = phraseTokens.filter(pt => nameTokens.some(nt => pt === nt || (nt.length >= 4 && distance(pt, nt) <= 1))).length;
    // Either he said most of the name, or everything he said is IN the name
    // ("la de vrtx" is one word, and it is the word that tells them apart).
    if (hit) best = Math.max(best, 0.85 * Math.max(hit / nameTokens.length * (0.5 + 0.5 * said / phraseTokens.length), 0.7 * said / phraseTokens.length));
    const sim = 1 - distance(p, n) / Math.max(p.length, n.length);
    if (sim >= 0.7) best = Math.max(best, 0.8 * sim);
    // Names that are spelled one way and SAID another: "tesseract" is tsrct and
    // "hog" is harbor. With the vowels out they are nearly the same string.
    const bones = x => x.replace(/[aeiou]/g, '');
    const pb = bones(p), nb = bones(n);
    if (pb.length >= 2 && nb.length >= 2) {
        const bsim = 1 - distance(pb, nb) / Math.max(pb.length, nb.length);
        if (bsim >= 0.6) best = Math.max(best, 0.75 * bsim);
    }
    return best;
}

// The best match in a list, or nothing. Split out of hear() so one phrase can be
// weighed against TWO lists before anything is said out loud.
function rank(spoken, names) {
    const list = [...new Set((names || []).filter(Boolean))];
    const direct = list.find(n => plain(n) === plain(spoken));
    if (direct) return { best: direct, sure: true, ranked: [{ n: direct, s: 1 }] };
    const tokens = plain(spoken).split(' ').filter(t => t && !FILLER.has(t));
    const ranked = list.map(n => ({ n, s: scoreName(tokens, n) })).filter(x => x.s >= 0.45).sort((a, b) => b.s - a.s);
    const sure = !!ranked.length && (ranked.length === 1 || ranked[0].s - ranked[1].s >= 0.12);
    return { best: ranked.length ? ranked[0].n : '', sure, ranked };
}

// -> { name } | { ask: 'a question naming the real options' }
//
// `alt` is the OTHER list — projects when we are hearing a session, sessions
// when we are hearing a project. He does not think in two lists: he said "el
// proyecto trudy" about a session that was open on his screen, and was told
// "no tengo ningun proyecto con ese nombre" followed by eight names read out
// loud. Both halves of that were wrong. Knowing which list a word belongs to is
// the difference between an assistant that sounds literal-minded and one that
// sounds like it was paying attention.
function hear(spoken, names, what, alt) {
    const r = rank(spoken, names);
    if (r.sure) return { name: r.best };
    if (r.ranked.length) return { ask: `Hay varios parecidos: ${r.ranked.slice(0, 3).map(x => x.n).join(', ')}. Cual?` };
    if (alt && alt.names) {
        const a = rank(spoken, alt.names);
        const aOne = what.replace(/^ninguna\b/, 'una').replace(/^ningun\b/, 'un');
        if (a.sure) return { ask: `${a.best} es ${alt.say}, no ${aOne}. Decime que queres que haga con ${alt.her ? 'ella' : 'el'}.`, crossed: a.best };
    }
    // Spoken, so THREE names, not eight: a list read out loud stops being a list
    // after the third item.
    const list = [...new Set((names || []).filter(Boolean))];
    // Tesla's own worker closes when idle; "no tengo ninguna sesion con ese
    // nombre" about the session he was just talking to reads as amnesia (2026-09-25).
    if (plain(spoken) === 'hands') return { ask: 'hands ya se cerro porque estuvo un rato sin uso. Si queres, le pido lo mismo a una nueva.' };
    return { ask: `No tengo ${what} con ese nombre. Hay ${list.slice(0, 3).join(', ')}${list.length > 3 ? ` y ${list.length - 3} mas` : ''}. Cual?` };
}

const THOSE = /\b(las? que abriste|los? que abriste|las? (dos|tres|cuatro)|esas|esos|las mismas|los mismos|recien abiertas?|que acabas de abrir)\b/;
const ANY = /\b(cualquier[ao]?|el que (vos )?quieras|la que (vos )?quieras|elegi vos|elegilo vos|eleg[ei] (uno|una|cualquier)|da igual|me da lo mismo|no importa cual|random|alguno|alguna)\b/;

function askAgain(message) { const e = new Error(message); e.askAgain = true; return e; }

// "cuatro sesiones en personal" -> { count: 4, name: 'en personal' }. "una" and
// "otra" are a count of ONE said out loud, which matters: "dos en tsrct y una en
// harbor" is three sessions, not a total of two.
const NUMBER = { un: 1, una: 1, otra: 1, otro: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
function countOf(piece) {
    const words = plain(piece).split(' ').filter(Boolean);
    const i = words.findIndex(t => NUMBER[t] || /^[1-9]$/.test(t));
    if (i < 0) return { count: null, name: piece };
    const count = NUMBER[words[i]] || Number(words[i]);
    words.splice(i, 1);
    return { count, name: words.join(' ') };
}

// The recognizer drops his commas, so "tsrct, harbor y probill" can arrive as
// "tsrct harbor". Split into runs of words that EACH name one project for sure, or
// give up — never a guess.
function splitNames(phrase) {
    const tokens = plain(phrase).split(' ').filter(t => t && !FILLER.has(t)).slice(0, 8);
    const names = projectNames();
    const walk = (from) => {
        if (from === tokens.length) return [];
        for (let to = tokens.length; to > from; to--) {
            const r = rank(tokens.slice(from, to).join(' '), names);
            if (!r.sure) continue;
            const rest = walk(to);
            if (rest) return [r.best, ...rest];
        }
        return null;
    };
    const found = tokens.length > 1 ? walk(0) : null;
    // "verde soap" is one project heard twice, not two.
    if (!found || found.length < 2 || new Set(found).size < found.length) return null;
    return found.map(n => TYPES.project(n));
}

// One of a short closed list, heard the way he says it.
function oneOf(kind, spoken, what) {
    const v = ui.match(kind, spoken);
    if (v) return v;
    const all = ui.options(kind);
    throw askAgain(`No se a que ${what} te referis. Tengo ${all.slice(0, 4).join(', ')}${all.length > 4 ? ' y alguna mas' : ''}. Cual?`);
}

// Is that pane mid-turn? Only for the confirmation sentence — never a reason to
// refuse, just a reason to say it out loud before he says yes.
function isWorking(session) {
    try {
        const raw = deps.tmux.captureSession(session, 40);
        return !!paneShape.looksLikeWorking(paneShape.tailOf(raw, 20));
    } catch { return false; }
}

const CHOICES_MAX = 200;
function projectNames() {
    try {
        return (deps.projectRegistry.list() || []).filter(p => p.known !== false).map(p => p.project)
            .filter(n => n && !restrictedGuard.mentionsRestricted(n));
    } catch { return []; }
}
// What the morning plan proposed, and which of those are not open yet. Both
// halves matter: the confirmation names the ones it would open, and "ya estan
// abiertas" is a better answer than opening three duplicates.
function plannedNow() {
    let all = [];
    try {
        const st = deps.morningRoutine.loadState() || {};
        all = (st.plannedSessions || []).filter(p => p && p.session && !restrictedGuard.mentionsRestricted(p.session));
    } catch { all = []; }
    const live = sessionNames();
    return { all, left: all.filter(p => !live.includes(p.session)) };
}

// Claude Code's own permission dialog, on the last lines of a session's screen:
// "Do you want to proceed?" (or "make this edit", "create") with "1. Yes" under
// the cursor. Returns { what } - the line above the question - or null.
function permissionDialog(session) {
    let raw = '';
    try { raw = String(deps.tmux.captureSession(session, 40) || ''); } catch { return null; }
    const lines = raw.split('\n').map(l => l.trimEnd()).filter(l => l.trim()).slice(-14);
    const q = lines.findIndex(l => /Do you want to (proceed|make this edit|create|overwrite|allow)\b[^?]*\?/i.test(l));
    if (q < 0 || !lines.slice(q + 1).some(l => /^\s*[❯>]\s*1\.\s*Yes\b/.test(l))) return null;
    // The command, not the border: the two lines above the question are often the
    // dialog's ╌╌╌ rules (Tesla review #11: "¿Aprobar ... (╌╌╌╌╌╌╌╌)?" five times),
    // or Claude Code's own tip (review #13: "Tip: auto mode handles these prompts").
    const body = lines.slice(Math.max(0, q - 6), q).map(l => l.trim()).filter(l => /[a-z0-9]/i.test(l) && !/^[\s─━╌═│┃╭╮╰╯-]+$/.test(l) && !/^(Bash command|Permission rule|Press|Esc|Tip:)/i.test(l));
    const what = body.slice(0, 2).join(' ').replace(/\s+/g, ' ').slice(0, 90);
    return { what: restrictedGuard.mentionsRestricted(what) ? '' : what };
}

// Not his work, so never in a list Tesla reads out or acts on (Tesla review #7):
// her own hidden brains, Ro's ATELIER sessions, and runners (a server, a script).
const NOT_HIS = /^(tesla-|ro-|run-)/;
function sessionNames() {
    try {
        return (deps.tmux.listSessions() || []).map(x => x.name || x).filter(n => n && !NOT_HIS.test(n) && !restrictedGuard.mentionsRestricted(n));
    } catch { return []; }
}

// Several sessions at once, and the phrase he actually uses for the ones it
// just opened. `cap` is per action kind: see manySessions.
// open_session's spawn loop. One after another, never in parallel: each spawn
// waits for the REAL input box, and nextSessionName has to see the one before
// it. Before each one, a look at free memory: a batch stops itself rather than
// push the laptop into swap.
async function openNow({ project, name: names, prompt: first, panel, places }) {
    const perOne = !!(names && names.length > 1 && names.length === project.length);
    const made = [];
    let stoppedAt = 0;
    for (let idx = 0; idx < project.length; idx++) {
        const p = project[idx];
        if (project.length > 1) {
            const free = freeMb();
            if (free < MIN_FREE_MB) { stoppedAt = free; break; }
        }
        // `places` (reopen_sessions): the folder and conversation are already known.
        const where = places ? places[idx] : deps.projectRegistry.resolve(p);
        // The same spawn the morning routine uses: create, wait, paste.
        // No second copy of that sequence.
        // nextSessionName TAKES the existence test — it has no tmux of
        // its own. Calling it with one argument crashed inside the action
        // ("exists is not a function") after he had already said yes.
        const label = perOne ? names[idx] : (names && names[0]);
        const base = String(label || where.project || p).slice(0, 64);
        const exists = (n) => deps.tmux.sessionExists(n);
        const name = exists(base) ? deps.sessionSpawn.nextSessionName(base, exists) : base;
        let out = null;
        try {
            out = await deps.sessionSpawn.createPrimedSession({
                name,
                cwd: where.cwd,
                // A reopened session resumes ITS conversation and is told nothing:
                // a pasted line would start fifteen paid turns at once.
                ...(places ? { command: where.sessionId && sessionFolders.UUID.test(where.sessionId) ? `claude --resume ${where.sessionId}` : 'claude' } : {}),
                // With a first message (2026-09-25) the session starts WORKING on it;
                // without one it waits, as before.
                prompt: places ? '' : first
                    ? `Estas abierto desde TSRCT por pedido de Leon. Proyecto: ${where.project || p}. Lo que te pide:\n${first}`
                    : `Estas abierto desde TSRCT por pedido de Leon. Proyecto: ${where.project || p}. Esperá a que te diga qué hacer.`,
            });
        } catch (e) { out = { ok: false, error: e.message }; }
        made.push({ project: where.project || p, session: name, ok: !!(out && out.ok), why: out && out.error });
        if (out && out.ok) {
            opened = opened.filter(n => n !== name);
            opened.push(name);
            if (opened.length > 12) opened = opened.slice(-12);
        }
    }
    let shown = null;
    if (panel && made.length === 1 && made[0].ok) {
        try { shown = byName.get('put_in_panel').run({ session: made[0].session, place: panel }); }
        catch (e) { shown = { failed: e.message }; }
    }
    return { opened: made, ok: made.every(o => o.ok), ...(stoppedAt ? { stoppedAt } : {}), ...(shown ? { inPanel: panel, shown } : {}) };
}

// More than MAX_AT_ONCE: answered at once, opened behind his back one by one,
// and the outcome spoken when it ends. Never two batches at a time.
function inBackground(args) {
    const total = args.project.length;
    if (batchRunning) return { ok: false, say: 'Todavia estoy abriendo la tanda anterior. Cuando termine te aviso y me pedis esta.' };
    batchRunning = true;
    openNow(args).then((r) => {
        const ok = r.opened.filter(o => o.ok).map(o => o.session);
        const bad = r.opened.filter(o => !o.ok).map(o => o.session);
        const line = `Listo, abri ${ok.length} de ${total}.`
            + (bad.length ? ` No pude con ${bad.join(', ')}.` : '')
            + (r.stoppedAt ? ` Pare porque a la maquina le quedaban ${r.stoppedAt} MB libres; faltan ${total - r.opened.length}.` : '');
        if (deps.say) deps.say(line);
    }).catch((e) => { if (deps.say) deps.say(`Se corto la tanda de sesiones: ${e.message}`); })
        .finally(() => { batchRunning = false; });
    return { ok: true, queued: total, say: `Dale, abro las ${total} de a una. Te aviso cuando esten.` };
}

function sessionsUpTo(cap, v) {
    const raw = Array.isArray(v) ? v.join(', ') : String(v || '');
    // "mandales a todas que compacten". ALL of them, capped like everything
    // else here — and the confirmation names every one, so "todas" is never
    // a word he has to trust.
    if (/\btodas?\b|\btodos\b/.test(plain(raw))) {
        const live = sessionNames();
        if (!live.length) throw askAgain('No hay ninguna sesion abierta.');
        if (live.length > cap) throw askAgain(`Hay ${live.length} abiertas y no le mando a mas de ${cap} de una. Cuales?`);
        return live;
    }
    if (THOSE.test(plain(raw))) {
        const live = sessionNames();
        // Deduped: replaying a setup opens the same names again, and "las
        // dos que abriste" then confirmed four sessions, two of them twice.
        const mine = [...new Set(opened)].filter(n => live.includes(n));
        if (!mine.length) throw askAgain('No tengo ninguna sesion abierta por mi en esta charla. Cual cierro?');
        return mine;
    }
    const pieces = (Array.isArray(v) ? v : raw.split(/\s*(?:,|;|\sy\s|\se\s)\s*/i))
        .map(x => String(x || '').trim()).filter(Boolean)
        .filter(x => plain(x).split(' ').some(t => t && !FILLER.has(t)));
    if (!pieces.length) throw new Error('falta la sesion');
    if (pieces.length > cap) throw askAgain(`Hasta ${cap} a la vez. Cuales?`);
    return pieces.map(p => {
        try { return TYPES.session(p); } catch (e) {
            if (e.askAgain && pieces.length > 1) throw askAgain(`De esas no reconozco "${p}". Decime de nuevo cuales cierro.`);
            throw e;
        }
    });
}

// ── argument types ──────────────────────────────────────────────────────────
// Deliberately few. Every one of them can say NO, and saying no is the whole
// job: this is where an invented value stops being dangerous and becomes a
// sentence the assistant has to say out loud instead.
const TYPES = {
    session: (v) => {
        const s = String(v || '').trim();
        if (!s) throw new Error('falta el nombre de la sesion');
        restrictedGuard.assertNotRestricted('actions (session)', s);
        const live = deps.tmux ? sessionNames() : [];
        if (!live.length) {
            if (!/^[A-Za-z0-9._@-]{1,64}$/.test(s)) throw new Error(`"${s}" no parece un nombre de sesion`);
            return s;
        }
        const h = hear(s, live, 'ninguna sesion', { names: projectNames(), say: 'un proyecto', her: false });
        if (!h.name) throw askAgain(h.ask);
        return h.name;
    },
    project: (v) => {
        const p = String(v || '').trim();
        if (!p) throw new Error('falta el proyecto');
        restrictedGuard.assertNotRestricted('actions (project)', p);
        if (deps.projectRegistry) {
            // "cualquiera", "elegi vos", "el que quieras": he is testing, or he
            // does not care. It picks one that has no session open yet, and the
            // confirmation names it, so "any" never opens something unseen.
            if (ANY.test(plain(p))) {
                const names = projectNames();
                const live = sessionNames().map(plain);
                const free = names.filter(n => !live.some(l => l.includes(plain(n))));
                const pick = (free.length ? free : names)[0];
                if (pick) {
                    const hit = deps.projectRegistry.resolve(pick);
                    if (hit && hit.cwd) return hit.project || pick;
                }
            }
            const h = hear(p, projectNames(), 'ningun proyecto', { names: sessionNames(), say: 'una sesion abierta', her: true });
            if (!h.name) throw askAgain(h.ask);
            const hit = deps.projectRegistry.resolve(h.name);
            if (!hit || !hit.cwd) throw new Error(`conozco ${h.name} pero no encuentro su carpeta`);
            return hit.project || h.name;
        }
        return p;
    },
    // Several at once: "abrime tsrct, harbor y probill". Each piece is heard
    // on its own against the real list, and ONE unknown piece stops the lot —
    // opening three of four and guessing the fourth is not what he asked for.
    // Capped like the morning routine: every session is a Claude on 11 GB.
    // A name may repeat: "cuatro sesiones en personal" is personal four times,
    // and open_session names each one personal, personal-2, ... in turn.
    projects: (v) => {
        if (!Array.isArray(v) && ANY.test(plain(v))) return [TYPES.project(v)];
        const pieces = (Array.isArray(v) ? v : String(v || '').split(/\s*(?:,|;|\sy\s|\se\s|\smas\s|\smás\s|\sotra\s|\sotro\s)\s*/i))
            .map(x => countOf(String(x || '').trim()))
            // "... y abrir una sesion" is the rest of his sentence, not a project
            .filter(x => x.count || plain(x.name).split(' ').some(t => t && !FILLER.has(t)));
        // "abrime dos sesiones, personal y probill": a number on the FIRST
        // piece only, followed by more names, is the total — not two of personal.
        let total = null;
        if (pieces.length > 1 && pieces[0].count >= 2 && pieces.slice(1).every(x => !x.count)) {
            total = pieces[0].count;
            pieces[0].count = 1;
        }
        const named = pieces.filter(x => plain(x.name).split(' ').some(t => t && !FILLER.has(t)));
        if (!named.length) throw new Error('falta el proyecto');
        if (total && total !== named.length) throw askAgain(`Me dijiste ${total} pero nombraste ${named.length}. Cuales abro?`);
        const out = [];
        let skippedRestricted = 0;
        for (const x of named) {
            // One SecretCo name in a list of fifteen skips THAT one, said out loud in
            // the confirmation; it used to throw and take the other fourteen with it.
            if (named.length > 1 && restrictedGuard.mentionsRestricted(x.name)) { skippedRestricted++; continue; }
            let names;
            try { names = [TYPES.project(x.name)]; } catch (e) {
                // The recognizer drops his commas: "tsrct harbor" is two names.
                names = splitNames(x.name);
                if (!names) {
                    if (e.askAgain && named.length > 1) throw askAgain(`De esos no reconozco "${x.name}". Decime de nuevo cuales abro.`);
                    throw e;
                }
            }
            for (const n of names) for (let i = 0; i < (x.count || 1); i++) out.push(n);
        }
        if (!out.length) throw askAgain('Esa la tenes que abrir vos: es de un trabajo que no toco desde aca. Otra?');
        if (out.length > MAX_BATCH) throw askAgain(`Son ${out.length}; abro hasta ${MAX_BATCH} de una tanda, para no ahogar la maquina. Cuales ${MAX_BATCH}?`);
        if (skippedRestricted) out.skippedRestricted = skippedRestricted;
        return out;
    },
    // One name per project, in order, for "abrilas de nuevo como estaban": a
    // single name keeps the old meaning (the same name for all, numbered).
    labels: (v) => {
        const list = Array.isArray(v) ? v : String(v || '').split(/\s*[,;]\s*/);
        const out = list.map(x => String(x || '').trim()).filter(Boolean).map(TYPES.label);
        if (!out.length) throw askAgain('Que nombre le pongo?');
        return out;
    },
    // Several sessions at once, and the phrase he actually uses for the ones it
    // just opened.
    sessions: (v) => sessionsUpTo(MAX_AT_ONCE, v),
    // The same, for things that cost nothing to do to many sessions at once:
    // deciding permission cards, pressing Escape, reading. The cap of 4 is
    // about opening Claudes on 11 GB, and "aproba todo" across six sessions
    // must not become "cuales 4?" (2026-09-24, BULK).
    // 30 since 2026-10-14: a send to all of his sessions reached 4 of 16.
    manySessions: (v) => sessionsUpTo(30, v),
    // Sessions that are CLOSED now but TSRCT remembers (lib/sessionFolders.js):
    // "todas" is the ones that closed together most recently (a crash, a
    // reboot), anything else is heard against the remembered names. -> rows
    // { name, cwd, sessionId }. SecretCo never reaches the file, so never here.
    closedSessions: (v) => {
        // Asked again while the batch is still opening (2026-10-14: "la 13 de a 1",
        // his echo of her own line, was re-sent as a reopen and she said she could
        // not find them while all 13 were coming up).
        if (batchRunning) throw new Error('ya las estoy abriendo de a una; te aviso cuando esten todas');
        // His "si" re-runs the action with the rows its question was built from,
        // not with his words: they come back here as {name, cwd, sessionId} and
        // are heard by name (2026-10-15: two "si" each answered "no tengo ninguna
        // sesion cerrada con ese nombre", because the rows were read as text).
        if (Array.isArray(v)) v = v.map(x => (x && typeof x === 'object') ? x.name : x);
        const raw = Array.isArray(v) ? v.join(', ') : String(v || '');
        const live = (deps.tmux && deps.tmux.listSessions ? deps.tmux.listSessions() : []).map(x => x.name || x);
        const gone = sessionFolders.closed(live);
        if (!gone.length) throw askAgain('No tengo registrada ninguna sesion cerrada para reabrir.');
        let rows;
        if (!raw.trim() || /\btodas?\b|\btodos\b|\blas que (se )?(cerraron|cayeron|habia|tenia)\b/.test(plain(raw))) {
            rows = sessionFolders.closed(live, { together: true });
        } else {
            const names = gone.map(r => r.name);
            const pieces = (Array.isArray(v) ? v : raw.split(/\s*(?:,|;|\sy\s|\se\s)\s*/i)).map(x => String(x || '').trim()).filter(Boolean)
                .filter(x => !restrictedGuard.mentionsRestricted(x));
            if (!pieces.length) throw askAgain(`Cuales reabro? Se cerraron ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` y ${names.length - 3} mas` : ''}.`);
            rows = pieces.map((p) => {
                const h = hear(p, names, 'ninguna sesion cerrada');
                if (!h.name) throw askAgain(h.ask);
                return gone.find(r => r.name === h.name);
            });
            rows = rows.filter((r, i) => rows.findIndex(x => x.name === r.name) === i);
        }
        if (rows.length > MAX_BATCH) throw askAgain(`Son ${rows.length}; reabro hasta ${MAX_BATCH} de una tanda. Cuales?`);
        return rows;
    },
    // How hard a prompt is to write, which picks the model that writes it.
    level: (v) => {
        const s = plain(v);
        if (/^(simple|facil|haiku|chico|basico)/.test(s)) return 'simple';
        if (/^(complex|complej|dificil|opus|profund|grande)/.test(s)) return 'complex';
        if (/^(medium|medio|mediano|normal|sonnet)/.test(s)) return 'medium';
        return 'medium';
    },
    // approve / deny, the way he says it.
    verdict: (v) => {
        const s = plain(v);
        if (/^(approve|allow|y|yes|si|aprob|acept|permit|dale|ok)/.test(s)) return 'approve';
        if (/^(deny|n|no|rechaz|deneg|neg|cancel)/.test(s)) return 'deny';
        throw askAgain('Los apruebo o los rechazo?');
    },
    // A PROJECT OR A SESSION, whichever he meant. He does not keep two lists in
    // his head — he says "el proyecto trudy" about a session that is open on his
    // screen — and for a question like "how is X going" the distinction is mine
    // to resolve, not his to get right. The project view wins a tie because it
    // is the bigger one: it contains that project's sessions.
    place: (v) => {
        const s = String(v || '').trim();
        if (!s) throw new Error('falta el nombre');
        restrictedGuard.assertNotRestricted('actions (place)', s);
        const projects = projectNames();
        const live = sessionNames();
        const p = rank(s, projects);
        if (p.sure) return { kind: 'project', name: p.best };
        const q = rank(s, live);
        if (q.sure) return { kind: 'session', name: q.best };
        const near = [...p.ranked, ...q.ranked].sort((a, b) => b.s - a.s).slice(0, 3).map(x => x.n);
        if (near.length) throw askAgain(`Hay varios parecidos: ${near.join(', ')}. Cual?`);
        // Name what he said, not the first three projects in alphabetical order:
        // "ledgerly-bankrec, ledgerly-quirks, inventory-app" answered every
        // unrelated question and told him nothing.
        throw askAgain(`No encontre ningun proyecto ni sesion que se llame "${s.slice(0, 40)}". De cual me hablas?`);
    },
    // ── the small closed lists (a tab, a room, yes/no/skip, a slash command) ──
    // He says "pasame a tareas", never "tasks". One word list per kind, matched
    // here, so the spoken word never has to be the technical one — and an
    // unknown one becomes a question that names the real options.
    // One of his saved setups, heard the way he named it out loud.
    setup: (v) => {
        const s = String(v || '').trim();
        if (!s) throw new Error('falta el nombre del setup');
        const all = deps.setups ? deps.setups.names() : [];
        if (!all.length) throw askAgain('Todavia no tenes ningun setup guardado. Arma uno y decime "guarda esto como" el nombre que quieras.');
        const h = hear(s, all, 'ningun setup');
        if (!h.name) throw askAgain(h.ask);
        return h.name;
    },
    // One automation, by what he calls it ("syften", "lo de amazon") or by the
    // name on its card. Hooks and system services are not in the list at all.
    automation: (v) => {
        const s = String(v || '').trim();
        if (!s) throw askAgain('Cual automatizacion?');
        const all = automations.switchable();
        const byWord = automations.spokenId(s);
        if (byWord && all.some(a => a.id === byWord)) return byWord;
        const exact = all.find(a => a.id === s);
        if (exact) return exact.id;
        const h = hear(s, all.map(a => a.title), 'ninguna automatizacion');
        if (!h.name) throw askAgain(h.ask);
        return all.find(a => a.title === h.name).id;
    },
    onoff: (v) => {
        if (typeof v === 'boolean') return v;
        const s = String(v || '').toLowerCase();
        if (/^(true|on|1|si|prend|encend|activ|reanud)/.test(s)) return true;
        if (/^(false|off|0|no|apag|desactiv|paus)/.test(s)) return false;
        throw new Error('no entendi si prenderla o apagarla');
    },
    tab: (v) => oneOf('tab', v, 'pantalla'),
    room: (v) => oneOf('room', v, 'pantalla grande'),
    answer: (v) => oneOf('answer', v, 'respuesta'),
    slash: (v) => oneOf('slash', v, 'comando'),
    size: (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1 && n <= 4) return Math.round(n);
        return Number(oneOf('size', v, 'tamanio'));
    },
    text: (v) => {
        const t = String(v || '').trim();
        if (!t) throw new Error('no hay texto que mandar');
        if (t.length > 6000) throw new Error('ese texto es demasiado largo');   // a drafted prompt is ~1-3k
        restrictedGuard.assertNotRestricted('actions (text)', t);
        return t;
    },
    // The name he gives a NEW session ("abrila con el nombre creators"). tmux-safe,
    // never the hidden brains' prefix, never SecretCo.
    label: (v) => {
        const t = plain(v).replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40);
        if (!t) throw askAgain('Que nombre le pongo?');
        if (t.startsWith('tesla-')) throw new Error('ese nombre esta reservado para mi');
        restrictedGuard.assertNotRestricted('actions (session name)', t);
        return t;
    },
    // Files he attached in the orb: only paths TSRCT stored itself (the upload
    // folders), that exist - promptWriter.cleanFiles is the one filter.
    files: (v) => {
        const list = Array.isArray(v) ? v : String(v || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
        return deps.promptWriter && deps.promptWriter.cleanFiles ? deps.promptWriter.cleanFiles(list) : [];
    },
    // A plan the research left waiting for his yes. Only a key that names one:
    // the path, the session and the prompt come from the plan, never from here.
    job: (v) => {
        const k = String(v || '').trim();
        if (!deps.promptWriter || !deps.promptWriter.waiting || !deps.promptWriter.waiting(k)) {
            const w = deps.promptWriter && deps.promptWriter.list ? deps.promptWriter.list().filter(j => j.state === 'waiting') : [];
            if (w.length === 1) return w[0].key;          // "abrila" with exactly one plan waiting
            throw askAgain(w.length ? 'Hay varios planes esperando. Cual?' : 'No hay ningun plan esperando.');
        }
        return k;
    },
    lines: (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(5, Math.min(200, Math.round(n))) : 40;
    },
};

// ── the catalogue ───────────────────────────────────────────────────────────
// `says` is what the model is shown: plain language, because that is what it
// matches a spoken sentence against. `verify` is what check-actions.js asserts
// still exists — the link back to real code that keeps this list honest.
const CATALOG = [
    {
        name: 'automations_status',
        says: 'contar como andan las automatizaciones: cuantas estan prendidas y cuales estan fallando',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/automations.js:list' },
        run: async () => {
            const r = await automations.list();
            const items = r.groups.flatMap(g => g.items).filter(i => !i.locked);
            const on = items.filter(i => i.on === true).length;
            const off = items.filter(i => i.on === false).length;
            const bad = items.filter(i => i.state === 'fail');
            return {
                on, off, failing: bad.map(i => ({ name: i.title, why: i.result || '' })),
                plain: `Tenes ${on} prendidas y ${off} apagadas.` + (bad.length
                    ? ` Fallando: ${bad.slice(0, 3).map(i => i.title).join(', ')}${bad.length > 3 ? ` y ${bad.length - 3} mas` : ''}.`
                    : ' Ninguna esta fallando.'),
            };
        },
    },
    {
        name: 'set_automation',
        says: 'prender o apagar una automatizacion (lo que corre solo: syften, clickup, amazon, la rutina de la maniana...)',
        args: { automation: 'automation', on: 'onoff' },
        asks: { on: 'La prendo o la apago?' },
        verify: { fn: 'lib/automations.js:setEnabled' },
        confirmSays: ({ automation, on }) => {
            const a = automations.switchable().find(x => x.id === automation);
            return `${on ? 'prender' : 'apagar'} ${a ? a.title : automation}`;
        },
        run: async ({ automation, on }) => {
            const a = automations.switchable().find(x => x.id === automation);
            const r = await automations.setEnabled(automation, on);
            if (!r.ok) { const e = new Error(`No pude: ${r.error}`); e.soft = true; throw e; }
            return { plain: `Listo, ${a ? a.title : automation} ${on ? 'prendida' : 'apagada'}.` };
        },
    },
    // ── BULK (2026-09-24): "usar mi sistema de manera seamless y en BULK" ────
    // Every session at a glance, every permission card at once, the same key
    // to many. Each one reaches the function its button already uses.
    {
        // "quien me necesita?" / "como estan todas?": one sweep, no model. A
        // session is WORKING, ASKING (a permission card waits), or WAITING for
        // him; and how full its context is, from the weight hook.
        name: 'sessions_overview',
        says: 'repasar TODAS las sesiones de una: cuales trabajan, cuales lo esperan a el, cuales piden permiso y cuales estan pesadas',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/permissionDesk.js:pending' },
        run: () => {
            const names = sessionNames();
            const cards = deps.permissionDesk ? deps.permissionDesk.pending() : [];
            let weights = [];
            try { weights = deps.sessionWeight ? deps.sessionWeight.all(names).sessions || [] : []; } catch { weights = []; }
            const rows = names.map(name => {
                const asking = cards.filter(c => c.session === name).length;
                const w = weights.find(x => x.session === name);
                return {
                    session: name,
                    state: asking ? 'pide permiso' : isWorking(name) ? 'trabajando' : 'esperandote',
                    permissions: asking,
                    context: w ? { ctx: w.ctx, level: w.level } : null,
                };
            });
            const by = (st) => rows.filter(r => r.state === st).map(r => r.session);
            const heavy = rows.filter(r => r.context && r.context.level && r.context.level !== 'ok').map(r => r.session);
            const parts = [];
            if (by('pide permiso').length) parts.push(`piden permiso: ${by('pide permiso').join(', ')}`);
            if (by('esperandote').length) parts.push(`te esperan: ${by('esperandote').join(', ')}`);
            if (by('trabajando').length) parts.push(`trabajando: ${by('trabajando').join(', ')}`);
            if (heavy.length) parts.push(`pesadas: ${heavy.join(', ')}`);
            return {
                sessions: rows,
                plain: rows.length ? `${rows.length} abiertas. ${parts.join('. ')}.` : 'No tenes ninguna sesion abierta.',
            };
        },
    },
    {
        name: 'pending_permissions',
        says: 'decir que permisos estan esperando su aprobacion, en todas las sesiones o en algunas',
        args: { session: 'manySessions?' },
        readOnly: true,
        verify: { fn: 'lib/permissionDesk.js:pending' },
        run: ({ session }) => {
            const cards = deps.permissionDesk.pending(session);
            return {
                permissions: cards.map(c => ({ session: c.session, what: deps.permissionDesk.describe(c) })),
                plain: cards.length
                    ? `${cards.length} esperando: ${cards.slice(0, 4).map(c => `${c.session}, ${deps.permissionDesk.describe(c)}`).join('; ')}${cards.length > 4 ? ` y ${cards.length - 4} mas` : ''}.`
                    : 'No hay ningun permiso esperando.',
            };
        },
    },
    {
        // The cards the phone shows, decided in one yes. Only cards that are
        // pending when the question is asked: one that arrives after his yes is
        // not one he agreed to, so it stays for him.
        name: 'answer_permissions',
        says: 'aprobar o rechazar de una todos los permisos que estan esperando, en todas las sesiones o en las que diga',
        args: { decision: 'verdict', session: 'manySessions?' },
        asks: { decision: 'Los apruebo o los rechazo?' },
        verify: { fn: 'lib/permissionDesk.js:decide' },
        confirmSays: ({ decision, session }) => {
            const cards = deps.permissionDesk ? deps.permissionDesk.pending(session) : [];
            offeredCards = cards.map(c => c.id);
            if (!cards.length) return `${decision === 'approve' ? 'aprobar' : 'rechazar'} permisos, pero ahora no hay ninguno esperando`;
            const list = cards.slice(0, 4).map(c => `${c.session}: ${deps.permissionDesk.describe(c)}`).join('; ');
            return `${decision === 'approve' ? 'aprobar' : 'rechazar'} ${cards.length} permiso${cards.length === 1 ? '' : 's'} (${list}${cards.length > 4 ? ` y ${cards.length - 4} mas` : ''})`;
        },
        run: ({ decision }) => {
            const done = deps.permissionDesk.decide(offeredCards, decision);
            offeredCards = [];
            const verb = decision === 'approve' ? 'Aprobe' : 'Rechace';
            return {
                decided: done.map(c => ({ session: c.session, what: deps.permissionDesk.describe(c) })),
                plain: done.length ? `${verb} ${done.length}.` : 'Ya no habia ninguno de esos esperando.',
            };
        },
    },
    {
        // ONE session's permission, from the server (Tesla review #8, 2026-10-09):
        // approve_permission is a SCREEN button, so from the runner app - no TSRCT
        // page - "aprobalo" could not be done, and he said "si" some twenty times
        // while running to get six permissions through a typed "si". Its TSRCT card
        // if it has one (the hook reads it); otherwise the dialog on its screen,
        // answered with Enter - the first option, the screen button's own key -
        // and ONLY when the dialog is actually there.
        name: 'approve_session_permission',
        says: 'aprobar el permiso que UNA sesion esta pidiendo ahora (su tarjeta o el dialogo en su pantalla); funciona aunque no haya pantalla de TSRCT, por ejemplo desde la app de correr',
        args: { session: 'session' },
        verify: { fn: 'lib/paneKeys.js:press' },
        confirmSays: ({ session }) => {
            const cards = deps.permissionDesk ? deps.permissionDesk.pending([session]) : [];
            if (cards.length) return `aprobar el permiso de ${session} (${deps.permissionDesk.describe(cards[0])})`;
            const d = permissionDialog(session);
            return d ? `aprobar el permiso que ${session} pide en pantalla${d.what ? ` (${d.what})` : ''}` : `aprobar el permiso de ${session}, aunque ahora no veo ninguno esperando`;
        },
        run: ({ session }) => {
            const cards = deps.permissionDesk ? deps.permissionDesk.pending([session]) : [];
            if (cards.length) {
                const done = deps.permissionDesk.decide(cards.map(c => c.id), 'approve');
                return { decided: done.map(c => ({ session: c.session, what: deps.permissionDesk.describe(c) })), plain: done.length ? `Aprobado, ${session} sigue.` : 'Ya no estaba esperando.' };
            }
            if (!permissionDialog(session)) return { plain: `No veo ningun permiso esperando en ${session}.` };
            deps.paneKeys.press(session, ['Enter']);
            return { pressed: 'Enter', plain: `Aprobado, ${session} sigue.` };
        },
    },
    {
        // Escape to several at once: "frena todas". The single-session button
        // lives in the page; this is the server-side one for a list.
        name: 'stop_sessions',
        says: 'frenar lo que estan haciendo varias sesiones a la vez (escape), o todas',
        args: { session: 'manySessions' },
        verify: { fn: 'lib/paneKeys.js:press' },
        confirmSays: ({ session }) => `frenar ${session.join(', ')}`,
        run: ({ session }) => {
            const out = session.map(s => { try { deps.paneKeys.press(s, ['Escape']); return s; } catch { return null; } }).filter(Boolean);
            return { stopped: out, plain: `Frene ${out.length}: ${out.join(', ')}.` };
        },
    },
    {
        // /compact or /clear to several at once — "compacta todas".
        name: 'slash_to_sessions',
        says: 'mandarle un comando de Claude (compactar, limpiar el contexto) a varias sesiones a la vez, o a todas',
        args: { session: 'manySessions', cmd: 'slash' },
        verify: { fn: 'lib/paneKeys.js:press' },
        confirmSays: ({ session, cmd }) => {
            const busy = session.filter(s => isWorking(s));
            return `mandarle ${cmd} a ${session.join(', ')}${busy.length ? ` (ojo: ${busy.join(', ')} esta${busy.length === 1 ? '' : 'n'} trabajando)` : ''}`;
        },
        run: async ({ session, cmd }) => {
            const out = [];
            for (const s of session) {
                try {
                    deps.paneKeys.press(s, [cmd], { literal: true });
                    await new Promise(r => setTimeout(r, 250));
                    deps.paneKeys.press(s, ['Enter']);
                    out.push(s);
                } catch { /* a pane that went away is skipped, and the count says so */ }
            }
            return { sent: out, plain: `Le mande ${cmd} a ${out.length}: ${out.join(', ')}.` };
        },
    },
    {
        // The handoff the weight badge offers: compact, open a fresh session in
        // the same folder primed with the summary, retire the old one only then.
        name: 'refresh_sessions',
        says: 'renovar sesiones pesadas: resumirlas y seguir en una sesion nueva en la misma carpeta',
        args: { session: 'sessions' },
        verify: { fn: 'lib/sessionWeight.js:startHandoff' },
        confirmSays: ({ session }) => `renovar ${session.join(', ')}: las resumo, abro una nueva en la misma carpeta y cierro la vieja`,
        run: ({ session }) => {
            const own = deps.serverSession ? deps.serverSession() : '';
            const out = session.map(s => {
                if (own && s === own) return { session: s, status: 'es la de TSRCT, no la toco' };
                const r = deps.sessionWeight.startHandoff(s, { killOld: true });
                return { session: s, status: r.status };
            });
            return { handoffs: out, plain: `Arranque la renovacion de ${out.filter(o => o.status === 'scheduled').map(o => o.session).join(', ') || 'ninguna'}. Tarda un par de minutos.` };
        },
    },
    {
        name: 'rename_session',
        says: 'cambiarle el nombre a una sesion abierta',
        args: { session: 'session', name: 'label' },
        verify: { fn: 'lib/paneKeys.js:rename' },
        confirmSays: ({ session, name }) => `renombrar ${session} a ${name}`,
        run: ({ session, name }) => {
            if (sessionNames().includes(name)) { const e = new Error(`ya hay una sesion llamada ${name}`); e.soft = true; throw e; }
            const r = deps.paneKeys.rename(session, name);
            if (!r || !r.ok) { const e = new Error((r && r.error) || 'no pude renombrarla'); e.soft = true; throw e; }
            return { from: session, to: name, plain: `Listo, ${session} ahora se llama ${name}.` };
        },
    },
    {
        // "que tengo sin commitear?" across the projects with a session open (or
        // the ones he names). Read-only: git status and a count, nothing else.
        name: 'git_status',
        says: 'decir que proyectos tienen cambios sin guardar en git o commits sin subir; de los que tienen sesion abierta, o de los que diga',
        args: { project: 'projects?' },
        readOnly: true,
        verify: { fn: 'lib/projectRegistry.js:resolve' },
        run: ({ project }) => {
            let dirs;
            if (project && project.length) {
                dirs = [...new Set(project)].map(p => { const w = deps.projectRegistry.resolve(p) || {}; return { name: w.project || p, cwd: w.cwd }; });
            } else {
                const seen = new Set();
                dirs = (deps.tmux.listSessions() || [])
                    .filter(s => s && s.cwd && !restrictedGuard.mentionsRestricted(s.name, s.cwd) && !seen.has(s.cwd) && seen.add(s.cwd))
                    .map(s => ({ name: String(s.cwd).split('/').filter(Boolean).pop(), cwd: s.cwd }));
            }
            const rows = dirs.slice(0, 12).map(d => {
                if (!d.cwd || restrictedGuard.mentionsRestricted(d.name, d.cwd)) return null;
                try { return { project: d.name, ...deps.gitSummary(d.cwd) }; } catch { return { project: d.name, error: 'no es un repo' }; }
            }).filter(Boolean);
            const dirty = rows.filter(r => r.changed || r.ahead);
            return {
                repos: rows,
                plain: dirty.length
                    ? dirty.map(r => `${r.project}: ${r.changed || 0} cambio${r.changed === 1 ? '' : 's'} sin commitear${r.ahead ? `, ${r.ahead} commit${r.ahead === 1 ? '' : 's'} sin subir` : ''}`).join('. ') + '.'
                    : `Todo limpio en ${rows.length} proyecto${rows.length === 1 ? '' : 's'}.`,
            };
        },
    },
    {
        // Walks up to ~150 MB of transcripts, so ONLY when he asks.
        name: 'usage_today',
        says: 'decir cuanto uso de Claude lleva hoy: costo estimado, turnos y en que proyectos',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/usage.js:scan' },
        run: () => {
            const u = deps.usage.scan(deps.usage.todayKey());
            if (!u || !u.ok) return { plain: 'No pude leer el uso de hoy.' };
            const top = (u.byProject || []).filter(p => !restrictedGuard.mentionsRestricted(p.key)).slice(0, 3);
            return {
                cost: Math.round((u.estimatedCost || 0) * 100) / 100, sessions: u.sessionCount,
                top: top.map(p => ({ project: p.key, cost: Math.round(p.cost * 100) / 100 })),
                plain: `Hoy van unos ${Math.round(u.estimatedCost || 0)} dolares estimados en ${u.sessionCount} sesiones. Lo que mas: ${top.map(p => p.key).join(', ') || 'nada todavia'}.`,
            };
        },
    },
    {
        name: 'clients_status',
        says: 'contar como estan los clientes: cuales en rojo o amarillo y por que (lo de la pestania Clientes)',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/clientHealth.js:view' },
        run: () => {
            const v = deps.clientHealth.view();
            const bad = (v.clients || []).filter(c => c.health !== 'green');
            return {
                updatedAt: v.updatedAt,
                clients: (v.clients || []).map(c => ({ name: c.name, health: c.health, reasons: (c.reasons || []).slice(0, 2) })),
                plain: !(v.clients || []).length ? 'Todavia no hay un informe de clientes.'
                    : bad.length ? `${bad.length} con algo pendiente: ${bad.slice(0, 3).map(c => `${c.name} (${c.health === 'red' ? 'rojo' : 'amarillo'})`).join(', ')}.`
                        : 'Todos los clientes en verde.',
            };
        },
    },
    {
        name: 'run_automation',
        says: 'correr ahora una automatizacion, sin esperar a su horario',
        args: { automation: 'automation' },
        verify: { fn: 'lib/automations.js:runNow' },
        confirmSays: ({ automation }) => {
            const a = automations.switchable().find(x => x.id === automation);
            return `correr ahora ${a ? a.title : automation}`;
        },
        run: async ({ automation }) => {
            const r = await automations.runNow(automation);
            if (!r.ok) { const e = new Error(`No pude: ${r.error}`); e.soft = true; throw e; }
            return { plain: 'Arrancada. Te aviso el resultado en la pestania de automatizaciones.' };
        },
    },
    {
        // "redactame / armame un prompt para ..." — the heavy part runs on Opus in
        // the background (it may read the project, the vault and the web), then
        // the prompt lands in his box unsent, or in the session if he said send.
        name: 'research_prompt',
        says: 'que un modelo investigue (el codigo del proyecto, el vault, internet si hace falta) y redacte un prompt bien armado para una sesion; tarda unos minutos. level lo elegis vos segun lo dificil: simple (Haiku: algo obvio y chico), medium (Sonnet: lo normal), complex (Opus: razonamiento profundo, investigar mucho o varias piezas). send si si dijo que lo mande directo, si no queda en su caja para revisarlo',
        args: { goal: 'text', session: 'session?', send: 'onoff?', level: 'level?' },
        asks: { goal: 'Para que es el prompt?' },
        verify: { fn: 'lib/promptWriter.js:start' },
        confirmSays: ({ session, send, level }) => `que ${LEVEL_NAME[level || 'medium']} investigue y arme el prompt${session ? ` para ${session}` : ''}, y ${send ? 'se lo mande directo' : 'te lo deje en la caja para revisarlo'}`,
        run: ({ goal, session, send, level }) => {
            const r = deps.promptWriter.start({ goal, session, send: !!send && !!session, level });
            return { ...r, plain: `Le pedi a ${r.model || 'Sonnet'} que lo investigue y lo arme. Tarda unos minutos; te aviso cuando ${r.send ? `se lo mande a ${r.session}` : 'este en tu caja'}.` };
        },
    },
    {
        name: 'plan_task',
        says: 'una TAREA nueva que le pidieron (Sam, un cliente...): un modelo investiga todo (lo que adjunto, el vault, sus proyectos, Slack/ClickUp/Gmail, internet), decide en que proyecto va o si hace falta una carpeta nueva, y arma el prompt inicial; cuando termina le propone abrir la sesion ahi. goal = todo lo que conto; files = los adjuntos; level segun lo dificil',
        args: { goal: 'text', files: 'files?', level: 'level?' },
        asks: { goal: 'Que te pidieron?' },
        verify: { fn: 'lib/promptWriter.js:start' },
        // Names the job (2026-10-05): "que Sonnet investigue la tarea" said
        // nothing he had asked for, so the question made no sense to him.
        confirmSays: ({ goal, files, level }) => `que ${LEVEL_NAME[level || 'medium']} investigue esto como tarea nueva: "${String(goal || '').replace(/\s+/g, ' ').trim().slice(0, 110)}"${files && files.length ? `, con ${files.length} adjunto${files.length === 1 ? '' : 's'}` : ''}, y te proponga donde abrir la sesion`,
        run: ({ goal, files, level }) => {
            const r = deps.promptWriter.start({ goal, files, level, mode: 'task' });
            return { ...r, plain: `Le pedi a ${r.model || 'Sonnet'} que investigue la tarea${r.files ? ` con ${r.files} adjunto${r.files === 1 ? '' : 's'}` : ''}. Cuando termine te propongo donde abrirla; lo ves en el panel.` };
        },
    },
    {
        name: 'start_task',
        says: 'abrir la sesion de un plan que ya esta esperando su si (crea la carpeta si es nueva, pega el prompt y la deja trabajando). job = la clave del plan',
        args: { job: 'job' },
        verify: { fn: 'lib/promptWriter.js:startTask' },
        confirmSays: ({ job }) => {
            const j = deps.promptWriter.waiting(job);
            const p = j && j.plan;
            return p ? `abrir la sesion ${p.session} en ${p.isNew ? `una carpeta nueva, ${p.project}` : p.project} con el prompt de ${j.model || 'la investigacion'}, y dejarla trabajando` : 'abrir la sesion del plan';
        },
        run: async ({ job }) => {
            const r = await deps.promptWriter.startTask(job);
            return { ...r, plain: `Listo: ${r.session} esta trabajando en ${r.isNew ? `la carpeta nueva ${r.project}` : r.project}.` };
        },
    },
    {
        name: 'drop_task',
        says: 'descartar un plan que esta esperando su si',
        args: { job: 'job' },
        verify: { fn: 'lib/promptWriter.js:drop' },
        confirmSays: ({ job }) => { const j = deps.promptWriter.waiting(job); return `descartar el plan${j && j.plan ? ` de ${j.plan.session}` : ''}`; },
        run: ({ job }) => ({ ok: deps.promptWriter.drop(job), plain: 'Descartado.' }),
    },
    // ── when there is no button for it (2026-09-25) ─────────────────────────
    // lib/teslaHands.js: a visible `hands` Claude session does it, and every
    // one is logged in logs/tesla-workarounds.md - the buttons still missing.
    {
        name: 'look_into',
        says: 'SOLO si ninguna otra accion sirve: que una sesion Claude aparte lo averigue o lo revise POR OTRO CAMINO, sin cambiar nada (leer, buscar, mirar el estado de algo). task = exactamente lo que quiere, completo; why = por que ninguna accion servia; level segun lo dificil',
        args: { task: 'text', why: 'text?', session: 'session?', level: 'level?', detail: 'text?' },
        asks: { task: 'Que queres que averigue?' },
        readOnly: true,
        verify: { fn: 'lib/teslaHands.js:start' },
        run: ({ task, why, session, level, detail }) => {
            const r = deps.teslaHands.start({ task, why, session, level, changes: false, detail: /^(si|true|1|yes)$/i.test(String(detail || '').trim()) });
            return { ...r, plain: 'Lo averiguo y te aviso.' };
        },
    },
    {
        name: 'workaround',
        says: 'SOLO si ninguna otra accion sirve y hay que CAMBIAR, crear, mandar o borrar algo: que una sesion Claude aparte lo haga por otro camino. task = exactamente lo que quiere, completo; why = por que ninguna accion servia; level segun lo dificil',
        args: { task: 'text', why: 'text?', session: 'session?', level: 'level?' },
        asks: { task: 'Que queres que haga?' },
        readOnly: false,
        verify: { fn: 'lib/teslaHands.js:start' },
        confirmSays: ({ task, level }) => `que ${LEVEL_NAME[level || 'medium']} lo haga por otro camino, sin boton: ${String(task).slice(0, 160)}`,
        run: ({ task, why, session, level }) => {
            const r = deps.teslaHands.start({ task, why, session, level, changes: true });
            return { ...r, plain: 'Voy. Te aviso.' };
        },
    },
    // ── the buttons `hands` showed were missing (logs/tesla-workarounds.md, 2026-09-25) ──
    // Three are fixed recipes run in the same `hands` session (they need his
    // mail/calendar/ClickUp/store connectors, which only a Claude session has);
    // one is plain code. A recipe is the task text, written once here, instead
    // of Haiku improvising it every time.
    {
        name: 'day_status',
        says: 'como viene su dia AHORA MISMO, a cualquier hora (no el resumen de la maniana): mira sus sesiones abiertas, el mail nuevo, lo que le queda de calendario y lo que vence en ClickUp, y dice que sigue',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/teslaHands.js:start' },
        run: () => {
            const r = deps.teslaHands.start({ recipe: 'day_status', level: 'medium', changes: false, task: RECIPES.day_status() });
            return { ...r, plain: 'Lo miro y te digo.' };
        },
    },
    {
        name: 'past_sessions',
        says: 'donde quedaron las ultimas conversaciones de Claude de un proyecto (aunque esten cerradas): que fue lo ultimo que el pidio y que le contesto',
        args: { project: 'project' },
        readOnly: true,
        verify: { fn: 'lib/pastSessions.js:forFolder' },
        run: ({ project }) => {
            const where = deps.projectRegistry.resolve(project) || {};
            if (!where.cwd) throw new Error(`no encuentro la carpeta de ${project}`);
            const past = deps.pastSessions.forFolder({ project: where.project || project, cwd: where.cwd });
            const day = (at) => at ? new Date(at).toLocaleString('es-AR', { weekday: 'long', hour: '2-digit', minute: '2-digit' }) : '';
            const plain = past.length
                ? `La ultima de ${where.project || project} fue el ${day(past[0].at)}: le pediste "${past[0].asked.slice(0, 140)}"${past[0].answer ? ` y termino con: ${past[0].answer.slice(0, 200)}` : ''}.`
                : `No encuentro conversaciones de Claude en ${where.project || project}.`;
            return { project: where.project || project, past, plain };
        },
    },
    {
        name: 'store_messages',
        says: 'los mensajes que le dejaron clientes en el chat de la tienda (Shopify Inbox): quien, que dijo, cuando, y si alguien contesto',
        args: { store: 'text?' },
        readOnly: true,
        verify: { fn: 'lib/teslaHands.js:start' },
        run: ({ store }) => {
            const r = deps.teslaHands.start({ recipe: 'store_messages', level: 'simple', changes: false, task: RECIPES.store_messages(store) });
            return { ...r, plain: 'Lo miro y te digo.' };
        },
    },
    {
        name: 'draft_reply',
        says: 'escribirle un borrador de respuesta a alguien (un cliente, un mail, un mensaje de la tienda) sacado del mensaje real, en el idioma de esa persona; NO lo manda. person = a quien; about = que quiere decirle',
        args: { person: 'text', about: 'text?' },
        asks: { person: 'A quien le contesto?' },
        readOnly: true,
        verify: { fn: 'lib/teslaHands.js:start' },
        run: ({ person, about }) => {
            const r = deps.teslaHands.start({ recipe: 'draft_reply', level: 'medium', changes: false, task: RECIPES.draft_reply(person, about) });
            return { ...r, plain: 'Te lo escribo, sin mandar.' };
        },
    },
    {
        name: 'look_at_screen',
        says: 'MIRAR la pantalla de su PC (Windows, sus monitores) y contestar algo sobre lo que se ve: que ventana hay abierta, que dice un documento o un error, donde esta algo. Solo mira, no toca nada. question = lo que quiere saber; screen = el numero de monitor si lo dijo; level segun lo dificil',
        args: { question: 'text', screen: 'text?', level: 'level?', detail: 'text?' },
        asks: { question: 'Que queres que mire en la pantalla?' },
        readOnly: true,
        verify: { fn: 'lib/teslaHands.js:start' },
        run: ({ question, screen, level, detail }) => {
            const d = String(detail || '').trim().toLowerCase();
            const full = d === 'textual' ? 'textual' : /^(si|true|1|yes)$/.test(d);
            const r = deps.teslaHands.start({ recipe: 'look_at_screen', level: level || 'medium', changes: false, detail: full, task: RECIPES.look_at_screen(question, screen, full) });
            return { ...r, plain: 'Miro.' };
        },
    },
    {
        name: 'do_on_pc',
        says: 'HACER algo en su PC (Windows) con mouse y teclado, como una persona: abrir programas y ventanas, buscar y abrir archivos, completar algo en una pagina, escribir texto. Para tareas de varios pasos; antes de mandar, borrar, pagar o publicar le vuelve a preguntar. Si toca el mouse, para. task = exactamente lo que quiere, completo; level segun lo dificil (complex para tareas largas); harmless = "si" cuando SOLO pone musica, cambia el volumen, abre o acomoda ventanas o navega para mirar (nada que mande, borre, escriba en algo suyo, pague o instale): entonces no se le pregunta',
        args: { task: 'text', level: 'level?', harmless: 'text?' },
        // Tesla review #11: "pone algo, sorprendeme" -> "¿Pongo Happy?" -> "tampoco tan
        // generico" read as NO -> "no me preguntes ... ponelo directamente". A song is
        // not a decision. The brain marks it harmless; the WORDS are checked again here.
        skipConfirm: ({ task, harmless }) => /^(si|true|1|yes)$/i.test(String(harmless || '').trim()) && !RISKY_PC.test(String(task || '')),
        asks: { task: 'Que queres que haga en la PC?' },
        readOnly: false,
        verify: { fn: 'lib/teslaHands.js:start' },
        // Short on purpose: he waits for the whole question before he can say yes.
        confirmSays: ({ task }) => `en tu PC: ${String(task || '').replace(/\s+/g, ' ').trim().replace(/\s+en (la|tu|mi) (pc|compu\w*)\.?$/i, '').replace(/^\w/, c => c.toLowerCase()).slice(0, 100)}`,
        run: ({ task, level }) => {
            const r = deps.teslaHands.start({ recipe: 'do_on_pc', level: level || 'medium', changes: true, task: RECIPES.do_on_pc(task) });
            return { ...r, plain: 'Voy.' };
        },
    },
    // ── the SEPARATE browser (2026-10-12, the PROJECTOR) ─────────────────────
    // Web work done in a headless browser of its own (scripts/projector.js)
    // that he watches live, so his mouse stays his. His rule: she must ASK, so
    // it always confirms once, and the question says what it costs him: nothing.
    {
        name: 'browser_task',
        says: 'HACER algo que pasa SOLO en paginas web (un curso online, Salesforce o la Academy en el navegador, completar un formulario web, navegar y leer un sitio) en un NAVEGADOR APARTE, sin tocar su mouse: el lo mira en vivo en el proyector y sigue usando su PC. Siempre le pregunta antes. task = exactamente lo que quiere, completo, con las direcciones o nombres que dijo; level segun lo dificil (complex para un curso o muchos pasos)',
        args: { task: 'text', level: 'level?' },
        asks: { task: 'Que queres que haga en el navegador aparte?' },
        readOnly: false,
        verify: { fn: 'lib/teslaHands.js:start' },
        confirmSays: ({ task }) => `en el navegador aparte, con tu mouse libre: ${String(task || '').replace(/\s+/g, ' ').trim().replace(/^\w/, c => c.toLowerCase()).slice(0, 100)}`,
        run: ({ task, level }) => {
            const r = deps.teslaHands.start({ recipe: 'browser_task', level: level || 'medium', changes: true, task: RECIPES.browser_task(task) });
            return { ...r, plain: 'Voy. Miralo en el proyector, sesion hands.' };
        },
    },
    // ── the PC without the mouse (2026-10-10) ───────────────────────────────
    // Leon: "toda tarea que se pueda hacer mas rapido o eficiente evitando el
    // uso fisico del mouse, que se haga". These are ~1 s, no screenshot, no
    // model; do_on_pc (the mouse) is for what happens INSIDE an app.
    {
        name: 'session_files',
        says: 'que archivos escribio o cambio una sesion hace poco (un documento que genero, un reporte): sale de lo que hizo la sesion, no de buscar',
        args: { session: 'session' },
        readOnly: true,
        verify: { fn: 'lib/pcDirect.js:sessionFiles' },
        run: ({ session }) => {
            const files = deps.pcDirect.sessionFiles(session);
            const name = (f) => f.path.split('/').pop();
            return {
                files,
                plain: files.length
                    ? `${session} ${files.length === 1 ? 'escribio' : 'escribio estos'}: ${files.slice(0, 4).map(name).join(', ')}.${files.length > 4 ? ` Y ${files.length - 4} mas.` : ''}`
                    : `No veo archivos que ${session} haya escrito en las ultimas horas.`,
            };
        },
    },
    {
        name: 'open_file',
        says: 'ABRIR un archivo o una carpeta en su PC con su programa de siempre (o mostrarlo en su carpeta con reveal). path = la ruta exacta (sale de "ARCHIVOS QUE ... ESCRIBIO" o de lo que ya se hablo). Sin mouse, al instante',
        args: { path: 'text', reveal: 'text?' },
        asks: { path: 'Que archivo abro?' },
        readOnly: true,
        verify: { fn: 'lib/pcDirect.js:openPath' },
        run: async ({ path: p, reveal }) => {
            const r = await deps.pcDirect.openPath({ path: p, reveal: !!reveal && !/^(no|false|0)$/i.test(String(reveal)) });
            const file = r.opened.split('/').pop();
            return { ...r, plain: r.reveal ? 'Ahi esta.' : 'Abierto.' };
        },
    },
    {
        name: 'open_app',
        says: 'ABRIR un programa de su PC por nombre (Spotify, Excel, WhatsApp, Chrome...); si ya esta abierto lo trae al frente. O una pagina web si name es una direccion https. Sin mouse, al instante',
        args: { name: 'text' },
        asks: { name: 'Que programa abro?' },
        readOnly: true,
        verify: { fn: 'lib/pcDirect.js:openApp' },
        run: async ({ name }) => {
            if (/^https?:\/\//i.test(String(name).trim())) { const r = await deps.pcDirect.openUrl(name); return { ...r, plain: 'Abierta.' }; }
            const r = await deps.pcDirect.openApp(name);
            return { ...r, plain: r.how === 'focused' ? 'Listo.' : `Abriendo ${r.app}.` };
        },
    },
    {
        name: 'media',
        says: 'MUSICA y VOLUMEN de su PC con las teclas multimedia, al instante y sin mouse: play/pausa, siguiente, anterior, subir, bajar, maximo, silencio. what = una de esas; times = cuantas veces si lo dijo',
        args: { what: 'text', times: 'text?' },
        asks: { what: 'Play, pausa, siguiente, o el volumen?' },
        readOnly: true,
        verify: { fn: 'lib/pcDirect.js:media' },
        run: async ({ what, times }) => {
            await deps.pcDirect.media(what, times);
            return { plain: 'Listo.' };
        },
    },
    {
        name: 'move_file',
        says: 'MOVER un archivo a una carpeta (descargas, escritorio, documentos, la carpeta de un proyecto, o una ruta). Nunca pisa uno que ya este. path = la ruta exacta del archivo; to = la carpeta como la dijo',
        args: { path: 'text', to: 'text' },
        asks: { path: 'Que archivo muevo?', to: 'A que carpeta?' },
        readOnly: false,
        verify: { fn: 'lib/pcDirect.js:moveFile' },
        confirmSays: ({ path: p, to }) => `muevo ${String(p).split('/').pop()} a ${to}`,
        run: ({ path: p, to }) => {
            const r = deps.pcDirect.moveFile({ path: p, to });
            return { ...r, plain: 'Movido.' };
        },
    },
    // ── windows, layouts, shortcuts (2026-10-11, TESLA-PC-PATHS.md) ─────────
    // "toda tarea que se pueda hacer mas rapido evitando el mouse": one call, ~1 s,
    // no screenshot and no model. All undoable, so none asks - except the two
    // that throw something away (overwrite a saved layout, a shortcut marked ask).
    {
        name: 'arrange_window',
        says: 'ACOMODAR una ventana de su PC sin mouse: a la izquierda/derecha, arriba/abajo, una esquina, un tercio, maximizar, minimizar, centrar, o pasarla al otro monitor. window = el programa (spotify, chrome, slack...); where = el lugar COMO LO DIJO ("a la derecha del monitor", "al otro monitor", "maximizala"). Para dos ventanas a la vez, window2 y where2',
        args: { window: 'text', where: 'text', window2: 'text?', where2: 'text?' },
        asks: { window: 'Que ventana?', where: 'A donde la pongo?' },
        readOnly: true,
        verify: { fn: 'lib/deskWindows.js:place' },
        run: async ({ window: w, where, window2, where2 }) => {
            const items = [{ window: w, where }];
            if (window2) items.push({ window: window2, where: where2 || where });
            const r = await deps.deskWindows.placeMany(items, { direct: true });
            if (!r.done.length && r.failed.length) { const e = new Error(r.failed[0].why); e.soft = true; throw e; }
            return { ...r, plain: r.failed.length ? `Listo, menos ${r.failed.map(f => f.window).join(' y ')}.` : 'Listo.' };
        },
    },
    {
        name: 'solo_window',
        says: 'dejar UNA sola ventana a la vista y minimizar todas las demas ("dejame solo el excel", "solo spotify"). window = la que queda',
        args: { window: 'text' },
        asks: { window: 'Cual dejo?' },
        readOnly: true,
        verify: { fn: 'lib/deskWindows.js:solo' },
        run: async ({ window: w }) => {
            const r = await deps.deskWindows.solo({ keep: w, direct: true });
            return { ...r, plain: 'Listo.' };
        },
    },
    {
        name: 'arrange',
        says: 'ARMAR un modo de trabajo guardado: abre y acomoda de una vez todas sus ventanas ("modo trabajo", "arma foco", "poneme el setup de musica"). Sirve para sus workspaces de PowerToys y para los que guardo con save_layout. name = el nombre como lo dijo',
        args: { name: 'text' },
        asks: { name: 'Cual armo?' },
        readOnly: true,
        verify: { fn: 'lib/deskWindows.js:arrange' },
        run: async ({ name }) => {
            const r = await deps.deskWindows.arrange({ name, direct: true });
            const miss = r.missing && r.missing.length ? ` Menos ${r.missing.join(' y ')}, que no abrio.` : '';
            return { ...r, plain: `Armado.${miss}` };
        },
    },
    {
        name: 'save_layout',
        says: 'GUARDAR como esta su pantalla ahora (que ventanas y donde) con un nombre, para volver despues con arrange ("guarda esto como foco"). name = el nombre. Si ya existe uno con ese nombre, le pregunta antes de pisarlo',
        args: { name: 'text' },
        asks: { name: 'Con que nombre lo guardo?' },
        readOnly: false,
        // New name: nothing is lost, no question. An existing one: asks.
        skipConfirm: ({ name }) => !deps.deskWindows || !deps.deskWindows.listLayouts().some(l => !l.starter && l.name === deps.deskWindows.layoutKey(name)),
        confirmSays: ({ name }) => `piso ${deps.deskWindows ? deps.deskWindows.layoutKey(name) : name}`,
        verify: { fn: 'lib/deskWindows.js:saveLayout' },
        run: async ({ name }) => {
            const r = await deps.deskWindows.saveLayout({ name, overwrite: true });
            return { ...r, plain: `Guardado como ${r.name}.` };
        },
    },
    {
        name: 'list_layouts',
        says: 'que modos de trabajo / disposiciones de ventanas tiene guardados (los suyos, los de fabrica y sus workspaces de PowerToys)',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/deskWindows.js:arrangeNames' },
        run: () => {
            const names = deps.deskWindows.arrangeNames();
            return { names, plain: names.length ? `Tenes ${names.slice(0, -1).join(', ')}${names.length > 1 ? ' y ' : ''}${names[names.length - 1]}.` : 'Todavia no hay ninguno.' };
        },
    },
    {
        name: 'delete_layout',
        says: 'BORRAR un modo de trabajo que guardo. name = cual',
        args: { name: 'text' },
        asks: { name: 'Cual borro?' },
        readOnly: false,
        confirmSays: ({ name }) => `borro ${deps.deskWindows ? deps.deskWindows.layoutKey(name) : name}`,
        verify: { fn: 'lib/deskWindows.js:deleteLayout' },
        run: ({ name }) => ({ ...deps.deskWindows.deleteLayout(name), plain: 'Borrado.' }),
    },
    {
        name: 'set_zones',
        says: 'cambiar las ZONAS de FancyZones de un monitor (columnas, filas, grilla, prioridad, foco, sin zonas). layout = la forma como la dijo; screen = "el monitor"/"la notebook" si lo dijo',
        args: { layout: 'text', screen: 'text?' },
        asks: { layout: 'Que forma? Columnas, filas, grilla, prioridad o foco.' },
        readOnly: true,
        verify: { fn: 'lib/deskWindows.js:setZones' },
        run: async ({ layout, screen }) => {
            const sc = screen ? (deps.deskWindows.parseWhere(screen).screen || screen) : undefined;
            const r = await deps.deskWindows.setZones({ layout, screen: sc });
            return { ...r, plain: 'Listo.' };
        },
    },
    {
        name: 'press_shortcut',
        says: 'un ATAJO con nombre en su PC, sin mouse: mostrar el escritorio, minimizar todo, portapapeles, captura de pantalla, explorador, administrador de tareas, escritorios virtuales, emojis; en Chrome pestana nueva/cerrar/reabrir/siguiente/recargar; en Slack no leidos/directos/menciones; Spotify aleatorio/repetir; Outlook correo/calendario; cerrar la ventana de adelante (pregunta). name = el atajo COMO LO DIJO',
        args: { name: 'text' },
        asks: { name: 'Que atajo?' },
        readOnly: false,
        skipConfirm: ({ name }) => { const r = deps.deskShortcuts && deps.deskShortcuts.findShortcut(name); return !!r && r.risk === 'harmless'; },
        confirmSays: ({ name }) => { const r = deps.deskShortcuts && deps.deskShortcuts.findShortcut(name); return r ? r.name : String(name); },
        verify: { fn: 'lib/deskShortcuts.js:pressShortcut' },
        run: async ({ name }) => {
            const row = deps.deskShortcuts.findShortcut(name);
            if (!row) { const e = new Error('no tengo un atajo para eso'); e.soft = true; throw e; }
            const r = await deps.deskShortcuts.pressShortcut(row);
            return { ...r, plain: 'Listo.' };
        },
    },
    {
        name: 'pc_routine',
        says: 'ir DIRECTO a algo dentro de un programa con el teclado: en Slack abrir un canal o el chat con alguien (Ctrl+K), en VS Code abrir un archivo por nombre, en Chrome buscar un texto en la pagina. Solo abre y busca, nunca manda. routine = "slack" | "vscode" | "buscar en la pagina"; what = el canal, la persona o el archivo',
        args: { routine: 'text', what: 'text' },
        asks: { what: 'Cual?' },
        readOnly: true,
        verify: { fn: 'lib/deskShortcuts.js:runRoutine' },
        run: async ({ routine, what }) => {
            const r = deps.deskShortcuts.findRoutine(routine) || deps.deskShortcuts.ROUTINES.find(x => x.app === String(routine).toLowerCase().replace(/vs ?code/, 'code'));
            if (!r) { const e = new Error('no tengo una rutina para eso'); e.soft = true; throw e; }
            const res = await deps.deskShortcuts.runRoutine(r, what);
            return { ...res, plain: 'Ahi esta.' };
        },
    },
    {
        name: 'windows_settings',
        says: 'abrir una parte de la CONFIGURACION de Windows directo (sonido, pantalla, bluetooth, wifi, notificaciones, bateria, aplicaciones, impresoras, actualizaciones, fondo, modo oscuro...). page = la parte como la dijo',
        args: { page: 'text?' },
        readOnly: true,
        verify: { fn: 'lib/deskShortcuts.js:openSettings' },
        run: async ({ page }) => ({ ...(await deps.deskShortcuts.openSettings(page || '')), plain: 'Abierto.' }),
    },
    // Music that PLAYS (2026-10-14, "me obliga a tocar play a mi"): spotify_search
    // only opened the results page, and every "poneme X" ended there.
    {
        name: 'play_music',
        says: 'PONER MUSICA en Spotify y que SUENE ya, sin preguntar: un artista, un tema, un genero, un estilo o un animo ("algo para concentrarme"). query = lo que pidio, en pocas palabras; si dijo "sorprendeme", "cualquier cosa" o no nombro nada, elegi VOS algo concreto y distinto y ponelo en query (o dejalo vacio)',
        args: { query: 'text?' },
        readOnly: true,
        verify: { fn: 'lib/spotify.js:playMusic' },
        run: async ({ query }) => {
            const r = await (deps.spotify || require('./spotify')).playMusic(query || '');
            return { ...r, plain: r.why ? `Suena ${r.playing}. ${r.why}.` : `Suena ${r.playing}.` };
        },
    },
    // His taste (lib/tasteBrain.js, 2026-10-14): what she picks for "sorprendeme"
    // and for a moment is inferred from WHY he likes things, and these two are how
    // he tells her. Saved, never asked: he says them mid-run.
    {
        name: 'music_react',
        says: 'lo que le parece la MUSICA QUE ESTA SONANDO: "me gusta esto", "esto no", "no me gusta, demasiado limpio", "me encanta este tema". liked = si o no; reason = el por que si lo dijo',
        args: { liked: 'text', reason: 'text?' },
        readOnly: true,
        verify: { fn: 'lib/tasteBrain.js:react' },
        run: async ({ liked, reason }) => {
            const r = (deps.taste || require('./tasteBrain')).react({ liked, reason });
            return { ...r, plain: r.liked ? 'Anotado, va para ese lado.' : 'Anotado, no te lo vuelvo a poner.' };
        },
    },
    {
        name: 'music_teach',
        says: 'ENSENARLE su GUSTO musical: un artista, tema o estilo que le gusta y por que ("anota que me gusta Lorn por los graves sucios"). what = el artista/tema/estilo; why = el por que, con sus palabras',
        args: { what: 'text', why: 'text?' },
        asks: { what: 'Que te gusta?' },
        readOnly: true,
        verify: { fn: 'lib/tasteBrain.js:teach' },
        run: async ({ what, why }) => {
            const r = (deps.taste || require('./tasteBrain')).teach({ what, why });
            return { ...r, plain: r.why ? 'Anotado, con el por que.' : 'Anotado. Si me decis por que te gusta, aprendo mas.' };
        },
    },
    {
        name: 'spotify_search',
        says: 'BUSCAR algo en Spotify y DEJAR los resultados a la vista, sin reproducir: solo si dijo "busca" o "mostrame" (para PONER musica es play_music). query = lo que hay que buscar',
        args: { query: 'text' },
        asks: { query: 'Que busco?' },
        readOnly: true,
        verify: { fn: 'lib/deskShortcuts.js:spotifySearch' },
        run: async ({ query }) => ({ ...(await deps.deskShortcuts.spotifySearch(query)), plain: 'Ahi esta.' }),
    },
    {
        name: 'list_windows',
        says: 'que VENTANAS tiene abiertas en la PC y en que monitor, sin mirar la pantalla',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/deskWindows.js:list' },
        run: async () => {
            const { windows, monitors } = await deps.deskWindows.list({ fresh: true });
            const shown = windows.filter(w => !w.restricted);
            const where = (w) => w.state === 'min' ? 'minimizada' : monitors.length > 1 ? (monitors.find(m => m.n === w.screen) || {}).primary ? 'en la notebook' : 'en el monitor' : '';
            return { windows: shown, plain: shown.length ? shown.slice(0, 8).map(w => `${w.process} ${where(w)}`.trim()).join(', ') + '.' : 'No hay ventanas abiertas.' };
        },
    },
    {
        name: 'lock_pc',
        says: 'BLOQUEAR la PC (la pantalla de inicio de Windows). Pregunta antes',
        args: {},
        readOnly: false,
        confirmSays: () => 'bloqueo la PC',
        verify: { fn: 'lib/deskShortcuts.js:lockPc' },
        run: async () => ({ ...(await deps.deskShortcuts.lockPc()), plain: 'Bloqueada.' }),
    },
    {
        name: 'last_prompt',
        says: 'decir como va o que decia el ultimo prompt que se armo',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/promptWriter.js:last' },
        run: () => {
            const j = deps.promptWriter.last();
            if (!j) return { plain: 'Todavia no arme ningun prompt en esta sesion de TSRCT.' };
            const mins = Math.max(1, Math.round((Date.now() - j.startedAt) / 60000));
            const st = { running: `lo esta armando hace ${mins} minutos`, sent: `se lo mande a ${j.session}`, drafted: 'te lo deje en la caja', ready: 'esta listo pero no lo pude dejar en la caja', failed: 'fallo', refused: 'lo descarte porque tocaba SecretCo', waiting: `esta listo y espera tu si para abrir ${j.plan ? j.plan.session : 'la sesion'}`, starting: 'estoy abriendo la sesion', started: `la sesion ${j.session} ya esta trabajando`, dropped: 'lo descartaste' }[j.state] || j.state;
            return { state: j.state, summary: j.summary, prompt: j.prompt ? j.prompt.slice(0, 1500) : '', plain: `El ultimo: ${st}. ${j.summary || ''}`.trim() };
        },
    },
    {
        name: 'list_sessions',
        says: 'decir que sesiones estan abiertas y en cual esta trabajando cada una',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/dispatcher/tmuxAdapter.js:listSessions' },
        run: () => {
            const list = deps.tmux.listSessions();
            const names = list.map(s => s.name);
            return {
                sessions: list.map(s => ({ name: s.name, cwd: s.cwd, attached: !!s.attached })),
                // What to say if there is no model to say it better. A read that
                // answers "Listo." is worse than no read at all.
                plain: names.length
                    ? `Tenes ${names.length} abierta${names.length === 1 ? '' : 's'}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` y ${names.length - 4} mas` : ''}.`
                    : 'No tenes ninguna sesion abierta.',
            };
        },
    },
    {
        name: 'read_session',
        says: 'mirar que hay en la pantalla de una sesion',
        args: { session: 'session', lines: 'lines?' },
        readOnly: true,
        verify: { fn: 'lib/dispatcher/tmuxAdapter.js:captureSession' },
        run: ({ session, lines }) => {
            const raw = deps.tmux.captureSession(session, Math.max(lines || 40, 40) + 20);
            const text = paneShape.readableTail(raw, { lines: lines || 40, chars: 2500 });
            restrictedGuard.assertNotRestricted('actions (screen)', text);
            return { session, working: paneShape.looksLikeWorking(paneShape.tailOf(raw, 25)), screen: text };
        },
    },
    {
        // "cual es el estado actual del proyecto X" was the question it could not
        // answer: every read it had was about a SESSION, so a question about a
        // PROJECT fell through to the router, which reached for the only action
        // whose description had the word "proyecto" in it and offered to open a
        // session. The missing piece was not intelligence, it was this: a project
        // is its open sessions plus where the last one left off.
        name: 'project_status',
        says: 'contar como viene un proyecto o una sesion: si tiene sesiones abiertas, que estan haciendo, y donde quedo la ultima vez',
        args: { project: 'place' },
        readOnly: true,
        verify: { fn: 'lib/projectMemory.js:forProject' },
        run: ({ project }) => {
            const all = (deps.tmux.listSessions() || [])
                .filter(s => s && s.name && !restrictedGuard.mentionsRestricted(s.name));
            // He named a session: that pane IS the answer, and the project it
            // sits in supplies the background.
            const one = project.kind === 'session' ? all.find(s => s.name === project.name) : null;
            const where = one
                ? { project: one.cwd ? String(one.cwd).split('/').filter(Boolean).pop() : project.name, cwd: one.cwd || '' }
                : (deps.projectRegistry.resolve(project.name) || {});
            const name = where.project || project.name;
            const dir = where.cwd || '';
            const live = one ? [one] : all
                .filter(s => dir && s.cwd && (s.cwd === dir || String(s.cwd).startsWith(dir + '/')));
            // Two, and a short tail of each. This whole object is read into a
            // 4096-token window a sentence later; a third screen buys nothing and
            // costs the answer's latency.
            const sessions = live.slice(0, 2).map(s => {
                let screen = '', working = false;
                try {
                    const raw = deps.tmux.captureSession(s.name, 60);
                    working = !!paneShape.looksLikeWorking(paneShape.tailOf(raw, 25));
                    screen = paneShape.readableTail(raw, { lines: 20, chars: 350 });
                } catch { /* a pane that will not capture is an absence, not an error */ }
                return { session: s.name, working, screen };
            });
            const mem = deps.projectMemory ? deps.projectMemory.forProject(name, dir) : null;
            const out = {
                project: name,
                openSessions: live.length,
                sessions,
                lastSession: mem && mem.lastSession
                    ? { date: mem.lastSession.date || null, text: String(mem.lastSession.text || '').slice(0, 350) }
                    : null,
                decided: (mem && Array.isArray(mem.decisions) ? mem.decisions : []).slice(0, 2),
            };
            out.plain = out.openSessions
                ? `${name} tiene ${out.openSessions} sesion${out.openSessions === 1 ? '' : 'es'} abierta${out.openSessions === 1 ? '' : 's'}: ${sessions.map(s => s.session + (s.working ? ' trabajando' : ' esperando')).join(', ')}.`
                : `${name} no tiene ninguna sesion abierta${out.lastSession && out.lastSession.date ? `. La ultima fue el ${out.lastSession.date}` : ''}.`;
            // Panes, vault notes and the decisions log in one object, on its way
            // to a model. The same fail-closed check the narrator does.
            restrictedGuard.assertNotRestricted('actions (project status)', JSON.stringify(out));
            return out;
        },
    },
    {
        name: 'say_to_session',
        says: 'escribirle algo a una sesion, como si lo tipearas vos',
        // A confirmation has to name the THING, not the capability: "do you want
        // me to type something into a session?" is not a question anybody can
        // answer safely. The arguments are the question.
        confirmSays: ({ session, text }) => `mandarle "${text}" a ${session}`,
        args: { session: 'session', text: 'text' },
        readOnly: false,
        verify: { fn: 'lib/dispatcher/tmuxAdapter.js:sendToSession' },
        run: ({ session, text }) => {
            // tmuxAdapter.sendToSession returns NOTHING on success and throws on
            // failure. Reading "nothing" as "not sent" told Tesla every send had
            // failed, and she said so every time (2026-09-25).
            const out = deps.tmux.sendToSession(session, text);
            return { session, sent: !out || out.success !== false };
        },
    },
    {
        name: 'open_session',
        says: 'abrir una sesion nueva de Claude en un proyecto, o en varios a la vez (sin limite de 4: mas de 4 se abren de a una en segundo plano); name es el nombre de la sesion si el lo dice, o una lista con un nombre por proyecto en el mismo orden para reabrir sesiones como estaban; prompt = lo que la sesion tiene que hacer apenas abre, si el se lo pide ("abri una en HARBOR y pedile que revise..."), escrito completo y claro',
        confirmSays: ({ project, name: names, prompt, panel }) => {
            const name = names && names.length === 1 ? names[0] : '';
            const perOne = names && names.length > 1 && names.length === project.length;
            const tail = (project.length > MAX_AT_ONCE ? ', de a una y en segundo plano; te aviso cuando esten' : '')
                + (project.skippedRestricted ? `. Una la dejo afuera porque no la toco desde aca, esa la abris vos` : '');
            const called = (name ? ` con el nombre ${name}` : '') + (panel ? ` en el panel de ${panel}` : '') + (prompt ? ` y pedirle: ${String(prompt).slice(0, 140)}` : '');
            if (project.length === 1) return `abrir una sesion nueva en ${project[0]}${called}${tail}`;
            if (perOne) return `abrir ${project.length} sesiones: ${project.map((p, i) => `${names[i]} en ${p}`).join(', ')}${tail}`;
            if (name) return `abrir ${project.length} sesiones nuevas (${project.join(', ')}) con el nombre ${name}${tail}`;
            // "4 en personal", not "personal, personal, personal, personal"
            const each = [...new Set(project)].map(p => ({ p, n: project.filter(x => x === p).length }));
            if (each.length === 1) return `abrir ${project.length} sesiones nuevas en ${project[0]}${tail}`;
            return `abrir ${project.length} sesiones nuevas: ${each.map(e => (e.n > 1 ? `${e.n} en ${e.p}` : e.p)).join(', ')}${tail}`;
        },
        // `name` is optional: without it the session is called after the project.
        // Missing on 2026-09-24, so Haiku opened the manual form for "una nueva
        // con el nombre creators" - the only door that could take a name.
        // `panel` (2026-10-08): "en esta misma terminal" - the new session takes
        // the split panel that shows this one, instead of opening off screen.
        // `name` takes a list too: one name per project, in order, to reopen a
        // set of sessions as they were (2026-10-14).
        args: { project: 'projects', name: 'labels?', prompt: 'text?', panel: 'session?' },
        readOnly: false,
        verify: { fn: 'lib/sessionSpawn.js:createPrimedSession' },
        run: async (args) => {
            const { project } = args;
            return project.length <= MAX_AT_ONCE ? openNow(args) : inBackground(args);
        },
    },
    {
        // Back as they were: same name, same folder, same conversation (2026-10-14:
        // fifteen closed at once and she could place only eight by their names).
        name: 'reopen_sessions',
        says: 'reabrir sesiones que se cerraron (se cayeron, reinicio la compu, "abrilas de nuevo como estaban"): cada una con su nombre, en su carpeta y con su conversacion; session = "todas" para las que se cerraron juntas, o sus nombres',
        confirmSays: ({ session }) => `reabrir ${session.length === 1 ? 'la sesion' : `${session.length} sesiones`} como estaban, con su conversacion: ${session.map(r => r.name).join(', ')}`
            + (session.length > MAX_AT_ONCE ? ', de a una y en segundo plano; te aviso cuando esten' : ''),
        args: { session: 'closedSessions' },
        readOnly: false,
        verify: { fn: 'lib/sessionFolders.js:closed' },
        run: async ({ session }) => {
            const args = { project: session.map(r => r.cwd.split('/').pop()), name: session.map(r => r.name), places: session.map(r => ({ cwd: r.cwd, project: r.cwd.split('/').pop(), sessionId: r.sessionId })) };
            return session.length <= MAX_AT_ONCE ? openNow(args) : inBackground(args);
        },
    },
    {
        name: 'close_session',
        says: 'cerrar una sesion abierta, o varias',
        confirmSays: ({ session }) => {
            // The confirmation says which ones AND which are mid-turn: closing a
            // session that is working throws away what it was doing.
            const busy = session.filter(s => isWorking(s));
            const list = session.join(', ');
            return (session.length === 1 ? `cerrar la sesion ${list}` : `cerrar ${session.length} sesiones: ${list}`)
                + (busy.length ? ` (ojo: ${busy.join(', ')} ${busy.length === 1 ? 'esta trabajando' : 'estan trabajando'} ahora mismo)` : '');
        },
        args: { session: 'sessions' },
        readOnly: false,
        verify: { fn: 'lib/dispatcher/tmuxAdapter.js:sessionExists' },
        run: async ({ session }) => {
            const closed = [];
            for (const name of session) {
                let out = null;
                try { out = deps.killSession(name); } catch (e) { out = { ok: false, error: e.message }; }
                closed.push({ session: name, ok: !!(out && out.ok), why: out && out.error });
                opened = opened.filter(n => n !== name);
            }
            return { closed, ok: closed.every(c => c.ok) };
        },
    },
    {
        // The one that types into SEVERAL at once. Its confirmation names every
        // session, because "mandarle a las tres" is not a question anybody can
        // answer safely without knowing which three.
        name: 'say_to_sessions',
        says: 'escribirle lo mismo a varias sesiones a la vez',
        confirmSays: ({ session, text }) => `mandarle "${text}" a ${session.join(', ')}`,
        // manySessions: a paste costs nothing, and "a todas" means all of them
        // (2026-10-14: "mandales a cada una" reached 4 of 16).
        args: { session: 'manySessions', text: 'text' },
        readOnly: false,
        verify: { fn: 'lib/dispatcher/tmuxAdapter.js:sendToSession' },
        run: ({ session, text }) => {
            const sent = [];
            for (const name of session) {
                let out = null;
                try { out = deps.tmux.sendToSession(name, text); } catch (e) { out = { success: false, error: e.message }; }
                sent.push({ session: name, ok: !out || out.success !== false, why: out && out.error });
            }
            return { sent, ok: sent.every(s => s.ok) };
        },
    },
    {
        // A setup is a list of the actions above, said once. Nothing new can
        // happen here: every step goes back through this same gate.
        name: 'run_setup',
        says: 'armar uno de sus setups guardados: abre las sesiones y deja todo como lo dejo la ultima vez',
        confirmSays: ({ setup }) => {
            const steps = deps.setups.get(setup) || [];
            const said = steps.map(s => {
                const a = byName.get(s.name);
                if (a && a.confirmSays) { try { return a.confirmSays(validate(s.name, s.args).args); } catch { /* fall through */ } }
                return (a && a.says) || s.name;
            });
            return `armar el setup ${setup}: ${said.join('; ')}`;
        },
        args: { setup: 'setup' },
        readOnly: false,
        verify: { fn: 'lib/setups.js:get' },
        run: async ({ setup }) => {
            const steps = deps.setups.get(setup) || [];
            const done = [];
            for (const step of steps) {
                // Through the gate again, confirmed: he agreed to the whole list
                // by name, and each step still has to be valid RIGHT NOW.
                try {
                    const r = await run(step.name, step.args, { confirmed: true });
                    done.push({ step: step.name, ok: !!r.ok });
                    if (!r.ok) break;
                } catch (e) {
                    // Half a board is worse than none: he would be looking at two
                    // sessions believing there are three.
                    done.push({ step: step.name, ok: false, why: e.message });
                    break;
                }
            }
            return { setup, steps: done, ok: done.length === steps.length && done.every(d => d.ok) };
        },
    },
    {
        name: 'save_setup',
        says: 'guardar lo que acaba de hacer como un setup con nombre, para pedirlo despues en una frase',
        confirmSays: ({ name }) => `guardar lo que hicimos recien como el setup "${name}"`,
        args: { name: 'text' },
        asks: { name: 'Dale. Como querias llamarlo?' },
        readOnly: false,
        verify: { fn: 'lib/setups.js:fromHistory' },
        run: ({ name }) => {
            const r = deps.setups.fromHistory(name, deps.recent ? deps.recent() : []);
            if (!r.ok) { const e = new Error(r.why); e.soft = true; throw e; }
            return r;
        },
    },
    {
        name: 'read_brief',
        says: 'contar que decia el resumen de la maniana',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/morningRoutine.js:loadState' },
        run: () => {
            const st = deps.morningRoutine.loadState() || {};
            // The plan is part of the brief: "what did it say" and "what did it
            // want to open" are the same question at six in the morning.
            const plan = plannedNow();
            return {
                date: st.today || st.date || null,
                brief: st.brief || '',
                phase: st.phase || null,
                proposed: plan.all.map(p => p.session),
                stillClosed: plan.left.map(p => p.session),
                plain: st.brief ? String(st.brief) : 'Todavia no hay resumen de hoy.',
            };
        },
    },
    {
        // What he has to do today, in the order the brief ranked it. The brief
        // already did the work (ClickUp, mail, calendar, Slack, the vault) at six;
        // this reads that list back instead of spending a second headless job.
        name: 'today_tasks',
        says: 'decir que tareas tiene para hoy y cual es la proxima que deberia hacer',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/morningRoutine.js:loadState' },
        run: () => {
            const st = deps.morningRoutine.loadState() || {};
            const d = new Date();
            const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const tasks = (Array.isArray(st.pending) ? st.pending : [])
                .filter(t => t && t.title && !restrictedGuard.mentionsRestricted(JSON.stringify(t)))
                .slice(0, 5)
                .map(t => ({ title: String(t.title), why: String(t.why || '').slice(0, 200), project: t.project || '' }));
            const stale = st.today && st.today !== today;
            const out = { date: st.today || null, stale: !!stale, tasks };
            out.plain = !tasks.length
                ? (st.today ? 'El resumen de hoy no dejo tareas pendientes.' : 'Todavia no hay resumen de hoy, asi que no tengo la lista.')
                : `${stale ? `La lista es del ${st.today}. ` : ''}Lo primero: ${tasks[0].title}.${tasks.length > 1 ? ` Despues: ${tasks.slice(1, 3).map(t => t.title).join('; ')}.` : ''}`;
            restrictedGuard.assertNotRestricted('actions (today tasks)', JSON.stringify(out));
            return out;
        },
    },
    {
        // The brief's [OPEN] button, said out loud. It opens the plan ALREADY ON
        // DISK — never a second headless job, which would spend another Claude
        // and could come back with a different plan than the one he just heard.
        name: 'open_morning',
        says: 'abrir las sesiones que propuso el resumen de la maniana',
        confirmSays: () => {
            const { left } = plannedNow();
            return left.length === 1
                ? `abrir la sesion que te propuso el resumen: ${left[0].session}`
                : `abrir las ${left.length} sesiones del plan de la maniana: ${left.map(p => p.session).join(', ')}`;
        },
        // Nothing left to open is nothing to offer (Tesla review #4): on 2026-10-06
        // the morning call asked "abrir las 0 sesiones del plan de la maniana: ?".
        offerable: () => plannedNow().left.length > 0 || 'no queda ninguna sesion del plan por abrir',
        args: {},
        readOnly: false,
        verify: { fn: 'lib/morningRoutine.js:startOpen' },
        run: () => {
            const { left } = plannedNow();
            if (!left.length) { const e = new Error('las del plan ya estan abiertas'); e.soft = true; throw e; }
            const r = deps.morningRoutine.startOpen({ only: left.map(p => p.session) });
            if (!r || !r.ok) { const e = new Error(r && r.error ? r.error : 'no pude arrancar el plan'); e.soft = true; throw e; }
            // Each session takes about a minute to come up, so this says what is
            // happening rather than pretending it already happened — and it says
            // it without a model.
            return {
                opening: left.map(p => p.session),
                say: `Dale, abro ${left.length === 1 ? 'la sesion' : `las ${left.length}`}: ${left.map(p => p.session).join(', ')}. Tardan un minuto cada una.`,
            };
        },
    },
    {
        name: 'gpu_free',
        says: 'decir cuanta memoria libre tiene la placa de video',
        args: {},
        readOnly: true,
        verify: { fn: 'lib/studio/gpu.js:sample' },
        run: async () => {
            const g = await deps.gpu.sample();
            if (!g || !g.available) return { available: false, plain: 'No puedo leer la placa ahora.' };
            const free = (g.memTotal || 0) - (g.memUsed || 0);
            return {
                available: true, freeMiB: free, totalMiB: g.memTotal || 0,
                plain: `La placa tiene ${(free / 1024).toFixed(1).replace('.', ',')} giga libres.`,
            };
        },
    },
];

// One catalogue from here on. Everything downstream — the gate, the
// confirmation, the manifest the model is shown, the verb table, the checks —
// treats a button in the page exactly like a button in the server, because the
// only thing that differs is what run() does with it.
CATALOG.push(...ui.CATALOG);

const byName = new Map(CATALOG.map(a => [a.name, a]));

// What the model is shown. Names, plain descriptions, argument names — and
// NOTHING else: no code, no routes, no internals it could try to address.
function manifest() {
    // Each list ONCE per manifest (Tesla review #6, 2026-10-09): it was asked
    // per argument - 19 tmux calls and 4 registry scans, all on the server's one
    // thread - and TSRCT froze 2-3.5 s whenever Tesla opened or answered.
    let projects = null, sessions = null;
    const projectList = () => (projects = projects || projectNames());
    const sessionList = () => (sessions = sessions || sessionNames());
    return CATALOG.map(a => ({
        name: a.name,
        says: a.says,
        args: Object.keys(a.args),
        confirm: !a.readOnly,
        // The real names an argument can take, so the router copies one instead
        // of inventing one. Names only, and never an SecretCo one. ALL of them: a cap
        // of 40 on an alphabetical list of 47 hid "tsrct" (2026-09-24, Tesla said
        // TSRCT was not a project). Short names; the whole list is ~400 tokens.
        choices: Object.fromEntries(Object.entries(a.args)
            .map(([k, t]) => [k, t.startsWith('place') ? [...new Set([...projectList(), ...sessionList()])].slice(0, CHOICES_MAX)
                : t.startsWith('project') ? projectList().slice(0, CHOICES_MAX)
                    : /^(session|manySessions)/.test(t) ? sessionList().slice(0, 20)
                        : ui.WORDS[t.replace(/\?$/, '')] ? ui.options(t.replace(/\?$/, '')) : null])
            .filter(([, v]) => v && v.length)),
    }));
}

// Which arguments of an action name a SESSION, whose list changes while a Haiku
// brain lives (Tesla review #3): its catalogue is written once and must not
// freeze them. Kept out of manifest() so the model-facing shape stays as it is.
function liveArgs(name) {
    const a = byName.get(name);
    if (!a) return [];
    return Object.entries(a.args)
        .filter(([, t]) => /^(session|manySessions|place)/.test(t))
        .map(([k, t]) => [k, t.startsWith('place') ? 'place' : 'session']);
}

// How to ask him for an argument he did not give, by type.
const ASK_FOR = {
    session: 'En cual sesion?',
    project: 'De que proyecto?',
    sessions: 'Cual sesion? Pueden ser varias.',
    projects: 'De que proyecto? Pueden ser varios.',
    setup: 'Si. Cual de los que guardaste?',
    place: 'De que proyecto o de que sesion?',
    text: 'Que le digo?',
};

// ── the gate ────────────────────────────────────────────────────────────────
// Everything a model produces arrives here and is treated as a guess.
function validate(name, rawArgs) {
    const action = byName.get(String(name || '').trim());
    if (!action) throw new Error(`no existe una accion llamada "${name}"`);
    const args = {};
    for (const [key, type] of Object.entries(action.args)) {
        const optional = type.endsWith('?');
        const t = optional ? type.slice(0, -1) : type;
        const given = rawArgs ? rawArgs[key] : undefined;
        if (given === undefined || given === null || given === '') {
            if (optional) continue;
            // A missing argument is a QUESTION, not an error: the caller asks him
            // for it out loud. The internal names never reach his ears.
            // An action may word its own question: ASK_FOR is per TYPE, and
            // "que le digo?" is the wrong question when the missing text is a
            // NAME for a setup.
            const e = new Error((action.asks && action.asks[key]) || ASK_FOR[t] || 'me falta un dato para eso');
            // What he DID give travels with the question, still unvalidated: it
            // goes back through this gate when the answer arrives.
            const given = {};
            for (const k of Object.keys(action.args)) if (rawArgs && rawArgs[k] != null && rawArgs[k] !== '') given[k] = rawArgs[k];
            e.missing = { action: action.name, key, args: given };
            throw e;
        }
        if (!TYPES[t]) throw new Error(`tipo desconocido ${t}`);
        try { args[key] = TYPES[t](given); } catch (e) {
            // Heard something, matched nothing: the same question-and-answer
            // round as a missing argument, so his next sentence is the answer.
            if (e.askAgain) {
                const rest = {};
                for (const k of Object.keys(action.args)) if (k !== key && rawArgs && rawArgs[k] != null && rawArgs[k] !== '') rest[k] = rawArgs[k];
                e.missing = { action: action.name, key, args: rest };
            }
            throw e;
        }
    }
    // Anything it sent that the action does not take is dropped, not obeyed.
    return { action, args };
}

async function run(name, rawArgs, { confirmed } = {}) {
    const { action, args } = validate(name, rawArgs);
    if (!action.readOnly && !confirmed && !(typeof action.skipConfirm === 'function' && action.skipConfirm(args))) {
        // The question he is asked names the real arguments, not the capability.
        const says = action.confirmSays ? action.confirmSays(args) : action.says;
        return { ok: false, needsConfirm: true, action: action.name, args, says };
    }
    // Everything above is written to be SAID: a refusal from the gate is a
    // sentence for a person. A crash inside run() is not — it reached him once
    // as "'exists' no es una funcion", read out loud by the voice.
    let value;
    // `soft` is a refusal written for a person — "no tengo TSRCT abierto
    // adelante". Only a real crash gets softened into "se rompio algo".
    try { value = await action.run(args); } catch (e) { if (!e.soft) e.internal = true; throw e; }
    return { ok: true, action: action.name, args, value };
}

// The actions whose own `plain` is what she says, word for word (Tesla review
// #10). Every action used to be re-told by a second model call (haiku.report),
// which turned "voy" into "Le pase el pedido a Sonnet, que mira la pantalla y no
// toca nada. Te digo en un momento" - 9 s of audio, ~1.8 s more wait. A list or
// a status (today's tasks, the sessions) still goes through the brain.
const SPEAKS_PLAIN = new Set(['media', 'open_app', 'open_file', 'move_file', 'session_files',
    'arrange_window', 'solo_window', 'arrange', 'save_layout', 'list_layouts', 'delete_layout', 'set_zones', 'press_shortcut',
    'pc_routine', 'windows_settings', 'spotify_search', 'play_music', 'music_react', 'music_teach', 'list_windows', 'lock_pc', 'look_at_screen', 'do_on_pc', 'browser_task', 'look_into', 'workaround', 'day_status', 'store_messages', 'draft_reply']);
function speaksPlain(name) { return SPEAKS_PLAIN.has(String(name || '')); }

// What a permission card or dialog in that session is asking, or '' (for
// lib/teslaHands.js: a worker stuck on a permission must say so).
function permissionWaiting(session) {
    try {
        const cards = deps.permissionDesk ? deps.permissionDesk.pending([session]) : [];
        if (cards.length) return deps.permissionDesk.describe(cards[0]) || 'un permiso';
    } catch { /* no desk */ }
    const d = permissionDialog(session);
    return d ? (d.what || 'un permiso') : '';
}

module.exports = { configure, manifest, liveArgs, validate, run, hear, CATALOG, TYPES, speaksPlain, permissionWaiting, _permissionDialog: permissionDialog };
