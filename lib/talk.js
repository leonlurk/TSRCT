// ─────────────────────────────────────────────────────────────────────────
// lib/talk.js — TALK: speak to the machine, it answers out loud.
//
//   microphone (browser)  ->  text  ->  Hermes (local, Ollama)  ->  text  ->
//   Piper "es_MX-claude-high" (CPU)  ->  the answer in his ear. (Was the cloned
//   "house-es" until 2026-09-24: hard to understand - he picked this one by ear.)
//
// THE WHOLE POINT OF THIS FILE IS THE MEMORY POLICY. Leon's rule, stated up
// front: "hermes tiene que jamas interrumpir otros procesos y dejarme sin
// memoria". The card is 8GB and hermes3:8b takes ~4.7GB of it; the box has
// ~11GB of RAM in WSL with several Claude sessions living in it. A chat
// assistant that keeps a model resident all day to be ready for a question that
// comes twice a week is exactly the thing that ruins an afternoon of work.
//
// So, four rules, and every one of them is enforced here rather than hoped for:
//
//   1. NOTHING AT BOOT. HERMES_AUTOSTART has been off since 2026-09-18 and this
//      module does not touch Ollama until open() is called by a real click.
//   2. IT ASKS BEFORE IT TAKES. open() refuses if the card is already busy
//      (ComfyUI rendering, a training run) and says so in words. The one
//      exception is when the model is ALREADY resident — then talking costs no
//      new memory at all, so there is nothing to refuse.
//   3. WARM FOR AS LONG AS THE CONVERSATION IS OPEN - silence included. The
//      model is loaded when the conversation opens, and a heartbeat re-arms
//      keep_alive=TALK_KEEP_ALIVE every few minutes while it stays open; ending
//      it unloads immediately (keep_alive: 0). ONLY HE ENDS IT (2026-09-24):
//      the END button or a phrase ("tesla, terminamos", "chau tesla"). Leon:
//      "puedo estar en una conversacion un largo rato y no por eso voy a estar
//      hablando ... la deberia desactivar yo manualmente".
//   4. THE ONE SAFETY NET is not silence, it is ABSENCE: if no TSRCT window has
//      polled for TALK_ABANDON_MS (tab closed, laptop asleep), nobody can hear
//      it, so it closes and gives the card back. And if this server dies, the
//      keep_alive runs out on its own - the heartbeat is what keeps it, not -1.
//
// Concurrency: every Ollama call in this repo goes through hermes' single
// queue (OLLAMA_MAX=1), so TALK can never run beside TOWER or the dispatcher —
// it waits its turn like everything else. One question at a time on top of that
// (`busy`), because two overlapping answers would also mean two overlapping
// voices.
//
// ── ATTACHED TO A SESSION (2026-09-19) ──────────────────────────────────────
// TALK can be pointed at one tmux session, and then it is the thing TOWER was
// supposed to be. Three parts, and the difference from TOWER is in all three:
//
//   THE SCREEN, NOT THE CHAT. paneShape.readableTail() throws away the rules,
//   the composer, the spinner and the token footer before the model sees
//   anything. TOWER handed over the raw capture and summarised the furniture.
//
//   BOTH WAYS AT ONCE. What he says is pasted into the session as a prompt AND
//   handed to the local model with the screen. Claude does the work; hermes is
//   the voice that tells him what happened. He never types.
//
//   A WATCHER THAT COSTS NOTHING UNTIL SOMETHING HAPPENS. The tick is a
//   capture-pane and a regex — no model, no GPU, no network. The model is woken
//   only on the transition from working to waiting, i.e. once per finished turn.
//   TOWER woke it every 25 seconds per pane whether or not anything had changed,
//   which is how it ended up being the only thing on this box that loaded a
//   4.7GB model by itself and pinned a core at 96 degrees.
//
// The watcher lives INSIDE the open conversation on purpose: no panel open, no
// watching, and the same close() that gives the memory back also stops it.
//
// SecretCo: the question, the history and the answer are all content. The guard is
// applied here AND inside hermes.ollamaChat; the spoken half is guarded again
// at /api/tts/say. Fail closed — a refusal is an error, never a silent answer.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const restrictedGuard = require('./dispatcher/restrictedGuard');
const { NAME: OWNER, UPPER: OWNER_UP, LANG: OWNER_LANG } = require('./owner');

// A refusal that only says "restricted" tells him nothing and tells the log nothing.
// Every one of them is the same sentence to him, so which door it came from was
// unknowable from the outside: he asked four questions, got the same line four
// times, and called it being ignored — correctly, from where he was sitting.
const RESTRICTED_SNIPPET = new RegExp(`[^.\\n]{0,60}(?:${restrictedGuard.NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\w*[^.\\n]{0,60}`, 'i');
function restrictedHit(text) {
    const m = RESTRICTED_SNIPPET.exec(String(text || ''));
    return m ? m[0].trim() : '(no snippet)';
}
function logRefusal(where, text) {
    console.warn(`[talk] restricted project refused ${where}: ...${restrictedHit(text)}...`);
}
const gpu = require('./gpu');
// Standalone, never through `dispatcher.*`: the same rule restrictedGuard follows.
// What a Claude pane looks like is knowledge this file needs to decide when a
// turn ended, and it must not depend on the dispatcher having loaded.
const paneShape = require('./paneShape');
// The names he calls it by (and the character behind them).
const persona = require('./persona');
// The declared buttons. TALK is the only caller that lets a MODEL pick one, and
// even here the model only names it — lib/actions.js validates and runs.
const actions = require('./actions');
// The buttons that live in his browser. This file owns the two things it needs
// from the conversation: whether a panel is actually there to press them, and a
// voice to report a press that failed after "listo" had already been said.
const uiActions = require('./uiActions');
// How it sounds: the length and the shape of a spoken answer, enforced in code
// because a 7B asked nicely still writes a paragraph with a list in it.
const speech = require('./speech');
const { followTarget } = require('./follow');
// What he said, decided without a model. Runs BEFORE hermes and answers for the
// sentences he says every day; the model is what happens when this is not sure.
const understand = require('./understand');
const haiku = require('./haikuBrain');
// Every turn written down, so the next conversation can be better than this one.
const teslaLog = require('./teslaLog');

// WHO THINKS (2026-09-24): 'haiku' = a hidden Claude Haiku session per project
// (lib/haikuBrain.js, his subscription, no GPU, no cold load); 'local' = Ollama.
const BRAIN = (process.env.TALK_BRAIN || 'haiku').toLowerCase();

// How long Ollama holds the model after each answer. Long enough that a pause
// mid-conversation does not pay the 90s cold load again, short enough that a
// forgotten tab is not a 4.7GB leak for the rest of the day.
const KEEP_ALIVE = process.env.TALK_KEEP_ALIVE || '30m';
// No window polling for this long = nobody is there to hear it. NOT silence:
// the panel polls every few seconds whether he talks or not.
const IDLE_MS = Number(process.env.TALK_ABANDON_MS || process.env.TALK_IDLE_MS || 20 * 60 * 1000);
// While open, how often the model's keep_alive is re-armed (well under KEEP_ALIVE).
const HEARTBEAT_MS = Number(process.env.TALK_HEARTBEAT_MS || 5 * 60 * 1000);
// Free VRAM (MiB) needed to load the model. hermes3:8b is ~4.7GB resident.
// The 3B at this conversation's context is ~2.4 GB resident; the rest is headroom.
const MIN_FREE_MIB = Number(process.env.TALK_MIN_FREE_MIB || 3200);
// Turns of history sent back to the model (a turn is you + it).
const MAX_TURNS = Number(process.env.TALK_MAX_TURNS || 8);
// The cloned voice. Same one the morning brief is read in.
// 2026-10-14: Microsoft's Jorge pitched into a monster, picked by ear (lib/tts.js PROFILES).
const VOICE = process.env.TALK_VOICE || 'jorge-monstruo';
const VOICE_EN = process.env.TALK_VOICE_EN || 'en_US-lessac-high';

// ── his language (Tesla review #4, 2026-10-08) ──────────────────────────────
// He switched to English at 22:06 and Tesla answered ten turns in Spanish, in
// the Spanish voice. The language is read from HIS sentence (common words of
// each language; a sentence with neither, "okay", "tsrct", keeps the last one),
// the brain is told to answer in it, and every line is spoken by the voice of
// ITS OWN language - the fixed Spanish lines in code ("Listo, se lo mande a...")
// stay in the Spanish voice instead of being mangled by the English one.
const EN_WORDS = new Set(['the', 'you', 'i', "i'm", 'im', 'it', 'is', 'to', 'what', 'please', 'yes', 'yeah', 'do', 'that', 'this', 'can', 'could', 'want', 'wanted', 'need', "let's", 'lets', 'my', 'and', 'of', 'be', 'already', 'just', 'tell', 'session', 'sorry', 'how', 'are', 'was', 'with', 'for', 'have', 'it’s', "it's", 'we', 'our', 'now', 'there', 'thanks', 'from', 'about', 'would', 'should', 'will', 'your']);
const ES_WORDS = new Set(['que', 'el', 'la', 'los', 'las', 'de', 'del', 'por', 'favor', 'si', 'es', 'y', 'lo', 'le', 'un', 'una', 'como', 'va', 'esto', 'esta', 'con', 'para', 'sesion', 'quiero', 'hola', 'gracias', 'dale', 'vos', 'se', 'listo', 'pero', 'ya', 'mi', 'tu', 'te', 'en', 'al', 'decile', 'decirle', 'pedile', 'mandale', 'hace', 'hizo', 'hay', 'esa', 'ese', 'todo', 'bien', 'cual', 'donde', 'cuando', 'porque', 'tambien', 'muy', 'eso', 'proceda', 'arreglos', 'perfecto', 'onda']);
function langOf(text) {
    const words = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z’']+/g) || [];
    let en = 0, es = 0;
    for (const w of words) { if (EN_WORDS.has(w)) en++; if (ES_WORDS.has(w)) es++; }
    if (en > es) return 'en';
    if (es > en) return 'es';
    return null;
}
function voiceFor(lang) { return lang === 'en' ? VOICE_EN : VOICE; }
function voiceOf(text) { return voiceFor(langOf(text) || state.lang || OWNER_LANG); }
// The MODEL THAT SPEAKS, which is deliberately not the dispatcher's.
// Measured 2026-09-19 on the same real pane, same prompt: qwen2.5:7b-instruct
// read the screen correctly while hermes3:8b claimed Leon's own verification as
// its own work and addressed Claude instead of him.
// MEASURED AGAIN 2026-09-19, both at THIS window (4096), both genuinely cold,
// same pane, same prompt, on the real code path:
//
//     qwen2.5:7b-instruct   cold 141.8s · warm 6.9/5.2s · 4835 MiB
//     hermes3:8b            cold 216.5s · warm 6.0/5.3s · 4991 MiB
//
// [!] The earlier "hermes3 loads faster (112s vs 152s)" was WRONG: that 112s was
// a model the page cache had just served three times. Cold-load timings swing
// enormously with disk state — the same model measured 112s and 216s the same
// afternoon — so never compare two of them unless both are truly cold.
//
// Quality on the same three questions: qwen2.5 named the two concrete reports
// and their state; hermes3 answered "the file was updated" and named nothing.
// The reverse held on the invention trap ("how many commits this month"):
// hermes3 refused from context, qwen2.5 made a number up. An 8B does that
// occasionally and no prompt removes it — that is the ceiling, not a bug.
// HERMES_MODEL still overrides everything.
// 2026-09-24, his call after an A/B with long context (Decisions Log): the 3B uses
// about half the card (2.3-2.9 GB), answers faster (70-100 tok/s vs ~50) and holds
// ~12k tokens of context fully on the GPU, where the 7B spilled to the CPU. It
// passed every fact/needle test up to 12k; its Spanish is a little rougher.
const MODEL = process.env.TALK_MODEL || process.env.HERMES_MODEL || 'qwen2.5:3b-instruct-q4_K_M';
const MAX_CHARS = 1200;
// Acting on what he says, not only answering it. Off with TALK_ACTIONS=0.
const ACTIONS_ON = process.env.TALK_ACTIONS !== '0';
// How long a "should I?" stays answerable before it is forgotten. Long enough
// to think, short enough that a "dale" half an hour later cannot fire it.
const CONFIRM_MS = Number(process.env.TALK_CONFIRM_MS || 120000);

// ── the watcher's numbers ───────────────────────────────────────────────────
// How often the pane is LOOKED AT. This is a capture-pane and a regex; it never
// touches Ollama or the card, so it can be frequent without costing anything.
const WATCH_MS = Number(process.env.TALK_WATCH_MS || 4000);
// The floor between two spoken narrations. A session that finishes a turn every
// ten seconds would otherwise talk over itself all afternoon.
const NARRATE_MIN_MS = Number(process.env.TALK_NARRATE_MIN_MS || 20000);
// LIVE mode: how often it is allowed to say something WHILE a turn is running.
// Much slower than the tick on purpose — this one does cost a model call, and a
// running turn changes the screen constantly, so the floor is the whole limit.
const LIVE_MS = Number(process.env.TALK_LIVE_MS || 60000);
// How much of the pane the model is shown. Bigger is not better on an 8GB card:
// it is the whole answer's latency, and the last screen is where the news is.
const CAPTURE_LINES = 140;
// How long a single answer is allowed to take. Two numbers, because the two
// cases are nothing alike and one number cannot serve both: measured
// 2026-09-19, a COLD answer is a ~150s model load plus the generation, and the
// inherited 180s ceiling (TOWER's, for a one-line summary) killed the very
// first question of every conversation — the timeout then tripped hermes'
// circuit breaker, so the two questions after it failed instantly too, and the
// panel looked broken when it was only slow.
const COLD_MS = Number(process.env.TALK_COLD_MS || 300000);
const WARM_MS = Number(process.env.TALK_WARM_MS || 90000);
// The context window TALK asks Ollama for. The dispatcher's default is 8192 and
// this path does not need it: system + examples + the project block + 2500 chars
// of screen + eight turns of history is ~2.4k tokens at its very fattest. The
// window is a KV cache ALLOCATED WHEN THE MODEL LOADS, so asking for four times
// what you send is VRAM held for nothing and cold-start seconds paid every time.
// Leon, on the swap from hermes3 to qwen2.5: "el modelo nunca esta cargando ...
// con hermes creo que funcionaba mas rapido". He was right, and this was the
// bigger half of why. MEASURED on the same model, same prompt, only this number
// changing:
//
//     num_ctx 8192   cold 211.3s · warm 5.7s · 5067 MiB
//     num_ctx 4096   cold 129.7s · warm 2.2s · 4835 MiB
//
// A 39% cheaper cold start, answers nearly THREE TIMES faster warm, and 232 MiB
// back — for a window that was never being filled. The warm number is the one
// that decides whether it feels like a conversation: 2.2s is an answer, 5.7s is
// a wait. Raise this only with a measurement, never on the theory that more
// context is better.
const NUM_CTX = Number(process.env.TALK_NUM_CTX || 4096);
const SCREEN_LINES = Number(process.env.TALK_SCREEN_LINES || 60);
const SCREEN_CHARS = Number(process.env.TALK_SCREEN_CHARS || 2500);
// A panel that has not polled in this long is a tab nobody is looking at, and
// its narrations stop counting as "he is still here" for the idle timer.
const POLL_ALIVE_MS = 60000;
// THE CEILING. Until now "a panel is open" was the proof that he was there, so
// closing it ended the conversation and freed the card. The assistant is not a
// panel any more — it lives outside every view, which is the whole point — so
// that proof is gone and something else has to cap it: half an hour without HIM
// saying a word ends the conversation, however much the sessions are narrating.
// A phone in a pocket listening to a build must not hold 4.7GB all afternoon.
// OFF by default since 2026-09-24 (0): only he ends a conversation. Kept as an
// opt-in for anyone who wants the old half-hour ceiling back.
const MAX_SILENT_MS = Number(process.env.TALK_MAX_SILENT_MS || 0);

let deps = { hermes: null, brief: null, sessions: null, capture: null, send: null, project: null };
function configure(d) {
    deps = { ...deps, ...(d || {}) };
    if (d && d.brain) haiku.configure({ ...d.brain, catalogue: catalogueText });
}

// Work running in the background (the prompt writer): the list the panel
// draws, and the one line Haiku is TOLD - asked "que paso?" without it, Haiku
// guessed "esta en progreso" about a job that had finished six minutes before.
function backgroundList() {
    try { return typeof deps.background === 'function' ? (deps.background() || []) : []; } catch { return []; }
}
// What he said that never reached a turn: the page cut him off to speak a
// narration (2026-10-05, "when i remind it that it interrupted me it doesn't
// remember what it interrupted" - nothing could: the words were never sent).
// The orb reports each lost sentence; the NEXT turn hands them to the brain,
// once, and only if they are recent. SecretCo never enters the list.
const LOST_MS = 10 * 60000;
const lost = [];
function noteLost(text) {
    const t = String(text || '').trim().slice(0, 400);
    if (!t || restrictedGuard.mentionsRestricted(t)) return false;
    lost.push({ text: t, at: Date.now() });
    if (lost.length > 4) lost.splice(0, lost.length - 4);
    return true;
}
function lostNote() {
    const fresh = lost.filter(x => Date.now() - x.at < LOST_MS);
    lost.length = 0;
    if (!fresh.length) return '';
    return `LO QUE ${OWNER_UP} DIJO Y SE PERDIO (lo corto una narracion tuya o del programa; nunca llego a un turno): `
        + fresh.map(x => `"${x.text}"`).join(' / ')
        + '. Si ahora te pide seguir o te dice que lo interrumpiste, es ESTO lo que estaba diciendo.';
}

function backgroundText() {
    try {
        const s = typeof deps.backgroundText === 'function' ? String(deps.backgroundText() || '') : '';
        return s && !restrictedGuard.mentionsRestricted(s) ? s : '';
    } catch { return ''; }
}
// Is anybody looking? A panel in a conversation, or an orb that is off but
// still checking on background work. Nobody -> the result goes to his phone.
let jobsPollAt = 0;
function someoneWatching(now = Date.now()) {
    return (state.open && now - state.lastPollAt < POLL_ALIVE_MS) || now - jobsPollAt < POLL_ALIVE_MS;
}
// The orb's slow poll while the conversation is OFF: the background list, and
// the lines background work announced, so a result is SHOWN even when nobody
// is talking. Never touches lastPollAt - that one means "a conversation panel".
function jobsStatus({ since } = {}) {
    jobsPollAt = Date.now();
    const from = Number(since || 0);
    return { jobs: backgroundList(), say: state.spool.filter(x => x.id > from && x.kind === 'bg'), seq: state.seq, open: state.open };
}

// A press is only queued while a panel is actually polling — otherwise the
// assistant would say "listo" into a closed browser. POLL_ALIVE_MS is the same
// liveness the narrator already uses to decide he is still there.
// Only a TSRCT page counts: Ghost Runner keeps the conversation alive from his
// phone, but it has none of these buttons, so a press queued for it would be a
// "listo" nobody keeps (2026-10-09).
uiActions.configure({ alive: () => state.open && Date.now() - state.screenPollAt < POLL_ALIVE_MS });
// And if the page reports a failure after the fact, it is spoken: a wrong
// "listo" left standing is the thing this whole file is written to avoid.
uiActions.onFailure((line) => { pushSay(line, 'ui'); });
// And what this conversation has done, so "guardalo como mi setup" has
// something to save. The catalogue owns the recipe; this only remembers.
actions.configure({ recent: () => state.did, say: (line) => { if (!restrictedGuard.mentionsRestricted(line)) pushSay(line, 'bg'); } });

const state = {
    open: false,
    openedAt: 0,
    lastAt: 0,
    busy: false,
    turns: [],          // [{ role:'user'|'assistant', content, at }]
    idleTimer: null,
    lastError: '',
    // ── attached session ──
    session: '',        // the tmux session being watched and spoken to ('' = none)
    // DOES WHAT HE SAYS GO INTO THE SESSION. Default OFF since 2026-09-19, and
    // the reason is a real incident: it shipped ON, he said one word to test the
    // microphone, and "Hello" was typed into a live acme-agent-trudy session
    // where Claude answered it. Nobody warned him and nobody asked. The feature
    // was working exactly as designed, which is what made the DESIGN wrong:
    // typing into a running session is not a default, it is a decision, and it
    // has to be made once, deliberately, per conversation. Leon: "no tiene que
    // mandar nada sin que me entere".
    toClaude: false,
    watch: true,        // narrate by itself when a turn finishes
    live: false,        // ALSO say what is happening WHILE the turn runs
    watchTimer: null,
    lastWork: null,     // was the pane mid-turn last tick (null = not looked yet)
    lastScreen: '',     // what was narrated last, so the same screen is not said twice
    lastSaid: '',       // and the same sentence is not said twice either
    // The one slot of memory the pronouns resolve against. He almost never says
    // a name twice: the second sentence says "esa", "la otra", "lo mismo". This
    // is what those point at — and when it is empty, the gate ASKS instead of
    // guessing, because a wrong guess here is a session closed by mistake.
    last: { session: '', project: '' },
    recent: [],         // the last few things it SAID, so it does not repeat one
    did: [],            // and the last few things it DID, so a setup can be saved
    needArg: null,      // { name, key, args, at } an action one answer short of runnable
    pendingAction: null,// { name, args, says, at } waiting for him to say yes
    modelOk: false,     // has the card been checked this conversation
    modelNoBefore: 0,   // ...and if it said no, when to bother asking again
    warm: false,        // is the model in memory (so: is the next answer seconds or minutes)
    lastNarrateAt: 0,
    pending: false,     // a turn finished and has not been spoken about yet
    narrating: false,
    lastPollAt: 0,      // when the panel last asked for status
    screenPollAt: 0,    // ...and when a TSRCT page did (Ghost Runner polls too, and has no buttons)
    lastUserAt: 0,      // when HE last said something (not when it last spoke)
    spool: [],          // [{ id, text, voice, kind, at }] things to be SAID
    seq: 0,
    lang: null,         // the language he spoke last ('es' | 'en'), see langOf()
    trace: [],          // what THIS turn did on its way through ask(), for lib/teslaLog.js
    turnT0: 0,          // when this turn started, so every step carries its offset (t, ms)
};

// One step of the current turn, for the log, stamped with how far into the
// turn it happened. A string is the human detail; an object is measurements.
function trace(tag, detail) {
    const row = { tag, t: state.turnT0 ? Date.now() - state.turnT0 : 0 };
    if (detail && typeof detail === 'object') row.data = detail;
    else if (detail !== undefined) row.detail = String(detail).slice(0, 400);
    state.trace.push(row);
}

// How long one awaited step took, and - when Haiku answered it - how that time
// split: bringing the hidden session up, waiting behind another question, and
// Haiku's own answer. This is the line that says WHERE a slow turn was slow.
async function timed(tag, p) {
    const s = Date.now();
    let failed = '';
    try { return await p; }
    catch (e) { failed = e.message; throw e; }
    finally {
        const data = { ms: Date.now() - s };
        const c = haiku.lastCall && haiku.lastCall();
        const b = haiku.lastBoot && haiku.lastBoot();
        if (c && c.at >= s) data.haiku = { ensureMs: c.ensureMs, waitMs: c.waitMs, pasteMs: c.pasteMs, answerMs: c.answerMs, promptChars: c.promptChars, answerChars: c.answerChars, timedOut: c.timedOut || undefined, retried: c.retried || undefined, notReceived: c.notReceived || undefined };
        if (b && b.at >= s) data.bootMs = b.ms;
        if (failed) data.failed = failed.slice(0, 200);
        trace(tag, data);
    }
}

// The Haiku brain wears the same shape as hermes.js, so every path below is
// unchanged: it is "loaded" as far as TALK is concerned (there is no card to
// weigh), keepWarm starts the hidden session, unload ends them all. It has no
// chooseAction, so the model router is skipped - the parser decides actions.
const haikuShape = {
    converse: (a) => haiku.converse({ ...a, session: (a && a.session) || state.session }),
    narrateSession: (a) => haiku.narrateSession(a),
    ping: async () => true,
    loaded: async () => true,
    keepWarm: () => haiku.warm(state.session),
    // Waits for a question in flight, and skips the sweep if a new
    // conversation opened meanwhile (lib/haikuBrain.js closeAll).
    unload: () => haiku.closeAll({ stillClosed: () => !state.open }),
};
function usingHaiku() { return BRAIN === 'haiku' && haiku.ready(); }
// The local model only when he CHOSE it (TALK_BRAIN=local). A Haiku brain that
// is not ready is no brain, never a silent fall back onto the graphics card:
// "no quiero que siga cargando el modelo local" (2026-09-25).
function hermes() { return usingHaiku() ? haikuShape : BRAIN === 'local' ? deps.hermes : null; }
function brainName() { return BRAIN === 'local' ? 'the local model' : 'Haiku'; }

// ── the memory gate ─────────────────────────────────────────────────────────
// Answers three separate questions, because they have three different remedies:
// is Ollama even running, is the model already in memory, and if it is not, is
// there room for it right now.
async function preflight() {
    // No graphics card involved: nothing to weigh.
    if (usingHaiku()) return { ok: true, resident: true, why: 'the brain is a hidden Haiku session' };
    const h = hermes();
    if (!h || typeof h.converse !== 'function') {
        return { ok: false, why: BRAIN === 'local' ? 'the local model is not wired into this server' : 'the Haiku brain is not ready on this server' };
    }
    const up = await h.ping(3000);
    if (!up) {
        return { ok: false, why: 'Ollama is not running - start it and try again', fixable: true };
    }
    let resident = false;
    try { resident = await h.loaded(MODEL); } catch { resident = false; }
    if (resident) {
        // Already paid for. Nothing to weigh.
        return { ok: true, resident: true, why: 'the model is already in memory' };
    }
    const g = await gpu.sample();
    if (g && g.available && g.memTotal) {
        const free = g.memTotal - (g.memUsed || 0);
        if (free < MIN_FREE_MIB) {
            return {
                ok: false,
                busy: true,
                free,
                why: `the graphics card is busy - ${Math.round(free / 1024 * 10) / 10} GB free and the voice model needs about ${Math.round(MIN_FREE_MIB / 1024 * 10) / 10} GB. Close what is rendering and try again.`,
            };
        }
        return { ok: true, resident: false, free };
    }
    // No nvidia-smi (or it failed): let it through. Ollama falls back to CPU on
    // a box with no usable card, which is slow but harms nothing.
    return { ok: true, resident: false, free: null };
}

// Nobody can hear it: no window has polled for IDLE_MS. Silence is NOT this.
function abandoned({ now, lastPollAt }) {
    return !lastPollAt || now - lastPollAt >= IDLE_MS;
}

// One slow heartbeat for the life of the conversation: re-arm the model's
// keep_alive (only if it is already resident - the heartbeat never LOADS it),
// and let go only when no window is there any more. Called from many places for
// history's sake; it only ever keeps ONE timer.
function armIdle() {
    if (state.idleTimer) return;
    const beat = async () => {
        state.idleTimer = null;
        if (!state.open) return;
        if (abandoned({ now: Date.now(), lastPollAt: state.lastPollAt })) {
            console.log('[talk] no TSRCT window for a while - closing and unloading');
            close({ reason: 'nobody' }).catch(() => {});
            return;
        }
        const h = hermes();
        try {
            if (state.modelOk && h && h.loaded && await h.loaded(MODEL) && h.keepWarm) await h.keepWarm(MODEL, KEEP_ALIVE, WARM_MS, NUM_CTX);
        } catch { /* a missed beat is re-tried in HEARTBEAT_MS */ }
        if (state.open) armIdle();
    };
    state.idleTimer = setTimeout(beat, Math.min(HEARTBEAT_MS, IDLE_MS));
    if (state.idleTimer.unref) state.idleTimer.unref();
}

// Load the model NOW, in the background, so his first question is not the one
// that pays the ~2 minute cold load. Only after preflight said the card has room.
function preload() {
    const h = hermes();
    if (!h || !h.keepWarm || state.preloading) return;
    state.preloading = true;
    h.keepWarm(MODEL, KEEP_ALIVE, COLD_MS, NUM_CTX)
        .then(() => { if (state.open) state.warm = true; })
        .catch(e => console.log(`[talk] preload did not finish: ${e.message}`))
        .finally(() => { state.preloading = false; });
}

// "tesla, terminamos" / "chau tesla" / "terminamos". The whole sentence has to BE
// the goodbye: "terminamos el deploy y despues vemos" is news, not an ending.
function endsConversation(text) {
    const t = understand.flat(text).replace(/\b(listo|bueno|ok|dale)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const names = persona.ALIASES.map(a => understand.flat(a)).filter(Boolean).join('|');
    const bye = '(terminamos|cortamos|apagate|chau|adios|hasta luego|nos vemos|eso es todo|termina la conversacion|terminar la conversacion|fin de la conversacion)';
    // "chau" / "adios" on their own are too common to end anything: they need the name.
    if (/^(chau|adios|hasta luego|nos vemos)$/.test(t)) return false;
    return new RegExp(`^(?:(?:${names})\\s+)?${bye}(?:\\s+(?:${names}))?$`).test(t);
}

// ── the attached session ────────────────────────────────────────────────────

// A session name arrives from the browser and is about to become a tmux target
// AND a model input, so it is checked as both. SecretCo is refused by NAME here and
// by CONTENT in screenOf(): the pane of an SecretCo session must never reach a
// model, and the name alone is enough to know.
function sessionGuard(name) {
    const s = String(name || '').trim();
    if (!s) return '';
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(s)) throw new Error('that does not look like a session name');
    restrictedGuard.assertNotRestricted('talk (session)', s);
    return s;
}

// What is on that screen right now, in words, plus whether the turn is still
// running. Throws only for an SecretCo refusal — a pane that cannot be captured
// (the session died, tmux said no) is an absence, not an error.
function screenOf(session) {
    if (!session || typeof deps.capture !== 'function') return null;
    let raw = '';
    try { raw = deps.capture(session, CAPTURE_LINES); } catch { return null; }
    if (!raw || !String(raw).trim()) return null;
    const working = paneShape.looksLikeWorking(paneShape.tailOf(raw, 25));
    const text = paneShape.readableTail(raw, { lines: SCREEN_LINES, chars: SCREEN_CHARS });
    // The pane is content, and this is the doorway it would use to reach a
    // model. Fail closed: the caller stops watching rather than narrating it.
    try { restrictedGuard.assertNotRestricted('talk (session screen)', text); }
    catch (e) { e.restrictedText = text; throw e; }
    return { text, working };
}

// ── it does not say the same thing twice in a minute ────────────────────────
// Compared on the flattened text, so "Sigue con los tests." and "sigue con los
// tests" count as the same sentence — which, out loud, they are.
const REPEAT_MS = Number(process.env.TALK_REPEAT_MS || 90000);
function saidRecently(text) {
    const key = understand.flat(text).slice(0, 120);
    const now = Date.now();
    state.recent = (state.recent || []).filter(x => now - x.at < REPEAT_MS);
    return state.recent.some(x => x.key === key);
}
function remberSaid(text) {
    state.recent = state.recent || [];
    state.recent.push({ key: understand.flat(text).slice(0, 120), at: Date.now() });
    if (state.recent.length > 12) state.recent = state.recent.slice(-12);
}

// Something to be SAID, queued for whichever panel is listening. The frontend
// pulls from here by id, so a narration that arrives while he is mid-sentence
// waits its turn instead of talking over him. `urgent` (2026-10-14) is the one
// exception the orb lets through while he talks or dictates: a permission request,
// because a session stopped on a card is waiting on him, and progress is not.
function pushSay(text, kind, { urgent } = {}) {
    state.seq += 1;
    state.spool.push({ id: state.seq, text, voice: voiceOf(text), kind: kind || 'session', at: Date.now(), ...(urgent ? { urgent: true } : {}) });
    if (state.spool.length > 20) state.spool = state.spool.slice(-20);
    return state.seq;
}

// One look at the pane. Everything here is local and cheap; the model is only
// woken on the one transition that means "a turn just finished".
async function watchTick() {
    if (!state.open) return;
    // Enforced HERE because the watcher is the only thing still ticking once he
    // stops talking — the idle timer can be re-armed by narrations, this cannot.
    if (MAX_SILENT_MS > 0 && state.lastUserAt && Date.now() - state.lastUserAt > MAX_SILENT_MS) {
        console.log('[talk] half an hour without a word from him - closing and unloading');
        close({ reason: 'silent' }).catch(() => {});
        return;
    }
    if (!state.watch || !state.session) return;
    if (state.busy || state.narrating) return;
    // The PC worker's results are announced by lib/teslaHands.js; narrating its
    // session on top said each one twice (review #11, 17:28).
    if (state.session === HANDS_SESSION) return;
    let s = null;
    try {
        s = screenOf(state.session);
    } catch (e) {
        // An SecretCo pane. Stop looking at it entirely and say why.
        state.watch = false;
        state.session = '';
        state.lastError = e.message;
        return;
    }
    if (!s) return;
    const was = state.lastWork;
    state.lastWork = s.working;
    // A finished turn is REMEMBERED rather than narrated on the spot. The floor
    // below can skip a tick, and a transition seen once and dropped because it
    // was 3 seconds too early is a finished turn he never hears about.
    if (was === true && !s.working) { state.pending = true; state.pendingAt = Date.now(); }
    // LIVE: he asked to be able to keep talking WHILE it works, which only makes
    // sense if the other side keeps talking too. So a running turn gets an
    // occasional sentence about what changed — far slower than the tick, and
    // only in the mode he turned on, because this one does wake the model.
    const live = s.working && state.live && !state.pending
        && Date.now() - state.lastNarrateAt >= LIVE_MS
        && s.text && s.text !== state.lastScreen;
    if (!live) {
        if (s.working || !state.pending) return;
        if (Date.now() - state.lastNarrateAt < NARRATE_MIN_MS) return;
        if (!s.text || s.text === state.lastScreen) { state.pending = false; return; }
    }
    const h = hermes();
    if (!h || typeof h.narrateSession !== 'function') return;
    // Narrating is the one thing here that needs the model. With Ollama off or
    // the card busy, the watcher stays silent instead of erroring every turn.
    if (!(await ensureModel({ soft: true })).ok) return;
    state.narrating = true;
    if (!live) state.pending = false;
    const n0 = Date.now();
    try {
        const said = await h.narrateSession({
            screen: s.text,
            session: state.session,
            state: live ? 'working' : 'idle',
            context: sessionContext(state.session),
            progress: live,
            lang: state.lang,
            model: MODEL,
            numCtx: NUM_CTX,
            timeoutMs: await answerLimit(h),
            keepAlive: KEEP_ALIVE,
        });
        // In LIVE mode an empty answer is a real answer: nothing worth
        // interrupting him for. The screen still counts as seen, so the next
        // ping compares against it rather than repeating this one.
        if (!said) { if (live) { state.lastScreen = s.text; state.lastNarrateAt = Date.now(); } return; }
        // A narration interrupts him while he is doing something else, so the
        // shape matters here more than anywhere: one or two sentences, never a
        // list of what changed.
        const reply = speech.shape(said);
        if (restrictedGuard.mentionsRestricted(reply)) { logRefusal('a narration', reply); state.lastError = 'a narration was dropped by the SecretCo contract'; return; }
        state.lastScreen = s.text;
        state.lastNarrateAt = Date.now();
        state.warm = true;
        // A run of small changes on screen produces the same sentence twice, and
        // hearing it twice is worse than hearing nothing: it sounds broken. The
        // screen still counts as seen, so this is a silence, not a retry.
        // Not only the LAST one: a slow build alternating between two states
        // said "sigue con los tests" four times in a row with another line
        // between them, and the last-one-only test let every one of them out.
        if (saidRecently(reply)) return;
        state.lastSaid = reply;
        remberSaid(reply);
        pushSay(reply, live ? 'live' : 'session');
        const c = haiku.lastCall && haiku.lastCall();
        const id = state.seq;
        teslaLog.narration({ id, session: state.session, live, said: reply, ms: Date.now() - n0,
            haiku: c && c.at >= n0 ? { ensureMs: c.ensureMs, waitMs: c.waitMs, answerMs: c.answerMs } : undefined,
            // From the session finishing its turn to this line being ready to say.
            sinceTurnEndedMs: !live && state.pendingAt ? Date.now() - state.pendingAt : undefined });
        state.turns.push({ role: 'assistant', content: reply, at: Date.now() });
        // Listening counts as being here, but only if a panel is actually open.
        // A tab that died mid-build would otherwise re-arm the idle timer on
        // every finished turn and pin the model for the rest of the day.
        if (Date.now() - state.lastPollAt < POLL_ALIVE_MS) { state.lastAt = Date.now(); armIdle(); }
    } catch (e) {
        state.lastError = e.message;
    } finally {
        state.narrating = false;
    }
}

function startWatch() {
    if (state.watchTimer) return;
    state.watchTimer = setInterval(() => { watchTick().catch(() => {}); }, WATCH_MS);
    if (state.watchTimer.unref) state.watchTimer.unref();
}

function stopWatch() {
    if (state.watchTimer) { clearInterval(state.watchTimer); state.watchTimer = null; }
    state.lastWork = null;
    state.lastScreen = '';
}

// Point it at a session (or at nothing), without reopening the conversation.
// Her last line to him was a question, and recent enough to be what his yes answers.
function herQuestionIsOpen() {
    const last = state.turns[state.turns.length - 1];
    return !!(last && last.role === 'assistant' && /\?\s*$/.test(String(last.content || '').trim()) && Date.now() - (last.at || 0) < CONFIRM_MS);
}

// What the brain says when a line was not meant for it (haikuBrain BASE).
function notForMe(reply) { return /^\(?\s*silencio\s*\)?\s*\.?$/i.test(String(reply || '').trim()); }

function attach({ session, watch, toClaude, live } = {}) {
    if (session !== undefined) {
        const s = sessionGuard(session);
        if (s !== state.session) {
            state.session = s; state.lastWork = null; state.lastScreen = '';
            // Start that folder's brain NOW, not inside his next question: a switch
            // used to cost 6.6-6.8 s of cold boot in the very next turn (Tesla
            // review #6). Same start the question would make, shared, never twice.
            if (state.open && usingHaiku()) haiku.warm(s).catch(() => {});
        }
        if (s) state.last.session = s;      // "esa" means the one he just pointed at
    }
    if (watch !== undefined) state.watch = !!watch;
    if (toClaude !== undefined) state.toClaude = !!toClaude;
    if (live !== undefined) state.live = !!live;
    if (state.open && state.watch && state.session) startWatch(); else stopWatch();
    return { ok: true, session: state.session, watch: state.watch, toClaude: state.toClaude, live: state.live };
}

// ── opening without paying for it ───────────────────────────────────────────
// Since the parser answers most of what he says, and a pressed button carries
// its own sentence, a whole conversation can now happen with OLLAMA OFF. That
// matters most at six in the morning: the phone rings, he answers, the brief is
// read by Piper (CPU), it offers to open the board and he says "dale" — and
// nothing in that costs a second of GPU or a 130-second cold load.
//
// So the conversation opens LIGHT, and the model is loaded by the first thing
// that actually needs one. open() below is still the panel's button: that one
// asks about the card up front, because the panel's job is to say whether
// talking is going to cost him his memory.
function openLight(session) {
    if (!state.open) {
        state.open = true;
        state.openedAt = Date.now();
        state.turns = [];
        state.spool = [];
        teslaLog.opened({ light: true, session: session || '' });
    }
    if (session !== undefined) attach({ session });
    state.lastAt = Date.now();
    state.lastUserAt = state.lastUserAt || Date.now();
    state.lastPollAt = state.lastPollAt || Date.now();
    state.closedReason = '';
    armIdle();
}

// The time limit for ONE model call, from what Ollama really holds right now
// (/api/ps, ~1 ms, no GPU work). `state.warm` alone went stale: the model unloads
// itself after a quiet spell, the flag still said warm, a cold load got the 90s
// warm limit and TSRCT hung up at 93s mid-load (2026-09-24). Unsure = cold.
async function answerLimit(h) {
    let resident = false;
    try { resident = !!(h && h.loaded && await h.loaded(MODEL)); } catch { resident = false; }
    state.warm = resident;
    return resident ? WARM_MS : COLD_MS;
}

// Called right before anything that needs the model. Answers once per
// conversation; close() forgets it.
async function ensureModel({ soft } = {}) {
    if (state.modelOk) return { ok: true };
    // The WATCHER asks this too, and preflight spawns nvidia-smi. He is not
    // waiting on that one, so a failure holds it off for a minute instead of
    // asking the card again at every finished turn. A question from HIM always
    // tries, because he is standing there.
    if (soft && state.modelNoBefore && Date.now() < state.modelNoBefore) return { ok: false, why: state.lastError };
    const pre = await preflight();
    if (!pre.ok) {
        state.lastError = pre.why;
        state.modelNoBefore = Date.now() + 60000;
        return { ok: false, why: pre.why, busy: pre.busy };
    }
    state.warm = !!pre.resident;
    state.modelOk = true;
    preload();
    return { ok: true };
}

async function open(opts = {}) {
    // The session is settled BEFORE the model is touched: if it is an SecretCo
    // session this must refuse without having loaded anything.
    let wanted = state.session;
    try {
        if (opts.session !== undefined) wanted = sessionGuard(opts.session);
    } catch (e) {
        state.lastError = e.message;
        return { ok: false, why: e.message };
    }
    // LIGHT: open without asking the card anything. For the caller that would
    // rather have half an assistant than none — the six o'clock call, which
    // needs to hear him, press buttons and speak through Piper, and has no use
    // for the model at all. The model is still loaded later by the first thing
    // that needs one, and refused there if the card is busy.
    if (opts.light) {
        openLight(wanted);
        state.lastError = '';
        return { ok: true, light: true, warm: false, resident: false, voice: VOICE, keepAlive: KEEP_ALIVE, idleMs: IDLE_MS,
            session: state.session, watch: state.watch, toClaude: state.toClaude, live: state.live };
    }
    const pre = await preflight();
    if (!pre.ok) { state.lastError = pre.why; return { ok: false, ...pre }; }
    state.warm = !!pre.resident;
    state.modelOk = true;              // paid for here; ensureModel() will not ask again
    if (!state.open) {
        state.open = true;
        state.openedAt = Date.now();
        state.turns = [];
        state.spool = [];
        teslaLog.opened({ light: false, session: wanted || '', resident: !!pre.resident });
    }
    attach({
        session: wanted,
        watch: opts.watch !== undefined ? opts.watch : state.watch,
        toClaude: opts.toClaude !== undefined ? opts.toClaude : state.toClaude,
        live: opts.live !== undefined ? opts.live : state.live,
    });
    state.lastAt = Date.now();
    state.lastUserAt = Date.now();
    state.lastPollAt = Date.now();
    state.lastError = '';
    state.closedReason = '';
    armIdle();
    preload();
    return {
        ok: true,
        resident: !!pre.resident,
        free: pre.free != null ? pre.free : null,
        voice: VOICE,
        keepAlive: KEEP_ALIVE,
        idleMs: IDLE_MS,
        session: state.session,
        watch: state.watch,
        toClaude: state.toClaude,
        live: state.live,
        // A cold load is ~90s on this box and a warm answer ~2s. The panel says
        // which one he is in for instead of looking frozen.
        warm: !!pre.resident,
    };
}

// What the model is allowed to know about today. Deliberately small: the brief
// is the thing he asks about ("what did it say about the invoices?"), and a
// 12k-token context on an 8GB card is a slow answer for no gain.
function context() {
    const bits = [];
    try {
        const brief = deps.brief ? deps.brief() : '';
        if (brief) bits.push(`RESUMEN DE LA MANIANA:\n${String(brief).slice(0, 2500)}`);
    } catch { /* no brief is not an error */ }
    try {
        const s = deps.sessions ? deps.sessions() : null;
        if (s && s.length) bits.push(`SESIONES ABIERTAS AHORA: ${s.slice(0, 20).join(', ')}`);
    } catch { /* same */ }
    // So "what can you do?" is answered from the catalogue and not from
    // imagination — asked exactly that, it described itself and left out every
    // one of these.
    const can = manifest();
    if (can.length) bits.push(`LO QUE PODES HACER SI TE LO PIDE (y nada mas que esto):\n${can.map(a => `- ${a.says}`).join('\n')}`);
    const ctx = bits.join('\n\n');
    // The context is content too, and it is assembled from files this server
    // writes. If anything SecretCo ever reached it, it stops here.
    if (ctx && restrictedGuard.mentionsRestricted(ctx)) return '';
    return ctx;
}

// ── what this session IS ────────────────────────────────────────────────────
// The screen alone says what just happened; it does not say what any of it is
// FOR. "Ran the tests, one fails" is a fact; "the allocations test that has to
// pass before Thursday's deploy fails" is worth interrupting him for, and the
// difference is two lines of context, not a bigger model. The server supplies
// them (it owns the filesystem); this only shapes and guards them.
// The files the session just wrote ride along with its context (2026-10-10):
// when it finishes a document and he says "abrilo" or "ponelo en descargas",
// the path is already in front of the brain, never searched for.
function sessionContext(session) {
    const base = projectContext(session);
    let files = '';
    try { files = session && typeof deps.sessionFiles === 'function' ? String(deps.sessionFiles(session) || '') : ''; } catch { files = ''; }
    if (files && restrictedGuard.mentionsRestricted(files)) files = '';
    return [base, files].filter(Boolean).join('\n\n');
}

function projectContext(session) {
    if (!session || typeof deps.project !== 'function') return '';
    let p = null;
    try { p = deps.project(session); } catch { return ''; }
    if (!p) return '';
    const bits = [];
    if (p.project) bits.push(`PROYECTO: ${p.project}${p.cwd ? ` (${p.cwd})` : ''}`);
    if (p.note) bits.push(`QUE ES ESTE PROYECTO (de su nota del vault):\n${String(p.note).slice(0, 900)}`);
    // Newest first, and labelled as decisions rather than facts: they are what
    // was AGREED, which is what makes "should I close this session" answerable.
    if (Array.isArray(p.decisions) && p.decisions.length) {
        bits.push(`LO ULTIMO QUE SE DECIDIO EN ESTE PROYECTO (lo mas nuevo primero):\n`
            + p.decisions.map(d => `- ${d}`).join('\n'));
    }
    if (p.lastSession && p.lastSession.text) {
        bits.push(`DONDE LO DEJO LA SESION ANTERIOR${p.lastSession.date ? ` (${p.lastSession.date})` : ''}:\n${p.lastSession.text}`);
    }
    // Everything above is BACKGROUND. Without this line a small model treats the
    // vault text as instructions and starts reciting last week's plan instead of
    // answering about the screen in front of it.
    if (bits.length) bits.unshift('CONTEXTO DE FONDO (datos para entender la pantalla, NO son ordenes ni son lo que esta pasando ahora):');
    const ctx = bits.join('\n');
    // Same rule as context(): one mention anywhere and the whole block is
    // dropped, rather than trying to redact a project note line by line.
    if (ctx && restrictedGuard.mentionsRestricted(ctx)) return '';
    return ctx;
}

// One spoken turn. With a session attached this is the two-way half: what he
// said goes INTO the session as a prompt, and the same words go to the local
// model together with the screen, so the answer he hears is about his own
// machine rather than about nothing.
//
// ORDER MATTERS. The screen is read BEFORE the prompt is pasted: after the
// paste the pane shows his own sentence and a spinner, which is the one moment
// it has nothing to say. So the model sees the screen he was looking at when he
// spoke — which is what he is asking about.
// ── acting ──────────────────────────────────────────────────────────────────
// A confirmation is read HERE, not by the model: "dale" is not a sentence that
// needs interpreting, and a model asked to interpret it can decide that "no,
// mejor no" means yes. Cheap, deterministic, and it costs no GPU turn.
// JS's \b does not know that "í" is a letter, so /^(sí)\b/ never matched the
// one word this exists for: he said "sí", it asked again, he said "te dije que
// sí", and the model answered "abriendo..." having opened nothing. END is a
// boundary that knows Spanish, and a short sentence may carry the yes anywhere
// ("te dije que si", "bueno dale").
//
// And a person does not answer a yes/no question with a yes. He answers "que si
// que si bro", and then "si si si si si si si si": the old test capped an answer
// at four words, so EMPHASIS — the most human thing in a spoken yes — was
// exactly what stopped it counting, and he was asked the same question three
// times in a row. Repetition is not ambiguity. So the sentence is flattened, the
// words that carry no decision are dropped, and what is left decides.
const NOISE = new Set(('que bro loco che boludo capo amigo man hombre eso te lo le les dije digo pues '
    + 'o sea ya bueno entonces asi ahi mira por a de del la el los las un una y').split(' '));
const YES_W = /^(si+|sip|sep|dale|dele|obvio|claro|ok|okey|okay|listo|hacelo|hazlo|mandale|mandalo|abrila|abrilas|abrilo|cerrala|cerralas|confirmo|confirmado|correcto|adelante|afirmativo|va|vamos|vale|perfecto|exacto|joya|barbaro|procede|proceda|procedele|segui|avanza|avanzale|metele|arranca|arrancale|ejecuta|ejecutalo|lanzala|lanzalo|andale|hacela)$/;
const NO_W = /^(no+|nop|nope|nunca|cancela|cancelalo|cancelala|dejalo|deja|dejala|olvidalo|para|pare|negativo|tampoco)$/;

function words(t) {
    const s = String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]+/g, ' ')
        // the two-word ones, flattened before anything is thrown away
        .replace(/\bde una\b/g, 'si').replace(/\bpor supuesto\b/g, 'si')
        .replace(/\bni ahi\b/g, 'no').replace(/\bmejor no\b/g, 'no').replace(/\bpara nada\b/g, 'no');
    return s.split(/\s+/).filter(w => w && !NOISE.has(w));
}

function decide(t) {
    const w = words(t);
    if (!w.length) return null;
    const yes = w.filter(x => YES_W.test(x)).length;
    const no = w.filter(x => NO_W.test(x)).length;
    if (!yes && !no) return null;
    // Everything he said was a yes (or a no), however many times he said it.
    if (yes && !no && yes === w.length) return 'yes';
    if (no && !yes && no === w.length) return 'no';
    // Mixed, or buried in a longer sentence: only a SHORT answer counts, and the
    // opening word decides it. "no veo que hayas abierto la sesion" opens with a
    // no and is a complaint, not a cancellation.
    if (w.length > 4) return null;
    if (NO_W.test(w[0])) return 'no';
    if (YES_W.test(w[0])) return no ? 'no' : 'yes';   // "claro que no" is a no
    return null;
}

// "voy a revisar", "dejame ver", "ahora lo abro" - an announcement of work.
const PROMISES = { test: (s) => /^(ok[,. ]+|dale[,. ]+|listo[,. ]+|entendido[,. ]+|perfecto[,. ]+)?(voy a|ahora (voy|lo|la|le)|dejame|ya (lo|la|le) (reviso|abro|mando|hago|pido))\b/i.test(String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()) };
// "ya esta en marcha", "ya lo lance", "le pedi a Opus" - said with no action behind it.
// "le acabo de decir que lo suba" / "ya se lo dije" (2026-10-05): a send claimed
// with no ACCION behind it, and he had to say "no veo que se lo hayas dicho".
const CLAIMS_STARTED = { test: (s) => /\b(en marcha|ya (esta|lo|la|le|las|los) ?(lan[zc]|arran[cq]|ped|mand|corr|abr)\w*|ya (arran[cq]|lan[zc]|empe[zc]|abr)\w*|le ped[i] a (opus|sonnet|haiku)|lo estoy (lanzando|armando|corriendo)|espero (a )?que \S+ (respond|contest)\w*|acabo de (decir|mandar|pedir|pasar|preguntar|enviar|escribir)\w*|ya (se )?(lo|la|le|les) (dij|mand|ped|pregunt|pas|escrib|envi)\w*)/i.test(String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')) };
// "Le escribo a la sesion daily-tasks que... dale?" with no ACCION behind it
// (Tesla review #4). The promise guard skips anything with a question mark, so
// his yes had nothing pending to say yes TO. A yes-question that announces an
// action of its own needs the action attached, like any confirmation.
const ASKS_TO_ACT = { test: (s) => {
    const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    // An OFFER with no question mark is the same thing (Tesla review #10: "Puedo
    // hacerlo con la PC ... buscando a Eminem y dandole play." -> his "si" -> the
    // gate asked AGAIN, two yeses for one song).
    if (/\b(puedo hacerlo|lo puedo hacer|lo podria hacer|podria hacerlo|puedo (buscar|abrir|poner|hacer|mandar|escribir|leer|mover)\w*|si queres,? (lo|la|te|le) \w+)\b/.test(t)) return true;
    // A question that offers TWO things ("...a marketing-seo, o que se lo pida a
    // Opus?") or no thing at all ("¿queres que le pase algo?") has no one action
    // to attach; nudged, it came back as an apology for nothing (review #14).
    const q = t.slice(t.lastIndexOf('¿') + 1);
    if (/,\s*o (que|a|al|si|le|lo|la|se)\b/.test(q) || /\b(algo|alguna cosa)\b/.test(q)) return false;
    return /\?\s*$/.test(t) && /\b(le (escribo|mando|digo|paso|pido|pregunto|apruebo)|le voy a (pedir|mandar|decir|escribir|pasar|preguntar)|te (abro|mando|armo|paso)|(abro|cierro|corro|lanzo|apruebo|rechazo) (una|la|el|las|los)|lo (mando|abro|corro)|quer[e]?s que (le|les|lo|la) (diga|mande|escriba|pase|pida|pregunte|apruebe|abra|cierre|frene))\b/.test(t);
} };
// What survives the retry (review #14). A QUESTION claims nothing: when the retry
// brings no action, the question stays as it was (19:01, "¿Querés que le pase algo
// a la sesión?" -> "Tenés razón, me equivoqué ... Leon dijo sólo 'hola güera'").
// A promise with no action is a lie, so the honest retry replaces it.
function afterNudge(first, second) {
    if (!second) return first;
    if (second.action) return second;
    if (/\?\s*$/.test(String(first && first.say || '').trim())) return first;
    return second;
}
// A claim of a start with nothing behind it (review #14). A send REALLY made in
// the last CONFIRM_MS is what "ya le mande tu confirmacion" is about (21:36, true,
// and it was replaced by "Perdon, no lance nada todavia"). Still false while the
// action waits for his yes, and false with no run at all.
function falseClaim(reply, { ranThisTurn, lastRunAt, pending, now = Date.now() } = {}) {
    if (ranThisTurn || !CLAIMS_STARTED.test(reply) || /\?/.test(String(reply || ''))) return false;
    if (pending) return true;
    return !(lastRunAt && now - lastRunAt < CONFIRM_MS);
}
const NO = { test: (t) => decide(t) === 'no' };
const YES = { test: (t) => decide(t) === 'yes' };

// ── a question is not an order ──────────────────────────────────────────────
// He asked "cual es el estado actual del proyecto" and was answered with
// "queres que abra una sesion nueva en images?". Nothing was broken: the router
// read a sentence with the word "proyecto" in it, and the only action whose
// description carried that word was the one that opens sessions. A 7B will keep
// making that trade — the fix is not a better prompt, it is that NOTHING WITH A
// SIDE EFFECT FIRES WITHOUT A WORD THAT ASKS FOR IT. Reading is still free.
const ORDER = /(abr[ií]|abrir|abrime|abril[ao]|cre[aá]r?|arranc|lev[aá]nt|cerr[aá]|cerrar|cerrame|cerral[ao]|mat[aá]|kill|fren[aá]|termin[aá]|mand[aá]|manda|decile|dile|dec[ií]le|escribile|escrib[ií]|tipe[aá]|pon[eé]le|pas[aá]le|pedile|avisale|contale|preguntale|hacelo|hazlo|ejecut|corr[eé]|reinici)/i;

// What the model is allowed to know about the buttons: names and plain words.
// The action list as Haiku reads it once, when its session starts.
// Session names are NOT listed here (Tesla review #3, 2026-10-08): this text is
// written once, when a brain starts, and tsrct-2 - opened 30 s earlier - was
// "not in my list" although every turn's "Sesiones abiertas ahora" had it.
function catalogueText() {
    return manifest().map(a => {
        let live = new Map();
        try { live = new Map(actions.liveArgs(a.name)); } catch { live = new Map(); }
        const args = (a.args || []).map(k => (live.get(k) === 'session' ? `${k} (una de las "Sesiones abiertas ahora" de cada mensaje)`
            : live.get(k) === 'place' ? `${k} (una carpeta de CARPETAS DE ${OWNER_UP} o una de las "Sesiones abiertas ahora" de cada mensaje)`
                : a.choices && a.choices[k] ? `${k} (uno de: ${a.choices[k].join(', ')})` : k)).join('; ');
        return `- ${a.name}: ${a.says}. args: ${args || 'ninguno'}${a.confirm ? ' [cambia algo: TSRCT le pregunta antes]' : ''}`;
    }).join('\n');
}

function manifest() {
    if (!ACTIONS_ON) return [];
    try { return actions.manifest(); } catch { return []; }
}

// Runs an action and turns whatever happens into something sayable. The gate's
// refusals are already written for a person ("no hay ninguna sesion llamada
// X"), so they ARE the answer — no second model call to explain a failure.
// The last thing named out loud, so the next sentence can point at it. Taken
// from the VALIDATED arguments, never from what he said: "la de hog" is
// remembered as `harbor`, which is the name the next sentence will need.
function remember(args) {
    if (!args) return;
    const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
    if (args.session) state.last.session = String(one(args.session));
    if (args.project) {
        const p = one(args.project);
        if (p && typeof p === 'object') state.last[p.kind === 'session' ? 'session' : 'project'] = String(p.name);
        else if (p) state.last.project = String(p);
    }
}

async function runAction(name, args, confirmed) {
    try {
        const a0 = Date.now();
        const r = await actions.run(name, args, { confirmed });
        trace(r && r.needsConfirm ? 'action-needs-yes' : 'action-ran', `${name}${confirmed ? ' (confirmed)' : ''} ${Date.now() - a0}ms ${JSON.stringify(r && r.args || args || {}).slice(0, 160)}`);
        if (r && r.args) remember(r.args);
        // So a bare "no me gusta" right after reads as about the song (understand.js).
        if (name === 'play_music' && r && !r.needsConfirm && r.ok !== false) state.last.musicAt = Date.now();
        // What this conversation has actually DONE, in order. It is what
        // "guarda esto como mi setup de la maniana" turns into a recipe, so it
        // holds the VALIDATED arguments — a setup can only contain real values.
        if (r && r.ok && r.action) {
            state.did.push({ name: r.action, args: r.args || {} });
            if (state.did.length > 12) state.did = state.did.slice(-12);
        }
        if (r.needsConfirm) {
            state.pendingAction = { name: r.action, args: r.args, says: r.says, at: Date.now() };
            return { ask: confirmLine(r.says) };
        }
        state.pendingAction = null;
        state.runs = (state.runs || 0) + 1;      // something REALLY ran (see CLAIMS_STARTED)
        state.lastRunAt = Date.now();             // ...and when (falseClaim)
        // A button in the page carries the sentence to say when it is pressed,
        // so pressing one costs no model turn at all: the answer is already
        // written and it is the truth about what was queued.
        const following = follow(followTarget(r.action, r.value));
        if (r.value && r.value.say) return { did: r.action, value: r.value, say: r.value.say };
        // A send answers from its RESULT, never from the screen. Handed the pane
        // a moment after the paste, before the session showed it, Haiku read
        // {"sent":true} as "No se envio" every time (2026-09-25).
        if (r.action === 'say_to_session' || r.action === 'say_to_sessions') {
            return { did: r.action, value: r.value, say: sentSentence(r.value) + (following ? ' Te aviso cuando conteste.' : '') };
        }
        return { did: r.action, value: r.value };
    } catch (e) {
        state.pendingAction = null;
        // One argument short: ask him for it and remember the rest, so his next
        // sentence IS the answer ("De que proyecto?" - "tsrct") and costs no
        // model turn. The filled action still goes through the confirmation.
        trace(e.missing ? 'action-missing-arg' : e.internal ? 'action-crashed' : 'action-refused', `${name}: ${e.message}`);
        if (e.missing) {
            state.needArg = { name: e.missing.action, key: e.missing.key, args: e.missing.args, at: Date.now() };
            return { ask: e.message };
        }
        if (e.internal) {
            console.error(`[talk] action ${name} crashed:`, e.stack || e.message);
            return { failed: 'se rompio algo de mi lado al intentarlo, asi que quedo sin hacer' };
        }
        return { failed: e.message };
    }
}

// Watch the session she just touched (lib/follow.js). Returns whether its answer will come.
function follow(session) {
    if (!session || !state.open) return false;
    if (state.session === session && state.watch) return true;
    try { attach({ session, watch: true }); } catch { return false; }
    trace('follow', session);
    return true;
}

function sentSentence(v) {
    if (!v) return 'Listo, se lo mande.';
    if (!Array.isArray(v.sent)) return v.sent ? `Listo, se lo mande a ${v.session}.` : `No le llego a ${v.session}.`;
    const ok = v.sent.filter(s => s.ok).map(s => s.session);
    const bad = v.sent.filter(s => !s.ok).map(s => s.session);
    return (ok.length ? `Listo, se lo mande a ${ok.join(', ')}.` : '') + (bad.length ? ` No le llego a ${bad.join(', ')}.` : '');
}

// What this conversation really DID, for Haiku: a send answered by the code
// above never passes through its session, so without this it answers the next
// "ya se envio?" from its own memory, which says nothing was sent.
// Each line says when it was about ANOTHER session than the one he is watching
// now: a fresh brain read five skool-brain sends as "where sends go" (2026-10-05).
function doneNote(watching) {
    const d = state.did.slice(-6);
    if (!d.length) return '';
    const other = (x) => watching && x.args && typeof x.args.session === 'string' && x.args.session !== watching
        ? ` (eso fue en ${x.args.session}, NO en ${watching}, que es la que mira ahora)` : '';
    return 'LO QUE YA HICISTE EN ESTA CONVERSACION (real, verificado por el codigo; no lo dudes):\n'
        + d.map(x => `- ${x.name} ${JSON.stringify(x.args).slice(0, 200)}${other(x)}`).join('\n');
}

// The orders that are their own yes. Only these actions, only these verbs, and
// never behind a "no": "no le mandes nada" must stay a question.
// (?![a-z...]) instead of a closing \b: after an accented letter \b never matches.
// The ask-verbs (2026-10-05): "preguntale si...", "le puedes pedir que corra...",
// "pedirle que declare...", "decirle que lo suba..." were each answered "si o
// no?" - six of his eight sends that night, one of them answered "si si, te dije
// que si". Same rule as mandale: the order IS the yes, and the text and the
// session are still the ones the confirmation would have named.
const SEND_NOW = /\b(mand[aá](le|selo|lo|les|selos)?|envi[aá](le|selo|lo|les)?|pas[aá]le|pas[aá]selo|dec[ií]le|dec[ií]selo|decirle|escribile|peg[aá](le|selo)|preg[uú]nt[aá](le|selo)|preguntarle|ped[ií](le|selo)|p[ií]dele|pedirle|(le|se lo) (puedes|pod[eé]s) (pedir|decir|preguntar|mandar))(?![a-záéíóúñ])/i;
const DRAFT_NOW = /\b(redact[aá]\w*|arm[aá](me|lo)?|escrib[ií]me|prepar[aá](me|lo)?|investig[aá]\w*)(?![a-záéíóúñ])/i;
const NEGATED = /\bno\s+(se\s+)?(lo\s+|le\s+|la\s+|les\s+)?(mand|envi|pas|dec|escrib|peg|redact|arm|investig|pregunt|ped|pid)/i;
function saidDirectly(text, pend) {
    const t = String(text || '');
    if (!pend || NEGATED.test(t)) return false;
    if (pend.name === 'say_to_session' || pend.name === 'say_to_sessions') return SEND_NOW.test(t);
    if (pend.name === 'research_prompt') return pend.args && pend.args.send ? SEND_NOW.test(t) : (DRAFT_NOW.test(t) || SEND_NOW.test(t));
    return false;
}

// A send he did not aim goes to the session he is WATCHING (2026-10-05). He
// switched to winery-audits and said "decirle que lo explique en mis palabras";
// the winery brain was brand new, its only memory was "LO QUE YA HICISTE" - five
// sends to skool-brain - so it aimed there, with a Frog's Leap text, at the wrong
// project. Aimed by name ("decile a harbor", "la de seo") it stays where he said.
//
// Two exceptions (Tesla review #4, 2026-10-08). Tesla asked "Le escribo a la
// sesion daily-tasks ... dale?", he said "yes please do that", and the send was
// moved to hollysentials - the one on screen, which was not even open - and
// refused twice. A session named in the LAST exchange (his previous line or
// Tesla's own question) counts as named; and a watched session that is not open
// is never a better target than the one Haiku chose.
// Third exception (Tesla review #14): `asking` names the sessions with a question
// open to him right now. hands asked "¿Confirmás que querés que haga los pasos del
// Plan GEO en tu PC?" by voice, his "sí por favor" was aimed at hands as the brain
// was told to, and this moved it to marketing-seo because his yes named nobody.
function fixSession(args, target, said, { recent = '', open = null, asking = [] } = {}) {
    if (!args || !target || typeof args.session !== 'string' || !args.session || args.session === target) return args;
    if (Array.isArray(asking) && asking.includes(args.session)) return args;
    if (Array.isArray(open) && open.length && !open.includes(target)) return args;
    const flat = ' ' + `${said || ''} ${recent || ''}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ') + ' ';
    const parts = args.session.toLowerCase().split(/[^a-z0-9]+/).filter(p => p.length >= 3);
    if (flat.includes(` ${args.session.toLowerCase()} `) || parts.some(p => flat.includes(` ${p} `))) return args;
    return { ...args, session: target };
}

// "pedile que se ponga a investigar..." while watching a session is a message
// FOR that session (review #2, 2026-10-05): Haiku read "investigar" + new work
// and planned a separate task, then asked "que Sonnet investigue la tarea...?",
// which made no sense to him. An ask-verb with a session watched, aimed at one
// of the background jobs, goes back to Haiku as say_to_session. Asking for a
// PROMPT ("armale un prompt") or a NEW session stays what it is.
const HANDS_SESSION = 'hands';   // lib/teslaHands.js NAME
// The PC worker's newest spoken line was a question, said after her last answer:
// his next yes is for hands (review #14). Its lines arrive as 'bg' (announce).
function handsAsked(now = Date.now()) {
    const bg = [...state.spool].reverse().find(x => x.kind === 'bg');
    if (!bg || !/\?\s*$/.test(String(bg.text || '').trim()) || now - bg.at > CONFIRM_MS) return [];
    const last = [...state.turns].reverse().find(t => t.role === 'assistant');
    return last && (last.at || 0) > bg.at ? [] : [HANDS_SESSION];
}
const BACKGROUND_JOBS = new Set(['plan_task', 'research_prompt', 'look_into', 'workaround']);
function askedOfSession(name, said, target) {
    if (!target || !BACKGROUND_JOBS.has(name)) return false;
    const t = String(said || '');
    // "pedile a OPUS que haga una revision de mi maquina" is a job for a model, not
    // a message for the session he is watching (Tesla review #11: it was typed into tsrct).
    if (/\b(a|al|con)\s+(opus|sonnet|sonet|haiku)\b/i.test(t)) return false;
    if (NEGATED.test(t) || !SEND_NOW.test(t)) return false;
    return !/\bprompt\b|sesi[oó]n nueva|nueva sesi[oó]n|tarea nueva/i.test(t);
}

// He asked for the explanation, so the answer may be one (lib/speech.js LONG_*).
function wantsDetail(text) {
    const t = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    // A list or a summary he asked for counts too (Tesla review #10: "listame los
    // problemas" got two of eight). Short is for PC results, not for what he asked to hear.
    return /\b(explic\w*|contame (todo|bien|mas)|en detalle|con detalle|desde el principio|paso a paso|todo de una manera)/.test(t)
        || /\b(list\w*|enumer\w*|resum\w*|cuales (son|fueron|eran|hay)|todos los|todas las|y que mas|que mas|los (problemas|errores|pendientes|cambios)|las (tareas|cosas|novedades))\b/.test(t)
        // Reading something WHOLE (Tesla review #12: "leeme toda la conversacion" four
        // times, a one-line summary each time).
        || /\b(le[ei]\w*|describ\w*|transcrib\w*|cont[aá]\w*)\b.*\b(tod[oa]s?|enter[oa]s?|complet[oa]s?|textual\w*)\b/.test(t)
        || /\btodo lo que (hablamos|dijimos|habl\w*|dij\w*)\b/.test(t);
}

// "que paso, no te escuche" / "repetimelo": her LAST line again, word for word, no
// model (Tesla review #12: the brain did not know what she had said - it was a
// background line - and answered "lo que dijiste no llego completo").
const NOT_HEARD = { test: (s) => /^(que paso,? |perdon,? |eh,? )?(no te (escuche|oi|entendi)( bien| nada)?|repet\w*( eso| lo ultimo| por favor)?|que dijiste|como dijiste|que me dijiste)\??$/.test(String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[¿?!.]/g, '').trim()) };
function lastSaid() {
    const spoken = state.spool.length ? state.spool[state.spool.length - 1] : null;
    const turn = [...state.turns].reverse().find(t => t.role === 'assistant');
    if (spoken && (!turn || spoken.at >= (turn.at || 0))) return spoken.text;
    return turn ? turn.content : '';
}
// "textual / literal / palabra por palabra": the words themselves (review #13 - by
// default a whole conversation is EXPLAINED, his rule).
const LITERAL = /\b(textual\w*|literal\w*|palabra por palabra|tal cual|mensaje por mensaje)\b/i;
// The PC jobs a "whole thing" request is passed to (review #12).
const DETAIL_ACTIONS = new Set(['look_at_screen', 'look_into', 'do_on_pc']);

// The yes/no question when Haiku is the brain: its own sentence when it asked
// one, the template only when it did not. Its sentence names the things it put
// in the action, and his yes is still read by the code, not by the model.
function haikuConfirm(say, says) {
    const s = String(say || '').trim();
    return /\?/.test(s) ? s : confirmLine(says);
}

// The yes/no question, as short as it can be (2026-10-10, Leon: "la pregunta de
// confirmacion es super larga y me estresa tener que esperar 10 segundos solo
// para que termine de leer la pregunta"). It was "Queres que haga esto: <x>?
// Decime si o no." around every action; the wrapper said nothing he needed.
function confirmLine(says) {
    const s = String(says || '').trim().replace(/[.?!\s]+$/, '');
    return `¿${s.charAt(0).toUpperCase()}${s.slice(1)}?`;
}

// Is this sentence the ANSWER to the question it just asked ("which one?")?
// Short, and not a request of its own. "Short" depends on what was asked: one
// name is a few words, but the answer to "cuales 4?" is a list said out loud -
// "una en personal otra en tsrc" is six words, and the four-word cap sent it to
// a model that was still loading (2026-09-24).
function answerFits(need, clean) {
    const words = understand.flat(clean).split(' ').filter(Boolean);
    const action = actions.CATALOG.find(a => a.name === need.name);
    const type = String((action && action.args && action.args[need.key]) || '').replace(/\?$/, '');
    const cap = (type === 'projects' || type === 'sessions') ? 12 : 4;
    if (words.length > cap) return false;
    const own = understand.parse(clean, { here: state.session, last: state.last });
    return !(own && own.sure && own.name !== need.name);
}

// The few orders the parser reads with no doubt, that change nothing worth a
// question, and where the brain only added time (Tesla review #16): "poneme algo
// de lo-fi en spotify" waited 8.2 s for Haiku (19.5 s cold start included, 18.1 s
// in all) and Haiku then picked spotify_search, which plays nothing. These run
// straight from the parser, Haiku mode or not. Keep the list short: a misread
// here has no brain behind it.
const FAST_PARSER = new Set(['play_music', 'music_react']);
function fastPick(clean) {
    const heard = understand.parse(clean, { here: state.session, last: state.last });
    if (!heard || !heard.sure || !FAST_PARSER.has(heard.name)) return null;
    const a = actions.CATALOG.find(x => x.name === heard.name);
    return a && a.readOnly ? { name: heard.name, args: heard.args || {}, why: heard.why } : null;
}

// Addressed to the assistant BY NAME. A switch is the wrong instrument for
// "this one sentence is not for Claude": he is talking with his hands busy, and
// reaching for a button to ask "what is it doing?" and reaching for it again
// afterwards is how a line ends up pasted into a session mid-turn. Saying the
// name is the switch.
//
// The names themselves live in lib/persona.js, because they are part of WHO it
// is, not part of the plumbing: "hermes" is the engine's name and he never says
// it — he says House, dr casa, doc. A speech recognizer will produce a different
// one of those every day and all of them have to land here.
const ADDRESSED = persona.addressedPattern();

// The turn as the log sees it: ask() below does the work, this writes down
// what came in, what path it took and what went out - errors included.
async function ask(opts = {}) {
    const t0 = Date.now();
    state.trace = [];
    state.turnT0 = t0;
    const text = String(opts.text || '').trim();
    // Him flagging the last answer. Answered here, without the model, and the
    // turn it points at is the one before this.
    if (teslaLog.isFeedback(text) && !state.busy) {
        trace('feedback', (state.turns.slice(-1)[0] || {}).content || '');
        if (!state.open) openLight();
        const reply = 'Anotado. Lo vamos a revisar.';
        state.turns.push({ role: 'user', content: text, at: t0 }, { role: 'assistant', content: reply, at: Date.now() });
        state.lastUserAt = t0;
        const r = { ok: true, reply, voice: voiceOf(reply), ms: Date.now() - t0 };
        teslaLog.turn({ said: text, via: opts.via, session: state.session, toClaude: state.toClaude, files: 0, result: r, ms: r.ms, trace: state.trace });
        return r;
    }
    let r;
    try {
        r = await askTurn(opts);
    } catch (e) {
        trace('threw', e.message);
        teslaLog.turn({ said: text, via: opts.via, session: opts.session, toClaude: opts.toClaude, files: (opts.files || []).length, result: { ok: false, why: e.message }, ms: Date.now() - t0, trace: state.trace, threw: true });
        throw e;
    }
    const row = teslaLog.turn({ said: (r && r.said) || text, raw: text, via: opts.via, session: state.session, toClaude: opts.toClaude !== undefined ? !!opts.toClaude : state.toClaude, files: (opts.files || []).length, result: r, ms: Date.now() - t0, trace: state.trace });
    // The page reports its half of this turn's timing (speech, voice, mic) under this id.
    if (row && r && typeof r === 'object') r.turnId = row.id;
    return r;
}

async function askTurn({ text, session, home, toClaude, files, from }) {
    let clean = String(text || '').trim().slice(0, MAX_CHARS);
    // "teserac" is how the recogniser writes tsrct (lib/speech.js fromVoice).
    clean = speech.fromVoice(clean);
    { const l = langOf(clean); if (l) state.lang = l; }
    // What he attached in the orb (Sam's screenshots): only files TSRCT stored.
    let attached = [];
    try { attached = typeof deps.cleanFiles === 'function' ? deps.cleanFiles(files) : []; } catch { attached = []; }
    if (!clean) return { ok: false, why: 'nothing was said' };
    // Strip the vocative before the model sees it: "hermes, que esta haciendo"
    // is a question about the session, not a question about hermes.
    const addressed = ADDRESSED.test(clean);
    if (addressed) {
        const stripped = clean.replace(ADDRESSED, '').trim();
        // "hermes" on its own is him getting its attention, not an empty question.
        if (stripped) clean = stripped;
    }
    // Fail closed, and say which side refused.
    restrictedGuard.assertNotRestricted('talk (local model)', clean);
    // His goodbye ends it - the only way besides the END button. Checked on
    // what he SAID (name included), before the name is stripped.
    if (endsConversation(text)) {
        await close({ reason: 'said' });
        return { ok: true, reply: 'Listo, cierro. Cuando me necesites, toca el circulo.', voice: VOICE, ended: true };
    }
    if (state.busy) return { ok: false, why: 'still answering the last one' };
    let target = state.session;
    try {
        if (session !== undefined) target = sessionGuard(session);
    } catch (e) {
        return { ok: false, why: e.message };
    }
    // Open WITHOUT touching the card. The model is loaded further down, by the
    // first thing that actually needs one — and most turns no longer do.
    if (!state.open) openLight(target);
    else if (target !== state.session) attach({ session: target });
    // Watching nothing, "esta sesion" is the one on his screen (2026-10-24): looked
    // at for this turn, never watched - no news from a session she did not touch.
    if (!target && home) {
        try { target = sessionGuard(home); trace('looks-at', target); } catch { target = ''; }
    }
    // Addressing it by name wins over the mode, in the direction that is always
    // safe: it can keep a line OUT of the session, never put one in.
    const wantClaude = addressed ? false : (toClaude !== undefined ? !!toClaude : state.toClaude);
    const h = hermes();
    state.busy = true;
    const t0 = Date.now();
    try {
        const history = state.turns.slice(-MAX_TURNS * 2)
            .map(t => ({ role: t.role, content: t.content }));

        // ── does this sentence ASK for something? ───────────────────────────
        // Three ways in, cheapest first. Only the third one costs a model turn,
        // and it is skipped entirely for the common case (he is just talking).
        let acted = null;
        let haikuReply = null;
        let fast = null;                     // an order the parser runs without the brain (fastPick)
        const pend = state.pendingAction && (Date.now() - state.pendingAction.at) < CONFIRM_MS
            ? state.pendingAction : null;
        if (!pend) state.pendingAction = null;
        let need = state.needArg && (Date.now() - state.needArg.at) < CONFIRM_MS ? state.needArg : null;
        state.needArg = null;
        // Only a short reply is an ANSWER to "which one?". A whole new question
        // ("cual es la lista de tareas para hoy") is a new request, and reading it
        // as a project name trapped him in "No conozco eso" for five turns in a
        // row (2026-09-21). Same if the parser recognises it as its own request.
        if (need && !NO.test(clean) && !answerFits(need, clean)) need = null;
        // With Haiku as the brain his answer to "which ones?" goes back to Haiku,
        // which asked it and knows what it meant. The code read "cualquiera" as
        // ONE project and opened one of the four (2026-09-24).
        if (usingHaiku() && !wantClaude) need = null;
        ({ acted, haikuReply, fast } = await decideTurn({ need, clean, pend, wantClaude, from, target, attached, h }));
        // A question it has to ask him is the whole answer for this turn: no
        // narration on top, or it buries the question under a paragraph.
        if (acted && acted.ask) {
            state.turns.push({ role: 'user', content: clean, at: t0 });
            state.turns.push({ role: 'assistant', content: acted.ask, at: Date.now() });
            state.lastAt = Date.now();
            state.lastUserAt = t0;
            armIdle();
            return { ok: true, reply: acted.ask, voice: voiceOf(acted.ask), ms: Date.now() - t0, asking: true };
        }
        // A pressed button answers itself. No screen read, no model, no wait —
        // and `do` rides back on this same response, so the page presses it
        // before the sentence has finished being spoken.
        if (acted && acted.say) {
            state.turns.push({ role: 'user', content: clean, at: t0 });
            state.turns.push({ role: 'assistant', content: acted.say, at: Date.now() });
            state.lastAt = Date.now();
            state.lastUserAt = t0;
            state.lastSaid = acted.say;
            armIdle();
            return { ok: true, reply: acted.say, voice: voiceOf(acted.say), ms: Date.now() - t0, do: uiActions.pending() };
        }
        let screen = null;
        let scrState = 'idle';
        let letGo = '';
        if (target) {
            try {
                const s = screenOf(target);
                if (s) { screen = s.text; scrState = s.working ? 'working' : 'idle'; }
            } catch (e) {
                // That pane carries SecretCo. Refusing the QUESTION left him asking
                // the same thing over and over and being told the same thing —
                // the session is what is refused, so let it go and answer him
                // without it. The screen still never reaches the model.
                logRefusal(`the screen of ${target}`, e.restrictedText || '');
                letGo = target;
                attach({ session: '' });
                target = '';
            }
        }
        // Into the session, as if he had typed it. sendToTmuxSession answers
        // with {success}; a refusal is worth hearing about, not worth aborting
        // the spoken half over.
        let sent = null;
        if (wantClaude && target && typeof deps.send === 'function') {
            try { sent = deps.send(clean, target); } catch (e) { sent = { success: false, error: e.message }; }
            // The pane is about to go busy. Saying so now means the watcher
            // still reports this turn even if it finishes between two ticks.
            if (sent && sent.success) state.lastWork = true;
            trace('typed-into-session', `${target}: ${sent && sent.success ? 'ok' : (sent && sent.error) || 'failed'}`);
        }
        const forwarded = !!(sent && sent.success);
        // What just happened, in the model's own input, so the spoken answer is
        // about the real result instead of about the intention.
        // With nothing done this turn, it is told so: an 8B that has just been
        // talking about opening a session will otherwise report having opened it.
        const actedNote = !acted ? (ACTIONS_ON ? '\n\n(En este turno NO ejecutaste ninguna accion. Si te pregunta por algo que pidio, no digas que lo hiciste ni que lo estas haciendo.)' : '') : (
            acted.failed ? `\n\nNO PUDISTE HACERLO. El motivo exacto, decilo tal cual: ${acted.failed}`
                : acted.cancelled ? `\n\nEL CANCELO: ${acted.cancelled}. Decile que no lo hiciste, en una frase.`
                    : `\n\nACABAS DE HACER ESTO (${acted.did}) y este es el resultado real; contaselo en una frase, sin inventar nada que no este aca:\n${JSON.stringify(acted.value).slice(0, 1800)}`);
        // From here on it needs the model. If it cannot have one, it still has
        // to answer: something may have just been DONE, and silence after an
        // action is the worst possible reply.
        const ready = await timed('ensure-model', ensureModel());
        if (!ready.ok) {
            // A read action carries its own plain sentence for exactly this
            // case: with no model, "Tenes 3 abiertas: trudy, harbor y tsrct" is
            // the whole answer, and "Listo." would have been an insult.
            const plain = acted
                ? (acted.failed ? `No pude: ${acted.failed}`
                    : acted.cancelled ? 'Listo, no lo hice.'
                        : speech.shape((acted.value && acted.value.plain) || 'Listo.'))
                : `No te puedo contestar eso ahora: ${ready.why}`;
            state.turns.push({ role: 'user', content: clean, at: t0 });
            state.turns.push({ role: 'assistant', content: plain, at: Date.now() });
            state.lastAt = Date.now();
            state.lastUserAt = t0;
            armIdle();
            return { ok: true, reply: plain, voice: voiceOf(plain), ms: Date.now() - t0, noModel: true };
        }
        trace('answer', haikuReply !== null ? 'haiku' : screen ? `narrated ${target} (${scrState})` : 'converse');
        let reply = haikuReply !== null ? haikuReply
            : await composeReply({ h, screen, target, scrState, forwarded, clean, actedNote, history });
        // Not for her (Tesla review #6): the brain answers "(silencio)" to a line
        // he said to someone else, and nothing is spoken. The turn stays in the
        // history so "eso no fue para vos" still has something to point at.
        if (haikuReply !== null && notForMe(reply)) {
            trace('not-for-her', clean.slice(0, 120));
            state.turns.push({ role: 'user', content: clean, at: t0 }, { role: 'assistant', content: '(silencio)', at: Date.now() });
            state.lastAt = Date.now();
            armIdle();
            return { ok: true, reply: '', silent: true, ms: Date.now() - t0 };
        }
        if (!reply) {
            state.lastError = `${brainName()} did not answer - say it again`;
            return { ok: false, why: state.lastError };
        }
        // Two sentences, no lists, no markdown. Cut, never rewritten - unless he
        // asked for the explanation, which then gets room to be one.
        reply = speech.shape(reply, { long: wantsDetail(clean) });
        // The answer is about to be spoken and sent back over HTTP. It came from
        // a model that was handed a context this server built, so it is checked
        // like any other egress rather than trusted because of where it is from.
        // Only the sentences that name it go (2026-10-14): a screenshot of fifteen
        // sessions, one of them SecretCo's, made the WHOLE answer vanish, and all he
        // heard was nothing. What is left is checked again before it is spoken.
        if (restrictedGuard.mentionsRestricted(reply)) {
            logRefusal('an answer it wrote', reply);
            const kept = reply.split(/(?<=[.!?])\s+/).filter(s => s && !restrictedGuard.mentionsRestricted(s)).join(' ').trim();
            reply = (kept && !restrictedGuard.mentionsRestricted(kept) ? kept + ' ' : '') + 'Una parte la deje afuera porque es de un trabajo que no toco desde aca.';
        }
        if (letGo) reply = `Solte la sesion ${letGo}, tiene contenido que no puedo mirar. ${reply}`;
        rememberTurn(clean, reply, t0);
        // `sent` tells the panel which of the two things happened, so it can show
        // a line that went into the session differently from one that did not.
        return { ok: true, reply, voice: voiceOf(reply), ms: Date.now() - t0, sent: forwarded, addressed, said: clean };
    } catch (e) {
        state.lastError = e.message;
        state.lastAt = Date.now();
        armIdle();
        return { ok: false, why: e.message };
    } finally {
        state.busy = false;
    }
}

// What this turn DOES, decided before a word is said: a pending yes/no, a
// missing argument, the parser's fast path, the Haiku brain or the action
// chooser. Lifted out of askTurn (cleanup P2 #13) unchanged; it only sets these
// three, and askTurn keeps the SecretCo guards and the answer.
async function decideTurn({ need, clean, pend, wantClaude, from, target, attached, h }) {
    let acted = null;
    let haikuReply = null;
    let fast = null;
    if (need && NO.test(clean)) {
        trace('path', 'no to a missing-argument question');
        acted = { cancelled: 'lo que te estaba preguntando' };
    } else if (need) {
        trace('path', `answer to "which ${need.key}?" for ${need.name}`);
        // Spoken answers arrive with a full stop and an article on them.
        const value = clean.replace(/^(el|la|los|las|en|de|del|a)\s+/i, '').replace(/[.?!]+$/, '').trim();
        acted = await runAction(need.name, { ...need.args, [need.key]: value }, false);
        // Asked twice and still no match: stop asking. A third "which one?"
        // is the loop, not a conversation.
        if (acted && acted.ask && need.retried) {
            state.needArg = null;
            acted = { ask: 'No lo encuentro. Cuando quieras, pedimelo de nuevo con el nombre.' };
        } else if (state.needArg) state.needArg.retried = true;
    } else if (NOT_HEARD.test(clean) && lastSaid()) {
        trace('path', 'repeat-last');
        haikuReply = lastSaid();
    } else if (pend && NO.test(clean)) {
        trace('path', `no to ${pend.name}`);
        state.pendingAction = null;
        acted = { cancelled: pend.says };
    } else if (pend && YES.test(clean)) {
        trace('path', `yes to ${pend.name}`);
        // He agreed. The action re-validates on the way through: the session
        // he agreed to open may have died while he was thinking.
        acted = await runAction(pend.name, pend.args, true);
        // Its own short line, not a narration of the screen ("Voy. Solo confirmo
        // que el pedido quedo en marcha; todavia no se si...", review #11).
        if (acted && acted.did && !acted.say && actions.speaksPlain(acted.did) && acted.value && acted.value.plain) {
            haikuReply = acted.value.plain;
            trace('plain', `${pend.name} (after yes)`);
            acted = null;
        }
    } else if (!wantClaude && (fast = fastPick(clean))) {
        trace('path', `parser: ${fast.name} (${fast.why || 'sure'})`);
        acted = await runAction(fast.name, fast.args, false);
        if (acted && acted.failed) { haikuReply = `No pude: ${acted.failed}`; acted = null; }
        else if (acted && acted.did && !acted.say && acted.value && acted.value.plain) {
            haikuReply = acted.value.plain;
            trace('plain', fast.name);
            acted = null;
        }
    } else if (usingHaiku() && !wantClaude) {
        ({ acted, haikuReply } = await decideByHaiku({ from, target, clean, pend, attached }));
    } else if (ACTIONS_ON && manifest().length) {
        acted = await decideByChooser({ clean, h, pend });
    }
    return { acted, haikuReply, fast };
}

// The model's answer when Haiku did not already give one: about the watched session's
// screen if there is one, otherwise plain conversation. Lifted out of askTurn (cleanup
// P2, 2026-10-17).
async function composeReply({ h, screen, target, scrState, forwarded, clean, actedNote, history }) {
    return screen
        ? await timed('model-narrate', h.narrateSession({
            screen,
            session: target,
            lang: state.lang,
            model: MODEL,
            numCtx: NUM_CTX,
            state: scrState,
            context: sessionContext(target),
            timeoutMs: await answerLimit(h),
            question: (forwarded
                ? `${clean}\n(Nota: eso ya se lo mandaste a la sesion como pedido y lo esta haciendo. No lo contestes vos: decile en una frase que se lo pasaste, y si de la pantalla se entiende algo util para el, sumalo.)`
                : clean) + actedNote,
            history,
            keepAlive: KEEP_ALIVE,
        }))
        : await timed('model-converse', h.converse({
            text: clean + actedNote,
            model: MODEL,
            numCtx: NUM_CTX,
            timeoutMs: await answerLimit(h),
            history,
            context: context(),
            keepAlive: KEEP_ALIVE,
        }));
}

// A turn that was answered: into the history, and the clocks that hang off it.
function rememberTurn(clean, reply, t0) {
    state.turns.push({ role: 'user', content: clean, at: t0 });
    state.turns.push({ role: 'assistant', content: reply, at: Date.now() });
    if (state.turns.length > MAX_TURNS * 4) state.turns = state.turns.slice(-MAX_TURNS * 4);
    state.lastAt = Date.now();
    state.lastUserAt = t0;      // HE spoke: the ceiling starts again from here
    state.lastError = '';
    // It just spoke to him, so the live commentary waits its full interval
    // from HERE. Otherwise the first progress ping lands on top of the answer
    // to the question he just asked.
    state.lastNarrateAt = Date.now();
    state.lastSaid = reply;
    state.warm = true;          // it just answered, so the model is in memory
    armIdle();
}

// The Haiku brain's turn: it answers, and may pick actions that run here. Lifted out of
// decideTurn (cleanup P2, 2026-10-17); it sets only what it returns.
async function decideByHaiku({ from, target, clean, pend, attached }) {
    let acted = null;
    let haikuReply = null;
    // ── Haiku understands him; the code validates, confirms, runs ────
    // The parser below misread the first real test of this ("abrime
    // cinco sesiones en cinco directorios distintos" -> ONE session in
    // ledgerly-bankrec). Haiku reads the sentence; the gate in
    // lib/actions.js still decides what is real, and anything that
    // changes something still waits for his yes.
    trace('path', 'haiku');
    if (from) trace('from', from);
    const runsBefore = state.runs || 0;
    const lastRunBefore = state.lastRunAt || 0;
    let scr = null;
    try { scr = target ? screenOf(target) : null; } catch { scr = null; }   // an SecretCo screen is dealt with below, as always
    let open = [];
    try { open = typeof deps.sessions === 'function' ? deps.sessions() : []; } catch { open = []; }
    let d = await timed('haiku-decide', haiku.decide({
        text: clean, session: target, screen: scr && scr.text, working: scr && scr.working,
        context: [target ? sessionContext(target) : context(), doneNote(target), lostNote()].filter(Boolean).join('\n\n'), sessions: open,
        pending: pend ? pend.says : null,
        detail: wantsDetail(clean),
        lang: state.lang,
        watching: state.watch && target ? (state.live ? 'live' : 'turns') : '',
        background: backgroundText(),
        files: attached,
        // Said into Ghost Runner, most likely mid-run (lib/haikuBrain.js howToAnswer).
        where: from === 'runner' || from === 'vr' ? from : '',
    }));
    // "Voy a revisar..." and no ACCION: a promise nothing will keep
    // (2026-09-25, "abri una sesion en HARBOR" -> nothing). Once, it is told.
    if (!d.action && d.say && ((PROMISES.test(d.say) && !/\?/.test(d.say)) || ASKS_TO_ACT.test(d.say))) {
        console.warn(`[talk] haiku promised without an action: "${d.say.slice(0, 80)}"`);
        trace('nudge', d.say);
        try { d = afterNudge(d, await timed('haiku-nudge', haiku.nudge({ session: target, said: d.say }))); } catch { /* keep the first answer */ }
    }
    // HAIKU decides the yes (2026-09-24). Asked "que Opus investigue...?",
    // he answered "si entendiste, procede a pedirle esos": no yes-word
    // the code knows, so Haiku - which DID understand - wrote "ya esta en
    // marcha" and nothing ran. Now Haiku says yes by repeating the same
    // ACCION while it is pending (its instructions say exactly that), and
    // that runs, through the same gate, with his confirmation.
    if (pend && d.action && d.action.name === pend.name) {
        console.log(`[talk] haiku read a yes for ${pend.name}: "${clean.slice(0, 80)}"`);
        trace('haiku-yes', pend.name);
        acted = await runAction(d.action.name, d.action.args, true);
        d = { ...d, action: null };
        state.pendingAction = null;
        if (acted && acted.failed) { haikuReply = `No pude: ${acted.failed}`; acted = null; }
        else if (acted && acted.ask) { haikuReply = acted.ask; acted = null; }
    } else if (!pend && d.action && YES.test(clean) && herQuestionIsOpen()) {
        // She asked HIM a yes/no question with no action behind it ("queres
        // que le diga que si?"), he said yes, and now she names the action:
        // his yes WAS the confirmation (Tesla review #8 - on his run every
        // permission cost "si" three or four times, "te dije que si como 10
        // veces"). Only for a plain yes, and only right after her question.
        console.log(`[talk] his yes to her question confirms ${d.action.name}: "${clean.slice(0, 80)}"`);
        trace('yes-to-her-question', d.action.name);
        acted = await runAction(d.action.name, d.action.args, true);
        d = { ...d, action: null };
        if (acted && acted.failed) { haikuReply = `No pude: ${acted.failed}`; acted = null; }
        else if (acted && acted.ask) { haikuReply = acted.ask; acted = null; }
    }
    // The gate's objections ("hasta 4 a la vez", "no conozco X") go back
    // to HAIKU, once: it fixes the action or asks him in its own words.
    // The code wrote those questions before, and then read his answer
    // with the parser Haiku replaced.
    if (d.action && askedOfSession(d.action.name, clean, target)) {
        trace('rerouted', `${d.action.name} -> say_to_session ${target}`);
        d = await timed('haiku-rejected', haiku.rejected({ session: target, action: d.action,
            why: `${OWNER} dijo "${clean.slice(0, 200)}": es un pedido PARA la sesion ${target} que esta mirando, no un trabajo aparte. Usa say_to_session a ${target} con su pedido en sus palabras, limpio de muletillas.` }));
    }
    if (d.action && DETAIL_ACTIONS.has(d.action.name) && wantsDetail(clean)) {
        d = { ...d, action: { ...d.action, args: { ...d.action.args, detail: LITERAL.test(clean) ? 'textual' : 'si' } } };
        trace('detail', d.action.name);
    }
    for (let tries = 0; d.action; tries++) {
        if (d.action.name === 'say_to_session') {
            const recent = state.turns.slice(-2).map(t => t.content).join(' ');
            const aimed = fixSession(d.action.args, target, clean, { recent, open, asking: handsAsked() });
            if (aimed !== d.action.args) {
                trace('session-fixed', `${d.action.args.session} -> ${aimed.session}`);
                d = { ...d, action: { ...d.action, args: aimed } };
            }
        }
        console.log(`[talk] haiku asked for ${d.action.name} ${JSON.stringify(d.action.args).slice(0, 160)}`);
        acted = await runAction(d.action.name, d.action.args, false);
        const why = acted && (acted.failed || (acted.ask && !state.pendingAction && acted.ask));
        if (!why) break;
        state.needArg = null;
        trace(tries >= 1 ? 'rejected-twice' : 'rejected', why);
        if (tries >= 1) { haikuReply = acted.failed ? `No pude: ${acted.failed}` : acted.ask; acted = null; break; }
        d = await timed('haiku-rejected', haiku.rejected({ session: target, action: d.action, why }));
        acted = null;
        if (!d.action) haikuReply = d.say || '';
    }
    // "mandale / enviale ..." in HIS sentence is the yes (2026-09-24: "si
    // le digo enviale un prompt diciendo... o mandale, que lo mande
    // directo"). Read from his words, never from Haiku's, and only for
    // the actions whose whole effect is the thing he just ordered.
    if (acted && acted.ask && state.pendingAction && saidDirectly(clean, state.pendingAction)) {
        const p = state.pendingAction;
        console.log(`[talk] ${p.name} ordered directly, no question: "${clean.slice(0, 80)}"`);
        trace('ordered-directly', p.name);
        acted = await runAction(p.name, p.args, true);
        if (acted && acted.failed) { haikuReply = `No pude: ${acted.failed}`; acted = null; }
        else if (acted && acted.did && !acted.say) {
            haikuReply = (acted.value && acted.value.plain) || d.say || 'Listo.';
            acted = null;
        }
    }
    if (acted && acted.ask && state.pendingAction) {
        // The yes/no question is HIS sentence, not a template: Haiku was
        // told to name exactly what it is about to do and ask.
        acted = { ask: haikuConfirm(d.say, state.pendingAction.says) };
    } else if (acted && acted.did && !acted.say && actions.speaksPlain(acted.did) && acted.value && acted.value.plain) {
        // Its own short line, as is (Tesla review #10: no second model
        // turning "voy" into three sentences about who does what).
        haikuReply = acted.value.plain;
        trace('plain', acted.did);
        acted = null;
    } else if (acted && acted.did && !acted.say) {
        haikuReply = await timed('haiku-report', haiku.report({ session: target, action: acted.did, value: acted.value }));
        acted = null;
    } else if (!d.action && haikuReply === null) haikuReply = d.say || '';
    // A claim that something is running, from a turn that ran nothing,
    // is replaced by the truth and the question (it said "ya esta en
    // marcha" about a job that was never started).
    if (haikuReply && falseClaim(haikuReply, { ranThisTurn: (state.runs || 0) !== runsBefore, lastRunAt: lastRunBefore, pending: pend || state.pendingAction })) {
        const p = pend || state.pendingAction;
        console.warn(`[talk] haiku claimed a start that did not happen: "${haikuReply.slice(0, 80)}"`);
        trace('claim-fixed', haikuReply);
        // HIS words were the order for the very thing it claimed
        // ("no ya esta, decirle que lo subas" -> "ya le acabo de decir",
        // 2026-10-05): do it now instead of asking him a third time.
        const did = p && saidDirectly(clean, p) ? await runAction(p.name, p.args, true) : null;
        if (did && did.say) haikuReply = did.say;
        else if (did && did.failed) haikuReply = `No pude: ${did.failed}`;
        else {
            haikuReply = p ? `Todavia no lo lance. Queres que ${p.says}? Decime si.` : 'Perdon, no lance nada todavia. Pedimelo de nuevo y lo arranco.';
            if (p) state.pendingAction = { ...p, at: Date.now() };
        }
    }
    // Still waiting on a yes that did not come, and Haiku asked again:
    // keep the question alive. Anything else lets it go.
    if (pend && !d.action) state.pendingAction = /\?/.test(haikuReply || '') ? pend : null;
    return { acted, haikuReply };
}

// The local model's turn when Haiku is not the brain: it chooses one action from the
// catalogue. Lifted out of decideTurn (cleanup P2, 2026-10-17); it sets only `acted`.
async function decideByChooser({ clean, h, pend }) {
    let acted = null;
    // ── the parser first, and usually last ──────────────────────────
    // No GPU, no network, ~0ms. Everything it is sure about skips the
    // model entirely, which is most of what he says: the model was the
    // slowest step and the only one that could invent a door.
    const heard = understand.parse(clean, { here: state.session, last: state.last });
    let pick = heard && heard.sure ? { name: heard.name, args: heard.args, local: true } : null;
    if (pick) { console.log(`[talk] entendido sin modelo: ${pick.name} (${heard.why})`); trace('path', `parser: ${pick.name} (${heard.why})`); }
    // The router is the first thing here that costs a model. If the card
    // is busy or Ollama is off, this turn simply has no action in it —
    // which is the same thing the router says most of the time anyway.
    if (!pick && h && h.chooseAction && (await ensureModel()).ok) pick = await h.chooseAction({
        text: clean,
        manifest: manifest(),
        pending: pend ? pend.says : null,
        model: MODEL,
        numCtx: NUM_CTX,
        // The SAME cold/warm split the answer uses. Hardcoding 120s here
        // reintroduced, in a new function, the exact bug that killed the
        // first question of every conversation: the cold load is ~130s,
        // so the router timed out before the model had finished loading
        // and tripped the circuit breaker for everything behind it.
        timeoutMs: await answerLimit(h),
    }).catch(() => null);
    const chosen = pick && pick.name ? manifest().find(a => a.name === pick.name) : null;
    // Nothing that changes something without a word asking for it. This
    // guards the MODEL's picks only: the parser already refuses a verb
    // with a negation in front of it, and it knows forms this regex does
    // not ("baja probill"). A veto written for a guesser must not
    // start overruling the thing that reads the sentence properly.
    if (chosen && chosen.confirm && !pick.local && !ORDER.test(clean)) {
        console.log(`[talk] router picked ${pick.name} for a sentence with no order in it - treated as conversation: "${clean.slice(0, 80)}"`);
        trace('router-vetoed', pick.name);
        pick = null;
    } else if (chosen && !chosen.confirm && state.session
        && (chosen.args || []).includes('session') && !(pick.args && pick.args.session)) {
        // "que esta haciendo?" with a session attached means THAT session.
        // Only for the ones that read: a close with the argument filled in
        // for him is a session closed because he asked a vague question.
        pick.args = { ...(pick.args || {}), session: state.session };
    }
    if (pick && pick.name) acted = await runAction(pick.name, pick.args, false);
    // Still waiting on his yes, and this sentence was neither a yes, a no
    // nor a new request. Say the truth once, deterministically — a model
    // asked to fill this silence said "abriendo..." — then let it go.
    else if (pend) {
        pend.nags = (pend.nags || 0) + 1;
        if (pend.nags <= 1) { state.pendingAction = pend; acted = { ask: `Todavia no hice nada. ${confirmLine(pend.says)}` }; }
        else state.pendingAction = null;
    }
    return acted;
}


// ── it offers something, out loud, without being asked ──────────────────────
// The one place the assistant speaks first. It exists for the six o'clock call:
// the phone rings, he answers, Piper reads the brief, and then — instead of the
// silence that used to follow — it offers the board the brief just proposed and
// waits for a yes, exactly as if he had asked for it himself.
//
// It is NOT initiative. Only a route he arrived at by answering the phone calls
// this, it can only ever propose an action from the catalogue, the proposal goes
// through the same validation, and an unanswered offer expires with every other
// pending confirmation (TALK_CONFIRM_MS). Nothing here can run anything.
function propose(name, args) {
    try {
        const { action, args: clean } = actions.validate(name, args || {});
        if (action.readOnly) return { ok: false, why: 'that one needs no offer - just do it' };
        const can = typeof action.offerable === 'function' ? action.offerable(clean) : true;
        if (can !== true) return { ok: false, why: typeof can === 'string' ? can : 'nothing to offer' };
        const says = action.confirmSays ? action.confirmSays(clean) : action.says;
        openLight();
        state.pendingAction = { name: action.name, args: clean, says, at: Date.now() };
        const line = confirmLine(says);
        state.turns.push({ role: 'assistant', content: line, at: Date.now() });
        pushSay(line, 'offer', { urgent: /permission/.test(action.name) });
        teslaLog.write('offer', { action: action.name, says });
        remberSaid(line);
        return { ok: true, says, id: state.seq };
    } catch (e) {
        // A missing argument or a refusal here is not worth saying out loud: he
        // did not ask for it. The caller gets the reason and stays quiet.
        return { ok: false, why: e.message };
    }
}

// Give the memory back. Called by the panel's STOP, by the browser on its way
// out (fetch keepalive), and by the idle timer.
async function close(opts = {}) {
    const was = state.open;
    if (was) teslaLog.closed({ reason: opts.reason || 'closed', turns: Math.floor(state.turns.length / 2), minutes: state.openedAt ? Math.round((Date.now() - state.openedAt) / 60000) : null });
    state.open = false;
    state.closedReason = opts.reason || 'closed';
    state.turns = [];
    state.spool = [];
    state.lang = null;
    state.pending = false;
    state.needArg = null;
    state.pendingAction = null;
    state.warm = false;
    state.modelOk = false;
    state.modelNoBefore = 0;
    state.did = [];
    state.recent = [];
    // The watcher is part of the conversation, so it ends with it. This is the
    // line that keeps "hermes reads my sessions" from ever meaning "hermes reads
    // my sessions forever".
    stopWatch();
    if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
    state.lastPollAt = 0;
    state.screenPollAt = 0;
    let unloaded = false;
    const h = hermes();
    // With Haiku the sweep runs even if no conversation was open: a hidden
    // session can outlive the flag (a preload racing a close).
    if ((was || usingHaiku()) && h && typeof h.unload === 'function') {
        // If a question is still in flight, the unload queues behind it — it can
        // never cut an answer in half.
        unloaded = await h.unload(MODEL);
    }
    return { ok: true, unloaded, reason: opts.reason || 'closed' };
}

// Cheap, synchronous, and the panel polls it — so it must never be the thing
// that warms a model. `since` is the last spooled line the panel has already
// said out loud; everything after it comes back to be spoken.
function status({ since, client } = {}) {
    state.lastPollAt = Date.now();
    if (client !== 'runner') state.screenPollAt = state.lastPollAt;
    const from = Number(since || 0);
    return {
        open: state.open,
        busy: state.busy,
        turns: Math.floor(state.turns.length / 2),
        openedAt: state.openedAt || null,
        lastAt: state.lastAt || null,
        idleMs: IDLE_MS,
        closedReason: state.open ? '' : (state.closedReason || ''),
        preloading: !!state.preloading,
        maxSilentMs: MAX_SILENT_MS,
        silentLeftMs: state.open && state.lastUserAt ? Math.max(0, MAX_SILENT_MS - (Date.now() - state.lastUserAt)) : null,
        keepAlive: KEEP_ALIVE,
        voice: VOICE,
        model: MODEL,
        warm: state.warm,
        error: state.lastError || '',
        // The attached session
        session: state.session || '',
        watch: state.watch,
        toClaude: state.toClaude,
        live: state.live,
        liveMs: LIVE_MS,
        working: state.lastWork === null ? null : !!state.lastWork,
        narrating: state.narrating,
        // A count, not the model-facing list: building it reads every action's name lists (16 tmux
        // calls, 1.2 s) and froze the server on every 3.5 s poll (2026-10-08).
        actions: ACTIONS_ON ? actions.CATALOG.length : 0,
        pendingAction: state.pendingAction ? { says: state.pendingAction.says } : null,
        say: state.spool.filter(x => x.id > from),
        // Buttons the page has not pressed yet. It also rides back on the answer
        // to /api/talk/ask, so in practice the press happens before he has
        // finished hearing the sentence; this is the safety net for the rest.
        do: uiActions.pending(),
        jobs: backgroundList(),
        seq: state.seq,
    };
}

module.exports = {
    configure, open, attach, ask, close, status, preflight,
    // A line from something that finished in the background (the prompt
    // writer): queued like a narration, spoken by whichever orb is listening.
    // 3000, not 400: a conversation he asked to hear whole was cut to a summary (review #12).
    // `{urgent:true}` only for a permission request (see pushSay).
    announce: (text, opts) => pushSay(String(text || '').slice(0, 3000), 'bg', { urgent: !!(opts && opts.urgent) }),
    noteLost, _lostNote: lostNote, _lost: lost, _fastPick: fastPick,
    jobsStatus, someoneWatching,
    inConversation: () => state.open && Date.now() - state.lastPollAt < POLL_ALIVE_MS,
    // The assistant speaking first, only from the morning call (see propose()).
    propose,
    // exported for the tick-level test in scripts/ and for anything that wants
    // to know what the pane looks like without waiting for the timer
    watchTick,
    // The two deterministic decisions in this file, exported so they can be
    // tested against sentences he actually said instead of sentences I imagined:
    // is that a yes, and did he ask for something to be DONE.
    decide, ORDER,
    _answerLimit: answerLimit, _answerFits: answerFits, _catalogueText: catalogueText,
    _endsConversation: endsConversation, _abandoned: abandoned, _haikuConfirm: haikuConfirm, _saidDirectly: saidDirectly, _fixSession: fixSession, _askedOfSession: askedOfSession, _wantsDetail: wantsDetail, _claimsStarted: CLAIMS_STARTED, _promises: PROMISES, _asksToAct: ASKS_TO_ACT, _afterNudge: afterNudge, _falseClaim: falseClaim,
    _followTarget: followTarget, _langOf: langOf, _voiceFor: voiceFor, _notForMe: notForMe, _asksToAct: ASKS_TO_ACT, _notHeard: NOT_HEARD,
    VOICE, KEEP_ALIVE, IDLE_MS, WATCH_MS,
};
