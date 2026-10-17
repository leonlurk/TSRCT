// Phase 4: periodic daemon that refreshes session states and triggers
// reconciliation on transitions into waiting_input / failed.

const db = require('./db');
const tmux = require('./tmuxAdapter');
const eventConsumer = require('./eventConsumer');
const activityLog = require('./activityLog');

// Poll every 10s so "session finished / needs you" voice alerts land promptly.
// tmux capture-pane per session is cheap; reconciliation still only fires once
// per real transition (deduped by prev !== state), so faster polling just means
// sooner detection, not more Hermes work.
const POLL_MS = Number(process.env.DISPATCHER_MONITOR_MS || 10000);
const PAUSED_KEY = 'monitoring_paused_sessions';

const previousStates = new Map(); // sessionName → state

let timer = null;
// Heartbeat: proof the monitor loop is alive, surfaced in the Cockpit header.
let lastTickAt = null;
let tickCount = 0;

function getHeartbeat() {
    return {
        running: !!timer,
        poll_ms: POLL_MS,
        last_tick_at: lastTickAt,
        tick_count: tickCount,
    };
}

function getPausedSet() {
    try {
        const raw = db.getConfig(PAUSED_KEY);
        return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
}
function savePausedSet(set) {
    try { db.setConfig(PAUSED_KEY, JSON.stringify(Array.from(set))); } catch {}
}
function pause(name) { const s = getPausedSet(); s.add(name); savePausedSet(s); }
function resume(name) { const s = getPausedSet(); s.delete(name); savePausedSet(s); }
function isPaused(name) { return getPausedSet().has(name); }

async function tick() {
    lastTickAt = Date.now();
    tickCount += 1;
    let sessions;
    try { sessions = tmux.listSessions(); } catch { return; }

    for (const s of sessions) {
        let result;
        try {
            result = eventConsumer.refreshSessionState(s.name);
        } catch (e) {
            console.warn(`[sessionMonitor] refresh ${s.name} failed: ${e.message}`);
            continue;
        }
        if (!result) continue;
        const prev = previousStates.get(s.name);
        previousStates.set(s.name, result.state);

        // Log every real state transition so the user sees the monitor working.
        if (prev !== undefined && prev !== result.state) {
            activityLog.push('state', `${s.name}: ${prev} -> ${result.state}`, { session: s.name, from: prev, to: result.state });
        }

        // Trigger reconciliation only on transition INTO waiting_input/failed,
    }
}

function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
    timer.unref?.();
    // First run after a small delay.
    setTimeout(() => { tick().catch(() => {}); }, 5000).unref?.();
    console.log(`[sessionMonitor] started (poll every ${POLL_MS}ms)`);
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { start, stop, tick, pause, resume, isPaused, getPausedSet, getHeartbeat };
