#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/check-layout.js — the desktop layout survives a TSRCT restart and
// resets when Linux restarts (2026-10-14).
//
// His words: "i am sick of re-allocating everything between each restart. if
// linux is shut down, then the layouts should reset."
//
// A TSRCT restart closes the app window and the launcher opens a NEW one, so
// everything kept per window (sessionStorage: the per-folder split tabs, the
// sidebar width/panel/collapse, focus mode, the session on screen) was gone.
// The server now keeps a copy stamped with the Linux boot id
// (/proc/sys/kernel/random/boot_id): same boot = restored, new boot = reset.
//
// Run: node scripts/check-layout.js   (exit 0 = clean, 1 = a check failed)
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let failed = 0, passed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.error(`  [!] ${name}${detail ? ' -- ' + detail : ''}`);
}

(async () => {
    // ── the server's store ──
    let ui = null;
    try { ui = require('../lib/uiLayout'); } catch (e) { check('lib/uiLayout.js loads', false, e.message); }
    if (ui) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-check-'));
        const file = path.join(dir, 'ui-layout.json');
        let boot = 'boot-A';
        ui.configure({ file, bootId: () => boot });
        const groups = JSON.stringify({ 'g-acme': { sessions: ['kara-bva', 'tsrct'], activeIndex: 1, bounds: [{ x: 0, y: 0, w: 0.5, h: 1 }] } });
        const w = ui.write('full', { tsrct_split_groups: groups, pc_sidebar_w: '300', evil_key: 'x' });
        check('a layout is saved', w && w.ok, JSON.stringify(w));
        const r = ui.read('full');
        check('it comes back after a restart (same Linux boot)', r.values.tsrct_split_groups === groups && r.values.pc_sidebar_w === '300', JSON.stringify(r));
        check('only layout keys are kept', !('evil_key' in r.values));
        check('the answer says which boot it belongs to', r.bootId === 'boot-A');
        ui.write('deck', { pc_sidebar_w: '200' });
        check('each window role keeps its own layout', ui.read('full').values.pc_sidebar_w === '300' && ui.read('deck').values.pc_sidebar_w === '200');
        ui.write('full', { pcFocusMode: '1' });
        check('a save replaces that window\'s layout (a key left out is gone)', ui.read('full').values.pcFocusMode === '1' && !('pc_sidebar_w' in ui.read('full').values));
        check('an unknown role is treated as the main window', ui.read('../../etc').values.pcFocusMode === '1');
        const big = ui.write('full', { tsrct_split_groups: 'x'.repeat(300 * 1024) });
        check('an oversized layout is refused', big && !big.ok);
        boot = 'boot-B';
        const after = ui.read('full');
        check('after a Linux restart the layout is reset', Object.keys(after.values).length === 0 && after.bootId === 'boot-B', JSON.stringify(after));
        check('... and the old file is gone', !fs.existsSync(file) || JSON.parse(fs.readFileSync(file, 'utf8')).bootId === 'boot-B');
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }

    // ── the routes ──
    const server = require('./serverSource')();
    check('GET /api/ui/layout exists', server.includes("pathname === '/api/ui/layout' && req.method === 'GET'"));
    check('POST /api/ui/layout exists', server.includes("pathname === '/api/ui/layout' && req.method === 'POST'"));

    // ── the window side (src/js/layout-memory.js) ──
    let src = '';
    try { src = read('src/js/layout-memory.js'); } catch { check('src/js/layout-memory.js exists', false); }
    if (src) {
        const mkStore = (init) => {
            const m = new Map(Object.entries(init || {}));
            return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
        };
        const run = (server, ss, ls, url) => {
            const posts = [];
            const win = { location: { search: url || '', reloads: 0, reload() { this.reloads++; } }, sessionStorage: ss, localStorage: ls };
            const ctx = vm.createContext({
                window: win, sessionStorage: ss, localStorage: ls, location: win.location, console, URLSearchParams, JSON, setTimeout: (fn, ms) => setTimeout(fn, ms >= 1000 ? ms : 0), clearTimeout,
                token: 't',
                fetch: async (u, o) => {
                    if (o && o.method === 'POST') { posts.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) }; }
                    // `server` may be a function: the answer can change (logged out, then in).
                    const s = typeof server === 'function' ? server() : server;
                    if (s === 401) return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
                    return { ok: true, json: async () => s };
                },
            });
            vm.runInContext(src, ctx);
            return { win, posts };
        };
        // A fresh window after a TSRCT restart: empty sessionStorage, the server has the layout.
        const ss = mkStore(), ls = mkStore({ tsrct_layout_boot: 'boot-A' });
        const { win, posts } = run({ bootId: 'boot-A', values: { tsrct_split_groups: '{"g":1}', pc_sidebar_w: '300', tsrct_split_state: '{"enabled":true}' } }, ss, ls);
        check('window.pcLayout is exported', win.pcLayout && typeof win.pcLayout.restore === 'function' && typeof win.pcLayout.mirror === 'function');
        if (win.pcLayout) {
            await win.pcLayout.restore();
            check('a fresh window gets its split tabs back', ss.getItem('tsrct_split_groups') === '{"g":1}');
            check('... and its sidebar width', ss.getItem('pc_sidebar_w') === '300');
            check('... and the split view itself', ls.getItem('tsrct_split_state') === '{"enabled":true}');

            // A reload keeps its own (newer) window state.
            const ss2 = mkStore({ pc_sidebar_w: '410' }), ls2 = mkStore({ tsrct_layout_boot: 'boot-A' });
            const r2 = run({ bootId: 'boot-A', values: { pc_sidebar_w: '300' } }, ss2, ls2);
            await r2.win.pcLayout.restore();
            check('a reload keeps what that window already has', ss2.getItem('pc_sidebar_w') === '410');

            // Linux restarted: the server has nothing, and the old browser copy is wiped.
            const ss3 = mkStore(), ls3 = mkStore({ tsrct_layout_boot: 'boot-A', tsrct_split_state: '{"enabled":true,"sessions":["dead-1","dead-2"]}' });
            const r3 = run({ bootId: 'boot-B', values: {} }, ss3, ls3);
            await r3.win.pcLayout.restore();
            check('after a Linux restart the browser\'s old split view is wiped too', ls3.getItem('tsrct_split_state') === null);
            check('... and the new boot is remembered', ls3.getItem('tsrct_layout_boot') === 'boot-B');

            // Saving: every layout key of this window goes up, with its role.
            ss.setItem('pcFocusMode', '1');
            win.pcLayout.mirror();
            await new Promise(r => setTimeout(r, 30));
            const last = posts[posts.length - 1];
            check('a change is sent to the server', last && last.role === 'full' && last.values.pcFocusMode === '1' && last.values.tsrct_split_groups === '{"g":1}', JSON.stringify(last));
            const { win: w4, posts: p4 } = run({ bootId: 'boot-A', values: {} }, mkStore(), mkStore({ tsrct_layout_boot: 'boot-A' }), '?role=deck');
            await w4.pcLayout.restore();     // a window saves only after it has read the server's copy
            w4.pcLayout.mirror();
            await new Promise(r => setTimeout(r, 30));
            check('a second window saves under its own role', p4.length && p4[p4.length - 1].role === 'deck');

            // 2026-10-14, his words: "reinicie un par de veces y el layout no se esta
            // guardando". A server restart drops every login (sessions live in memory),
            // so the new window's first ask is REFUSED (401). It started empty, and once
            // he logged in its first change saved that empty layout over the good one.
            let loggedIn = false;
            const saved = { bootId: 'boot-A', values: { tsrct_split_groups: '{"g":7}', pc_sidebar_w: '419', tsrct_split_state: '{"enabled":true}' } };
            const ss5 = mkStore(), ls5 = mkStore({ tsrct_layout_boot: 'boot-A' });
            const r5 = run(() => (loggedIn ? saved : 401), ss5, ls5);
            await r5.win.pcLayout.restore();
            ss5.setItem('pc_sidebar_w', '220');          // the empty window's default, before he logs in
            r5.win.pcLayout.mirror();
            await new Promise(r => setTimeout(r, 30));
            check('a window that is not logged in yet never saves over the server copy', r5.posts.length === 0, JSON.stringify(r5.posts));
            loggedIn = true;
            await new Promise(r => setTimeout(r, 2600));
            check('once he is logged in, the saved layout is fetched again', ss5.getItem('tsrct_split_groups') === '{"g":7}' && ss5.getItem('pc_sidebar_w') === '419', `${ss5.getItem('tsrct_split_groups')} ${ss5.getItem('pc_sidebar_w')}`);
            check('... and the page reloads once so the desktop is built from it', r5.win.location.reloads === 1, `reloads ${r5.win.location.reloads}`);
            check('... and nothing empty was saved on the way', r5.posts.every(p => p.values.tsrct_split_groups === '{"g":7}'), JSON.stringify(r5.posts));
        }
    }

    // ── wiring ──
    // desktop.js plus the files cut out of it (cleanup P2 #11)
    const desk = ['desktop', 'desktop-sessions'].map(n => read(`src/js/${n}.js`)).join('\n');
    check('desktop init waits for the restore', /pcLayout\.restore\(\)[\s\S]{0,500}initDesktopMode\(\)/.test(desk));
    check('a sidebar preference change is saved', /function pcPrefSet[\s\S]{0,500}pcLayout/.test(desk));
    check('a split-tab change is saved', /function pcSplitGroupsSave[\s\S]{0,300}pcLayout/.test(desk));
    check('a split-view change is saved', /function pcSplitSave[\s\S]{0,900}pcLayout/.test(desk));
    check('the session on screen is saved', /tsrct_home_session[\s\S]{0,300}pcLayout/.test(read('src/js/gallery.js')));
    const html = read('src/index.html');
    check('index.html loads layout-memory.js before desktop.js and desktop-sessions.js', html.indexOf('/src/js/layout-memory.js') > 0 && html.indexOf('/src/js/layout-memory.js') < html.indexOf('/src/js/desktop.js')
        && html.indexOf('/src/js/layout-memory.js') < html.indexOf('/src/js/desktop-sessions.js'));
    check('sw.js caches layout-memory.js', /'\/src\/js\/layout-memory\.js'/.test(read('sw.js')));

    if (failed) { console.error(`[check-layout] ${failed} failed, ${passed} passed`); process.exit(1); }
    console.log(`[check-layout] OK -- ${passed} checks`);
})();
