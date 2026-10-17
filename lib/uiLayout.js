'use strict';
// ─────────────────────────────────────────────────────────────────────────
// lib/uiLayout.js — the desktop layout outlives a TSRCT restart, not a Linux one
// (2026-10-14).
//
// His words: "i am sick of re-allocating everything between each restart. if
// linux is shut down, then the layouts should reset."
//
// A TSRCT restart closes the app window and the launcher opens a NEW one, so all
// that a window keeps for itself (sessionStorage: the per-folder split tabs, the
// sidebar width, panel and collapse, focus mode, the session on screen) was lost.
// The window now mirrors those keys here, one copy per window ROLE (full, deck,
// focus, wall), and a fresh window seeds itself from it (src/js/layout-memory.js).
//
// The copy is stamped with the Linux boot id. A different boot id means Linux was
// shut down (or `wsl --shutdown`): the copy is thrown away and the layout starts
// clean, which also matches reality - every tmux session it pointed at died too.
// Laptop sleep keeps the same boot. Not in the `config` table: that one is
// durable across boots on purpose, and this must not be.
// ─────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// Only these keys, all of them a window's own layout. Anything else is dropped.
const KEYS = ['tsrct_split_groups', 'tsrct_split_state', 'pc_sidebar_w', 'pc_sidebar_collapsed', 'pc_sidebar_panel',
    'pcFocusMode', 'tsrct_home_session'];
const ROLES = ['full', 'deck', 'focus', 'wall'];
const MAX_BYTES = 200 * 1024;

let deps = {
    file: path.join(__dirname, '..', '.tsrct', 'ui-layout.json'),
    bootId: () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return 'unknown'; } },
};
function configure(d) { deps = { ...deps, ...d }; }

const roleOf = (r) => (ROLES.includes(r) ? r : 'full');

function load() {
    const boot = deps.bootId();
    let data = null;
    try { data = JSON.parse(fs.readFileSync(deps.file, 'utf8')); } catch { data = null; }
    if (!data || data.bootId !== boot) {
        // Another boot's layout (or none): start clean, and say so on disk.
        if (data) { try { fs.unlinkSync(deps.file); } catch { /* already gone */ } }
        data = { bootId: boot, roles: {} };
    }
    if (!data.roles || typeof data.roles !== 'object') data.roles = {};
    return data;
}

function read(role) {
    const data = load();
    return { bootId: data.bootId, values: { ...(data.roles[roleOf(role)] || {}) } };
}

// Replaces that window's copy: a key the window no longer has is gone here too.
function write(role, values) {
    const clean = {};
    for (const k of KEYS) {
        const v = values && values[k];
        if (typeof v === 'string' && v.length) clean[k] = v;
    }
    const size = Buffer.byteLength(JSON.stringify(clean));
    if (size > MAX_BYTES) return { ok: false, error: `layout too large (${size} bytes)` };
    const data = load();
    data.roles[roleOf(role)] = clean;
    data.savedAt = Date.now();
    try {
        fs.mkdirSync(path.dirname(deps.file), { recursive: true });
        const tmp = deps.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, deps.file);
    } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, bootId: data.bootId };
}

module.exports = { configure, read, write, KEYS, ROLES };
