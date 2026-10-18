// ─────────────────────────────────────────────────────────────────────────
// lib/understand.js — THE BRAIN IN CODE. What he said, decided without a model.
//
// Until now one 7B call decided what a sentence meant. Three things were wrong
// with that, and only the first one is obvious:
//
//   1. IT IS SLOW. 2s warm, 130s cold — on a sentence like "pasame a tareas".
//   2. IT IS THE PART THAT INVENTS. Everything after it is validated; it is the
//      only step whose output is a guess.
//   3. IT GETS WORSE AS THE CATALOGUE GROWS. At EIGHT actions it read "cual es
//      el estado actual del proyecto" and reached for the one action with the
//      word "proyecto" in its description — the one that opens sessions. At a
//      hundred and twenty it would be guessing most of the time.
//
// So the order is inverted. A verb table and the name matcher decide first, in
// microseconds and with no GPU; the model is the FALLBACK, for the sentences
// this file is not sure about. Leon's own framing, and the whole point:
// **the model is the mouth, not the brain.**
//
// Nothing here executes anything. It produces {name, args} — the same shape the
// router produced — and lib/actions.js validates it exactly as before. An
// invented action name still cannot exist, because the name comes from a table
// that check-talk.js compares against the catalogue on every `npm run check`.
//
// The tests are the point of this file as much as the code: scripts/check-talk.js
// holds the sentences HE ACTUALLY SAID, with the action each one has to produce.
// A new mistake becomes a fixture, and then it cannot come back.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

// Accents are not optional on a phone recognizer: the same sentence comes back
// "abrí"/"abri"/"Abrí" on three consecutive tries. Everything here works on the
// flattened form, and never on the raw one.
function flat(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Words that carry no decision. Kept small on purpose: a filler list that eats
// real words ("nueva" in "sesion nueva" is filler, "personal" is a project) is
// worse than no filler list at all.
// "y" is NOT in here: it is the separator in "personal y probill", and
// dropping it turned two projects into one name that matches nothing.
const FILLER = new Set(('el la los las lo un una unos unas de del al a en que se es son por para con '
    + 'me mi mis te tu su sus nos les le les hay ahi aca alla eso esto esa ese estos estas esos esas '
    + 'porfa favor porfavor dale bro loco che capo gracias ahora ya despues tambien igual'
    + ' sesion sesiones claude proyecto proyectos carpeta pantalla cosa cosas'
    // "contame como viene todo" is a question about everything, not about a
    // project called "todo" — which is what it was heard as.
    + ' todo todos toda todas').split(' '));

// ── he is talking ABOUT it, not TO it ───────────────────────────────────────
// "contame" is a question for the assistant; "contale" is an order to type into
// a session. One letter apart, opposite consequences — and one of them writes
// into a live Claude. They are separated HERE, deterministically, never by a
// model reading the tone of a sentence.
const TO_ME = /\b(contame|decime|deci me|mostrame|leeme|explicame|pasame el|dame|fijate|mira|revisa|checkea)\b/;
const TO_IT = /\b(contale|decile|dile|mandale|manda le|escribile|pedile|avisale|preguntale|pasale|tipeale|respondele)\b/;

// ── deixis ──────────────────────────────────────────────────────────────────
// "esa", "ahi", "la misma", "la que estas mirando". He almost never says the
// name twice in a row; the second sentence points at the first one. One slot of
// memory answers nearly all of it, and a wrong guess here is a session closed by
// mistake — so an unresolved pronoun is an ASK, never a default.
const THIS_ONE = /\b(esa|ese|eso|esta|este|esto|ahi|aca|la misma|el mismo|la de ahi|esa misma|la que estas mirando|la que mirabas|donde estas)\b/;
const AGAIN = /\b(de nuevo|otra vez|lo mismo|igual que antes|como antes|repetilo|repeti)\b/;
// More than one session in one sentence: a number, or a list.
const MANY = /\b(dos|tres|cuatro|cinco|[2-9]|y|e|mas|otra en|otro en)\b/;

// ── the verb table ──────────────────────────────────────────────────────────
// One row per action. `re` is what the ACT sounds like in his Spanish (voseo,
// imperative, infinitive, and the Spain forms his phone sometimes produces);
// `take` pulls the arguments out of the rest of the sentence and does NOT
// validate them — lib/actions.js owns that, and it is the thing that can say no.
//
// Ordering matters only for the leftmost match: a sentence with two verbs is
// decided by the first one he said.
// The ROOMS and TABS, needed here because "abri" means two different things
// depending on what comes after it: "abri una sesion en tsrct" opens a Claude,
// "abri el escritorio remoto" opens a screen. The word decides, not the verb.
const ROOM_WORD = /\b(escritorio|remoto|windows|la pc|runners?|salesforce|sf|orgs?)\b/;

// Every spoken name of an automation, from the catalogue itself, so the verb row
// and the resolver can never disagree about what counts as one.
const AUTOMATION_WORD = require('./automations').SPOKEN.map(([, re]) => re.source.replace(/^\\b\(|\)\\b$/g, '')).join('|');

const ORDERS = [
    // ── the buttons in the page (lib/uiActions.js) ──────────────────────────
    // First, because several of them share a stem with the session verbs and
    // they are the more specific reading: "pasame a tareas" is a tab, while
    // "pasale a harbor que..." types into a session.
    {
        action: 'go_tab',
        re: /\b(pasame a|and[aá] a|llevame a|mostrame la (pantalla|solapa|pestania) de|abri la solapa|cambia a|poneme en|ir a)\b/,
        take: (rest) => ({ tab: rest.trim() }),
    },
    {
        action: 'open_room',
        // an opening verb AND the name of a screen: "abrime el escritorio"
        re: new RegExp(`\\b(abr\\w*|and[aá] a|mostrame|llevame a|meteme en|poneme)\\b[^.]{0,20}?${ROOM_WORD.source}`),
        take: (rest, w, said) => ({ room: said }),
    },
    {
        // "apaga syften", "prende lo de amazon", "pausa la rutina". Only when a
        // known automation is named near the verb: a bare "apaga" is not this.
        action: 'set_automation', writes: true,
        re: new RegExp(`\\b(apag\\w*|prend\\w*|encend\\w*|desactiv\\w*|activ\\w*|pausa\\w*|reanuda\\w*)\\b(?=[^.]{0,40}?(${AUTOMATION_WORD}))`),
        take: (rest, w, said) => ({ automation: rest.trim(), on: !/^(apag|desactiv|paus)/.test(said) }),
    },
    {
        action: 'approve_permission', writes: true,
        re: /\b(aproba\w*|acepta\w*|dale permiso|autoriza\w*|permitile|dale para adelante)\b/,
        take: () => ({}),
    },
    {
        action: 'deny_permission', writes: true,
        re: /\b(recha[sz]a\w*|negale|no le des permiso|denega\w*)\b/,
        take: () => ({}),
    },
    {
        action: 'stop_session',
        // "frena" lives here and NOT in close_session: nine times out of ten he
        // means stop what it is doing, not kill the session.
        re: /\b(fren[aá]\w*|par[aá]la|par[aá] eso|stop|mandale escape|escape|cancela eso|corta eso|basta)\b/,
        take: () => ({}),
    },
    {
        action: 'slash_command', writes: true,
        re: /\b(compact\w*|comprimi\w*|limpia\w* el contexto|hacele un clear|clear)\b/,
        take: (rest, w, said) => ({ cmd: said }),
    },
    {
        action: 'show_brief',
        re: /\b(abri(me)? el resumen|mostrame el resumen|abri el brief|mostrame el brief)\b/,
        take: () => ({}),
    },
    // The rest of the page, in the words he would actually use. Cheap rows: a
    // phrase and an action, no arguments to get wrong.
    { action: 'close_room', re: /\b(cerra (la|esta) pantalla|volve a la terminal|sali de (aca|ahi|esta pantalla)|cerra el remoto|cerra esa pantalla)\b/, take: () => ({}) },
    { action: 'scroll_bottom', re: /\b(baja del todo|anda al final|mostrame lo ultimo|scrollea|baja hasta abajo)\b/, take: () => ({}) },
    { action: 'focus_mode', re: /\b(modo foco|el foco|foco)\b/, take: () => ({}) },
    { action: 'mute_voices', re: /\b(silencia (las voces|todo)|apaga las voces|no me avises mas|mute)\b/, take: () => ({}) },
    { action: 'eye_protect', re: /\b(filtro de luz|luz azul|modo noche|proteccion de ojos)\b/, take: () => ({}) },
    { action: 'font_size', re: /\b(letra (mas )?(grande|chica)|agranda\w* la letra|achica\w* la letra|mas grande la letra)\b/, take: (rest, w, said) => ({ size: said }) },
    { action: 'sessions_panel', re: /\b(mostrame las sesiones|la lista de sesiones|abri la lista|elegir sesion)\b/, take: () => ({}) },
    { action: 'new_session_dialog', re: /\b(el cuadro de sesion|una sesion a mano|crear una sesion a mano)\b/, take: () => ({}) },
    { action: 'restart_dialog', re: /\b(reinicia\w* (el server|el servidor|tsrct)|reiniciar el server)\b/, take: () => ({}) },
    {
        // "decile que si" — the canned answer, not a sentence to type. Before
        // say_to_session, which would type the word "si" into the pane.
        action: 'quick_answer', writes: true,
        re: /\b((decile|contestale|respondele|dale) que (si|no)|saltealo|salteala|skipealo)\b/,
        take: (rest, w, said) => ({ answer: said }),
    },
    {
        action: 'show_session',
        re: /\b(poneme|pone|mostrame) (en pantalla )?(la sesion|a)\b/,
        take: (rest, w) => ({ session: objectOf(rest.replace(/en pantalla/g, ''), w, 'session') }),
    },
    // ── the morning call ────────────────────────────────────────────────────
    // What he says with the phone still at his ear, after the brief has been
    // read to him. Before open_session, which would hear "abri las que dijiste"
    // as a project called "las que dijiste".
    {
        action: 'open_morning', writes: true,
        re: /\b(abri (las|los)? ?que (dijiste|propusiste|dijo)|abri el plan|dale con el plan|arranca (con )?el plan|abri las de la maniana|abri las sesiones del resumen|abrilas todas)\b/,
        take: () => ({}),
    },
    // ── setups: the board he arranges every morning, said once ──────────────
    {
        action: 'run_setup', writes: true,
        re: /\b(arma\w*|prepara\w*|monta\w*|levantame|dejame)\b[^.]{0,24}?\b(setup|board|tablero|ambiente)\b/,
        take: (rest) => ({ setup: rest.replace(/^(de|del|la|el|mi|para)\s+/, '').trim() }),
    },
    {
        action: 'save_setup', writes: true,
        re: /\b(guarda\w*|salva\w*|anota\w*)\b[^.]{0,20}?\bcomo\b/,
        take: (rest) => ({
            name: rest.trim().replace(/^(mi|el|la)\s+/, '').replace(/^setup\s+(de\s+(la|el)\s+)?/, '').trim(),
        }),
    },
    {
        // "decile a las dos que corran los tests" — one prompt, several panes.
        // Before say_to_session, which would take "las" as the session name.
        action: 'say_to_sessions', writes: true,
        re: new RegExp(`${TO_IT.source}\\s+a\\s+(?:(las?|los?)\\s+)?(dos|tres|cuatro|todas|todos)\\b`),
        take: (rest, w, said) => {
            const who = /(?:(las?|los?)\s+)?(dos|tres|cuatro|todas|todos)\s*$/.exec(said.trim());
            return {
                session: who ? [who[1], who[2]].filter(Boolean).join(' ') : 'todas',
                text: rest.trim().replace(/^que\s+/, '').trim(),
            };
        },
    },
    // ── the sessions themselves ─────────────────────────────────────────────
    {
        action: 'close_session', writes: true,
        // Before open_session: "cerra la que abriste" contains both.
        re: /\b(cerr\w*|cierra\w*|cerrame|mat\w*|kill|bajam?e?|baja|apag\w*|termina\w*|termine)\b/,
        take: (rest, w) => ({ session: objectOf(rest, w, 'session') }),
    },
    {
        action: 'open_session', writes: true,
        re: /\b(abr\w*|abrime|abrirme|cre\w*|crea\w*|creame|levant\w*|arranc\w*|larg\w*|prend\w*|inicia\w*|empez\w*)\b/,
        // Several at once travels WHOLE: objectOf() keeps only what follows the
        // first "en", so "cuatro sesiones en personal" lost the four and opened
        // one, and "tsrct, harbor y probill" became one name. The counting and
        // the splitting happen in lib/actions.js, against the real project list.
        take: (rest, w) => (MANY.test(flat(rest))
            ? { project: flat(rest) }
            : { project: objectOf(rest, w, 'project') }),
    },
    {
        action: 'say_to_session', writes: true,
        re: TO_IT,
        take: (rest, w) => sayArgs(rest, w),
    },
    {
        action: 'read_session',
        // "mira que hay en harbor", "fijate la pantalla de tsrct"
        re: /\b(mira\w*|fijate|revisa\w*|checkea\w*|leeme|mostrame|pasame)\b/,
        take: (rest, w) => ({ session: objectOf(rest, w, 'session') || (w && w.here) || '' }),
    },
];

// ── questions ───────────────────────────────────────────────────────────────
// A question is not an order, and the ones he asks are a short list. Answering
// them from a table is not a shortcut: it is the difference between the right
// answer in 200 milliseconds and a coin flip in two seconds.
const ASKS = [
    {
        action: 'project_status',
        re: /\b(como (va|viene|anda|vamos)|como esta|en que (anda|esta)|que onda|estado (actual )?(de|del)|como quedo|donde (quedo|quedamos)|que paso con)\b/,
        take: (rest, w) => ({ project: objectOf(rest, w, 'place') }),
        generic: true,
    },
    {
        action: 'list_sessions',
        re: /\b(que sesiones|cuales sesiones|cuantas sesiones|que tengo abierto|que hay abierto|que esta abierto|listame las sesiones|que corre ahora)\b/,
        take: () => ({}),
    },
    {
        action: 'read_session',
        re: /\b(que (esta|estas) haciendo|que hace|que hizo|que hiciste|que dice|que hay en|que paso|en que esta|termino|ya termino|sigue trabajando)\b/,
        // Read-only, so a question with no name in it is about the screen he is
        // looking at. The ones that CHANGE something never fill their own blanks.
        take: (rest, w) => ({ session: objectOf(rest, w, 'session') || (w && w.here) || '' }),
        generic: true,
    },
    {
        // Before today_tasks: "como andan las tareas automaticas" is this one.
        action: 'automations_status',
        re: /\b(automatizaciones|automations|tareas automaticas|lo que corre solo|que esta fallando|que fallo)\b/,
        take: () => ({}),
    },
    {
        // "cual es la lista de tareas para hoy", "que es lo proximo que deberia
        // hacer". With no row of its own this fell to the model, which picked the
        // project question and asked "which project?" - and then read every next
        // sentence as the answer to it (2026-09-21).
        // "pasame a tareas" still goes to the tab: that verb comes first.
        action: 'today_tasks',
        re: /\b(tareas|pendientes|que (tengo|hay) que hacer|que (deberia|debo|tendria que|tengo que) (hacer|completar|terminar)|lo proximo|que sigue|que hago (ahora|hoy)|prioridades|por donde (empiezo|arranco))\b/,
        take: () => ({}),
    },
    {
        action: 'read_brief',
        re: /\b(resumen|brief|briefing|que decia lo de la maniana|que dijo el resumen)\b/,
        take: () => ({}),
    },
    {
        action: 'gpu_free',
        re: /\b(placa|gpu|vram|grafica|memoria de la placa|cuanta memoria)\b/,
        take: () => ({}),
    },
];

// "como esta la gpu" is both "como esta <algo>" and "la gpu". The generic
// question is the one that happens to start earlier in the sentence, and
// leftmost-wins would answer about a project called "la gpu". A question that
// names a SPECIFIC thing beats a question about anything.
const GENERIC = new Set(ASKS.filter(a => a.generic).map(a => a.action));

// ── pulling the object out of the rest of the sentence ──────────────────────
// It is handed on RAW. Everything that decides whether a name is real happens in
// lib/actions.js against the live lists — this only decides which WORDS he meant
// as the name, never whether they name anything.
// The phrases lib/actions.js reads BY ITSELF — "las dos que abriste", "esas",
// "cualquiera". Taking the articles off them turns "las dos que abriste" into
// something its own matcher no longer recognises, so they travel whole.
const KEEP_RAW = /\b(que abriste|que acabas de abrir|las? (dos|tres|cuatro)|los? (dos|tres)|esas|esos|las mismas|los mismos|recien abiertas?|cualquier|elegi vos|da igual|el que quieras|la que quieras)\b/;

function objectOf(rest, world, kind) {
    const r = flat(rest);
    // "en tsrct", "a harbor", "de probill", "la sesion de trudy" — the name is
    // what comes after the preposition, if there is one.
    const after = /\b(?:en|a|de|del|con|sobre|para)\s+(.+)$/.exec(r);
    const body = (after ? after[1] : r).trim();
    if (KEEP_RAW.test(body)) return body;
    // "abrime una sesion nueva en X" leaves the counting words in front
    const head = body.replace(/^(una|un|la|el|las|los|dos|tres|cuatro|otra|otro|nueva|nuevo|nuevas|nuevos)\s+/, '');
    const said = head.split(' ').filter(t => t && !FILLER.has(t)).join(' ').trim();
    if (said) return said;
    // Nothing but filler left. A PRONOUN points at something; silence does not.
    // "cerra esa" is the session on screen; "abrime una sesion" is a question for
    // him, and answering it from memory is how the wrong project gets opened.
    if (THIS_ONE.test(r) || AGAIN.test(r)) {
        const last = (world && world.last) || {};
        if (kind === 'project') return last.project || '';
        if (kind === 'place') return (world && world.here) || last.session || last.project || '';
        return (world && world.here) || last.session || '';
    }
    return '';
}

// ── "decile a harbor que corra los tests" ─────────────────────────────────────
// The one that types into a live session, so it is the one that has to be read
// exactly right: WHO, and WHAT. Three shapes cover how he says it, and anything
// else comes back with the text and no session — which asks him which session,
// rather than picking one.
function sayArgs(rest, world) {
    const r = flat(rest);
    // "a harbor que corra los tests" | "a harbor: corra los tests"
    let m = /^(?:a|al|para)\s+([a-z0-9._@-]+)\s+(?:que\s+)?(.+)$/.exec(r);
    if (m) return { session: m[1], text: m[2].trim() };
    // "que corra los tests" with a session already on screen
    m = /^que\s+(.+)$/.exec(r);
    if (m) return { session: (world && world.here) || '', text: m[1].trim() };
    // "a esa que pare"
    if (THIS_ONE.test(r)) {
        const t = r.replace(THIS_ONE, ' ').replace(/^(a|al|para)\s+/, '').replace(/^que\s+/, '').trim();
        return { session: (world && world.here) || (world && world.last && world.last.session) || '', text: t };
    }
    return { session: (world && world.here) || '', text: r };
}

// A verb with a "no" in front of it is not an order. "no abras nada todavia"
// used to be an instruction to open something.
// Five words back, not three: "ni se te ocurra cerrar esa sesion" is four words
// between the negation and the verb, and it closed the session.
function negated(flatText, at) {
    const before = flatText.slice(0, at).trim().split(' ').slice(-5);
    return ['no', 'ni', 'nunca', 'jamas', 'tampoco'].some(n => before.includes(n));
}

// ── the parse ───────────────────────────────────────────────────────────────
// -> { name, args, sure, why } | null
//
// `sure` is the whole contract with the caller. Sure means: act on this, do not
// wake the model. Not sure means: this is a guess worth showing the model beside
// its own. Missing arguments do NOT make it unsure — an action with a hole in it
// becomes a question for him ("de que proyecto?"), which is a better answer than
// anything a 7B would have produced, and costs nothing.
// ── his PC, not his sessions (2026-10-10) ───────────────────────────────────
// Tesla can look at and use his Windows desktop (look_at_screen, do_on_pc), and
// he talks about it the way he talks about anything: "abrime el excel de
// ventas", "cerra spotify", "escribile a paul por whatsapp". The verb table was
// built for sessions, so those became open_session "ventas", close_session
// "spotify" and a message typed into a session called "paul". A sentence about
// a thing on the PC that names none of his sessions or projects is not the
// table's: a plain look goes to look_at_screen, anything else to the brain,
// which has the context (and do_on_pc asks him once anyway).
// An app or a file is the PC even when one of his projects is named in the same
// breath ("abri el proyecto de harbor en vs code"); a place word (carpeta,
// pantalla...) is only the PC when it names none of his work, because "la
// carpeta de harbor" and "la pantalla de tsrct" are how he names a project and a session.
const PC_APP = /\b(excel|word|power ?point|pdf|chrome|navegador|browser|edge|firefox|pagina|web|sitio|link|whats ?app|spotify|outlook|gmail|mail|mails|correo|email|vs ?code|visual studio|notepad|bloc de notas|explorador|archivo|archivos|documento|pestana|formulario|boton|clic|click|descargas|volumen|mouse|teclado|programa)\b/;
const PC_PLACE = /\b(carpeta|ventana|ventanas|pantalla|monitor|escritorio|pc|compu|computadora)\b/;
const PC_LOOK = /\b(que (dice|dicen|hay|ves|tengo|se ve|aparece|muestra)|mira(me)?|fijate|lee(me)?|decime que)\b/;
const LOOK_AT = /\b(pantalla|monitor|escritorio|pc|compu|computadora|ventana|ese mail|este mail|ese documento|este documento|esa pagina|esta pagina|ese archivo|este archivo|ese error|este error)\b/;
const MONITOR_N = /\bmonitor (1|2|3|uno|dos|tres)\b/;
const SESSION_WORD = /\bsesion(es)?\b|\bterminal\b|\bpanel\b|\bescritorio remoto\b/;   // the remote desktop is a TSRCT room
function namesHisWork(t, w) {
    const names = [...(w.sessions || []), ...(w.projects || [])].map(n => flat(n)).filter(Boolean);
    const tokens = new Set(t.split(/[^a-z0-9]+/));
    return names.some(n => tokens.has(n) || n.split(/[^a-z0-9]+/).some(p => p.length >= 4 && tokens.has(p)));
}
// "abri spotify", "traeme el chrome": one known program and nothing else. Code,
// not the brain: ~0 ms instead of ~3.5 s, and open_app asks nothing (it only
// opens or brings forward). Anything longer ("abrime el excel DE VENTAS") is a
// file or a task, and goes to the brain.
const APP_NAMES = 'spotify|chrome|excel|word|powerpoint|outlook|whatsapp|slack|notepad|bloc de notas|explorador|edge|firefox|vs ?code|visual studio code|teams|zoom|discord|calculadora|paint|obsidian|clickup';
const OPEN_APP = new RegExp(`^(?:dale |che |tesla )?(?:abri|abrime|abrir|abre|traeme|trae|pone|poneme|mostrame)(?: el| la| mi)? (${APP_NAMES})(?: por favor)?$`);
// ── windows, modes, shortcuts (2026-10-11, TESLA-PC-PATHS.md) ──
// The sentences he says most, routed in code: "spotify a la derecha", "pasa el
// chrome al otro monitor", "modo trabajo", "mostrame el escritorio", "abri la
// configuracion de sonido", "busca bad bunny en spotify". Anything else about
// windows still reaches the brain, which has the same actions.
const MOVE_VERB = /^(?:dale |che |tesla )?(?:pone|poneme|pon|ponela|ponelo|move|movela|movelo|mueve|lleva|llevame|llevala|llevalo|manda|mandala|mandalo|pasa|pasame|pasala|pasalo|tira|acomoda|acomodame|maximiza|maximizame|minimiza|minimizame|agranda|centra|centrame)\b/;
const WIN_APP = new RegExp(`\\b(${APP_NAMES}|notepad|bloc de notas|word|powerpoint|teams|tsrct)\\b`);
const MODE = /^(?:dale |che |tesla )?(?:modo|arma(?:me)?(?: el| la)?(?: modo| setup)?|poneme el (?:modo|setup)(?: de)?|activa el modo|pasame a(?:l)? modo)\s+(?:de\s+)?([a-z0-9 ]{2,30}?)(?: por favor)?$/;
// "guarda ESTO como X" is TSRCT's save_setup (a board of sessions); saving the
// PC's windows has to say so: las ventanas, la pantalla, como esta la PC.
const SAVE_MODE = /^(?:dale |che |tesla )?guarda(?:me)? (?:las ventanas|la pantalla|como estan las ventanas|como esta la pantalla|como esta la pc|esta disposicion de ventanas|las ventanas como estan)(?: ahora)? como ([a-z0-9 ]{2,30}?)(?: por favor)?$/;
const SETTINGS_ASK = /^(?:dale |che |tesla )?(?:abri|abrime|abre|anda a|llevame a|mostrame)(?: la| el)? (?:configuracion|ajustes|config)(?: de| del)?(?: la| el| los| las)? ?([a-z ]{0,30})$/;
const SPOTIFY_SEARCH = /^(?:dale |che |tesla )?busca(?:me)? (.{2,60}?) en spotify$/;
// Music that PLAYS (2026-10-14): "me pones un poco de sade en spotify", "poneme algo
// de lo-fi", "poneme musica". Only "en spotify" or a music word makes it music, so
// "pone spotify a la derecha" stays a window move. A long mood ("algo que me ayude a
// concentrarme en el trabajo") goes to the brain, which turns it into a search.
const PLAY_VERB = /^(?:dale |che |tesla |hola tesla )?(?:me |nos )?(?:pone|pones|poneme|ponme|pon|ponenos|pasame|tirame|reproduci|reproducime|tocame|dale play a|quiero escuchar)\b ?(.*)$/;
const MUSIC_WORD = /\b(?:musica|musiquita|tema|temas|cancion|canciones|playlist|disco|album)\b/;
const PLAY_FILLER = /^(?:algo|alguna|algun|un poco|un poquito|de|del|musica|musiquita|tema|temas|cancion|canciones|playlist|para mi|ahora)\b ?/;
// A moment is music too (lib/tasteBrain.js picks for it): "poneme algo para correr",
// "poneme algo chill". Only after a play verb, so "voy a correr" is never an order.
const MOMENT_MUSIC = /^(?:algo |un poco de )?(?:para (?:correr|entrenar|trotar|el gym|relajarme|descansar|estar en casa)|chill|tranqui|tranquilo|relajado|suave)\b/;
// What he thinks of what is playing (music_react). Sure only when the sentence
// says it is the music: a bare "me gusta esto" may be about anything on screen.
const ABOUT_PLAYING = /\b(?:este tema|esta cancion|este temazo|lo que suena|lo que esta sonando|esto que suena|esta musica|este artista|esta banda)\b/;
// A bare "no me gusta" a moment after a song started IS about the song (review
// #18: typed 13 s after Alix Perez began, Haiku asked whether he meant the session).
const JUST_PLAYED_MS = 3 * 60000;
function musicReaction(t, w) {
    const s = t.replace(/^(?:dale |che |tesla |hola tesla )/, '');
    const m = /^(no )?me (?:gusta|encanta|copa|cabe)\b(.*)$/.exec(s) || /^(?:este tema|esta cancion|esto que suena|lo que suena) (no )?me (?:gusta|encanta|copa)\b(.*)$/.exec(s);
    const at = w && w.last && w.last.musicAt;
    const justPlayed = at && Date.now() - at < JUST_PLAYED_MS && s.split(' ').length <= 8;
    if (!m || !(ABOUT_PLAYING.test(s) || justPlayed)) return null;
    const reason = String(m[2] || '').replace(ABOUT_PLAYING, ' ').replace(/^[\s,]*(?:porque|por|que)?\s*/, '').replace(/\s+/g, ' ').trim();
    return { liked: m[1] ? 'no' : 'si', ...(reason ? { reason } : {}) };
}
function playMusicQuery(t) {
    // "sorprendeme con algo en spotify" (review #16): the verb IS the surprise.
    // Only with music or Spotify in the sentence - a bare "sorprendeme" is not an order.
    if (/^(?:dale |che |tesla )?sorprendeme\b/.test(t) && (/\bspotify\b/.test(t) || MUSIC_WORD.test(t))) return '';
    const m = PLAY_VERB.exec(t);
    if (!m) return null;
    let rest = m[1];
    const inSpotify = /\ben (?:el )?spotify\b/.test(rest);
    rest = rest.replace(/\ben (?:el )?spotify\b/g, ' ').replace(/\bpor favor\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\bspotify\b/.test(rest)) return null;              // spotify as the OBJECT: a window, an app
    // "poneme algo de eminem" (review #18): five artists went to Haiku today at
    // 12-24 s, one came back "no tengo una herramienta para poner musica". "algo de
    // X" / "un poco de X" after pone/tocame is music when X is short and is not a
    // session, the PC or a plain thing ("pasame algo de info" stays the brain's).
    const someOf = /^(?:pone|pones|poneme|ponme|pon|tirame|tocame)$/.test(m[0].replace(/^(?:dale |che |tesla |hola tesla )?(?:me |nos )?/, '').split(' ')[0])
        && /^(?:algo|un poco|un poquito) de [a-z0-9][a-z0-9 .-]{1,30}$/.test(rest)
        && !SESSION_WORD.test(rest) && !PC_APP.test(rest) && !PC_PLACE.test(rest)
        && !/\b(?:info|informacion|contexto|texto|codigo|eso|esto|aquello|lo que)\b/.test(rest);
    if (!someOf && !inSpotify && !MUSIC_WORD.test(rest) && !MOMENT_MUSIC.test(rest) && !/^(?:reproduci|dale play|quiero escuchar)/.test(t.replace(/^(?:dale |che |tesla |hola tesla )/, ''))) return null;
    let q = rest, prev;
    do { prev = q; q = q.replace(PLAY_FILLER, ''); } while (q !== prev);
    q = q.replace(/\b(?:sorprendeme|lo que quieras|cualquier cosa|lo que sea)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (q.split(' ').length > 4) return null;
    return q;
}
const SOLO = /^(?:dale |che |tesla )?(?:dejame|deja) (?:solo|sola|solamente)(?: el| la)? (.{2,30})$|^(?:dale |che |tesla )?solo(?: el| la)? (.{2,30}) (?:a la vista|adelante)$/;
function pcPaths(t, w) {
    let m;
    if ((m = SAVE_MODE.exec(t))) return { name: 'save_layout', args: { name: m[1] }, sure: true, why: 'guardar la disposicion' };
    if ((m = MODE.exec(t))) {
        let names = w.layouts;
        if (!names) { try { names = require('./deskWindows').arrangeNames(); } catch { names = []; } }
        const k = m[1].trim();
        // "modo foco" is TSRCT's focus mode, whatever he saved.
        if (k !== 'foco' && names.some(n => n === k || n.startsWith(k) || k.startsWith(n))) return { name: 'arrange', args: { name: k }, sure: true, why: `modo ${k}` };
    }
    if ((m = SETTINGS_ASK.exec(t))) return { name: 'windows_settings', args: m[1].trim() ? { page: m[1].trim() } : {}, sure: true, why: 'configuracion de windows' };
    if ((m = SPOTIFY_SEARCH.exec(t))) return { name: 'spotify_search', args: { query: m[1] }, sure: true, why: 'buscar en spotify' };
    const music = playMusicQuery(t);
    if (music !== null) return { name: 'play_music', args: { query: music }, sure: true, why: 'poner musica' };
    const verdict = musicReaction(t, w);
    if (verdict) return { name: 'music_react', args: verdict, sure: true, why: 'que le parece la musica' };
    if ((m = SOLO.exec(t))) return { name: 'solo_window', args: { window: (m[1] || m[2]).trim() }, sure: true, why: 'una sola ventana' };
    // A window, a verb that moves it and a place: arrange_window.
    const app = WIN_APP.exec(t);
    // "pasale a tsrct que ..." is a message, never a window move.
    if (app && MOVE_VERB.test(t) && !/\bque\b/.test(t)) {
        let dw = null;
        try { dw = require('./deskWindows'); } catch { dw = null; }
        const where = dw ? dw.parseWhere(t) : { slot: null, screen: null };
        if (where.slot || where.screen) return { name: 'arrange_window', args: { window: app[1], where: t }, sure: true, why: 'acomodar una ventana' };
    }
    // A named, harmless shortcut said on its own ("mostrame el escritorio").
    if (t.split(' ').length <= 7) {
        let sc = null;
        try { sc = require('./deskShortcuts'); } catch { sc = null; }
        const row = sc && sc.findShortcut(t);
        if (row && row.risk === 'harmless' && row.says.some(p => t.includes(sc._flat(p)))) return { name: 'press_shortcut', args: { name: row.name }, sure: true, why: `atajo ${row.name}` };
    }
    return undefined;
}

function aboutThePc(t, w) {
    const quick = pcPaths(t, w);
    if (quick) return quick;
    const app = OPEN_APP.exec(t);
    if (app) return { name: 'open_app', args: { name: app[1] }, sure: true, why: `dijo "${t}"` };
    if (SESSION_WORD.test(t)) return undefined;
    if (!PC_APP.test(t) && !(PC_PLACE.test(t) && !namesHisWork(t, w))) return undefined;
    if (PC_LOOK.test(t) && LOOK_AT.test(t)) {
        const m = MONITOR_N.exec(t);
        const screen = m ? ({ uno: '1', dos: '2', tres: '3' }[m[1]] || m[1]) : undefined;
        return { name: 'look_at_screen', args: { question: t, ...(screen ? { screen } : {}) }, sure: true, why: 'pregunta por lo que se ve en su PC' };
    }
    return null;   // about the PC, but what to DO is the brain's call
}

function parse(text, world) {
    const t = flat(text);
    if (!t) return null;
    const w = world || {};
    const pc = aboutThePc(t, w);
    if (pc !== undefined) return pc;

    // He is asking IT to tell him something. This has to be settled before the
    // verb table, because "contame que hizo" and "contale que pare" share a stem.
    const toMe = TO_ME.test(t);
    const toIt = TO_IT.test(t);

    let best = null;
    for (const row of ORDERS) {
        const m = row.re.exec(t);
        if (!m) continue;
        if (negated(t, m.index)) continue;
        // The two that must never be confused with each other. "contale" fires
        // the one that types; a sentence aimed at the assistant ("mostrame",
        // "contame") can never reach anything that writes. Reading and looking
        // at his own screen stay available — that IS what he is asking for.
        if (row.action === 'say_to_session' && !toIt) continue;
        if (row.writes && toMe && !toIt) continue;
        if (row.action === 'read_session' && toIt) continue;
        if (!best || m.index < best.at) best = { action: row.action, at: m.index, end: m.index + m[0].length, take: row.take };
    }

    // A question beats a verb when the question mark words came FIRST: "como va
    // tsrct, abrilo si quiere" is a question with an aside, not an order.
    let ask = null;
    for (const row of ASKS) {
        const m = row.re.exec(t);
        if (!m) continue;
        const here = { action: row.action, at: m.index, end: m.index + m[0].length, take: row.take };
        if (!ask) { ask = here; continue; }
        // specific beats generic, wherever it sits in the sentence
        const mineGeneric = GENERIC.has(here.action), theirsGeneric = GENERIC.has(ask.action);
        if (mineGeneric !== theirsGeneric) { if (theirsGeneric) ask = here; continue; }
        if (here.at < ask.at) ask = here;
    }

    // Between a verb and a question: the earlier one wins, EXCEPT that a question
    // naming a specific thing beats a vague reading verb. "leeme el resumen de la
    // maniana" opens with "leeme", which is how you ask to be read a SCREEN — the
    // thing he named is the brief, and that is what decides it.
    let pick;
    if (best && ask) {
        const bestVague = best.action === 'read_session';
        const askSpecific = !GENERIC.has(ask.action);
        pick = (askSpecific && bestVague) ? ask : (ask.at < best.at ? ask : best);
    } else pick = best || ask;
    if (!pick) return null;

    const rest = t.slice(pick.end);
    // `said` is the phrase that matched, because for some actions THAT is the
    // argument: "compactala" is the /compact command, "abri el estudio" names
    // the room inside the verb phrase itself.
    const args = pick.take(rest, w, t.slice(pick.at, pick.end)) || {};
    // An empty string argument is a hole, not a value: drop it so the catalogue
    // asks him for it by name instead of trying to match "".
    for (const k of Object.keys(args)) if (args[k] === '' || args[k] === undefined) delete args[k];
    return { name: pick.action, args, sure: true, why: `dijo "${t.slice(pick.at, pick.end)}"` };
}

// Every action the table can produce. check-talk.js asserts each one is real, so
// a renamed action in the catalogue breaks the build instead of the assistant.
function actionsNamed() {
    return [...new Set([...ORDERS, ...ASKS].map(r => r.action))];
}

// Which rows this file believes will CHANGE something. check-talk.js compares
// the list against the catalogue's own `confirm` flag: if an action stops being
// read-only and nobody updates the verb table, "mostrame" would reach it.
function writingActions() {
    return [...new Set([...ORDERS, ...ASKS].filter(r => r.writes).map(r => r.action))];
}

module.exports = { parse, flat, actionsNamed, writingActions, TO_ME, TO_IT, THIS_ONE };
