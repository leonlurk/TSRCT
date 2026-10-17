// ==============================================
// LAYOUT MEMORY (2026-10-14)
// The desktop layout outlives a TSRCT restart, and resets when Linux restarts.
//
// "i am sick of re-allocating everything between each restart. if linux is shut
// down, then the layouts should reset."
//
// A TSRCT restart closes this window and the launcher opens a NEW one, so all
// a window keeps for itself (sessionStorage: the per-folder split tabs, the
// sidebar width/panel/collapse, focus mode, the session on screen) was lost,
// and the split view in localStorage outlived even a Linux reboot.
// Every change to those keys is mirrored to the server (lib/uiLayout.js), one
// copy per window role; a fresh window seeds itself from it BEFORE desktop.js
// reads anything. The server stamps the copy with the Linux boot id: another
// boot means nothing comes back, and the browser's old split view is wiped too.
// Loads before desktop.js; exports window.pcLayout.
// ==============================================
(function () {
    'use strict';

    // Per window (sessionStorage) and per browser (localStorage). lib/uiLayout.js
    // keeps the same list: a key added here must be added there.
    const SESSION_KEYS = ['tsrct_split_groups', 'pc_sidebar_w', 'pc_sidebar_collapsed', 'pc_sidebar_panel', 'pcFocusMode', 'tsrct_home_session'];
    const LOCAL_KEYS = ['tsrct_split_state'];
    const BOOT_KEY = 'tsrct_layout_boot';
    const ROLES = ['full', 'deck', 'focus', 'wall'];
    const RESTORE_WAIT_MS = 2000;
    const SAVE_DELAY_MS = 500;

    const store = (kind) => { try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch (e) { return null; } };
    const get = (s, k) => { try { return s ? s.getItem(k) : null; } catch (e) { return null; } };
    const set = (s, k, v) => { try { if (s) s.setItem(k, v); } catch (e) { /* private window */ } };
    const del = (s, k) => { try { if (s) s.removeItem(k); } catch (e) { /* private window */ } };

    // Same rule as windows.js: ?role= wins, then this window's stored role.
    function role() {
        try {
            const q = new URLSearchParams(location.search).get('role');
            if (q && ROLES.includes(q)) return q;
        } catch (e) { /* no URL */ }
        const r = get(store('session'), 'tsrct_role');
        return ROLES.includes(r) ? r : 'full';
    }

    function headers(json) {
        const h = { 'Authorization': (typeof token !== 'undefined' && token) || '' };
        if (json) h['Content-Type'] = 'application/json';
        return h;
    }

    // A TSRCT restart drops every login (the server keeps them in memory), so the
    // new window's first ask is usually REFUSED until he unlocks it. Until the
    // server's copy has been read, this window saves nothing: its empty layout
    // used to land on top of the good one the moment he logged in (2026-10-14,
    // "reinicie un par de veces y el layout no se esta guardando").
    const RETRY_MS = 1500;
    const RETRY_FOR_MS = 30 * 60 * 1000;
    const RELOADED_KEY = 'tsrct_layout_reloaded';
    let restored = false;

    async function fetchLayout() {
        try {
            const r = await Promise.race([
                fetch('/api/ui/layout?role=' + encodeURIComponent(role()), { headers: headers(false) }),
                new Promise(res => setTimeout(() => res(null), RESTORE_WAIT_MS)),
            ]);
            if (!r || !r.ok) return null;
            const d = await r.json();
            return d && d.bootId ? d : null;
        } catch (e) { return null; }
    }

    // `late`: the window was already built empty while it waited for a login, so
    // the server's copy wins over its defaults. Returns whether anything changed.
    function apply(d, late) {
        const S = store('session'), L = store('local');
        const last = get(L, BOOT_KEY);
        if (last && last !== d.bootId) {
            // Linux restarted since this browser last saw TSRCT: nothing old comes back.
            LOCAL_KEYS.forEach(k => del(L, k));
            SESSION_KEYS.forEach(k => del(S, k));
        }
        set(L, BOOT_KEY, d.bootId);
        const v = d.values || {};
        let changed = false;
        // A reload still has its own (newer) window state; only a fresh window is seeded.
        SESSION_KEYS.forEach(k => {
            if (typeof v[k] !== 'string') return;
            const cur = get(S, k);
            if (cur === null || (late && cur !== v[k])) { set(S, k, v[k]); changed = true; }
        });
        LOCAL_KEYS.forEach(k => {
            if (typeof v[k] !== 'string') return;
            if (get(L, k) !== v[k]) changed = true;
            set(L, k, v[k]);
        });
        return changed;
    }

    function done() {
        restored = true;
        if (pending) mirror();
    }

    // Asked again until he is logged in. When the copy arrives late and changes
    // the layout, the page reloads ONCE so the desktop is built from it.
    let retryUntil = 0;
    function retry() {
        if (!retryUntil) retryUntil = Date.now() + RETRY_FOR_MS;
        setTimeout(async () => {
            const d = await fetchLayout();
            if (!d) { if (Date.now() < retryUntil) retry(); return; }
            const changed = apply(d, true);
            if (changed && get(store('session'), RELOADED_KEY) !== '1') {
                set(store('session'), RELOADED_KEY, '1');
                try { location.reload(); } catch (e) { /* no page (tests) */ }
                return;
            }
            done();
        }, RETRY_MS);
    }

    // Seed this window from the server's copy. Resolves false when the server
    // cannot be asked yet: the window starts as it always did, saves nothing,
    // and keeps asking (retry) until it can.
    async function restore() {
        const d = await fetchLayout();
        if (!d) { retry(); return false; }
        apply(d, false);
        done();
        return true;
    }

    function collect() {
        const S = store('session'), L = store('local');
        const values = {};
        SESSION_KEYS.forEach(k => { const x = get(S, k); if (x !== null) values[k] = x; });
        LOCAL_KEYS.forEach(k => { const x = get(L, k); if (x !== null) values[k] = x; });
        return { role: role(), values };
    }

    function send(keepalive) {
        try {
            fetch('/api/ui/layout', { method: 'POST', headers: headers(true), body: JSON.stringify(collect()), keepalive: !!keepalive })
                .catch(() => {});
        } catch (e) { /* offline */ }
    }

    // Called after every change to a layout key; a burst of changes (a drag) is one save.
    let timer = null;
    let pending = false;
    function mirror() {
        pending = true;
        if (!restored) return;               // not read yet: saving now would wipe the good copy
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; pending = false; send(false); }, SAVE_DELAY_MS);
    }

    // A change made in the last half second before the window closes still lands.
    try {
        window.addEventListener('pagehide', () => { if (pending && restored) { pending = false; send(true); } });
    } catch (e) { /* no window events (tests) */ }

    window.pcLayout = { restore, mirror, KEYS: SESSION_KEYS.concat(LOCAL_KEYS), role };
})();
