// Productivity Dashboard (Increment 2) — worklog generation.
//
// The cc-tsrct-analyst session runs the weekly-worklogs skill logic (reads the
// vault sessions + Decisions Log + WSL Claude session logs in parallel — Slack /
// Calendar via MCP if available) and emits a STRICT JSON array of worklog
// proposals. This module submits that job (via the shared analyst engine) and
// parses the result into the worklog_proposals table. Leon then edits/approves
// on the dashboard; the SERVER creates the ClickUp time entries on explicit
// confirm (clickupSync.createTimeEntry) — see server.js worklog routes.
//
// DETERMINISTIC vs INTELLIGENT: the analyst only PROPOSES; the server (not the
// model) does the ClickUp create. Token cost is on-demand only (Leon clicks).

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');
const db = require('./db');
const analyst = require('./clickupAnalyst');

// In-memory generation state (ephemeral, on-demand). Mirrors the analyst pattern.
let lastBatchId = null;
const activeBatches = new Set();
const batchErrors = new Map();
const cancelledBatches = new Set();

// Build the instruction handed to claude -p. It is written to a file and reaches
// the model via "$(cat file)" — command-substitution output is literal, so quotes
// (incl. the JSON example) are safe and not re-parsed by the shell.
function buildInstruction(jobKey) {
    return [
        'You are the TSRCT Worklog Generator. Do NOT do any of the work itself - only SUMMARIZE work already done into worklog proposals.',
        `Read jobs/${jobKey}.json for range_start and range_end (YYYY-MM-DD inclusive), hours_hint (Leon stated net hours per day; may be empty), and recent_worklogs (Leon OWN recent ClickUp time entries - his ground-truth logging history).`,
        'STEP 1 - LEARN LEON PATTERNS FROM recent_worklogs: those entries are how Leon actually logs. Study them to extract (a) his exact COMMENT VOICE and length, (b) which ClickUp task_id each kind of work maps to, (c) how he splits hours across a day, (d) his billable choices. Match that voice and those task mappings EXACTLY - they override any guess. The recent comments are the single best template for the comments you write.',
        'STEP 2 - READ ' + path.join(paths.HOME, '.claude', 'skills') + '/weekly-worklogs/SKILL.md and FOLLOW IT IDENTICALLY: the project->ClickUp-task-id MAPPING TABLE with billable flags, the daily-standup rule (a flat 30m entry on Daily Team Meeting task 86ahpxwv2, weekdays Mon-Fri only, never weekends - fold an attached demo in at real duration), the net-hours model (the stated daily net is the day TOTAL incl meetings - fit them inside it, do not add on top), the billable rule (external client = true, internal ACME = false), and the granular-task rule (never a catch-all, never General Administration unless genuinely cross-cutting admin; mini-products have their own task).',
        'COMMENT STYLE - apply the skill PHASE 4 Worklog Comment Style Guide EXACTLY, do not paraphrase it loosely: comments are SHORT, one line, ~5-15 words (a routine entry can be 3 words); start with a verb or noun, no articles; ONE main thing per entry - DROP secondary clauses (Leon trims them hard); keep load-bearing specifics for DEV work (class names, version numbers, counts like 129/129) but drop them for admin/meeting entries; abbreviate (env, config, impl, auth, repo); no fluff words (worked on, helped with, continued); soft cap ~120 chars, shorter is better. Good real examples: "PS Core 1.42 packaged + PR", "Voided CDs, closed periods", "Fixed TRW records (Pattern 1/3 data fix applied)", "Daily meeting". When unsure, mirror the closest recent_worklogs comment.',
        'STEP 3 - FOUR MANDATORY SOURCES, ALWAYS ALL FOUR, COMBINED: (i) Leon Obsidian vault at ' + paths.VAULT_ROOT + ' - sessions/YYYY-MM-DD-*.md, dated entries in wiki/decisions/*.md (one file per project, newest first), the relevant projects/*.md; (ii) the real WSL2 Claude Code session logs under ' + paths.CLAUDE_PROJECTS + '/<slug>/*.jsonl (STEP 3a); (iii) Slack (STEP 3b); (iv) Google Calendar (STEP 3c). Slack AND Calendar MCP tools ARE BOTH available and permitted in this session - always call them, never skip either one and never conclude "not available" without actually trying the call. No source substitutes for another: the vault says what Leon WROTE DOWN, WSL2 says what he ACTUALLY RAN, Slack says what he COORDINATED, Calendar says where his TIME WENT. A day is only fully covered when all four have been checked and CROSS-REFERENCED - the same block of work often appears in two sources (a vault note plus the WSL2 session that produced it) and must be logged ONCE, while work that appears in only one source (a meeting with no vault note, a repo touched with no Slack mention) is still real work and must be logged. A missing vault note is never a reason to under-report a day.',
        'STEP 3a - MANDATORY FULL WSL2 ENUMERATION (do this before writing any proposal, every run, regardless of what recent_worklogs suggests): run `ls ' + paths.CLAUDE_PROJECTS + '/ | grep -vi secretco` to list EVERY project slug, then for EACH ONE run `grep -l \'"timestamp":"YYYY-MM-DDT\' <dir>/*.jsonl` (one grep per date in range) to find which of ITS .jsonl files touch the target date(s). Do this for ALL slugs, including ones you do not recognize or that never appeared in recent_worklogs (e.g. a one-off tool project) - recent_worklogs is only a STYLE/MAPPING reference, never a filter on which projects to check. Exclude only: any slug containing "secretco" (never open these - Bedrock-only, see below), "tsrct-analyst" (that IS this analyst job - its own transcripts are not Leon client/dev work and must never be cited as an entry), and the personal slugs "TSRCT" and "prompt-polisher" (read-excluded is not required but never output them - see STEP 4). For every matching .jsonl, get first/last "timestamp" on that date (grep suffices) as a duration bound, and read enough of the actual content (tail or targeted grep, not the whole file) to know what was built. Cap at 5 sessions per project dir if more match. SHELL FORM MATTERS - the sandbox DENIES certain forms, and a denied command silently costs you a whole project of evidence, so: write every path LITERALLY in full (never a shell variable like $P or $dir - variable expansion is always denied), run ONE command per call (never chain with && or ; and never pipe into a second processing command - each part needs its own approval), and never write a helper script to /tmp. If a command comes back denied, do NOT give up on that project - reissue it in the simple literal single-command form.',
        'STEP 3b - MANDATORY SLACK CHECK (this is a real, working MCP tool in this session - always call it, never skip it as "not available" without trying): you cannot interactively ask Leon which contacts to scan (this is headless), so ALWAYS check these 3 fixed contacts every run: Sam Bechara (id UAD7MEAKB), Ravi M (id U098T6A3W65), Alex Mestroni (id U04R4JMSELD). For each, call mcp__claude_ai_Slack__slack_read_channel with channel_id = that id, oldest/latest = Unix timestamps spanning 00:00 to 23:59 Argentina time (UTC-3) for each date in the range (00:00-03:00 = subtract 3h from local midnight to get UTC), limit 100, response_format concise. Also call mcp__claude_ai_Slack__slack_search_public_and_private once per date with query `after:YYYY-MM-DD before:YYYY-MM-DD` (before = date+1) to catch channel activity outside the 3 DMs. Extract: tasks/projects worked on, bugs fixed, deliverables, decisions, calls/huddles - ignore greetings and logistics. Skip any Slack content that mentions secretco/secretco-sandbox (do not read or summarize it - HARD SECRETCO EXCLUSION applies here too).',
        'STEP 3c - MANDATORY GOOGLE CALENDAR CHECK (these MCP tools ARE available and permitted here - always call them, never skip as "not available" without trying): call mcp__claude_ai_Google_Calendar__list_events once per date in the range, time_min/time_max spanning 00:00 to 23:59 Argentina time (UTC-3), to recover the meetings/calls that leave no trace in git or the vault. Calendar is the authoritative source for MEETING TIME: use each event real duration and attendees to (a) attribute meeting hours to the right client/project instead of burying them in dev time, (b) confirm or correct a day total, and (c) catch client calls that produced no code at all - those are still billable work. Do NOT double-count: an event that is clearly the daily standup is already covered by the flat 30m standup entry, and a working session that also shows up in WSL2/vault is ONE entry, not two. Skip any event whose title or attendees concern secretco/secretco-sandbox (HARD SECRETCO EXCLUSION applies here too).',
        'HARD SECRETCO EXCLUSION: never read, grep, open or summarize anything whose path or content concerns secretco or SecretCoSandbox (filter with grep -vi secretco). That work is Bedrock-only; reading it here is a contract breach. If SecretCo work happened, still propose an entry but with the comment exactly SecretCo client work and billable true - never invent a description and never read the SecretCo sources.',
        'EXCLUDE the personal projects TSRCT and prompt-polisher entirely - their time is never logged to ACME.',
        'NEVER PAD OR FABRICATE HOURS: hours_hint is a cross-check total, not a target to force. Build each entry ONLY from evidence found in STEP 3/3a (vault note length, WSL2 session span, Slack/calendar). Do not inflate, invent, or dump leftover hours into one convenient/familiar project just to make the day sum equal hours_hint. If the evidence you found sums to less than hours_hint, that is fine - it means either keep searching every remaining project dir from STEP 3a first, or leave the day short rather than guess. Never let a project already seen in recent_worklogs "absorb" unexplained hours.',
        'For each day in the range: distribute that day net hours across the day projects using the skill signals (session-note length, WSL session duration, complexity), map each project to its SPECIFIC ACTIVE task id (prefer the exact id Leon used for that work in recent_worklogs, else the skill table), and write the comment in his voice. Round hours to the nearest 0.25.',
        'EVIDENCE - Leon taps a [?] on each proposal to remember where it came from, so every entry must carry (a) "why": ONE plain-Spanish sentence, max 40 words, no jargon (no dev or accounting words), saying what he did and what source showed it, e.g. "Le respondiste a Diana sobre la conciliacion: lo muestra tu sesion de winery-recon de 10:39 a 12:22 y el pedido de Paul en Slack del 8/9."; (b) "evidence": 1 to 4 items {"source":"vault|session|slack|calendar|clickup","ref":"<where>","quote":"<text>"}. ref: for vault and session the FULL absolute file path you actually read (session = the .jsonl path) followed by " @HH:MM" local time for sessions; for slack the channel or person + time; for calendar the event title + time. quote: COPIED VERBATIM from that source, max 200 chars, never paraphrased and never invented - prefer the line where Leon asked for the work or the vault line that names it. The server re-checks every vault/session quote against the file and shows Leon which ones it could not find. For the standup entry use why "Reunion diaria fija de 30 min (dia de semana)." and evidence []. Never quote anything about SecretCo.',
        `TASK IDS MUST BE ALIVE: jobs/${jobKey}.json dead_task_ids lists tasks that are ARCHIVED or DELETED in ClickUp (the server checked them, including every id in the skill mapping table) - NEVER output any of them, even when the skill table or an old habit points there. Every task in recent_worklogs is alive (task_state "closed" means finished but still usable). If no live task fits the work, do NOT force an unrelated task and do NOT reuse a dead id: output "task_id": null and add "new_task": {"list_id":"<a list_id from active_lists>","name":"<short task name in Leon style>","description":"<one line: what the work is>"}, picking the list of the client/project the work belongs to from active_lists (in the jobs file). Leon reviews and confirms the task creation himself - you create nothing.`,
        'OUTPUT FORMAT - your output is parsed by a program, so output ONLY a single JSON array and nothing else: no prose, no explanation, no markdown, no code fences. Each element must be exactly: {"work_date":"YYYY-MM-DD","project":"NAME","task_id":"<clickup task id, or null with new_task>","task_name":"<clickup task name>","hours":<number>,"billable":<true|false>,"comment":"<short comment in Leon voice>","why":"<one plain sentence>","evidence":[{"source":"...","ref":"...","quote":"..."}]} plus "new_task":{...} only when task_id is null. Add the daily standup as its own element (task_id 86ahpxwv2, task_name Daily Team Meeting, hours 0.5, billable false) for each weekday Mon-Fri that had any work. If a date shows no evidence of work, omit it. If nothing at all, output exactly [].',
    ].join(' ');
}

// Pull Leon's recent ClickUp time entries to teach the analyst his real patterns.
// Compact (cap N, most-recent-first) to keep the job file + token cost small. Best
// effort: if the token/network fails, the analyst still runs off the skill table.
async function fetchRecentWorklogs(days = 45, cap = 60) {
    try {
        const clickupSync = require('./clickupSync');
        const endMs = Date.now();
        const startMs = endMs - days * 24 * 3600 * 1000;
        const entries = await clickupSync.getTimeEntries(startMs, endMs);
        const restrictedGuard = require('./restrictedGuard');
        const before = entries.length;
        // SECRETCO: drop SecretCo entries HERE, before they can reach the job file.
        // Leon does log SecretCo hours in ClickUp, so this list legitimately mixes
        // them in -- and the analyst runs on the public API. The instruction has
        // always carried a "HARD SECRETCO EXCLUSION" sentence, but that asks the
        // model not to look at something it has already been handed. Filtering
        // the input is what actually holds, and it is what lets the choke-point
        // guard in analyst.submitJob() stay strict without breaking worklogs.
        const clean = entries.filter(e => !restrictedGuard.mentionsRestricted(
            e.task_name, e.description, e.list_name, e.project, e.folder_name
        ));
        if (clean.length !== before) {
            console.log(`[worklog] SecretCo filter: dropped ${before - clean.length} of ${before} entries`);
        }
        return clean
            .sort((a, b) => (b.start || 0) - (a.start || 0))
            .slice(0, cap)
            .map(e => ({
                task_id: e.task_id,
                task_name: e.task_name,
                hours: e.hours,
                billable: e.billable,
                comment: (e.description || '').slice(0, 200),
            }));
    } catch (e) {
        console.warn('[worklog] could not fetch recent ClickUp worklogs:', e.message);
        return [];
    }
}

// ─── Archived tasks (2026-09-30) ─────────────────────────────────────────────
// The generator kept reusing task ids that were archived in ClickUp: it learns ids
// from Leon's history and from the skill's mapping table, and nothing asked ClickUp
// whether they were still alive. Now: dead ids are named to the model BEFORE it
// writes, every proposal is re-checked AFTER, and the create gate checks again.
const BLOCKING = new Set(['archived', 'gone']);
const SKILL_MD = path.join(os.homedir(), '.claude', 'skills', 'weekly-worklogs', 'SKILL.md');

async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
}

// id -> health (null when ClickUp could not be asked: unknown is never "alive").
async function checkTasks(ids) {
    const clickupSync = require('./clickupSync');
    const uniq = [...new Set(ids.filter(Boolean).map(String))];
    const res = await mapLimit(uniq, 5, id => clickupSync.taskHealth(id).catch(() => null));
    return new Map(uniq.map((id, k) => [id, res[k]]));
}

function skillTaskIds() {
    try { return [...new Set(fs.readFileSync(SKILL_MD, 'utf8').match(/\b86[a-z0-9]{7}\b/g) || [])]; }
    catch { return []; }
}

// Check one stored proposal's task and record the verdict on the row.
async function checkRow(row) {
    if (!row || !row.task_id) { if (row) db.setWorklogTaskState(row.id, null, null); return null; }
    const h = await require('./clickupSync').taskHealth(row.task_id).catch(() => null);
    db.setWorklogTaskState(row.id, h ? h.state : null, h ? h.reason : 'could not ask ClickUp');
    return h;
}

// After the model answers: check every proposal. A dead task with no suggestion
// gets one (same list when that list is still active, otherwise Leon picks it) —
// "offer the task creation" instead of leaving him with a red row and no way out.
async function checkBatch(batchId, lists) {
    const rows = db.getWorklogProposalsByBatch(batchId).filter(r => r.task_id && !r.new_task_json);
    const active = new Set((lists || []).map(l => l.list_id));
    await mapLimit(rows, 5, async (row) => {
        const h = await checkRow(row);
        if (h && BLOCKING.has(h.state)) {
            db.setWorklogNewTask(row.id, {
                list_id: h.list_id && active.has(h.list_id) ? h.list_id : null,
                name: String(row.comment || row.task_name || '').slice(0, 120),
                description: '',
            });
        }
    });
}

function cleanNewTask(nt, lists) {
    if (!nt || typeof nt !== 'object') return null;
    const restrictedGuard = require('./restrictedGuard');
    const name = String(nt.name || '').trim().slice(0, 200);
    const description = String(nt.description || '').trim().slice(0, 1000);
    if (!name || restrictedGuard.mentionsRestricted(name, description)) return null;
    const listId = nt.list_id != null ? String(nt.list_id) : null;
    const ok = (lists || []).some(l => l.list_id === listId);
    return { list_id: ok ? listId : null, name, description };
}

// Pull the first JSON array out of the model output (defensive against stray
// prose or ```json fences the model may add despite the instruction).
function parseProposals(text) {
    let s = String(text || '').trim();
    // Strip code fences if present.
    s = s.replace(/```(?:json)?/gi, '');
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return [];
    const slice = s.slice(start, end + 1);
    try {
        const arr = JSON.parse(slice);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function storeProposals(batchId, items, lists) {
    let n = 0;
    for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const hours = Number(it.hours);
        if (!it.work_date || !isFinite(hours)) continue;
        // Evidence is model-cited, so it is only a pointer: the [?] route re-checks each
        // quote against the real file before showing it. SecretCo-mentioning items never
        // get stored (they would reach an HTTP response).
        const restrictedGuard = require('./restrictedGuard');
        const evidence = (Array.isArray(it.evidence) ? it.evidence : [])
            .filter(e => e && typeof e === 'object' && e.quote)
            .map(e => ({
                source: String(e.source || '').slice(0, 20),
                ref: String(e.ref || '').slice(0, 400),
                quote: String(e.quote).slice(0, 400),
            }))
            .filter(e => !restrictedGuard.mentionsRestricted(e.ref, e.quote))
            .slice(0, 6);
        const why = it.why && !restrictedGuard.mentionsRestricted(it.why) ? String(it.why).slice(0, 600) : null;
        const newTask = it.task_id ? null : cleanNewTask(it.new_task, lists);
        db.insertWorklogProposal({
            new_task_json: newTask ? JSON.stringify(newTask) : null,
            why,
            evidence_json: evidence.length ? JSON.stringify(evidence) : null,
            batch_id: batchId,
            work_date: String(it.work_date).slice(0, 10),
            project: it.project ? String(it.project).slice(0, 120) : null,
            task_id: it.task_id ? String(it.task_id).slice(0, 60) : null,
            task_name: it.task_name ? String(it.task_name).slice(0, 200) : null,
            hours: Math.max(0, hours),
            comment: it.comment ? String(it.comment).slice(0, 500) : null,
            billable: !!it.billable,
        });
        n++;
    }
    return n;
}

// Kick off a generation run. Returns { batch_id }. Async: first pulls Leon's
// recent ClickUp worklog history (his patterns) to feed the analyst as ground truth.
async function generate({ range_start, range_end, hours_hint }) {
    const batchId = `wl-${Date.now()}`;
    lastBatchId = batchId;
    activeBatches.add(batchId);
    batchErrors.delete(batchId);
    cancelledBatches.delete(batchId);
    const history = await fetchRecentWorklogs();
    // Ask ClickUp about every id the model could reach for: his history AND the
    // skill table. Dead ones leave the history (so it stops learning them) and are
    // listed by name; a closed-but-alive task stays, marked as such.
    const known = await checkTasks([...history.map(e => e.task_id), ...skillTaskIds()]);
    const recentWorklogs = history
        .filter(e => !(known.get(e.task_id) && BLOCKING.has(known.get(e.task_id).state)))
        .map(e => ({ ...e, task_state: known.get(e.task_id) ? known.get(e.task_id).state : 'unknown' }));
    const restrictedGuard = require('./restrictedGuard');
    const deadTasks = [...known]
        .filter(([, h]) => h && BLOCKING.has(h.state) && !restrictedGuard.mentionsRestricted(h.name, h.list_name, h.folder_name))
        .map(([id, h]) => ({ task_id: id, task_name: h.name || null, why: h.reason }));
    let lists = [];
    try { lists = await require('./clickupSync').listCatalogue(); }
    catch (e) { console.warn('[worklog] could not read the ClickUp list catalogue:', e.message); }
    console.log(`[worklog] task check: ${known.size} ids, ${deadTasks.length} dead, ${history.length - recentWorklogs.length} history rows dropped, ${lists.length} active lists`);
    // submitJob can throw (SecretCo guard). Without this the batch stays in
    // activeBatches and the panel sits on [ GENERATING ] forever with nothing
    // dispatched -- which is exactly how the bug above stayed invisible.
    try {
    analyst.submitJob({
        key: batchId,
        kind: 'worklog',
        jobData: {
            range_start: range_start || null,
            range_end: range_end || null,
            hours_hint: hours_hint || '',
            recent_worklogs: recentWorklogs,
            dead_task_ids: deadTasks,
            active_lists: lists.map(l => ({ list_id: l.list_id, list: l.list, folder: l.folder })),
        },
        instruction: buildInstruction(batchId),
        onResult: async (txt) => {
            try {
                const items = parseProposals(txt);
                const n = storeProposals(batchId, items, lists);
                if (!n) batchErrors.set(batchId, 'analyst returned no parseable worklogs (check the date range / sources)');
                console.log(`[worklog] batch ${batchId}: stored ${n} proposal(s)`);
                // Still "generating" while ClickUp is asked about each task, so the
                // table never shows a dead task without its warning.
                await checkBatch(batchId, lists);
            } catch (e) {
                console.warn(`[worklog] storing/checking ${batchId} failed: ${e.message}`);
                batchErrors.set(batchId, `stored the worklogs but could not check their tasks: ${e.message}`);
            } finally {
                activeBatches.delete(batchId);
            }
        },
        onTimeout: () => { batchErrors.set(batchId, 'worklog generation timed out'); activeBatches.delete(batchId); },
        onError: (msg) => { batchErrors.set(batchId, `worklog generation failed: ${msg}`); activeBatches.delete(batchId); },
        onCancel: () => { activeBatches.delete(batchId); cancelledBatches.add(batchId); },
    });
    } catch (e) {
        activeBatches.delete(batchId);
        batchErrors.set(batchId, `could not start: ${e.message}`);
        console.error(`[worklog] submit failed for ${batchId}: ${e.message}`);
        return { batch_id: batchId, error: e.message };
    }
    return { batch_id: batchId };
}

// Cancel an in-flight generation and hand the UI back a clean slate to start over.
// Clearing the generating flag is UNCONDITIONAL, not contingent on the analyst still
// tracking the job: a batch the engine already forgot (server restart, orphaned
// headless claude) is precisely the case that pins the dashboard on [ GENERATING ].
// Nothing is written to ClickUp here — a cancelled batch simply stored no proposals.
function cancel(batchId) {
    const id = batchId || lastBatchId;
    if (!id) return { cancelled: false, reason: 'nothing to cancel' };
    const r = analyst.cancelJob(id);
    activeBatches.delete(id);
    batchErrors.delete(id);
    cancelledBatches.add(id);
    console.log(`[worklog] batch ${id} cancelled (analyst: ${r.was})`);
    return { cancelled: true, batch_id: id, was: r.was };
}

// State for the dashboard: which batch + whether it is still generating + error.
function state() {
    return {
        batch_id: lastBatchId,
        generating: lastBatchId ? activeBatches.has(lastBatchId) : false,
        cancelled: lastBatchId ? cancelledBatches.has(lastBatchId) : false,
        error: lastBatchId ? (batchErrors.get(lastBatchId) || null) : null,
        proposals: lastBatchId ? db.getWorklogProposalsByBatch(lastBatchId) : [],
    };
}

module.exports = { generate, cancel, state, parseProposals, checkRow, cleanNewTask, BLOCKING };
