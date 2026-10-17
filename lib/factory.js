// ─────────────────────────────────────────────────────────────────────────
// factory.js — TSRCT's window into the software factory (personal/factory).
//
// The factory is its own repo and its own CLI; this module never reimplements
// it. It does three things:
//   1. WATCH  — fetch the factory repo's `live` branch (one file the researcher
//              force-pushes while it runs, cloud or local) and hand it to the UI.
//   2. PULL   — when origin/main moves, run `factory pull` so new findings get
//              scored, and turn what changed into in-app events for Notifs.
//   3. ACT    — pick / drop / build / run, each one a `factory <cmd>` child
//              process with argv (never a shell string), ids validated first.
//
// Standalone like syften.js: a failure in here must not take anything else
// down, and nothing else may depend on it having loaded.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { execFile, spawn } = require('child_process');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const DIR = process.env.FACTORY_DIR || path.join(paths.PROJECTS_ROOT, 'factory');
const BIN = path.join(DIR, 'bin', 'factory.js');
const NOTIFIED = path.join(__dirname, '..', 'data', 'factory-notified.json');

// Idle: one fetch a minute is one small network call. Live: a run moves every
// few seconds, but GitHub is the channel, so 15s is honest, not lazy.
const POLL_IDLE_MS = 60 * 1000;
const POLL_LIVE_MS = 15 * 1000;
const LOCAL_RUN_TIMEOUT_MS = 40 * 60 * 1000;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,79}$/;

let state = {
    available: false, dir: DIR,
    live: null, liveFrom: null,
    board: null, runs: [],
    mainSha: null, lastFetch: 0, lastError: null,
    localRun: null, pulling: false, lastPull: null,
};
let addEvent = null;
let timer = null;
let ticking = false;
let notified = { keys: [] };

// ── small helpers ────────────────────────────────────────────────────────
function git(args, timeout) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd: DIR, encoding: 'utf8', timeout: timeout || 20000, maxBuffer: 4 * 1024 * 1024 },
            (e, out, err) => resolve(e ? { ok: false, err: String(err || e.message).trim() } : { ok: true, out: String(out).trim() }));
    });
}

function cli(args, timeout) {
    return new Promise((resolve) => {
        let out = '', err = '', done = false;
        const child = spawn(process.execPath, [BIN, ...args], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
        const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeout || 30000);
        child.stdout.on('data', c => { out += c; });
        child.stderr.on('data', c => { err = (err + c).slice(-4000); });
        child.on('error', e => { if (done) return; done = true; clearTimeout(killer); resolve({ ok: false, code: -1, out, err: e.message }); });
        child.on('close', code => { if (done) return; done = true; clearTimeout(killer); resolve({ ok: code === 0, code, out, err }); });
    });
}

function readJson(fp) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function loadNotified() { notified = readJson(NOTIFIED) || { keys: [] }; if (!Array.isArray(notified.keys)) notified.keys = []; }
function saveNotified() {
    try { fs.mkdirSync(path.dirname(NOTIFIED), { recursive: true }); fs.writeFileSync(NOTIFIED, JSON.stringify({ keys: notified.keys.slice(-2000) })); }
    catch { /* a lost bookkeeping write means one duplicate event, not a broken run */ }
}
function once(key, fn) {
    if (notified.keys.includes(key)) return false;
    notified.keys.push(key); saveNotified();
    try { fn(); } catch { /* never let an event break the poll */ }
    return true;
}
function emit(ev) { if (typeof addEvent === 'function') addEvent(ev); }

function config() { return readJson(path.join(DIR, 'factory.config.json')) || {}; }

// "0 9 * * *" -> the next 09:00 UTC. Only minute+hour are read; that is all the
// factory's schedule uses, and a wrong guess here would only mislabel a countdown.
function nextRunAt(cron) {
    const m = String(cron || '').trim().split(/\s+/);
    const minute = Number(m[0]), hour = Number(m[1]);
    if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
}

function isLiveActive(l) {
    if (!l || !l.phase || l.phase === 'done') return false;
    const t = Date.parse(l.updatedAt || l.startedAt || '');
    // A run that stopped writing three hours ago is not live, whatever its phase says.
    return Number.isFinite(t) && (Date.now() - t) < 3 * 3600 * 1000;
}

// ── the watch ────────────────────────────────────────────────────────────
async function readRemoteLive() {
    const r = await git(['show', 'origin/live:live.json']);
    if (!r.ok) return null;
    try { return JSON.parse(r.out); } catch { return null; }
}

function readLocalLive() { return readJson(path.join(DIR, 'research', 'live.json')); }

async function refreshBoard() {
    const s = await cli(['status', '--json'], 30000);
    if (s.ok) { try { state.board = JSON.parse(s.out); } catch (e) { state.lastError = 'status: bad JSON'; } }
    else state.lastError = 'status: ' + (s.err || s.out).slice(0, 160);
    const r = await cli(['runs', '--json'], 20000);
    if (r.ok) { try { state.runs = JSON.parse(r.out); } catch { /* keep the old rows */ } }
}

function liveEvents(prev, live) {
    if (!live || !live.run) return;
    const run = live.run;
    if (live.phase && live.phase !== 'done') {
        once(`${run}|start`, () => emit({
            type: 'factory_run',
            title: `[factory] reading ${live.category || 'a shelf'}${live.where === 'local' ? ' (local run)' : ''}`,
            body: `${live.apps && live.apps.total ? live.apps.total + ' apps to open' : 'starting'} - watch it in the Factory tab`,
        }));
    }
    for (const f of (live.findings || [])) {
        if (!f || !f.id) continue;
        once(`${run}|finding|${f.id}`, () => emit({
            type: 'factory_finding',
            title: `[factory] finding: ${f.id}`,
            body: `${f.people || '?'} people${f.dead ? ' - but already solved or not a product' : ''}`,
        }));
    }
    if (live.phase === 'done') {
        const res = live.result || {};
        once(`${run}|done`, () => emit({
            type: 'factory_run',
            title: `[factory] run finished: ${res.findings || 0} finding${res.findings === 1 ? '' : 's'}`,
            body: res.note || `${live.reviewsRead || 0} reviews read, ${live.quotesKept || 0} quotes kept`,
        }));
    }
}

async function pull() {
    if (state.pulling) return { ok: false, error: 'a pull is already running' };
    state.pulling = true;
    try {
        const r = await cli(['pull'], 90000);
        state.lastPull = new Date().toISOString();
        if (!r.ok) { state.lastError = 'pull: ' + (r.err || r.out).slice(0, 160); return { ok: false, error: state.lastError }; }
        const m = r.out.match(/new candidates: (\d+)\s+updated: (\d+)/);
        const created = m ? Number(m[1]) : 0, updated = m ? Number(m[2]) : 0;
        if (created) emit({
            type: 'factory_pull',
            title: `[factory] ${created} new candidate${created === 1 ? '' : 's'} scored`,
            body: `${updated} updated - open the Factory tab to pick or drop`,
        });
        await refreshBoard();
        return { ok: true, created, updated, out: r.out };
    } finally { state.pulling = false; }
}

async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        if (!fs.existsSync(BIN)) { state.available = false; state.lastError = 'factory not found at ' + DIR; return; }
        state.available = true;

        const f = await git(['fetch', '--prune', 'origin'], 30000);
        if (f.ok) { state.lastFetch = Date.now(); if (state.lastError && state.lastError.startsWith('fetch')) state.lastError = null; }
        else state.lastError = 'fetch: ' + f.err.slice(0, 160);

        let live = null, from = null;
        if (state.localRun && state.localRun.active) { live = readLocalLive(); if (live) from = 'local'; }
        if (!live) { live = await readRemoteLive(); if (live) from = live.where || 'cloud'; }
        const prev = state.live;
        state.live = live; state.liveFrom = from;
        liveEvents(prev, live);

        const sha = await git(['rev-parse', 'origin/main']);
        if (sha.ok && sha.out !== state.mainSha) {
            const first = state.mainSha === null;
            state.mainSha = sha.out;
            if (!first) await pull();
        }
        if (!state.board) await refreshBoard();
    } catch (e) {
        state.lastError = e.message;
    } finally {
        ticking = false;
        schedule();
    }
}

function schedule() {
    if (timer) clearTimeout(timer);
    // Paused from the Automations tab: a tick already in flight must not re-arm.
    if (stopped) { timer = null; return; }
    // Right after a cloud fire the run has not written `live` yet; watch closely
    // so its first step appears within seconds, not a minute.
    const fired = state.cloudFire && state.cloudFire.ok && (Date.now() - Date.parse(state.cloudFire.finishedAt)) < CLOUD_HOT_MS;
    const hot = isLiveActive(state.live) || (state.localRun && state.localRun.active) || fired;
    timer = setTimeout(() => { tick().catch(() => {}); }, hot ? POLL_LIVE_MS : POLL_IDLE_MS);
    if (timer.unref) timer.unref();
}

// ── actions ──────────────────────────────────────────────────────────────
async function pick(id) {
    if (!ID_RE.test(String(id || ''))) return { ok: false, error: 'bad id' };
    const r = await cli(['pick', id], 30000);
    await refreshBoard();
    return { ok: r.ok, out: (r.out || r.err).trim() };
}

async function drop(id, reason) {
    if (!ID_RE.test(String(id || ''))) return { ok: false, error: 'bad id' };
    const why = String(reason || '').trim().slice(0, 200) || 'dropped from TSRCT';
    const r = await cli(['drop', id, why], 30000);
    await refreshBoard();
    return { ok: r.ok, out: (r.out || r.err).trim() };
}

// The CLI waits up to 40s for the lead's prompt to appear, so this answers
// immediately and lets the board show the session when it is up.
function build(id) {
    if (!ID_RE.test(String(id || ''))) return { ok: false, error: 'bad id' };
    cli(['build', id], 90000).then(async (r) => {
        emit({ type: 'factory_build', title: r.ok ? `[factory] lead session up for ${id}` : `[factory] build did not start: ${id}`, body: (r.out || r.err).trim().slice(0, 300) });
        await refreshBoard();
    });
    return { ok: true, started: true };
}

// A local run of the same researcher brief, for testing or a day the cloud
// did not run. It is `claude -p` on this laptop: light (no browser), minutes
// long, and never two at once.
function runLocal() {
    if (state.localRun && state.localRun.active) return { ok: false, error: 'a local run is already going' };
    if (restrictedGuard.mentionsRestricted(DIR)) return { ok: false, error: 'refused: SecretCo path' };
    const routine = readJson(path.join(DIR, 'research', 'routine.json'));
    if (!routine || !routine.message) return { ok: false, error: 'research/routine.json has no message' };
    const tools = (routine.allowed_tools || ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch']).join(',');
    let child;
    try {
        child = spawn('claude', ['-p', routine.message, '--allowedTools', tools], {
            cwd: DIR, env: { ...process.env, FACTORY_WHERE: 'local' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (e) { return { ok: false, error: e.message }; }
    const run = { active: true, startedAt: new Date().toISOString(), finishedAt: null, code: null, tail: '' };
    state.localRun = run;
    const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, LOCAL_RUN_TIMEOUT_MS);
    const keep = c => { run.tail = (run.tail + c).slice(-2000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', e => { run.tail += '\n' + e.message; });
    child.on('close', async (code) => {
        clearTimeout(killer);
        run.active = false; run.finishedAt = new Date().toISOString(); run.code = code;
        emit({ type: 'factory_run', title: code === 0 ? '[factory] local run finished' : `[factory] local run exited ${code}`, body: run.tail.trim().slice(-300) });
        // The run pushed to main; pull whatever landed, then fall back to the cloud view.
        await pull().catch(() => {});
        schedule();
    });
    schedule();
    emit({ type: 'factory_run', title: '[factory] local run started', body: 'the researcher is reading a shelf from this laptop' });
    return { ok: true, started: true };
}

// Fire the cloud routine now instead of waiting for its schedule. The server
// holds no claude.ai credentials, so a one-turn headless `claude -p` (Haiku,
// only the RemoteTrigger tool) makes the call with the CLI's own login. The
// run itself then shows up on the `live` branch like any scheduled one.
const TRIGGER_RE = /^trig_[A-Za-z0-9]+$/;
const CLOUD_FIRE_TIMEOUT_MS = 2 * 60 * 1000;
const CLOUD_HOT_MS = 10 * 60 * 1000;

function runCloud() {
    if (state.cloudFire && state.cloudFire.active) return Promise.resolve({ ok: false, error: 'already asking the cloud to run' });
    if (isLiveActive(state.live) || (state.localRun && state.localRun.active)) return Promise.resolve({ ok: false, error: 'a run is already going' });
    if (restrictedGuard.mentionsRestricted(DIR)) return Promise.resolve({ ok: false, error: 'refused: SecretCo path' });
    const routine = readJson(path.join(DIR, 'research', 'routine.json')) || {};
    const trig = String(routine.trigger_id || '');
    if (!TRIGGER_RE.test(trig)) return Promise.resolve({ ok: false, error: 'research/routine.json has no valid trigger_id' });

    const prompt = `Call the RemoteTrigger tool once with action "run" and trigger_id "${trig}". `
        + 'Then reply with ONLY one line: "OK <the run session URL or id>" if it started, or "FAIL <the error>" if not.';
    const fire = { active: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null, note: '' };
    state.cloudFire = fire;
    return new Promise((resolve) => {
        let out = '', done = false, child;
        const finish = (ok, note) => {
            if (done) return; done = true; clearTimeout(killer);
            Object.assign(fire, { active: false, finishedAt: new Date().toISOString(), ok, note: String(note || '').trim().slice(0, 300) });
            emit({ type: 'factory_run', title: ok ? '[factory] cloud run started' : '[factory] cloud run did not start', body: fire.note });
            schedule();
            resolve(ok ? { ok: true, started: true, note: fire.note } : { ok: false, error: fire.note || 'no answer' });
        };
        const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } finish(false, 'timed out asking the cloud'); }, CLOUD_FIRE_TIMEOUT_MS);
        try {
            child = spawn('claude', ['-p', prompt, '--model', 'haiku', '--allowedTools', 'RemoteTrigger'], {
                cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (e) { finish(false, e.message); return; }
        child.stdout.on('data', c => { out = (out + c).slice(-4000); });
        child.stderr.on('data', c => { out = (out + c).slice(-4000); });
        child.on('error', e => finish(false, e.message));
        child.on('close', (code) => {
            const line = out.split('\n').map(s => s.trim()).find(s => /^(OK|FAIL)\b/.test(s));
            if (code === 0 && line && line.startsWith('OK')) finish(true, line.slice(2));
            else finish(false, line ? line.replace(/^FAIL\s*/, '') : `claude exited ${code}: ${out.trim().slice(-200)}`);
        });
    });
}

// ── public surface ───────────────────────────────────────────────────────
function snapshot() {
    const cfg = config();
    const rt = cfg.routine || {};
    return {
        available: state.available,
        dir: DIR,
        live: state.live,
        liveFrom: state.liveFrom,
        liveActive: isLiveActive(state.live),
        board: state.board,
        runs: state.runs,
        localRun: state.localRun,
        cloudFire: state.cloudFire || null,
        pulling: state.pulling,
        lastPull: state.lastPull,
        lastFetch: state.lastFetch,
        lastError: state.lastError,
        routine: { name: rt.name || null, cron: rt.cron || null, human: rt.cronHuman || null, model: rt.model || null, nextRunAt: nextRunAt(rt.cron) },
        worth: cfg.worth || 8,
    };
}

let stopped = false;
function start(addEventFn) {
    stopped = false;
    if (addEventFn) addEvent = addEventFn;
    loadNotified();
    // First look is deferred so a slow GitHub cannot slow server boot.
    setTimeout(() => { tick().catch(() => {}); }, 4000);
    return { started: true, dir: DIR, present: fs.existsSync(BIN) };
}

function stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } }
function isRunning() { return !stopped; }

module.exports = { start, stop, isRunning, snapshot, pull, pick, drop, build, runLocal, runCloud, tick, nextRunAt, isLiveActive };
