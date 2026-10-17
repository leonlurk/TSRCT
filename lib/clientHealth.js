'use strict';
// ── clientHealth.js — how each client relationship is doing, for the Clients tab ──
//
// THE PRINCIPLE (Leon, 2026-09-21): the tab must not depend on HOW work is
// recorded. Today a client's requests are checkboxes in one master task,
// tomorrow loose tasks, subtasks, native checklists, comments, or only a mail.
// So nothing here knows a task id, a tag or a description format. A client is
// CONFIG — a name, its mail domain(s), and where it lives in ClickUp (folders
// and/or lists) — and headless Claude reads EVERYTHING there plus the mail and
// reports the REQUESTS: what was asked, what is resolved, what is open, where
// it lives. What matters is the request, not the container.
//
// WHO DECIDES WHAT:
//   - Claude (read-only connectors) interprets and merges; it reports facts.
//   - this module merges again only where the facts PROVE it (the same ClickUp
//     place listed twice), and decides every judgement: the colour, overdue, this week vs
//     backlog, the trend. Same facts, same dot, every time.
//   - an item Claude is not sure about is KEPT and flagged `review`, never dropped.
//
// Runs as part of the 06:00 morning routine, or alone from the tab's [Refresh].
// READ-ONLY END TO END: read tools only; this module has no network code. The
// only thing it writes is TSRCT's own files (the report, the expired marks).
//
// SECRETCO: config entries and reports that mention SecretCo are dropped; the job
// data passes the analyst choke point.

const fs = require('fs');
const path = require('path');
const restrictedGuard = require('./dispatcher/restrictedGuard');
const { stateFile } = require('./stateFile');

const ROOT = path.join(__dirname, '..');
const STORE = process.env.CLIENTS_STATE_FILE || stateFile('clients.json', '.tsrct-clients.json');
const CONFIG_FILE = process.env.CLIENTS_CONFIG_FILE || stateFile('clients-config.json', '.tsrct-clients-config.json');
// What Leon marked EXPIRED in the tab: never shown again, and the job is told
// not to report it. Local to TSRCT — expiring does not touch ClickUp or Gmail.
const EXPIRED_FILE = process.env.CLIENTS_EXPIRED_FILE || STORE.replace(/\.json$/, '') + '-expired.json';

// The health rule. Kept as numbers here so the tooltip and the code agree.
const RULE = {
    unansweredHours: 24,     // weekday hours a client mail may wait before red
    oldestOpenDays: 30,      // oldest open request older than this -> yellow
    dueSoonDays: 7,          // due within this many days -> "this week"
    newDays: 14,             // asked within this many days -> "this week"
    resolvedLookbackDays: 14,
    mailLookbackDays: 30,
};

let deps = { analyst: null, jsonJob: null };
function configure(injected) { deps = { ...deps, ...(injected || {}) }; }

// ── config: the only place a client exists ───────────────────────────────────
// .tsrct-clients-config.json (gitignored):
//   { "clients": [ { "name": "...", "code": "...", "domains": ["x.com"],
//                    "clickup": { "workspace": "123", "folders": ["456"], "lists": [] } } ] }
const ID_RE = /^\d{3,20}$/;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

function loadConfig() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return []; }
    return (Array.isArray(raw && raw.clients) ? raw.clients : [])
        .map(c => ({
            name: str(c && c.name, 80),
            code: str(c && c.code, 12),
            domains: list(c && c.domains, 10).map(d => str(d, 80).toLowerCase()).filter(d => DOMAIN_RE.test(d)),
            clickup: {
                workspace: ID_RE.test(String(c && c.clickup && c.clickup.workspace)) ? String(c.clickup.workspace) : '',
                folders: list(c && c.clickup && c.clickup.folders, 20).map(String).filter(x => ID_RE.test(x)),
                lists: list(c && c.clickup && c.clickup.lists, 50).map(String).filter(x => ID_RE.test(x)),
            },
        }))
        .filter(c => c.name && (c.domains.length || c.clickup.folders.length || c.clickup.lists.length))
        .filter(c => !restrictedGuard.mentionsRestricted(JSON.stringify(c)));
}

// ── the answer we require ────────────────────────────────────────────────────
const S = 'string';
const CLIENT_SHAPE = {
    object: {
        name: S, last_in: S, last_out: S, summary: S,
        actions: { array: { object: { do: S, why: S, thread_id: S, url: S }, optional: ['why', 'thread_id', 'url'] } },
        requests: {
            array: {
                object: {
                    title: S, who: S, first_asked: S, status: S, resolved_on: S, priority: S, due: S, quote: S,
                    places: { array: { object: { url: S, label: S }, optional: ['label'] } },
                    thread_ids: { array: S }, review: S,
                },
                optional: ['who', 'first_asked', 'resolved_on', 'priority', 'due', 'quote', 'places', 'thread_ids', 'review'],
            },
        },
        unanswered: { array: { object: { subject: S, who: S, received: S, thread_id: S }, optional: ['who', 'thread_id'] } },
        // `due` optional: a promise found in a mail without a date failed the whole brief (2026-09-23).
        promises: { array: { object: { what: S, due: S, thread_id: S, url: S }, optional: ['due', 'thread_id', 'url'] } },
    },
    optional: ['last_in', 'last_out', 'summary', 'actions', 'unanswered', 'promises'],
};
const CLIENTS_SHAPE = { array: CLIENT_SHAPE };

// Read side only. Nothing here can send, post, create or delete.
const CLIENT_TOOLS = [
    ...['clickup_filter_tasks', 'clickup_get_task', 'clickup_get_task_comments', 'clickup_get_threaded_comments',
        'clickup_get_list', 'clickup_get_folder', 'clickup_get_workspace_hierarchy', 'clickup_search']
        .map(t => `mcp__claude_ai_ClickUp__${t}`),
    ...['search_threads', 'get_thread', 'get_message'].map(t => `mcp__claude_ai_Gmail__${t}`),
];

// ── the question (shared by the morning routine and the standalone refresh) ──
function clientLines(cfg) {
    return cfg.map(c => {
        const where = [
            c.clickup.workspace && `workspace ${c.clickup.workspace}`,
            c.clickup.folders.length && `folder(s) ${c.clickup.folders.join(', ')}`,
            c.clickup.lists.length && `list(s) ${c.clickup.lists.join(', ')}`,
        ].filter(Boolean).join('; ');
        return `  - "${c.name}": mail ${c.domains.join(', ') || '(none)'}; ClickUp ${where || '(none)'}`;
    }).join('\n');
}

function instructionSection(cfg = loadConfig()) {
    if (!cfg.length) return 'CLIENT HEALTH: no clients are configured - return "clients": [].';
    return `CLIENT HEALTH - read everything about each client below and report its REQUESTS as they really
stand. Facts only: TSRCT decides the colour and what is urgent.

CLIENTS (report exactly these, with exactly these names, and no others):
${clientLines(cfg)}

READ, per client:
  - ClickUp: EVERY task in those folders/lists - open, and closed in the last 30 days
    (clickup_filter_tasks with folder_ids / list_ids, include_closed true, subtasks true; keep
    paging while has_more is true). Open each one with clickup_get_task: description, native
    checklists, subtasks, status, priority, dates, assignees, tags. Read comments where they may
    carry a request or its status.
  - Gmail: threads with those mail domains in the last ${RULE.mailLookbackDays} days, who wrote last and when.
    Also open any older thread whose id appears in ClickUp text when you need it to judge a status.

A request can live ANYWHERE: a whole task, a subtask, a checklist item, a markdown checkbox
("- [ ]" / "- [x]") in a description, a comment, or only a mail. Do not assume any one format.
What matters is the request, not the container.

MERGE DUPLICATES: the same request can be a checkbox in one task, a separate task and a mail at
once. A Gmail thread id appearing in any text (e.g. "Source thread: <id>") is strong evidence two
items are the same request; the content decides. One mail can carry SEVERAL different requests:
same thread with a different ask is a different request. Report each request ONCE, with every
place it lives in.

For each client:
  - name: exactly as listed above.
  - requests: every OPEN request, plus requests RESOLVED in the last ${RULE.resolvedLookbackDays} days. Each:
      title        short plain name
      who          the client person who asked
      first_asked  YYYY-MM-DD of the client's FIRST ask (the mail date or the quoted date), NOT when a
                   task was created
      status       "resolved" only if the PROBLEM is solved - task closed, checkbox ticked, or clear
                   evidence in the mail. Having replied is NOT resolved. Otherwise "open".
      resolved_on  YYYY-MM-DD, when resolved and you can tell
      priority, due  from the container, when it has them (due as YYYY-MM-DD)
      quote        the client's own words, VERBATIM, cut to 300 characters with "..."
      places       EVERY ClickUp place it lives in: {"url": the task that holds it, "label": that task's
                   name, plus " #<n>" when it is checkbox or checklist item n}
      thread_ids   EVERY Gmail thread id tied to it
      review       OMIT when you are sure. Otherwise a few words on what is unclear ("sources disagree
                   on status", "cannot tell if resolved"). Never drop an item because you are unsure.
  - unanswered: threads whose last message is from the client with no reply from us after it
    (received = ISO date-time of that message, who = sender's first name).
  - promises: things someone at ACME promised them in writing, not yet delivered. due = the promised
    date (YYYY-MM-DD); OMIT due when no date was given - never invent one.
  - last_in / last_out: ISO date-time of the newest mail FROM them / from us TO them.
    If Gmail cannot be read, OMIT unanswered, promises, last_in and last_out - an empty list would
    read as "nothing pending".
  - summary: AT MOST 30 words, plain, for Leon: how the relationship stands right now and the one
    thing that matters most. No jargon, no list, no colour words.
  - actions: at most 3 concrete next steps for Leon, most important first ("Reply to Ann about the
    missing order in the report", not "follow up"), each tied to the thread_id or ClickUp url it acts
    on. A request months old with no mail since is backlog, not a next step.
${expiredBlock()}
Exact dates only. Never include a client, task or mail that mentions SecretCo.`;
}

// Tell the job what Leon already marked expired. The server ALSO drops these:
// this line saves a wasted mention, it is not what keeps them off the screen.
function expiredBlock() {
    const ex = Object.values(loadExpired());
    if (!ex.length) return '';
    const lines = ex.slice(-80).map(e =>
        `    - ${e.client ? e.client + ': ' : ''}${e.title || e.key}  (expired ${new Date(e.at).toISOString().slice(0, 10)})`);
    return `  - EXPIRED BY LEON - do not report these again anywhere (requests, unanswered, promises,
    actions, summary), unless the client wrote about it again after that date:
${lines.join('\n')}
`;
}

function jsonTemplate() {
    return `"mailbox": "<the Gmail address you read, or omit>",
  "clients": [
    {"name": "<exactly as listed>",
     "last_in": "<ISO>", "last_out": "<ISO>",
     "summary": "...",
     "actions": [{"do": "...", "why": "...", "thread_id": "...", "url": "https://app.clickup.com/t/..."}],
     "requests": [{"title": "...", "who": "...", "first_asked": "YYYY-MM-DD", "status": "open",
                   "resolved_on": "YYYY-MM-DD", "priority": "high", "due": "YYYY-MM-DD", "quote": "...",
                   "places": [{"url": "https://app.clickup.com/t/...", "label": "... #3"}],
                   "thread_ids": ["..."], "review": "..."}],
     "unanswered": [{"subject": "...", "who": "...", "received": "<ISO>", "thread_id": "..."}],
     "promises": [{"what": "...", "due": "YYYY-MM-DD", "thread_id": "...", "url": "..."}]}
  ]`;
}

// ── cleaning what came back ──────────────────────────────────────────────────
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const THREAD_RE = /^[A-Za-z0-9_-]{6,64}$/;
const HIGH = new Set(['urgent', 'high']);

function str(v, max) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max || 200); }
function day(v) { const s = str(v, 10); return DAY_RE.test(s) ? s : ''; }
function stamp(v) { const s = str(v, 40); return s && !isNaN(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : ''; }
function thread(v) { const s = str(v, 64); return THREAD_RE.test(s) ? s : ''; }
function cuUrl(v) { const s = str(v, 300); return /^https:\/\/app\.clickup\.com\/[A-Za-z0-9/_#?=&.%-]+$/.test(s) ? s : ''; }
function list(v, max) { return Array.isArray(v) ? v.slice(0, max || 200) : []; }
function uniq(a) { return [...new Set(a)]; }

function cleanRequest(r) {
    return {
        title: str(r.title), who: str(r.who, 40), first_asked: day(r.first_asked),
        status: str(r.status, 12).toLowerCase() === 'resolved' ? 'resolved' : 'open',
        resolved_on: day(r.resolved_on),
        priority: str(r.priority, 12).toLowerCase(), due: day(r.due), quote: str(r.quote, 400),
        places: list(r.places, 8).map(p => ({ url: cuUrl(p && p.url), label: str(p && p.label, 120) })).filter(p => p.url),
        thread_ids: uniq(list(r.thread_ids, 12).map(thread).filter(Boolean)),
        review: str(r.review, 120),
    };
}

// The job is asked to merge; this is the net under it, and it only acts on
// PROOF: two requests that name the same ClickUp place (same task, same
// checkbox label) are the same request. A shared Gmail thread is NOT proof —
// measured on real data 2026-09-22, one client mail carried three separate
// requests, and merging on the thread folded 25 requests into 18. That
// judgement belongs to the job, which reads the content.
// The merged one keeps the earliest ask, every place and thread, and is open
// unless BOTH say resolved — when they disagree it stays open and says so,
// because a dropped open request is the exact failure this tab exists to prevent.
function placeRef(p) { const id = taskIdOf(p.url); return id ? ('req:task:' + id + ':' + slug(p.label)).slice(0, 220) : ''; }

function mergeRequests(reqs) {
    const out = [];
    for (const r of reqs) {
        const refs = r.places.map(placeRef).filter(Boolean);
        const twin = refs.length && out.find(o => o.places.some(p => refs.includes(placeRef(p))));
        if (!twin) { out.push({ ...r, places: [...r.places], thread_ids: [...r.thread_ids] }); continue; }
        if (twin.status !== r.status) {
            twin.review = twin.review || 'sources disagree on status';
            twin.status = 'open';
            twin.resolved_on = '';
        }
        if (r.first_asked && (!twin.first_asked || r.first_asked < twin.first_asked)) twin.first_asked = r.first_asked;
        for (const p of r.places) if (!twin.places.some(x => placeRef(x) === placeRef(p))) twin.places.push(p);
        twin.thread_ids = uniq([...twin.thread_ids, ...r.thread_ids]);
        for (const k of ['who', 'priority', 'due', 'quote']) if (!twin[k] && r[k]) twin[k] = r[k];
        if (HIGH.has(r.priority) && !HIGH.has(twin.priority)) twin.priority = r.priority;
        if (r.review && !twin.review) twin.review = r.review;
        twin.merged = (twin.merged || 1) + 1;
    }
    return out;
}

function cleanClient(c, cfg) {
    return {
        name: cfg.name, code: cfg.code, domains: cfg.domains,
        last_in: stamp(c.last_in),
        last_out: stamp(c.last_out),
        summary: str(c.summary, 400),
        actions: list(c.actions, 3).map(a => ({ do: str(a.do), why: str(a.why), thread_id: thread(a.thread_id), url: cuUrl(a.url) }))
            .filter(a => a.do),
        requests: mergeRequests(list(c.requests, 300).map(cleanRequest).filter(r => r.title)),
        unanswered: list(c.unanswered, 50).map(u => ({ subject: str(u.subject), who: str(u.who, 40), received: stamp(u.received), thread_id: thread(u.thread_id) }))
            .filter(u => u.received),
        promises: list(c.promises, 50).map(p => ({ what: str(p.what), due: day(p.due), thread_id: thread(p.thread_id), url: cuUrl(p.url) }))
            .filter(p => p.what),
        // Mail data is absent (not empty) when Gmail could not be read.
        mail: ['last_in', 'last_out', 'unanswered', 'promises'].some(k => c[k] != null),
    };
}

// Store one report. Only CONFIGURED clients are kept: the job may not invent one.
function ingest(report, source) {
    const cfg = loadConfig();
    const byName = new Map(cfg.map(c => [c.name.toLowerCase(), c]));
    const clients = list(report && report.clients, 30)
        .filter(c => c && typeof c === 'object' && byName.has(str(c.name, 80).toLowerCase()))
        .filter(c => !restrictedGuard.mentionsRestricted(JSON.stringify(c)))
        .map(c => cleanClient(c, byName.get(str(c.name, 80).toLowerCase())));
    const mailbox = str(report && report.mailbox, 120);
    const doc = {
        updatedAt: Date.now(),
        source: source || 'refresh',
        mailbox: /^[^\s@]+@[^\s@]+$/.test(mailbox) && !restrictedGuard.mentionsRestricted(mailbox) ? mailbox : '',
        clients,
    };
    try { fs.writeFileSync(STORE, JSON.stringify(doc, null, 2)); }
    catch (e) { console.error('[clients] could not write the store:', e.message); }
    return clients.length;
}

function load() {
    try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return null; }
}

// ── expired (Leon's "stop showing me this") ──────────────────────────────────
// A request is identified by the ClickUp PLACES it lives in (task + checkbox
// label), never by its Gmail thread: one mail can carry several requests, so a
// thread key would hide the siblings too. An expiry remembers every place the
// request had, and hides any later request that still sits in one of them —
// so it survives Leon deleting a duplicate task, and survives the job wording
// the title differently. A request with no place falls back to client + words.
// Mail items (unanswered, promises) ARE per thread, and keep a thread key.
const KEY_RE = /^(req|mail|text):[\w .:'&@/()#-]{1,220}$/;

function taskIdOf(url) { const m = /\/t\/([A-Za-z0-9_-]+)/.exec(url || ''); return m ? m[1] : ''; }
function slug(s) { return String(s || '').toLowerCase().replace(/[^\w .:'&@/()#-]/g, '').slice(0, 120); }
function textKey(client, text) { return ('text:' + slug(client + ':' + text)).slice(0, 220); }
function requestRefs(client, r) {
    const refs = (r.places || []).map(placeRef).filter(Boolean);
    return refs.length ? uniq(refs) : [textKey(client, r.title)];
}
function mailKey(client, m, text) { return m.thread_id ? 'mail:' + m.thread_id : textKey(client, text); }

function loadExpired() {
    try { return JSON.parse(fs.readFileSync(EXPIRED_FILE, 'utf8')) || {}; } catch { return {}; }
}

// expire({ key, refs?, client, title }) / expire({ key, undo: true })
function expire({ key, refs, client, title, undo }) {
    const k = String(key || '');
    if (!KEY_RE.test(k)) return { ok: false, error: 'bad key' };
    const all = loadExpired();
    const r = uniq([k, ...list(refs, 12).map(String)]).filter(x => KEY_RE.test(x));
    if (undo) delete all[k];
    else all[k] = { key: k, refs: r, client: str(client, 80), title: str(title, 160), at: Date.now() };
    try { fs.writeFileSync(EXPIRED_FILE, JSON.stringify(all, null, 2)); }
    catch (e) { return { ok: false, error: e.message }; }
    return { ok: true };
}

// A MAIL item comes back if the client wrote again after he expired it — the
// same thread with a new message is news.
function hidden(expired, key, receivedIso) {
    const e = expired[key];
    if (!e) return false;
    if (!receivedIso) return true;
    return Date.parse(receivedIso) <= e.at;
}
// A request is hidden when any of its places was expired.
function expiredRefs(expired) {
    const s = new Set();
    for (const e of Object.values(expired)) for (const r of (e.refs || [e.key])) s.add(r);
    return s;
}

// ── the rule ─────────────────────────────────────────────────────────────────
function localDay(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
}
function startOfToday(now) { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function daysFrom(dayStr, now) { return dayStr ? Math.round((startOfToday(now) - localDay(dayStr)) / 86400000) : null; }

// Hours between two instants that fall on Monday-Friday (local time).
function weekdayHours(fromMs, toMs) {
    let t = fromMs, h = 0;
    while (t < toMs) {
        const d = new Date(t);
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        const end = Math.min(next, toMs);
        const wd = d.getDay();
        if (wd !== 0 && wd !== 6) h += (end - t) / 3600000;
        t = end;
    }
    return h;
}

// Everything the tab shows, derived. asOf = when the facts were read (the trend
// is measured from there); now = when he is looking (ages are measured from here).
// Expired marks are applied BEFORE the rule, so an expired item cannot keep a
// client red.
function derive(c, asOf, now, expired = {}) {
    const today = startOfToday(now);
    const soonEdge = today + RULE.dueSoonDays * 86400000;
    const gone = expiredRefs(expired);
    const all = (c.requests || []).map(r => {
        const places = r.places || [], thread_ids = r.thread_ids || [];
        const refs = requestRefs(c.name, { places, title: r.title });
        return {
            ...r, places, thread_ids, refs, key: refs[0],
            age: daysFrom(r.first_asked, now),
            overdue: r.status === 'open' && !!r.due && localDay(r.due) < today,
            high: HIGH.has(r.priority),
        };
    }).filter(r => !r.refs.some(x => gone.has(x)));
    const requests = all.filter(r => r.status === 'open').sort((a, b) => (b.age ?? -1) - (a.age ?? -1));
    const resolved = all.filter(r => r.status === 'resolved');

    const mail = (m, text) => ({ ...m, key: mailKey(c.name, m, text) });
    const unanswered = (c.unanswered || []).map(u => mail({ ...u, hours: Math.floor(weekdayHours(Date.parse(u.received), now)) }, u.subject))
        .filter(u => !hidden(expired, u.key, u.received))
        .sort((a, b) => b.hours - a.hours);
    const promises = (c.promises || []).map(p => mail({ ...p, due: p.due || '', overdue: !!p.due && localDay(p.due) < today }, p.what))
        .filter(p => !hidden(expired, p.key))
        .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));

    // Open a week before the facts were read: add back what was resolved since,
    // take out what was asked since. Asked AND resolved inside the week was open
    // at neither point, which is correct.
    const weekAgo = startOfToday(asOf) - 7 * 86400000;
    const askedSince = r => r.first_asked && localDay(r.first_asked) > weekAgo;
    const resolvedWeek = resolved.filter(r => r.resolved_on && localDay(r.resolved_on) > weekAgo);
    const openLastWeek = requests.length - requests.filter(askedSince).length + resolvedWeek.filter(r => !askedSince(r)).length;

    const oldest = requests.length ? requests[0].age : null;
    const overdue = requests.filter(r => r.overdue);
    const highOverdue = overdue.filter(r => r.high);
    const lateUnanswered = unanswered.filter(u => u.hours > RULE.unansweredHours);
    const latePromises = promises.filter(p => p.overdue);
    const untracked = requests.filter(r => !r.places.length);

    const red = [], yellow = [];
    if (lateUnanswered.length) red.push(`${lateUnanswered.length} unanswered > ${RULE.unansweredHours}h`);
    if (highOverdue.length) red.push(`${highOverdue.length} high overdue`);
    if (latePromises.length) red.push(`${latePromises.length} promise overdue`);
    if (unanswered.length > lateUnanswered.length) yellow.push(`${unanswered.length - lateUnanswered.length} unanswered`);
    if (overdue.length > highOverdue.length) yellow.push(`${overdue.length - highOverdue.length} overdue`);
    if (untracked.length) yellow.push(`${untracked.length} not in ClickUp`);
    if (oldest != null && oldest > RULE.oldestOpenDays) yellow.push(`oldest ${oldest}d`);
    if (requests.length > openLastWeek) yellow.push(`open ${openLastWeek} -> ${requests.length}`);
    // Green is a claim that nothing is waiting; without the mail it cannot be made.
    if (!c.mail) yellow.push('mail not read');
    const health = red.length ? 'red' : yellow.length ? 'yellow' : 'green';

    // What deserves his eyes this week vs the backlog he can open if he wants.
    // A request that lives only in a mail is always "this week": nobody else is tracking it.
    const isSoon = r => r.overdue || (r.due && localDay(r.due) <= soonEdge) ||
        (r.age != null && r.age <= RULE.newDays) || !r.places.length;
    const soon = requests.filter(isSoon).sort((a, b) =>
        (b.overdue - a.overdue) || (a.due || '9999').localeCompare(b.due || '9999') || (b.high - a.high) || ((b.age ?? 0) - (a.age ?? 0)));
    const backlog = requests.filter(r => !isSoon(r));

    // Next steps: the job's, when it gave them (minus anything he expired), else
    // built here from the same facts that set the colour, in the same order.
    const dropped = a => a.thread_id && hidden(expired, 'mail:' + a.thread_id);
    let actions = (c.actions || []).filter(a => !dropped(a)).map(a => ({ ...a, key: a.thread_id ? 'mail:' + a.thread_id : '' }));
    if (!actions.length) actions = ruleActions({ unanswered, latePromises, untracked, highOverdue, soon });
    const inActions = new Set(actions.map(a => a.key).filter(Boolean));

    return {
        name: c.name, code: c.code, domains: c.domains || [], mail: c.mail,
        last_in: c.last_in, last_out: c.last_out,
        health, reasons: [...red, ...yellow],
        verdict: c.summary || ruleVerdict({ c, unanswered, lateUnanswered, latePromises, highOverdue, soon, requests, soonEdge }),
        actions,
        counts: {
            open: requests.length, high: requests.filter(r => r.high).length, overdue: overdue.length,
            oldest, openLastWeek, resolvedWeek: resolvedWeek.length,
            soon: soon.length, backlog: backlog.length, review: requests.filter(r => r.review).length,
        },
        waiting: [
            ...unanswered.map(u => ({ ...u, kind: 'unanswered', late: u.hours > RULE.unansweredHours })),
            ...promises.map(p => ({ ...p, kind: 'promise', late: p.overdue })),
        ].filter(w => !inActions.has(w.key)),
        soon, backlog,
        resolved: resolved.sort((a, b) => (b.resolved_on || '').localeCompare(a.resolved_on || '')),
        expired: Object.values(expired).filter(e => e.client === c.name).sort((a, b) => b.at - a.at),
    };
}

function waited(h) { return h < 48 ? `${h}h` : `${Math.round(h / 24)} working days`; }
function firstName(s) { return String(s || '').split(/\s+/)[0] || 'The client'; }
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

// The sentence when the job did not write one. Facts only, most urgent first.
function ruleVerdict({ c, unanswered, lateUnanswered, latePromises, highOverdue, soon, requests, soonEdge }) {
    const parts = [];
    if (lateUnanswered.length) {
        const u = lateUnanswered[0];
        parts.push(`${firstName(u.who)} has waited ${waited(u.hours)} for a reply` +
            (lateUnanswered.length > 1 ? ` (and ${plural(lateUnanswered.length - 1, 'more mail', 'more mails')})` : ''));
    } else if (unanswered.length) {
        parts.push(`${firstName(unanswered[0].who)} wrote ${waited(unanswered[0].hours)} ago, not answered yet`);
    }
    if (latePromises.length) parts.push(`we promised "${latePromises[0].what}" for ${latePromises[0].due.slice(5)}`);
    if (highOverdue.length) parts.push(`${plural(highOverdue.length, 'high request is', 'high requests are')} past due`);
    else {
        const due = soon.filter(r => r.due && !r.overdue && localDay(r.due) <= soonEdge);
        const high = due.filter(r => r.high).length;
        if (due.length) parts.push(`${plural(due.length, high === due.length ? 'high request' : 'request', high === due.length ? 'high requests' : 'requests')} due by ${due[due.length - 1].due.slice(5)}`);
    }
    if (!parts.length) parts.push(requests.length ? `nothing urgent; ${plural(requests.length, 'request', 'requests')} in the backlog` : 'nothing waiting on you');
    if (!c.mail) parts.push('mail was not read');
    const s = parts.slice(0, 3).join('; ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

function ruleActions({ unanswered, latePromises, untracked, highOverdue, soon }) {
    const out = [];
    for (const u of unanswered) out.push({ do: `Reply to ${firstName(u.who)}: ${u.subject}`, why: `waiting ${waited(u.hours)}`, thread_id: u.thread_id, key: u.key });
    for (const p of latePromises) out.push({ do: `Deliver what we promised: ${p.what}`, why: `promised for ${p.due.slice(5)}`, thread_id: p.thread_id, url: p.url, key: p.key });
    for (const r of untracked) out.push({ do: `Log it in ClickUp: ${r.title}`, why: `${firstName(r.who)} asked; it lives only in the mail`, thread_id: r.thread_ids[0], key: r.key });
    for (const r of highOverdue) out.push({ do: `Deliver: ${r.title}`, why: `due ${r.due.slice(5)}`, url: (r.places[0] || {}).url, thread_id: r.thread_ids[0], key: r.key });
    if (out.length < 3) {
        const dueHigh = soon.filter(r => r.high && !r.overdue && r.due);
        if (dueHigh.length) out.push({ do: `Pick what ships from ${plural(dueHigh.length, 'high request', 'high requests')} due ${dueHigh[0].due.slice(5)}`, why: 'listed under THIS WEEK', key: '' });
    }
    return out.slice(0, 3);
}

const ORDER = { red: 0, yellow: 1, green: 2 };

function view(now = Date.now()) {
    const doc = load();
    const cfg = loadConfig();
    const base = {
        running: busy, runStartedAt: busy ? runStartedAt : null, lastError,
        rule: RULE, configured: cfg.length,
    };
    if (!doc) return { ...base, updatedAt: null, clients: [] };
    const asOf = doc.updatedAt || now;
    const expired = loadExpired();
    // A client removed from the config disappears even before the next run.
    const names = new Set(cfg.map(c => c.name));
    const clients = (doc.clients || []).filter(c => names.has(c.name)).map(c => derive(c, asOf, now, expired))
        .sort((a, b) => ORDER[a.health] - ORDER[b.health] || b.counts.open - a.counts.open);
    return { ...base, updatedAt: doc.updatedAt, source: doc.source, mailbox: doc.mailbox, clients };
}

// ── refresh on demand (the tab's button) ─────────────────────────────────────
// One at a time; the HTTP route is told at once and the run takes minutes.
let busy = false, runStartedAt = 0, lastError = '';

function buildRefreshInstruction(today, cfg = loadConfig()) {
    return `Today is ${today}. You are refreshing Leon's client-health board. Read only ClickUp and
Gmail, and change nothing anywhere.

${instructionSection(cfg)}

Answer with ONLY this JSON, no prose around it, no markdown fence:

{
  ${jsonTemplate()}
}`;
}
const REFRESH_SHAPE = { object: { mailbox: S, clients: CLIENTS_SHAPE }, optional: ['mailbox'] };

function start() {
    if (busy) return { ok: false, error: 'already running' };
    if (!deps.analyst || !deps.jsonJob) return { ok: false, error: 'the headless job runner is not available' };
    const cfg = loadConfig();
    if (!cfg.length) return { ok: false, error: 'no clients configured' };
    busy = true; runStartedAt = Date.now(); lastError = '';
    const today = new Date().toISOString().slice(0, 10);
    const p = deps.jsonJob.run({
        analyst: deps.analyst,
        key: `clients-${today}-${String(runStartedAt).slice(-5)}`,
        kind: 'client-health',
        jobData: { today, clients: cfg },
        instruction: buildRefreshInstruction(today, cfg),
        shape: REFRESH_SHAPE,
        allowedTools: CLIENT_TOOLS,
        retries: 1,
    }).then(answer => {
        if (!answer.ok) { lastError = answer.error || 'no answer'; return; }
        const n = ingest(answer.value, 'refresh');
        console.log(`[clients] refreshed: ${n} client(s)`);
    }).catch(e => { lastError = e.message; })
      .finally(() => { busy = false; });
    return { ok: true, started: true, promise: p };
}

module.exports = {
    configure, start, ingest, view, load, loadConfig, expire, loadExpired,
    instructionSection, jsonTemplate, buildRefreshInstruction, derive, mergeRequests, weekdayHours,
    CLIENTS_SHAPE, REFRESH_SHAPE, CLIENT_TOOLS, RULE, STORE, CONFIG_FILE, EXPIRED_FILE,
};
