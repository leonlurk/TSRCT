// ─────────────────────────────────────────────────────────────────────────
// codemapEngine.js — TSRCT control surface for the `repo-map` skill (MAP.md).
//
// PURPOSE: keep every ACTIVE tmux session's MAP.md (a file:line code index)
// fresh and let you ARM a running Claude session to read it first (token saver).
// You don't browse the index — your session does. This engine only:
//   - runs the genmap.js generator against a session's cwd   (argv-exec, no shell)
//   - reads MAP.md's HEADER ONLY for freshness metadata        (counts/age, never code)
//   - injects a short generic "read MAP.md first" directive into a live session
//   - optional auto-pilot: regenerate stale/missing maps on a timer
//
// SECRETCO — fail-closed, defense in depth (the wire NEVER carries code):
//   1. any session whose cwd mentions SecretCo is flagged `secretco:true` and gets NO
//      buttons client-side and is refused here.
//   2. regenerate()/prime() call restrictedGuard.assertNotRestricted(cwd) BEFORE acting.
//   3. genmap.js itself refuses SecretCo paths (exits 2, writes nothing).
//   4. DATA MINIMIZATION: listSessionMaps() returns only counts/age/drift + the
//      project basename — never MAP.md body. So there is no code to leak, and
//      SecretCo sessions never produce a map anyway.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile } = require('child_process');
const restrictedGuard = require('./restrictedGuard');

const GENMAP = path.join(os.homedir(), '.claude', 'skills', 'repo-map', 'genmap.js');
const AUTOPILOT_KEY = 'codemap_autopilot';
const DRIFT_SCAN_CAP = 4000;   // max code files scanned when counting drift
const STALE_DRIFT = 8;         // auto-pilot regenerates a map once this many files drifted
const TICK_MS = 5 * 60 * 1000; // auto-pilot cadence

const IGNORE_DIRS = new Set([
    '.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'out', '.next',
    'vendor', 'coverage', '.cache', 'tmp', 'temp', '.idea', '.vscode',
    'Downloads', 'Descargas', '__pycache__', '.venv', 'venv', '.tsrct',
]);
const CODE_EXT = new Set([
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.htm',
    '.py', '.cls', '.trigger', '.sh', '.bash', '.css', '.json',
]);

// The generic directive injected on [Prime]. Contains NO repo content — safe text.
const PRIME_DIRECTIVE =
    '[CODEMAP] A fresh MAP.md (a file:line index of this repo: functions, classes, ' +
    'window.* exports, onclick handlers and API routes) is at the project root. ' +
    'Before exploring, READ MAP.md FIRST and jump to code by file:line instead of ' +
    'grepping the tree — it saves tokens. The Obsidian vault is the source of *why*; ' +
    'MAP.md is the *where*.';

let _db = null;
let _tmux = null;
let _send = null;
let _serverSession = '';
let _timer = null;

function init({ db, tmux, send, serverSession } = {}) {
    _db = db || null;
    _tmux = tmux || null;
    _send = send || null;
    _serverSession = serverSession || '';
}

function genmapAvailable() {
    try { return fs.existsSync(GENMAP); } catch { return false; }
}

// A session is a USER repo session if it isn't infra (server / runner / headless helper).
function isUserSession(name) {
    if (!name) return false;
    if (name === _serverSession) return false;
    if (name.startsWith('run-')) return false;   // runner mini-terminals
    if (name.startsWith('cc-')) return false;     // cc-tsrct-analyst / cc-prompt-polisher headless
    if (name.startsWith('ro-')) return false;     // ATELIER: las conversaciones de Rocío
    return true;
}

// Read ONLY the MAP.md header (first ~1KB) for counts + the file mtime. Never the body.
function readMapMeta(cwd) {
    const mapPath = path.join(cwd, 'MAP.md');
    let stat;
    try { stat = fs.statSync(mapPath); } catch { return null; }
    let head = '';
    try {
        const fd = fs.openSync(mapPath, 'r');
        const buf = Buffer.alloc(1024);
        const n = fs.readSync(fd, buf, 0, 1024, 0);
        fs.closeSync(fd);
        head = buf.toString('utf8', 0, n);
    } catch { /* keep counts null */ }
    let files = null, symbols = null;
    const m = /Files indexed:\s*(\d+)\s*·\s*Symbols:\s*(\d+)/.exec(head);
    if (m) { files = Number(m[1]); symbols = Number(m[2]); }
    return { files, symbols, mtime: stat.mtimeMs };
}

// Count code files newer than the map (the "N changed since" drift nudge). Bounded.
function driftCount(cwd, mapMtime) {
    if (!mapMtime) return 0;
    let scanned = 0, drift = 0;
    (function walk(dir) {
        if (scanned >= DRIFT_SCAN_CAP) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (scanned >= DRIFT_SCAN_CAP) return;
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (restrictedGuard.mentionsRestricted(full)) continue;
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (IGNORE_DIRS.has(e.name)) continue;
                walk(full);
            } else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (!CODE_EXT.has(ext)) continue;
                if (e.name === 'MAP.md') continue;
                scanned++;
                let st;
                try { st = fs.statSync(full); } catch { continue; }
                if (st.mtimeMs > mapMtime + 1000) drift++;
            }
        }
    })(cwd);
    return drift;
}

function ageLabel(mtime) {
    const ms = Date.now() - mtime;
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const d = Math.floor(hr / 24);
    return d + 'd ago';
}

// Build the full map descriptor for one cwd. METADATA ONLY — no code crosses the wire.
function mapDescriptor(cwd) {
    const meta = readMapMeta(cwd);
    if (!meta) return { exists: false };
    const drift = driftCount(cwd, meta.mtime);
    return {
        exists: true,
        files: meta.files,
        symbols: meta.symbols,
        age: ageLabel(meta.mtime),
        mtime: meta.mtime,
        drift,
        stale: drift >= STALE_DRIFT,
    };
}

// Resolve a session name -> its cwd via the tmux adapter (the source of truth).
function cwdForSession(name) {
    const s = (_tmux && _tmux.listSessions() || []).find(x => x.name === name);
    return s ? s.cwd : null;
}

// PUBLIC: per-active-session map status. The only data the browser ever receives.
function listSessionMaps() {
    const sessions = (_tmux && _tmux.listSessions() || []).filter(s => isUserSession(s.name));
    return sessions.map(s => {
        const cwd = s.cwd || '';
        const secretco = restrictedGuard.mentionsRestricted(cwd, s.name);
        const project = cwd ? path.basename(cwd) : '(no cwd)';
        if (secretco) {
            // SecretCo: locked. Reveal NOTHING about the path — not even the folder name.
            return { name: s.name, project: '[locked]', cwd: '[locked]', attached: !!s.attached, secretco: true, map: null };
        }
        return {
            name: s.name,
            project,
            cwd,
            attached: !!s.attached,
            secretco: false,
            map: mapDescriptor(cwd),
        };
    });
}

// PUBLIC: regenerate MAP.md for a session's repo. SecretCo-guarded (throws RestrictedProjectError).
function regenerate(sessionName) {
    const cwd = cwdForSession(sessionName);
    if (!cwd) throw new Error('Session not found or has no working directory.');
    restrictedGuard.assertNotRestricted('codemap.regenerate', cwd, sessionName);   // layer 2
    if (!genmapAvailable()) throw new Error('repo-map generator not found at ' + GENMAP);
    // argv-exec, no shell. genmap refuses SecretCo itself (layer 3) and writes MAP.md to cwd.
    execFileSync('node', [GENMAP, cwd], {
        encoding: 'utf8',
        timeout: 90000,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return mapDescriptor(cwd);
}

// PUBLIC: arm a live session to use its map. Generic directive only. SecretCo-guarded.
function prime(sessionName, sendFn) {
    const cwd = cwdForSession(sessionName);
    if (!cwd) return { success: false, error: 'Session not found.' };
    restrictedGuard.assertNotRestricted('codemap.prime', cwd, sessionName);
    const send = sendFn || _send;
    if (typeof send !== 'function') return { success: false, error: 'No session-send available.' };
    const r = send(PRIME_DIRECTIVE, sessionName);
    return r && r.success ? { success: true, session: sessionName } : (r || { success: false, error: 'send failed' });
}

function getAutopilot() {
    try { return _db && _db.getConfig(AUTOPILOT_KEY) === '1'; } catch { return false; }
}
function setAutopilot(on) {
    try { _db && _db.setConfig(AUTOPILOT_KEY, on ? '1' : '0'); } catch { /* noop */ }
    return getAutopilot();
}

// Auto-pilot: regenerate maps that are MISSING or STALE for live non-SecretCo sessions.
// Never auto-primes (injecting a prompt could interrupt active work — that stays manual).
//
// ASYNC since 2026-10-08. It used to do all of this synchronously: up to 4000
// statSync per session through /mnt/c, then genmap (timeout 90s) per stale
// session, every 5 minutes. Measured: the whole server stopped answering for
// ~2 minutes at 01:24 and again at 01:29, and TSRCT's MAP.md was rewritten the
// very second the first freeze ended. Now: async file walk, async genmap, one
// tick at a time, each folder once (two sessions in TSRCT regenerated it
// twice), and never a folder that is not a git repo (a session sitting in
// PROJECTS/ itself would map every project on the disk).
let _ticking = false;

async function driftCountAsync(cwd, mapMtime) {
    if (!mapMtime) return 0;
    let scanned = 0, drift = 0;
    async function walk(dir) {
        if (scanned >= DRIFT_SCAN_CAP) return;
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (scanned >= DRIFT_SCAN_CAP) return;
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (restrictedGuard.mentionsRestricted(full)) continue;
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (IGNORE_DIRS.has(e.name)) continue;
                await walk(full);
            } else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (!CODE_EXT.has(ext) || e.name === 'MAP.md') continue;
                scanned++;
                try { if ((await fs.promises.stat(full)).mtimeMs > mapMtime + 1000) drift++; } catch { /* gone */ }
            }
        }
    }
    await walk(cwd);
    return drift;
}

function genmapAsync(cwd) {
    return new Promise((resolve, reject) => {
        execFile('node', [GENMAP, cwd], { encoding: 'utf8', timeout: 90000 },
            err => (err ? reject(err) : resolve()));
    });
}

async function tick() {
    if (_ticking || !getAutopilot()) return;
    _ticking = true;
    try {
        const sessions = (_tmux && _tmux.listSessions() || []).filter(s => isUserSession(s.name));
        const done = new Set();
        for (const s of sessions) {
            const cwd = s.cwd || '';
            if (!cwd || done.has(cwd)) continue;
            done.add(cwd);
            if (restrictedGuard.mentionsRestricted(cwd, s.name)) continue;
            try { await fs.promises.access(path.join(cwd, '.git')); } catch { continue; }
            const meta = readMapMeta(cwd);
            const needs = !meta || (await driftCountAsync(cwd, meta.mtime)) >= STALE_DRIFT;
            if (!needs || !genmapAvailable()) continue;
            try {
                restrictedGuard.assertNotRestricted('codemap.autopilot', cwd, s.name);
                await genmapAsync(cwd);
            } catch { /* SecretCo/throw -> skip silently */ }
        }
    } catch { /* never let the timer die */ }
    finally { _ticking = false; }
}

function start() {
    if (_timer) return;
    _timer = setInterval(tick, TICK_MS);
    if (_timer.unref) _timer.unref();
}
function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
    init, start, stop, tick,
    genmapAvailable, listSessionMaps, regenerate, prime,
    getAutopilot, setAutopilot,
    GENMAP, PRIME_DIRECTIVE,
};
