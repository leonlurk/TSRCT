// Productivity Dashboard (Increment 1) — DETERMINISTIC ClickUp poller.
//
// Polls the ClickUp REST API for tasks ASSIGNED to Leon and upserts them into
// the ephemeral `clickup_tasks` table. The dedup key is the ClickUp task id
// (UNIQUE), so a re-poll on every server start can NEVER create duplicates — it
// just refreshes the ClickUp-sourced columns and leaves Leon's interpretation +
// any stored analysis untouched (see db.upsertClickupTask).
//
// NO reasoning happens here. This module only fetches + stores. All intelligent
// completion analysis lives in clickupAnalyst.js (the cc-tsrct-analyst session).
//
// Auth: a ClickUp PERSONAL API token (starts with "pk_"). Stored in the
// `config` table (the only persistent table) under key `clickup_api_token`, or
// supplied via the CLICKUP_API_TOKEN env var. Personal tokens go in the raw
// Authorization header (no "Bearer" prefix).

const https = require('https');
const db = require('./db');

const POLL_MS = Number(process.env.CLICKUP_POLL_MS || 5 * 60 * 1000); // 5 min
const API_HOST = 'api.clickup.com';

function getToken() {
    let t = null;
    try { t = db.getConfig('clickup_api_token'); } catch {}
    return t || process.env.CLICKUP_API_TOKEN || null;
}

// Where the live token comes from + a non-secret fingerprint of it, so the UI can
// say WHICH token is in use without ever shipping the token itself to the browser.
function maskToken(t) {
    const s = String(t || '');
    if (s.length <= 12) return '***';
    return `${s.slice(0, 8)}...${s.slice(-4)}`;
}
function tokenInfo() {
    let stored = null;
    try { stored = db.getConfig('clickup_api_token'); } catch {}
    const live = stored || process.env.CLICKUP_API_TOKEN || null;
    return {
        token_configured: !!live,
        token_source: stored ? 'config' : (process.env.CLICKUP_API_TOKEN ? 'env' : null),
        token_masked: live ? maskToken(live) : null,
        // An env token can never be edited from the UI (it wins nothing — config
        // wins — but saying so avoids "I changed it and nothing happened").
        env_override_present: !!process.env.CLICKUP_API_TOKEN,
    };
}

function getUserId() {
    return process.env.CLICKUP_USER_ID || null;
}

// One request to the ClickUp v2 API. Resolves to the parsed JSON body. On a
// non-2xx the rejected Error carries `.statusCode` so callers can retry 502s.
function apiRequest(token, apiPath, method, bodyObj) {
    return new Promise((resolve, reject) => {
        const body = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
        const headers = { 'Authorization': token, 'Content-Type': 'application/json' };
        if (body) headers['Content-Length'] = Buffer.byteLength(body);
        const req = https.request({ host: API_HOST, port: 443, path: apiPath, method, headers }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(buf || '{}'); }
                catch (e) { const err = new Error(`clickup: bad JSON (HTTP ${res.statusCode})`); err.statusCode = res.statusCode; return reject(err); }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const err = new Error(`clickup HTTP ${res.statusCode}: ${parsed.err || parsed.error || buf.slice(0, 200)}`);
                    err.statusCode = res.statusCode;
                    return reject(err);
                }
                resolve(parsed);
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('clickup request timeout')));
        if (body) req.write(body);
        req.end();
    });
}
function apiGet(token, apiPath) { return apiRequest(token, apiPath, 'GET'); }
function apiPost(token, apiPath, bodyObj) { return apiRequest(token, apiPath, 'POST', bodyObj || {}); }

// Resolve the user id to filter by. Prefer CLICKUP_USER_ID; otherwise ask the
// API for the token owner (GET /v2/user).
async function resolveUserId(token) {
    const envId = getUserId();
    if (envId) return String(envId);
    const u = await apiGet(token, '/api/v2/user');
    return u && u.user && u.user.id != null ? String(u.user.id) : null;
}

// All workspaces (teams) the token can see.
async function fetchTeams(token) {
    const r = await apiGet(token, '/api/v2/team');
    return (r && r.teams) || [];
}

// Check a CANDIDATE token (not necessarily the stored one) against the live API
// and report who it belongs to + which workspaces it can see. This is the gate on
// saving a new token: a dead/typo'd token must never be written to config, because
// every downstream failure it causes surfaces as ClickUp's misleading
// "you do not have access to this task" (see the WORKLOG_TEAM_NAME note below) —
// the exact error that was misdiagnosed as an expired token for months.
async function verifyToken(candidate) {
    const tok = String(candidate || '').trim();
    if (!tok) throw new Error('token required');
    let user;
    try {
        const u = await apiGet(tok, '/api/v2/user');
        user = (u && u.user) || null;
    } catch (e) {
        if (e.statusCode === 401) throw new Error('ClickUp rejected this token (401) — check you copied the whole personal token');
        throw e;
    }
    if (!user || user.id == null) throw new Error('ClickUp accepted the token but returned no user');
    const teams = await fetchTeams(tok);
    return {
        user: { id: String(user.id), username: user.username || null, email: user.email || null },
        workspaces: teams.map(t => ({ id: String(t.id), name: t.name || null })),
    };
}

// All tasks in a workspace assigned to `userId`, across pages. ClickUp caps each
// page at 100 and signals the end via `last_page`.
async function fetchAssignedTasks(token, teamId, userId) {
    const out = [];
    for (let page = 0; page < 50; page++) {
        const qs = `page=${page}&assignees[]=${encodeURIComponent(userId)}&subtasks=true&include_closed=false`;
        const r = await apiGet(token, `/api/v2/team/${encodeURIComponent(teamId)}/task?${qs}`);
        const tasks = (r && r.tasks) || [];
        out.push(...tasks);
        if (r.last_page || tasks.length === 0) break;
    }
    return out;
}

// Map a raw ClickUp task into our row shape. "project" is the best human label
// of where the task lives: the (visible) folder name, else the list name.
function mapTask(t, userId) {
    const folderName = t.folder && !t.folder.hidden ? t.folder.name : null;
    const listName = t.list && t.list.name ? t.list.name : null;
    return {
        clickup_task_id: t.id,
        project: folderName || listName || null,
        title: t.name || `ClickUp task ${t.id}`,
        list_name: listName,
        clickup_status: t.status && t.status.status ? t.status.status : null,
        url: t.url || null,
        assignee_id: String(userId),
    };
}

// Fetch + upsert every assigned task once. Returns { upserted, teams } or throws.
async function syncOnce() {
    const token = getToken();
    if (!token) throw new Error('no ClickUp API token configured (config.clickup_api_token or CLICKUP_API_TOKEN)');
    const userId = await resolveUserId(token);
    if (!userId) throw new Error('could not resolve ClickUp user id (set CLICKUP_USER_ID)');

    const teams = await fetchTeams(token);
    let upserted = 0;
    const allRaw = [];
    for (const team of teams) {
        const tasks = await fetchAssignedTasks(token, team.id, userId);
        for (const t of tasks) {
            allRaw.push(t);
            try { db.upsertClickupTask(mapTask(t, userId)); upserted++; }
            catch (e) { console.warn(`[clickupSync] upsert failed for task ${t.id}: ${e.message}`); }
        }
    }
    console.log(`[clickupSync] synced ${upserted} assigned task(s) across ${teams.length} workspace(s)`);
    // Rebuild the unified inbox from the same fetch (best-effort: a comment-fetch
    // failure must never break the core task sync).
    let inbox = 0;
    try { inbox = await buildInbox(token, userId, allRaw); }
    catch (e) { console.warn('[clickupSync] inbox build failed:', e.message); }
    return { upserted, teams: teams.length, inbox };
}

// ─── Inbox: the unified "where I stand" feed (deterministic) ───────────────
// Reconstructs ClickUp's notification firehose from the REST API (which has NO
// public notifications endpoint) by combining: comments + @mentions on my tasks,
// newly-assigned tasks, status changes, and due/overdue. NO reasoning here.
const INBOX_COMMENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // surface comments from the last 14 days
const INBOX_DUE_SOON_MS = 2 * 24 * 60 * 60 * 1000;        // and tasks due within 2 days

// Fetch a task's comments (most-recent page). Shape per the ClickUp v2 API:
// { comments: [ { id, comment:[fragments], comment_text, user:{id,username}, date } ] }.
async function getTaskComments(token, taskId) {
    const r = await apiGet(token, `/api/v2/task/${encodeURIComponent(taskId)}/comment`);
    return (r && r.comments) || [];
}

// A comment mentions `userId` if any rich-text fragment is a user tag for them,
// or a group tag whose embedded member list includes them.
function commentMentionsUser(comment, userId) {
    const uid = String(userId);
    const frags = Array.isArray(comment.comment) ? comment.comment : [];
    for (const f of frags) {
        if (f && f.type === 'tag' && f.user && String(f.user.id) === uid) return true;
        if (f && f.type === 'group_tag' && f.user_group && Array.isArray(f.user_group.members)) {
            if (f.user_group.members.some(m => m && String(m.id) === uid)) return true;
        }
    }
    return false;
}

function prioName(p) { return p && p.priority ? String(p.priority) : null; }

function dueLabel(dueMs, nowMs) {
    const day = 24 * 60 * 60 * 1000;
    const diff = dueMs - nowMs;
    if (diff < 0) {
        const d = Math.floor(-diff / day);
        return d <= 0 ? 'overdue today' : `overdue ${d}d`;
    }
    const d = Math.floor(diff / day);
    return d <= 0 ? 'due today' : `due in ${d}d`;
}

// Build + persist the inbox feed. `rawTasks` are the raw ClickUp task objects
// fetched by syncOnce (carry status, due_date, priority). Returns the item count.
async function buildInbox(token, userId, rawTasks) {
    const nowMs = Date.now();
    const items = [];

    const known = db.getInboxKnownTasks();              // { taskId: status } baseline (persistent)
    const seen = db.getInboxSeen();                      // { itemKey: seenMs }   (persistent)
    const initialized = !!db.getConfig('inbox_initialized');
    const newKnown = {};

    // 1) Assignments + status changes + due/overdue (from the task objects).
    for (const t of rawTasks) {
        const tid = String(t.id);
        const meta = mapTask(t, userId); // project / list_name / url / title
        const status = (t.status && t.status.status) ? String(t.status.status) : null;
        newKnown[tid] = status;
        const updatedTs = t.date_updated ? Number(t.date_updated) : nowMs;

        if (initialized) {
            if (!(tid in known)) {
                items.push({ item_key: `a:${tid}`, kind: 'assigned', task_id: tid, task_name: t.name, project: meta.project, url: t.url, actor: null, snippet: 'assigned to you', ts: updatedTs });
            } else if (known[tid] !== status && status) {
                items.push({ item_key: `s:${tid}:${status}`, kind: 'status', task_id: tid, task_name: t.name, project: meta.project, url: t.url, actor: null, snippet: `${known[tid] || '?'} -> ${status}`, ts: updatedTs });
            }
        }

        if (t.due_date) {
            const due = Number(t.due_date);
            const overdue = due < nowMs;
            if (overdue || (due - nowMs) < INBOX_DUE_SOON_MS) {
                items.push({ item_key: `d:${tid}:${due}`, kind: overdue ? 'overdue' : 'due', task_id: tid, task_name: t.name, project: meta.project, url: t.url, actor: null, snippet: dueLabel(due, nowMs), priority: prioName(t.priority), ts: due });
            }
        }
    }

    // 2) Comments + @mentions on my tasks (windowed, never my own comments).
    for (const t of rawTasks) {
        const meta = mapTask(t, userId);
        let comments = [];
        try { comments = await getTaskComments(token, t.id); }
        catch (e) { continue; } // skip this task's comments on error; keep the rest
        for (const c of comments) {
            const cdate = Number(c.date) || 0;
            if (cdate < nowMs - INBOX_COMMENT_WINDOW_MS) continue;
            if (c.user && String(c.user.id) === String(userId)) continue; // authored by me
            const mention = commentMentionsUser(c, userId);
            const text = (c.comment_text || '').replace(/\s+/g, ' ').trim();
            items.push({ item_key: `c:${c.id}`, kind: mention ? 'mention' : 'comment', task_id: String(t.id), task_name: t.name, project: meta.project, url: t.url, actor: c.user ? c.user.username : null, snippet: text.slice(0, 240), ts: cdate });
        }
    }

    // Persist the feed (full swap) + advance the persistent baseline / read-state.
    db.replaceInboxItems(items);
    db.setInboxKnownTasks(newKnown);
    // Prune seen-state to keys still present (anything else has aged out of the
    // window or no longer exists, so it can never resurface).
    const live = new Set(items.map(i => i.item_key));
    const prunedSeen = {};
    for (const k of Object.keys(seen)) if (live.has(k)) prunedSeen[k] = seen[k];
    db.setInboxSeen(prunedSeen);
    if (!initialized) db.setConfig('inbox_initialized', '1');

    return items.length;
}

// Mark one inbox item key as seen (persistent). Returns the updated seen map size.
function markInboxSeen(itemKey) {
    if (!itemKey) return;
    const seen = db.getInboxSeen();
    seen[String(itemKey)] = Date.now();
    db.setInboxSeen(seen);
}
// Mark every current inbox item as seen (the "clear all" action).
function markAllInboxSeen() {
    const seen = db.getInboxSeen();
    const t = Date.now();
    for (const it of db.getInboxItems()) seen[it.item_key] = t;
    db.setInboxSeen(seen);
}

// ─── Increment 2: time-entry creation (deterministic) ──────────────────────
//
// WORKLOGS BELONG TO EXACTLY ONE WORKSPACE: Acme Cloud Co. The token also sees
// "Test Sandbox" and "Arkly BizApps Projects" — neither is ever a valid target for
// a time entry, and neither may pollute the history the analyst learns from.
//
// This used to be `teams[0]`, i.e. whatever workspace ClickUp happened to list
// first — which is the SANDBOX. So every time entry was posted to the sandbox and
// rejected with a 400 "You do not have access to this task", and the recent-worklog
// history was read from the sandbox too (10 dummy rows instead of 185 real ones).
// The error text reads like an auth failure, so this was misdiagnosed as an expired
// token for months. Never infer the workspace — pin it and fail closed.
//
// Resolved by NAME once against the live team list, then compared by ID (a rename
// in ClickUp is a config edit here, never a silent switch to the wrong workspace).
const WORKLOG_TEAM_NAME = process.env.CLICKUP_WORKSPACE_NAME || 'Acme Cloud Co';
let cachedTeamId = null;

async function getTeamId(token) {
    if (process.env.CLICKUP_TEAM_ID) return String(process.env.CLICKUP_TEAM_ID);
    if (cachedTeamId) return cachedTeamId;
    const tok = token || getToken();
    if (!tok) throw new Error('no ClickUp API token configured');
    const teams = await fetchTeams(tok);
    if (!teams.length) throw new Error('no ClickUp workspace visible to this token');
    const want = WORKLOG_TEAM_NAME.trim().toLowerCase();
    const hit = teams.find(t => String(t.name || '').trim().toLowerCase() === want);
    if (!hit) {
        // Fail closed: logging into a guessed workspace is worse than not logging.
        throw new Error(
            `ClickUp workspace "${WORKLOG_TEAM_NAME}" not found — worklogs go there and nowhere else. ` +
            `Visible: ${teams.map(t => `${t.name} (${t.id})`).join(', ')}. ` +
            `Set CLICKUP_WORKSPACE_NAME or CLICKUP_TEAM_ID.`);
    }
    cachedTeamId = String(hit.id);
    return cachedTeamId;
}

// Which workspace a task actually lives in — used to REJECT a task that is not in
// the worklog workspace, so a wrong/hallucinated task id can never book hours
// somewhere else. Cached per task id.
const taskTeamCache = new Map();
async function teamForTask(token, taskId) {
    const key = String(taskId);
    if (taskTeamCache.has(key)) return taskTeamCache.get(key);
    const t = await apiGet(token, `/api/v2/task/${encodeURIComponent(key)}`);
    const teamId = t && t.team_id ? String(t.team_id) : null;
    if (teamId) taskTeamCache.set(key, teamId);
    return teamId;
}

// Both caches above are keyed to WHOEVER the token is: a different token can see a
// different workspace list (and different tasks), so a token change must invalidate
// them. Without this, changing the token keeps posting worklogs against the previous
// account's resolved team id until the process restarts.
function resetCaches() {
    cachedTeamId = null;
    taskTeamCache.clear();
    listStateCache.clear();
    catalogueCache = null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Create ONE ClickUp time entry. Retries transient 5xx (the ~40% Cloudflare 502s)
// — safe because a 502 means the create did NOT persist server-side. Returns the
// new time-entry id. Caller is responsible for never re-firing a SUCCEEDED create.
async function createTimeEntry({ taskId, dateMs, durationMs, billable, description }) {
    const token = getToken();
    if (!token) throw new Error('no ClickUp API token configured');
    if (!taskId) throw new Error('createTimeEntry: taskId required');
    const teamId = await getTeamId(token); // always the worklog workspace (ACME)
    // Guard: the task must live in THAT workspace. Without this, a task id from
    // the sandbox or Arkly would be posted to ACME and rejected with ClickUp's
    // misleading "you do not have access" — the exact error that cost us months.
    let taskTeam = null;
    try { taskTeam = await teamForTask(token, taskId); }
    catch (e) {
        // A deleted task (ITEM_013) surfaces here: report it plainly instead of
        // letting it fail later as an opaque "no access" on the create.
        if (/ITEM_013|not found|deleted/i.test(e.message)) {
            throw new Error(`clickup task ${taskId} not found or deleted — reassign this worklog to a live task`);
        }
        throw e;
    }
    if (taskTeam && taskTeam !== teamId) {
        throw new Error(`clickup task ${taskId} is not in the ${WORKLOG_TEAM_NAME} workspace — worklogs are only logged there, so this entry was not created`);
    }
    const body = {
        tid: String(taskId),
        start: Math.round(Number(dateMs) || Date.now()),
        duration: Math.max(0, Math.round(Number(durationMs) || 0)),
        billable: !!billable,
        description: String(description || ''),
    };
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await apiPost(token, `/api/v2/team/${encodeURIComponent(teamId)}/time_entries`, body);
            const id = r && r.data && r.data.id ? r.data.id : (r && r.id) || null;
            return { id };
        } catch (e) {
            lastErr = e;
            const code = e.statusCode || 0;
            // Retry only transient gateway errors; a 4xx is a real rejection.
            if (code >= 500 || code === 429) { await sleep(800 * (attempt + 1)); continue; }
            throw e;
        }
    }
    throw lastErr || new Error('createTimeEntry: exhausted retries');
}

// Read Leon's OWN recent ClickUp time entries (his real worklog history) so the
// analyst can learn his actual logging patterns: comment voice, which task each
// project maps to, how he splits hours, billable choices. Range in unix-ms.
async function getTimeEntries(startMs, endMs) {
    const token = getToken();
    if (!token) throw new Error('no ClickUp API token configured');
    let qs = `start_date=${Math.round(startMs)}&end_date=${Math.round(endMs)}`;
    const assignee = process.env.CLICKUP_USER_ID;
    if (assignee) qs += `&assignee=${encodeURIComponent(assignee)}`;
    // ONLY the worklog workspace (ACME). This used to read teams[0] = the sandbox,
    // so the analyst learned Leon's "patterns" from 10 dummy rows instead of his
    // 185 real ones. Reading every workspace would fix the count but re-introduce
    // the same disease: sandbox/Arkly entries teaching it the wrong task ids.
    const teamId = await getTeamId(token);
    const r = await apiGet(token, `/api/v2/team/${encodeURIComponent(teamId)}/time_entries?${qs}`);
    const data = (r && r.data) || [];
    return data.map(e => ({
        task_id: e.task && e.task.id ? String(e.task.id) : (e.tid ? String(e.tid) : null),
        task_name: e.task && e.task.name ? e.task.name : null,
        description: e.description || '',
        hours: e.duration ? Math.round((Number(e.duration) / 3600000) * 100) / 100 : 0,
        billable: !!e.billable,
        start: e.start ? Number(e.start) : null,
    })).filter(e => e.task_id);
}

// Look up a single ClickUp task by id (for the paste-a-task-id autocomplete).
async function lookupTask(taskId) {
    const token = getToken();
    if (!token) throw new Error('no ClickUp API token configured');
    const t = await apiGet(token, `/api/v2/task/${encodeURIComponent(taskId)}`);
    if (!t || !t.id) return null;
    return {
        id: t.id,
        name: t.name || null,
        status: t.status && t.status.status ? t.status.status : null,
        url: t.url || null,
    };
}

// ─── Is a task still a place to log time? (2026-09-30) ─────────────────────
//
// The worklog generator kept booking hours on tasks that were archived, because
// nothing ever asked. Two traps, both measured against the live workspace:
//   - "General Administration" (86ae7fqj1) has archived=true on the TASK;
//   - every task in the archived "Marketing" list still reports archived=false —
//     only the LIST says it is archived. So the list (and its folder and space)
//     must be checked too, not just the task.
// A 404 is a deleted task: treated the same as archived. Closed/complete is only
// a warning — Leon does log time on work he just finished.
const LIST_TTL_MS = 10 * 60 * 1000;
const listStateCache = new Map(); // listId -> { at, archived, name, folder, space }

async function listState(token, listId) {
    const key = String(listId);
    const hit = listStateCache.get(key);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit;
    const l = await apiGet(token, `/api/v2/list/${encodeURIComponent(key)}`);
    const folder = l.folder || {}, space = l.space || {};
    const st = {
        at: Date.now(),
        archived: !!(l.archived || folder.archived || space.archived),
        why: l.archived ? 'its list is archived' : folder.archived ? 'its folder is archived' : space.archived ? 'its space is archived' : null,
        name: l.name || null,
        // A folderless list comes back with a hidden placeholder folder.
        folder: folder.hidden ? null : (folder.name || null),
        space: space.name || null,
    };
    listStateCache.set(key, st);
    return st;
}

// { state: 'live'|'closed'|'archived'|'gone', reason, name, status, list_id, list_name, folder_name }
// 'archived' and 'gone' BLOCK a worklog; 'closed' only warns. Network errors throw —
// an unknown state is never reported as live.
async function taskHealth(taskId) {
    const token = getToken();
    if (!token) throw new Error('no ClickUp API token configured');
    let t;
    try { t = await apiGet(token, `/api/v2/task/${encodeURIComponent(String(taskId))}`); }
    catch (e) {
        if (e.statusCode === 404 || /ITEM_013|not found|deleted/i.test(e.message)) {
            return { state: 'gone', reason: 'task not found or deleted' };
        }
        throw e;
    }
    const out = {
        name: t.name || null,
        status: t.status && t.status.status ? t.status.status : null,
        list_id: t.list && t.list.id ? String(t.list.id) : null,
        list_name: t.list && t.list.name ? t.list.name : null,
        folder_name: t.folder && !t.folder.hidden ? (t.folder.name || null) : null,
    };
    if (t.archived) return { ...out, state: 'archived', reason: 'task is archived' };
    if (out.list_id) {
        const ls = await listState(token, out.list_id);
        if (ls.archived) return { ...out, state: 'archived', reason: ls.why };
    }
    const type = t.status && t.status.type;
    if (type === 'closed' || type === 'done') return { ...out, state: 'closed', reason: `status: ${out.status || type}` };
    return { ...out, state: 'live', reason: null };
}

// Every ACTIVE list in the worklog workspace, for "create a task here" suggestions.
// Archived spaces/folders/lists are left out by the API filter; SecretCo lists are
// dropped here so they never reach the analyst job file or the browser.
let catalogueCache = null; // { at, lists }
async function listCatalogue() {
    if (catalogueCache && Date.now() - catalogueCache.at < LIST_TTL_MS) return catalogueCache.lists;
    const token = getToken();
    if (!token) throw new Error('no ClickUp API token configured');
    const restrictedGuard = require('./restrictedGuard');
    const teamId = await getTeamId(token);
    const spaces = ((await apiGet(token, `/api/v2/team/${encodeURIComponent(teamId)}/space?archived=false`)) || {}).spaces || [];
    const lists = [];
    for (const s of spaces) {
        const folders = ((await apiGet(token, `/api/v2/space/${encodeURIComponent(s.id)}/folder?archived=false`)) || {}).folders || [];
        for (const f of folders) {
            if (f.archived) continue;
            for (const l of (f.lists || [])) {
                if (l.archived) continue;
                lists.push({ list_id: String(l.id), list: l.name, folder: f.name, space: s.name });
            }
        }
        const loose = ((await apiGet(token, `/api/v2/space/${encodeURIComponent(s.id)}/list?archived=false`)) || {}).lists || [];
        for (const l of loose) {
            if (l.archived) continue;
            lists.push({ list_id: String(l.id), list: l.name, folder: null, space: s.name });
        }
    }
    const clean = lists.filter(l => !restrictedGuard.mentionsRestricted(l.list, l.folder, l.space));
    catalogueCache = { at: Date.now(), lists: clean };
    return clean;
}

// Create ONE task for a worklog that had nowhere to go. Only into an active,
// non-SecretCo list of the worklog workspace (the catalogue above), assigned to Leon.
// Not retried: unlike a time entry, a create that timed out may still have landed,
// and a duplicate task is worse than a visible failure.
async function createTask({ listId, name, description }) {
    const token = getToken();
    if (!token) throw new Error('no ClickUp API token configured');
    const title = String(name || '').trim().slice(0, 200);
    if (!title) throw new Error('new task needs a name');
    const lists = await listCatalogue();
    const list = lists.find(l => l.list_id === String(listId || ''));
    if (!list) throw new Error('pick a list for the new task (it must be an active list in the worklog workspace)');
    const restrictedGuard = require('./restrictedGuard');
    restrictedGuard.assertNotRestricted('worklog task create', title, description);
    const body = { name: title, description: String(description || '').slice(0, 2000) };
    const userId = await resolveUserId(token).catch(() => null);
    if (userId) body.assignees = [Number(userId)];
    const t = await apiPost(token, `/api/v2/list/${encodeURIComponent(list.list_id)}/task`, body);
    if (!t || !t.id) throw new Error('ClickUp returned no task id');
    return { id: String(t.id), name: t.name || title, url: t.url || null, list };
}

let timer = null;
async function tick() {
    if (!getToken()) return; // nothing to do until a token is configured
    try { await syncOnce(); }
    catch (e) { console.warn('[clickupSync] tick failed:', e.message); }
}

function start() {
    if (timer) return;
    // Poll once immediately so tasks assigned while the server was off are caught
    // on startup, then on the interval.
    setTimeout(() => { tick().catch(() => {}); }, 3000).unref?.();
    timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
    timer.unref?.();
    console.log(`[clickupSync] started (poll=${POLL_MS}ms, token=${getToken() ? 'set' : 'MISSING'})`);
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
    start, stop, tick, syncOnce, getToken, getTeamId, createTimeEntry, getTimeEntries,
    lookupTask, taskHealth, listCatalogue, createTask, buildInbox, markInboxSeen, markAllInboxSeen,
    tokenInfo, verifyToken, resetCaches, WORKLOG_TEAM_NAME,
};
