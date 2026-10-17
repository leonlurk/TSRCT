'use strict';
// ── progressReport.js — "what did this tab get done today?" ──────────────────
//
// The [R] button on the split-tab bar (2026-10-06). Leon paints a panel blue
// when he considers its work finished; at the end of the day he wants the
// Slack update ("Tasks nailed today: / Pending:") written from what is actually
// on screen, and checked against what people asked him for.
//
// Two halves, the same split as the morning routine:
//   1. LOCAL, no model: for every session in the tab, find ITS Claude transcript
//      and pull out today's requests and finished answers. The transcript is
//      found through ~/.claude/sessions/<pid>.json, which Claude Code writes
//      with the tmux pane it runs in ("tmux": "nrsite:@3.%3") and the sessionId.
//      Several tmux sessions often share one folder, so "the newest log in the
//      folder" would read the wrong conversation; that is only the fallback.
//   2. ONE headless Claude job (lib/jsonJob.js -> analyst.submitJob, the SecretCo
//      choke point) that cross-reads those digests with ClickUp, Slack, Gmail,
//      calendar and the vault, READ side only, and answers JSON.
//
// THE TRANSCRIPT IS THE TRUTH, the panel colour is a hint (his words: "la
// realidad está detrás de leer realmente lo que hay en la sesión"). The colour
// and what it means go in so the job can say where his mark and the work
// disagree, never to decide "done" on its own.
//
// The Slack text is assembled HERE from the JSON, not written by the model, so
// the format is always his format.
//
// SecretCo: a session whose name or folder mentions SecretCo is dropped before
// anything is sent and listed as skipped; inside the others, each turn that names
// SecretCo is left out; anything that still mentions it drops the session; and the
// analyst choke point checks the job data again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const restrictedGuard = require('./dispatcher/restrictedGuard');
const pastSessions = require('./pastSessions');
const { stateFile } = require('./stateFile');

const STATE_FILE = process.env.PROGRESS_STATE_FILE || stateFile('progress.json', '.tsrct-progress.json');
const CLAUDE_SESSIONS = process.env.CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
const VAULT_ROOT = paths.VAULT_ROOT;
const MODEL = process.env.PROGRESS_MODEL || '';          // '' = the analyst's default
const TAIL_BYTES = 3 * 1024 * 1024;                      // a whole day of one session, usually
const PER_SESSION_CHARS = 9000;                          // what one session may add to the prompt
const MAX_SESSIONS = 16;

let deps = {
    analyst: null,          // lib/dispatcher/clickupAnalyst
    jsonJob: null,          // lib/jsonJob
    paneCwd: null,          // (session) => folder of its pane, for the fallback
    morning: null,          // () => morningRoutine.loadState()
};
function configure(injected) {
    deps = { ...deps, ...(injected || {}) };
    clearStale();
}

let busy = false;
let runningKey = '';

// ── the answer we require ────────────────────────────────────────────────────
const SHAPE = {
    object: {
        done: { array: 'string' },
        pending: { array: { object: { item: 'string', blocker: 'string' }, optional: ['blocker'] } },
        askedNotWorked: {
            array: { object: { item: 'string', source: 'string', who: 'string', due: 'string' }, optional: ['who', 'due'] },
        },
        workedNotAsked: { array: 'string' },
        markMismatch: { array: { object: { session: 'string', note: 'string' } } },
        unread: { array: 'string' },
    },
    optional: ['askedNotWorked', 'workedNotAsked', 'markMismatch', 'unread'],
};

// ── 1. local: which transcript is this tmux session? ─────────────────────────
function sessionRecords() {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(CLAUDE_SESSIONS).filter(f => f.endsWith('.json')); } catch { return out; }
    for (const f of files) {
        try {
            const o = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS, f), 'utf8'));
            if (o && o.sessionId && o.cwd && typeof o.tmux === 'string') out.push(o);
        } catch { /* half-written or not ours */ }
    }
    return out;
}

function transcriptFor(session, records) {
    const mine = (records || sessionRecords())
        .filter(r => r.tmux.split(':')[0] === session)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const r of mine) {
        const file = path.join(pastSessions.dirFor(r.cwd), `${r.sessionId}.jsonl`);
        if (fs.existsSync(file)) return { file, cwd: r.cwd, how: 'pane' };
    }
    // Fallback: the newest conversation in the pane's folder. Marked, because
    // with several sessions in one folder it can be another session's.
    const cwd = deps.paneCwd ? safe(() => deps.paneCwd(session)) : '';
    if (!cwd) return null;
    try {
        const dir = pastSessions.dirFor(cwd);
        const newest = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
            .map(f => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)[0];
        return newest ? { file: newest.f, cwd, how: 'folder' } : null;
    } catch { return null; }
}

function safe(fn) { try { return fn(); } catch { return ''; } }

function textOf(m) {
    const c = m && m.content;
    if (typeof c === 'string') return c;
    return (c || []).filter(p => p && p.type === 'text').map(p => p.text || '').join(' ');
}

function human(r) {
    if (r.type !== 'user' || !r.message || r.isMeta) return '';
    const t = textOf(r.message).replace(/<\/?pasted_content[^>]*>/g, '').trim();
    if (!t || /^<(command|local-command|system-reminder|task-notification)/.test(t) || /^Caveat:/.test(t)) return '';
    if (/^This session is being continued from a previous conversation/.test(t)) return '';
    return t;
}

function localDayStart(now = new Date()) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

const flat = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// Today's turns of one transcript: what he asked, what came back finished.
// Over budget, the OLDEST turns go first: the end of the day is where the state is.
function digest(file, since) {
    const size = fs.statSync(file).size;
    const len = Math.min(size, TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    let text;
    try {
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, size - len);
        text = b.toString('utf8');
    } finally { fs.closeSync(fd); }
    const turns = [];
    let last = null;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        const at = Date.parse(r.timestamp || '') || 0;
        const h = human(r);
        if (h) { last = { at, who: 'Leon', text: flat(h, 500) }; if (at >= since) turns.push(last); continue; }
        if (r.type === 'assistant' && r.message && r.message.stop_reason === 'end_turn') {
            const t = textOf(r.message).trim();
            if (!t) continue;
            last = { at, who: 'Claude', text: flat(t, 900) };
            if (at >= since) turns.push(last);
        }
    }
    let out = turns, chars = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
        chars += turns[i].text.length + 10;
        if (chars > PER_SESSION_CHARS) { out = turns.slice(i + 1); break; }
    }
    return { turns: out, cut: turns.length - out.length, lastAt: last ? last.at : 0, lastTurn: out.length ? null : last };
}

// YYYY-MM-DD in the process's local time (.env sets TZ; WSL itself runs on UTC).
function localDate(ms = Date.now()) {
    return new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function hhmm(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// sessions: [{ name, color, meaning, state }] from the page.
function collect(sessions, now = new Date()) {
    const since = localDayStart(now);
    const records = sessionRecords();
    const read = [], skipped = [];
    for (const s of (sessions || []).slice(0, MAX_SESSIONS)) {
        const name = String(s && s.name || '').trim();
        if (!name) continue;
        if (restrictedGuard.mentionsRestricted(name)) { skipped.push({ session: name, why: 'SecretCo, never read here' }); continue; }
        const t = transcriptFor(name, records);
        if (!t) { skipped.push({ session: name, why: 'no Claude conversation found for this session' }); continue; }
        if (restrictedGuard.mentionsRestricted(t.cwd)) { skipped.push({ session: name, why: 'SecretCo, never read here' }); continue; }
        let d;
        try { d = digest(t.file, since); } catch (e) { skipped.push({ session: name, why: `could not read its log (${e.message})` }); continue; }
        // A LINE that names SecretCo is left out, not the whole session (2026-10-08:
        // gaap, wrl-sync and fl-overdue vanished from his report over one mention,
        // "ni siquiera hay laburo de secretco en esas sesiones"). Real SecretCo work runs
        // in its own folder, which is refused above by name and folder; the check
        // on the whole entry below still drops anything that slips through.
        const kept = d.turns.filter(x => !restrictedGuard.mentionsRestricted(x.text));
        const leftOut = d.turns.length - kept.length;
        const lastTurn = d.lastTurn && !restrictedGuard.mentionsRestricted(d.lastTurn.text) ? d.lastTurn : null;
        const project = path.basename(t.cwd);
        const entry = {
            session: name,
            project,
            mark: s.color ? `${s.color}${s.meaning ? ` = "${s.meaning}"` : ''}` : 'none',
            state: String(s.state || 'unknown'),
            found: t.how,
            today: kept.map(x => `[${hhmm(x.at)}] ${x.who}: ${x.text}`),
            olderCut: d.cut,
            ...(leftOut ? { leftOut } : {}),
            lastBeforeToday: lastTurn ? `[${new Date(lastTurn.at).toISOString().slice(0, 10)}] ${lastTurn.who}: ${lastTurn.text}` : '',
        };
        if (restrictedGuard.mentionsRestricted(JSON.stringify(entry))) { skipped.push({ session: name, why: 'its conversation mentions SecretCo, not sent' }); continue; }
        read.push(entry);
    }
    return { read, skipped };
}

// ── 2. the question ──────────────────────────────────────────────────────────
const TOOLS = [
    'Read', 'Glob', 'Grep',
    ...['slack_search_public_and_private', 'slack_search_public', 'slack_search_users', 'slack_search_channels',
        'slack_read_channel', 'slack_read_thread', 'slack_read_user_profile'].map(t => `mcp__claude_ai_Slack__${t}`),
    ...['clickup_search', 'clickup_filter_tasks', 'clickup_get_task', 'clickup_get_task_comments',
        'clickup_get_threaded_comments', 'clickup_get_workspace_hierarchy', 'clickup_get_list',
        'clickup_find_member_by_name', 'clickup_resolve_assignees'].map(t => `mcp__claude_ai_ClickUp__${t}`),
    ...['search_threads', 'get_thread', 'get_message', 'list_labels'].map(t => `mcp__claude_ai_Gmail__${t}`),
    ...['list_events', 'list_calendars', 'get_event', 'search_events'].map(t => `mcp__claude_ai_Google_Calendar__${t}`),
];

function morningPending() {
    const st = safe(() => deps.morning && deps.morning());
    if (!st || !Array.isArray(st.pending)) return [];
    const today = localDate();
    if (st.today && st.today < localDate(Date.now() - 2 * 864e5)) return [];
    return st.pending.slice(0, 30).map(p => `${flat(p.title, 160)} (${flat(p.source, 60)})`)
        .filter(l => !restrictedGuard.mentionsRestricted(l))
        .concat(st.today && st.today !== today ? [`(that brief is from ${st.today})`] : []);
}

function buildInstruction(job) {
    const panels = job.read.map(p => [
        `### ${p.session}  (project folder: ${p.project}; his colour mark: ${p.mark}; live state: ${p.state}${p.found === 'folder' ? '; NOTE: matched by folder only, may be another session in the same folder' : ''})`,
        ...(p.today.length ? p.today : [`(no activity today${p.lastBeforeToday ? `; last before today: ${p.lastBeforeToday}` : ''})`]),
        p.olderCut ? `(${p.olderCut} earlier turns today not shown)` : '',
    ].filter(Boolean).join('\n')).join('\n\n');

    return `You are writing Leon's end-of-day progress report for ONE group of his work
sessions ("${job.group}"), today ${job.today}, and checking that work against what
people asked him for.

PART A - WHAT HE WORKED ON. Below is what was said today in each Claude session of
this group (his requests and Claude's finished answers, oldest first). THIS IS THE
TRUTH about what got done. Each session also carries his colour mark: he paints a
panel when he considers it finished (usually blue). The mark is HIS opinion, a hint:
decide done or not from the conversation, and when your reading disagrees with his
mark, say so in markMismatch.

${panels || '(no session could be read)'}

PART B - WHAT WAS ASKED OF HIM. Read these sources fresh, READ ONLY. The morning
brief below is a starting point, NOT the full list: tasks get added during the day
and old asks are not always in it.
  1. ClickUp: tasks assigned to him that are open, due today or overdue, or
     created / commented today.
  2. Slack: DMs and mentions from the last 7 days that ask him for something.
  3. Gmail: the last 7 days, mail that asks him for an action.
  4. Google Calendar: today's meetings (a meeting he had is work done).
  5. The vault at ${VAULT_ROOT}: sessions/ notes from today and yesterday.
Today's morning brief listed as pending:
${job.morning.map(l => `  - ${l}`).join('\n') || '  (no morning brief available)'}
If a source cannot be read, name it in "unread" and carry on. Never guess its content.
Other connectors this account has are NOT part of this job: do not open them.

HARD SECRETCO EXCLUSION: never read, name, or report anything about SecretCo or SecretCoSandbox.

THEN CROSS-READ. The same work shows up in several places (a ClickUp task, a Slack
ask about it, a session working on it): it is ONE item.

WRITING RULES for done and pending (they are pasted into Slack as they are):
  - English, short and dry, like a person reporting to his team. One line each,
    at most ~14 words, no explanation, no "successfully", no emojis.
  - Name the client or project and the thing, e.g. "Lilypad Leap tasks assigned by Jo",
    "Set up a few reports for Paul/HARBOR", "Tested new AF package".
  - done = finished TODAY in these sessions (or a meeting held today that belongs to
    this group's work). A session that worked toward something unfinished goes to pending.
  - pending = started or asked and not finished. "blocker" = what it waits on, a few
    words, only if the conversation or a source says so.
  - Only work of THIS group goes in done/pending.

askedNotWorked: things asked of him (ClickUp/Slack/Gmail/calendar) that NO session in
this group touched today and that belong to the same clients/projects as this group,
plus anything due today or overdue whatever the project. source = where (e.g.
"ClickUp: <task name>", "Slack DM from Jo"), who = who asked, due = date if any.
workedNotAsked: work done in these sessions that nobody asked for (one line each).

Answer with ONLY this JSON, no prose, no markdown fence:
{
  "done": ["<line>", ...],
  "pending": [{"item": "<line>", "blocker": "<few words or omit>"}],
  "askedNotWorked": [{"item": "<line>", "source": "<where>", "who": "<who>", "due": "<YYYY-MM-DD or omit>"}],
  "workedNotAsked": ["<line>"],
  "markMismatch": [{"session": "<tmux name>", "note": "<one line>"}],
  "unread": ["<source that could not be read, and why>"]
}`;
}

// ── the Slack text, assembled here so the format never drifts ────────────────
function slackText(v) {
    const done = (v.done || []).map(s => flat(s, 200)).filter(Boolean);
    const pend = (v.pending || []).map(p => {
        const item = flat(p && p.item, 200);
        const b = flat(p && p.blocker, 140);
        return item ? (b ? `${item} (${b})` : item) : '';
    }).filter(Boolean);
    const lines = ['Tasks nailed today:'];
    lines.push(...(done.length ? done.map(s => `• ${s}`) : ['• (nothing finished yet)']));
    if (pend.length) { lines.push('', 'Pending:', ...pend.map(s => `• ${s}`)); }
    return lines.join('\n');
}

// ── state ────────────────────────────────────────────────────────────────────
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { reports: {} }; }
}
function saveState(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[progress] save:', e.message); }
}

function clearStale() {
    if (busy) return;
    const s = loadState();
    let changed = false;
    for (const r of Object.values(s.reports || {})) {
        if (r.phase === 'running') { r.phase = 'failed'; r.error = 'interrupted: TSRCT restarted during the run'; changed = true; }
    }
    if (changed) saveState(s);
}

function view() {
    const s = loadState();
    return { busy, reports: s.reports || {} };
}

// Answers at once; the job takes minutes. opts: { group, sessions }
function start(opts = {}) {
    if (busy) return { ok: false, error: 'a progress report is already running' };
    if (!deps.analyst || !deps.jsonJob) return { ok: false, error: 'the report is not wired up (no analyst)' };
    const group = flat(opts.group || 'selection', 60);
    const sessions = Array.isArray(opts.sessions) ? opts.sessions : [];
    if (!sessions.length) return { ok: false, error: 'no sessions in this tab' };
    busy = true;
    setImmediate(() => runInner(group, sessions).catch(e => console.error('[progress] run:', e.message))
        .finally(() => { busy = false; runningKey = ''; }));
    return { ok: true };
}

function stop() {
    if (!busy || !runningKey) return { ok: false, error: 'nothing is running' };
    try { deps.analyst.cancelJob(runningKey); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true };
}

async function runInner(group, sessions) {
    const started = Date.now();
    const today = localDate(started);
    const put = (patch) => {
        const s = loadState();
        s.reports = s.reports || {};
        s.reports[group] = { ...(s.reports[group] || {}), ...patch };
        saveState(s);
        return s.reports[group];
    };
    put({ group, phase: 'running', startedAt: started, finishedAt: 0, error: '', sessions: sessions.map(x => x.name) });

    const { read, skipped } = collect(sessions);
    if (!read.length) {
        return put({ phase: 'failed', finishedAt: Date.now(), skipped, error: 'none of these sessions has a Claude conversation that could be read' });
    }
    const job = { group, today, read, morning: morningPending() };
    const key = `progress-${today}-${String(started).slice(-6)}`;
    runningKey = key;
    const answer = await deps.jsonJob.run({
        analyst: deps.analyst,
        key,
        kind: 'progress',
        // What the SecretCo choke point inspects: everything the job is given.
        jobData: job,
        instruction: buildInstruction(job),
        shape: SHAPE,
        allowedTools: TOOLS,
        model: MODEL || undefined,
        retries: 1,
    });
    if (!answer.ok) {
        return put({ phase: 'failed', finishedAt: Date.now(), skipped, error: answer.error || 'no answer', raw: String(answer.raw || '').slice(0, 2000) });
    }
    const v = answer.value;
    if (restrictedGuard.mentionsRestricted(JSON.stringify(v))) {
        return put({ phase: 'failed', finishedAt: Date.now(), skipped, error: 'the answer mentioned SecretCo and was discarded' });
    }
    console.log(`[progress] ${group}: ${read.length} session(s) read, ${Math.round((Date.now() - started) / 1000)}s`);
    return put({
        phase: 'done', finishedAt: Date.now(), skipped,
        read: read.map(r => ({ session: r.session, turns: r.today.length, found: r.found })),
        slack: slackText(v),
        done: v.done || [], pending: v.pending || [],
        askedNotWorked: v.askedNotWorked || [], workedNotAsked: v.workedNotAsked || [],
        markMismatch: v.markMismatch || [], unread: v.unread || [],
    });
}

module.exports = {
    configure, start, stop, view,
    // for scripts/check-progress.js
    _collect: collect, _digest: digest, _transcriptFor: transcriptFor, _slackText: slackText,
    _buildInstruction: buildInstruction, SHAPE,
};
