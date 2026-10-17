// Dispatcher SQLite layer (uses Node built-in node:sqlite — no external dep).
// Schema: tasks (one row per bundled task) + messages (raw inputs that compose a task) + config.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

let db = null;
let stmts = null;

function init(dbPath) {
    const fullPath = dbPath || path.join(__dirname, '..', '..', 'data', 'dispatcher.db');
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    db = new DatabaseSync(fullPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = OFF'); // off while we drop + rebuild the ephemeral tables; re-enabled below
    // Tighten file perms post-create (no-op on /mnt/c which is NTFS, but real on ext4).
    try {
        fs.chmodSync(fullPath, 0o600);
        const walPath = fullPath + '-wal';
        const shmPath = fullPath + '-shm';
        if (fs.existsSync(walPath)) fs.chmodSync(walPath, 0o600);
        if (fs.existsSync(shmPath)) fs.chmodSync(shmPath, 0o600);
    } catch {}

    // ── Ephemeral model ──────────────────────────────────────────────────────
    // The dispatcher's working data lives ONLY for the life of this server
    // process. Every startup DROPs and recreates these tables, so nothing
    // accumulates across restarts (no stale tasks / follow-ups / drafts / polish
    // jobs / voice corpus). Only `config` is persistent. Recreating from scratch
    // also keeps the schema always current with zero migration code for them.
    // Order: children before parents (FK is OFF here anyway).
    db.exec(`
        DROP TABLE IF EXISTS messages;
        -- Phase 6 tables: no longer CREATEd (the feature was deleted 2026-08-15).
        -- The DROPs stay so an existing dispatcher.db sheds them on the next boot;
        -- remove these two lines once every machine has started at least once.
        DROP TABLE IF EXISTS subtasks;
        DROP TABLE IF EXISTS anticipated_tasks;
        DROP TABLE IF EXISTS session_states;
        DROP TABLE IF EXISTS clickup_tasks;
        DROP TABLE IF EXISTS worklog_proposals;
        DROP TABLE IF EXISTS vault_digests;
        DROP TABLE IF EXISTS note_routes;
        DROP TABLE IF EXISTS inbox_items;
        DROP TABLE IF EXISTS tasks;
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            sender             TEXT,
            sender_id          TEXT,
            source             TEXT NOT NULL,
            raw_text           TEXT NOT NULL,
            project            TEXT,
            project_confidence REAL,
            task_type          TEXT,
            type_confidence    REAL,
            matched_session    TEXT,
            match_confidence   REAL,
            proposed_session   TEXT,
            proposed_cwd       TEXT,
            composed_prompt    TEXT,
            status             TEXT NOT NULL DEFAULT 'pending_review',
            created_at         INTEGER NOT NULL,
            updated_at         INTEGER NOT NULL,
            dispatched_at      INTEGER
        );

        CREATE TABLE IF NOT EXISTS messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            source      TEXT NOT NULL,
            source_id   TEXT NOT NULL,
            text        TEXT NOT NULL,
            permalink   TEXT,
            channel     TEXT,
            received_at INTEGER NOT NULL,
            UNIQUE(source, source_id)
        );

        CREATE INDEX IF NOT EXISTS idx_status   ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_sender   ON tasks(sender, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_msg_task ON messages(task_id);

        CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        -- Phase 2: live state of every tmux session relevant to the dispatcher.
        -- Updated by sessionMonitor (capture-based heuristic) and eventConsumer
        -- (Claude Code hook events). One row per session name.
        CREATE TABLE IF NOT EXISTS session_states (
            name             TEXT PRIMARY KEY,
            state            TEXT NOT NULL DEFAULT 'unknown',
            reason           TEXT,
            last_activity    INTEGER,
            last_event_id    TEXT,
            current_task_id  INTEGER REFERENCES tasks(id),
            last_capture     TEXT,
            updated_at       INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_session_state ON session_states(state);

        -- Phase 5: corpus of Leon's voice for RAG drafts.

        -- Phase 5: drafted replies waiting for Leon to copy + send.

        -- Local prompt-polisher: each row is one polish job dispatched to the
        -- dedicated cc-prompt-polisher Claude session. job_key is the filename
        -- stem used for jobs/<key>.json and out/<key>.md.

        -- Productivity Dashboard (Increment 1): tasks assigned to Leon in ClickUp,
        -- populated deterministically by the REST poller (clickupSync) + the webhook.
        -- EPHEMERAL like every table here: dedup key is clickup_task_id (UNIQUE), so a
        -- startup re-poll repopulates with ZERO duplicates. user_interpretation +
        -- analysis_json are the only Leon/analyst-authored columns; they are rebuilt
        -- on demand (interpretation re-entered, [Analyze] re-run) — acceptable to drop.
        CREATE TABLE IF NOT EXISTS clickup_tasks (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            clickup_task_id     TEXT NOT NULL UNIQUE,
            project             TEXT,
            title               TEXT,
            list_name           TEXT,
            clickup_status      TEXT,
            url                 TEXT,
            assignee_id         TEXT,
            user_interpretation TEXT,
            proposed_interpretation TEXT,        -- analyst's proposed "what done means" (Leon edits/confirms -> user_interpretation)
            mapped_session      TEXT,            -- tmux session Leon mapped to this task (its cwd = the project to analyze)
            analysis_json       TEXT,
            analysis_at         INTEGER,
            first_seen_at       INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_clickup_updated ON clickup_tasks(updated_at DESC);

        -- Productivity Dashboard (Increment 2): worklog proposals generated by the
        -- cc-tsrct-analyst session for a date range. Leon edits/approves; the SERVER
        -- creates the ClickUp time entry on explicit confirm. EPHEMERAL — a proposal
        -- not yet 'created' is just dropped on restart (Leon re-generates). Once
        -- created, clickup_time_entry_id is the idempotency guard (never re-fire).
        CREATE TABLE IF NOT EXISTS worklog_proposals (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id              TEXT NOT NULL,
            work_date             TEXT,                 -- YYYY-MM-DD
            project               TEXT,
            task_id               TEXT,                 -- ClickUp task id (editable)
            task_name             TEXT,
            hours                 REAL NOT NULL DEFAULT 0,
            comment               TEXT,
            billable              INTEGER NOT NULL DEFAULT 0,
            status                TEXT NOT NULL DEFAULT 'proposed', -- proposed|created|failed|dismissed
            clickup_time_entry_id TEXT,
            error                 TEXT,
            why                   TEXT,                 -- plain-language "where this came from"
            evidence_json         TEXT,                 -- [{source, ref, quote}] as the analyst cited it
            task_state            TEXT,                 -- live|closed|archived|gone (archived/gone block the create)
            task_note             TEXT,                 -- why, in words ("its list is archived", "status: complete")
            new_task_json         TEXT,                 -- {list_id, name, description}: create this task first, then log on it
            created_at            INTEGER NOT NULL,
            updated_at            INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_worklog_batch ON worklog_proposals(batch_id, work_date);

        -- Productivity Dashboard (Increment 3): vault digest runs. One row per run;
        -- content is the COMPACT 1-2-sentence-per-item summary the analyst emitted.
        CREATE TABLE IF NOT EXISTS vault_digests (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            content    TEXT,
            status     TEXT NOT NULL DEFAULT 'pending',  -- pending|ready|failed
            run_at     INTEGER NOT NULL,
            ready_at   INTEGER
        );

        -- Productivity Dashboard (Increment 3): meeting/Gemini-note routing. Leon
        -- drops a note; the analyst proposes a vault destination + formatted content;
        -- Leon approves (server writes it) / edits / dismisses.
        CREATE TABLE IF NOT EXISTS note_routes (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            note_text         TEXT NOT NULL,
            proposed_path     TEXT,
            proposed_content  TEXT,
            rationale         TEXT,
            status            TEXT NOT NULL DEFAULT 'pending', -- pending|ready|written|dismissed|failed
            error             TEXT,
            created_at        INTEGER NOT NULL,
            written_at        INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_note_status ON note_routes(status, created_at DESC);

        -- Productivity Dashboard (Inbox): the unified "where I stand" feed. Each row
        -- is ONE actionable signal reconstructed deterministically from ClickUp by
        -- clickupSync (mentions/comments on my tasks, new assignments, status changes,
        -- due/overdue). EPHEMERAL: rebuilt in full on every poll via replaceInboxItems,
        -- so this table is just a render cache. The READ-STATE (what Leon marked seen)
        -- and the assignment/status BASELINE live in the persistent config table
        -- (keys inbox_seen / inbox_known_tasks / inbox_initialized) so they survive
        -- restarts — otherwise every restart would re-flag the whole backlog as new.
        -- item_key is the stable identity used for seen-tracking + dedup:
        --   mention/comment -> c:{commentId} ; assigned -> a:{taskId}
        --   status          -> s:{taskId}:{status} ; due/overdue -> d:{taskId}:{dueMs}
        CREATE TABLE IF NOT EXISTS inbox_items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key    TEXT NOT NULL UNIQUE,
            kind        TEXT NOT NULL,        -- mention|comment|assigned|status|due|overdue
            task_id     TEXT,                 -- ClickUp task id
            task_name   TEXT,
            project     TEXT,
            url         TEXT,
            actor       TEXT,                 -- who triggered it (comment author / assigner)
            snippet     TEXT,                 -- comment text / status transition / due label
            priority    TEXT,                 -- for due/overdue rows
            ts          INTEGER,              -- event time (ms) — for ordering within a group
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_inbox_kind ON inbox_items(kind, ts DESC);
    `);

    // Ephemeral tables were just recreated fresh, so the old per-column ALTER
    // migrations are no longer needed (the schema above is always authoritative).
    db.exec('PRAGMA foreign_keys = ON');

    stmts = {
        insertTask: db.prepare(`
            INSERT INTO tasks (sender, sender_id, source, raw_text, status, created_at, updated_at)
            VALUES (@sender, @sender_id, @source, @raw_text, 'pending_review', @now, @now)
        `),
        updateTaskHermesOutput: db.prepare(`
            UPDATE tasks SET
                raw_text           = @raw_text,
                project            = @project,
                project_confidence = @project_confidence,
                task_type          = @task_type,
                type_confidence    = @type_confidence,
                matched_session    = @matched_session,
                match_confidence   = @match_confidence,
                proposed_session   = @proposed_session,
                proposed_cwd       = @proposed_cwd,
                composed_prompt    = @composed_prompt,
                updated_at         = @now
            WHERE id = @id
        `),
        insertMessage: db.prepare(`
            INSERT OR IGNORE INTO messages (task_id, source, source_id, text, permalink, channel, received_at)
            VALUES (@task_id, @source, @source_id, @text, @permalink, @channel, @received_at)
        `),
        getInbox: db.prepare(`
            SELECT * FROM tasks
            WHERE status = 'pending_review'
            ORDER BY created_at DESC
        `),
        getTask: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
        getMessages: db.prepare(`
            SELECT * FROM messages WHERE task_id = ? ORDER BY received_at ASC
        `),
        getRecentTasksBySender: db.prepare(`
            SELECT * FROM tasks
            WHERE sender_id = ? AND status = 'pending_review' AND created_at > ?
            ORDER BY created_at DESC
            LIMIT 5
        `),
        markDispatched: db.prepare(`
            UPDATE tasks
            SET status = 'dispatched', dispatched_at = @now, updated_at = @now,
                matched_session = COALESCE(@session, matched_session)
            WHERE id = @id
        `),
        markDismissed: db.prepare(`
            UPDATE tasks SET status = 'dismissed', updated_at = @now WHERE id = @id
        `),
        markDone: db.prepare(`
            UPDATE tasks SET status = 'done', updated_at = @now WHERE id = @id
        `),
        moveMessagesToTask: db.prepare(`
            UPDATE messages SET task_id = @new_task_id WHERE id IN (SELECT value FROM json_each(@msg_ids_json))
        `),
        getHistory: db.prepare(`
            SELECT * FROM tasks
            WHERE status IN ('dispatched', 'dismissed', 'done')
            ORDER BY updated_at DESC
            LIMIT ?
        `),
        getConfig: db.prepare(`SELECT value FROM config WHERE key = ?`),
        setConfig: db.prepare(`
            INSERT INTO config (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `),

        // Phase 2: session_states.
        upsertSessionState: db.prepare(`
            INSERT INTO session_states (name, state, reason, last_activity, last_event_id, current_task_id, last_capture, updated_at)
            VALUES (@name, @state, @reason, @last_activity, @last_event_id, @current_task_id, @last_capture, @now)
            ON CONFLICT(name) DO UPDATE SET
                state           = excluded.state,
                reason          = excluded.reason,
                last_activity   = COALESCE(excluded.last_activity, session_states.last_activity),
                last_event_id   = COALESCE(excluded.last_event_id, session_states.last_event_id),
                current_task_id = COALESCE(excluded.current_task_id, session_states.current_task_id),
                last_capture    = COALESCE(excluded.last_capture, session_states.last_capture),
                updated_at      = excluded.updated_at
        `),
        getSessionState: db.prepare(`SELECT * FROM session_states WHERE name = ?`),
        getAllSessionStates: db.prepare(`SELECT * FROM session_states ORDER BY updated_at DESC`),
        clearSessionTask: db.prepare(`UPDATE session_states SET current_task_id = NULL, updated_at = @now WHERE name = @name`),

        // Phase 2: tasks recently completed/dispatched for a project (used by contextBuilder).
        getRecentTasksForProject: db.prepare(`
            SELECT id, sender, raw_text, composed_prompt, status, created_at, dispatched_at
            FROM tasks
            WHERE project = ? AND status IN ('dispatched', 'done')
            ORDER BY COALESCE(dispatched_at, updated_at) DESC
            LIMIT ?
        `),




        getRecentDispatchedTasks: db.prepare(`
            SELECT * FROM tasks WHERE status IN ('dispatched', 'done') AND dispatched_at > ?
            ORDER BY dispatched_at DESC LIMIT 500
        `),

        // Local prompt-polisher jobs.

        // Productivity Dashboard: clickup_tasks. The upsert refreshes only the
        // ClickUp-sourced columns on conflict; user_interpretation + analysis_* are
        // deliberately PRESERVED (a re-poll must never wipe Leon's notes / verdict).
        upsertClickupTask: db.prepare(`
            INSERT INTO clickup_tasks
                (clickup_task_id, project, title, list_name, clickup_status, url, assignee_id, first_seen_at, updated_at)
            VALUES
                (@clickup_task_id, @project, @title, @list_name, @clickup_status, @url, @assignee_id, @now, @now)
            ON CONFLICT(clickup_task_id) DO UPDATE SET
                project        = excluded.project,
                title          = excluded.title,
                list_name      = excluded.list_name,
                clickup_status = excluded.clickup_status,
                url            = excluded.url,
                assignee_id    = excluded.assignee_id,
                updated_at     = excluded.updated_at
        `),
        getAllClickupTasks: db.prepare(`SELECT * FROM clickup_tasks ORDER BY updated_at DESC`),
        getClickupTask: db.prepare(`SELECT * FROM clickup_tasks WHERE id = ?`),
        getClickupTaskByClickupId: db.prepare(`SELECT * FROM clickup_tasks WHERE clickup_task_id = ?`),
        setClickupInterpretation: db.prepare(`
            UPDATE clickup_tasks SET user_interpretation = @interpretation, updated_at = @now WHERE id = @id
        `),
        setClickupAnalysis: db.prepare(`
            UPDATE clickup_tasks SET analysis_json = @analysis_json, analysis_at = @now, updated_at = @now WHERE id = @id
        `),
        setClickupProposedInterpretation: db.prepare(`
            UPDATE clickup_tasks SET proposed_interpretation = @proposed, updated_at = @now WHERE id = @id
        `),
        setClickupMappedSession: db.prepare(`
            UPDATE clickup_tasks SET mapped_session = @session, updated_at = @now WHERE id = @id
        `),

        // Increment 2: worklog_proposals.
        insertWorklogProposal: db.prepare(`
            INSERT INTO worklog_proposals
                (batch_id, work_date, project, task_id, task_name, hours, comment, billable, why, evidence_json, new_task_json, status, created_at, updated_at)
            VALUES
                (@batch_id, @work_date, @project, @task_id, @task_name, @hours, @comment, @billable, @why, @evidence_json, @new_task_json, 'proposed', @now, @now)
        `),
        setWorklogTaskState: db.prepare(`UPDATE worklog_proposals SET task_state = @state, task_note = @note, updated_at = @now WHERE id = @id`),
        setWorklogNewTask: db.prepare(`UPDATE worklog_proposals SET new_task_json = @json, updated_at = @now WHERE id = @id`),
        getWorklogProposalsByBatch: db.prepare(`SELECT * FROM worklog_proposals WHERE batch_id = ? ORDER BY work_date, id`),
        getWorklogProposal: db.prepare(`SELECT * FROM worklog_proposals WHERE id = ?`),
        updateWorklogProposal: db.prepare(`
            UPDATE worklog_proposals SET
                task_id   = @task_id,
                task_name = @task_name,
                hours     = @hours,
                comment   = @comment,
                billable  = @billable,
                project   = @project,
                updated_at = @now
            WHERE id = @id
        `),
        markWorklogCreated: db.prepare(`
            UPDATE worklog_proposals SET status = 'created', clickup_time_entry_id = @entry_id, error = NULL, updated_at = @now WHERE id = @id
        `),
        markWorklogFailed: db.prepare(`UPDATE worklog_proposals SET status = 'failed', error = @error, updated_at = @now WHERE id = @id`),
        markWorklogDismissed: db.prepare(`UPDATE worklog_proposals SET status = 'dismissed', updated_at = @now WHERE id = @id`),

        // Increment 3: vault_digests + note_routes.
        insertVaultDigest: db.prepare(`INSERT INTO vault_digests (content, status, run_at) VALUES (NULL, 'pending', @now)`),
        setVaultDigestReady: db.prepare(`UPDATE vault_digests SET content = @content, status = 'ready', ready_at = @now WHERE id = @id`),
        setVaultDigestFailed: db.prepare(`UPDATE vault_digests SET status = 'failed', content = @content, ready_at = @now WHERE id = @id`),
        getLatestVaultDigest: db.prepare(`SELECT * FROM vault_digests ORDER BY run_at DESC LIMIT 1`),
        insertNoteRoute: db.prepare(`INSERT INTO note_routes (note_text, status, created_at) VALUES (@note_text, 'pending', @now)`),
        setNoteRouteReady: db.prepare(`
            UPDATE note_routes SET proposed_path = @path, proposed_content = @content, rationale = @rationale, status = 'ready' WHERE id = @id
        `),
        setNoteRouteFailed: db.prepare(`UPDATE note_routes SET status = 'failed', error = @error WHERE id = @id`),
        updateNoteRouteProposal: db.prepare(`UPDATE note_routes SET proposed_path = @path, proposed_content = @content WHERE id = @id`),
        markNoteRouteWritten: db.prepare(`UPDATE note_routes SET status = 'written', written_at = @now WHERE id = @id`),
        markNoteRouteDismissed: db.prepare(`UPDATE note_routes SET status = 'dismissed' WHERE id = @id`),
        getNoteRoute: db.prepare(`SELECT * FROM note_routes WHERE id = ?`),
        getNoteRoutes: db.prepare(`SELECT * FROM note_routes WHERE status != 'dismissed' ORDER BY created_at DESC LIMIT 50`),

        // Inbox: full-rebuild render cache. clearInboxItems + insertInboxItem run
        // inside replaceInboxItems' transaction on every poll.
        clearInboxItems: db.prepare(`DELETE FROM inbox_items`),
        insertInboxItem: db.prepare(`
            INSERT OR REPLACE INTO inbox_items
                (item_key, kind, task_id, task_name, project, url, actor, snippet, priority, ts, created_at)
            VALUES
                (@item_key, @kind, @task_id, @task_name, @project, @url, @actor, @snippet, @priority, @ts, @now)
        `),
        getInboxItems: db.prepare(`SELECT * FROM inbox_items ORDER BY ts DESC`),
    };

    return db;
}

function getDb() {
    if (!db) throw new Error('dispatcher db not initialized');
    return db;
}

function now() { return Date.now(); }

function createTask({ sender, sender_id, source, raw_text }) {
    const res = stmts.insertTask.run({ sender, sender_id, source, raw_text, now: now() });
    return res.lastInsertRowid;
}

function attachMessage(task_id, msg) {
    stmts.insertMessage.run({
        task_id,
        source: msg.source,
        source_id: msg.source_id,
        text: msg.text,
        permalink: msg.permalink || null,
        channel: msg.channel || null,
        received_at: msg.received_at || now(),
    });
}

function applyHermesOutput(id, hermesOutput) {
    stmts.updateTaskHermesOutput.run({
        id,
        raw_text:           hermesOutput.raw_text,
        project:            hermesOutput.project || null,
        project_confidence: hermesOutput.project_confidence || null,
        task_type:          hermesOutput.task_type || null,
        type_confidence:    hermesOutput.type_confidence || null,
        matched_session:    hermesOutput.matched_session || null,
        match_confidence:   hermesOutput.match_confidence || null,
        proposed_session:   hermesOutput.proposed_session || null,
        proposed_cwd:       hermesOutput.proposed_cwd || null,
        composed_prompt:    hermesOutput.composed_prompt || null,
        now: now(),
    });
}

function getInbox() {
    const tasks = stmts.getInbox.all();
    return tasks.map(t => ({ ...t, messages: stmts.getMessages.all(t.id) }));
}

function getTask(id) {
    const task = stmts.getTask.get(id);
    if (!task) return null;
    return { ...task, messages: stmts.getMessages.all(id) };
}

function getRecentTasksBySender(sender_id, windowMs) {
    return stmts.getRecentTasksBySender.all(sender_id, now() - windowMs);
}

function markDispatched(id, session) {
    stmts.markDispatched.run({ id, session: session || null, now: now() });
}

function markDismissed(id) {
    stmts.markDismissed.run({ id, now: now() });
}

function markDone(id) {
    stmts.markDone.run({ id, now: now() });
}

function moveMessagesToNewTask(msgIds, newTaskFields) {
    // node:sqlite has no transaction() wrapper; use explicit BEGIN/COMMIT.
    db.exec('BEGIN');
    try {
        const newId = createTask(newTaskFields);
        stmts.moveMessagesToTask.run({
            new_task_id: newId,
            msg_ids_json: JSON.stringify(msgIds),
        });
        db.exec('COMMIT');
        return newId;
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

function getHistory(limit = 50) {
    return stmts.getHistory.all(limit);
}

function getConfig(key) {
    const row = stmts.getConfig.get(key);
    return row ? row.value : null;
}

function setConfig(key, value) {
    stmts.setConfig.run(key, value);
}

// ─── Productivity Dashboard: durable task meta (survives the ephemeral rebuild) ──
// The clickup_tasks table is dropped on every restart, but Leon's mapped_session,
// confirmed interpretation, and the analyst's proposed interpretation are worth
// keeping. We mirror just those three fields into the persistent `config` table as
// one small JSON map keyed by clickup_task_id (stable across restarts). Tiny: a few
// short strings per task. write-through on edit (persistTaskMeta) + restore on the
// re-sync upsert (restoreTaskMeta).
const TASK_META_KEY = 'clickup_task_meta';
function readTaskMetaMap() { try { return JSON.parse(getConfig(TASK_META_KEY) || '{}'); } catch { return {}; } }
function persistTaskMeta(id, field, value) {
    const row = stmts.getClickupTask.get(id);
    if (!row || row.clickup_task_id == null) return;
    const cid = String(row.clickup_task_id);
    const map = readTaskMetaMap();
    const entry = map[cid] || {};
    if (value == null || value === '') delete entry[field];
    else entry[field] = value;
    if (Object.keys(entry).length) map[cid] = entry; else delete map[cid];
    setConfig(TASK_META_KEY, JSON.stringify(map));
}

// ─── Phase 2: session_states helpers ──────────────────────────────────────
function upsertSessionState(fields) {
    stmts.upsertSessionState.run({
        name:            fields.name,
        state:           fields.state || 'unknown',
        reason:          fields.reason || null,
        last_activity:   fields.last_activity || null,
        last_event_id:   fields.last_event_id || null,
        current_task_id: fields.current_task_id || null,
        last_capture:    fields.last_capture || null,
        now: now(),
    });
}
function getSessionState(name) { return stmts.getSessionState.get(name) || null; }
function getAllSessionStates() { return stmts.getAllSessionStates.all(); }
function clearSessionTask(name) { stmts.clearSessionTask.run({ name, now: now() }); }
function getRecentTasksForProject(project, limit = 3) {
    if (!project) return [];
    return stmts.getRecentTasksForProject.all(project, limit);
}

module.exports = {
    init,
    getDb,
    createTask,
    attachMessage,
    applyHermesOutput,
    getInbox,
    getTask,
    getRecentTasksBySender,
    markDispatched,
    markDismissed,
    markDone,
    moveMessagesToNewTask,
    getHistory,
    getConfig,
    setConfig,
    // Phase 2
    upsertSessionState,
    getSessionState,
    getAllSessionStates,
    clearSessionTask,
    getRecentTasksForProject,
    getRecentDispatchedTasks: (sinceMs) => stmts.getRecentDispatchedTasks.all(Date.now() - sinceMs),
    upsertClickupTask: (fields) => {
        stmts.upsertClickupTask.run({
            clickup_task_id: String(fields.clickup_task_id),
            project:         fields.project || null,
            title:           fields.title || null,
            list_name:       fields.list_name || null,
            clickup_status:  fields.clickup_status || null,
            url:             fields.url || null,
            assignee_id:     fields.assignee_id != null ? String(fields.assignee_id) : null,
            now: now(),
        });
        const cid = String(fields.clickup_task_id);
        let row = stmts.getClickupTaskByClickupId.get(cid) || null;
        // Restore durable meta (mapping / interpretation) saved in config — lets these
        // survive the ephemeral table rebuild on restart. Config is authoritative.
        if (row) {
            const meta = readTaskMetaMap()[cid];
            if (meta) {
                if (meta.user_interpretation != null && meta.user_interpretation !== row.user_interpretation)
                    stmts.setClickupInterpretation.run({ id: row.id, interpretation: meta.user_interpretation, now: now() });
                if (meta.mapped_session != null && meta.mapped_session !== row.mapped_session)
                    stmts.setClickupMappedSession.run({ id: row.id, session: meta.mapped_session, now: now() });
                if (meta.proposed_interpretation != null && meta.proposed_interpretation !== row.proposed_interpretation)
                    stmts.setClickupProposedInterpretation.run({ id: row.id, proposed: meta.proposed_interpretation, now: now() });
                row = stmts.getClickupTaskByClickupId.get(cid) || row;
            }
        }
        return row;
    },
    getAllClickupTasks: () => stmts.getAllClickupTasks.all(),
    getClickupTask: (id) => stmts.getClickupTask.get(id) || null,
    getClickupTaskByClickupId: (cid) => stmts.getClickupTaskByClickupId.get(String(cid)) || null,
    setClickupInterpretation: (id, interpretation) => { stmts.setClickupInterpretation.run({ id, interpretation: interpretation || null, now: now() }); persistTaskMeta(id, 'user_interpretation', interpretation || null); },
    setClickupAnalysis: (id, analysisJson) => stmts.setClickupAnalysis.run({ id, analysis_json: analysisJson || null, now: now() }),
    setClickupProposedInterpretation: (id, proposed) => { stmts.setClickupProposedInterpretation.run({ id, proposed: proposed || null, now: now() }); persistTaskMeta(id, 'proposed_interpretation', proposed || null); },
    setClickupMappedSession: (id, session) => { stmts.setClickupMappedSession.run({ id, session: session || null, now: now() }); persistTaskMeta(id, 'mapped_session', session || null); },
    // Increment 2: worklog_proposals.
    insertWorklogProposal: (f) => stmts.insertWorklogProposal.run({
        batch_id: f.batch_id,
        work_date: f.work_date || null,
        project: f.project || null,
        task_id: f.task_id || null,
        task_name: f.task_name || null,
        hours: Number(f.hours) || 0,
        comment: f.comment || null,
        billable: f.billable ? 1 : 0,
        why: f.why || null,
        evidence_json: f.evidence_json || null,
        new_task_json: f.new_task_json || null,
        now: now(),
    }).lastInsertRowid,
    setWorklogTaskState: (id, state, note) => stmts.setWorklogTaskState.run({ id, state: state || null, note: note || null, now: now() }),
    setWorklogNewTask: (id, obj) => stmts.setWorklogNewTask.run({ id, json: obj ? JSON.stringify(obj) : null, now: now() }),
    getWorklogProposalsByBatch: (batchId) => stmts.getWorklogProposalsByBatch.all(batchId),
    getWorklogProposal: (id) => stmts.getWorklogProposal.get(id) || null,
    updateWorklogProposal: (id, f) => stmts.updateWorklogProposal.run({
        id,
        task_id: f.task_id || null,
        task_name: f.task_name || null,
        hours: Number(f.hours) || 0,
        comment: f.comment || null,
        billable: f.billable ? 1 : 0,
        project: f.project || null,
        now: now(),
    }),
    markWorklogCreated: (id, entryId) => stmts.markWorklogCreated.run({ id, entry_id: entryId != null ? String(entryId) : null, now: now() }),
    markWorklogFailed: (id, error) => stmts.markWorklogFailed.run({ id, error: error || 'unknown', now: now() }),
    markWorklogDismissed: (id) => stmts.markWorklogDismissed.run({ id, now: now() }),
    // Increment 3: vault_digests.
    insertVaultDigest: () => stmts.insertVaultDigest.run({ now: now() }).lastInsertRowid,
    setVaultDigestReady: (id, content) => stmts.setVaultDigestReady.run({ id, content: content || '', now: now() }),
    setVaultDigestFailed: (id, content) => stmts.setVaultDigestFailed.run({ id, content: content || 'digest failed', now: now() }),
    getLatestVaultDigest: () => stmts.getLatestVaultDigest.get() || null,
    // Increment 3: note_routes.
    insertNoteRoute: (noteText) => stmts.insertNoteRoute.run({ note_text: noteText, now: now() }).lastInsertRowid,
    setNoteRouteReady: (id, f) => stmts.setNoteRouteReady.run({ id, path: f.path || null, content: f.content || null, rationale: f.rationale || null }),
    setNoteRouteFailed: (id, error) => stmts.setNoteRouteFailed.run({ id, error: error || 'unknown' }),
    updateNoteRouteProposal: (id, f) => stmts.updateNoteRouteProposal.run({ id, path: f.path || null, content: f.content || null }),
    markNoteRouteWritten: (id) => stmts.markNoteRouteWritten.run({ id, now: now() }),
    markNoteRouteDismissed: (id) => stmts.markNoteRouteDismissed.run({ id }),
    getNoteRoute: (id) => stmts.getNoteRoute.get(id) || null,
    getNoteRoutes: () => stmts.getNoteRoutes.all(),
    // Inbox. replaceInboxItems atomically swaps the whole feed each poll.
    replaceInboxItems: (items) => {
        db.exec('BEGIN');
        try {
            stmts.clearInboxItems.run();
            const t = now();
            for (const it of (items || [])) {
                stmts.insertInboxItem.run({
                    item_key:  String(it.item_key),
                    kind:      String(it.kind),
                    task_id:   it.task_id != null ? String(it.task_id) : null,
                    task_name: it.task_name || null,
                    project:   it.project || null,
                    url:       it.url || null,
                    actor:     it.actor || null,
                    snippet:   it.snippet || null,
                    priority:  it.priority || null,
                    ts:        it.ts != null ? Number(it.ts) : t,
                    now: t,
                });
            }
            db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    getInboxItems: () => stmts.getInboxItems.all(),
    // Inbox read-state + baseline live in the persistent `config` table as JSON, so
    // they survive the ephemeral-table rebuild on restart. Helpers are thin JSON
    // accessors over getConfig/setConfig.
    getInboxSeen: () => { try { return JSON.parse(getConfig('inbox_seen') || '{}'); } catch { return {}; } },
    setInboxSeen: (obj) => setConfig('inbox_seen', JSON.stringify(obj || {})),
    getInboxKnownTasks: () => { try { return JSON.parse(getConfig('inbox_known_tasks') || '{}'); } catch { return {}; } },
    setInboxKnownTasks: (obj) => setConfig('inbox_known_tasks', JSON.stringify(obj || {})),
};
