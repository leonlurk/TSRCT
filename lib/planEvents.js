'use strict';
// ── planEvents.js — what the plan machinery did, for the command center ─────
//
// Phase 5 (2026-10-25): Tesla's full screen shows, live, what she is doing with
// his plan: a step sent to a session, a step proven done, a stop and why, a
// permission the plan's list approved. The tracker and the pilot each push one
// line here; the center reads the newest. In memory only (the plan itself, on
// disk, is the record); a restart starts the feed empty. Never SecretCo.

const restrictedGuard = require('./dispatcher/restrictedGuard');

const MAX = 60;
const rows = [];
let seq = 0;

// kind: sent | done | blocked | nudged | allowed | asked | finished
function push(kind, text, session) {
    const t = String(text || '').replace(/\s+/g, ' ').slice(0, 240);
    if (!t || restrictedGuard.mentionsRestricted(t) || restrictedGuard.mentionsRestricted(session || '')) return null;
    const row = { id: ++seq, at: Date.now(), kind: String(kind || 'note'), text: t, session: String(session || '') };
    rows.push(row);
    if (rows.length > MAX) rows.splice(0, rows.length - MAX);
    return row;
}

function since(id = 0) { return rows.filter(r => r.id > Number(id || 0)); }
function recent(n = 20) { return rows.slice(-n).reverse(); }

module.exports = { push, since, recent };
