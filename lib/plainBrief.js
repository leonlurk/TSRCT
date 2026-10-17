'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// lib/plainBrief.js — which tmux sessions are under the [PB] plain-brief rules.
//
// The toggle is the whole feature, so the file it writes is the contract. Two
// very different readers share it:
//
//   1. TSRCT (this server), which flips it from the mobile status bar or the PC
//      status row.
//   2. Two Claude Code hooks (`~/.claude/hooks/plain-brief-{gate,check}.sh`),
//      which read it directly off disk — no HTTP, no token, no dependency on
//      this server being up. That is deliberate: the enforcement must keep
//      working while TSRCT is restarting, and a gate that quietly stops gating
//      is worse than no gate.
//
// DURABLE ON DISK, not in `lib/dispatcher/db.js` — that drops its tables on every
// boot, and a rule Leon switched on should not switch itself off when the server
// restarts. Same call as `data/handson-plans.json` and `data/syften-items.json`.
//
// Standalone: a failure in here must not take anything else down, so every entry
// point returns a value and never throws at a caller.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, '..', 'data', 'plain-brief.json');

const DEFAULT_CAP = 70;      // words, for an ordinary answer
const DEFAULT_DETAIL_CAP = 200;  // words, when he explicitly asked for detail
const MIN_CAP = 20;
const MAX_CAP = 1000;
const MAX_SESSIONS = 200;    // a name is ~20 bytes; this is a sanity bound, not a policy

let state = null;

function blank() {
    return { sessions: {}, detailCap: DEFAULT_DETAIL_CAP };
}

function load() {
    if (state) return state;
    try {
        const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
        state = (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object')
            ? { sessions: raw.sessions, detailCap: clampCap(raw.detailCap, DEFAULT_DETAIL_CAP) }
            : blank();
    } catch {
        state = blank();   // absent or corrupt both mean "nobody has turned it on"
    }
    return state;
}

function save() {
    try {
        fs.mkdirSync(path.dirname(STORE), { recursive: true });
        // tmp + rename: the hooks read this file on every prompt and every turn
        // end, so a torn write would be read as "off" and silently drop the rule
        // mid-session.
        const tmp = STORE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, STORE);
        return true;
    } catch (e) {
        console.error('[plainbrief] save failed:', e.message);
        return false;
    }
}

function clampCap(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(MAX_CAP, Math.max(MIN_CAP, Math.round(n)));
}

function safeName(s) {
    // tmux session names only. Anything else is not a session and must not be
    // able to create a key here.
    const n = String(s || '').trim();
    return /^[A-Za-z0-9._-]{1,64}$/.test(n) ? n : '';
}

// ── public ───────────────────────────────────────────────────────────────────

function getState() {
    const s = load();
    return { sessions: s.sessions, detailCap: s.detailCap, defaultCap: DEFAULT_CAP };
}

function isOn(session) {
    const name = safeName(session);
    if (!name) return false;
    const e = load().sessions[name];
    return !!(e && e.on);
}

function get(session) {
    const name = safeName(session);
    if (!name) return { session: '', on: false, cap: DEFAULT_CAP };
    const e = load().sessions[name] || {};
    return { session: name, on: !!e.on, cap: clampCap(e.cap, DEFAULT_CAP) };
}

// on=true stores the session, on=false DELETES it. Keeping an `{on:false}` row
// around would grow the file forever with sessions that no longer exist and make
// "is it on?" two questions instead of one.
function set(session, on, cap) {
    const name = safeName(session);
    if (!name) return { ok: false, error: 'invalid session name' };
    const s = load();
    if (on) {
        if (!s.sessions[name] && Object.keys(s.sessions).length >= MAX_SESSIONS) {
            return { ok: false, error: 'too many sessions tracked' };
        }
        s.sessions[name] = { on: true, cap: clampCap(cap, (s.sessions[name] || {}).cap || DEFAULT_CAP) };
    } else {
        delete s.sessions[name];
    }
    save();
    return { ok: true, ...get(name) };
}

function toggle(session, cap) {
    return set(session, !isOn(session), cap);
}

// Drop rows for tmux sessions that no longer exist. Called with the live list so
// this module never has to shell out itself.
function prune(liveSessions) {
    const live = new Set((liveSessions || []).map(safeName).filter(Boolean));
    const s = load();
    let removed = 0;
    for (const name of Object.keys(s.sessions)) {
        if (!live.has(name)) { delete s.sessions[name]; removed++; }
    }
    if (removed) save();
    return removed;
}

module.exports = { getState, isOn, get, set, toggle, prune, STORE, DEFAULT_CAP };
