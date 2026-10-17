// ─────────────────────────────────────────────────────────────────────────
// syften.js — Syften mention feed for the Notifs tab.
//
// Polls Syften's API server-side (the token never reaches the browser) and
// keeps a DURABLE store in data/syften-items.json, because the in-app event
// queue is capped at 50 and wiped on restart — a missed mention is the whole
// point of the tool, so these have to survive a reboot.
//
// Syften's own quota is spent by MATCHING, not by reading: polling /items/get
// costs nothing against the 500/day. Only the filters themselves cost.
//
// Delivery ceiling is Syften's, not ours: it surfaces posts minutes after they
// appear, so a 60s poll is not the bottleneck.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const API_BASE = 'syften.com';
const API_PATH = '/api/0.1/items/get';
const STORE = path.join(__dirname, '..', 'data', 'syften-items.json');
const MAX_KEEP = 300;          // ring buffer; oldest fall off
const POLL_MS = 60 * 1000;

let state = { items: [], dismissed: [], lastPoll: 0, lastError: null };
let timer = null;
let onNew = null;              // callback(newItems) — used to fire the chime

// ── store ────────────────────────────────────────────────────────────────
function load() {
    try {
        if (fs.existsSync(STORE)) {
            const d = JSON.parse(fs.readFileSync(STORE, 'utf8'));
            state.items = Array.isArray(d.items) ? d.items : [];
            state.dismissed = Array.isArray(d.dismissed) ? d.dismissed : [];
        }
    } catch (e) {
        state.lastError = 'store read failed: ' + e.message;
    }
}

function save() {
    try {
        fs.mkdirSync(path.dirname(STORE), { recursive: true });
        fs.writeFileSync(STORE, JSON.stringify({
            items: state.items.slice(0, MAX_KEEP),
            dismissed: state.dismissed.slice(-2000),
        }, null, 1));
    } catch (e) {
        state.lastError = 'store write failed: ' + e.message;
    }
}

// ── API ──────────────────────────────────────────────────────────────────
function apiPost(body) {
    return new Promise((resolve) => {
        const token = process.env.SYFTEN_TOKEN || '';
        if (!token) return resolve({ ok: false, error: 'SYFTEN_TOKEN not set in .env' });
        const payload = JSON.stringify(body || {});
        const req = https.request({
            hostname: API_BASE, path: API_PATH, method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 25000,
        }, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return resolve({ ok: false, error: 'HTTP ' + res.statusCode + ' ' + raw.slice(0, 200) });
                }
                try { resolve({ ok: true, data: JSON.parse(raw) }); }
                catch (e) { resolve({ ok: false, error: 'bad JSON: ' + e.message }); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.write(payload);
        req.end();
    });
}

// Flatten one Syften item into exactly what the UI row needs.
// Shape verified against the live API 2026-08-21: the response is a BARE ARRAY,
// each entry {id, item:{...}, matched_on, filter}. The community lives in
// item.backend_sub ("r/startupideas"), not in item.meta.
function normalize(raw) {
    const it = raw.item || {};
    return {
        id: raw.id || (it.item_url || '') + '|' + (it.timestamp || ''),
        url: it.item_url || '',
        title: it.title || '(untitled)',
        // Syften sends HTML for Reddit; strip tags so the row stays one line.
        text: (it.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
        backend: it.backend || '?',
        community: it.backend_sub || '',
        author: it.author || '',
        type: it.type || '',
        lang: it.lang || '',
        filter: raw.filter || it.filter || '',
        ts: it.timestamp || raw.matched_on || null,
    };
}

async function poll() {
    const r = await apiPost({ limit: 50 });
    state.lastPoll = Date.now();
    if (!r.ok) { state.lastError = r.error; return { ok: false, error: r.error }; }
    state.lastError = null;

    const rows = Array.isArray(r.data) ? r.data : (r.data.items || []);
    const incoming = rows.map(normalize).filter(i => i.id);
    const known = new Set(state.items.map(i => i.id));
    const fresh = incoming.filter(i => !known.has(i.id));

    if (fresh.length) {
        state.items = fresh.concat(state.items).slice(0, MAX_KEEP);
        save();
        const dismissed = new Set(state.dismissed);
        const visible = fresh.filter(i => !dismissed.has(i.id));
        if (visible.length && typeof onNew === 'function') {
            try { onNew(visible); } catch { /* never let the callback break polling */ }
        }
    }
    return { ok: true, added: fresh.length };
}

// ── public surface ───────────────────────────────────────────────────────
// Dismissing never deletes: the item stays in the store and `hidden` reports how
// many are being withheld, so the UI can always offer them back.
function list(includeDismissed) {
    const dismissed = new Set(state.dismissed);
    const open = state.items.filter(i => !dismissed.has(i.id));
    return {
        items: includeDismissed ? state.items : open,
        hidden: state.items.length - open.length,
        showingAll: !!includeDismissed,
        lastPoll: state.lastPoll,
        lastError: state.lastError,
        configured: !!process.env.SYFTEN_TOKEN,
    };
}

function restore() {
    const n = state.dismissed.length;
    state.dismissed = [];
    save();
    return { ok: true, restored: n };
}

function dismiss(id) {
    if (!id) return { ok: false, error: 'id required' };
    if (!state.dismissed.includes(id)) state.dismissed.push(id);
    save();
    return { ok: true };
}

function clearAll() {
    // Count only what was actually visible, so the toast matches the rows that
    // disappeared rather than the whole retained buffer.
    let cleared = 0;
    for (const i of state.items) {
        if (!state.dismissed.includes(i.id)) { state.dismissed.push(i.id); cleared++; }
    }
    save();
    return { ok: true, cleared };
}

function start(newItemCallback) {
    onNew = newItemCallback;
    load();
    if (timer) clearInterval(timer);
    // First poll is deferred so a Syften outage cannot slow server boot.
    setTimeout(() => { poll().catch(() => {}); }, 5000);
    timer = setInterval(() => { poll().catch(() => {}); }, POLL_MS);
    if (timer.unref) timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, poll, list, dismiss, clearAll, restore };
