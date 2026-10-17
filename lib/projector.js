// ─────────────────────────────────────────────────────────────────────────
// lib/projector.js — the PROJECTOR (2026-10-12): a live view of a SEPARATE
// browser that another Claude session drives.
//
// Why it exists: course steps go through the real UI (his rule), and until now
// that meant Tesla's PC mode, which moves HIS mouse - he could not work while a
// course ran. Now the course session drives its own headless browser
// (scripts/projector.js, puppeteer-core + chrome-headless-shell, its own
// profile) and he watches it in a floating window, clicking or typing into it
// only when he wants to (his own passwords, for instance).
//
// Three parts, all here:
//   1. A REGISTRY on disk, one JSON file per tmux session
//      (~/.config/tsrct/projector/<session>.json). The browser's keeper writes
//      it when it starts and deletes it when it closes; a file whose browser pid
//      is dead is pruned on the next read. So the dropdown reflects reality with
//      no setup, and a crash leaves nothing behind that claims to be live.
//   2. A STREAM: a CDP websocket to the page (Node's own WebSocket - this repo
//      has zero npm dependencies), Page.startScreencast, JPEG frames fanned out
//      to every window watching that session. ONE connection per session however
//      many windows watch, and the last viewer leaving stops the screencast and
//      closes the socket. Nobody watching = Chrome encodes nothing.
//   3. INPUT from the window (mouse down/move/up, wheel, keys, pasted text) sent
//      as CDP Input events to that same page. Never the real cursor: this file
//      does not touch lib/desk.js and cannot.
//
// SECRETCO: a session named SecretCo is refused at registration and never listed; the
// page's url and title are checked before the first frame, on every main-frame
// navigation and every few seconds while streaming, and an SecretCo page stops the
// stream. The frames only ever go to his own authenticated window, but the
// projected page is also what the driving Claude session reads back, so the
// CLI refuses the same pages on its side.
//
// Typed text (his passwords included) passes through memory only: input is
// never logged and never written anywhere.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
// Modest on purpose: 11 GB laptop, many sessions. Screencast only sends a frame
// when the page changes, so a still page costs nothing - but a moving one (a
// spinner, an animation) ran at 60 frames/s and a FULL core (measured
// 2026-10-12). Every 6th frame = ~10/s, enough to follow a course.
const SCREENCAST = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 6 };
const RECHECK_MS = 3000;

function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const deps = {
    dir: process.env.PROJECTOR_DIR || path.join(os.homedir(), '.config', 'tsrct', 'projector'),
    isAlive: pidAlive,
    connect: cdpConnect,
    pageInfo: httpPageInfo,
};
function configure(o = {}) { Object.assign(deps, o); }
function dir() { return deps.dir; }

// ── 1. registry ─────────────────────────────────────────────────────────────
function fileOf(session) { return path.join(deps.dir, session + '.json'); }

function register(entry) {
    const e = entry || {};
    if (!NAME_RE.test(String(e.session || ''))) return { ok: false, error: 'bad session name' };
    if (restrictedGuard.mentionsRestricted(e.session)) return { ok: false, error: 'SecretCo is never projected' };
    if (!e.port || !e.targetId) return { ok: false, error: 'port and targetId are required' };
    try {
        fs.mkdirSync(deps.dir, { recursive: true });
        const row = { kind: 'browser', ...e, updatedAt: Date.now() };
        const tmp = fileOf(e.session) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(row, null, 2));
        fs.renameSync(tmp, fileOf(e.session));
        return { ok: true, entry: row };
    } catch (err) { return { ok: false, error: err.message }; }
}

// Merge a few fields into an existing row (url/title after a navigation, the
// active tab, last use). Missing row = nothing to update.
function touch(session, fields) {
    const cur = rawRead(session);
    if (!cur) return null;
    return register({ ...cur, ...fields }).entry || null;
}

function unregister(session) {
    if (!NAME_RE.test(String(session || ''))) return;
    try { fs.unlinkSync(fileOf(session)); } catch {}
}

function rawRead(session) {
    if (!NAME_RE.test(String(session || ''))) return null;
    try { return JSON.parse(fs.readFileSync(fileOf(session), 'utf8')); } catch { return null; }
}

// The live source of a session, or null. A dead browser is pruned here, so
// the next list is already right.
function source(session) {
    if (restrictedGuard.mentionsRestricted(session)) return null;
    const e = rawRead(session);
    if (!e) return null;
    if (!deps.isAlive(e.pid)) { unregister(session); return null; }
    return e;
}

// What the dropdown shows: every tmux session he could pick, each with its
// source or null. Hidden sessions (Tesla's brains, Ro's), runners and SecretCo are
// left out here, not by the caller, so no route can forget it.
function sourcesFor(sessionNames) {
    const out = [];
    for (const name of sessionNames || []) {
        if (!NAME_RE.test(String(name || ''))) continue;
        if (name.startsWith('tesla-') || name.startsWith('ro-') || name.startsWith('run-')) continue;
        if (restrictedGuard.mentionsRestricted(name)) continue;
        const s = source(name);
        out.push({ name, source: s ? { kind: s.kind, url: s.url || '', title: s.title || '', startedAt: s.startedAt || 0 } : null });
    }
    // Sources whose session is gone stay on disk until their keeper notices; they
    // are simply not offered (no session to pick).
    return out;
}

function isBlocked({ session, url, title } = {}) {
    return restrictedGuard.mentionsRestricted(session, url, title);
}

// ── 2. CDP over Node's own WebSocket ────────────────────────────────────────
function cdpConnect(entry) {
    return new Promise((resolve, reject) => {
        if (typeof WebSocket !== 'function') return reject(new Error('this Node has no WebSocket (needs 22+)'));
        const ws = new WebSocket(`ws://127.0.0.1:${entry.port}/devtools/page/${entry.targetId}`);
        let seq = 0, opened = false;
        const pending = new Map();
        const handlers = [], closers = [];
        const conn = {
            send(method, params = {}) {
                return new Promise((res, rej) => {
                    const id = ++seq;
                    pending.set(id, { res, rej });
                    try { ws.send(JSON.stringify({ id, method, params })); }
                    catch (e) { pending.delete(id); rej(e); }
                });
            },
            on(fn) { handlers.push(fn); },
            onClose(fn) { closers.push(fn); },
            close() { try { ws.close(); } catch {} },
        };
        ws.onopen = () => { opened = true; resolve(conn); };
        ws.onerror = () => { if (!opened) reject(new Error('cannot reach the browser')); };
        ws.onclose = () => {
            for (const p of pending.values()) p.rej(new Error('browser connection closed'));
            pending.clear();
            closers.forEach(fn => { try { fn(); } catch {} });
        };
        ws.onmessage = (m) => {
            let d; try { d = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
            if (d.id && pending.has(d.id)) {
                const p = pending.get(d.id); pending.delete(d.id);
                return d.error ? p.rej(new Error(d.error.message || 'cdp error')) : p.res(d.result || {});
            }
            if (d.method) handlers.forEach(h => { try { h(d.method, d.params || {}); } catch {} });
        };
    });
}

// url + title of the page, from the DevTools HTTP list (no extra socket).
function httpPageInfo(entry) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: entry.port, path: '/json/list', timeout: 2000 }, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try {
                    const t = JSON.parse(raw).find(x => x.id === entry.targetId);
                    resolve(t ? { url: t.url || '', title: t.title || '' } : null);
                } catch { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

// ── 3. streams ──────────────────────────────────────────────────────────────
const streams_ = new Map();   // session -> { conn, viewers:Set, entry, timer, last }

function streams() { return [...streams_.keys()]; }

function endStream(session, ev) {
    const s = streams_.get(session);
    if (!s) return;
    streams_.delete(session);
    clearInterval(s.timer);
    if (ev) s.viewers.forEach(v => { try { v(ev); } catch {} });
    s.conn.send('Page.stopScreencast').catch(() => {});
    // Let the stop go out before the socket closes.
    setImmediate(() => s.conn.close());
}

async function openStream(session, entry) {
    const conn = await deps.connect(entry);
    const s = { conn, viewers: new Set(), entry, timer: null, last: null };
    streams_.set(session, s);
    const refuse = () => endStream(session, { kind: 'refused', why: 'This page is SecretCo - never projected.' });
    conn.on((method, p) => {
        if (method === 'Page.screencastFrame') {
            conn.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
            const m = p.metadata || {};
            const ev = { kind: 'frame', data: p.data, w: m.deviceWidth || 0, h: m.deviceHeight || 0 };
            s.last = ev;
            s.viewers.forEach(v => { try { v(ev); } catch {} });
        } else if (method === 'Page.frameNavigated') {
            const f = p.frame || {};
            if (!f.parentId && isBlocked({ url: f.url })) refuse();
        }
    });
    conn.onClose(() => {
        if (streams_.get(session) === s) endStream(session, { kind: 'ended', why: 'The browser closed.' });
    });
    // The page's title and a change of tab are not frame events: look every few
    // seconds while someone watches (one local HTTP call, no model, no frame).
    s.timer = setInterval(async () => {
        const cur = source(session);
        if (!cur) return endStream(session, { kind: 'ended', why: 'The browser closed.' });
        if (cur.targetId !== s.entry.targetId) return endStream(session, { kind: 'switch' });
        const info = await deps.pageInfo(cur);
        if (info && isBlocked({ url: info.url, title: info.title })) refuse();
        touch(session, { lastViewed: Date.now() });
    }, RECHECK_MS);
    if (s.timer.unref) s.timer.unref();
    await conn.send('Page.enable');
    // A headless page with no client holding it "focused" drops key events (and
    // a click focuses the input but typing goes nowhere): measured 2026-10-12,
    // keys landed only while the CLI's puppeteer was attached. Claim focus here.
    await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await conn.send('Page.bringToFront').catch(() => {});
    await conn.send('Page.startScreencast', SCREENCAST);
    // The screencast only sends a frame when the page paints, and only every 6th one:
    // a page that does not move (a login form) never sends any, and the window sat
    // black on "Connecting..." (2026-10-17). So the page as it is now goes first.
    if (!s.last) {
        try {
            const shot = await conn.send('Page.captureScreenshot', { format: 'jpeg', quality: SCREENCAST.quality });
            const vp = (await conn.send('Page.getLayoutMetrics').catch(() => ({}))).cssLayoutViewport || {};
            if (shot && shot.data && !s.last) s.last = { kind: 'frame', data: shot.data, w: vp.clientWidth || 0, h: vp.clientHeight || 0 };
        } catch { /* the screencast's own frames still come when the page moves */ }
    }
    return s;
}

// Watch a session. Calls onEvent with {kind:'frame'|'none'|'refused'|'ended'|
// 'switch'|'error'} and returns the function that stops watching.
async function watch(session, onEvent) {
    const noop = () => {};
    if (!NAME_RE.test(String(session || ''))) { onEvent({ kind: 'none', why: 'No session picked.' }); return noop; }
    if (restrictedGuard.mentionsRestricted(session)) { onEvent({ kind: 'refused', why: 'SecretCo is never projected.' }); return noop; }
    const entry = source(session);
    if (!entry) { onEvent({ kind: 'none', why: `Nothing to project for ${session}: it has no separate browser open.` }); return noop; }
    let s = streams_.get(session);
    if (!s) {
        const info = await deps.pageInfo(entry);
        if (info && isBlocked({ url: info.url, title: info.title })) {
            onEvent({ kind: 'refused', why: 'This page is SecretCo - never projected.' });
            return noop;
        }
        try { s = await openStream(session, entry); }
        catch (e) {
            streams_.delete(session);
            onEvent({ kind: 'error', why: 'Could not reach that browser: ' + e.message });
            return noop;
        }
    }
    s.viewers.add(onEvent);
    if (s.last) onEvent(s.last);   // a second window gets the current picture at once
    let stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        s.viewers.delete(onEvent);
        if (!s.viewers.size && streams_.get(session) === s) endStream(session);
    };
}

// ── input ───────────────────────────────────────────────────────────────────
const VK = {
    Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, Home: 36, End: 35,
    PageUp: 33, PageDown: 34, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32,
};
// Headless Chrome does not turn Ctrl+A into "select all" by itself; the edit
// command has to ride along with the key.
const CMD = { a: 'selectAll', c: 'copy', x: 'cut', z: 'undo', y: 'redo' };

function keyParams({ key, code, ctrl, shift, alt, meta } = {}) {
    const k = String(key || '');
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
    const out = { key: k, code: code || '', modifiers };
    if (VK[k] !== undefined) out.windowsVirtualKeyCode = VK[k];
    else if (k.length === 1) out.windowsVirtualKeyCode = k.toUpperCase().charCodeAt(0);
    if (k === 'Enter') out.text = '\r';
    else if (k.length === 1 && !ctrl && !meta && !alt) out.text = k;
    if ((ctrl || meta) && CMD[k.toLowerCase()]) out.commands = [CMD[k.toLowerCase()]];
    return out;
}

const BUTTON = { 0: 'left', 1: 'middle', 2: 'right' };

async function input(session, ev = {}) {
    const s = streams_.get(session);
    if (!s) return { ok: false, error: 'Not watching that session.' };
    const c = s.conn;
    const num = (v) => Math.max(0, Math.min(10000, Number(v) || 0));
    try {
        if (ev.kind === 'mouse') {
            const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[ev.type];
            if (!type) return { ok: false, error: 'bad mouse type' };
            await c.send('Input.dispatchMouseEvent', {
                type, x: num(ev.x), y: num(ev.y),
                button: ev.type === 'move' ? (ev.held ? BUTTON[ev.button || 0] : 'none') : BUTTON[ev.button || 0] || 'left',
                buttons: ev.held || ev.type === 'down' ? 1 : 0,
                clickCount: ev.type === 'move' ? 0 : Math.max(1, Math.min(3, Number(ev.clickCount) || 1)),
            });
        } else if (ev.kind === 'wheel') {
            await c.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel', x: num(ev.x), y: num(ev.y),
                deltaX: Math.max(-3000, Math.min(3000, Number(ev.dx) || 0)),
                deltaY: Math.max(-3000, Math.min(3000, Number(ev.dy) || 0)),
            });
        } else if (ev.kind === 'key') {
            const p = keyParams(ev);
            await c.send('Input.dispatchKeyEvent', { type: p.text ? 'keyDown' : 'rawKeyDown', ...p });
            await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: p.key, code: p.code, modifiers: p.modifiers, windowsVirtualKeyCode: p.windowsVirtualKeyCode });
        } else if (ev.kind === 'text') {
            await c.send('Input.insertText', { text: String(ev.text || '').slice(0, 10000) });
        } else {
            return { ok: false, error: 'unknown input' };
        }
        touch(session, { lastViewed: Date.now() });
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
    configure, dir, register, touch, unregister, source, sourcesFor, isBlocked,
    watch, input, streams, keyParams, NAME_RE,
};
