'use strict';
// ── teslaHands.js — what Tesla does when it has no button for it ─────────────
//
// WHY (2026-09-25). Leon: "si el asistente no encuentra la manera de hacer lo
// que yo le estoy pidiendo a traves de comandos, que busque la manera de
// hacerlo ... y que venga y me diga que ya lo hizo ... y que lo vaya
// almacenando en un archivo que despues yo te pueda dar a vos". So when Haiku
// understood him and no action in lib/actions.js fits, the job goes to a worker
// and every one of these is written to logs/tesla-workarounds.md: those are the
// buttons Tesla is missing, and whatever repeats there becomes a real action.
//
// WHAT KIND OF SESSION (his choice): an ordinary, VISIBLE, interactive Claude
// session called `hands` - not a headless `claude -p`. Its permission questions
// go through his TSRCT approver like any of his sessions, he can open it and
// stop it, and it never blocks the analyst's one-at-a-time queue (research,
// worklogs, the morning brief). One task at a time; it closes itself after
// IDLE_MS without work. Its answer is read from its transcript (a known
// --session-id), the same way lib/haikuBrain.js reads Tesla's brain.
//
// SAFETY. SecretCo is refused before anything is typed (task text, folder, the
// session it is pointed at) and denied as a permission in the session's own
// settings (the analyst's restrictedDenyRules). Whether he is asked first is decided
// in lib/actions.js: `look_into` (only looks) runs at once, `workaround`
// (changes, sends, deletes, creates) asks once.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const NAME = 'hands';
const IDLE_MS = Number(process.env.HANDS_IDLE_MS || 15 * 60 * 1000);
// 3 hours (was 30 min, review #14): the 40-question AI test ran past 30 minutes,
// the job was dropped as "took more than 30 minutes" while hands went on working,
// she told him "está parada" while he watched it run, and its result was never
// announced. hands is a visible session he can stop himself; the cap is only
// for a worker that truly hangs. Past STILL_WORKING_MS she says so, once.
const TASK_MS = Number(process.env.HANDS_TASK_MS || 3 * 60 * 60 * 1000);
const STILL_WORKING_MS = Number(process.env.HANDS_STILL_WORKING_MS || 30 * 60 * 1000);
// 1 s (was 3): a desk task's answer sat up to 3 s before anyone read it, on top
// of the voice queue (review 2026-10-10: 11 s from her RESULTADO to his ear).
// A poll is a stat and a small read.
const POLL_MS = Number(process.env.HANDS_POLL_MS || 1000);
const MODELS = {
    simple: process.env.HANDS_MODEL_SIMPLE || 'claude-haiku-5-5',
    medium: process.env.HANDS_MODEL_MEDIUM || 'claude-sonnet-5-5',
    complex: process.env.HANDS_MODEL_COMPLEX || 'claude-opus-5-5',
};
const MODEL_NAME = { simple: 'Haiku', medium: 'Sonnet', complex: 'Opus' };

let deps = {
    tmux: null,            // argv tmux
    spawn: null,           // sessionSpawn.createPrimedSession
    paste: null,           // sessionSpawn.pasteIntoPane
    readAnswer: null,      // haikuBrain._readAnswer
    draft: null,           // (text) => puts text in his input box, unsent (draft_reply)
    denyRules: null,       // () => analyst.restrictedDenyRules()
    cwdOf: null,           // (session) => its folder
    projectsRoot: '',
    dataDir: '',           // where the settings file lives
    logFile: '',           // logs/tesla-workarounds.md
    say: null,             // (line) => told to him (orb, or his phone)
    permission: null,      // (session) => what a permission card/dialog asks, or '' (lib/actions.js)
    offer: null,           // (name, args) => talk.propose: the yes/no question, so his "si" runs it
};
function configure(d) { deps = { ...deps, ...(d || {}) }; }

let seq = 0;
const jobs = new Map();    // key -> { task, why, changes, level, model, session, cwd, state, startedAt, finishedAt, result }
let worker = null;
let lastResult = null;     // { goal, said, at }: the newest answer, whole         // { id, model, entry: {id, file, offset}, busy, idleTimer }
let chain = Promise.resolve();

function exists() {
    try { deps.tmux(['has-session', '-t', `=${NAME}`]); return true; } catch { return false; }
}

function instruction(job) {
    return [
        job.recipe
            ? `COMANDO DE TESLA "${job.recipe}" (${job.key}). Leon se lo pidio por voz a su asistente; es un comando declarado, segui la receta de abajo.`
            : `TAREA DE TESLA ${job.key}. Leon se la pidio por voz a su asistente, y el asistente no tiene un comando para esto, asi que la haces vos.`,
        `Lo que quiere: ${job.task}`,
        job.why ? `Por que no habia comando: ${job.why}` : '',
        job.session ? `Estaba mirando la sesion tmux "${job.session}" (carpeta ${job.cwd}).` : '',
        job.changes
            ? 'Ya confirmo que se puede cambiar/crear/mandar lo necesario. Hace SOLO lo que pidio: nada de mas, nada destructivo que no haya pedido explicitamente.'
            : 'SOLO MIRAR: podes leer, buscar y correr comandos que no cambian nada. No edites, no borres, no mandes nada. Si para hacerlo habria que cambiar algo, no lo hagas: decilo en el resultado.',
        // Not by name: this text sits on the session's screen, and the SecretCo
        // screen guard (rightly) refuses any screen that contains the word.
        'NUNCA toques el proyecto restringido de Leon (el que solo corre en AWS Bedrock; sus carpetas ya estan bloqueadas por permiso). Si la tarea es de ese proyecto, no hagas nada y decilo.',
        'No cargues la maquina: nada de pipes largos a grep (es ugrep), lo largo en segundo plano, filtra archivos terminados con python3.',
        'Todo numero, nombre o fecha que le digas tiene que salir TAL CUAL de lo que imprimieron tus comandos o de lo que leiste - nunca de memoria ni estimado. Si no lo verificaste, decilo.',
        'Cuando termines, tu ULTIMO mensaje tiene que terminar con UNA linea exactamente asi (JSON en una linea, en espanol simple, sin jerga):',
        job.detail
            ? 'RESULTADO {"ok": true|false, "dijo": "<lo que pidio, completo pero EXPLICADO: ordenado por tema, con todos los datos que importan, hablandole de tu, unas 6 a 10 frases (palabra por palabra solo si lo pidio textual)>",'
            : 'RESULTADO {"ok": true|false, "dijo": "<UNA frase corta (menos de 15 palabras) para decirle en voz alta: solo el resultado, nada de como lo hiciste ni con que>", "como": "<como lo hiciste: comandos, archivos, pasos>", "falta": "<que comando le faltaria a Tesla para hacer esto directo, o vacio>"}',
    ].filter(Boolean).join('\n');
}

function settingsFile() {
    const f = path.join(deps.dataDir || '/tmp', 'hands-settings.json');
    const deny = typeof deps.denyRules === 'function' ? deps.denyRules() : [];
    // The same Read rules the analyst jobs carry, plus the write side.
    const all = [...deny, ...deny.map(r => r.replace(/^Read\(/, 'Edit('))];
    // look_at_screen / do_on_pc without a permission card per step: the desk
    // command (it carries the SecretCo wall and the mouse-taken stop, lib/desk.js)
    // and reading what it saved. Nothing else. do_on_pc was confirmed once, by
    // name, before the worker got it.
    const root = path.join(__dirname, '..');
    const cli = path.join(root, 'scripts', 'desk.js');
    // `cd` too (Tesla review #11): the worker wrote "cd .../TSRCT && node scripts/desk.js
    // key ..." and a compound command needs every part allowed - it stopped on a
    // permission card for its own keystroke, twice, and the music never played.
    const ops = ['look', 'click', 'double', 'right', 'move', 'scroll', 'type', 'key', 'focus', 'open', 'media',
        // windows, modes, shortcuts (2026-10-11): same single door, same checks
        'windows', 'place', 'solo', 'layout', 'zones', 'shortcut', 'routine', 'settings', 'spotify', 'music'];
    // The relative form too (review #13: "node scripts/desk.js scroll ..." after a cd).
    // browser_task (2026-10-12): the separate browser, its own door (it carries
    // its own SecretCo refusals and never touches his mouse), and its screenshots.
    const proj = path.join(root, 'scripts', 'projector.js');
    const projOps = ['start', 'stop', 'status', 'open', 'look', 'read', 'find', 'click', 'dblclick', 'rightclick',
        'type', 'key', 'drag', 'scroll', 'upload', 'download', 'back', 'reload', 'tabs', 'tab'];
    const allow = [...ops.map(op => `Bash(node ${cli} ${op}:*)`), ...ops.map(op => `Bash(node scripts/desk.js ${op}:*)`),
        ...projOps.map(op => `Bash(node ${proj} ${op}:*)`), ...projOps.map(op => `Bash(node scripts/projector.js ${op}:*)`),
        `Read(/${path.join(os.homedir(), '.config', 'tsrct', 'projector', 'shots')}/**)`,
        'Bash(cd:*)', `Read(/${path.join(root, '.tsrct', 'desk')}/**)`,
        // its skill sheets (tesla-skills/, 2026-10-11)
        `Read(/${path.join(root, 'tesla-skills')}/**)`];
    fs.writeFileSync(f, JSON.stringify({ permissions: { allow, deny: all } }, null, 2));
    return f;
}

async function ensureWorker(level, cwd) {
    const model = MODELS[level] || MODELS.medium;
    if (worker && exists() && worker.model === model) return worker;
    if (worker || exists()) stopWorker('model change');
    const id = crypto.randomUUID();
    const settings = settingsFile();
    if (!/^[A-Za-z0-9._/-]+$/.test(settings)) throw new Error('bad settings path');
    // Fixed parts only: nothing he or a model said reaches this line.
    const command = `claude --model ${model} --session-id ${id} --settings ${settings}`;
    const out = await deps.spawn({ name: NAME, cwd: cwd || deps.projectsRoot, command, bootTimeoutMs: 90000 });
    if (!out || !out.ok) throw new Error((out && out.error) || 'the worker session did not start');
    worker = { id, model, entry: { id, file: '', offset: 0 }, busy: false, idleTimer: null };
    console.log(`[hands] worker up (${model})`);
    return worker;
}

// What he asked `hands` STRAIGHT (say_to_session, not a look_into task) was
// never logged: the task that started it was, the follow-ups and whatever they
// made it do were not (2026-09-25, four follow-ups lost). Read off its
// transcript from where the last logged thing ended: each question, the answer,
// and the tools it used - the tools are the missing buttons.
function followUps(e) {
    if (!e || !e.file) return [];
    let buf = '';
    try {
        const size = fs.statSync(e.file).size;
        const from = e.logFrom || 0;
        if (size <= from) return [];
        const fd = fs.openSync(e.file, 'r');
        const b = Buffer.alloc(size - from);
        fs.readSync(fd, b, 0, b.length, from);
        fs.closeSync(fd);
        buf = b.toString('utf8');
        e.logFrom = size;
    } catch { return []; }
    const out = [];
    let cur = null;
    for (const line of buf.split('\n')) {
        let r = null;
        try { r = JSON.parse(line); } catch { continue; }
        const m = r && r.message;
        if (!m) continue;
        const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
        if (r.type === 'user') {
            const said = parts.filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
            if (!said || /^<(command|local-command|system-reminder)/.test(said)) continue;   // a tool result or harness text, not him
            cur = { asked: said.slice(0, 600), answer: '', tools: [] };
            out.push(cur);
        } else if (r.type === 'assistant' && cur) {
            for (const c of parts) {
                if (c.type === 'tool_use') {
                    const arg = c.input && (c.input.command || c.input.file_path || c.input.pattern || c.input.query || c.input.url || '');
                    cur.tools.push(`${c.name}${arg ? ` (${String(arg).replace(/\s+/g, ' ').slice(0, 120)})` : ''}`);
                } else if (c.type === 'text' && m.stop_reason === 'end_turn') cur.answer = String(c.text || '').replace(/\s+/g, ' ').slice(0, 600);
            }
        }
    }
    return out;
}

function logFollowUps(why) {
    if (!worker || !deps.logFile) return;
    const rows = followUps(worker.entry).filter(f => !/RESULTADO\s*\{/.test(f.answer));   // a task's own answer is logged by run()
    if (!rows.length) return;
    const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
    let block = `## ${when} - follow-ups asked straight to hands (${rows.length}, logged at ${why})\n`;
    for (const f of rows) {
        block += `- **Asked:** ${f.asked.replace(/\s+/g, ' ')}\n`
            + (f.answer ? `  - **Answered:** ${f.answer}\n` : '')
            + (f.tools.length ? `  - **Used:** ${[...new Set(f.tools)].slice(0, 15).join('; ')}\n` : '');
    }
    if (restrictedGuard.mentionsRestricted(block)) block = `## ${when} - follow-ups asked straight to hands (${rows.length}) - dropped: they mentioned SecretCo\n`;
    try { fs.appendFileSync(deps.logFile, block); } catch (e) { console.warn('[hands] log:', e.message); }
}

function stopWorker(why) {
    try { logFollowUps(why); } catch (e) { console.warn('[hands] follow-ups:', e.message); }
    if (worker && worker.idleTimer) clearTimeout(worker.idleTimer);
    worker = null;
    try { deps.tmux(['kill-session', '-t', `=${NAME}`]); } catch { /* already gone */ }
    console.log(`[hands] worker closed (${why})`);
}

// Idle means nobody TALKED to it, not "no new task". He kept asking it
// follow-ups through Tesla, and it was killed 15 min after the last task,
// between Tesla's question and his yes (2026-09-25). Its transcript moves on
// every exchange, whoever typed, so the clock runs from the transcript.
function armIdle(ms = IDLE_MS) {
    if (!worker) return;
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    worker.idleTimer = setTimeout(() => {
        if (!worker || worker.busy) return;
        const quiet = Date.now() - lastActivity();
        if (quiet < IDLE_MS) return armIdle(IDLE_MS - quiet + 1000);
        stopWorker('idle');
    }, ms);
    if (worker.idleTimer.unref) worker.idleTimer.unref();
}

// When the transcript was last written (0 when unknown: then the timer alone decides).
function lastActivity() {
    let t = 0;
    try {
        // run() found the file on the first task; reading it here could move
        // the offset the answer is read from.
        const e = worker && worker.entry;
        if (e && e.file) t = fs.statSync(e.file).mtimeMs;
    } catch { t = 0; }
    return t;
}

// RESULTADO {...} on the last line; anything that does not parse is still an
// answer, said as it came.
function parseResult(text, detail) {
    const s = String(text || '');
    const m = /RESULTADO\s*(\{[\s\S]*\})\s*$/.exec(s.trim());
    if (m) {
        try {
            const o = JSON.parse(m[1]);
            return { ok: o.ok !== false, said: String(o.dijo || '').slice(0, detail ? 3000 : 400), how: String(o.como || '').slice(0, 2000), missing: String(o.falta || '').slice(0, 300) };
        } catch { /* fall through */ }
    }
    const plain = s.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
    return { ok: true, said: plain.slice(0, 300), how: plain.slice(0, 2000), missing: '' };
}

function writeLog(job) {
    if (!deps.logFile) return;
    const r = job.result || {};
    const when = new Date(job.startedAt).toISOString().slice(0, 16).replace('T', ' ');
    const block = [
        `## ${when} - ${job.recipe ? `command ${job.recipe} (has a button now)` : job.changes ? 'workaround (changes)' : 'look_into (read only)'} - ${job.state}`,
        `- **Asked:** ${job.task}`,
        job.why ? `- **Why no button:** ${job.why}` : '',
        `- **Model:** ${job.model}${job.session ? ` · watching ${job.session}` : ''} · ${Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000)}s`,
        `- **Told him:** ${r.said || job.error || ''}`,
        r.how ? `- **How:** ${r.how.replace(/\n+/g, ' ')}` : '',
        r.missing ? `- **Missing button:** ${r.missing}` : '',
        '',
    ].filter(Boolean).join('\n') + '\n';
    try {
        if (!fs.existsSync(deps.logFile)) {
            fs.mkdirSync(path.dirname(deps.logFile), { recursive: true });
            fs.writeFileSync(deps.logFile, '# Tesla workarounds\n\nEverything Tesla had to do WITHOUT a button (lib/teslaHands.js). Give this file to Claude: what repeats becomes a real action.\n\n');
        }
        fs.appendFileSync(deps.logFile, block);
    } catch (e) { console.warn('[hands] log:', e.message); }
}

async function run(key) {
    const job = jobs.get(key);
    const tell = (line) => { try { if (deps.say) deps.say(line); } catch { /* nobody listening */ } };
    try {
        restrictedGuard.assertNotRestricted('tesla hands', job.task, job.why, job.session, job.cwd);
        const w = await ensureWorker(job.level, job.cwd);
        w.busy = true;
        if (w.idleTimer) clearTimeout(w.idleTimer);
        job.state = 'running';
        const e = w.entry;
        if (!e.file && deps.readAnswer) deps.readAnswer(e);      // finds the transcript
        logFollowUps('a new task');
        try { e.offset = e.file ? fs.statSync(e.file).size : 0; } catch { e.offset = 0; }
        const paste = deps.paste(NAME, instruction(job));
        if (!paste || !paste.success) throw new Error(`could not type into ${NAME}: ${(paste && paste.error) || 'paste failed'}`);
        await new Promise(r => setTimeout(r, Math.min(400, POLL_MS)));
        deps.tmux(['send-keys', '-t', NAME, 'Enter']);
        const t0 = Date.now();
        let text = null, toldStill = false;
        while (Date.now() - t0 < TASK_MS) {
            await new Promise(r => setTimeout(r, POLL_MS));
            if (!exists()) throw new Error('the hands session was closed');
            text = deps.readAnswer(e);
            if (text !== null) break;
            watchPermission(job);
            if (!toldStill && Date.now() - t0 >= STILL_WORKING_MS) {
                toldStill = true;
                tell(`Sigo trabajando en eso, ya llevo ${Math.round((Date.now() - t0) / 60000)} minutos. Te aviso cuando termine.`);
            }
        }
        if (text === null) throw new Error(`took more than ${Math.round(TASK_MS / 60000)} minutes`);
        // The task and its answer are logged by writeLog; follow-ups start here.
        try { e.logFrom = fs.statSync(e.file).size; } catch { /* no file: nothing to skip */ }
        if (restrictedGuard.mentionsRestricted(text)) throw new Error('its answer mentioned SecretCo, so it was dropped');
        job.result = parseResult(text, job.detail);
        // The full text stays with the brain for a while (review #12: "leemela entera"
        // sent it back to look again, because the brain only had a 90-char summary).
        lastResult = { goal: job.task.slice(0, 120), said: job.result.said, at: Date.now() };
        job.state = job.result.ok ? 'done' : 'failed';
        job.finishedAt = Date.now();
        // A draft is text to copy, not a sentence to hear: it goes into his
        // input box, unsent, and the voice only says where it is.
        let drafted = false;
        if (job.recipe === 'draft_reply' && job.result.ok && job.result.how && deps.draft) {
            try { deps.draft(job.result.how); drafted = true; } catch (e) { console.warn('[hands] draft:', e.message); }
        }
        // Only the result, in her words (Tesla review #10: "Sonnet lo hizo por
        // otro camino: ..." before every answer - machinery he never asked about).
        tell(`${job.result.said}${drafted ? ' Te deje el texto en tu caja, sin mandar.' : ''}`);
    } catch (err) {
        job.state = 'failed';
        job.error = String(err.message).slice(0, 200);
        job.finishedAt = Date.now();
        tell(`No pude: ${job.error}`);
    } finally {
        if (worker) { worker.busy = false; armIdle(); }
        writeLog(job);
    }
}

// A permission card stops `hands` cold, and nothing said so (Tesla review #10:
// 5 minutes on "cd /tmp/..." while she told him three times "sigue trabajando,
// no hay error"). Every poll asks; the first time a card shows up she ASKS him
// (talk.propose -> approve_session_permission), so his "si" approves it.
// ONE question per stop (Tesla review #11: eight offers in 20 minutes, because the
// dialog's text changed on every redraw). Again only if it is still stuck later.
const OFFER_AGAIN_MS = Number(process.env.HANDS_OFFER_AGAIN_MS || 90 * 1000);
// A card his approver allows on its own is gone in a second; asking him about it
// read "¿Aprobar ... (Tip: auto mode ...)?" for nothing (review #13). Only a card
// still there after PERMISSION_GRACE_MS is a stop worth his attention.
const PERMISSION_GRACE_MS = Number(process.env.HANDS_PERMISSION_GRACE_MS || 4000);
function watchPermission(job) {
    let what = '';
    try { what = typeof deps.permission === 'function' ? String(deps.permission(NAME) || '') : ''; } catch { what = ''; }
    if (restrictedGuard.mentionsRestricted(what)) what = 'algo';
    if (!what) { job.waiting = ''; job.offeredAt = 0; job.firstSeen = 0; return; }
    if (!job.firstSeen) job.firstSeen = Date.now();
    if (Date.now() - job.firstSeen < PERMISSION_GRACE_MS) return;
    job.waiting = what;
    if (job.offeredAt && Date.now() - job.offeredAt < OFFER_AGAIN_MS) return;
    job.offeredAt = Date.now();
    let asked = false;
    try { asked = !!(deps.offer && deps.offer('approve_session_permission', { session: NAME }).ok); } catch { asked = false; }
    if (!asked && deps.say) { try { deps.say(`Necesito tu permiso para seguir: ${what}.`, { urgent: true }); } catch { /* nobody listening */ } }
}

// Queues the task and answers at once: it can take minutes.
// `recipe`: the name of a DECLARED command whose fixed task text this is
// (lib/actions.js). Same session and rules; logged as a command, not a gap.
function start({ task, why, changes, level, session, recipe, detail }) {
    const t = String(task || '').trim();
    if (!t) throw new Error('falta que me digas que hay que hacer');
    let cwd = '';
    try { cwd = session && deps.cwdOf ? String(deps.cwdOf(session) || '') : ''; } catch { cwd = ''; }
    restrictedGuard.assertNotRestricted('tesla hands', t, why || '', session || '', cwd);
    if (cwd && deps.projectsRoot && !path.resolve(cwd).startsWith(path.resolve(deps.projectsRoot) + path.sep)) cwd = '';
    const lvl = MODELS[level] ? level : 'medium';
    seq += 1;
    const key = `hands-${Date.now()}-${seq}`;
    // `key` on the job too: the instruction printed "TAREA DE TESLA undefined".
    jobs.set(key, { key, detail: !!detail, recipe: recipe ? String(recipe).slice(0, 40) : '', task: t.slice(0, 4000), why: String(why || '').slice(0, 300), changes: !!changes, level: lvl, model: MODEL_NAME[lvl],
        session: session || '', cwd: cwd || deps.projectsRoot, state: 'queued', startedAt: Date.now() });
    chain = chain.then(() => run(key));
    return { key, model: MODEL_NAME[lvl], changes: !!changes };
}

// For the orb's "in the background" block and for Haiku's context.
function list(now = Date.now()) {
    return [...jobs.entries()]
        .filter(([, j]) => ['queued', 'running'].includes(j.state) || now - (j.finishedAt || j.startedAt) < 30 * 60 * 1000)
        .sort((a, b) => b[1].startedAt - a[1].startedAt)
        .slice(0, 3)
        .map(([key, j]) => ({
            key, what: 'workaround', model: j.model, level: j.level, session: j.session, goal: j.task.slice(0, 90),
            state: j.state === 'running' && j.waiting ? 'waiting' : (j.state === 'queued' ? 'running' : j.state), startedAt: j.startedAt, finishedAt: j.finishedAt || null,
            elapsedMs: (j.finishedAt || now) - j.startedAt,
            step: j.state === 'queued' ? 'waiting its turn' : (j.state === 'running' ? (j.waiting ? `ESPERA TU PERMISO para: ${j.waiting}` : 'working in the hands session') : ''),
            steps: 0, summary: j.result ? j.result.said : '', error: j.error || '', plan: null, files: 0,
        }));
}
function describe(now = Date.now()) {
    const full = lastResult && now - lastResult.at < 30 * 60 * 1000 && lastResult.said.length > 120
        ? `ULTIMO RESULTADO COMPLETO de "${lastResult.goal}" (si te pide oirlo entero, leeselo TAL CUAL, no lo mandes a mirar de nuevo): ${lastResult.said.slice(0, 2500)}`
        : '';
    return [full, ...list(now).map(j => {
        const job = jobs.get(j.key) || {};
        // do_on_pc stops to ASK before anything that cannot be undone (lib/actions.js
        // RECIPES.do_on_pc): his answer goes back to the same worker, which still
        // has the screen and the steps in its head.
        if (['do_on_pc', 'browser_task'].includes(job.recipe) && j.state !== 'running') {
            return `${job.recipe === 'browser_task' ? 'navegador aparte (proyector)' : 'uso de su PC'} con ${j.model}, tarea "${j.goal}": ${j.state === 'done' ? 'terminado' : 'PARADO'}${j.summary ? ` - dijo: ${j.summary}` : ''}${j.error ? ` - ${j.error}` : ''}${j.state === 'failed' && !j.error ? '. Si eso fue una pregunta y el dice que si (o que siga, o que cambie algo), mandaselo con say_to_session a la sesion hands, tal cual' : ''}`;
        }
        if (j.state === 'waiting') return `tarea "${j.goal}" PARADA: ESPERA SU PERMISO para ${job.waiting}. Si dice que si, approve_session_permission con session hands; no digas que sigue trabajando`;
        return `trabajo por otro camino (sesion hands) con ${j.model}, tarea "${j.goal}": ${j.state === 'running' ? `trabajando hace ${Math.round(j.elapsedMs / 60000)} min` : `${j.state === 'done' ? 'terminado' : 'fallo'} y YA ANOTADO solo en logs/tesla-workarounds.md`}${j.summary ? ` - resultado: ${j.summary}` : ''}${j.error ? ` - ${j.error}` : ''}`;
    })].filter(Boolean).join('; ');
}

module.exports = { configure, start, list, describe, instruction, NAME, MODELS, _parseResult: parseResult, _jobs: jobs, _writeLog: writeLog, stopWorker };
