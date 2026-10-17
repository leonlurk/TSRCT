'use strict';
// ── automations.js — everything that runs by itself, in one list ────────────
//
// WHY THIS EXISTS (2026-09-24): nobody had the full list. Things were added in
// TSRCT, WSL cron, systemd, Windows Task Scheduler and Claude Code hooks, and two
// of them were silently broken when the inventory was taken (the Amazon
// keep-alive for three weeks, with its failure written to a file nobody opened).
// The Automations tab reads this module: one card per automation, one switch,
// and the last outcome in a word. A failure nobody sees is what it is built
// against, so a failing or missed job turns red, counts on the tab button, and
// pushes to the phone on the second failure in a row.
//
// Five kinds, each with its own way to switch:
//   job     — a scheduler job (lib/scheduler.js). The four cron jobs moved here
//             so they catch up when the laptop was shut at the appointed minute.
//   loop    — a loop inside this server. Paused state is kept on disk, so a
//             paused loop stays paused after a restart.
//   service — a systemd --user unit (`enable --now` / `disable --now`). System
//             units need sudo, so they are shown and not switched.
//   wintask — a Windows Task Scheduler task, through schtasks.exe (argv only;
//             never PowerShell -EncodedCommand, which Defender quarantined).
//   hook    — a Claude Code hook. SHOWN, NEVER SWITCHED: turning off the SecretCo
//             guard or the permission hook from a tap is not a risk worth a
//             convenience. Change them in ~/.claude/settings.json by hand.
//
// Every text that leaves here goes through the SecretCo check: a job's last lines
// (meeting names, for one) could name a Bedrock-only project.

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const { execFile } = require('child_process');
const restrictedGuard = require('./dispatcher/restrictedGuard');
const shellJob = require('./shellJob');
const { stateFile } = require('./stateFile');

const STATE_FILE = process.env.AUTOMATIONS_STATE_FILE || stateFile('automations.json', '.tsrct-automations.json');
const PROJECTS = paths.PROJECTS_ROOT;
const TSRCT_DIR = path.join(__dirname, '..');
const SCHTASKS = '/mnt/c/Windows/System32/schtasks.exe';
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

const GROUPS = [
    { id: 'work', title: 'Work' },
    { id: 'upkeep', title: 'Upkeep' },
    { id: 'content', title: 'Content' },
    { id: 'machine', title: 'Machine' },
    { id: 'hooks', title: 'Claude Code hooks' },
];

let deps = { scheduler: null, loops: {}, notify: null };

// ── persisted pause state for loops ─────────────────────────────────────────
function loadState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (s && typeof s === 'object' && s.paused && typeof s.paused === 'object') return s;
    } catch { /* first run */ }
    return { paused: {} };
}
function saveState(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { console.error('[automations] could not write state:', e.message); }
}
function isPaused(id) { return !!loadState().paused[id]; }
function setPaused(id, on) {
    const s = loadState();
    if (on) s.paused[id] = Date.now(); else delete s.paused[id];
    saveState(s);
}

// ── small helpers ───────────────────────────────────────────────────────────
function clean(text) {
    const t = String(text == null ? '' : text).slice(0, 240);
    return restrictedGuard.mentionsRestricted(t) ? '[hidden: mentions a Bedrock-only project]' : t;
}

function run(cmd, args, timeoutMs = 8000) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, encoding: 'buffer', windowsHide: true }, (err, stdout, stderr) => {
            resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: stdout || Buffer.alloc(0), err: String(stderr || (err && err.message) || '') });
        });
    });
}

function readTail(file, bytes = 4096) {
    try {
        const st = fs.statSync(file);
        const fd = fs.openSync(file, 'r');
        const len = Math.min(bytes, st.size);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        return buf.toString('utf8');
    } catch { return ''; }
}

function mtime(file) {
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// ── jobs that run a script ──────────────────────────────────────────────────
// Each `judge` turns a finished script into an outcome: return { summary, warn }
// or throw with the one sentence that says what went wrong. Times are LOCAL
// (TZ is set in .env). Add your own here: name, title, when, the script, a judge.
const AUDIT_LOG = path.join(TSRCT_DIR, 'logs', 'security-audit.log');

const SCRIPT_JOBS = [
    {
        name: 'security-audit',
        title: 'Security audit',
        blurb: 'Checks TSRCT for known security holes every Monday.',
        group: 'upkeep', at: '10:00', days: [1], window: 144,
        file: path.join(TSRCT_DIR, 'scripts', 'weekly-audit.sh'),
        timeoutMs: 5 * 60 * 1000,
        judge(r) {
            const line = readTail(AUDIT_LOG, 2048).split('\n').reverse()
                .find(l => /\] \[[*!]\]/.test(l));
            if (!line) throw new Error(r.code === 0 ? 'no result written' : `script exited ${r.code}`);
            const body = line.replace(/^\[[^\]]+\]\s*/, '');
            const vuln = /\[!\]\s*(\d+)/.exec(body);
            const outdated = /outdated direct deps:\s*(\d+)/.exec(body);
            if (vuln) return { summary: `${vuln[1]} security problem(s) found`, warn: true };
            return { summary: `No security problems${outdated && outdated[1] !== '0' ? ` · ${outdated[1]} updates waiting` : ''}` };
        },
        lastRunGuess() {
            const line = readTail(AUDIT_LOG, 2048).split('\n').reverse().find(l => /\] \[[*!]\]/.test(l));
            const m = line && /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/.exec(line);
            // weekly-audit.sh stamps with `date` under cron, which ran in UTC.
            return m ? Date.parse(m[1].replace(' ', 'T') + 'Z') : 0;
        },
    },
];

// Exclusive groups with a run in progress (see `exclusive` on a job).
const busyGroups = new Set();

function registerJobs(scheduler) {
    for (const j of SCRIPT_JOBS) {
        scheduler.register({
            name: j.name, at: j.at, days: j.days, window: j.window,
            description: j.blurb, enabled: j.enabled !== false,
            run: async () => {
                if (!fs.existsSync(j.file)) throw new Error('script not found: ' + path.basename(j.file));
                // The run already going covers this one, so a skip is not a failure.
                if (j.exclusive && busyGroups.has(j.exclusive)) return { summary: 'Skipped, another run was already going' };
                if (j.exclusive) busyGroups.add(j.exclusive);
                try {
                    const startedAt = Date.now();
                    const r = await shellJob.runScript({ file: j.file, cwd: path.dirname(j.file), timeoutMs: j.timeoutMs });
                    if (r.timedOut) throw new Error(`stopped after ${Math.round(j.timeoutMs / 60000)} min without finishing`);
                    if (r.error) throw new Error(r.error);
                    return j.judge(r, startedAt);
                } finally {
                    if (j.exclusive) busyGroups.delete(j.exclusive);
                }
            },
        });
        // What cron already ran is not run again on the first boot after the move.
        // Its judge reads the same log, so the card starts with that run's outcome.
        try {
            const last = j.lastRunGuess();
            if (last) {
                let outcome;
                try { const r = j.judge({ code: 0, tail: '' }); outcome = { ok: true, text: r.summary, warn: !!r.warn }; }
                catch (e) { outcome = { ok: false, text: e.message }; }
                scheduler.seed(j.name, last, outcome);
            }
        } catch { /* no history: it simply runs when owed */ }
    }
}

// ── the catalogue ───────────────────────────────────────────────────────────
// Names and one-line blurbs are written for Leon, not for a developer.
const ITEMS = [
    { id: 'morning-routine', kind: 'job', group: 'work', title: 'Morning routine', costly: true,
      blurb: 'Reads ClickUp, Slack, mail and calendar at dawn, writes the brief and opens the sessions for the day. Spends Claude tokens.' },
    { id: 'clickup-sync', kind: 'loop', group: 'work', title: 'ClickUp sync', every: 'every 5 min',
      blurb: 'Brings your assigned ClickUp tasks into the Tasks tab.' },
    { id: 'analyst', kind: 'loop', group: 'work', title: 'Claude job runner', every: 'checks every 8 s',
      blurb: 'Runs the jobs other buttons ask for (hours estimate, worklogs, Clients). Uses Claude only when one is asked for.' },
    { id: 'presence', kind: 'loop', group: 'work', title: 'Presence for hours', every: 'every 30 s',
      blurb: 'Notes the minutes your mouse/keyboard or a TSRCT window shows you are there, so supervising an automatic run counts in Hours Recall. Records minutes only.' },
    { id: 'session-log', kind: 'loop', group: 'work', title: 'Session memory', every: 'every 60 s',
      blurb: 'Remembers each session\'s name, folder and conversation (logs/sessions/), so Tesla can reopen them as they were after a crash or a reboot.' },
    { id: 'pv-card-watch', kind: 'loop', group: 'work', title: 'PV card-testing watch', every: 'every 30 min',
      blurb: 'Checks the Verde Soap store for a burst of abandoned checkouts (card testing). Alerts land in Notifs and on the phone.' },
    { id: 'security-audit', kind: 'job', group: 'upkeep' },
    { id: 'codemap', kind: 'loop', group: 'upkeep', title: 'Codemap autopilot', every: 'every 5 min',
      blurb: 'Keeps each session\'s code map fresh so Claude finds code faster.' },
    { id: 'syften', kind: 'loop', group: 'content', title: 'Brand mentions', every: 'every 60 s',
      blurb: 'Watches Syften for new mentions of the brands.' },
    { id: 'syften-daily', kind: 'loop', group: 'content', title: 'Daily mentions read', every: 'once a day',
      blurb: 'Once a day, picks the mentions worth answering. Spends Claude tokens.' },
    { id: 'factory', kind: 'loop', group: 'content', title: 'Factory watcher', every: 'every few min',
      blurb: 'Follows the software factory runs and shows them in Notifs.' },
    { id: 'session-monitor', kind: 'loop', group: 'machine', title: 'Session watcher', every: 'every 10 s', core: true,
      blurb: 'Tells which sessions are working or waiting for you. Off means the session dots stop updating.' },
    { id: 'ntfy', kind: 'service', group: 'machine', title: 'Phone alerts', unit: 'ntfy', user: true, core: true,
      blurb: 'The server that makes your phone ring. Off means no phone alerts at all.' },
    { id: 'ollama', kind: 'service', group: 'machine', title: 'Local model (Ollama)', unit: 'ollama', user: false,
      blurb: 'Runs the local voice model. Needs your admin password to switch, so it is shown only.' },
];

const JOB_BY_NAME = Object.fromEntries(SCRIPT_JOBS.map(j => [j.name, j]));

// The words he would use out loud, accent-free and lower case (lib/understand.js
// flattens what he says the same way). Most specific first: "lectura diaria de
// menciones" must not be read as the mentions poller.
const SPOKEN = [
    ['syften-daily', /\b(lectura diaria|menciones diarias|resumen de menciones)\b/],
    ['syften', /\b(syften|menciones|mentions)\b/],
    ['morning-routine', /\b(rutina( de la mani?ana)?|morning)\b/],
    ['clickup-sync', /\b(clickup|click up|sincronizacion)\b/],
    ['analyst', /\b(analista|analyst|job runner|corredor de trabajos)\b/],
    ['pv-card-watch', /\b(card testing|tarjetas|fraude|vigilante de (la )?tienda|shopify)\b/],
    ['security-audit', /\b(auditoria|seguridad|audit)\b/],
    ['codemap', /\b(codemap|code map|mapa de codigo|mapas)\b/],
    ['factory', /\b(factory|fabrica)\b/],
    ['session-monitor', /\b(vigilante|monitor de sesiones|session monitor|watcher)\b/],
    ['ntfy', /\b(ntfy|alertas del telefono|alertas al telefono|notificaciones del telefono)\b/],
];
function spokenId(text) {
    const t = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const hit = SPOKEN.find(([, re]) => re.test(t));
    return hit ? hit[0] : null;
}
// Everything the voice may switch: not hooks, not system services.
function switchable() {
    return ITEMS.filter(i => i.kind !== 'service' || i.user).map(i => ({ id: i.id, title: i.title || (JOB_BY_NAME[i.id] || {}).title || i.id }));
}

// Friendly names for the hooks, keyed by script file name.
const HOOK_NAMES = {
    'permission-hook.sh': ['Permission requests to TSRCT', 'Sends every approval request to TSRCT so you can answer from here.'],
    'notify.sh': ['Session activity to TSRCT', 'Tells TSRCT when a session edits, runs, stops or waits.'],
    'secretco-guard.sh': ['SecretCo guard', 'Blocks SecretCo content from leaving through the public API.'],
    'orchestrate-guard.sh': ['Team token guard', 'Keeps orchestrated session teams from wasting tokens.'],
    'aws-declare-watch.sh': ['AWS change watcher', 'Notices changes to the AWS estate.'],
    'aws-declare-remind.sh': ['AWS publish reminder', 'Reminds to publish AWS changes to the ACME registry.'],
    'ps-billy-watch.sh': ['Billy change watcher', 'Notices changes to the Probill package.'],
    'ps-billy-remind.sh': ['Billy check reminder', 'Reminds to check Billy after Probill changes.'],
    'session-weight.sh': ['Session size meter', 'Measures how big each session got.'],
    'plain-brief-check.sh': ['Plain answer check', 'Stops answers that break the plain-brief rules.'],
    'plain-brief-gate.sh': ['Plain answer gate', 'Adds the plain-brief rules to every message.'],
};

function readHooks() {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch { return []; }
    const byFile = new Map();
    for (const [event, arr] of Object.entries(cfg.hooks || {})) {
        for (const m of arr || []) {
            for (const h of m.hooks || []) {
                const cmd = String(h.command || '');
                const file = (/([\w.-]+\.sh)/.exec(cmd) || [])[1] || cmd.slice(0, 40);
                if (!byFile.has(file)) byFile.set(file, new Set());
                byFile.get(file).add(event);
            }
        }
    }
    return Array.from(byFile.entries()).map(([file, events]) => {
        const [title, blurb] = HOOK_NAMES[file] || [file, 'A Claude Code hook.'];
        return {
            id: 'hook:' + file, kind: 'hook', group: 'hooks', title, blurb: clean(blurb),
            on: true, canToggle: false, canRun: false, locked: true,
            state: 'ok', line: 'Runs ' + Array.from(events).map(hookWhen).join(', '),
        };
    });
}
function hookWhen(ev) {
    return ({ PreToolUse: 'before tools', PermissionRequest: 'on each approval', Notification: 'on alerts',
        Stop: 'when a turn ends', SubagentStop: 'when a helper ends', UserPromptSubmit: 'on each message' })[ev] || ev;
}

// ── external state, cached (schtasks.exe takes ~0.5 s through WSL interop) ────
const cache = new Map();   // key -> { at, value }
async function cached(key, ttlMs, fn) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttlMs) return c.value;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
}

async function serviceState(unit, user) {
    return cached('svc:' + unit, 30000, async () => {
        const base = user ? ['--user'] : [];
        const a = await run('systemctl', [...base, 'is-active', unit]);
        const e = await run('systemctl', [...base, 'is-enabled', unit]);
        return { active: a.out.toString().trim(), enabled: e.out.toString().trim() };
    });
}

// Columns of `schtasks /Query /V /FO CSV` by position, because the headers are
// in the Windows display language (Spanish here): 2 next run, 3 status,
// 5 last run, 6 last result, 11 enabled/disabled.
function parseCsvLine(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') q = false;
            else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out;
}

// dd/mm/yyyy hh:mm:ss (the machine's locale) -> ms, or 0 for "N/A" / never.
function parseWinDate(s) {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(String(s || ''));
    if (!m) return 0;
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
    // 30/11/1999 is what Windows prints for "never ran".
    return d.getFullYear() < 2000 ? 0 : d.getTime();
}

async function winTaskState(task) {
    return cached('win:' + task, 5 * 60 * 1000, async () => {
        if (!fs.existsSync(SCHTASKS)) return { error: 'Windows is not reachable from here' };
        const r = await run(SCHTASKS, ['/Query', '/TN', task, '/V', '/FO', 'CSV'], 15000);
        if (!r.ok) return { error: 'task not found' };
        // Console output is in the OEM code page; the fields read here are
        // digits, dates and a word we only compare against, so latin1 is enough.
        const rows = r.out.toString('latin1').split(/\r?\n/).filter(Boolean);
        if (rows.length < 2) return { error: 'no answer from Windows' };
        const f = parseCsvLine(rows[1]);
        const enabledWord = String(f[11] || '');
        return {
            enabled: !/deshabilit|disabled/i.test(enabledWord),
            running: /ejecut|running/i.test(String(f[3] || '')),
            nextRun: parseWinDate(f[2]),
            lastRun: parseWinDate(f[5]),
            lastResult: String(f[6] || '').trim(),
        };
    });
}

// ── building a card ─────────────────────────────────────────────────────────
function scheduleText(days, at) {
    const NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    if (!days || !days.length) return `Every day ${at}`;
    return `${days.map(d => NAMES[d]).join(', ')} ${at}`;
}

function jobCard(item) {
    const sch = deps.scheduler;
    const v = sch && sch.view(item.id);
    const def = JOB_BY_NAME[item.id] || {};
    if (!v) return { ...base(item, def), on: null, state: 'fail', line: 'Not loaded in this server', canToggle: false, canRun: false };
    let state = 'idle';
    if (v.running) state = 'running';
    else if (!v.enabled) state = 'off';
    else if (v.lastOk === false) state = 'fail';
    else if (v.missedDay) state = 'fail';
    else if (v.lastWarn) state = 'warn';
    else if (v.lastOk === true) state = 'ok';
    return {
        ...base(item, def),
        on: v.enabled, canToggle: true, canRun: !v.running, costly: !!(item.costly || def.costly),
        state,
        running: v.running,
        lastRun: v.lastRun || 0,
        nextRun: v.enabled ? v.nextDue : 0,
        schedule: scheduleText(v.days, v.at),
        at: v.at,
        editableTime: true,
        missed: v.missedDay || '',
        failStreak: v.failStreak || 0,
        result: clean(v.lastOk === false ? v.lastError : v.lastSummary),
        history: (v.history || []).map(h => ({ ...h, text: clean(h.text) })),
    };
}

function base(item, def) {
    return {
        id: item.id, kind: item.kind, group: item.group,
        title: item.title || def.title || item.id,
        blurb: clean(item.blurb || def.blurb || ''),
        core: !!item.core,
    };
}

function loopCard(item) {
    const L = deps.loops[item.id];
    if (!L) return { ...base(item, {}), on: null, state: 'off', line: 'Not available in this server', canToggle: false, canRun: false };
    let st = {};
    try { st = (L.status && L.status()) || {}; } catch (e) { st = { error: e.message }; }
    const on = typeof L.isOn === 'function' ? !!L.isOn() : !isPaused(item.id);
    let state = on ? 'ok' : 'off';
    if (on && st.error) state = 'fail';
    else if (on && st.warn) state = 'warn';
    return {
        ...base(item, {}),
        on, canToggle: !st.cannotToggle, canRun: on && typeof L.runNow === 'function',
        state,
        lastRun: st.lastRun || 0,
        schedule: item.every || '',
        result: clean(st.error || st.warn || st.summary || ''),
    };
}

async function serviceCard(item) {
    const s = await serviceState(item.unit, item.user);
    const on = s.active === 'active';
    return {
        ...base(item, {}),
        on, canToggle: !!item.user, canRun: false, locked: !item.user,
        state: on ? 'ok' : (s.enabled === 'enabled' ? 'fail' : 'off'),
        schedule: s.enabled === 'enabled' ? 'Starts with the machine' : 'Does not start with the machine',
        result: on ? 'Running' : (s.enabled === 'enabled' ? 'Should be running but is stopped' : 'Stopped'),
    };
}

async function winTaskCard(item) {
    const t = await winTaskState(item.task);
    if (t.error) return { ...base(item, {}), on: null, state: 'fail', canToggle: false, canRun: false, result: t.error };
    const okResult = t.lastResult === '0' || t.lastResult === '';
    let state = !t.enabled ? 'off' : t.running ? 'running' : !t.lastRun ? 'idle' : okResult ? 'ok' : 'fail';
    return {
        ...base(item, {}),
        on: t.enabled, canToggle: true, canRun: !t.running,
        state, running: t.running,
        lastRun: t.lastRun, nextRun: t.enabled ? t.nextRun : 0,
        schedule: 'Weekly (Windows)',
        result: !t.lastRun ? 'Never ran' : okResult ? 'Finished OK' : `Windows reported error ${t.lastResult}`,
    };
}

async function card(item) {
    try {
        if (item.kind === 'job') return jobCard(item);
        if (item.kind === 'loop') return loopCard(item);
        if (item.kind === 'service') return await serviceCard(item);
        if (item.kind === 'wintask') return await winTaskCard(item);
    } catch (e) {
        return { ...base(item, {}), on: null, state: 'fail', canToggle: false, canRun: false, result: clean(e.message) };
    }
    return null;
}

async function list() {
    const cards = (await Promise.all(ITEMS.map(card))).filter(Boolean).concat(readHooks());
    const groups = GROUPS.map(g => ({ ...g, items: cards.filter(c => c.group === g.id) })).filter(g => g.items.length);
    const alerts = cards.filter(c => c.state === 'fail').length;
    return { groups, alerts, at: Date.now() };
}

// Cheap version for the tab button's red number: no systemctl, no Windows.
function alertCount() {
    let n = 0;
    for (const item of ITEMS) {
        try {
            if (item.kind === 'job' && jobCard(item).state === 'fail') n++;
            else if (item.kind === 'loop' && loopCard(item).state === 'fail') n++;
        } catch { /* a broken card is not an alert source */ }
    }
    for (const k of cache.keys()) {
        const v = cache.get(k).value;
        if (k.startsWith('svc:') && v && v.active !== 'active' && v.enabled === 'enabled') n++;
        if (k.startsWith('win:') && v && v.enabled && v.lastRun && v.lastResult && v.lastResult !== '0') n++;
    }
    return n;
}

function find(id) { return ITEMS.find(i => i.id === id); }

// ── actions ─────────────────────────────────────────────────────────────────
async function setEnabled(id, on) {
    const item = find(id);
    if (!item) return { ok: false, error: 'unknown automation' };
    on = !!on;
    if (item.kind === 'job') {
        const r = deps.scheduler.setEnabled(id, on);
        if (!r.ok) return r;
    } else if (item.kind === 'loop') {
        const L = deps.loops[id];
        if (!L) return { ok: false, error: 'not available in this server' };
        if (typeof L.setOn === 'function') {
            const r = await L.setOn(on);
            if (r && r.ok === false) return r;
        } else {
            setPaused(id, !on);
            try { on ? L.start() : L.stop(); } catch (e) { return { ok: false, error: e.message }; }
        }
    } else if (item.kind === 'service') {
        if (!item.user) return { ok: false, error: 'needs your admin password; switch it from a terminal' };
        const r = await run('systemctl', ['--user', on ? 'enable' : 'disable', '--now', item.unit], 20000);
        cache.delete('svc:' + item.unit);
        if (!r.ok) return { ok: false, error: clean(r.err.trim().split('\n').pop() || 'systemctl failed') };
    } else if (item.kind === 'wintask') {
        const r = await run(SCHTASKS, ['/Change', '/TN', item.task, on ? '/ENABLE' : '/DISABLE'], 15000);
        cache.delete('win:' + item.task);
        if (!r.ok) return { ok: false, error: 'Windows refused the change' };
    } else {
        return { ok: false, error: 'this one is shown only' };
    }
    return { ok: true, item: await card(item) };
}

async function runNow(id) {
    const item = find(id);
    if (!item) return { ok: false, error: 'unknown automation' };
    if (item.kind === 'job') {
        const v = deps.scheduler.view(id);
        if (!v) return { ok: false, error: 'not loaded in this server' };
        if (v.running) return { ok: false, error: 'already running' };
        const def = JOB_BY_NAME[id];
        if (def && def.exclusive && busyGroups.has(def.exclusive)) return { ok: false, error: 'another run of this is already going' };
        setImmediate(() => deps.scheduler.runJob(id, { manual: true })
            .catch(e => console.error(`[automations] ${id} failed:`, e.message)));
        return { ok: true, started: true };
    }
    if (item.kind === 'loop') {
        const L = deps.loops[id];
        if (!L || typeof L.runNow !== 'function') return { ok: false, error: 'this one cannot be run by hand' };
        setImmediate(() => Promise.resolve().then(() => L.runNow()).catch(e => console.error(`[automations] ${id}:`, e.message)));
        return { ok: true, started: true };
    }
    if (item.kind === 'wintask') {
        const r = await run(SCHTASKS, ['/Run', '/TN', item.task], 15000);
        cache.delete('win:' + item.task);
        return r.ok ? { ok: true, started: true } : { ok: false, error: 'Windows refused to start it' };
    }
    return { ok: false, error: 'this one cannot be run by hand' };
}

async function setTime(id, at) {
    const item = find(id);
    if (!item || item.kind !== 'job') return { ok: false, error: 'only scheduled jobs have a time' };
    const r = deps.scheduler.setTime(id, at);
    return r.ok ? { ok: true, item: await card(item) } : r;
}

// A loop is started at boot only if it was not paused from the tab.
function bootLoop(id, startFn) {
    if (isPaused(id)) {
        console.log(`[automations] ${id} is paused (Automations tab) - not started`);
        return false;
    }
    startFn();
    return true;
}

// ── wiring ──────────────────────────────────────────────────────────────────
function titleOf(name) {
    const item = find(name);
    return (item && item.title) || (JOB_BY_NAME[name] && JOB_BY_NAME[name].title) || name;
}

function configure({ scheduler, loops, notify } = {}) {
    if (scheduler) deps.scheduler = scheduler;
    if (loops) deps.loops = { ...deps.loops, ...loops };
    if (notify) deps.notify = notify;
    if (scheduler) {
        // The second failure in a row reaches the phone; the first only turns
        // the card red (one bad network moment is not worth a buzz).
        scheduler.setOnFinished((name, v) => {
            if (!v || v.lastOk !== false || v.failStreak !== 2 || !deps.notify) return;
            deps.notify({ id: name, title: `${titleOf(name)} failed twice`, body: clean(v.lastError) });
        });
        scheduler.setOnMissed((name, day) => {
            if (!deps.notify) return;
            deps.notify({ id: name, title: `${titleOf(name)} missed its run`, body: `It was due ${day} and TSRCT was not running in time.` });
        });
    }
}

module.exports = {
    configure, registerJobs, bootLoop, list, alertCount, setEnabled, runNow, setTime,
    spokenId, switchable, SPOKEN,
    // for checks
    ITEMS, SCRIPT_JOBS, GROUPS, parseCsvLine, parseWinDate, isPaused, setPaused, clean, readHooks, STATE_FILE,
};
