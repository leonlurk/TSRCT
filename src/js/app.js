// ==============================================
// TSRCT - App Core
// Globals, utilities, service worker
// ==============================================

// Where his projects live, from PROJECTS_ROOT in .env: the server writes it into
// the page (getMobileHTML) so no path on a particular machine is spelled out here.
window.TSRCT_PROJECTS_ROOT = (document.querySelector('meta[name="tsrct-projects-root"]') || {}).content || '';

// Register Service Worker for PWA installation
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js')
                .then(reg => console.log('SW registered:', reg.scope))
                .catch(err => console.log('SW registration failed:', err));
        }

        // Already running as an installed app? Covers the installed PWA, a
        // `chrome --app=URL` window, and iOS standalone. The button used to be
        // visible unconditionally (nothing ever ADDED .hidden), so it showed up
        // inside the app itself offering to install what you are already using.
        function isInstalledApp() {
            return ['standalone', 'fullscreen', 'minimal-ui'].some(m =>
                       window.matchMedia('(display-mode: ' + m + ')').matches) ||
                   window.navigator.standalone === true ||
                   document.referrer.startsWith('android-app://');
        }

        // PWA install prompt
        let deferredInstallPrompt = null;
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredInstallPrompt = e;
            if (isInstalledApp()) return;
            const btn = document.getElementById('pwa-install');
            if (btn) btn.classList.remove('hidden');
        });

        function installPWA() {
            if (!deferredInstallPrompt) {
                alert('PWA install not available. Check:\n1. chrome://flags > "insecure origins" has this URL\n2. Chrome was relaunched\n3. App is not already installed');
                return;
            }
            deferredInstallPrompt.prompt();
            deferredInstallPrompt.userChoice.then(result => {
                console.log('PWA install:', result.outcome);
                deferredInstallPrompt = null;
                const btn = document.getElementById('pwa-install');
                if (btn) btn.classList.add('hidden');
            });
        }

        window.addEventListener('appinstalled', () => {
            const btn = document.getElementById('pwa-install');
            if (btn) btn.classList.add('hidden');
            deferredInstallPrompt = null;
        });

        // Auto-fullscreen on mobile: hide browser chrome
        (function initAutoFullscreen() {
            const el = document.documentElement;
            const rfs = el.requestFullscreen || el.webkitRequestFullscreen;
            if (!rfs) return;
            // In standalone PWA, still use fullscreen for max screen space
            // Skip on desktop (PC mode handles its own layout)
            if (window.innerWidth >= 900) return;

            // First real touch triggers fullscreen
            document.addEventListener('touchend', function goFS() {
                if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                    rfs.call(el).catch(() => {});
                }
                document.removeEventListener('touchend', goFS);
            }, { once: true });

            // Also handle click (for mouse on mobile browser)
            document.addEventListener('click', function() {
                if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                    rfs.call(el).catch(() => {});
                }
            });
        })();

        // Show project name as toast on vault activation / session switch
        async function refreshProjectBadge(session) {
            try {
                const r = await fetch(`/api/status?session=${encodeURIComponent(session)}`, { headers: { Authorization: token } });
                const d = await r.json();
                if (d.error) return;
                if (d.project) {
                    toast('VAULT: ' + d.project.toUpperCase(), 'success');
                } else {
                    toast('VAULT: no project detected', 'warn');
                }
            } catch (e) {}
        }

        let token = localStorage.getItem('cbt') || '';

        // ── BIOMETRIC GATE ──────────────────────────────────────────────────
        // On a handheld that has a passkey enrolled for this origin, EVERY open
        // costs a fingerprint. A session survives the app being closed (it is a
        // sliding idle window, and the token sits in localStorage), so without
        // this the app would auto-connect on load and never reach the unlock
        // screen at all -- which is why the phone's credential showed as never
        // used. Dropped here, synchronously, because `authBootstrap()` in
        // main.js auto-connects the moment a token exists; an async check would
        // lose the race. webauthn.js owns the flag.
        (function biometricGate() {
            try {
                if (localStorage.getItem('tsrct_biometric_lock') !== '1') return;
                const handheld = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 900;
                if (!handheld) return;
                // GRACE WINDOW -- the resume path (visibilitychange in webauthn.js)
                // always had one, but backgrounding a PWA on Android often kills it,
                // so you come back through a fresh PAGE LOAD and land here instead:
                // the gate asked for a thumb after a two-second glance, and after a
                // manual pull-to-refresh. webauthn.js heartbeats `tsrct_last_seen`
                // while the app is visible and stamps it on hide; keep this window
                // in sync with RELOCK_AFTER_MS there. Missing stamp = lock (a first
                // open, or storage cleared, is a real open).
                const GRACE_MS = 30000;
                const seen = parseInt(localStorage.getItem('tsrct_last_seen') || '0', 10);
                if (seen && Date.now() - seen < GRACE_MS) return;
                token = '';
                localStorage.removeItem('cbt');
            } catch (e) {}
        })();
        let vaultEnabled = localStorage.getItem('vault_enabled') !== 'false'; // on by default

        // Auto-attach the bridge token to every same-origin /api/ request so the
        // server can require auth on ALL endpoints (closes unauthenticated access
        // over the public tunnel). Reads `token` at call time, so re-auth works.
        // /images/ stays public (img tags); SSE/WS pass their token via ?token=.
        (function () {
            const rawFetch = window.fetch.bind(window);
            window.fetch = function (input, init) {
                const u = typeof input === 'string' ? input : (input && input.url) || '';
                if (token && u.startsWith('/api/')) {
                    init = Object.assign({}, init);
                    const h = new Headers(init.headers || {});
                    if (!h.has('Authorization')) h.set('Authorization', token);
                    init.headers = h;
                }
                return rawFetch(input, init);
            };
        })();

        function toggleVault() {
            vaultEnabled = !vaultEnabled;
            localStorage.setItem('vault_enabled', vaultEnabled);
            // Sync both mobile and desktop toggles
            ['vault-toggle', 'pc-vault-toggle'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) btn.classList.toggle('active', vaultEnabled);
            });
            // Show project toast when activating vault
            if (vaultEnabled) {
                refreshProjectBadge(typeof targetSession !== 'undefined' ? targetSession : 'claude');
            } else {
                toast('VAULT OFF', 'warn');
            }
        }

        // Reset vault cycle for current session
        async function resetVaultCycle() {
            const session = typeof getCurrentTargetSession === 'function'
                ? getCurrentTargetSession()
                : (typeof homeSession !== 'undefined' && homeSession) || 'claude';
            try {
                await fetch('/api/vault/reset', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ session })
                });
                toast('VAULT RESET: ' + session, 'success');
            } catch (e) {
                toast('VAULT RESET FAILED', 'error');
            }
        }

        // ── [PB] PLAIN BRIEF ────────────────────────────────────────────────
        // Unlike the vault toggle above, this state lives on the SERVER, not in
        // localStorage, and it is per tmux session. Two reasons, both load-bearing:
        // the thing that enforces it is a pair of Claude Code hooks reading a file
        // on disk, so a browser-only flag would be invisible to them; and it has to
        // apply to prompts Leon types straight into the pane, which never pass
        // through this app at all.
        let pbSessionOf = () => (typeof getCurrentTargetSession === 'function'
            ? getCurrentTargetSession()
            : (typeof homeSession !== 'undefined' && homeSession) || 'claude');

        function pbPaint(on) {
            ['pb-toggle', 'pc-pb-toggle'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) btn.classList.toggle('active', !!on);
            });
        }

        // Read the flag for whatever session the UI is pointed at. Called on load
        // and on every session switch -- never on a timer, because a per-session
        // flag that nobody is looking at is not worth a poll (gotcha 26).
        async function refreshPlainBrief() {
            const session = pbSessionOf();
            if (!session) return;
            try {
                const r = await fetch('/api/plainbrief?session=' + encodeURIComponent(session), {
                    headers: { Authorization: token }
                });
                if (!r.ok) return;
                const s = await r.json();
                pbPaint(s.on);
            } catch (e) { /* offline: leave the button as it is, do not lie */ }
        }

        async function togglePlainBrief() {
            const session = pbSessionOf();
            if (!session) { if (typeof toast === 'function') toast('NO SESSION', 'warn'); return; }
            try {
                const r = await fetch('/api/plainbrief/toggle', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ session })
                });
                const s = await r.json();
                if (!r.ok || !s.ok) throw new Error(s.error || 'toggle failed');
                pbPaint(s.on);
                if (typeof toast === 'function') {
                    toast(s.on ? `PLAIN BRIEF ON: ${session} (${s.cap}w)` : `PLAIN BRIEF OFF: ${session}`,
                          s.on ? 'success' : 'warn');
                }
            } catch (e) {
                if (typeof toast === 'function') toast('PB TOGGLE FAILED', 'error');
            }
        }

        // Init vault toggle state on load
        document.addEventListener('DOMContentLoaded', () => {
            const btn = document.getElementById('vault-toggle');
            if (btn) btn.classList.toggle('active', vaultEnabled);
            refreshPlainBrief();
        });

        // Stats persistence - reset after 30 mins of inactivity
        const STATS_TIMEOUT = 30 * 60 * 1000; // 30 minutes
        const STATS_KEY = 'bridge_stats';

        function loadStats() {
            try {
                const saved = localStorage.getItem(STATS_KEY);
                if (saved) {
                    const data = JSON.parse(saved);
                    const lastActive = data.lastActive || data.start;
                    const timeSinceActive = Date.now() - lastActive;

                    // Reset if inactive for too long
                    if (timeSinceActive > STATS_TIMEOUT) {
                        return { cmds: 0, edits: 0, approved: 0, start: Date.now(), lastActive: Date.now() };
                    }
                    // Keep the stats but update lastActive
                    data.lastActive = Date.now();
                    return data;
                }
            } catch (e) {}
            return { cmds: 0, edits: 0, approved: 0, start: Date.now(), lastActive: Date.now() };
        }

        function saveStats() {
            try {
                stats.lastActive = Date.now();
                localStorage.setItem(STATS_KEY, JSON.stringify(stats));
            } catch (e) {}
        }

        let stats = loadStats();

        // Track visibility to update lastActive and check for timeout on return
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                // Returning to app - check if we should reset
                const saved = localStorage.getItem(STATS_KEY);
                if (saved) {
                    try {
                        const data = JSON.parse(saved);
                        const timeSinceActive = Date.now() - (data.lastActive || data.start);
                        if (timeSinceActive > STATS_TIMEOUT) {
                            // Reset stats
                            stats = { cmds: 0, edits: 0, approved: 0, start: Date.now(), lastActive: Date.now() };
                            saveStats();
                            updateStats();
                        }
                    } catch (e) {}
                }
                stats.lastActive = Date.now();
                saveStats();
            } else {
                // Leaving app - save current state
                saveStats();
            }
        });

        let pendingPerm = null;
        let chatHistory = [];
        let swipeX = 0;
        let attachedImages = []; // Paths de imágenes adjuntas
        let attachedRunners = []; // Runner terminals adjuntos { id, name, session }
        let attachedOrgs = []; // SF orgs adjuntas { alias, workspace }

        // SF CLI lazy loader
        var sfCliLoaded = false;
        var sfCliLoading = null;
        function loadSfCli() {
            if (sfCliLoaded) return Promise.resolve();
            if (sfCliLoading) return sfCliLoading;
            sfCliLoading = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = '/src/js/sf-cli.js';
                s.onload = () => {
                    sfCliLoaded = true;
                    sfCliLoading = null;
                    if (typeof sfBootstrap === 'function') sfBootstrap();
                    resolve();
                };
                s.onerror = () => {
                    sfCliLoading = null;
                    reject(new Error('Failed to load sf-cli.js'));
                };
                document.head.appendChild(s);
            });
            return sfCliLoading;
        }
        function showOrgAttachPicker() {
            loadSfCli().then(() => {
                if (typeof showOrgAttachPickerImpl === 'function') showOrgAttachPickerImpl();
            });
        }

        let recognition = null; // Speech recognition
        let isRecording = false;
        let wantRecording = false; // Para mantener grabación activa
        let speechLang = 'es-ES'; // Idioma de dictado (es-ES o en-US)
        let soundEnabled = localStorage.getItem('soundEnabled') !== 'false'; // Sounds on by default

        const $ = id => document.getElementById(id);

        // Eye protection mode
        function toggleEyeProtect() {
            const on = document.body.classList.toggle('eye-protect');
            localStorage.setItem('eyeProtect', on ? '1' : '0');
            if (typeof toast === 'function') toast(on ? 'Eye protect ON' : 'Eye protect OFF', on ? 'success' : 'info');
        }
        // Restore on load
        if (localStorage.getItem('eyeProtect') === '1') document.body.classList.add('eye-protect');

        // leonlurk navy theme (brand palette). Independent from eye-protect; green stays the default.
        function toggleNavyTheme() {
            const on = document.body.classList.toggle('theme-navy');
            localStorage.setItem('navyTheme', on ? '1' : '0');
            if (typeof toast === 'function') toast(on ? 'Navy theme ON' : 'Navy theme OFF', on ? 'success' : 'info');
        }
        // Restore on load
        if (localStorage.getItem('navyTheme') === '1') document.body.classList.add('theme-navy');

