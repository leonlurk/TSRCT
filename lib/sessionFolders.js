'use strict';
// ── Where each session lived, after it is gone ──────────────────────────────
//
// 2026-10-14: fifteen sessions closed together at 17:01, he showed Tesla a
// screenshot of them and asked to reopen them "en sus directorios". Nothing in
// TSRCT knew which folder "trw-diana" or "kara-bva" had been in: Claude Code
// deletes ~/.claude/sessions/<pid>.json when the process exits, and a session
// name is not a project name. She matched 8 by spelling and gave up on the rest.
//
// So while they are ALIVE, those files are read (each one names its tmux pane,
// its cwd and its conversation id) and the pairing is kept here, on disk, for
// 30 days. Reopening then means: the same name, the same folder, and the same
// conversation (`claude --resume <id>`), not a blank one.
//
// SecretCo is never written: a name or a folder that mentions it is skipped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const FILE = process.env.TSRCT_SESSION_FOLDERS || path.join(__dirname, '..', '.tsrct', 'session-folders.json');
const CLAUDE_SESSIONS = process.env.CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
const KEEP_MS = 30 * 24 * 3600 * 1000;
const MAX = 300;
const EVERY_MS = 60 * 1000;
// Not his work: Tesla's brains, Ro's sessions, runners, Tesla's worker.
const NOT_HIS = /^(tesla-|ro-|run-|hands$)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let lastSnap = 0;

function load() {
    try { const o = JSON.parse(fs.readFileSync(FILE, 'utf8')); return o && typeof o === 'object' ? o : {}; }
    catch { return {}; }
}
function save(map) {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE + '.tmp', JSON.stringify(map, null, 1));
        fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.warn(`[sessionFolders] could not save: ${e.message}`); }
}

function clean(name, cwd) {
    return !!(name && cwd && /^[A-Za-z0-9._@-]{1,64}$/.test(name) && !NOT_HIS.test(name)
        && !restrictedGuard.mentionsRestricted(name) && !restrictedGuard.mentionsRestricted(cwd));
}

// Merge what is alive now. Cheap (a few dozen small JSON files) and throttled,
// so it can ride on a route the page polls. `force` is for tests.
function snapshot({ force } = {}) {
    const now = Date.now();
    if (!force && now - lastSnap < EVERY_MS) return 0;
    lastSnap = now;
    let files = [];
    try { files = fs.readdirSync(CLAUDE_SESSIONS).filter(f => /^\d+\.json$/.test(f)); } catch { return 0; }
    const map = load();
    let seen = 0;
    for (const f of files) {
        let d;
        try { d = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS, f), 'utf8')); } catch { continue; }
        const pid = Number(d && d.pid);
        // A file left behind by a crash is not a live session.
        if (!pid) continue;
        try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') continue; }
        const name = String(d.tmux || '').split(':')[0];
        const cwd = String(d.cwd || '');
        if (!clean(name, cwd)) continue;
        map[name] = { cwd, ...(UUID.test(String(d.sessionId || '')) ? { sessionId: d.sessionId } : {}), at: now };
        seen++;
    }
    audit(map, now);
    const keep = Object.entries(map).filter(([n, v]) => v && now - (v.at || 0) < KEEP_MS && clean(n, v.cwd))
        .sort((a, b) => b[1].at - a[1].at).slice(0, MAX);
    save(Object.fromEntries(keep));
    return seen;
}

// ── the audit log (his ask, 2026-10-14) ─────────────────────────────────────
// "un audit log para recuperar el ultimo estado de mis sesiones, incluso las
// conversaciones, incluso reiniciando la compu". One line per CHANGE (a session
// opened or closed), each carrying the whole live set with folder and
// conversation id, in logs/sessions/YYYY-MM-DD.jsonl (gitignored, 90 days). On
// disk, never stamped with the boot: a reboot is exactly when it is needed.
const AUDIT_DIR = process.env.TSRCT_SESSION_AUDIT || path.join(__dirname, '..', 'logs', 'sessions');
let lastLive = null;
function audit(map, now) {
    const live = Object.entries(map).filter(([, v]) => v.at === now).map(([name, v]) => ({ name, cwd: v.cwd, sessionId: v.sessionId }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const key = live.map(x => x.name + '|' + (x.sessionId || '')).join(',');
    if (lastLive === null) {
        // First look since the server started: compare with the last line on disk.
        const prev = lastLine();
        lastLive = prev ? (prev.live || []).map(x => x.name + '|' + (x.sessionId || '')).join(',') : '';
    }
    if (key === lastLive) return;
    const before = new Set(lastLive.split(',').filter(Boolean).map(s => s.split('|')[0]));
    const after = new Set(live.map(x => x.name));
    lastLive = key;
    const d = new Date(now);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
        fs.appendFileSync(path.join(AUDIT_DIR, `${day}.jsonl`), JSON.stringify({
            at: d.toISOString(),
            opened: [...after].filter(n => !before.has(n)),
            closed: [...before].filter(n => !after.has(n)),
            live,
        }) + '\n');
        for (const f of fs.readdirSync(AUDIT_DIR)) {
            const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
            if (m && now - Date.parse(m[1]) > 90 * 24 * 3600 * 1000) fs.unlinkSync(path.join(AUDIT_DIR, f));
        }
    } catch (e) { console.warn(`[sessionFolders] audit: ${e.message}`); }
}
function lastLine() {
    try {
        const days = fs.readdirSync(AUDIT_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
        for (let i = days.length - 1; i >= 0; i--) {
            const rows = fs.readFileSync(path.join(AUDIT_DIR, days[i]), 'utf8').trim().split('\n').filter(Boolean);
            if (rows.length) return JSON.parse(rows[rows.length - 1]);
        }
    } catch { /* no log yet */ }
    return null;
}

function lookup(name) {
    const v = load()[name];
    return v && clean(name, v.cwd) ? { name, ...v } : null;
}

// The sessions that are NOT open now, newest first. `together` keeps only the
// ones last seen within 15 minutes of the newest of them: what closed in one
// go (a restart, a crash), not every session of the last month.
function closed(liveNames, { together } = {}) {
    const live = new Set(liveNames || []);
    const rows = Object.entries(load()).filter(([n, v]) => !live.has(n) && v && clean(n, v.cwd))
        .map(([name, v]) => ({ name, ...v })).sort((a, b) => b.at - a.at);
    if (!together || !rows.length) return rows;
    return rows.filter(r => rows[0].at - r.at <= 15 * 60 * 1000);
}

module.exports = { snapshot, lookup, closed, lastLine, FILE, AUDIT_DIR, UUID };
