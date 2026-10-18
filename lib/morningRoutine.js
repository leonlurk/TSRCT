'use strict';
// ── morningRoutine.js — wake up with the sessions already open ───────────────
//
// The job the scheduler fires at 06:00:
//   1. take stock locally, for free (which sessions are live, which projects
//      exist and where, what the vault says about the last few days);
//   2. ask headless Claude ONE question — "given ClickUp, Slack, mail, calendar,
//      the vault and my own past sessions, what is actually pending and what
//      should be open when I wake up?" — and require the answer as JSON;
//   3. open the sessions it names, in the right directories, primed.
//
// WHY THE THINKING IS NOT LOCAL: the local model (hermes3:8b) is good at
// one-shot shaped calls — classify this, match that, draft a line. Cross-reading
// five sources and deciding what is genuinely pending is not that, and a wrong
// answer here is not a bad sentence: it is four Claude sessions opened in the
// wrong repos, burning tokens, that Leon finds when he wakes up. So the local
// model is not in this path at all. If that changes, change it deliberately.
//
// FAIL-CLOSED, in order:
//   - a project the registry cannot place is SKIPPED, never guessed;
//   - SecretCo is refused twice over (projectRegistry refuses the folder, and the
//     analyst choke point refuses the job data);
//   - MAX_SESSIONS caps the fan-out, so a model that answers with twelve
//     sessions opens the top few and the rest are reported, not spawned;
//   - a session name that already exists is never reused; it gets the next free
//     name (foo -> foo-2), so a routine that fires twice cannot paste into the
//     session you are working in.

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
// Standalone, never through the dispatcher: the boundary must not depend on an
// optional subsystem having loaded.
const restrictedGuard = require('./dispatcher/restrictedGuard');
const { stateFile } = require('./stateFile');

const MAX_SESSIONS = Number(process.env.MORNING_MAX_SESSIONS || 4);
const STATE_FILE = process.env.MORNING_STATE_FILE || stateFile('morning.json', '.tsrct-morning.json');
const VAULT_ROOT = paths.VAULT_ROOT;
// The cloned House voice, fine-tuned 2026-09-19. Spanish only - a Piper voice
// is bound to the language of the checkpoint it came from.
const SPOKEN_VOICE = process.env.MORNING_SPOKEN_VOICE || 'jorge-monstruo'   // Tesla's voice since 2026-10-14 (lib/tts.js PROFILES);

let deps = {
    analyst: null,          // lib/dispatcher/clickupAnalyst (the claude -p runner)
    jsonJob: null,          // lib/jsonJob
    registry: null,         // lib/projectRegistry
    sessionSpawn: null,     // lib/sessionSpawn
    listSessions: null,     // () => [name, ...]
    sessionExists: null,    // (name) => bool
    addEvent: null,         // server.js addEvent, for the Notifs feed
    push: null,             // lib/push — wakes the phone when TSRCT is closed
    hermes: null,           // lib/dispatcher/hermes — turns the written brief into spoken Spanish
};

function configure(injected) {
    deps = { ...deps, ...(injected || {}) };
    clearStale();
}

// A run lives in this process's memory, so after a restart a state file still
// saying "asking"/"opening" describes a run that is gone - and the panel would
// show a progress bar forever with a STOP that answers "nothing is running".
function clearStale() {
    if (busy) return;
    const s = loadState();
    if (!s || (s.phase !== 'asking' && s.phase !== 'opening')) return;
    s.phase = 'failed';
    s.error = 'interrupted: TSRCT restarted during the run';
    s.opening = '';
    s.finishedAt = Date.now();
    saveState(s);
    console.warn('[morning] a run was cut off by a restart - marked interrupted');
}

// ── the answer we require ────────────────────────────────────────────────────
// Shape is enforced by lib/jsonJob.js, which re-asks once with the error quoted.
const PLAN_SHAPE = {
    object: {
        brief: 'string',
        pending: {
            array: {
                object: { title: 'string', source: 'string', why: 'string', project: 'string' },
                optional: ['project'],
            },
        },
        sessions: {
            array: {
                object: {
                    project: 'string',
                    session: 'string',
                    prompt: 'string',
                    why: 'string',
                    priority: 'number',
                },
                optional: ['session', 'priority'],
            },
        },
        mailbox: 'string',
        spoken: 'string',
    },
    optional: ['pending', 'mailbox', 'spoken'],
};

// ── local stock-taking (no model, no network) ────────────────────────────────
function recentVaultNotes(days = 4) {
    const dir = path.join(VAULT_ROOT, 'sessions');
    const out = [];
    try {
        const cutoff = Date.now() - days * 24 * 3600 * 1000;
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.md')) continue;
            const p = path.join(dir, f);
            let st;
            try { st = fs.statSync(p); } catch { continue; }
            if (st.mtimeMs < cutoff) continue;
            out.push({ file: f, when: new Date(st.mtimeMs).toISOString().slice(0, 10) });
        }
    } catch { /* no vault sessions dir: not fatal */ }
    return out.sort((a, b) => a.file.localeCompare(b.file)).slice(-12);
}

// What he was last in the middle of, per project, from Claude Code's own logs.
//
// This used to be item 6 of the question: "look under ~/.claude/projects". The
// headless job cannot be granted a shell, so it answered "the scanning commands
// are blocked here" and read one file. It is also the wrong side to do it on:
// those logs include the SecretCo sessions, and a sentence in a prompt asking the
// model not to open them is not a guard. So the server reads them — a stat per
// file, the last 384 KB of the newest one per project — and SecretCo is dropped by
// FOLDER NAME before a byte is read and by content after.
const CLAUDE_LOGS = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const LOG_TAIL_BYTES = 384 * 1024;

function lastAsks(file, n = 2) {
    let text = '';
    try {
        const st = fs.statSync(file);
        const len = Math.min(st.size, LOG_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
        text = buf.toString('utf8');
    } catch { return []; }
    const out = [];
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }      // the first line is usually cut in half
        if (!o || o.type !== 'user' || !o.message) continue;
        const c = o.message.content;
        const said = typeof c === 'string' ? c
            : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join(' ') : '';
        const clean = String(said).replace(/\s+/g, ' ').trim();
        // Tool results, hook output and slash-command plumbing are not him talking.
        if (!clean || clean.startsWith('<') || clean.startsWith('Caveat:')) continue;
        out.unshift(clean.slice(0, 240));
    }
    return out;
}

function recentClaudeWork(days = 3, max = 6) {
    const found = [];
    try {
        const cutoff = Date.now() - days * 24 * 3600 * 1000;
        for (const dir of fs.readdirSync(CLAUDE_LOGS)) {
            if (restrictedGuard.mentionsRestricted(dir)) continue;
            // The headless jobs' own workspace: that is this routine talking to itself.
            if (/tsrct-analyst$/i.test(dir)) continue;
            const full = path.join(CLAUDE_LOGS, dir);
            let newest = null;
            try {
                for (const f of fs.readdirSync(full)) {
                    if (!f.endsWith('.jsonl')) continue;
                    const st = fs.statSync(path.join(full, f));
                    if (st.mtimeMs >= cutoff && (!newest || st.mtimeMs > newest.at)) newest = { file: path.join(full, f), at: st.mtimeMs };
                }
            } catch { continue; }
            if (newest) found.push({ dir, ...newest });
        }
    } catch { return []; }
    found.sort((a, b) => b.at - a.at);
    const out = [];
    for (const f of found.slice(0, max)) {
        // Only the requests that name SecretCo go (2026-10-08): one mention used to
        // hide the whole project from the brief. Its folder is refused above.
        const all = lastAsks(f.file);
        const asks = all.filter(a => !restrictedGuard.mentionsRestricted(a));
        if (all.length && !asks.length) asks.push('(worked here; his recent requests named SecretCo and are left out)');
        // A long tool-heavy stretch can push his last words out of the tail. That
        // he WORKED there is still worth knowing, and it is known from the mtime.
        if (!asks.length) asks.push('(worked here; his last request is further back than was read)');
        out.push({
            project: f.dir.replace(/^-mnt-c-Users-[^-]+-PROJECTS-?/, '') || 'PROJECTS',
            when: new Date(f.at).toISOString().slice(0, 16).replace('T', ' '),
            lastAsks: asks,
        });
    }
    return out;
}

// The connectors the question is about, READ side only. Nothing here can send,
// post, create or delete: the job's whole output is a JSON plan.
const MORNING_TOOLS = [
    'Read', 'Glob', 'Grep',
    ...['slack_search_public_and_private', 'slack_search_public', 'slack_search_users', 'slack_search_channels',
        'slack_read_channel', 'slack_read_thread', 'slack_read_user_profile'].map(t => `mcp__claude_ai_Slack__${t}`),
    ...['clickup_search', 'clickup_filter_tasks', 'clickup_get_task', 'clickup_get_task_comments',
        'clickup_get_threaded_comments', 'clickup_get_workspace_hierarchy', 'clickup_get_list',
        'clickup_find_member_by_name', 'clickup_resolve_assignees'].map(t => `mcp__claude_ai_ClickUp__${t}`),
    ...['search_threads', 'get_thread', 'get_message', 'list_labels'].map(t => `mcp__claude_ai_Gmail__${t}`),
    ...['list_events', 'list_calendars', 'get_event', 'search_events'].map(t => `mcp__claude_ai_Google_Calendar__${t}`),
];

function liveSessions() {
    try { return (deps.listSessions && deps.listSessions()) || []; } catch { return []; }
}

function knownProjects() {
    try {
        return (deps.registry.list() || [])
            .filter(p => p.known)
            .map(p => ({ project: p.project, cwd: p.cwd }));
    } catch { return []; }
}

// ── the question ─────────────────────────────────────────────────────────────
function buildInstruction(stock) {
    const projectLines = stock.projects.map(p => `  - ${p.project}  ->  ${p.cwd}`).join('\n');
    return `You are preparing Leon's desk before he wakes up. Today is ${stock.today}.

Read what is actually going on and decide what should already be open when he sits down.

WHERE TO LOOK - these six sources and NOTHING ELSE. If one of THESE is unavailable,
say so in one short sentence rather than guessing. Any other connector this account
happens to have (brains, Atlassian, Salesforce, Shopify, Drive...) is not part of this
job: do not open it, and do not mention it in the brief, connected or not:
  1. ClickUp - his assigned tasks, what is overdue, what is due today, recent comments
     that ask him for something.
  2. Slack - DMs and mentions from the last 3 days that are still unanswered.
  3. Gmail - unread mail from the last 3 days that needs an answer or an action.
  4. Google Calendar - what is on today, especially anything before noon.
  5. The Obsidian vault at ${VAULT_ROOT} - projects/ for what each project is,
     sessions/ for what he was last doing. Recent session notes:
${stock.vaultNotes.map(n => `     - ${n.file}`).join('\n') || '     (none in the last few days)'}
  6. His own recent Claude Code work. This has ALREADY been read for you (the last
     things he asked for, per project, newest first) - do not go looking under
     ~/.claude yourself:
${stock.claudeWork.map(w => `     - ${w.project} (${w.when}): ${w.lastAsks.join('  //  ')}`).join('\n') || '     (nothing in the last few days)'}

CROSS-READ, do not list. The same piece of work usually appears more than once (a
ClickUp task, a Slack message asking about it, a half-finished session). Merge those
into ONE pending item. An item that exists only as somebody's question and has no
work attached is still pending - say where it came from.

TMUX SESSIONS ALREADY LIVE (do not propose opening these again):
${stock.live.map(s => `  - ${s}`).join('\n') || '  (none)'}

PROJECTS AND THEIR DIRECTORIES (the ONLY projects you may name; use the left-hand
name exactly, and never invent a path):
${projectLines || '  (none known)'}

HARD SECRETCO EXCLUSION: never read, name, or propose anything for SecretCo or SecretCoSandbox.
That work is Bedrock-only and is handled in its own session.

Then answer with ONLY this JSON, no prose around it, no markdown fence:

{
  "brief": "<8-10 lines, plain language, what happened while he was away and what today
             looks like. Say plainly which sources you could NOT read.>",
  "spoken": "<the same brief in neutral Latin American Spanish (tú, never vos), written to be READ ALOUD: 4-6 short
             sentences, no lists, no markdown, no file paths, no ids>",
  "pending": [
    {"title": "<what is pending, in his words>",
     "source": "<clickup | slack | gmail | calendar | vault | session - and which one>",
     "why": "<why it is pending, one line>",
     "project": "<project name from the list above, or omit>"}
  ],
  "sessions": [
    {"project": "<name from the list above>",
     "session": "<short tmux name, lowercase, letters/digits/dashes>",
     "priority": <1 = most important>,
     "why": "<one line: why this session should be open before he sits down>",
     "prompt": "<what to tell the new Claude session so it is useful immediately:
                 what the work is, where it stopped, what to check FIRST. End by asking
                 it to state in one line what it understands needs to happen, and to
                 wait before changing any code.>"}
  ]
}

Propose AT MOST ${MAX_SESSIONS} sessions, in priority order. Fewer is better: only work
that is genuinely next. If nothing is worth opening, return an empty sessions array and
say why in the brief.`;
}

// ── state, so the panel can show what happened while you slept ───────────────
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function saveState(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { console.error('[morning] could not write state:', e.message); }
}

function event(kind, title, body) {
    try { if (deps.addEvent) deps.addEvent({ type: kind, title, body }); } catch { /* never break the run */ }
}

// The notification says what actually happened, not that something did. At 6am
// the phone is the only screen he has, and "TSRCT has news" costs him the walk
// to the laptop to find out whether it mattered.
//
// It carries the first real sentence of the brief plus which sessions are
// waiting. Everything SecretCo is dropped from the list here, and push.send()
// refuses outright if anything slipped through — two layers, on purpose.
function notifyPhone(state) {
    if (!deps.push) return;
    try {
        const first = String(state.brief || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
        const opened = deps.push.dropRestricted((state.opened || []).map(o => o.session).filter(Boolean));
        const head = opened.length
            ? `${opened.length} session${opened.length === 1 ? '' : 's'} ready: ${opened.join(', ')}`
            : (state.plannedSessions || []).length ? 'a plan is waiting for you' : 'nothing needed opening';
        const body = [head, first].filter(Boolean).join('. ').slice(0, 300);
        // The brief is the one alert that is allowed to RING: it is useless if
        // he sleeps through it, and by the time he finds it in the shade the
        // morning it describes is half over. `ring` keeps calling until he
        // answers (ntfy, loud) and still carries the tap that opens TSRCT
        // speaking (web push). Without ring configured this is the old single
        // notification, unchanged.
        if (deps.ring) {
            Promise.resolve(deps.ring.start({
                title: `Morning brief · ${state.today}`,
                body,
                url: '/?speak=morning',
                kind: 'morning',
            })).catch(e => console.warn('[morning] could not ring the phone:', e.message));
            return;
        }
        Promise.resolve(deps.push.send({
            title: `Morning brief · ${state.today}`,
            body,
            url: '/?speak=morning',
            kind: 'morning',
            tag: `morning-${state.today}`,
        })).then(r => {
            if (r && r.refused) console.warn('[morning] the notification was refused by the SecretCo guard');
        }).catch(e => console.warn('[morning] could not send the notification:', e.message));
    } catch (e) {
        console.warn('[morning] notification failed:', e.message);   // never break the run
    }
}

// ── the run ──────────────────────────────────────────────────────────────────
// One at a time, always. Two overlapping runs would both write STATE_FILE and
// both fan out, and the second one's cap knows nothing about the first one's
// sessions — so a double fire opens double the sessions.
let busy = false;
// The panel's [x] STOP. While asking, it cancels the Claude job; while opening,
// it lets the session being started finish and opens no more after it.
let stopRequested = false;
let askingKey = '';

function stop() {
    if (!busy) { clearStale(); return { ok: true, note: 'nothing was running - cleared' }; }
    stopRequested = true;
    if (askingKey && deps.analyst && typeof deps.analyst.cancelJob === 'function') {
        // The retry runs under its own key; cancelling one that never started is a no-op.
        deps.analyst.cancelJob(askingKey);
        deps.analyst.cancelJob(`${askingKey}-retry1`);
    }
    return { ok: true };
}

function markStopped(state) {
    state.phase = 'stopped';
    state.error = 'stopped by you';
    state.opening = '';
    state.finishedAt = Date.now();
    saveState(state);
    console.log('[morning] stopped by the user');
    return state;
}

// opts: { manual, dryRun, maxSessions }
//   dryRun - ask, decide, report, open NOTHING. The honest way to watch it work
//            once before letting it open sessions at 6am.
async function run(opts = {}) {
    if (busy) return { ok: false, error: 'a morning run is already in progress' };
    busy = true;
    stopRequested = false;
    try { return await runInner(opts); } finally { busy = false; askingKey = ''; }
}

async function runInner(opts = {}) {
    const started = Date.now();
    const max = Math.max(0, Math.min(8, Number(opts.maxSessions) || MAX_SESSIONS));
    const today = new Date().toISOString().slice(0, 10);
    const stock = {
        today,
        live: liveSessions(),
        projects: knownProjects(),
        vaultNotes: recentVaultNotes(),
        claudeWork: recentClaudeWork(),
    };
    const state = {
        startedAt: started, today, phase: 'asking', dryRun: !!opts.dryRun,
        manual: !!opts.manual, brief: '', pending: [], opened: [], skipped: [], error: '',
    };
    saveState(state);

    if (!deps.analyst || !deps.jsonJob || !deps.registry || !deps.sessionSpawn) {
        state.phase = 'failed';
        state.error = 'the morning routine is not wired up (missing dependencies)';
        saveState(state);
        return state;
    }

    // (1) ask
    const key = `morning-${today}-${String(started).slice(-5)}`;
    askingKey = key;
    const answer = await deps.jsonJob.run({
        analyst: deps.analyst,
        key,
        kind: 'morning',
        // jobData is what the SecretCo choke point inspects. The stock-take is
        // local facts only: session names, project folders, vault filenames.
        jobData: stock,
        instruction: buildInstruction(stock),
        shape: PLAN_SHAPE,
        allowedTools: MORNING_TOOLS,
        retries: 1,
    });
    askingKey = '';
    if (stopRequested) return markStopped(state);

    if (!answer.ok) {
        state.phase = 'failed';
        state.error = answer.error || 'no answer';
        state.raw = String(answer.raw || '').slice(0, 2000);
        state.finishedAt = Date.now();
        saveState(state);
        event('morning', 'Morning routine failed', state.error);
        console.error(`[morning] failed: ${state.error}`);
        return state;
    }

    const plan = answer.value;
    state.brief = String(plan.brief || '');
    // The spoken version comes with the brief, from the same Claude job, so
    // playing it never loads the local model (2026-09-25).
    state.spokenPlan = String(plan.spoken || '').trim();
    state.pending = Array.isArray(plan.pending) ? plan.pending.slice(0, 40) : [];
    state.plannedSessions = (Array.isArray(plan.sessions) ? plan.sessions : []).slice(0, 12);
    state.phase = opts.dryRun ? 'planned' : 'opening';
    saveState(state);

    // (2) fan out
    await fanOut(state, { max, today, dryRun: opts.dryRun });
    if (stopRequested) { markStopped(state); writeBrief(state); return state; }

    state.phase = opts.dryRun ? 'planned' : 'done';
    state.finishedAt = Date.now();
    saveState(state);
    writeBrief(state);
    // A dry run decided and opened nothing, so waking the phone for it would be
    // waking him for a rehearsal.
    if (!opts.dryRun) notifyPhone(state);
    event('morning',
        opts.dryRun ? 'Morning plan ready (nothing opened)' : `Morning routine: ${state.opened.length} session(s) ready`,
        state.brief.split('\n').slice(0, 3).join(' '));
    console.log(`[morning] ${state.phase}: ${state.opened.length} opened, ${state.skipped.length} skipped, ${Math.round((Date.now() - started) / 1000)}s`);
    return state;
}

// The fan-out, shared by the full run and by "open the plan I am looking at".
// opts: { max, today, dryRun, only }
//   only - a list of session names or project names. Anything not in it is left
//          out silently (he unticked it), NOT reported as skipped: a skip line
//          means something went wrong, and choosing is not something going wrong.
async function fanOut(state, opts) {
    const wanted = (state.plannedSessions || [])
        .slice()
        .sort((a, b) => (Number(a.priority) || 99) - (Number(b.priority) || 99));
    const only = Array.isArray(opts.only) && opts.only.length
        ? new Set(opts.only.map(x => String(x)))
        : null;

    let attempts = 0;
    for (const s of wanted) {
        if (stopRequested) break;   // sessions already opened stay open
        const place = deps.registry.resolve(s.project);
        if (place.error) {
            if (!only || only.has(String(s.project))) state.skipped.push({ project: s.project, why: place.error });
            continue;
        }
        const base = sessionNameFor(s, place.project);
        if (only && !only.has(base) && !only.has(String(s.project))) continue;
        // ATTEMPTS, not successes. A spawn that fails half-way leaves the tmux
        // session ALIVE on purpose (it is the only place the reason is written
        // down), so counting successes would let a bad morning open twice the
        // sessions the cap allows — each one a real Claude waiting for input.
        if (attempts >= opts.max) {
            state.skipped.push({ project: s.project, why: `over the limit of ${opts.max} sessions` });
            continue;
        }
        if (opts.dryRun) {
            state.opened.push({ project: place.project, cwd: place.cwd, session: base, why: s.why || '', dryRun: true });
            continue;
        }
        attempts++;
        const name = deps.sessionExists(base) ? deps.sessionSpawn.nextSessionName(base, deps.sessionExists) : base;
        state.opening = name;
        saveState(state);
        const r = await deps.sessionSpawn.createPrimedSession({
            name,
            cwd: place.cwd,
            prompt: buildPrimingPrompt(s, place, opts.today),
        });
        if (r.ok) {
            state.opened.push({ project: place.project, cwd: place.cwd, session: name, why: s.why || '' });
            console.log(`[morning] opened ${name} in ${place.cwd}`);
        } else {
            state.skipped.push({ project: place.project, session: name, why: r.error });
            console.warn(`[morning] ${place.project}: ${r.error}`);
        }
        state.opening = '';
        saveState(state);
    }
    return state;
}

// ── open the plan that is already on disk ────────────────────────────────────
// A dry run reports and opens nothing on purpose. Re-running to get the sessions
// would spend a second headless Claude job AND could come back with a different
// plan — so the plan he read is the plan that opens.
//
// startOpen() is SYNCHRONOUS on purpose: the caller (an HTTP route) has to be
// told "there is no plan" or "it is already running" in its own response, while
// the opening itself takes a minute per session and cannot be waited on.
function startOpen(opts = {}) {
    const state = loadState();
    if (!state) return { ok: false, error: 'there is no plan yet - run it once first' };
    if (busy || state.phase === 'asking' || state.phase === 'opening') {
        return { ok: false, error: 'a morning run is already in progress' };
    }
    const planned = (state.plannedSessions || []).length;
    if (!planned) return { ok: false, error: 'that plan names no sessions to open' };
    busy = true;
    stopRequested = false;
    const p = openPlanned(state, opts).catch(e => {
        console.error('[morning] open failed:', e.message);
        const s = loadState() || state;
        s.phase = 'failed'; s.error = e.message; s.opening = '';
        saveState(s);
    }).finally(() => { busy = false; });
    return { ok: true, started: true, planned, promise: p };
}

async function openPlanned(state, opts = {}) {
    const max = Math.max(0, Math.min(8, Number(opts.maxSessions) || MAX_SESSIONS));
    const today = state.today || new Date().toISOString().slice(0, 10);
    // Placeholders from the dry run are what he was looking at, not sessions
    // that exist. Drop them; keep anything that really opened.
    state.opened = (state.opened || []).filter(o => !o.dryRun);
    state.skipped = [];
    state.dryRun = false;
    state.phase = 'opening';
    state.error = '';
    state.openedFromPlan = true;
    state.startedAt = Date.now();
    delete state.finishedAt;
    saveState(state);

    await fanOut(state, { max, today, dryRun: false, only: opts.only });
    if (stopRequested) { markStopped(state); writeBrief(state); return state; }

    state.phase = 'done';
    state.opening = '';
    state.finishedAt = Date.now();
    saveState(state);
    writeBrief(state);
    notifyPhone(state);
    event('morning', `Morning plan: ${state.opened.length} session(s) ready`,
        (state.opened || []).map(o => o.session).join(', '));
    console.log(`[morning] opened from plan: ${state.opened.length} opened, ${state.skipped.length} skipped`);
    return state;
}

function sessionNameFor(s, project) {
    const raw = String(s.session || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    const safe = raw || `am-${project}`;
    return safe.slice(0, 40);
}

function buildPrimingPrompt(s, place, today) {
    return [
        `Good morning. This session was opened for you by TSRCT's morning routine on ${today}.`,
        `Project: ${place.project}`,
        `Directory: ${place.cwd}`,
        `Why this session is open: ${s.why || 'work picked up from yesterday'}`,
        '',
        String(s.prompt || '').trim(),
        '',
        'Leon is not awake yet. Do not change any code, and do not run anything that costs money',
        'or touches a live system, until he has answered. Reply with ONE line saying what you',
        'understand needs to happen, then wait.',
    ].join('\n');
}

// The brief belongs where he already reads things, not only in a panel.
function writeBrief(state) {
    if (!state.brief) return;
    try {
        const dir = path.join(VAULT_ROOT, 'sessions');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${state.today}-morning-brief.md`);
        const lines = [
            `# Morning brief - ${state.today}`,
            '',
            state.brief,
            '',
            '## Pending',
            ...(state.pending.length
                ? state.pending.map(p => `- **${p.title}** (${p.source})${p.project ? ` - ${p.project}` : ''}: ${p.why}`)
                : ['- (nothing found)']),
            '',
            '## Sessions opened',
            ...(state.opened.length
                ? state.opened.map(o => `- \`${o.session}\` in ${o.cwd}${o.dryRun ? ' (dry run - not actually opened)' : ''} - ${o.why}`)
                : ['- (none)']),
            ...(state.skipped.length ? ['', '## Skipped', ...state.skipped.map(s => `- ${s.project || s.session}: ${s.why}`)] : []),
        ];
        fs.writeFileSync(file, lines.join('\n'));
    } catch (e) {
        console.error('[morning] could not write the brief:', e.message);
    }
}

// ── the brief, as something to SAY ───────────────────────────────────────────
// The brief is written English; the voice that reads it is House, in Spanish.
// Those do not meet on their own: a Spanish voice reading English is a mess,
// and text written to be READ ("12 allocations plus 449 movements") is not how
// anybody says it out loud.
//
// The local model does that rewrite - a short, shaped, one-shot job, which is
// exactly what it is good at and exactly what the cloud model is not needed
// for. It is CACHED against the brief it came from, so pressing play twice
// costs nothing and a new brief invalidates it on its own.
//
// If Ollama is off (the normal state while the GPU is busy) this returns null
// and the caller falls back to the English voice reading the English text. The
// feature degrades, it never blocks.
async function spokenBrief(opts = {}) {
    const state = loadState();
    if (!state || !state.brief) return { ok: false, error: 'there is no brief yet' };
    const stamp = `${state.today}:${state.brief.length}:${state.finishedAt || 0}`;
    if (!opts.force && state.spokenEs && state.spokenFor === stamp) {
        return { ok: true, text: state.spokenEs, voice: SPOKEN_VOICE, cached: true };
    }
    if (state.spokenPlan) return { ok: true, text: state.spokenPlan, voice: SPOKEN_VOICE, cached: true };
    // The local model rewrites it only when he chose the local brain. Leon,
    // 2026-09-25: "no quiero que siga cargando el modelo local".
    if ((process.env.TALK_BRAIN || 'haiku') !== 'local') {
        return { ok: false, error: 'this brief has no spoken version (it is written by the next morning run)', fallback: state.brief };
    }
    if (!deps.hermes || typeof deps.hermes.toSpokenSpanish !== 'function') {
        return { ok: false, error: 'the local model is not available', fallback: state.brief };
    }
    let said = null;
    try {
        said = await deps.hermes.toSpokenSpanish({ text: state.brief });
    } catch (e) {
        return { ok: false, error: e.message, fallback: state.brief };
    }
    if (!said) return { ok: false, error: 'the local model did not answer (is ollama running?)', fallback: state.brief };
    const fresh = loadState() || state;          // the run may have moved on while we waited
    fresh.spokenEs = said;
    fresh.spokenFor = stamp;
    saveState(fresh);
    return { ok: true, text: said, voice: SPOKEN_VOICE, cached: false };
}

module.exports = {
    configure, run, stop, startOpen, loadState, buildInstruction, spokenBrief,
    PLAN_SHAPE, MAX_SESSIONS, STATE_FILE, MORNING_TOOLS,
};
