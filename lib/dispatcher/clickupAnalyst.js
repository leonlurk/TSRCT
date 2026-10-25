// The HEADLESS Claude job engine (cc-tsrct-analyst session). The file name is
// historical: it began as the ClickUp analyst and grew into the one runner every
// background `claude -p` job goes through.
//
// Mirrors the promptPolisher pattern: the Node server writes a job file, a
// dedicated HEADLESS Claude Code session (`cc-tsrct-analyst`) reads it, does ALL
// the reasoning, and writes a result to out/<key>.md. This module polls for that
// file and hands the text back to the job's onResult callback. The Node side
// stays deterministic.
//
// ONE serialized session services every job KIND (the morning brief, Tesla's
// workarounds and prompts, the taste picks), so they share this single in-memory
// queue — never two `claude -p` at once.
//
// Runs ON DEMAND ONLY — nothing auto-fires, so token spend is fully controlled.
// Every job goes through submitJob().
//
// Why headless (claude -p): same as promptPolisher — print mode is the gate-free
// unattended path; we capture stdout straight to a file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');
const { execFileSync } = require('child_process');

const tmux = require('./tmuxAdapter');
const restrictedGuard = require('./restrictedGuard');

const WORKSPACE = process.env.ANALYST_WORKSPACE || path.join(paths.PROJECTS_ROOT, 'tsrct-analyst');
const JOBS_DIR = path.join(WORKSPACE, 'jobs');
const OUT_DIR = path.join(WORKSPACE, 'out');
const SESSION = process.env.ANALYST_SESSION || 'cc-tsrct-analyst';

// Read-only/scoped investigation -> acceptEdits is gate-free without --dangerously-skip.
const CLAUDE_FLAGS = process.env.ANALYST_CLAUDE_FLAGS || '--permission-mode acceptEdits';

// The agent investigates outside its cwd: the PROJECTS root (vault + repos), the
// Claude Code session logs, and the skills dir (the weekly-worklogs skill is the
// canonical worklog logic). Grant read access so it never prompts.
const ADD_DIRS = (process.env.ANALYST_ADD_DIRS ||
    [paths.PROJECTS_ROOT, paths.CLAUDE_PROJECTS, path.join(paths.HOME, '.claude', 'skills')].join(':')).split(':').filter(Boolean);

// ── SECRETCO, as a PERMISSION, not a sentence (2026-09-24) ──────────────────────
// ADD_DIRS hands every job the whole PROJECTS root and every session log -
// SecretCoSandbox's folder and transcripts included - and until today the only thing
// between a job and them was "NEVER read anything ... secretco" in its prompt. A
// prompt is not a guard. Every job now carries a settings file whose deny rules
// make Claude Code itself refuse those paths (measured with a dummy folder: the
// denied file's token never came back, through Read OR Grep; Claude's own
// warning confirms Read(...) rules cover every file-reading tool).
function restrictedDenyRules(roots = [...new Set([...ADD_DIRS, WORKSPACE])]) {
    return restrictedGuard.denyRules(roots);
}

const POLL_MS = Number(process.env.ANALYST_POLL_MS || 8000);
const MAX_RUN_MS = Number(process.env.ANALYST_MAX_RUN_MS || 12 * 60 * 1000);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ensureDirs() {
    for (const d of [WORKSPACE, JOBS_DIR, OUT_DIR]) {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
}

function jobFilePath(key) { return path.join(JOBS_DIR, `${key}.json`); }
function promptFilePath(key) { return path.join(JOBS_DIR, `${key}.prompt.txt`); }
function outFilePath(key) { return path.join(OUT_DIR, `${key}.md`); }

// In-memory job queue (all jobs are on-demand + ephemeral; a restart simply drops
// any unfinished job — Leon re-clicks). Serialized one-at-a-time on the session.
// queue item: { key, kind, onResult(text), onTimeout(), onError(msg) }.
const queue = [];
let running = null;

function ensureSession() {
    ensureDirs();
    if (!tmux.sessionExists(SESSION)) tmux.createSession(SESSION, WORKSPACE);
}

function tmuxSend(...args) {
    execFileSync('tmux', ['send-keys', '-t', SESSION, ...args], { stdio: 'pipe' });
}

function interrupt() {
    try { tmuxSend('C-c'); } catch {}
}

// Job keys are minted server-side (wl-<ms>, row-<id>-<ms>), but they end up as the
// PATTERN of `pkill -f`, where ".*" would kill the whole session and a leading "-"
// would be read as a flag. Enforce the shape here rather than trust the caller —
// cancelJob is reachable from an HTTP route.
const JOB_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Force-kill a job's headless claude. The key appears in the claude process argv:
// the shell expands "$(cat jobs/<key>.prompt.txt)" before exec, and the prompt text
// itself names jobs/<key>.json — so -f matches on the expanded command line.
function killJob(jobKey) {
    if (!jobKey || !JOB_KEY_RE.test(jobKey)) return false;
    // pkill exits 1 when nothing matched, which execFileSync throws on — that is a
    // normal "already gone", not an error worth surfacing.
    try { execFileSync('pkill', ['-f', jobKey], { stdio: 'pipe' }); return true; }
    catch { return false; }
}

function notifyCancelled(job) {
    try {
        if (job.onCancel) job.onCancel();
        else if (job.onError) job.onError('cancelled');
    } catch (e) { console.error(`[analyst] onCancel error (${job.key}):`, e.message); }
}

// Cancel a queued or running job: kill its headless claude, drop the pane back to a
// prompt, and release the one-at-a-time lock so the next job can start.
// Deliberately still pkills for a key the engine no longer tracks — after a server
// restart (or a job the timeout already gave up on) the claude process can outlive
// the bookkeeping, and that orphan is exactly what leaves the UI stuck.
function cancelJob(key) {
    if (!key || !JOB_KEY_RE.test(key)) return { cancelled: false, was: 'invalid' };

    const qi = queue.findIndex(j => j.key === key);
    if (qi !== -1) {                       // queued, never dispatched — nothing to kill
        const [job] = queue.splice(qi, 1);
        notifyCancelled(job);
        console.log(`[analyst] cancelled ${key} (queued, ${job.kind})`);
        return { cancelled: true, was: 'queued' };
    }

    if (running && running.key === key) {
        const job = running;
        running = null;                    // release the lock BEFORE pumping the next job
        killJob(key);
        interrupt();
        notifyCancelled(job);
        pump().catch(e => console.error('[analyst] pump error:', e.message));
        console.log(`[analyst] cancelled ${key} (running, ${job.kind})`);
        return { cancelled: true, was: 'running' };
    }

    const killed = killJob(key);
    console.log(`[analyst] cancel ${key}: not tracked (orphan killed: ${killed})`);
    return { cancelled: false, was: 'untracked', killed };
}

// ─── Generic job submission ────────────────────────────────────────────────
// Every job writes jobs/<key>.json (optional structured input) + jobs/<key>.prompt.txt
// (the instruction handed to claude -p). When out/<key>.md is non-empty, onResult
// fires with the trimmed text. onTimeout/onError are optional.
function submitJob({ key, kind, jobData, instruction, allowedTools, model, addDirs, disallowedTools, maxMs, onResult, onTimeout, onError, onCancel }) {
    // SECRETCO — at the CHOKE POINT, and it guards the DATA, never our own prompt.
    //
    // Every job kind (completion, propose, worklog, digest, note-route) reaches
    // `claude -p` through this one function, and that session is NOT Bedrock.
    // Guarding per caller is how the original gap happened, so the check lives
    // here and a new job kind inherits it for free.
    //
    // But the FIRST version of this check also scanned `instruction`, and every
    // analyst instruction MENTIONS SecretCo precisely in order to exclude it
    // ("HARD SECRETCO EXCLUSION: never read ... anything whose path or content
    // concerns secretco"). So it rejected the very sentence that honours the
    // contract, and from 2026-08-15 it silently killed EVERY analyst job. Nothing
    // ran until 08-19, when Leon hit GENERATE on worklogs and the panel sat on
    // [ GENERATING ] with no job file, no tmux session and no process.
    //
    // The untrusted input is jobData, plus the key (which becomes a pkill
    // pattern). A caller that inlines user content into the INSTRUCTION must
    // guard it itself — promptPolisher.submitFollowup does exactly that with its
    // live pane capture, and that is the pattern to copy.
    restrictedGuard.assertNotRestricted(
        `analyst job (${kind || 'unknown'})`,
        key, JSON.stringify(jobData || {}), (addDirs || []).join(' ')
    );
    ensureDirs();
    if (jobData !== undefined) fs.writeFileSync(jobFilePath(key), JSON.stringify(jobData, null, 2));
    fs.writeFileSync(promptFilePath(key), instruction);
    // A headless job cannot be asked for permission, so anything outside its
    // mode is simply refused. A job that needs connectors names the exact tools,
    // and they travel in a FILE: the list has parentheses and the command line
    // below is typed into a shell.
    const toolsFile = promptFilePath(key).replace(/\.prompt\.txt$/, '.tools.txt');
    if (Array.isArray(allowedTools) && allowedTools.length) fs.writeFileSync(toolsFile, allowedTools.join(','));
    else { try { fs.unlinkSync(toolsFile); } catch {} }
    // Per-job model, extra read folders and refused tools (Tesla's prompt writer,
    // 2026-09-24: Opus, reading the target session's project). Every token is
    // checked to be one plain word before it reaches the shell line below.
    const flagsFile = promptFilePath(key).replace(/\.prompt\.txt$/, '.flags.txt');
    const flags = [];
    if (model) {
        if (!/^[a-z0-9.-]{1,40}$/i.test(model)) throw new Error(`bad model name: ${model}`);
        flags.push('--model', model);
    }
    for (const d of addDirs || []) {
        if (!/^\/[A-Za-z0-9._\/-]{1,200}$/.test(d) || !fs.existsSync(d)) throw new Error(`bad folder: ${d}`);
        flags.push('--add-dir', d);
    }
    if (Array.isArray(disallowedTools) && disallowedTools.length) {
        if (!disallowedTools.every(t => /^[A-Za-z]{1,30}$/.test(t))) throw new Error('bad tool name');
        flags.push('--disallowedTools', disallowedTools.join(','));
    }
    // Every job, whatever its kind: the SecretCo deny rules (see restrictedDenyRules).
    // The file name is one plain word, so it is safe on the shell line.
    const settingsFile = promptFilePath(key).replace(/\.prompt\.txt$/, '.settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { deny: restrictedDenyRules() } }, null, 2));
    flags.push('--settings', `jobs/${key}.settings.json`);
    fs.writeFileSync(flagsFile, flags.join(' '));
    const cap = Number(maxMs) > 0 ? Math.min(Number(maxMs), 30 * 60 * 1000) : MAX_RUN_MS;
    queue.push({ key, kind: kind || 'job', maxMs: cap, onResult, onTimeout, onError, onCancel });
    pump().catch(e => console.error('[analyst] pump error:', e.message));
    return { queued: true, key };
}

// If the session is free, dispatch the next queued job. Serialized via the
// in-memory `running` lock + a pumping guard (pump awaits, so two near-simultaneous
// triggers could otherwise double-dispatch onto the one session).
let pumping = false;
async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        if (running) return;            // one at a time
        const job = queue.shift();
        if (!job) return;
        running = { ...job, startedAt: Date.now() };
        try {
            ensureSession();
            await sleep(400);
            interrupt();
            await sleep(300);
            const k = job.key;
            const addDirFlags = ADD_DIRS.map(d => `--add-dir ${d}`).join(' ');
            const toolsFlag = fs.existsSync(promptFilePath(k).replace(/\.prompt\.txt$/, '.tools.txt'))
                ? `--allowedTools "$(cat jobs/${k}.tools.txt)"` : '';
            const extraFlag = fs.existsSync(promptFilePath(k).replace(/\.prompt\.txt$/, '.flags.txt'))
                ? `$(cat jobs/${k}.flags.txt)` : '';
            const cmd = `echo "[analyst] running ${k} (silent: out/${k}.md, ~20s-5min)..."; claude -p "$(cat jobs/${k}.prompt.txt)" ${addDirFlags} ${CLAUDE_FLAGS} ${toolsFlag} ${extraFlag} > out/${k}.md 2> out/${k}.err; echo "[analyst] done ${k} ($(wc -c < out/${k}.md) bytes)"`;
            tmuxSend(cmd, 'Enter');
            console.log(`[analyst] dispatched ${k} (${job.kind})`);
        } catch (e) {
            try { if (job.onError) job.onError(`dispatch failed: ${e.message}`); } catch {}
            running = null;
            console.error(`[analyst] dispatch failed for ${job.key}: ${e.message}`);
        }
    } finally {
        pumping = false;
    }
}

// Capture the running job's output when ready; time it out otherwise; pump next.
async function tick() {
    if (running) {
        const job = running;
        try {
            const out = outFilePath(job.key);
            if (fs.existsSync(out)) {
                const txt = fs.readFileSync(out, 'utf8').trim();
                if (txt) {
                    running = null;
                    try { if (job.onResult) job.onResult(txt); }
                    catch (e) { console.error(`[analyst] onResult error (${job.key}):`, e.message); }
                    console.log(`[analyst] result delivered for ${job.key} (${job.kind}, ${txt.length} chars)`);
                }
            }
            if (running && (Date.now() - job.startedAt) > (job.maxMs || MAX_RUN_MS)) {
                killJob(job.key);
                running = null;
                try { if (job.onTimeout) job.onTimeout(); } catch {}
                console.warn(`[analyst] job ${job.key} timed out (killed)`);
            }
        } catch (e) {
            running = null;
            try { if (job.onError) job.onError(e.message); } catch {}
        }
    }
    await pump();
}

// ─── Live activity feed (what the analyst is doing, in real time) ────────────
// Each `claude -p` run writes a fresh transcript .jsonl under the analyst's project
// log dir; the NEWEST file is the current/last run. We tail it and surface the
// recent tool calls as short human-readable steps so the dashboard is never "blind".
const PROJ_LOG_DIR = path.join(os.homedir(), '.claude', 'projects', WORKSPACE.replace(/\//g, '-'));

function newestTranscript() {
    try {
        const files = fs.readdirSync(PROJ_LOG_DIR).filter(f => f.endsWith('.jsonl'));
        let best = null, bestM = 0;
        for (const f of files) {
            const m = fs.statSync(path.join(PROJ_LOG_DIR, f)).mtimeMs;
            if (m > bestM) { bestM = m; best = f; }
        }
        return best ? path.join(PROJ_LOG_DIR, best) : null;
    } catch { return null; }
}

function stepLabel(name, input) {
    const i = input || {};
    const base = (p) => String(p || '').split('/').pop();
    switch (name) {
        case 'Read':      return `read ${base(i.file_path)}`;
        case 'Grep':      return `grep "${String(i.pattern || '').slice(0, 40)}"`;
        case 'Glob':      return `glob ${i.pattern || ''}`;
        case 'Bash':      return `run: ${String(i.command || '').slice(0, 50)}`;
        case 'Task':      return `subagent: ${String(i.description || '').slice(0, 40)}`;
        case 'TodoWrite': return 'planning';
        case 'WebSearch': return `web search "${String(i.query || '').slice(0, 40)}"`;
        case 'WebFetch':  return `web ${String(i.url || '').replace(/^https?:\/\//, '').slice(0, 40)}`;
        default:          return name;
    }
}

// Returns { running, key, kind, steps:[{tool,label}] }. steps are the last `limit`
// tool calls from the newest transcript (the current run while one is active).
function getActivitySteps(limit = 12) {
    const out = { running: !!running, key: running ? running.key : null, kind: running ? running.kind : null, steps: [] };
    const file = newestTranscript();
    if (!file) return out;
    // When that transcript was last written: a caller that started a job after
    // it knows these steps belong to the PREVIOUS run.
    try { out.at = fs.statSync(file).mtimeMs; } catch { out.at = 0; }
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').trim().split('\n'); }
    catch { return out; }
    const tail = lines.slice(-200);
    const steps = [];
    for (const line of tail) {
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        const content = obj && obj.message && Array.isArray(obj.message.content) ? obj.message.content : null;
        if (!content) continue;
        for (const c of content) {
            if (c && c.type === 'tool_use') steps.push({ tool: c.name, label: stepLabel(c.name, c.input) });
        }
    }
    out.steps = steps.slice(-limit);
    return out;
}

let timer = null;
function start() {
    if (timer) return;
    ensureDirs();
    timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
    if (timer.unref) timer.unref();
    console.log(`[analyst] started (workspace=${WORKSPACE}, session=${SESSION}, poll=${POLL_MS}ms)`);
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
    // generic engine
    submitJob, pump, tick, start, stop, ensureSession, interrupt, killJob, cancelJob,
    // live activity feed
    getActivitySteps,
    SESSION, WORKSPACE, ADD_DIRS, restrictedDenyRules,
};
