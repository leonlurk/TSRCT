// In-memory activity log: a small ring buffer of what the dispatcher/Hermes is
// doing (state transitions, reconcile drafts, dispatches, polish, voice drafts).
// Surfaced in the Cockpit as a live feed so the user can SEE Hermes working.
// Not persisted — it's a live tail, cheap, resets on server restart.

const MAX = Number(process.env.ACTIVITY_LOG_MAX || 200);

const buf = [];
let seq = 0;

// type ∈ 'monitor' | 'state' | 'reconcile' | 'draft' | 'dispatch' | 'polish' | 'voice'
function push(type, message, meta = {}) {
    seq += 1;
    buf.push({ id: seq, at: Date.now(), type, message: String(message || ''), meta });
    if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    return seq;
}

// Newest first.
function getRecent(n = 50) {
    const slice = buf.slice(-n);
    slice.reverse();
    return slice;
}

// Events with id > sinceId, oldest first (so the client can replay in order).
// Optional `types` array filters by event type.
function getSince(sinceId = 0, types = null) {
    return buf.filter(e => e.id > sinceId && (!types || types.includes(e.type)));
}

// Highest seq currently in the buffer (0 if empty). Lets a poller advance its
// cursor even when no matching events were returned this round.
function latestId() {
    return buf.length ? buf[buf.length - 1].id : 0;
}

function clear() { buf.length = 0; }

module.exports = { push, getRecent, getSince, latestId, clear };
