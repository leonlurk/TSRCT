// Phase 2: consume Claude Code hook events to keep session_states fresh.
//
// We don't subscribe via a websocket — we just expose `ingest(event)` that the
// server.js /api/event handler calls for every hook payload. This is the
// lightest possible coupling and works for the events we get from notify.sh.
//
// We also expose `pollDirty()` for sessions where the event stream is silent
// — periodically the sessionMonitor (Phase 4) calls this to re-capture and
// reclassify state via outputParser.

const db = require('./db');
const outputParser = require('./outputParser');

// Persisted per-session last_event_id to dedupe + maintain "stop_event_seen_at".
const sessionEventClock = new Map(); // session -> { stopAt, lastEventAt, lastEventId }

function clockFor(name) {
    if (!sessionEventClock.has(name)) sessionEventClock.set(name, {});
    return sessionEventClock.get(name);
}

function inferSessionFromEvent(ev) {
    // Hook events include cwd; map back to a tmux session by matching cwd to
    // session_states.last_capture isn't precise — easiest is to trust cwd as
    // session_name when the convention is cc-<slug>. Otherwise fall back to
    // ev.session_id (Claude Code's internal id, sometimes set).
    return ev.session || ev.tmux_session || ev.session_id || null;
}

function applyEventToState(name, ev, now = Date.now()) {
    if (!name) return;
    const clock = clockFor(name);
    clock.lastEventAt = now;
    clock.lastEventId = ev.id || ev.tool_use_id || String(now);

    const hookName = ev.event || ev.hook_event_name;
    if (hookName === 'Stop' || hookName === 'SubagentStop') {
        clock.stopAt = now;
    }

    // Re-derive state from a fresh capture with the new event hints.
    const result = outputParser.parseSessionState(name, {
        stopEventSeenAt: clock.stopAt,
        previousCaptureAt: clock.lastCaptureAt,
        previousCapture: clock.lastCapture,
        now,
    });
    clock.lastCapture = result.capture;
    clock.lastCaptureAt = now;

    db.upsertSessionState({
        name,
        state: result.state,
        reason: result.reason,
        last_activity: result.lastActivity,
        last_event_id: clock.lastEventId,
        last_capture: result.capture ? result.capture.slice(-4000) : null,
    });
    return result.state;
}

function ingest(ev) {
    if (!ev || typeof ev !== 'object') return;
    const session = inferSessionFromEvent(ev);
    if (!session) return; // some events don't carry session info; that's fine
    try {
        applyEventToState(session, ev);
    } catch (e) {
        console.error('[eventConsumer] failed to apply event:', e.message);
    }
}

// Periodic state refresh for one session (called by Phase 4 sessionMonitor).
function refreshSessionState(name) {
    if (!name) return null;
    const clock = clockFor(name);
    const result = outputParser.parseSessionState(name, {
        stopEventSeenAt: clock.stopAt,
        previousCaptureAt: clock.lastCaptureAt,
        previousCapture: clock.lastCapture,
        // Hysteresis inputs: without these every poll looks like the first one
        // and a working session flaps to idle the moment Claude pauses to think.
        previousState: clock.lastState,
        staticSamples: clock.staticSamples || 0,
    });
    clock.lastState = result.state;
    clock.staticSamples = result.static ? (result.staticSamples || 0) : 0;
    // Only advance the "unchanged since" clock when the screen actually moved,
    // or the 5-minute idle rule can never fire.
    if (result.capture !== clock.lastCapture) clock.lastCaptureAt = Date.now();
    clock.lastCapture = result.capture;
    db.upsertSessionState({
        name,
        state: result.state,
        reason: result.reason,
        last_activity: result.lastActivity,
        last_event_id: clock.lastEventId || null,
        last_capture: result.capture ? result.capture.slice(-4000) : null,
    });
    return result;
}

// Associate a dispatched task with a session (called by core.approveTask).
function bindTaskToSession(sessionName, taskId) {
    if (!sessionName || !taskId) return;
    db.upsertSessionState({
        name: sessionName,
        state: 'working',
        reason: 'dispatched task',
        last_activity: Date.now(),
        current_task_id: taskId,
    });
    const clock = clockFor(sessionName);
    clock.stopAt = null; // reset; we want to see a NEW Stop after this dispatch
}

module.exports = { ingest, refreshSessionState, bindTaskToSession };
