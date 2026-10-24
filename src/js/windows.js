// ==============================================
// TSRCT - WINDOW ROLES / MULTI-MONITOR
// A window has a ROLE: what it shows and how much chrome it carries. Roles are
// not tied to a screen -- any window can take any role, and two windows swap
// with one keystroke, which is why "which monitor is the big one" never had to
// be answered.
//
// Everything here rides infrastructure that already exists:
//   - presence + session claims over BroadcastChannel('tsrct-windows')
//     (sessions.js) -- two windows already know about each other and already
//     refuse to show the same session, so a second window is not a new problem.
//   - GET /api/vnc/monitors -- the server reads the REAL Windows screen layout
//     (Screen::AllScreens) for the VNC crop, so we can place a window without
//     asking the browser for the window-management permission.
//
// Roles:
//   full  - the classic layout (sidebar + tabs + terminal). The default.
//   deck  - control surface: sidebar wide open, TOWER in the main area.
//   focus - one terminal, sidebar collapsed to its rail, no tab bar.
//   wall  - watch mode: sidebar collapsed, split view across the sessions.
// ==============================================

(function () {
    'use strict';

    const ROLES = ['full', 'deck', 'focus', 'wall'];
    const ROLE_KEY = 'tsrct_role';

    function currentRole() {
        // ?role= wins (that is how a spawned window is told what it is), then
        // this window's own stored role. Per-window on purpose: sessionStorage.
        try {
            const q = new URLSearchParams(location.search).get('role');
            if (q && ROLES.includes(q)) {
                sessionStorage.setItem(ROLE_KEY, q);
                return q;
            }
            const stored = sessionStorage.getItem(ROLE_KEY);
            if (stored && ROLES.includes(stored)) return stored;
        } catch (e) {}
        return 'full';
    }

    function setRole(role, opts) {
        if (!ROLES.includes(role)) return;
        try { sessionStorage.setItem(ROLE_KEY, role); } catch (e) {}
        applyRole(role);
        if (!opts || !opts.quiet) {
            if (typeof toast === 'function') toast('ROLE: ' + role.toUpperCase(), 'success', false);
        }
        renderRoleChip();
    }

    // Applying a role is only ever: collapse-or-not, tab-bar-or-not, and which
    // surface is mounted. No role owns markup of its own -- that is what makes a
    // swap a re-mount instead of a reload.
    function applyRole(role) {
        if (!document.body.classList.contains('pc-mode')) return;
        document.body.setAttribute('data-role', role);

        const collapse = (on) => {
            if (typeof window.pcSidebarToggleCollapse !== 'function') return;
            const sb = document.querySelector('.pc-sidebar');
            const isCollapsed = sb && sb.classList.contains('rail-only');
            if (!!on !== !!isCollapsed) window.pcSidebarToggleCollapse();
        };

        if (role === 'deck') {
            collapse(false);
            if (typeof window.pcRailSelect === 'function') window.pcRailSelect('sessions', { force: true });
            // TOWER retired 2026-09-19; the deck window now lands on the terminal.
            if (typeof window.pcSwitchTab === 'function') window.pcSwitchTab('terminal');
        } else if (role === 'focus') {
            collapse(true);
            if (typeof window.pcSwitchTab === 'function') window.pcSwitchTab('terminal');
        } else if (role === 'wall') {
            collapse(true);
            if (typeof window.pcSwitchTab === 'function') window.pcSwitchTab('terminal');
            if (typeof window.pcCombineEnable === 'function') {
                // Best effort: the split view owns its own selection rules.
                try { window.pcCombineEnable(); } catch (e) {}
            }
        } else {
            collapse(false);
        }
    }

    // ── Screen placement ────────────────────────────────────────────────────
    // The server reports Windows' own screen rectangles. Those are in Windows
    // coordinates; window.open/moveTo take CSS pixels. On this box both monitors
    // run at 150% DPI (measured: logical desktop 3627x1448 vs a 5440x2172 VNC
    // framebuffer), so the two spaces are NOT the same and assuming 1:1 is the
    // exact mistake that cost the VNC crop fix. We therefore CALIBRATE against
    // the window we are already in, and verify placement after the fact.
    async function screens() {
        try {
            const r = await fetch('/api/vnc/monitors', {
                headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
            });
            if (!r.ok) return null;
            const d = await r.json();
            return (d && d.screens && d.screens.length) ? d : null;
        } catch (e) { return null; }
    }

    // Which reported screen contains this window? Compare in the SERVER's space
    // by scaling our CSS-pixel position with the calibration factor.
    function calibration(data) {
        // window.screenX/Y are CSS px in the same origin as the virtual desktop.
        // If the browser reports a devicePixelRatio, Windows coordinates are
        // roughly cssPx * dpr for a per-monitor-DPI-unaware reporter. We do not
        // trust either: we pick the scale that puts our own window inside SOME
        // reported screen, preferring 1 (no scaling) when both work.
        const cands = [1, window.devicePixelRatio || 1];
        for (const k of cands) {
            const x = window.screenX * k, y = window.screenY * k;
            if (data.screens.some(s => x >= s.x - 2 && x < s.x + s.w && y >= s.y - 2 && y < s.y + s.h)) {
                return k;
            }
        }
        return 1;
    }

    function screenOf(data, k) {
        const x = window.screenX * k, y = window.screenY * k;
        return data.screens.find(s => x >= s.x - 2 && x < s.x + s.w && y >= s.y - 2 && y < s.y + s.h) || null;
    }

    // ── Expand to the other monitor ─────────────────────────────────────────
    // MUST be called from a click: window.open without a user gesture is blocked,
    // which is also why a layout cannot restore itself on load.
    async function expand(role) {
        role = role || 'focus';

        // PREFERRED PATH: the Window Management API. It is the only way to place a
        // window on a screen at NEGATIVE coordinates -- and Leon's second monitor
        // sits at x=-1920. Without the `window-management` permission Chrome CLAMPS
        // window.open/moveTo to the current screen, which is why the second window
        // kept appearing on the same display. getScreenDetails() itself triggers the
        // permission prompt, and we are inside a click, so it is allowed to.
        let placed = null;
        if (typeof window.getScreenDetails === 'function') {
            try {
                const det = await window.getScreenDetails();
                const cur = det.currentScreen;
                const other = det.screens.find(s2 => s2 !== cur) || det.screens[0];
                if (other) placed = { left: other.availLeft, top: other.availTop, width: other.availWidth, height: other.availHeight };
            } catch (e) { placed = null; }   // permission denied -> fall through
        }

        // FALLBACK: the server's own view of the Windows screen rectangles. Works
        // whenever the target screen is at non-negative coordinates; when it is not,
        // the browser will clamp and we say so instead of pretending it worked.
        let clampRisk = false;
        if (!placed) {
            const data = await screens();
            if (!data) {
                if (typeof toast === 'function') toast('No monitor layout available', 'error');
                return null;
            }
            const k = calibration(data);
            const here = screenOf(data, k);
            const target = data.screens.find(s2 => !here || s2.label !== here.label) || data.screens[0];
            if (!target) return null;
            const inset = 8;
            placed = {
                left: Math.round(target.x / k) + inset,
                top: Math.round(target.y / k) + inset,
                width: Math.round(target.w / k) - inset * 2,
                height: Math.round(target.h / k) - inset * 2,
            };
            clampRisk = placed.left < 0 || placed.top < 0;
        }

        const name = 'tsrct-' + role;
        const feat = `left=${placed.left},top=${placed.top},width=${placed.width},height=${placed.height},menubar=no,toolbar=no,location=no,status=no`;
        const win = window.open(`/?role=${encodeURIComponent(role)}`, name, feat);
        if (!win) {
            if (typeof toast === 'function') toast('Popup blocked - allow popups for TSRCT', 'error');
            return null;
        }

        // Ask again once it exists (Chrome often ignores the open features), then
        // VERIFY. Never report a placement we did not confirm.
        setTimeout(() => {
            try {
                win.moveTo(placed.left, placed.top);
                win.resizeTo(placed.width, placed.height);
                const landed = Math.abs(win.screenX - placed.left) < 120;
                if (!landed && typeof toast === 'function') {
                    toast(clampRisk
                        ? 'Window opened here - Chrome blocks off-screen placement. Allow "Manage windows" to auto-place, or drag it over.'
                        : 'Second window opened, but the OS placed it elsewhere', 'warn');
                }
            } catch (e) { /* cross-origin or closed */ }
        }, 250);

        try {
            localStorage.setItem('tsrct_layout', JSON.stringify({
                at: Date.now(), primary: currentRole(), secondary: role,
            }));
        } catch (e) {}
        return win;
    }

    // ── Role swap across windows ────────────────────────────────────────────
    // Reuses the presence channel. Each window applies the role it is handed and
    // re-mounts; nothing reloads, because surfaces are mountable (Phase 0).
    let chan = null;
    try { chan = new BroadcastChannel('tsrct-windows'); } catch (e) {}

    if (chan) {
        chan.addEventListener('message', (e) => {
            const m = e && e.data;
            if (!m || m.type !== 'tsrct-role') return;
            if (m.to && m.to !== currentRole()) return;   // addressed to a role
            if (m.role) setRole(m.role, { quiet: false });
        });
    }

    function swap() {
        const mine = currentRole();
        // Ask the other windows to take MY role; I take the one they had. With a
        // single window this is a no-op that still reports honestly.
        const partner = mine === 'focus' ? 'deck' : mine === 'deck' ? 'focus' : mine === 'wall' ? 'full' : 'wall';
        if (chan) chan.postMessage({ type: 'tsrct-role', role: mine, to: partner });
        setRole(partner);
    }

    // ── Chip in the PC header ───────────────────────────────────────────────
    function renderRoleChip() {
        const el = document.getElementById('pc-role-chip');
        if (el) el.textContent = currentRole().toUpperCase();
    }

    // The PC layout is built by initDesktopMode() AFTER auth, so at DOMContentLoaded
    // there is no .pc-mode and no #pc-role-chip yet: applyRole() would return
    // immediately and the role would be stored but never applied -- which is exactly
    // what happened (a window opened with ?role=focus still showed FULL and full
    // chrome). Retry until the layout exists, then stop.
    let initTries = 0;
    function init() {
        const ready = document.body.classList.contains('pc-mode') &&
                      document.getElementById('pc-role-chip');
        if (!ready) {
            if (initTries++ < 150) setTimeout(init, 200);   // up to ~30s, then give up
            return;
        }
        applyRole(currentRole());
        renderRoleChip();
    }

    // desktop.js loads BEFORE this file, so initDesktopMode() cannot call init()
    // -- it would not exist yet. Self-init instead, and cover the case where
    // DOMContentLoaded already fired (script at the end of body).
    document.addEventListener('DOMContentLoaded', init);
    setTimeout(init, 0);

    window.tsrctWindows = { currentRole, setRole, expand, swap, init, ROLES };
    window.pcExpandToScreen = (role) => expand(role || 'focus');
    window.pcSwapRoles = swap;
    window.pcCycleRole = function () {
        const i = ROLES.indexOf(currentRole());
        setRole(ROLES[(i + 1) % ROLES.length]);
    };
})();
