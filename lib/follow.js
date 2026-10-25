'use strict';
// ── follow.js — which session Tesla watches after an action ─────────────────
//
// A send whose answer nobody would hear: she sent the owner's message to a
// session while watching nothing, so "how is it going" got "I can't see what it
// is doing", and he had to ask what it said four times. Since 2026-10-24 there
// is no picker: she watches the session she last
// TOUCHED - wrote to, opened or reopened - even over the one she was watching,
// so its answer is narrated when its turn ends. A batch of several moves nothing.
// Returns the session to follow, or ''.

function followTarget(name, v) {
    if (!v) return '';
    if (name === 'say_to_session') return v.sent === true && v.session ? String(v.session) : '';
    if (name === 'open_session' || name === 'reopen_sessions') {
        const ok = (Array.isArray(v.opened) ? v.opened : []).filter(o => o && o.ok && o.session);
        return v.opened && v.opened.length === 1 && ok.length === 1 ? String(ok[0].session) : '';
    }
    return '';
}

module.exports = { followTarget };
