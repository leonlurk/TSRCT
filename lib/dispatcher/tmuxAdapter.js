// Tmux helpers for the dispatcher.
// Wrappers around tmux CLI. Sanitization happens here, before any send-keys.

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');

function tmuxExec(args) {
    // stderr -> 'ignore' so that when NO tmux server is running (e.g. server started
    // outside tmux with zero sessions), tmux's "error connecting to .../default" does
    // not spam the console on every poll. Callers already catch + treat as empty.
    // Timeout: sync, so a hung tmux froze the whole server (2026-10-08).
    return execSync(`tmux ${args}`, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000 });
}

function listSessions() {
    try {
        const raw = tmuxExec(`list-sessions -F "#{session_name}|#{pane_current_path}|#{session_attached}|#{session_activity}"`);
        return raw.trim().split('\n').filter(Boolean)
            // Las sesiones `ro-*` son de Rocío (ATELIER). Ni el dispatcher ni Hermes
            // tienen nada que hacer con ellas: van y vienen solas.
            .filter(line => !line.startsWith('ro-'))
            .map(line => {
            const [name, cwd, attached, activity] = line.split('|');
            return {
                name,
                cwd: cwd || '/',
                attached: attached === '1',
                last_activity: Number(activity) * 1000,
            };
        });
    } catch {
        return [];
    }
}

function sessionExists(name) {
    try {
        tmuxExec(`has-session -t "${name}"`);
        return true;
    } catch {
        return false;
    }
}

// CWD allowlist — sessions can only be created within these roots. Prevents
// a compromised Hermes from proposing /etc, /home/.ssh, etc.
const ALLOWED_CWD_ROOTS = (process.env.DISPATCHER_CWD_ROOTS ||
    [paths.PROJECTS_ROOT, paths.HOME].join(',')).split(',').map(s => s.trim());

// Max chars pasted into a session in one go. Generous — Claude-polished prompts
// run 6-8k chars and were getting cut at the old 4000 limit. paste-buffer loads
// from a temp file so large content is fine; this is just a runaway guard.
const PROMPT_MAX_CHARS = Number(process.env.PROMPT_MAX_CHARS || 24000);

function isCwdAllowed(cwd) {
    if (!cwd) return false;
    const abs = path.resolve(cwd);
    return ALLOWED_CWD_ROOTS.some(root => abs === root || abs.startsWith(root + '/'));
}

function createSession(name, cwd) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
        throw new Error(`invalid session name: ${name}`);
    }
    if (!cwd) throw new Error('cwd required');
    if (!isCwdAllowed(cwd)) {
        throw new Error(`cwd outside allowlist: ${cwd}`);
    }
    if (!fs.existsSync(cwd)) {
        throw new Error(`cwd does not exist: ${cwd}`);
    }
    // Use array-arg form via spawn to avoid shell injection on the name/cwd.
    const { execFileSync } = require('child_process');
    // Inject the orchestrator self-refresh env vars (see server.js sessionEnvArgs)
    // so a LEAD spawned in a dispatcher-created session can self-refresh too.
    const refreshEnv = [
        '-e', `TSRCT_SESSION_ID=${name}`,
        '-e', `TSRCT_REFRESH_URL=http://127.0.0.1:${process.env.BRIDGE_PORT || 3847}`,
    ];
    // Hand the session THIS process's PATH. Otherwise the shell inherits whatever
    // PATH the tmux server was born with, and on 2026-10-05 that one had no
    // /usr/bin: every analyst job died at once with "claude: command not found"
    // (the morning brief twice). Our PATH is known good -- it found node.
    if (process.env.PATH) refreshEnv.push('-e', `PATH=${process.env.PATH}`);
    execFileSync('tmux', ['new-session', '-d', '-s', name, '-c', cwd, ...refreshEnv], { stdio: 'pipe', timeout: 10000 });
    return { name, cwd };
}

function sanitizePrompt(text) {
    if (!text) return '';
    let s = String(text);
    // Strip control chars (except newline/tab).
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // Strip ANSI escape sequences (CSI / OSC) — these can rewrite the terminal
    // in arbitrary ways and would bypass visual review of the prompt.
    s = s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
    s = s.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '');
    if (s.length > PROMPT_MAX_CHARS) s = s.slice(0, PROMPT_MAX_CHARS) + '\n[...truncated]';
    return s;
}

function sendToSession(name, prompt) {
    if (!sessionExists(name)) {
        throw new Error(`session does not exist: ${name}`);
    }
    const clean = sanitizePrompt(prompt);
    const tmpFile = path.join(os.tmpdir(), `dispatcher-buffer-${Date.now()}.txt`);
    try {
        fs.writeFileSync(tmpFile, clean);
        tmuxExec(`load-buffer -b dispatcher "${tmpFile}"`);
        tmuxExec(`paste-buffer -b dispatcher -t "${name}"`);
        tmuxExec(`delete-buffer -b dispatcher`);
        tmuxExec(`send-keys -t "${name}" Enter`);
    } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
    }
}

function captureSession(name, lines = 100) {
    try {
        return tmuxExec(`capture-pane -t "${name}" -p -S -${lines}`);
    } catch {
        return '';
    }
}

// Start Claude (or claude --resume <id>) inside a tmux session, then wait a
// moment so the CLI is ready before any prompt gets pasted.
function bootstrapClaude(name, mode = 'new', resumeId = null) {
    if (!sessionExists(name)) throw new Error(`session does not exist: ${name}`);
    // Sanity: resume IDs from Claude Code are UUID-like; allow alnum + dash.
    if (mode === 'resume') {
        if (!resumeId || !/^[a-zA-Z0-9_-]{6,64}$/.test(resumeId)) {
            throw new Error('invalid resume id');
        }
    }
    const cmd = mode === 'resume' ? `claude --resume ${resumeId}` : 'claude';
    // Use raw send-keys for command + Enter (NOT paste-buffer — we need shell to interpret it).
    tmuxExec(`send-keys -t "${name}" "${cmd}" Enter`);
    return cmd;
}

module.exports = {
    listSessions,
    sessionExists,
    createSession,
    sendToSession,
    captureSession,
    sanitizePrompt,
    isCwdAllowed,
    ALLOWED_CWD_ROOTS,
    bootstrapClaude,
};
