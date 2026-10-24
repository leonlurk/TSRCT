// ==============================================
// TSRCT - Auto-accept
// The list of sessions whose permission requests the server approves by itself,
// mirrored here from every permissions poll, and the HUD that says what it approved.
// Cut out of main.js verbatim (cleanup round 4, 2026-10-24); it loads just before
// main.js. window.autoAcceptSessions is the same Set main.js and desktop.js read.
// ==============================================
(function () {
        // Auto-accept sessions. The SERVER owns the list and does the approving
        // (so it works with no browser open, and the phone never asks for what
        // the desktop already set to auto). This Set is a mirror of it, refreshed
        // on every permissions poll; desktop.js reads it for the buttons.
        // The old per-browser localStorage list is pushed up once, then dropped.
        let autoAcceptSessions = new Set();
        window.autoAcceptSessions = autoAcceptSessions; // Export for desktop.js access
        let autoAcceptLegacy = [];
        try { autoAcceptLegacy = JSON.parse(localStorage.getItem('autoAcceptSessions') || '[]'); } catch (e) {}
        // ═══════════════════════════════════════════════════════════
        // AUTO-ACCEPT SYSTEM
        // ═══════════════════════════════════════════════════════════

        function updateAutoAcceptButton() {
            const btn = $('auto-accept-btn');
            if (!btn) return;
            const count = autoAcceptSessions.size;
            if (count > 0) {
                btn.classList.add('active');
                $('auto-accept-label').textContent = `AUTO (${count})`;
            } else {
                btn.classList.remove('active');
                $('auto-accept-label').textContent = 'AUTO';
            }
        }
        window.updateAutoAcceptButton = updateAutoAcceptButton; // Export for desktop.js

        async function toggleAutoAcceptModal() {
            const modal = $('auto-accept-modal');
            if (!modal) return;

            // Fetch sessions
            try {
                const res = await fetch('/api/sessions', { headers: { Authorization: token } });
                const data = await res.json();
                const sessions = data.sessions || [];

                // Build session list
                const container = $('auto-accept-sessions');
                if (sessions.length === 0) {
                    container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">No active sessions</div>';
                } else {
                    container.innerHTML = sessions.map(s => `
                        <div class="auto-session-item ${autoAcceptSessions.has(s.name) ? 'selected' : ''}"
                             onclick="toggleAutoAcceptSession('${s.name}')">
                            <div class="auto-session-checkbox">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                                    <polyline points="20 6 9 17 4 12"/>
                                </svg>
                            </div>
                            <span class="auto-session-name">${s.name}</span>
                            <span class="auto-session-status">${s.attached ? 'ACTIVE' : 'idle'}</span>
                        </div>
                    `).join('');
                }
            } catch (e) {
                console.error('Failed to fetch sessions:', e);
            }

            modal.classList.remove('hidden');
        }

        function closeAutoAcceptModal() {
            const modal = $('auto-accept-modal');
            if (modal) modal.classList.add('hidden');
        }

        // Every button that lights up for auto-accept, in both layouts.
        function refreshAutoAcceptUI() {
            document.querySelectorAll('.auto-session-item').forEach(item => {
                const name = item.querySelector('.auto-session-name').textContent;
                item.classList.toggle('selected', autoAcceptSessions.has(name));
            });
            updateAutoAcceptButton();
            if (typeof window.pcUpdateAutoAcceptBtn === 'function') window.pcUpdateAutoAcceptBtn();
        }

        // Replace the mirror IN PLACE (desktop.js holds this same Set object).
        function syncAutoAccept(list) {
            if (!Array.isArray(list)) return;
            const same = list.length === autoAcceptSessions.size && list.every(s => autoAcceptSessions.has(s));
            if (same) return;
            autoAcceptSessions.clear();
            list.forEach(s => autoAcceptSessions.add(s));
            refreshAutoAcceptUI();
        }

        // The one way to change it, from any button. Optimistic, then corrected
        // by the server's answer.
        async function setAutoAccept(session, on) {
            if (!session) return;
            if (on) autoAcceptSessions.add(session); else autoAcceptSessions.delete(session);
            refreshAutoAcceptUI();
            try {
                const r = await fetch('/api/auto-accept', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ session, on: !!on })
                });
                const d = await r.json();
                if (d.autoAccept) syncAutoAccept(d.autoAccept);
                else throw new Error(d.error || 'failed');
            } catch (e) {
                toast('Auto-accept not saved: ' + e.message, 'error');
            }
        }

        function toggleAutoAcceptSession(sessionName) {
            setAutoAccept(sessionName, !autoAcceptSessions.has(sessionName));
        }

        async function clearAllAutoAccept() {
            autoAcceptSessions.clear();
            refreshAutoAcceptUI();
            try {
                const r = await fetch('/api/auto-accept', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ clear: true })
                });
                const d = await r.json();
                if (d.autoAccept) syncAutoAccept(d.autoAccept);
                toast('Auto-accept cleared', 'info');
            } catch (e) {
                toast('Auto-accept not cleared: ' + e.message, 'error');
            }
        }

        // First poll after this version loads: whatever this browser had in its
        // old local list goes up to the server, once.
        async function migrateAutoAccept(serverList) {
            const up = autoAcceptLegacy.filter(s => !serverList.includes(s));
            autoAcceptLegacy = [];
            try { localStorage.removeItem('autoAcceptSessions'); } catch (e) {}
            for (const s of up) await setAutoAccept(s, true);
        }

        // ── Auto-approve HUD ────────────────────────────────────────────────
        // Replaces the generic green "Auto-approved" toast, which said nothing
        // about WHAT was approved and looked like a phone notification. This
        // reports the tool and the session, counts a burst instead of stacking,
        // and dismisses itself on a visible drain bar. Styles: .auto-hud (main.css).
        let autoHudEl = null, autoHudTimer = 0, autoHudCount = 0, autoHudLast = 0;
        function autoApproveNotice(p) {
            if (!autoHudEl) {
                autoHudEl = document.createElement('div');
                autoHudEl.className = 'auto-hud';
                autoHudEl.innerHTML =
                    '<div class="auto-hud-row">' +
                        '<span class="auto-hud-tag">AUTO</span>' +
                        '<span class="auto-hud-title">Approved</span>' +
                        '<span class="auto-hud-count"></span>' +
                    '</div>' +
                    '<div class="auto-hud-meta"></div>' +
                    '<div class="auto-hud-bar"><i></i></div>';
                document.body.appendChild(autoHudEl);
            }
            const now = Date.now();
            // A burst of approvals counts up in place rather than flashing N times.
            autoHudCount = (now - autoHudLast < 4000) ? autoHudCount + 1 : 1;
            autoHudLast = now;

            const tool = (p && (p.tool || p.type)) || 'action';
            const session = (p && p.session) || homeSession || TMUX_SESSION || '';
            // textContent, not innerHTML -- tool/session come off the wire.
            autoHudEl.querySelector('.auto-hud-meta').textContent =
                session ? tool + '  ·  ' + session : tool;
            autoHudEl.querySelector('.auto-hud-count').textContent =
                autoHudCount > 1 ? '×' + autoHudCount : '';

            // Replay the entrance + drain even when it is already on screen.
            autoHudEl.classList.remove('show');
            void autoHudEl.offsetWidth;
            autoHudEl.classList.add('show');
            clearTimeout(autoHudTimer);
            autoHudTimer = setTimeout(() => autoHudEl && autoHudEl.classList.remove('show'), 2600);
        }

        // The server approved these by itself; the page only reports them.
        // Seen ids are remembered so a poll that repeats the last minute does
        // not replay the HUD. Anything older than this page load is skipped.
        const autoSeen = new Set();
        const autoSince = Date.now();
        function noticeAutoApproved(list) {
            if (!Array.isArray(list)) return;
            for (const a of list) {
                if (autoSeen.has(a.id)) continue;
                autoSeen.add(a.id);
                if (a.at >= autoSince) autoApproveNotice(a);
            }
            if (autoSeen.size > 200) autoSeen.clear();
        }

        // The server's list, as the permissions poll reads it: the old per-browser
        // list is pushed up once, after that the server's copy is mirrored.
        function applyServerAutoAccept(list) {
            if (autoAcceptLegacy.length) migrateAutoAccept(list);
            else syncAutoAccept(list);
        }

        // Initialize auto-accept button state on load
        setTimeout(updateAutoAcceptButton, 100);

        Object.assign(window, {
            applyServerAutoAccept, clearAllAutoAccept, closeAutoAcceptModal, noticeAutoApproved, setAutoAccept,
            toggleAutoAcceptModal, toggleAutoAcceptSession, updateAutoAcceptButton,
        });

})();
