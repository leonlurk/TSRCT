// ============================================================
//  Restart flow — styled confirm modal + boot splash
//
//  Desktop/local: the server hands off to the Windows launcher
//  (launch-tsrct.ps1), which shows Leon's native branded splash
//  tracking the REAL boot and opens a fresh app window. This tab
//  is then orphaned (handoff view + reload/close hint).
//
//  Mobile/remote: no native launcher on the phone, so we poll
//  until the bridge is back, re-auth via the trusted device,
//  stream the terminal back in, and reconnect the live UI.
//
//  Both surfaces (mobile INFO modal + desktop header) open this
//  via showRestartConfirm(). `token` + `connect` are shared
//  globals (app.js / main.js); the app.js fetch wrapper auto-
//  attaches the auth token to every /api/ request.
// ============================================================
(function () {
    const byId = (id) => document.getElementById(id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let running = false;

    function showRestartConfirm() {
        const m = byId('restart-confirm-modal');
        if (m) m.classList.remove('hidden');
    }
    function cancelRestart() {
        const m = byId('restart-confirm-modal');
        if (m) m.classList.add('hidden');
    }

    function openSplash() {
        const s = byId('restart-splash');
        if (!s) return;
        const term = byId('restart-splash-term');
        if (term) term.innerHTML = '';
        const rl = byId('restart-splash-reload');
        if (rl) rl.classList.add('hidden');
        s.classList.remove('hidden');
        requestAnimationFrame(() => s.classList.add('visible'));
    }
    function closeSplash() {
        const s = byId('restart-splash');
        if (!s) return;
        s.classList.remove('visible');
        setTimeout(() => s.classList.add('hidden'), 500);
    }
    function setPhase(t) {
        const e = byId('restart-splash-phase');
        if (e) e.textContent = t;
    }
    function log(line, cls) {
        const term = byId('restart-splash-term');
        if (!term) return;
        const d = document.createElement('div');
        d.className = 'rs-line' + (cls ? ' ' + cls : '');
        d.textContent = line;
        term.appendChild(d);
        term.scrollTop = term.scrollHeight;
    }
    function showReload() {
        const b = byId('restart-splash-reload');
        if (b) b.classList.remove('hidden');
    }

    // Trusted-device fast path (mirror of main.js tryDeviceLogin): exchange the
    // stored device token for a fresh session and reassign the shared global
    // `token` so the auto-attach fetch wrapper uses it.
    async function refreshSession() {
        const dev = localStorage.getItem('cbt_device');
        if (!dev) return false;
        try {
            const r = await fetch('/api/auth/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device: dev }),
            });
            const d = await r.json();
            if (r.ok && d.session) {
                token = d.session; // shared global (app.js)
                localStorage.setItem('cbt', token);
                return true;
            }
        } catch (e) {}
        return false;
    }

    async function confirmRestart() {
        if (running) return;
        running = true;
        cancelRestart();
        openSplash();
        setPhase('SENDING RESTART SIGNAL');
        log('[>] POST /api/restart', 'rs-cyan');

        let mode = 'respawn';
        try {
            const r = await fetch('/api/restart', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ splash: true }),
            });
            const d = await r.json().catch(() => ({}));
            if (d && d.mode) mode = d.mode;
            log('[+] Bridge acknowledged (mode: ' + mode + ')', 'rs-ok');
        } catch (e) {
            // The socket often drops as the process exits — expected.
            log('[.] Connection dropped (bridge exiting)', 'rs-muted');
        }

        if (mode === 'relaunch') await handoffToNativeSplash();
        else await reconnectFlow();
        running = false;
    }

    // Desktop/local: the Windows launcher takes over with the native splash and
    // opens a fresh app window. This tab is orphaned.
    async function handoffToNativeSplash() {
        setPhase('LAUNCHING NATIVE SPLASH');
        log('[+] Handoff to the launcher — the branded splash is opening.', 'rs-ok');
        log('[.] A fresh TSRCT window opens when the boot completes.', 'rs-muted');
        log('[.] You can close this window, or reload it to reconnect here.', 'rs-muted');
        showReload();
        // Best-effort close of the orphaned window (works in a Chrome --app window;
        // a normal tab may ignore it — hence the visible hint + RELOAD button).
        await wait(2600);
        try { window.close(); } catch (e) {}
    }

    // Mobile/remote: poll until the bridge answers again, re-auth, stream the
    // terminal in, then reconnect the live UI.
    async function reconnectFlow() {
        setPhase('WAITING FOR BRIDGE');
        await wait(1200);
        let back = false;
        for (let i = 1; i <= 45; i++) {
            log('[.] probe ' + i + ' - waiting for bridge...', 'rs-muted');
            try {
                await fetch('/api/status'); // ANY response (even 401) => it's up
                back = true;
                log('[+] Bridge is responding', 'rs-ok');
                break;
            } catch (e) { /* still down */ }
            await wait(1500);
        }
        if (!back) {
            setPhase('BRIDGE DID NOT RETURN');
            log('[!] Timed out (~70s). It may still be starting - reload manually.', 'rs-err');
            showReload();
            return;
        }

        setPhase('RE-AUTHENTICATING');
        if (await refreshSession()) log('[+] Session re-established (trusted device)', 'rs-ok');
        else log('[.] No trusted device - login may be required', 'rs-muted');

        setPhase('LOADING TERMINAL');
        log('[>] GET /api/status', 'rs-cyan');
        let status = null;
        // ?output=1 -- the splash streams the terminal, so it is one of the few
        // callers that still wants the pane capture in the status reply.
        try { status = await (await fetch('/api/status?output=1')).json(); } catch (e) {}
        if (status && !status.error && typeof status.output === 'string') {
            await streamTerminal(status.output);
        } else {
            log('[.] Terminal not available yet', 'rs-muted');
        }

        setPhase('READY');
        log('[+] READY', 'rs-ok');
        await wait(600);
        if (typeof connect === 'function') { try { connect(); } catch (e) {} }
        closeSplash();
    }

    async function streamTerminal(output) {
        const term = byId('restart-splash-term');
        if (!term) return;
        const sep = document.createElement('div');
        sep.className = 'rs-sep';
        sep.textContent = '-------- terminal --------';
        term.appendChild(sep);
        const lines = String(output).split('\n').slice(-200);
        for (let i = 0; i < lines.length; i++) {
            const d = document.createElement('div');
            d.className = 'rs-term-line';
            d.textContent = lines[i];
            term.appendChild(d);
            term.scrollTop = term.scrollHeight;
            await wait(lines.length > 80 ? 10 : 22);
        }
    }

    function reloadNow() { location.reload(); }

    Object.assign(window, {
        showRestartConfirm, cancelRestart, confirmRestart, restartReloadNow: reloadNow,
    });
})();
