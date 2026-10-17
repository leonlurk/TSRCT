'use strict';
// ── stallWatch.js — catch the moments the server stops answering ────────────
//
// WHY (2026-10-08). Leon: TSRCT "se tilda de vez en cuando y tengo que esperar".
// Node answers every request on one thread, and server.js runs ~60 child
// processes SYNCHRONOUSLY (execSync / execFileSync / spawnSync: tmux, git, ...).
// While one of those runs, nothing else is answered: every window, every poll.
// A git call on /mnt/c or a tmux call while WSL is busy can take seconds.
//
// What this does, and nothing more:
//   1. wraps the three sync functions of child_process so any call slower than
//      SLOW_CALL_MS is remembered (the program and its first argument only:
//      never the rest of argv, which can carry a prompt or pane text);
//   2. a 250 ms timer measures how late it fires; late by more than STALL_MS
//      means the thread was blocked, and the stall is written to
//      logs/stalls.jsonl with the request being handled and the slow calls
//      seen during the gap.
// It must be required BEFORE anything destructures child_process (server.js
// line 12 does), or that copy keeps the unwrapped functions.
//
// Read it back with: node scripts/stalls.js

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const STALL_MS = Number(process.env.STALL_MS || 1000);
const SLOW_CALL_MS = Number(process.env.STALL_SLOW_CALL_MS || 300);
const TICK_MS = 250;
const LOG = path.join(__dirname, '..', 'logs', 'stalls.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;

let current = null;          // { method, path, t } of the request being handled
let slowCalls = [];          // slow sync calls since the last tick

function label(file, args) {
    // execSync gets one shell string; the others get (file, argv).
    if (Array.isArray(args)) return [String(file), args[0] != null ? String(args[0]) : ''].join(' ').trim().slice(0, 60);
    return String(file).trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 60);
}

function wrap(name) {
    const orig = cp[name];
    if (typeof orig !== 'function' || orig.__stallWrapped) return;
    const wrapped = function (file, args) {
        const t0 = Date.now();
        try {
            return orig.apply(this, arguments);
        } finally {
            const ms = Date.now() - t0;
            if (ms >= SLOW_CALL_MS) {
                slowCalls.push({ fn: name, cmd: label(file, Array.isArray(args) ? args : undefined), ms,
                    req: current ? current.path : null });
            }
        }
    };
    wrapped.__stallWrapped = true;
    cp[name] = wrapped;
}
['execSync', 'execFileSync', 'spawnSync'].forEach(wrap);

function write(entry) {
    try {
        fs.mkdirSync(path.dirname(LOG), { recursive: true });
        try { if (fs.statSync(LOG).size > MAX_BYTES) fs.renameSync(LOG, LOG + '.prev'); } catch (e) {}
        fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
    } catch (e) { /* a watch must never be the thing that breaks */ }
}

let last = Date.now();
const timer = setInterval(() => {
    const now = Date.now();
    const late = now - last - TICK_MS;
    last = now;
    const calls = slowCalls;
    slowCalls = [];
    if (late < STALL_MS) return;
    const entry = {
        at: new Date(now).toISOString(),
        stalledMs: late,
        req: current ? `${current.method} ${current.path}` : null,
        calls: calls.sort((a, b) => b.ms - a.ms).slice(0, 5),
    };
    write(entry);
    console.log(`[STALL] ${late}ms` + (entry.calls[0] ? ` - ${entry.calls[0].cmd} ${entry.calls[0].ms}ms` : '')
        + (entry.req ? ` during ${entry.req}` : ''));
}, TICK_MS);
timer.unref();

// server.js calls this at the top of its request handler.
function noteRequest(method, p) { current = { method, path: String(p || '').slice(0, 80), t: Date.now() }; }

module.exports = { noteRequest, LOG, _label: label };
