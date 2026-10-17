'use strict';
// ── shellJob.js — run one of the scripts that used to live in crontab ────────
//
// WHY THIS EXISTS: the four cron jobs moved into the scheduler (2026-09-24) so
// they catch up after the laptop was shut at the appointed minute. cron ran
// them with `>/dev/null 2>&1`, which cannot tell a success from a job that
// never fired. Here a run returns its exit code, how long it took and the last
// lines it printed, and each job decides from that what "worked" means.
//
// Argv only (spawn, no shell string), never blocks the server (async), and a
// run that overstays its timeout is killed with its whole process group, so a
// hung `claude -p` inside a script cannot sit on a core for a day.

const { spawn } = require('child_process');

const TAIL_BYTES = 4096;

function runScript({ file, args = [], cwd, timeoutMs = 15 * 60 * 1000, env } = {}) {
    return new Promise((resolve) => {
        const started = Date.now();
        let tail = '';
        let child;
        try {
            child = spawn('bash', [file, ...args], {
                cwd,
                env: { ...process.env, ...(env || {}) },
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true,          // its own process group, so a kill takes the children too
            });
        } catch (e) {
            resolve({ code: -1, tail: '', ms: 0, error: e.message });
            return;
        }
        const keep = (buf) => {
            tail = (tail + buf.toString('utf8')).slice(-TAIL_BYTES);
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
            setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref?.();
        }, timeoutMs);
        timer.unref?.();
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ code: -1, tail, ms: Date.now() - started, error: e.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: timedOut ? -2 : code, tail, ms: Date.now() - started, timedOut });
        });
    });
}

// The last non-empty lines of a text, for a one-line summary.
function lastLines(text, n = 1) {
    return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).slice(-n);
}

module.exports = { runScript, lastLines };
