'use strict';
// ── scheduler.js — "run this job at HH:MM", for jobs that have a name ────────
//
// WHY THIS EXISTS: TSRCT had exactly one clock (lib/syften-daily.js startDaily),
// hardwired to one job, and every other recurring thing in the tree is an
// interval poller that knows nothing about the time of day. A morning routine
// needs a clock that other jobs can register on.
//
// The three rules the syften timer got right, kept here because each one was a
// real failure on a laptop:
//   1. `>=` the hour, never `===`. A machine that was closed at 06:00 and opened
//      at 09:00 is OWED the run, not past it. (Missing this silently skips days.)
//   2. Remember the last run per job, on disk, so a restart does not re-fire a
//      job that already ran and a crash loop cannot run it ten times.
//   3. Tick on a coarse interval (5 min) instead of scheduling to the second,
//      because a sleeping laptop wakes up with its timers long overdue.
//
// What is new here:
//   - jobs have NAMES and are registered by other modules;
//   - the day key is LOCAL (UTC-3), not UTC. syften's sameDay() compares UTC
//     dates, so anything owed between 21:00 and midnight local reads as
//     "tomorrow" and could run twice;
//   - a `window` in hours, so a job owed since 06:00 does not fire for the first
//     time at 23:40 when the laptop finally opens. Past the window, the day is
//     marked as skipped and the job waits for tomorrow.
//
// 2026-09-24 — the cron jobs moved in (Automations tab). Two additions for them:
//   - `days`: a weekly job ([1] = Mondays; Sunday is 0). Omitted means every day.
//   - the question is no longer "did it run TODAY" but "did it serve the most
//     recent OCCURRENCE". For a daily job those are the same thing; for a
//     Monday job with a 6-day window it is what lets a laptop that was shut on
//     Monday still run it on Wednesday. Cron could not do that, which is why the
//     Amazon keep-alive ran 3 times in 14 weeks.
// And an outcome with three levels: a run() may return { summary, warn: true }
// for "it ran, but look at this" (vulnerabilities found), and a failure streak
// is counted so the tab can shout after the second one, not the first.
//
// Nothing here runs a model, opens a session or touches the network: a job's
// `run()` does all of that, and the scheduler only decides when.

const fs = require('fs');
const path = require('path');
const { stateFile } = require('./stateFile');

// Overridable so a test can run against a scratch file instead of the real one.
const STATE_FILE = process.env.SCHEDULER_STATE_FILE || stateFile('scheduler.json', '.tsrct-scheduler.json');
const TICK_MS = Number(process.env.SCHEDULER_TICK_MS || 5 * 60 * 1000);

// name -> { name, at, days, window, description, run }
const jobs = new Map();
let timer = null;
let state = null;            // { jobs: { <name>: { lastRun, lastDay, lastResult, lastError, at, enabled } } }

// ── state ────────────────────────────────────────────────────────────────────
function loadState() {
    if (state) return state;
    try {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        state = { jobs: {} };
    }
    if (!state.jobs || typeof state.jobs !== 'object') state.jobs = {};
    // This is the first read in this process, so nothing can be running yet. A
    // `running` left on disk means the server restarted mid-run (2026-10-05: the
    // panel said "running now" with a dead job and the job could never fire again).
    for (const [name, st] of Object.entries(state.jobs)) {
        if (st && st.running) {
            st.running = false;
            st.lastError = 'interrupted: TSRCT restarted during the run';
            console.warn(`[scheduler] ${name}: was running when the server stopped - cleared`);
        }
    }
    return state;
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(loadState(), null, 2));
    } catch (e) {
        console.error('[scheduler] could not write state:', e.message);
    }
}

function jobState(name) {
    const s = loadState();
    if (!s.jobs[name]) s.jobs[name] = {};
    return s.jobs[name];
}

// ── time helpers ─────────────────────────────────────────────────────────────
// The local day, not the UTC one. Leon is UTC-3: a job that ran at 22:00 local
// is already "tomorrow" in UTC, which would let it run a second time at 00:30.
function dayKey(d) {
    const x = d || new Date();
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function parseAt(at) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || '').trim());
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { h, min };
}

function minutesNow(d) {
    const x = d || new Date();
    return x.getHours() * 60 + x.getMinutes();
}

// ── registration ─────────────────────────────────────────────────────────────
// register({ name, at:'06:00', window: 5, description, run, enabled })
//   window — hours after `at` during which an owed run still fires. Default 5.
//   run    — async (ctx) => result. Anything thrown is caught and recorded.
function register(job) {
    const name = String(job && job.name || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,48}$/i.test(name)) throw new Error(`scheduler: bad job name ${JSON.stringify(name)}`);
    if (typeof job.run !== 'function') throw new Error(`scheduler: job ${name} has no run()`);
    const at = parseAt(job.at);
    if (!at) throw new Error(`scheduler: job ${name} has a bad time ${JSON.stringify(job.at)}`);
    const st = jobState(name);
    // A time or an on/off saved by the user outlives a code change to the
    // default; the registration only supplies the fallback.
    if (st.at && !parseAt(st.at)) delete st.at;
    if (st.enabled === undefined) st.enabled = job.enabled !== false;
    // A job that has never run cannot have missed a day from before it existed.
    // Without this a job added in the afternoon shows red for yesterday.
    if (!st.firstSeen && !st.lastRun && !st.lastOcc && !st.lastDay) {
        st.firstSeen = Date.now();
        delete st.missedDay; delete st.missedAt; delete st.skippedDay;
    }
    const days = Array.isArray(job.days) && job.days.length
        ? job.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : null;
    jobs.set(name, {
        name,
        at: job.at,
        days,
        window: Number.isFinite(job.window) ? job.window : 5,
        description: String(job.description || ''),
        run: job.run,
    });
    saveState();
    return view(name);
}

function effectiveAt(name) {
    const st = jobState(name);
    const j = jobs.get(name);
    return (st.at && parseAt(st.at)) ? st.at : (j ? j.at : null);
}

function isEnabled(name) {
    return jobState(name).enabled !== false;
}

// The most recent moment this job was scheduled for, at or before `now`: today at
// `at` if that has passed and today is one of its days, otherwise the latest
// earlier allowed day. Null only when the job has no valid time.
function lastOccurrence(name, now) {
    const j = jobs.get(name);
    const at = parseAt(effectiveAt(name));
    if (!j || !at) return null;
    const base = now || new Date();
    for (let back = 0; back <= 7; back++) {
        const d = new Date(base);
        d.setDate(d.getDate() - back);
        d.setHours(at.h, at.min, 0, 0);
        if (d.getTime() > base.getTime()) continue;
        if (j.days && !j.days.includes(d.getDay())) continue;
        return d;
    }
    return null;
}

// Was this occurrence already served (ran, or given up on)? `lastOcc` is the
// occurrence a run served; `lastDay` is the older daily-only record, still
// honoured so a state file written before the change does not re-fire today.
function served(st, key) {
    return st.lastOcc === key || (!st.lastOcc && st.lastDay === key);
}

// ── the decision ─────────────────────────────────────────────────────────────
// Returns why a job should or should not run right now. Split out from the tick
// so it can be tested without a clock: due(job, now, state).
function due(name, now) {
    const j = jobs.get(name);
    if (!j) return { run: false, why: 'unknown job' };
    if (!isEnabled(name)) return { run: false, why: 'disabled' };
    const st = jobState(name);
    if (st.running) return { run: false, why: 'already running' };
    if (!parseAt(effectiveAt(name))) return { run: false, why: 'no time set' };
    const when = now || new Date();
    const occ = lastOccurrence(name, when);
    if (!occ) return { run: false, why: 'not yet' };
    const key = dayKey(occ);
    if (served(st, key)) return { run: false, why: 'already ran' };
    if (st.skippedDay === key) return { run: false, why: 'window missed' };
    if (when.getTime() > occ.getTime() + j.window * 3600 * 1000) {
        // Owed, but so late that running it now would be a surprise rather than
        // a service: a "morning routine" opening sessions at midnight is worse
        // than no morning routine. Burn the occurrence and wait for the next.
        // A job that never ran for this occurrence is a MISSED run, and that is
        // recorded so the tab can say so instead of looking merely idle.
        st.skippedDay = key;
        if (st.firstSeen && occ.getTime() < st.firstSeen) { saveState(); return { run: false, why: 'before the job existed' }; }
        if (st.enabled !== false) { st.missedDay = key; st.missedAt = Date.now(); }
        saveState();
        if (typeof onMissed === 'function') { try { onMissed(name, key); } catch { /* never break the tick */ } }
        return { run: false, why: 'past the window' };
    }
    return { run: true, why: 'owed' };
}

// ── running ──────────────────────────────────────────────────────────────────
async function runJob(name, opts = {}) {
    const j = jobs.get(name);
    if (!j) return { ok: false, error: `unknown job: ${name}` };
    const st = jobState(name);
    if (st.running) return { ok: false, error: 'already running' };
    st.running = true;
    st.startedAt = Date.now();
    saveState();
    const started = Date.now();
    // The occurrence this run serves, taken BEFORE running: a long job must not
    // serve the next one because the clock moved while it ran.
    const occ = lastOccurrence(name, new Date());
    let out;
    try {
        const r = await j.run({ name, manual: !!opts.manual, at: effectiveAt(name) });
        out = { ok: true, result: r };
        st.lastError = '';
    } catch (e) {
        console.error(`[scheduler] ${name} failed:`, e.message);
        out = { ok: false, error: e.message };
        st.lastError = e.message;
    } finally {
        if (occ) st.lastOcc = dayKey(occ);
        st.lastWarn = !!(out && out.ok && out.result && typeof out.result === 'object' && out.result.warn);
        st.failStreak = out && out.ok ? 0 : (st.failStreak || 0) + 1;
        // A run appends to a short history, newest first, for the tab's detail view.
        const entry = { at: Date.now(), ok: !!(out && out.ok), warn: st.lastWarn, manual: !!opts.manual,
            ms: Date.now() - started, text: out && out.ok ? summarize(out.result) : String(out && out.error || '').slice(0, 200) };
        st.history = [entry, ...(Array.isArray(st.history) ? st.history : [])].slice(0, 10);
        if (out && out.ok) delete st.missedDay;
        st.running = false;
        st.lastRun = Date.now();
        st.durationMs = Date.now() - started;
        // A MANUAL run does not consume the day: pressing "run now" at 14:00 to
        // test the morning routine should not cancel tomorrow's... but it must
        // not re-fire tonight either. It marks the day like a real run does,
        // because both leave the same sessions open. Same rule, said once.
        st.lastDay = dayKey(new Date());
        st.lastOk = !!(out && out.ok);
        st.lastSummary = out && out.ok ? summarize(out.result) : '';
        saveState();
    }
    if (typeof onFinished === 'function') { try { onFinished(name, view(name)); } catch { /* never break a run */ } }
    return out;
}

function summarize(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result.slice(0, 200);
    if (typeof result === 'object' && typeof result.summary === 'string') return result.summary.slice(0, 200);
    try { return JSON.stringify(result).slice(0, 200); } catch { return ''; }
}

async function tick(now) {
    const when = now || new Date();
    for (const name of jobs.keys()) {
        const d = due(name, when);
        if (!d.run) continue;
        console.log(`[scheduler] ${name}: ${d.why} (${effectiveAt(name)}) - running`);
        await runJob(name);       // one job at a time: they share one laptop
    }
}

function start() {
    if (timer) return { started: true, jobs: jobs.size };
    // A first tick shortly after boot, not immediately: the server has just
    // started, and a job that needs tmux or the dispatcher should not race it.
    setTimeout(() => { tick().catch(() => {}); }, 20000).unref?.();
    timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    timer.unref?.();
    return { started: true, jobs: jobs.size };
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

// ── read/write model for the UI ──────────────────────────────────────────────
function view(name) {
    const j = jobs.get(name);
    if (!j) return null;
    const st = jobState(name);
    const at = effectiveAt(name);
    return {
        name,
        at,
        days: j.days,
        window: j.window,
        description: j.description,
        enabled: isEnabled(name),
        running: !!st.running,
        lastRun: st.lastRun || 0,
        lastDay: st.lastDay || '',
        lastOk: st.lastOk === undefined ? null : !!st.lastOk,
        lastError: st.lastError || '',
        lastSummary: st.lastSummary || '',
        durationMs: st.durationMs || 0,
        lastWarn: !!st.lastWarn,
        failStreak: st.failStreak || 0,
        missedDay: st.missedDay || '',
        history: Array.isArray(st.history) ? st.history : [],
        nextDue: nextDue(name),
    };
}

// When this job would fire next if nothing changes. Purely informational.
// An occurrence that is owed and still inside its window counts as "now".
function nextDue(name) {
    const j = jobs.get(name);
    const at = parseAt(effectiveAt(name));
    if (!j || !at || !isEnabled(name)) return 0;
    const now = new Date();
    const st = jobState(name);
    const occ = lastOccurrence(name, now);
    if (occ) {
        const key = dayKey(occ);
        const open = now.getTime() <= occ.getTime() + j.window * 3600 * 1000;
        if (open && !served(st, key) && st.skippedDay !== key) return now.getTime();
    }
    for (let ahead = 0; ahead <= 8; ahead++) {
        const d = new Date(now);
        d.setDate(d.getDate() + ahead);
        d.setHours(at.h, at.min, 0, 0);
        if (d.getTime() <= now.getTime()) continue;
        if (j.days && !j.days.includes(d.getDay())) continue;
        return d.getTime();
    }
    return 0;
}

function list() {
    return Array.from(jobs.keys()).map(view);
}

function setTime(name, at) {
    if (!jobs.has(name)) return { ok: false, error: 'unknown job' };
    if (!parseAt(at)) return { ok: false, error: 'time must be HH:MM' };
    const st = jobState(name);
    st.at = at;
    // Moving the clock forward should be able to give you today's run back.
    if (st.skippedDay === dayKey(new Date())) delete st.skippedDay;
    saveState();
    return { ok: true, job: view(name) };
}

function setEnabled(name, on) {
    if (!jobs.has(name)) return { ok: false, error: 'unknown job' };
    jobState(name).enabled = !!on;
    saveState();
    return { ok: true, job: view(name) };
}

// Undo a "ran today" so the next tick fires it again. For the case where the
// run happened but did nothing useful (the model answered badly, the laptop was
// off the network) and you want the day back without waiting.
function clearToday(name) {
    if (!jobs.has(name)) return { ok: false, error: 'unknown job' };
    const st = jobState(name);
    delete st.lastDay;
    delete st.lastOcc;
    delete st.skippedDay;
    saveState();
    return { ok: true, job: view(name) };
}

// Told when an occurrence is given up on without having run (the tab's red flag).
let onMissed = null;
function setOnMissed(fn) { onMissed = fn; }
// Told after every run, with the job's view (the tab counts failure streaks).
let onFinished = null;
function setOnFinished(fn) { onFinished = fn; }

// First registration of a job that used to run somewhere else (cron): record the
// last run that happened there, so moving it does not re-run it on the next boot.
// `outcome` ({ ok, text, warn }) is what that run left behind, read from its log,
// so a job that was already failing shows red from the first boot, not a week later.
function seed(name, lastRunMs, outcome) {
    const j = jobs.get(name);
    const st = jobState(name);
    if (!j || st.lastRun || st.lastOcc || !lastRunMs) return false;
    const occ = lastOccurrence(name, new Date(lastRunMs + 1000));
    if (!occ) return false;
    st.lastRun = lastRunMs;
    st.lastOcc = dayKey(occ);
    if (outcome) {
        st.lastOk = !!outcome.ok;
        st.lastWarn = !!outcome.warn;
        st.lastSummary = outcome.ok ? String(outcome.text || '').slice(0, 200) : '';
        st.lastError = outcome.ok ? '' : String(outcome.text || '').slice(0, 200);
        st.failStreak = outcome.ok ? 0 : 1;
        st.history = [{ at: lastRunMs, ok: !!outcome.ok, warn: !!outcome.warn, manual: false, ms: 0, text: String(outcome.text || '').slice(0, 200) + ' (before the move, cron)' }];
    }
    saveState();
    return true;
}

// Forget a job's registration (tests only; the state on disk is kept).
function unregister(name) { jobs.delete(name); }

module.exports = {
    register, start, stop, tick, runJob, list, view, setTime, setEnabled, clearToday, setOnMissed, setOnFinished, seed,
    // exported for tests
    due, dayKey, parseAt, nextDue, lastOccurrence, unregister, STATE_FILE,
};
