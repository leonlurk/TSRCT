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
};
