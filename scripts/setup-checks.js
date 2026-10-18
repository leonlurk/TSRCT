'use strict';
// scripts/setup-checks.js — what TSRCT needs, how to tell it is there, and how
// to get it. One list, read by `npm run setup` (which offers each fix) and by
// `npm run doctor` (which only reports). A check never changes anything.
//
// A fix is one of: `cmd` (an argv the installer offers to run, shown first),
// `url` (a page it offers to open, for steps a person must do: a download, a
// login), or `note` (what to do by hand). Nothing here asks for a password by
// itself: a `sudo` in a cmd is typed by the person, in their own terminal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { onPath } = require('./setup-lib');
const envFile = require('../lib/envFile');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = process.env.TSRCT_ENV_FILE || path.join(ROOT, '.env');

function platform() {
    let wsl = false;
    try { wsl = /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { /* not linux */ }
    const apt = !!onPath('apt-get'), brew = !!onPath('brew');
    return { wsl, mac: process.platform === 'darwin', linux: process.platform === 'linux', apt, brew };
}

function settings() {
    try { return envFile.parse(fs.readFileSync(ENV_FILE, 'utf8')); } catch { return null; }
}

// The command that installs a system package here, or null if we cannot tell.
function pkgInstall(pkg, p) {
    if (p.apt) return ['sudo', 'apt-get', 'install', '-y', pkg];
    if (p.brew) return ['brew', 'install', pkg];
    return null;
}

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 });

function tailscaleBin() { return onPath('tailscale') || onPath('tailscale.exe'); }

// edge-tts lives in its own Python venv. Ubuntu ships python3 without venv
// support (ensurepip), so that package comes first when it is missing.
function voiceFix(p, edge) {
    if (!onPath('python3')) return { cmd: pkgInstall('python3', p), note: 'needs python3; run setup again after' };
    if (run('python3', ['-c', 'import ensurepip']).status !== 0) {
        return { cmd: pkgInstall('python3-venv', p), note: 'python3 is missing its venv part; run setup again after' };
    }
    const venv = path.dirname(path.dirname(edge));
    return { cmd: ['bash', '-c', `python3 -m venv "${venv}" && "${venv}/bin/pip" install edge-tts`], note: 'installs edge-tts in its own folder' };
}

function core(p, env) {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    const tokenOk = !!(env && env.BRIDGE_TOKEN && env.BRIDGE_TOKEN.length >= 32 && !/change-me/.test(env.BRIDGE_TOKEN));
    const hooksFile = path.join(os.homedir(), '.claude', 'settings.json');
    let hooksOk = false;
    try { hooksOk = fs.readFileSync(hooksFile, 'utf8').includes(path.join(ROOT, 'permission-hook.sh')); } catch { /* none yet */ }
    return [
        { id: 'node', title: 'Node.js 22 or newer', ok: nodeMajor >= 22, detail: `you have ${process.versions.node}`,
          fix: { url: 'https://nodejs.org/en/download', note: 'install Node.js 22 or newer, then run this again' } },
        { id: 'tmux', title: 'tmux (every session lives in one)', ok: !!onPath('tmux'),
          fix: { cmd: pkgInstall('tmux', p), note: 'install tmux with your package manager' } },
        { id: 'claude', title: 'Claude Code (the claude command)', ok: !!onPath('claude'),
          fix: { url: 'https://docs.claude.com/en/docs/claude-code/overview', note: 'install Claude Code and log in once with `claude`' } },
        { id: 'git', title: 'git (the git panels)', ok: !!onPath('git'), fix: { cmd: pkgInstall('git', p) } },
        { id: 'env', title: 'settings file (.env) with a strong token', ok: tokenOk,
          detail: env ? (tokenOk ? '' : 'BRIDGE_TOKEN is missing, short or still the example') : 'no .env yet',
          fix: { note: 'npm run setup writes it for you' } },
        { id: 'hooks', title: 'Claude Code hooks (permissions show up in TSRCT)', ok: hooksOk,
          detail: hooksOk ? '' : `${hooksFile} does not point at this TSRCT yet`, fix: { note: 'npm run setup adds them next to your own' } },
    ];
}

function optional(p, env) {
    const e = env || {};
    const ts = tailscaleBin();
    let served = false, funnel = false;
    if (ts) {
        const s = run(ts, ['serve', 'status']);
        served = new RegExp(`127\\.0\\.0\\.1:${e.BRIDGE_PORT || 3847}|localhost:${e.BRIDGE_PORT || 3847}`).test(s.stdout || '');
        funnel = /Funnel on/i.test(s.stdout || '');
    }
    const edge = process.env.EDGE_TTS_BIN || path.join(os.homedir(), '.venvs', 'edge-tts', 'bin', 'edge-tts');
    const vnc = '/mnt/c/Program Files/TightVNC/tvnserver.exe';
    return [
        { id: 'tailscale', title: 'Remote access through Tailscale', ok: !!ts && served && !funnel,
          detail: !ts ? 'Tailscale is not installed' : funnel ? 'FUNNEL IS ON: TSRCT is reachable from the whole internet' : served ? '' : 'installed, but not serving TSRCT yet',
          fix: ts ? { cmd: [ts, 'serve', '--bg', String(e.BRIDGE_PORT || 3847)], note: 'serves TSRCT inside your tailnet only (never turn on Funnel for it)' }
                  : { url: 'https://tailscale.com/download', note: p.wsl ? 'install it on Windows and sign in' : 'install it and sign in' } },
        { id: 'ntfy', title: 'Phone alerts (ntfy)', ok: !!e.NTFY_TOPIC, detail: e.NTFY_TOPIC ? `topic ${e.NTFY_TOPIC}` : 'off',
          fix: { url: 'https://ntfy.sh/app', note: 'install the ntfy app on your phone and subscribe to the topic setup gives you' } },
        { id: 'voice', title: 'Tesla\'s voice (edge-tts)', ok: fs.existsSync(edge), fix: voiceFix(p, edge) },
        { id: 'ollama', title: 'Local model (Ollama), optional for Tesla', ok: !!onPath('ollama') || !!onPath('ollama.exe'),
          fix: { url: 'https://ollama.com/download' } },
        ...(p.wsl ? [{ id: 'vnc', title: 'Remote desktop (TightVNC on Windows)', ok: fs.existsSync(vnc),
          fix: { url: 'https://www.tightvnc.com/download.php', note: 'install the server part on Windows' } }] : []),
        { id: 'morning', title: 'Morning routine', ok: e.MORNING_ENABLED === '1', detail: e.MORNING_ENABLED === '1' ? `at ${e.MORNING_AT || '06:00'}` : 'off',
          fix: { note: 'npm run setup can turn it on' } },
    ];
}

function all() {
    const p = platform();
    const env = settings();
    return { platform: p, envFile: ENV_FILE, env, core: core(p, env), optional: optional(p, env) };
}

module.exports = { all, platform, settings, ENV_FILE, ROOT };
