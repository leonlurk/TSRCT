// ─────────────────────────────────────────────────────────────────────────
// lib/studio/comfy.js — ComfyUI lifecycle + job proxy + live progress bridge.
//
// The TSRCT server is the single origin the phone talks to; ComfyUI is bound to
// 127.0.0.1:8188 (not tunnel-reachable). This module:
//   • starts / stops ComfyUI (argv-exec the venv python, PID-tracked, logs to
//     ~/ComfyUI/lurk-boot.log), reports readiness via /system_stats
//   • submits workflows (/prompt), interrupts, reads /history, proxies /view
//   • lists installed models (dir read) + sampler/scheduler enums (/object_info)
//   • bridges ComfyUI's /ws to a local EventEmitter (`bus`) so the SSE progress
//     route can relay live step/preview/done events — a hand-rolled minimal WS
//     client (read-only after handshake) keeps us dependency-free.
// Fail-soft throughout: ComfyUI down → status.running=false, never throws on poll.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { spawn, execFileSync } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 8188;
const COMFY_DIR = path.join(os.homedir(), 'ComfyUI');
const VENV_PY = path.join(COMFY_DIR, '.venv', 'bin', 'python');
const BOOT_LOG = path.join(COMFY_DIR, 'lurk-boot.log');
const OUTPUT_DIR = path.join(COMFY_DIR, 'output');
const INPUT_DIR = path.join(COMFY_DIR, 'input');
const MODELS_DIR = path.join(COMFY_DIR, 'models');
const CLIENT_ID = 'tsrct-studio';

const bus = new EventEmitter();     // emits ('ev', {kind, prompt_id?, ...})
bus.setMaxListeners(50);

let child = null;                   // process WE spawned (if any)
let starting = false;

// ── HTTP to ComfyUI ────────────────────────────────────────────────────────
function apiRequest(method, pathname, body) {
    return new Promise((resolve, reject) => {
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request({
            host: HOST, port: PORT, path: pathname, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve({
                    status: res.statusCode, headers: res.headers, buffer,
                    json: () => { try { return JSON.parse(buffer.toString()); } catch { return null; } },
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('comfy timeout')));
        if (data) req.write(data);
        req.end();
    });
}
async function apiJSON(method, pathname, body) { return (await apiRequest(method, pathname, body)).json(); }

// ── lifecycle ────────────────────────────────────────────────────────────
async function ping() {
    try { const r = await apiRequest('GET', '/system_stats'); return r.status === 200 ? r.json() : null; }
    catch { return null; }
}
function findPid() {
    try {
        const out = execFileSync('pgrep', ['-f', 'ComfyUI/.venv/bin/python'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const first = out.trim().split('\n')[0];
        return first ? parseInt(first, 10) : null;
    } catch { return null; }
}
async function status() {
    const stats = await ping();
    const pid = (child && !child.killed) ? child.pid : findPid();
    if (stats) ensureWS();
    // Surface the currently-executing prompt id so the UI can re-attach its
    // progress bar after a PWA refresh (the server's ws to ComfyUI stays alive).
    let runningPrompt = null;
    if (stats) {
        try {
            const q = await queue();
            const r = q && q.queue_running;
            if (r && r.length && r[0] && r[0][1]) runningPrompt = r[0][1];
        } catch {}
    }
    return {
        installed: fs.existsSync(VENV_PY),
        running: !!stats,
        starting,
        pid: pid || null,
        port: PORT,
        ownedByStudio: !!(child && !child.killed),
        version: stats && stats.system ? stats.system.comfyui_version : null,
        torch: stats && stats.system ? stats.system.pytorch_version : null,
        ramFreeMB: stats && stats.system ? Math.round(stats.system.ram_free / 1048576) : null,
        runningPrompt,
    };
}

const VRAM_FLAG = { normal: [], high: ['--highvram'], low: ['--lowvram'], no: ['--novram'] };

async function start(opts = {}) {
    if (await ping()) { ensureWS(); return { started: false, already: true }; }
    if (starting) return { started: false, starting: true };
    if (!fs.existsSync(VENV_PY)) throw new Error('ComfyUI venv not found at ' + VENV_PY);
    starting = true;
    try {
        const flags = VRAM_FLAG[opts.vramMode] || [];
        const out = fs.openSync(BOOT_LOG, 'a');
        child = spawn(VENV_PY, ['main.py', '--listen', HOST, '--port', String(PORT), ...flags],
            { cwd: COMFY_DIR, detached: true, stdio: ['ignore', out, out] });
        child.unref();
        child.on('exit', () => { child = null; });
        const t0 = Date.now();
        while (Date.now() - t0 < 120000) {
            await new Promise((r) => setTimeout(r, 1500));
            if (await ping()) { starting = false; ensureWS(); return { started: true }; }
        }
        starting = false;
        return { started: false, timeout: true };
    } catch (e) { starting = false; throw e; }
}

async function stop() {
    const pid = (child && !child.killed) ? child.pid : findPid();
    if (!pid) return { stopped: false, notRunning: true };
    try { process.kill(pid, 'SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 2500));
    if (await ping()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    child = null; closeWS();
    return { stopped: true };
}

// ── models (dir read + object_info enums) ──────────────────────────────────
function listDir(sub, exts) {
    try {
        return fs.readdirSync(path.join(MODELS_DIR, sub))
            .filter((f) => !f.startsWith('.') && !f.startsWith('put_')
                && (!exts || exts.some((e) => f.toLowerCase().endsWith(e))))
            .sort();
    } catch { return []; }
}
let objCache = null, objAt = 0;
async function objectInfo() {
    if (objCache && Date.now() - objAt < 30000) return objCache;
    const j = await apiJSON('GET', '/object_info');
    if (j) { objCache = j; objAt = Date.now(); }
    return j;
}
async function models() {
    const M = {
        unet: [...listDir('unet', ['.gguf', '.safetensors']), ...listDir('diffusion_models', ['.gguf', '.safetensors'])],
        loras: listDir('loras', ['.safetensors', '.gguf', '.pt']),
        vae: listDir('vae', ['.safetensors', '.pt']),
        text_encoders: listDir('text_encoders', ['.gguf', '.safetensors']),
        clip_vision: listDir('clip_vision', ['.safetensors']),
        upscale: listDir('upscale_models', ['.pth', '.safetensors']),
        style: listDir('style_models', ['.safetensors']),
    };
    let samplers = [], schedulers = [];
    try {
        const oi = await objectInfo();
        const k = oi && oi.KSampler && oi.KSampler.input && oi.KSampler.input.required;
        if (k) { samplers = k.sampler_name[0]; schedulers = k.scheduler[0]; }
    } catch {}
    return { ...M, samplers, schedulers };
}

// ── jobs ───────────────────────────────────────────────────────────────────
async function submit(workflow) {
    ensureWS();
    const j = await apiJSON('POST', '/prompt', { prompt: workflow, client_id: CLIENT_ID });
    if (!j || !j.prompt_id) {
        const msg = j && j.error ? (j.error.message || JSON.stringify(j.error)) : 'submit rejected';
        const e = new Error(msg); e.detail = j; throw e;
    }
    return j.prompt_id;
}
async function history(id) { return apiJSON('GET', '/history/' + id); }
async function interrupt() { try { return await apiJSON('POST', '/interrupt', {}); } catch { return null; } }
async function queue() { return apiJSON('GET', '/queue'); }
async function view(querystring) { return apiRequest('GET', '/view?' + querystring); }

// Resolve an output file's absolute path, confined to OUTPUT_DIR. null if outside/missing.
function outputAbsPath(filename, subfolder) {
    const base = path.resolve(OUTPUT_DIR);
    const sub = (subfolder || '').replace(/\.\.+/g, '').replace(/^[\/\\]+/, '');
    const full = path.resolve(path.join(base, sub, path.basename(String(filename || ''))));
    if (full !== base && !full.startsWith(base + path.sep)) return null;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return full;
}

// Read a generated output file straight from disk (no ComfyUI dependency — the
// gallery must keep working after ComfyUI is stopped). Confined to OUTPUT_DIR.
function readOutput(filename, subfolder) {
    const full = outputAbsPath(filename, subfolder);
    if (!full) return null;
    const ext = path.extname(full).toLowerCase();
    const ct = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
        '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' }[ext] || 'application/octet-stream';
    return { buffer: fs.readFileSync(full), contentType: ct };
}

// Open an output file in Windows (reveal=true → open its folder with the file
// selected). ComfyUI output is on the WSL fs (not /mnt/c), so use `wslpath -w`
// → a \\wsl.localhost\... path explorer.exe can open.
function openOutput(filename, subfolder, reveal) {
    const full = outputAbsPath(filename, subfolder);
    if (!full) return { ok: false, error: 'not found' };
    let win;
    try { win = execFileSync('wslpath', ['-w', full], { encoding: 'utf8' }).trim(); }
    catch (e) { return { ok: false, error: 'wslpath failed' }; }
    try {
        const args = reveal ? [`/select,${win}`] : [win];
        const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
    } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, win };
}

// Delete an output file (confined to OUTPUT_DIR).
function deleteOutput(filename, subfolder) {
    const full = outputAbsPath(filename, subfolder);
    if (!full) return false;
    try { fs.unlinkSync(full); return true; } catch { return false; }
}

// Copy an output file into ComfyUI/input so a chained mode (Animate/Upscale) can
// LoadImage it. Returns the input basename. Confined to OUTPUT_DIR.
function stageOutput(filename, subfolder) {
    const full = outputAbsPath(filename, subfolder);
    if (!full) throw new Error('output not found');
    fs.mkdirSync(INPUT_DIR, { recursive: true });
    const name = path.basename(full);
    fs.copyFileSync(full, path.join(INPUT_DIR, name));
    return name;
}

// Save an uploaded image into ComfyUI/input so LoadImage-based modes can use it.
function stageInput(srcPath) {
    if (!fs.existsSync(srcPath)) throw new Error('source not found: ' + srcPath);
    fs.mkdirSync(INPUT_DIR, { recursive: true });
    const name = path.basename(srcPath);
    const dst = path.join(INPUT_DIR, name);
    fs.copyFileSync(srcPath, dst);
    return name;
}

// Recent generated files (newest first) for the output gallery.
function recentOutputs(limit = 40) {
    const items = [];
    function walk(dir, subfolder) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (!subfolder) walk(full, e.name); continue; }
            const ext = path.extname(e.name).toLowerCase();
            if (!['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.gif'].includes(ext)) continue;
            let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch {}
            items.push({
                filename: e.name, subfolder, type: 'output',
                isVideo: ['.mp4', '.webm', '.gif'].includes(ext), mtime,
            });
        }
    }
    walk(OUTPUT_DIR, '');
    items.sort((a, b) => b.mtime - a.mtime);
    return items.slice(0, limit);
}

// ── minimal WebSocket client to ComfyUI /ws (read-only after handshake) ──────
let ws = { socket: null, connected: false, buf: Buffer.alloc(0), handshook: false };

function closeWS() {
    if (ws.socket) { try { ws.socket.destroy(); } catch {} }
    ws = { socket: null, connected: false, buf: Buffer.alloc(0), handshook: false };
}
function ensureWS() {
    if (ws.socket && ws.connected) return;
    if (ws.socket) return; // connecting
    connectWS();
}
function connectWS() {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(PORT, HOST);
    ws.socket = socket; ws.handshook = false; ws.buf = Buffer.alloc(0);
    socket.on('connect', () => {
        socket.write([
            `GET /ws?clientId=${CLIENT_ID} HTTP/1.1`,
            `Host: ${HOST}:${PORT}`,
            'Upgrade: websocket', 'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
        ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
        ws.buf = Buffer.concat([ws.buf, chunk]);
        if (!ws.handshook) {
            const idx = ws.buf.indexOf('\r\n\r\n');
            if (idx === -1) return;
            const header = ws.buf.slice(0, idx).toString();
            if (!/HTTP\/1\.1 101/.test(header)) { closeWS(); return; }
            ws.handshook = true; ws.connected = true;
            ws.buf = ws.buf.slice(idx + 4);
            // Advertise preview-metadata support so ComfyUI 0.26 streams live
            // latent previews (PREVIEW_IMAGE_WITH_METADATA, type 4) to us.
            try { wsSendText(socket, JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } })); } catch {}
        }
        parseFrames();
    });
    socket.on('close', () => { if (ws.socket === socket) closeWS(); });
    socket.on('error', () => { if (ws.socket === socket) closeWS(); });
}
function parseFrames() {
    let b = ws.buf;
    while (b.length >= 2) {
        const opcode = b[0] & 0x0f;
        const masked = (b[1] & 0x80) !== 0;
        let len = b[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
        let mask = null;
        if (masked) { if (b.length < off + 4) break; mask = b.slice(off, off + 4); off += 4; }
        if (b.length < off + len) break;
        const payload = b.slice(off, off + len);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        b = b.slice(off + len);
        if (opcode === 0x8) { closeWS(); return; }
        else if (opcode === 0x1) handleText(payload.toString());
        else if (opcode === 0x2) handleBinary(payload);
        // ping/pong (0x9/0xA) ignored — ComfyUI does not require client pongs here
    }
    ws.buf = b;
}
function handleText(s) {
    let msg; try { msg = JSON.parse(s); } catch { return; }
    const t = msg.type, d = msg.data || {};
    if (t === 'progress') {                             // legacy single-node progress
        bus.emit('ev', { kind: 'progress', prompt_id: d.prompt_id, value: d.value, max: d.max });
    } else if (t === 'progress_state') {                // ComfyUI 0.26 combined per-node state
        const nodes = d.nodes || {};
        let best = null;
        for (const n of Object.values(nodes)) {
            if (!n || !n.max) continue;
            if (!best) { best = n; continue; }
            const bRun = best.value < best.max, nRun = n.value < n.max;   // prefer the running node (sampler)
            if (nRun && !bRun) best = n;
            else if (nRun === bRun && n.max > best.max) best = n;
        }
        if (best) bus.emit('ev', { kind: 'progress', prompt_id: d.prompt_id, value: best.value, max: best.max });
    } else if (t === 'executing') bus.emit('ev', { kind: 'executing', prompt_id: d.prompt_id, node: d.node });
    else if (t === 'executed') bus.emit('ev', { kind: 'executed', prompt_id: d.prompt_id, output: d.output });
    else if (t === 'execution_error') bus.emit('ev', { kind: 'error', prompt_id: d.prompt_id, error: d.exception_message || 'execution error' });
    else if (t === 'status') bus.emit('ev', { kind: 'status', data: d });
}
function handleBinary(buf) {
    if (buf.length < 8) return;
    const evType = buf.readUInt32BE(0);
    if (evType === 4) {                                 // PREVIEW_IMAGE_WITH_METADATA
        const metaLen = buf.readUInt32BE(4);
        if (buf.length < 8 + metaLen) return;
        let mime = 'image/jpeg';
        try { mime = JSON.parse(buf.slice(8, 8 + metaLen).toString()).image_type || mime; } catch {}
        bus.emit('ev', { kind: 'preview', dataURL: `data:${mime};base64,${buf.slice(8 + metaLen).toString('base64')}` });
    } else if (evType === 1) {                          // PREVIEW_IMAGE (fallback): [4B type][img]
        const imgType = buf.readUInt32BE(4);            // 1=jpeg 2=png
        const mime = imgType === 2 ? 'image/png' : 'image/jpeg';
        bus.emit('ev', { kind: 'preview', dataURL: `data:${mime};base64,${buf.slice(8).toString('base64')}` });
    }
    // type 2 (unencoded) ignored — we advertise metadata support, so type 4 is used
}

// Build + send a MASKED text frame (client→server frames must be masked).
function wsSendText(socket, str) {
    const payload = Buffer.from(str);
    const len = payload.length;
    const mask = crypto.randomBytes(4);
    let header;
    if (len < 126) { header = Buffer.from([0x81, 0x80 | len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    socket.write(Buffer.concat([header, mask, masked]));
}

module.exports = {
    HOST, PORT, CLIENT_ID, COMFY_DIR, OUTPUT_DIR, INPUT_DIR, bus,
    status, start, stop, models, submit, history, interrupt, queue, view, readOutput,
    openOutput, deleteOutput, stageOutput, stageInput, recentOutputs, ping,
};
