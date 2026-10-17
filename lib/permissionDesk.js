'use strict';
// ── permissionDesk.js — the permission queue, as the assistant sees it ──────
//
// The queue itself lives in server.js (permission-hook.sh posts into it and
// polls it). This is the one door the assistant goes through, so "aproba todos
// los permisos de harbor" answers exactly the cards the phone would show and in
// exactly the way a tap on [approve] does: the hook reads `decision` on its next
// poll. No keystroke is sent to any pane from here.
//
// Written 2026-09-24 so Tesla can work in BULK: every card across every session,
// in one sentence and one yes.

let deps = { queue: null };   // () => Map of id -> perm
function configure(d) { deps = { ...deps, ...(d || {}) }; }

function pending(sessions = null) {
    const q = deps.queue ? deps.queue() : null;
    if (!q) return [];
    const only = Array.isArray(sessions) && sessions.length ? new Set(sessions) : null;
    return [...q.values()]
        .filter(p => p && p.status === 'pending' && !p.decision)
        .filter(p => !only || only.has(p.session))
        .sort((a, b) => a.timestamp - b.timestamp);
}

// What a card IS, in a line he can hear: the tool and the command or file.
function describe(p) {
    const what = String(p.command || p.file || p.description || '').replace(/\s+/g, ' ').trim();
    return `${p.tool || 'algo'}${what ? ` ${what.slice(0, 80)}` : ''}`;
}

// Decides the cards that are pending NOW for those sessions. The ids are taken
// again here, not from the confirmation: a card that arrived after he said yes
// is not one he agreed to, so it is left for him.
function decide(ids, decision) {
    if (decision !== 'approve' && decision !== 'deny') throw new Error('decision must be approve or deny');
    const q = deps.queue ? deps.queue() : null;
    if (!q) return [];
    const done = [];
    for (const id of ids || []) {
        const p = q.get(id);
        if (!p || p.status !== 'pending' || p.decision) continue;
        p.decision = decision;
        p.decidedAt = Date.now();
        done.push(p);
    }
    return done;
}

module.exports = { configure, pending, decide, describe };
