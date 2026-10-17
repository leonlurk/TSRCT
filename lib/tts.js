'use strict';
// ── tts.js — read text out loud without ever touching the graphics card ──────
//
// Piper is a small neural voice that runs on onnxruntime, on the CPU. That is
// the whole point of choosing it over XTTS (which speaks in a cloned voice but
// holds ~2.5 GB of an 8 GB card resident): the morning brief can be read at any
// hour, while ComfyUI or a local model owns the GPU, and nothing competes.
//
// The voice itself is a FILE (~114 MB of .onnx) that sits on disk like a
// typeface — designed once, says anything afterwards. Swapping in a voice
// trained from an XTTS speaker later changes nothing here: same file name, same
// route, different timbre.
//
// THREE THINGS THIS MODULE IS CAREFUL ABOUT, each for a measured reason:
//
//   1. IT IS CACHED BY CONTENT. The morning brief is fixed text once written,
//      and re-reading it is the normal case (open the overlay, press play,
//      press play again). Synthesis is ~20s of CPU for a brief; a cache hit is
//      a file read. The key is the hash of voice + text, so editing the text
//      makes a new file and nothing goes stale.
//
//   2. IT RUNS ONE AT A TIME. Measured on this laptop, one brief with the
//      thread cap at 2 already costs ~200% CPU for 23 seconds. Two overlapping
//      calls on a machine that also runs five Claude sessions is a stall
//      everyone feels, so requests queue instead of racing.
//
//   3. IT IS NOT REQUIRED. Piper missing, the venv gone, no voice downloaded:
//      available() answers false, the route says so plainly, and the frontend
//      falls back to the browser's own voice. A feature that reads things
//      aloud must never be able to break the thing it is reading.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PYTHON = process.env.PIPER_PYTHON || path.join(os.homedir(), '.venvs', 'piper', 'bin', 'python');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'piper-speak.py');
const VOICE_DIR = process.env.PIPER_VOICE_DIR || path.join(os.homedir(), '.local', 'share', 'vrtx', 'piper');
const DEFAULT_VOICE = process.env.PIPER_VOICE || 'en_US-lessac-high';
// 2 is deliberate. onnxruntime defaults to every core: unrestricted, one brief
// pinned ~21 cores at 2150% CPU for 16s. At 2 threads it is still 3.1x faster
// than real time, and nobody is waiting on it.
const THREADS = Number(process.env.PIPER_THREADS || 2);
const CACHE_DIR = process.env.TTS_CACHE_DIR || path.join(__dirname, '..', 'data', 'tts');
const CACHE_KEEP = 60;                 // files; a brief is ~3 MB
const MAX_CHARS = 20000;
const TIMEOUT_MS = Number(process.env.PIPER_TIMEOUT_MS || 5 * 60 * 1000);

// ── PROFILES: a voice plus the effects on top (2026-10-14) ──────────────────
// Leon: Piper "habla horrible ... no tiene entonacion". He picked, by ear, the
// Microsoft neural voice Jorge (es-MX) pitched down into a monster ("A grave").
// The voice is Microsoft's free online one (edge-tts, a ~1 MB package, nothing
// local runs a model); the monster is plain ffmpeg - pitch and formant down,
// bass, a short echo - the way he would treat a vocal in his DAW. Two rules:
//   - OFFLINE IS NOT SILENT: no internet, edge-tts gone or broken -> the same
//     effects over the local Piper voice. Still a monster, never a dead orb.
//   - SECRETCO NEVER LEAVES THE MACHINE: the route already refuses SecretCo text, and
//     here a mention sends it down the local path regardless (fail closed).
const EDGE_TTS = process.env.EDGE_TTS_BIN || path.join(os.homedir(), '.venvs', 'edge-tts', 'bin', 'edge-tts');
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const EDGE_TIMEOUT_MS = 20000;
const PROFILES = {
    'jorge-monstruo': {
        edge: 'es-MX-JorgeNeural',
        local: 'es_MX-claude-high',
        filter: 'aformat=channel_layouts=mono,rubberband=pitch=0.75:formant=shifted,bass=g=4,aecho=0.8:0.5:35:0.2,volume=1.3',
    },
};

function voiceFile(name) { return path.join(VOICE_DIR, `${name}.onnx`); }

function listVoices() {
    let piper = [];
    try {
        piper = fs.readdirSync(VOICE_DIR)
            .filter(f => f.endsWith('.onnx'))
            .map(f => f.slice(0, -5));
    } catch { piper = []; }
    // A profile is usable when its local fallback is: that path always works.
    const profiles = Object.keys(PROFILES).filter(k => piper.includes(PROFILES[k].local));
    return [...piper, ...profiles].sort();
}

// Why it is unavailable matters more than the fact: "no voice downloaded" and
// "no python" are different jobs for whoever reads the message.
function status() {
    const voices = listVoices();
    const hasPython = fs.existsSync(PYTHON);
    const hasScript = fs.existsSync(SCRIPT);
    const voice = voices.includes(DEFAULT_VOICE) ? DEFAULT_VOICE : (voices[0] || '');
    let why = '';
    if (!hasPython) why = `no piper runtime at ${PYTHON} (create it: uv venv ~/.venvs/piper && uv pip install piper-tts)`;
    else if (!hasScript) why = `scripts/piper-speak.py is missing`;
    else if (!voice) why = `no voice in ${VOICE_DIR} (download one: ~/.venvs/piper/bin/python -m piper.download_voices en_US-lessac-high --data-dir ${VOICE_DIR})`;
    return { ok: !why, why, voice, voices, threads: THREADS, engine: 'piper', gpu: false };
}

function available() { return status().ok; }

function cacheKey(text, voice) {
    return crypto.createHash('sha256').update(`${voice}\n${text}`).digest('hex').slice(0, 32);
}

// Keep the newest CACHE_KEEP files. Pruning on write (not on a timer) means a
// machine that never speaks never spends anything on housekeeping.
function prune() {
    try {
        const files = fs.readdirSync(CACHE_DIR)
            .filter(f => f.endsWith('.wav'))
            .map(f => {
                const p = path.join(CACHE_DIR, f);
                try { return { p, t: fs.statSync(p).mtimeMs }; } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.t - a.t);
        for (const f of files.slice(CACHE_KEEP)) { try { fs.unlinkSync(f.p); } catch {} }
    } catch { /* no cache dir yet */ }
}

// One at a time, across every caller. A promise chain rather than a queue of
// jobs: the work is short, and the caller already awaits its own turn.
let chain = Promise.resolve();

function say({ text, voice } = {}) {
    const clean = String(text == null ? '' : text).trim();
    if (!clean) return Promise.resolve({ ok: false, error: 'nothing to say' });
    if (clean.length > MAX_CHARS) return Promise.resolve({ ok: false, error: `too long (${clean.length} characters, cap is ${MAX_CHARS})` });
    const st = status();
    if (!st.ok) return Promise.resolve({ ok: false, error: st.why });
    const use = (voice && listVoices().includes(voice)) ? voice : st.voice;

    // A profile's effects are part of its sound: retuning the filter must not replay old files.
    const key = cacheKey(clean, PROFILES[use] ? `${use}\n${PROFILES[use].edge}\n${PROFILES[use].filter}` : use);
    const out = path.join(CACHE_DIR, `${key}.wav`);
    if (fs.existsSync(out)) {
        try { fs.utimesSync(out, new Date(), new Date()); } catch {}   // keep the ones he replays
        return Promise.resolve({ ok: true, file: out, voice: use, cached: true });
    }

    const run = PROFILES[use] ? () => sayProfile(clean, use, key, out) : () => piperTo(clean, use, key, out);
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
}

// A child process with a time limit: resolves { ok, err }.
function exec(bin, args, { input, timeoutMs } = {}) {
    return new Promise((resolve) => {
        let p;
        try { p = spawn(bin, args, { stdio: [input == null ? 'ignore' : 'pipe', 'ignore', 'pipe'] }); } catch (e) { return resolve({ ok: false, err: e.message }); }
        let err = '', done = false;
        const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish({ ok: false, err: `timed out after ${Math.round(timeoutMs / 1000)}s` }); }, timeoutMs);
        p.stderr.on('data', d => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
        p.on('error', e => finish({ ok: false, err: e.message }));
        p.on('close', code => finish({ ok: code === 0, err: code === 0 ? '' : (err.trim().split('\n').pop() || `${path.basename(bin)} exited ${code}`) }));
        if (input != null) { p.stdin.on('error', () => {}); p.stdin.end(input); }
    });
}

async function sayProfile(clean, name, key, out) {
    const prof = PROFILES[name];
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
    const base = path.join(CACHE_DIR, `.${key}.${process.pid}`);
    const tmpTxt = `${base}.txt`, tmpRaw = `${base}.raw`, tmpOut = `${base}.out.wav`;
    const clean_ = () => { for (const f of [tmpTxt, tmpRaw, tmpOut]) { try { fs.unlinkSync(f); } catch {} } };
    let how = 'edge';
    let made = { ok: false, err: 'skipped' };
    // The text goes in a file, never on the command line (argv rule, and a
    // leading dash in his sentence must not read as a flag).
    if (!restrictedGuard().mentionsRestricted(clean) && fs.existsSync(EDGE_TTS)) {
        let wrote = true;
        try { fs.writeFileSync(tmpTxt, clean); } catch (e) { wrote = false; made = { ok: false, err: e.message }; }
        if (wrote) made = await exec(EDGE_TTS, ['--voice', prof.edge, '--file', tmpTxt, '--write-media', tmpRaw], { timeoutMs: EDGE_TIMEOUT_MS });
    }
    if (!made.ok) {
        how = 'local';
        if (made.err !== 'skipped') console.warn(`[tts] ${name}: online voice failed (${made.err}); using the local one`);
        const r = await piperTo(clean, prof.local, key, `${tmpRaw}.wav`, { keep: true });
        if (!r.ok) { clean_(); return { ok: false, error: r.error }; }
        try { fs.renameSync(`${tmpRaw}.wav`, tmpRaw); } catch (e) { clean_(); return { ok: false, error: e.message }; }
    }
    const fx = await exec(FFMPEG, ['-nostdin', '-loglevel', 'error', '-y', '-i', tmpRaw, '-af', prof.filter, '-ar', '24000', tmpOut], { timeoutMs: 30000 });
    if (!fx.ok) { clean_(); return { ok: false, error: `effects: ${fx.err}` }; }
    // The offline stand-in is never cached as THE sound: next time online, the real voice is made.
    if (how === 'local') out = out.replace(/\.wav$/, '.local.wav');
    try { fs.renameSync(tmpOut, out); } catch (e) { clean_(); return { ok: false, error: e.message }; }
    clean_();
    prune();
    return { ok: true, file: out, voice: name, cached: false, via: how };
}

let guard = null;
function restrictedGuard() { return guard || (guard = require('./dispatcher/restrictedGuard')); }

// Piper straight to `out`. `keep` = an intermediate file: no prune, no cache bookkeeping.
function piperTo(clean, use, key, out, { keep } = {}) {
    return new Promise((resolve) => {
        try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
        const tmp = path.join(CACHE_DIR, `.${key}.${process.pid}.p.wav`);
        // argv, never a shell string: the text is arbitrary and goes in on
        // stdin, so nothing here can be read as a command (server.js rule).
        const p = spawn(PYTHON, [SCRIPT, '--voice', use, '--voice-dir', VOICE_DIR,
            '--threads', String(THREADS), '--out', tmp], { stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        let settled = false;
        const finish = (r) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!r.ok) { try { fs.unlinkSync(tmp); } catch {} }
            resolve(r);
        };
        const timer = setTimeout(() => {
            try { p.kill('SIGKILL'); } catch {}
            finish({ ok: false, error: `the voice took longer than ${Math.round(TIMEOUT_MS / 1000)}s and was stopped` });
        }, TIMEOUT_MS);
        p.stderr.on('data', d => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
        p.on('error', e => finish({ ok: false, error: e.message }));
        p.on('close', code => {
            if (code !== 0) return finish({ ok: false, error: (err.trim().split('\n').pop() || `piper exited ${code}`) });
            let stats = null;
            try { stats = JSON.parse(err.trim().split('\n').filter(l => l.startsWith('{')).pop() || 'null'); } catch {}
            try { fs.renameSync(tmp, out); } catch (e) { return finish({ ok: false, error: e.message }); }
            if (!keep) prune();
            finish({ ok: true, file: out, voice: use, cached: false, stats });
        });
        p.stdin.on('error', () => {});
        p.stdin.end(clean);
    });
}

module.exports = { say, status, available, listVoices, DEFAULT_VOICE, VOICE_DIR, CACHE_DIR, PROFILES };
