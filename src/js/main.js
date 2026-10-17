// Phase 3B: IIFE-wrapped -- 40 internal fns private; explicit exports at bottom.
(function () {
        // Globals: see app.js


        // WorldManager: see world-manager.js
        // Time Chamber: see time-chamber.js
        // Nexus: see nexus.js

                // USAGE STATS SYSTEM
        // ═══════════════════════════════════════════════════════════

        // Stats tracking variables
        let statsSessionStart = Date.now();
        let statsMsgCount = parseInt(localStorage.getItem('statsMsgCount') || '0');
        let statsTranscriptions = parseInt(localStorage.getItem('statsTranscriptions') || '0');
        let statsActivityLog = JSON.parse(localStorage.getItem('statsActivityLog') || '[]');

        // Auto-accept sessions. The SERVER owns the list and does the approving
        // (so it works with no browser open, and the phone never asks for what
        // the desktop already set to auto). This Set is a mirror of it, refreshed
        // on every permissions poll; desktop.js reads it for the buttons.
        // The old per-browser localStorage list is pushed up once, then dropped.
        let autoAcceptSessions = new Set();
        window.autoAcceptSessions = autoAcceptSessions; // Export for desktop.js access
        let autoAcceptLegacy = [];
        try { autoAcceptLegacy = JSON.parse(localStorage.getItem('autoAcceptSessions') || '[]'); } catch (e) {}

        // Terminal Font Size Control
        let terminalFontSize = parseInt(localStorage.getItem('terminalFontSize') || '10');

        // Initialize font size buttons and apply saved size
        function initFontSizeSliders() {
            applyTerminalFontSize(terminalFontSize);
            updateFontButtons(terminalFontSize);
        }

        // Set and apply terminal font size (called from onclick)
        function setTerminalFontSize(size) {
            terminalFontSize = size;
            localStorage.setItem('terminalFontSize', size.toString());
            applyTerminalFontSize(size);
            updateFontButtons(size);
        }

        // Update active state on font size buttons
        function updateFontButtons(size) {
            // Main status bar buttons
            document.querySelectorAll('.font-step').forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.size) === size);
            });
            // Fullscreen header buttons
            document.querySelectorAll('.fs-font-step').forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.size) === size);
            });
        }

        // Apply font size to all terminal elements
        function applyTerminalFontSize(size) {
            const sizeRem = (size / 16).toFixed(3) + 'rem';

            // Main terminal
            const terminal = $('terminal');
            if (terminal) terminal.style.fontSize = sizeRem;

            // Fullscreen deck panels read it as a variable, so the overview's
            // tiles can still shrink it (an inline size would beat the class).
            const fsRoot = $('terminal-fs');
            if (fsRoot) fsRoot.style.setProperty('--fs-font', sizeRem);

            // Fullscreen main content
            const fsContent = $('terminal-fs-content');
            if (fsContent) fsContent.style.fontSize = sizeRem;

            console.log('[FONT] Terminal font size:', size + 'px');
        }

        // Increment message count (call from send functions)
        function trackMessageSent() {
            statsMsgCount++;
            localStorage.setItem('statsMsgCount', statsMsgCount.toString());
            logActivity('Message sent', '#00FFFF');
        }

        // Increment transcription count
        function trackTranscription() {
            statsTranscriptions++;
            localStorage.setItem('statsTranscriptions', statsTranscriptions.toString());
            logActivity('Transcription', '#FFFF00');
        }

        // Log activity with color
        function logActivity(action, color = '#00FFFF') {
            const entry = {
                time: Date.now(),
                action,
                color
            };
            statsActivityLog.unshift(entry);
            // Keep only last 50 entries
            if (statsActivityLog.length > 50) {
                statsActivityLog = statsActivityLog.slice(0, 50);
            }
            // Defer save
            if (window.requestIdleCallback) {
                requestIdleCallback(() => {
                    localStorage.setItem('statsActivityLog', JSON.stringify(statsActivityLog));
                }, { timeout: 2000 });
            } else {
                setTimeout(() => {
                    localStorage.setItem('statsActivityLog', JSON.stringify(statsActivityLog));
                }, 100);
            }
        }

        // Format session time
        function formatSessionTime(ms) {
            const seconds = Math.floor(ms / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            if (hours > 0) {
                return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
            }
            return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
        }



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

        // Initialize auto-accept button state on load
        setTimeout(updateAutoAcceptButton, 100);

        // ═══════════════════════════════════════════════════════════
        // SOUND & HAPTICS SYSTEM
        // ═══════════════════════════════════════════════════════════
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // ═══════════════════════════════════════════════════════════
        // SOUND ENGINE
        // Every sound is synthesised -- no asset files, no network, no deps.
        //
        // Why the old set sounded cheap, and what replaced it:
        //  - Gain jumped 0 -> peak instantly, which is a CLICK on every sound.
        //    Everything now opens over a few ms and closes exponentially.
        //  - Raw un-filtered oscillators (a sawtooth for 'error') are buzzy.
        //    Every voice is lowpassed, most with a moving cutoff.
        //  - No shared bus: levels drifted 0.05..0.15 and nothing was tamed.
        //    All voices now land on one bus -> limiter -> out.
        //  - No space. A short synthesised reverb gives the set a body that
        //    dry beeps cannot have.
        //  - Frequencies were arbitrary. They now come from ONE tuning (A minor,
        //    root A=220), so the whole system sounds like one instrument.
        // ═══════════════════════════════════════════════════════════

        // Pitch table -- everything below is built from these, so the sounds
        // are consonant with each other by construction.
        const NOTE = {
            A2: 110.00, E3: 164.81, A3: 220.00, C4: 261.63, D4: 293.66,
            E4: 329.63, G4: 392.00, A4: 440.00, B4: 493.88, C5: 523.25,
            D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.00, C6: 1046.50,
            E6: 1318.51,
        };

        let bus = null;      // { dry, verb } -- built on first use
        let noiseBuf = null;

        function buildBus() {
            if (bus) return bus;
            const master = audioCtx.createGain();
            master.gain.value = 0.9;
            // Soft limiter: keeps a layered sound from clipping and holds the
            // whole set at a consistent perceived level.
            const limiter = audioCtx.createDynamicsCompressor();
            limiter.threshold.value = -12;
            limiter.knee.value = 12;
            limiter.ratio.value = 4;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.15;
            master.connect(limiter).connect(audioCtx.destination);

            // Small synthesised room. Decaying noise as an impulse response --
            // no .wav to ship, and it is what stops the set sounding like a toy.
            const len = Math.floor(audioCtx.sampleRate * 1.1);
            const ir = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
            for (let ch = 0; ch < 2; ch++) {
                const d = ir.getChannelData(ch);
                for (let i = 0; i < len; i++) {
                    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
                }
            }
            const conv = audioCtx.createConvolver();
            conv.buffer = ir;
            // Darken the tail; a bright reverb on UI sounds reads as hiss.
            const tone = audioCtx.createBiquadFilter();
            tone.type = 'lowpass';
            tone.frequency.value = 3200;
            const verbGain = audioCtx.createGain();
            verbGain.gain.value = 0.9;
            conv.connect(tone).connect(verbGain).connect(master);

            bus = { dry: master, verb: conv };
            return bus;
        }

        function getNoise() {
            if (noiseBuf) return noiseBuf;
            const len = Math.floor(audioCtx.sampleRate * 0.5);
            noiseBuf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
            const d = noiseBuf.getChannelData(0);
            for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
            return noiseBuf;
        }

        // One tuned voice. attack is never 0 -- that is the anti-click rule.
        function voice(o) {
            const b = buildBus();
            const t0 = o.t0, dur = o.dur;
            const osc = audioCtx.createOscillator();
            osc.type = o.type || 'sine';
            osc.frequency.setValueAtTime(o.f0, t0);
            if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + (o.glide || dur));
            if (o.detune) osc.detune.setValueAtTime(o.detune, t0);

            let node = osc;
            if (o.lp) {
                const f = audioCtx.createBiquadFilter();
                f.type = 'lowpass';
                f.frequency.setValueAtTime(o.lp, t0);
                if (o.lp1) f.frequency.exponentialRampToValueAtTime(o.lp1, t0 + dur);
                f.Q.value = o.q || 0.7;
                node.connect(f);
                node = f;
            }
            const g = audioCtx.createGain();
            const atk = o.attack != null ? o.attack : 0.006;
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.linearRampToValueAtTime(o.gain, t0 + atk);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            node.connect(g);
            g.connect(b.dry);
            if (o.send) {
                const s = audioCtx.createGain();
                s.gain.value = o.send;
                g.connect(s).connect(b.verb);
            }
            osc.start(t0);
            osc.stop(t0 + dur + 0.03);
        }

        // Filtered noise -- the transient that makes a click read as a physical
        // event rather than a beep.
        function nvoice(o) {
            const b = buildBus();
            const t0 = o.t0, dur = o.dur;
            const src = audioCtx.createBufferSource();
            src.buffer = getNoise();
            const f = audioCtx.createBiquadFilter();
            f.type = o.filter || 'bandpass';
            f.frequency.setValueAtTime(o.f0, t0);
            if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + dur);
            f.Q.value = o.q || 1.2;
            const g = audioCtx.createGain();
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.linearRampToValueAtTime(o.gain, t0 + (o.attack != null ? o.attack : 0.003));
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            src.connect(f).connect(g);
            g.connect(b.dry);
            if (o.send) {
                const s = audioCtx.createGain();
                s.gain.value = o.send;
                g.connect(s).connect(b.verb);
            }
            src.start(t0);
            src.stop(t0 + dur + 0.03);
        }

        // ── The set ─────────────────────────────────────────────────────────
        const SOUNDS = {
            // Ambient interaction: quiet, fast, never in the way.
            tap(t) {
                // A tick, not a knock. The old recipe was an 18ms BANDPASSED noise
                // burst at 2.6kHz -- straight into a phone speaker's resonant band,
                // where it reads as a woodblock (fine through laptop speakers, which
                // is why it passed). Now the transient is HIGHPASSED air with no mid
                // content at all, under a short glassy pip an octave up.
                nvoice({ t0: t, dur: 0.012, f0: 6500, f1: 11000, gain: 0.055, filter: 'highpass', q: 0.4 });
                voice({ t0: t, dur: 0.045, f0: NOTE.E6, gain: 0.045, lp: 9000, send: 0.16 });
            },
            press(t) {
                // Every button press on a handheld. Deliberately the quietest voice
                // in the set: it sits UNDER whatever outcome sound follows (send,
                // approve, error) rather than competing with it.
                nvoice({ t0: t, dur: 0.008, f0: 6000, f1: 9500, gain: 0.032, filter: 'highpass', q: 0.4 });
                voice({ t0: t, dur: 0.028, f0: NOTE.A5, gain: 0.028, lp: 8500, send: 0.10 });
            },
            swipe(t) {
                nvoice({ t0: t, dur: 0.10, f0: 700, f1: 3200, gain: 0.20, filter: 'bandpass', q: 0.8 });
            },
            mode(t) {   // was CALLED but never defined -- silent until now
                nvoice({ t0: t, dur: 0.02, f0: 1800, gain: 0.14 });
                voice({ t0: t, dur: 0.09, f0: NOTE.D5, gain: 0.075, lp: 3000, send: 0.1 });
            },
            send(t) {
                // A bandpassed noise sweep through the low-mids is exactly the
                // shape of a raspberry -- that was the "fart". Replaced with
                // HIGHpassed air (no low-mid content at all) over a short
                // upward tick, so it reads as dispatch, not flatulence.
                nvoice({ t0: t, dur: 0.055, f0: 4200, f1: 9000, gain: 0.10, filter: 'highpass', q: 0.5 });
                voice({ t0: t, dur: 0.085, f0: NOTE.E5, f1: NOTE.A5, glide: 0.06, gain: 0.055, lp: 6500, send: 0.12 });
                voice({ t0: t + 0.02, dur: 0.10, f0: NOTE.A5, gain: 0.03, lp: 7500, send: 0.18 });
            },

            // Decisions: approve/accept read as one family, deny as its answer.
            approve(t) {
                voice({ t0: t, dur: 0.09, f0: NOTE.E5, gain: 0.07, lp: 5200, send: 0.15 });
                voice({ t0: t + 0.055, dur: 0.13, f0: NOTE.A5, gain: 0.06, lp: 6000, send: 0.2 });
            },
            accept(t) { // was CALLED but never defined -- silent until now
                voice({ t0: t, dur: 0.16, f0: NOTE.A4, gain: 0.085, lp: 4000, send: 0.18 });
                voice({ t0: t, dur: 0.16, f0: NOTE.E5, gain: 0.04, detune: 4, lp: 4000, send: 0.18 });
            },
            deny(t) {
                // A decision, not a fault: muted and low, with no buzz.
                voice({ t0: t, dur: 0.22, f0: NOTE.E3, f1: NOTE.A2, gain: 0.10, type: 'triangle', lp: 900, lp1: 400, send: 0.12 });
                voice({ t0: t, dur: 0.14, f0: NOTE.A2, gain: 0.07, lp: 500 });
            },

            // The one Leon called cheap. Rebuilt as a weighted, damped fall:
            // a low body thump, a soft transient, and a descending minor third
            // under a closing filter. Dark and short -- never a sawtooth buzz.
            error(t) {
                nvoice({ t0: t, dur: 0.05, f0: 320, gain: 0.05, filter: 'lowpass', q: 0.7 });
                voice({ t0: t, dur: 0.30, f0: NOTE.A2, gain: 0.11, type: 'sine', lp: 600 });
                voice({ t0: t, dur: 0.55, f0: NOTE.E4, f1: NOTE.C4, glide: 0.20, gain: 0.085,
                        type: 'triangle', lp: 1500, lp1: 600, attack: 0.008, send: 0.3 });
                voice({ t0: t + 0.008, dur: 0.50, f0: NOTE.A3, gain: 0.045, type: 'sine', lp: 1200, send: 0.25 });
            },
            warning(t) {
                voice({ t0: t, dur: 0.13, f0: NOTE.D5, gain: 0.06, type: 'triangle', lp: 2400, send: 0.18 });
                voice({ t0: t + 0.16, dur: 0.20, f0: NOTE.D5, gain: 0.055, type: 'triangle', lp: 2000, send: 0.22 });
            },

            // Confirmations: root -> fifth -> octave. Resolved, not cheesy.
            success(t) {
                [NOTE.A4, NOTE.E5, NOTE.A5].forEach((f, i) => {
                    const at = t + i * 0.07;
                    voice({ t0: at, dur: 0.30, f0: f, gain: 0.06, lp: 3600, lp1: 6000, send: 0.25 });
                    voice({ t0: at, dur: 0.30, f0: f, gain: 0.025, detune: 6, lp: 5000, send: 0.25 });
                });
            },
            complete(t) {
                // A long task landing: a slow swell, not a click.
                [NOTE.A3, NOTE.E4, NOTE.A4, NOTE.C5].forEach((f, i) => {
                    voice({ t0: t + i * 0.045, dur: 0.75, f0: f, gain: 0.05,
                            attack: 0.035, lp: 2600, lp1: 4200, send: 0.4 });
                });
            },
            unlock(t) {
                // Access granted -- what Windows Hello should feel like.
                voice({ t0: t, dur: 0.20, f0: NOTE.A3, gain: 0.06, lp: 1600 });
                voice({ t0: t + 0.03, dur: 0.45, f0: NOTE.A5, gain: 0.05, lp: 7000, send: 0.35 });
                voice({ t0: t + 0.10, dur: 0.50, f0: NOTE.E6, gain: 0.035, lp: 8000, send: 0.4 });
            },

            // Attention. 'permission' is TSRCT's signature event, so it is the
            // only sound that repeats -- it has to carry from another room.
            notify(t) {
                voice({ t0: t, dur: 0.45, f0: NOTE.C6, gain: 0.08, lp: 7000, send: 0.35 });
                voice({ t0: t, dur: 0.30, f0: NOTE.E6, gain: 0.02, lp: 8000, send: 0.3 });
            },
            permission(t) {
                for (let r = 0; r < 2; r++) {
                    const at = t + r * 0.19;
                    nvoice({ t0: at, dur: 0.02, f0: 3000, gain: 0.03 });
                    voice({ t0: at, dur: 0.13, f0: NOTE.D5, gain: 0.065, lp: 5000, send: 0.2 });
                    voice({ t0: at + 0.075, dur: 0.26, f0: NOTE.A5, gain: 0.06, lp: 6500, send: 0.3 });
                }
            },

            // Session lifecycle.
            connect(t) {
                [NOTE.A3, NOTE.E4, NOTE.A4].forEach((f, i) => {
                    voice({ t0: t + i * 0.05, dur: 0.26, f0: f, gain: 0.05, lp: 2200, lp1: 4500, send: 0.22 });
                });
            },
            disconnect(t) {
                [NOTE.A4, NOTE.E4, NOTE.A3].forEach((f, i) => {
                    voice({ t0: t + i * 0.06, dur: 0.30, f0: f, gain: 0.05, type: 'triangle',
                            lp: 1800, lp1: 700, send: 0.2 });
                });
            },
        };

        // Vibration patterns (ms) -- one per sound, tap as the fallback.
        const vibePatterns = {
            tap: [6], press: [4], swipe: [4], mode: [6], send: [5, 25, 8],
            approve: [6], accept: [8], deny: [25],
            error: [18, 50, 30], warning: [12, 40, 12],
            success: [8, 40, 12], complete: [10, 60, 10, 60, 16], unlock: [6, 30, 14],
            notify: [10, 50, 6], permission: [12, 60, 12, 60, 12],
            connect: [6, 30, 10], disconnect: [16, 40, 8],
        };

        // Play haptic feedback
        function vibe(pattern = 'tap') {
            if (navigator.vibrate && soundEnabled) {
                navigator.vibrate(vibePatterns[pattern] || vibePatterns.tap);
            }
        }

        // Synth sound generator
        function playSound(type = 'tap') {
            if (!soundEnabled) return;

            // Resume audio context if suspended (mobile requirement)
            if (audioCtx.state === 'suspended') audioCtx.resume();

            // Unknown names fall back to 'tap' rather than going silent -- that
            // is how 'accept' and 'mode' were dead for as long as they were.
            const make = SOUNDS[type] || SOUNDS.tap;
            try { make(audioCtx.currentTime + 0.005); } catch (e) {}

            // Vibrate too
            vibe(type);
        }

        // Toggle sounds
        function toggleSound() {
            soundEnabled = !soundEnabled;
            localStorage.setItem('soundEnabled', soundEnabled);
            updateSoundButton();
            if (soundEnabled) playSound('success');
            toast(soundEnabled ? 'SOUNDS ON' : 'SOUNDS OFF', 'success', false);
        }

        function updateSoundButton() {
            const btn = $('sound-toggle');
            if (btn) btn.classList.toggle('muted', !soundEnabled);
        }

        // Hands-Free: see hands-free.js

        // Restart server remotely
        async function restartServer() {
            if (!confirm('Restart TSRCT server?')) return;
            try {
                toast('RESTARTING...', 'warn');
                await fetch('/api/restart', { method: 'POST', headers: { Authorization: token } });
            } catch (e) {}
            // Server will die and come back — poll until it's up
            let attempts = 0;
            const reconnect = setInterval(async () => {
                attempts++;
                if (attempts > 30) { clearInterval(reconnect); playSound('warning'); toast('RESTART FAILED', 'error'); return; }
                try {
                    const r = await fetch('/api/status', { headers: { Authorization: token } });
                    const d = await r.json();
                    if (!d.error) {
                        clearInterval(reconnect);
                        playSound('complete');
                        toast('SERVER RESTARTED', 'success');
                        connect();
                    }
                } catch (e) {}
            }, 2000);
        }

        // Session lost (401) while the app is OPEN. An expired session says
        // nothing about whether the device is still trusted, so try the 30-day
        // fast path before throwing the user at a 2FA form. Returns true if the
        // session was silently restored. Only a genuinely dead/absent device
        // token falls through to the hard logout.
        async function handleSessionLost() {
            if (await tryDeviceLogin()) return true;
            handleDeauth();
            playSound('disconnect');
            toast('SESSION EXPIRED - sign in again', 'warn');
            return false;
        }

        // Deauth - clear session + trusted device and return to login
        function handleDeauth() {
            try {
                const dev = localStorage.getItem('cbt_device');
                fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token || '' },
                    body: JSON.stringify({ device: dev || undefined })
                });
            } catch (e) {}
            token = '';
            localStorage.removeItem('cbt');
            localStorage.removeItem('cbt_device');
            if ($('token')) $('token').value = '';
            if ($('totp')) $('totp').value = '';
            $('auth').classList.remove('hidden');
            $('app').classList.add('hidden');
            const qb = $('quick-bar');
            if (qb) qb.classList.add('hidden');
            // Re-evaluate which login surface to show. The page may have loaded
            // BEFORE a Hello key existed for this origin, in which case the
            // auth card is still set up for the 2FA form.
            if (window.whInit) window.whInit();
        }

        // Is the bridge reachable at all? The service worker caches the app shell,
        // so TSRCT opens perfectly with no network and every API call fails --
        // which surfaced as "wrong token" and cost an hour of chasing auth bugs.
        // ANY http response (401 included) proves reachability; only a thrown
        // fetch means no route to the server.
        async function checkServerReachable() {
            const warn = $('auth-net-warn');
            try {
                await fetch('/api/status', { headers: { Authorization: token || 'probe' } });
                if (warn) warn.classList.add('hidden');
                return true;
            } catch (e) {
                if (warn) warn.classList.remove('hidden');
                return false;
            }
        }
        window.checkServerReachable = checkServerReachable;

        // Auth - 2FA login: master token + TOTP code -> short-lived session token.
        // The session token is stored as 'cbt' so the rest of the app (and the
        // fetch wrapper) keep working unchanged. With "trust this device", a
        // long-lived device token is stored to skip 2FA next time (see tryDeviceLogin).
        async function auth(e) {
            e.preventDefault();
            const masterToken = $('token').value.trim();
            const totp = $('totp') ? $('totp').value.trim() : '';
            const remember = !!($('auth-remember') && $('auth-remember').checked);
            if (!masterToken || !totp) { toast('Token and 2FA code required', 'error'); return; }
            try {
                const r = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: masterToken, totp, remember, deviceLabel: (navigator.userAgent || '').slice(0, 60) })
                });
                if (r.status === 429) { toast('Too many attempts - locked, try later', 'error'); return; }
                const d = await r.json();
                if (!r.ok || !d.session) {
                    toast(d.need === 'totp' ? 'Wrong 2FA code' : 'ACCESS DENIED', 'error');
                    return;
                }
                token = d.session;
                localStorage.setItem('cbt', token);
                if (d.device) localStorage.setItem('cbt_device', d.device);
                if ($('totp')) $('totp').value = '';
                connect();
                // Offer Windows Hello once, right after a successful 2FA login --
                // enrolment requires a live session, and this is the only moment
                // we know we have one.
                if (window.whMaybeOfferEnroll) setTimeout(window.whMaybeOfferEnroll, 800);
            } catch (err) {
                // A thrown fetch here is a NETWORK failure, never a rejected
                // credential -- saying "login failed" sent the user hunting for
                // a wrong password when Tailscale was simply off.
                if (await checkServerReachable() === false) {
                    toast('SIN CONEXION - revisa Tailscale', 'error');
                } else {
                    toast('Login failed', 'error');
                }
            }
        }

        // Trusted-device fast path: exchange a stored device token for a fresh
        // session without re-entering 2FA. Returns true if a session was obtained.
        // Single-flight: poll() (5s) and pollPerms() (500ms) both see the same
        // 401, so without this they would race and mint two sessions, and the
        // loser would overwrite `token` with the older one.
        let deviceLoginInFlight = null;
        function tryDeviceLogin() {
            if (deviceLoginInFlight) return deviceLoginInFlight;
            deviceLoginInFlight = doDeviceLogin().finally(() => { deviceLoginInFlight = null; });
            return deviceLoginInFlight;
        }
        async function doDeviceLogin() {
            const dev = localStorage.getItem('cbt_device');
            if (!dev) return false;
            try {
                const r = await fetch('/api/auth/refresh', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device: dev })
                });
                const d = await r.json();
                if (r.ok && d.session) {
                    token = d.session;
                    localStorage.setItem('cbt', token);
                    return true;
                }
            } catch (e) {}
            localStorage.removeItem('cbt_device');
            return false;
        }

        // Connect
        async function connect() {
            console.log('[CONNECT] Starting connection...');
            try {
                // ?output=1 -- /api/status no longer ships the pane capture by
                // default (it was a duplicate of /api/output on every 5s poll).
                // This call is the terminal's FIRST paint, so it still needs it.
                const r = await fetch('/api/status?output=1', { headers: { Authorization: token } });
                const d = await r.json();
                console.log('[CONNECT] Response:', d);
                if (d.error === 'unauthorized') {
                    // Session may have expired (e.g. server restart) - try the trusted
                    // device fast path once before forcing a full 2FA login.
                    if (await tryDeviceLogin()) { connect(); return; }
                    handleDeauth();
                    toast('ACCESS DENIED', 'error');
                    return;
                }
                console.log('[CONNECT] Success! Hiding auth, showing app');
                // Coming online from the login screen gets a chime -- unless the
                // login path already played its own (Hello plays 'unlock'), or
                // the two would stack into mush.
                if ($('auth') && !$('auth').classList.contains('hidden') && !window.__authChimeDone) playSound('connect');
                window.__authChimeDone = false;
                $('auth').classList.add('hidden');
                $('app').classList.remove('hidden');
                $('quick-bar').classList.remove('hidden');
                // Adopt a real tmux session before first paint so nothing falls back
                // to a phantom 'claude' (which doesn't exist -> false OFFLINE). Mirrors
                // the desktop sidebar's adopt-first-real-session behavior.
                await adoptRealSession();
                // If we adopted a live session we're online; otherwise trust the
                // server's report for the default session.
                updateStatus(homeSession ? true : d.sessionExists, d.project);
                const term = $('terminal');
                term.textContent = d.output || '> no data';
                term.scrollTop = term.scrollHeight;
                // Update auto-accept display
                updateAutoAcceptButton();
                updateHomeSessionDisplay();
                poll();
                pollPerms();
                // Guarded: connect() now runs again after every biometric
                // re-lock, and an unguarded setInterval stacks a new timer each
                // time (the clock would tick several times a minute).
                if (!window.__sessionTimeTimer) {
                    window.__sessionTimeTimer = setInterval(updateSessionTime, 60000);
                }
            } catch (e) {
                console.error('[CONNECT] Error:', e);
                toast('CONNECTION FAILED', 'error');
                if (typeof hfSpeakError === 'function') try { hfSpeakError('Conexión fallida'); } catch(e) {} // Hands-free error
                // Pre-fill token if saved so user doesn't have to re-enter
                if (token && $('token')) {
                    $('token').value = token;
                }
            }
        }

        // Pre-fill token on page load if saved
        if (token && $('token')) {
            $('token').value = token;
        }

        function updateStatus(ok, project) {
            const s = $('status');
            s.className = 'status' + (ok ? '' : ' offline');
            s.querySelector('span').textContent = ok ? 'ONLINE' : 'OFFLINE';
        }

        // The stats bar was removed in the 2026-06-15 room cleanup, so these
        // elements may be absent. Write only if present (null-safe no-op otherwise)
        // — stats are still tracked in `stats`/localStorage regardless.
        function updateSessionTime() {
            const el = $('stat-time');
            if (!el) return;
            const mins = Math.floor((Date.now() - stats.start) / 60000);
            el.textContent = mins < 60 ? mins + 'm' : Math.floor(mins/60) + 'h';
        }

        function updateStats() {
            const c = $('stat-cmds'); if (c) c.textContent = stats.cmds;
            const e = $('stat-edits'); if (e) e.textContent = stats.edits;
            const a = $('stat-approved'); if (a) a.textContent = stats.approved;
            updateSessionTime();
            saveStats(); // Persist to localStorage
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // SMART ABBREVIATIONS - Advanced text expansion system
        // ═══════════════════════════════════════════════════════════════════════════


        // ═══════════════════════════════════════════════════════════
        // COMMAND BUILDER - Shortcuts & Actions
        // Types: 'text' (expansion), 'ctrl' (Ctrl+key), 'key' (special key)
        // ═══════════════════════════════════════════════════════════

        const DEFAULT_COMMANDS = {
            // ── ACTIONS: Terminal Control ──
            '^c': { type: 'ctrl', key: 'c', label: 'Interrupt (SIGINT)' },
            '^d': { type: 'ctrl', key: 'd', label: 'EOF / Exit' },
            '^z': { type: 'ctrl', key: 'z', label: 'Suspend process' },
            '^l': { type: 'ctrl', key: 'l', label: 'Clear screen' },
            '^a': { type: 'ctrl', key: 'a', label: 'Start of line' },
            '^e': { type: 'ctrl', key: 'e', label: 'End of line' },
            '^u': { type: 'ctrl', key: 'u', label: 'Clear line' },
            '^k': { type: 'ctrl', key: 'k', label: 'Kill to end' },
            '^w': { type: 'ctrl', key: 'w', label: 'Delete word' },
            '^r': { type: 'ctrl', key: 'r', label: 'Search history' },

            // ── ACTIONS: Special Keys ──
            '@ent': { type: 'key', key: 'Enter', label: 'Enter' },
            '@esc': { type: 'key', key: 'Escape', label: 'Escape' },
            '@tab': { type: 'key', key: 'Tab', label: 'Tab' },
            '@up': { type: 'key', key: 'Up', label: 'Arrow Up' },
            '@dn': { type: 'key', key: 'Down', label: 'Arrow Down' },

            // ── TEXT: Git shortcuts ──
            'gs': { type: 'text', value: 'git status' },
            'gd': { type: 'text', value: 'git diff' },
            'gp': { type: 'text', value: 'git pull' },
            'gps': { type: 'text', value: 'git push' },
            'ga': { type: 'text', value: 'git add .' },
            'gc': { type: 'text', value: 'git commit -m ""' },
            'gco': { type: 'text', value: 'git checkout ' },
            'gb': { type: 'text', value: 'git branch' },
            'gl': { type: 'text', value: 'git log --oneline -10' },
            'gcp': { type: 'text', value: 'git add . && git commit -m "" && git push' },
            'gst': { type: 'text', value: 'git stash' },
            'gsp': { type: 'text', value: 'git stash pop' },

            // ── TEXT: npm/node ──
            'ni': { type: 'text', value: 'npm install' },
            'nid': { type: 'text', value: 'npm install -D ' },
            'nr': { type: 'text', value: 'npm run ' },
            'nrs': { type: 'text', value: 'npm run start' },
            'nrd': { type: 'text', value: 'npm run dev' },
            'nrt': { type: 'text', value: 'npm run test' },
            'nrb': { type: 'text', value: 'npm run build' },

            // ── TEXT: Quick responses ──
            'yy': { type: 'text', value: 'y' },
            'nn': { type: 'text', value: 'n' },
            'yya': { type: 'text', value: 'yes to all' },
            'ss': { type: 'text', value: 'skip' },
            'ok': { type: 'text', value: 'looks good, continue' },
            'fx': { type: 'text', value: 'fix it' },
            'rvt': { type: 'text', value: 'revert that change' },

            // ── TEXT: Navigation ──
            '..': { type: 'text', value: 'cd ..' },
            '...': { type: 'text', value: 'cd ../..' },
            'lsa': { type: 'text', value: 'ls -la' },
            'mkd': { type: 'text', value: 'mkdir -p ' },

            // ── TEXT: Claude Code ──
            'clr': { type: 'text', value: '/clear' },
            'cmp': { type: 'text', value: '/compact' },
            'hlp': { type: 'text', value: '/help' },

            // ── TEXT: Docker ──
            'dps': { type: 'text', value: 'docker ps' },
            'dcu': { type: 'text', value: 'docker-compose up -d' },
            'dcd': { type: 'text', value: 'docker-compose down' },
        };

        let userCommands = {};
        let currentPreview = null;

        function loadAbbreviations() {
            try {
                const saved = localStorage.getItem('commandBuilder');
                if (saved) {
                    userCommands = JSON.parse(saved);
                } else {
                    // Migrate old format or use defaults
                    const oldSaved = localStorage.getItem('smartAbbreviations');
                    if (oldSaved) {
                        const old = JSON.parse(oldSaved);
                        // Convert old string format to new object format
                        userCommands = {};
                        for (const [key, val] of Object.entries(old)) {
                            if (typeof val === 'string') {
                                userCommands[key] = { type: 'text', value: val };
                            } else {
                                userCommands[key] = val;
                            }
                        }
                        saveAbbreviations();
                        localStorage.removeItem('smartAbbreviations');
                    } else {
                        userCommands = JSON.parse(JSON.stringify(DEFAULT_COMMANDS));
                    }
                }
            } catch (e) {
                userCommands = JSON.parse(JSON.stringify(DEFAULT_COMMANDS));
            }
        }

        function saveAbbreviations() {
            localStorage.setItem('commandBuilder', JSON.stringify(userCommands));
        }

        // Get display text for a command
        function getCommandDisplay(cmd) {
            if (cmd.type === 'ctrl') return `Ctrl+${cmd.key.toUpperCase()}`;
            if (cmd.type === 'key') return cmd.key;
            return cmd.value || '';
        }

        // Find matching command for current input
        function findAbbreviationMatch(text) {
            if (!text) return null;
            const lower = text.toLowerCase();

            // Exact match first
            if (userCommands[lower]) {
                const cmd = userCommands[lower];
                return {
                    abbr: lower,
                    cmd: cmd,
                    expansion: getCommandDisplay(cmd),
                    exact: true
                };
            }

            // Fuzzy: find commands that start with input (only for 2+ chars)
            if (text.length >= 2) {
                for (const [abbr, cmd] of Object.entries(userCommands)) {
                    if (abbr.startsWith(lower)) {
                        return {
                            abbr,
                            cmd,
                            expansion: getCommandDisplay(cmd),
                            exact: false
                        };
                    }
                }
            }

            return null;
        }

        // Expand abbreviation in text (for send function)
        function expandAbbreviation(text) {
            if (!text) return text;
            const match = findAbbreviationMatch(text.trim());
            if (match && match.exact && match.cmd.type === 'text') {
                return match.cmd.value;
            }
            return text;
        }

        // Global preview element
        let abbrPreviewEl = null;
        let activeAbbrInput = null;

        function getOrCreatePreview() {
            if (!abbrPreviewEl) {
                abbrPreviewEl = document.createElement('div');
                abbrPreviewEl.id = 'abbr-preview';
                abbrPreviewEl.className = 'abbr-preview';

                // Use touchend for mobile
                abbrPreviewEl.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    applyAbbrFromPreview();
                });

                // Fallback for desktop
                abbrPreviewEl.addEventListener('click', (e) => {
                    e.preventDefault();
                    applyAbbrFromPreview();
                });

                document.body.appendChild(abbrPreviewEl);
            }
            return abbrPreviewEl;
        }

        function applyAbbrFromPreview() {
            if (!activeAbbrInput || !currentPreview) return;

            const input = activeAbbrInput;
            const cmd = currentPreview.cmd;

            playSound('tap');
            hideAbbrPreview();

            if (cmd.type === 'ctrl') {
                // Send Ctrl+key
                input.value = '';
                sendCtrl(cmd.key);
            } else if (cmd.type === 'key') {
                // Send special key
                input.value = '';
                sendKey(cmd.key);
            } else {
                // Text expansion
                const expansion = cmd.value;
                input.value = expansion;

                // Re-focus and position cursor inside quotes if present
                const quotePos = expansion.indexOf('""');
                setTimeout(() => {
                    input.focus();
                    if (quotePos !== -1) {
                        input.setSelectionRange(quotePos + 1, quotePos + 1);
                    }
                }, 50);
            }
        }

        // Show inline preview hint
        function showAbbrPreview(inputEl) {
            if (!inputEl) return;
            const text = inputEl.value.trim();
            const match = findAbbreviationMatch(text);

            const preview = getOrCreatePreview();
            activeAbbrInput = inputEl;

            if (match) {
                // Position preview above input
                const rect = inputEl.getBoundingClientRect();
                preview.style.position = 'fixed';
                preview.style.left = rect.left + 'px';
                preview.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
                preview.style.width = rect.width + 'px';

                // Style based on command type
                const cmd = match.cmd;
                let typeIcon = '';
                let typeClass = '';

                if (cmd.type === 'ctrl') {
                    typeIcon = '<span class="abbr-type-icon ctrl">⌃</span>';
                    typeClass = 'ctrl';
                } else if (cmd.type === 'key') {
                    typeIcon = '<span class="abbr-type-icon key">⌨</span>';
                    typeClass = 'key';
                }

                const displayVal = match.expansion.substring(0, 30) + (match.expansion.length > 30 ? '...' : '');

                const hint = match.exact
                    ? `${typeIcon}<span class="abbr-hint-key ${typeClass}">${match.abbr}</span> <span class="abbr-hint-arrow">→</span> <span class="abbr-hint-val">${displayVal}</span> <span class="abbr-hint-tab">TAP</span>`
                    : `${typeIcon}<span class="abbr-hint-partial">${match.abbr}</span> <span class="abbr-hint-val">${displayVal}</span> <span class="abbr-hint-tab">TAP</span>`;

                preview.innerHTML = hint;
                preview.classList.add('visible');
                currentPreview = match;
            } else {
                preview.classList.remove('visible');
                currentPreview = null;
            }
        }

        // Hide preview
        function hideAbbrPreview() {
            if (abbrPreviewEl) abbrPreviewEl.classList.remove('visible');
            currentPreview = null;
            activeAbbrInput = null;
        }

        // Accept preview with Tab
        function acceptAbbrPreview(inputEl) {
            if (!currentPreview || !inputEl) return false;
            inputEl.value = currentPreview.expansion;
            hideAbbrPreview();

            // Position cursor intelligently (inside quotes if present)
            const quotePos = currentPreview.expansion.indexOf('""');
            if (quotePos !== -1) {
                inputEl.setSelectionRange(quotePos + 1, quotePos + 1);
            }

            return true;
        }

        // Initialize abbreviation system on input fields
        function initAbbrSystem() {
            // Main input on home screen
            const inputs = ['prompt', 'fs-prompt', 'omni-quick-input', 'omni-broadcast-input'];

            inputs.forEach(id => {
                const input = $(id);
                if (!input) return;

                input.addEventListener('input', () => showAbbrPreview(input));
                input.addEventListener('blur', () => setTimeout(hideAbbrPreview, 200));
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Tab' && currentPreview) {
                        e.preventDefault();
                        acceptAbbrPreview(input);
                    }
                });
            });
        }

        // Call on load
        document.addEventListener('DOMContentLoaded', initAbbrSystem);

        // ── Draft persistence ────────────────────────────────────────────────
        // A half-written prompt has to survive leaving the app: on a phone,
        // switching to another app frequently kills the PWA, so coming back is a
        // cold page load and whatever was typed is gone. The draft is written on
        // every keystroke (debounced) and dropped ONLY when the prompt is sent or
        // the user empties the box themselves -- clearing it by hand is a
        // deliberate discard, so an empty input erases the draft rather than
        // resurrecting it on the next open.
        const DRAFT_KEY = 'tsrct_draft';
        const DRAFT_INPUTS = ['prompt', 'fs-prompt'];
        let draftTimer = 0;

        function saveDraft(value) {
            clearTimeout(draftTimer);
            draftTimer = setTimeout(() => {
                try {
                    if (value && value.trim()) localStorage.setItem(DRAFT_KEY, value);
                    else localStorage.removeItem(DRAFT_KEY);
                } catch (e) { }
            }, 200);
        }

        function clearPromptDraft() {
            clearTimeout(draftTimer);
            try { localStorage.removeItem(DRAFT_KEY); } catch (e) { }
        }

        function initDrafts() {
            let saved = '';
            try { saved = localStorage.getItem(DRAFT_KEY) || ''; } catch (e) { }
            DRAFT_INPUTS.forEach(id => {
                const input = $(id);
                if (!input) return;
                if (saved && !input.value) input.value = saved;
                input.addEventListener('input', () => {
                    saveDraft(input.value);
                    // Home input and fullscreen input are two views of the same
                    // prompt -- mirror them, or switching views loses the text.
                    DRAFT_INPUTS.forEach(other => {
                        if (other === id) return;
                        const el = $(other);
                        if (el && el.value !== input.value) el.value = input.value;
                    });
                });
            });
        }
        document.addEventListener('DOMContentLoaded', initDrafts);

        // A prompt written FOR him (Tesla's draft_prompt, 2026-09-24): it lands
        // in the box he sends from, unsent, so he reads it and presses send. The
        // 'input' event is what saves the draft and mirrors the other views.
        function fillPrompt(text) {
            const t = String(text || '');
            const pcMode = document.body.classList.contains('pc-mode');
            const ids = pcMode ? ['pc-input'] : DRAFT_INPUTS;
            let done = 0;
            ids.forEach(id => {
                const el = $(id);
                if (!el) return;
                el.value = t;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                done++;
            });
            const first = $(ids[0]);
            if (first) { first.focus(); try { first.setSelectionRange(t.length, t.length); } catch (e) { } }
            if (!done) throw new Error('no encuentro la caja donde escribis');
            return true;
        }
        window.fillPrompt = fillPrompt;

        // ── Universal press feedback (handhelds) ─────────────────────────────
        // Sound was per-handler, so a button only clicked if whoever wrote it
        // remembered -- most of the quick bar, the room buttons and the modals
        // were silent. One delegated listener gives every control the same
        // response instead. Deliberate choices:
        //  - pointerdown, not click: the feedback lands on the press, which is
        //    what makes a touch UI feel immediate rather than laggy.
        //  - 'press' is the quietest voice in the set, so a button that ALSO
        //    plays an outcome sound (send/approve/error) layers a tick under it
        //    instead of doubling up.
        //  - handhelds only; desktop keeps mouse clicks silent.
        // It also doubles as the AudioContext unlock gesture, so the first real
        // sound of a session is no longer swallowed by a suspended context.
        const PRESSABLE = 'button, .quick-btn, .modal-btn, .modal-close, .session-picker-item, .btn, [role="button"]';
        function initPressFeedback() {
            if (!window.matchMedia('(pointer: coarse)').matches) return;
            document.addEventListener('pointerdown', (e) => {
                const el = e.target && e.target.closest ? e.target.closest(PRESSABLE) : null;
                if (!el || el.disabled || el.hasAttribute('data-nopress')) return;
                playSound('press');
            }, { passive: true, capture: true });
        }
        document.addEventListener('DOMContentLoaded', initPressFeedback);

        function addCommand(abbr, cmd) {
            userCommands[abbr.toLowerCase()] = cmd;
            saveAbbreviations();
            toast(`Added: ${abbr}`, 'success');
        }

        function removeAbbreviation(abbr) {
            delete userCommands[abbr];
            saveAbbreviations();
        }

        function showAbbreviationsModal() {
            const modal = $('abbreviations-modal');
            if (!modal) return;
            modal.classList.remove('hidden');
            renderAbbreviationsList();
            playSound('notify');
        }

        function hideAbbreviationsModal() {
            const modal = $('abbreviations-modal');
            if (modal) modal.classList.add('hidden');
        }

        function resetAbbreviations() {
            userCommands = JSON.parse(JSON.stringify(DEFAULT_COMMANDS));
            saveAbbreviations();
            renderAbbreviationsList();
            toast('Reset to defaults', 'success');
        }

        // ═══════════════════════════════════════════════════════════
        function renderAbbreviationsList(filter = '') {
            const list = $('abbreviations-list');
            if (!list) return;

            let entries = Object.entries(userCommands);

            // Filter if search term provided
            if (filter) {
                const f = filter.toLowerCase();
                entries = entries.filter(([abbr, cmd]) => {
                    const display = getCommandDisplay(cmd);
                    return abbr.includes(f) || display.toLowerCase().includes(f) ||
                           (cmd.label && cmd.label.toLowerCase().includes(f));
                });
            }

            // Sort: actions first (^, @), then alphabetically
            entries.sort((a, b) => {
                const aIsAction = a[0].startsWith('^') || a[0].startsWith('@');
                const bIsAction = b[0].startsWith('^') || b[0].startsWith('@');
                if (aIsAction && !bIsAction) return -1;
                if (!aIsAction && bIsAction) return 1;
                return a[0].localeCompare(b[0]);
            });

            if (entries.length === 0) {
                list.innerHTML = filter
                    ? '<div class="abbr-empty">No matches</div>'
                    : '<div class="abbr-empty">No commands</div>';
                return;
            }

            list.innerHTML = entries.map(([abbr, cmd]) => {
                const display = getCommandDisplay(cmd);
                const typeClass = cmd.type === 'ctrl' ? 'type-ctrl' :
                                  cmd.type === 'key' ? 'type-key' : 'type-text';
                const typeIcon = cmd.type === 'ctrl' ? '⌃' :
                                 cmd.type === 'key' ? '⌨' : '⌨';

                return `
                <div class="abbr-item ${typeClass}" onclick="quickUseAbbr('${escapeHtml(abbr)}')">
                    <span class="abbr-type">${cmd.type !== 'text' ? typeIcon : ''}</span>
                    <span class="abbr-key">${escapeHtml(abbr)}</span>
                    <span class="abbr-arrow">→</span>
                    <span class="abbr-value">${escapeHtml(display.substring(0, 28))}${display.length > 28 ? '...' : ''}</span>
                    <button class="abbr-delete" onclick="event.stopPropagation(); removeAbbreviation('${escapeHtml(abbr)}'); renderAbbreviationsList();">×</button>
                </div>`;
            }).join('');
        }

        // Quick use: tap command to execute it
        function quickUseAbbr(abbr) {
            const cmd = userCommands[abbr];
            if (!cmd) return;

            hideAbbreviationsModal();
            playSound('tap');

            if (cmd.type === 'ctrl') {
                sendCtrl(cmd.key);
            } else if (cmd.type === 'key') {
                sendKey(cmd.key);
            } else {
                // Text - insert into input
                const msgInput = $('prompt');
                if (msgInput) {
                    msgInput.value = cmd.value;
                    msgInput.focus();

                    // Position cursor in quotes if present
                    const quotePos = cmd.value.indexOf('""');
                    if (quotePos !== -1) {
                        setTimeout(() => {
                            msgInput.setSelectionRange(quotePos + 1, quotePos + 1);
                        }, 10);
                    }
                }
            }
        }

        function addNewAbbreviation() {
            const abbrInput = $('new-abbr-key');
            const expInput = $('new-abbr-value');
            const typeSelect = $('new-abbr-type');
            if (!abbrInput || !expInput) return;

            const abbr = abbrInput.value.trim().toLowerCase();
            const value = expInput.value.trim();
            const type = typeSelect ? typeSelect.value : 'text';

            if (!abbr || !value) {
                toast('Fill both fields', 'error');
                return;
            }

            if (abbr.includes(' ')) {
                toast('Key cannot have spaces', 'error');
                return;
            }

            let cmd;
            if (type === 'ctrl') {
                cmd = { type: 'ctrl', key: value.toLowerCase() };
            } else if (type === 'key') {
                cmd = { type: 'key', key: value };
            } else {
                cmd = { type: 'text', value: value };
            }

            addCommand(abbr, cmd);
            abbrInput.value = '';
            expInput.value = '';
            renderAbbreviationsList();
        }

        // Initialize commands on load
        loadAbbreviations();

        // ═══════════════════════════════════════════════════════════════════════════
        // END SMART FEATURES
        // ═══════════════════════════════════════════════════════════════════════════

        // Adopt a real tmux session so the mobile UI never targets a phantom
        // 'claude' default. Sets homeSession to the first live session when none
        // is chosen (or the chosen one died). No-op if a valid session is set.
        async function adoptRealSession() {
            try {
                // Wait for the multi-window roll-call: a window that opened
                // beside a live sibling must NOT adopt anything.
                if (window.tsrctPresenceReady) await window.tsrctPresenceReady;
                const r = await fetch('/api/sessions', { headers: { Authorization: token } });
                const d = await r.json();
                const names = (d.sessions || []).map(s => s.name);
                // Same shared picker desktop.js uses -- one rule, one place.
                if (homeSession && names.includes(homeSession)) return;
                homeSession = (window.pickSessionForThisWindow
                    ? window.pickSessionForThisWindow(names)
                    : names[0]) || null;
            } catch (e) { /* leave homeSession as-is on failure */ }
        }

        // ── Poll scheduling: one chain each, throttled while off-screen ───────
        // poll() (5s) and pollPerms() (500ms) are self-rescheduling loops that
        // used to run flat out whenever the app was loaded -- including with the
        // phone in a pocket, on mobile data. They now behave differently when
        // the document is hidden, because they are not worth the same:
        //   poll()      STOPS. Terminal output nobody can see is worth nothing.
        //   pollPerms() SLOWS to 3s. A pending permission still matters when
        //               TSRCT is in the background -- that is what it is FOR.
        // visibilitychange fires both immediately on return, so neither is
        // delayed while anyone is actually looking.
        //
        // Routing every reschedule through these two helpers also collapses the
        // duplicate chains the old code could start: connect() called poll()
        // directly while send()/sendKey() each did their own setTimeout(poll),
        // so several loops could run at once, each paying full freight. The
        // clearTimeout here merges them back into one.
        let pollTimer = null, permsTimer = null;
        function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }
        function schedulePerms(ms) { clearTimeout(permsTimer); permsTimer = setTimeout(pollPerms, ms); }

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || !token) return;
            schedulePoll(0);
            schedulePerms(0);
        });

        async function poll() {
            if (!token) return;
            // Off-screen: fetch NOTHING. Terminal output that nobody can see has
            // no value at any price, and visibilitychange above repaints the
            // instant the screen comes back, so this loses nothing at all.
            if (document.hidden) { schedulePoll(30000); return; }
            try {
                // Use homeSession if set, otherwise default
                if (!homeSession) {
                    // Blank slate: nothing to show until the user picks a session.
                    const t = $('terminal');
                    if (t && t.dataset.blank !== '1') {
                        t.textContent = '> no session selected -- pick one from the sidebar';
                        t.dataset.blank = '1';
                    }
                    schedulePoll(1500);
                    return;
                }
                if ($('terminal')) delete $('terminal').dataset.blank;
                const sessionToFetch = homeSession;
                const r = await fetch(`/api/output?session=${encodeURIComponent(sessionToFetch)}`, { headers: { Authorization: token } });
                const d = await r.json();
                if (d.error === 'unauthorized') {
                    if (await handleSessionLost()) schedulePoll(250);
                    return;
                }
                if (d.output) {
                    if (window.TermImg) TermImg.write($('terminal'), d.output);
                    else if (window.TermFocus) TermFocus.write($('terminal'), d.output, false);
                    else $('terminal').textContent = d.output;
                }
                // Also fetch status for connection indicator (pass active session for project detection).
                // At most every STATUS_EVERY_MS: the terminal now polls every second on the PC,
                // and the connection dot does not need to move that fast.
                if (Date.now() - lastStatusAt >= STATUS_EVERY_MS) {
                    lastStatusAt = Date.now();
                    const activeSession = typeof getCurrentTargetSession === 'function' ? getCurrentTargetSession() : (homeSession || TMUX_SESSION || 'claude');
                    const statusR = await fetch(`/api/status?session=${encodeURIComponent(activeSession)}`, { headers: { Authorization: token } });
                    const statusD = await statusR.json();
                    if (statusD.error === 'unauthorized') {
                        if (await handleSessionLost()) schedulePoll(250);
                        return;
                    }
                    updateStatus(statusD.sessionExists, statusD.project);
                }
            } catch (e) {}
            schedulePoll(terminalPollMs());
        }

        // The PC polls the terminal every second, the phone every five. Measured
        // 2026-10-05: the server answers /api/output in ~9 ms and an unchanged pane
        // is a 304 with no body, so on the PC the old 5 s wait was pure delay. The
        // phone keeps 5 s because that is mobile data (Decisions Log, 2026-08-29).
        const STATUS_EVERY_MS = 5000;
        let lastStatusAt = 0;
        function terminalPollMs() {
            return document.body.classList.contains('pc-mode') ? 1000 : 5000;
        }

        // Immediate poll for home session (called when exiting fullscreen)
        async function pollHomeSession() {
            try {
                if (!homeSession) {
                    // Blank slate: nothing to show until the user picks a session.
                    const t = $('terminal');
                    if (t && t.dataset.blank !== '1') {
                        t.textContent = '> no session selected -- pick one from the sidebar';
                        t.dataset.blank = '1';
                    }
                    return;
                }
                if ($('terminal')) delete $('terminal').dataset.blank;
                const sessionToFetch = homeSession;
                const r = await fetch(`/api/output?session=${encodeURIComponent(sessionToFetch)}`, { headers: { Authorization: token } });
                const d = await r.json();
                if (d.output) {
                    if (window.TermImg) TermImg.write($('terminal'), d.output);
                    else if (window.TermFocus) TermFocus.write($('terminal'), d.output, false);
                    else $('terminal').textContent = d.output;
                }
            } catch (e) {}
        }

        // Update the session display in terminal header
        function updateHomeSessionDisplay() {
            // A window with no session shows that it has none. It used to fall
            // back to the literal string 'claude', which read as "attached to a
            // session called claude" whether or not one existed.
            const label = homeSession || '-- pick a session --';
            const sessionLabel = $('home-session-label');
            if (sessionLabel) {
                sessionLabel.textContent = label;
            }
            // Also update PC mode elements
            const pcSessionName = document.getElementById('pc-session-name');
            if (pcSessionName) {
                pcSessionName.textContent = label;
            }
            // Refresh PC sidebar sessions
            if (typeof refreshPCSessions === 'function') {
                refreshPCSessions();
            }
            // [PB] is per session, so it follows the target like AUTO does.
            if (typeof refreshPlainBrief === 'function') {
                refreshPlainBrief();
            }
        }

        // Show session picker for home terminal
        async function showHomeSessionPicker() {
            try {
                const r = await fetch('/api/sessions', { headers: { Authorization: token } });
                const d = await r.json();
                // Only this window's workspace -- picking a session that belongs
                // to another window is exactly the mirroring we removed.
                const sessions = window.tsrctFilterSessions
                    ? window.tsrctFilterSessions(d.sessions || [])
                    : (d.sessions || []);

                if (sessions.length === 0) {
                    toast(window.tsrctIsHome && !window.tsrctIsHome()
                        ? 'New workspace - create a session with [+]'
                        : 'No sessions found', 'error');
                    return;
                }

                // Build options for the modal
                const currentSession = homeSession || TMUX_SESSION || 'claude';
                const options = sessions.map(s => ({
                    name: s.name,
                    current: s.name === currentSession
                }));

                // Create a simple picker modal
                const modal = document.createElement('div');
                modal.className = 'session-picker-modal';
                modal.innerHTML = `
                    <div class="session-picker-content">
                        <div class="session-picker-header">
                            <span>Select Session</span>
                            <button onclick="this.closest('.session-picker-modal').remove()">&times;</button>
                        </div>
                        <div class="session-picker-list">
                            ${options.map(o => `
                                <button class="session-picker-item ${o.current ? 'active' : ''}" data-session="${o.name}">
                                    ${o.name}
                                    ${o.current ? '<span class="current-badge">current</span>' : ''}
                                </button>
                            `).join('')}
                        </div>
                    </div>
                `;

                // Add click handlers
                modal.querySelectorAll('.session-picker-item').forEach(btn => {
                    btn.addEventListener('click', () => {
                        homeSession = btn.dataset.session;
                        updateHomeSessionDisplay();
                        pollHomeSession();
                        refreshProjectBadge(homeSession);
                        modal.remove();
                        toast('Switched to ' + homeSession, 'success');
                    });
                });

                // Close on backdrop click
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) modal.remove();
                });

                document.body.appendChild(modal);
            } catch (e) {
                toast('Failed to load sessions', 'error');
            }
        }

        async function pollPerms() {
            if (!token) return;
            // This one SLOWS DOWN off-screen, it does not stop. Approving a
            // permission while you are in another app is the whole point of
            // TSRCT, so the alert has to keep working with the room in the
            // background -- 3s latency instead of 0.5s, for a sixth of the
            // requests. (poll() above genuinely stops, because unseen terminal
            // output is worth nothing; a pending permission is not.)
            const idle = document.hidden;
            try {
                const r = await fetch('/api/permissions', { headers: { Authorization: token } });
                const d = await r.json();
                if (d.error === 'unauthorized') {
                    if (await handleSessionLost()) schedulePerms(250);
                    return;
                }
                if (Array.isArray(d.autoAccept)) {
                    if (autoAcceptLegacy.length) migrateAutoAccept(d.autoAccept);
                    else syncAutoAccept(d.autoAccept);
                }
                noticeAutoApproved(d.autoApproved);
                if (d.permissions && d.permissions.length > 0) {
                    // Show card if new permission or different permission
                    if (!pendingPerm || pendingPerm.id !== d.permissions[0].id) {
                        showPerm(d.permissions[0]);
                    }
                }
            } catch (e) {}
            schedulePerms(idle ? 3000 : 500);
        }

        // Permission Card
        function showPerm(p) {
            const isNew = !pendingPerm || pendingPerm.id !== p.id;

            // Check auto-accept for this session
            const permSession = p.session || homeSession || TMUX_SESSION || 'claude';
            console.log('[PERM] === PERMISSION CHECK ===');
            console.log('[PERM] p.session:', p.session);
            console.log('[PERM] homeSession:', homeSession);
            console.log('[PERM] TMUX_SESSION:', TMUX_SESSION);
            console.log('[PERM] Resolved permSession:', permSession);
            console.log('[PERM] autoAcceptSessions Set:', [...autoAcceptSessions]);
            console.log('[PERM] isNew:', isNew);
            console.log('[PERM] has(permSession):', autoAcceptSessions.has(permSession));

            // No approving here: the server already approved anything in the
            // auto list before it could reach this queue.
            console.log('[PERM] Showing permission card (not auto-approved)');

            pendingPerm = p;
            $('perm-card').classList.remove('hidden');
            const sessionLabel = p.session ? ` [${p.session}]` : '';
            const toolLabels = { Bash: 'EXEC CMD', Edit: 'EDIT FILE', Write: 'WRITE FILE', Read: 'READ FILE', WebFetch: 'FETCH', WebSearch: 'SEARCH', Grep: 'GREP', Glob: 'GLOB' };
            $('perm-title').textContent = '[ ' + (toolLabels[p.tool] || p.tool || 'TOOL') + ' ]' + sessionLabel;
            $('perm-desc').textContent = p.description || p.detail || p.file || p.command;
            if (isNew) {
                playSound('permission'); // TSRCT's signature event -- repeats so it carries from another room
                if (typeof hfSpeakPermissionAndListen === 'function') try { hfSpeakPermissionAndListen(p); } catch(e) {} // Hands-free: speak + auto-listen
            }

            // Diff preview - enhanced
            const diff = $('diff-preview');
            let html = '';

            if (p.tool === 'Bash' && p.command) {
                // Command preview
                html = '<div class="diff-header"><span class="diff-file">$ terminal</span></div>';
                html += '<div class="diff-cmd">' + escapeHtml(p.command) + '</div>';
            } else if (p.old_string || p.new_string) {
                // Edit with old/new strings - show real diff
                const fileName = p.file ? p.file.split(/[/\\]/).pop() : 'file';
                html = '<div class="diff-header"><span class="diff-file">' + escapeHtml(fileName) + '</span></div>';

                if (p.old_string) {
                    html += '<div class="diff-section"><div class="diff-label">REMOVE:</div>';
                    html += p.old_string.split('\n').map(l => '<div class="diff-del">- ' + escapeHtml(l) + '</div>').join('');
                    html += '</div>';
                }
                if (p.new_string) {
                    html += '<div class="diff-section"><div class="diff-label">ADD:</div>';
                    html += p.new_string.split('\n').map(l => '<div class="diff-add">+ ' + escapeHtml(l) + '</div>').join('');
                    html += '</div>';
                }
            } else if (p.content) {
                // Write with content
                const fileName = p.file ? p.file.split(/[/\\]/).pop() : 'file';
                html = '<div class="diff-header"><span class="diff-file">' + escapeHtml(fileName) + '</span><span class="diff-badge">NEW FILE</span></div>';
                html += '<div class="diff-section">';
                html += p.content.split('\n').slice(0, 15).map(l => '<div class="diff-add">+ ' + escapeHtml(l) + '</div>').join('');
                if (p.content.split('\n').length > 15) html += '<div class="diff-more">... +' + (p.content.split('\n').length - 15) + ' more lines</div>';
                html += '</div>';
            } else {
                html = '<div class="diff-empty">No preview available</div>';
            }

            diff.innerHTML = html;
            initSwipe();

        }


        function hidePerm() {
            $('perm-card').classList.add('hidden');
            $('perm-content').style.transform = '';
            pendingPerm = null;
        }

        async function purgeAllPermissions() {
            console.log('[PURGE] Button clicked');
            toast('Purging...', 'warning', false);
            try {
                const res = await fetch('/api/permissions/purge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token }
                });
                console.log('[PURGE] Response status:', res.status);
                const data = await res.json();
                console.log('[PURGE] Response data:', data);
                if (data.success) {
                    toast(`Purged ${data.purged} permissions`, 'success', false);
                    hidePerm();
                    playSound('deny');
                } else {
                    toast('Purge failed', 'error', false);
                }
            } catch (e) {
                console.error('[PURGE] Error:', e);
                toast('Purge error: ' + e.message, 'error', false);
            }
        }

        // escHtml removed -> use the canonical global escapeHtml (utils.js)

        // Swipe Gesture - using addEventListener with passive:false for preventDefault to work
        function initSwipe() {
            const el = $('perm-content');
            if (!el) return;
            let startX = 0;
            let startY = 0;
            let isHorizontalSwipe = false;

            el.addEventListener('touchstart', function(e) {
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                isHorizontalSwipe = false;
                this.style.transition = 'none';
            }, { passive: true });

            el.addEventListener('touchmove', function(e) {
                const dx = e.touches[0].clientX - startX;
                const dy = e.touches[0].clientY - startY;

                // Determine if horizontal swipe (more X than Y movement)
                if (!isHorizontalSwipe && Math.abs(dx) > 10) {
                    isHorizontalSwipe = Math.abs(dx) > Math.abs(dy);
                    // Once per gesture, the moment the card commits to moving --
                    // the approve/deny sound still fires on release.
                    if (isHorizontalSwipe) playSound('swipe');
                }

                if (isHorizontalSwipe) {
                    e.preventDefault(); // This works because passive:false
                    this.style.transform = 'translateX(' + dx + 'px)';
                    swipeX = dx;
                }
            }, { passive: false }); // CRITICAL: passive:false allows preventDefault

            el.addEventListener('touchend', function() {
                this.style.transition = '';
                if (swipeX > 60) { approvePerm(); }
                else if (swipeX < -60) { denyPerm(); }
                else { this.style.transform = ''; }
                swipeX = 0;
                isHorizontalSwipe = false;
            }, { passive: true });
        }

        async function approvePerm() {
            const permToProcess = pendingPerm;
            const session = (permToProcess && permToProcess.session) || homeSession || TMUX_SESSION || 'claude';

            // Mark permission as handled on server (prevents re-detection)
            if (permToProcess && permToProcess.id) {
                try {
                    await fetch('/api/permission/' + encodeURIComponent(permToProcess.id) + '/approve', { method: 'POST' });
                } catch (e) {}
            }

            // Send Enter to tmux
            try {
                await fetch('/api/permission-respond', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ response: 'y', session: session })
                });
            } catch (e) {
                console.error('[APPROVE] Failed:', e);
            }

            // Update UI
            try { stats.approved++; updateStats(); } catch(e) {}
            try { playSound('approve'); } catch(e) {}
            toast('APPROVED', 'success', false);
            hidePerm();
        }

        async function denyPerm() {
            const permToProcess = pendingPerm;
            const session = (permToProcess && permToProcess.session) || homeSession || TMUX_SESSION || 'claude';

            // Mark permission as handled on server (prevents re-detection)
            if (permToProcess && permToProcess.id) {
                try {
                    await fetch('/api/permission/' + encodeURIComponent(permToProcess.id) + '/deny', { method: 'POST' });
                } catch (e) {}
            }

            // Send Escape to tmux
            try {
                await fetch('/api/permission-respond', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ response: 'n', session: session })
                });
            } catch (e) {
                console.error('[DENY] Failed:', e);
            }

            // Update UI
            try { playSound('deny'); } catch(e) {}
            toast('DENIED', 'error', false);
            hidePerm();
        }

        // Send
        // Prepend the attachment reference headers (images/files/runners/orgs)
        // built from the global attached* arrays. Shared by send() and by the
        // dispatcher's "send polished" path so attachments work identically there.
        function buildAttachmentPrefix(p) {
            p = p || '';
            const hasRunners = typeof attachedRunners !== 'undefined' && attachedRunners.length > 0;
            const hasOrgs = typeof attachedOrgs !== 'undefined' && attachedOrgs.length > 0;

            if (typeof attachedImages !== 'undefined' && attachedImages.length > 0) {
                const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
                const images = [];
                const files = [];
                for (const path of attachedImages) {
                    const lower = path.toLowerCase();
                    if (imageExts.some(ext => lower.endsWith(ext))) images.push(path);
                    else files.push(path);
                }
                let attachmentPrefix = '';
                if (images.length > 0) attachmentPrefix += `[Images attached: ${images.join(', ')}]`;
                if (files.length > 0) {
                    if (attachmentPrefix) attachmentPrefix += ' ';
                    attachmentPrefix += `[Files attached: ${files.join(', ')}]`;
                }
                if (p) {
                    p = `${attachmentPrefix} ${p}`;
                } else {
                    const totalCount = attachedImages.length;
                    const allPaths = attachedImages.join(', ');
                    p = totalCount === 1
                        ? `I've attached a file at ${allPaths} - please analyze it`
                        : `I've attached ${totalCount} files at: ${allPaths} - please analyze them`;
                }
            }
            if (hasRunners) {
                const runnerRefs = attachedRunners.map(r =>
                    `- ${r.name}: tmux capture-pane -t ${r.session} -p -S -200`
                ).join('\n');
                p = `[Attached runner terminals - read live output via tmux]\n${runnerRefs}\n\n${p}`;
            }
            if (hasOrgs) {
                const orgRefs = attachedOrgs.map(o => {
                    let ref = `- Org: ${o.alias}`;
                    if (o.workspace) ref += ` (workspace: ${o.workspace})`;
                    ref += ` -- query via: sf data query -o ${o.alias} -q "<SOQL>" --json`;
                    return ref;
                }).join('\n');
                p = `[Attached Salesforce orgs - use sf CLI to query/interact]\n${orgRefs}\n\n${p}`;
            }
            return p;
        }

        // How many attachments are currently staged (for UI counts).
        function getAttachmentCount() {
            return (typeof attachedImages !== 'undefined' ? attachedImages.length : 0)
                 + (typeof attachedRunners !== 'undefined' ? attachedRunners.length : 0)
                 + (typeof attachedOrgs !== 'undefined' ? attachedOrgs.length : 0);
        }

        // Clear all staged attachments + refresh the indicator.
        function clearAttachments() {
            if (typeof attachedImages !== 'undefined') attachedImages = [];
            if (typeof attachedRunners !== 'undefined') attachedRunners = [];
            if (typeof attachedOrgs !== 'undefined') attachedOrgs = [];
            if (typeof updateAttachmentIndicator === 'function') updateAttachmentIndicator();
            if (typeof pcUpdateAttachIndicator === 'function') pcUpdateAttachIndicator();
        }

        // Expose for the dispatcher (separate IIFE) to reuse the same machinery.
        window.buildAttachmentPrefix = buildAttachmentPrefix;
        window.getAttachmentCount = getAttachmentCount;
        window.clearAttachments = clearAttachments;

        async function send() {
            let p = $('prompt').value.trim();
            const hasRunners = typeof attachedRunners !== 'undefined' && attachedRunners.length > 0;
            const hasOrgs = typeof attachedOrgs !== 'undefined' && attachedOrgs.length > 0;
            if (!p && attachedImages.length === 0 && !hasRunners && !hasOrgs) return;

            // Expand abbreviations
            p = expandAbbreviation(p);

            // Capture terminal state BEFORE sending (for hands-free response detection)
            const terminalBeforeSend = (typeof HF !== 'undefined' && HF.active) ? ($('terminal')?.textContent || '') : '';

            // Prepend attachment reference headers (images/files/runners/orgs).
            p = buildAttachmentPrefix(p);

            // Clear input BEFORE sending to prevent duplicates
            const originalPrompt = $('prompt').value;
            $('prompt').value = '';
            const originalImages = [...attachedImages];
            const originalRunners = hasRunners ? [...attachedRunners] : [];
            const originalOrgs = hasOrgs ? [...attachedOrgs] : [];
            attachedImages = [];
            if (hasRunners) attachedRunners = [];
            if (hasOrgs) attachedOrgs = [];
            updateAttachmentIndicator();

            try {
                // Send to current target session (active panel in fullscreen, or homeSession)
                const targetSession = getCurrentTargetSession();
                const response = await fetch('/api/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ prompt: p, session: targetSession, vault: vaultEnabled })
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                // Sent for real -- only now is the draft safe to drop (a failed
                // send restores the text below, so clearing earlier would lose it).
                clearPromptDraft();
                const fsp = $('fs-prompt');
                if (fsp) fsp.value = '';
                // Note: addChat removed - chat panel no longer exists
                playSound('send');
                toast('SENT', 'success', false);
                trackMessageSent();
                schedulePoll(1000);

                // Note: Hands-free v4 uses SSE for responses, no polling needed
            } catch (e) {
                // Restore input on error so user can retry
                $('prompt').value = originalPrompt;
                attachedImages = originalImages;
                if (originalRunners.length > 0) attachedRunners = originalRunners;
                if (originalOrgs.length > 0) attachedOrgs = originalOrgs;
                updateAttachmentIndicator();
                console.error('[SEND ERROR]', e);
                toast('SEND ERROR', 'error');
            }
        }

        // Acción de aprobar - PRIORIZA pendingPerm (lo que se muestra al usuario)
        async function approveAction() {
            // Capture the permission at decision time to avoid race conditions
            const permToProcess = pendingPerm;
            try {
                // FIRST: Use pendingPerm if available (this is what user is looking at)
                if (permToProcess) {
                    const session = permToProcess.session || homeSession || TMUX_SESSION || 'claude';
                    const permId = encodeURIComponent(permToProcess.id);
                    console.log('[BTN APPROVE] Using pendingPerm ID:', permToProcess.id, 'Session:', session);

                    // 1. Approve via API (for the hook) - with retry
                    let result = null;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            const res = await fetch('/api/permission/' + permId + '/approve', { method: 'POST' });
                            result = await res.json();
                            console.log('[BTN APPROVE] API response (attempt ' + attempt + '):', result);
                            if (result.success) break;
                        } catch (retryErr) {
                            console.warn('[BTN APPROVE] Attempt ' + attempt + ' failed:', retryErr);
                            if (attempt < 3) await new Promise(r => setTimeout(r, 300));
                        }
                    }

                    // 2. CRITICAL: Also send 'y' to tmux (for Claude's prompt)
                    try {
                        await fetch('/api/permission-respond', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ response: 'y', session: session })
                        });
                        console.log('[BTN APPROVE] Sent "y" to tmux session:', session);
                    } catch (tmuxErr) {
                        console.error('[BTN APPROVE] Failed to send "y" to tmux:', tmuxErr);
                    }

                    if (result && result.success && result.found) {
                        stats.approved++;
                        if (permToProcess.tool === 'Bash') stats.cmds++;
                        else stats.edits++;
                        updateStats();
                        playSound('approve');
                        toast('APPROVED', 'success', false);
                        if (typeof hfSpeak === 'function') try { hfSpeak(permToProcess.session ? `${permToProcess.session} aprobado` : 'Aprobado'); } catch(e) {}
                        if (typeof flashHorizonSuccess === 'function') try { flashHorizonSuccess(); } catch(e) {}
                    } else {
                        console.error('[BTN APPROVE] Permission not found or API failed:', result);
                        stats.approved++;
                        updateStats();
                        playSound('approve');
                        toast('APPROVED (sent to terminal)', 'warning', false);
                        if (typeof flashHorizonSuccess === 'function') try { flashHorizonSuccess(); } catch(e) {}
                    }
                    hidePerm();
                    if (typeof refreshNexusSessions === 'function') setTimeout(() => refreshNexusSessions(), 500);
                    return;
                }
                // FALLBACK: Fetch from server if no pendingPerm displayed
                const r = await fetch('/api/permissions', { headers: { Authorization: token } });
                const d = await r.json();
                if (d.permissions && d.permissions.length > 0) {
                    const perm = d.permissions[0];
                    const session = perm.session || homeSession || TMUX_SESSION || 'claude';
                    const permId = encodeURIComponent(perm.id);
                    console.log('[BTN APPROVE] Using server perm ID:', perm.id, 'Session:', session);

                    // 1. Approve via API
                    const res = await fetch('/api/permission/' + permId + '/approve', { method: 'POST' });
                    const result = await res.json();
                    console.log('[BTN APPROVE] Server response:', result);

                    // 2. CRITICAL: Also send 'y' to tmux
                    await fetch('/api/permission-respond', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ response: 'y', session: session })
                    });
                    console.log('[BTN APPROVE] Sent "y" to tmux session:', session);

                    if (result.success && result.found) {
                        stats.approved++;
                        if (perm.tool === 'Bash') stats.cmds++;
                        else stats.edits++;
                        updateStats();
                        playSound('approve');
                        toast('APPROVED', 'success', false);
                        if (typeof hfSpeak === 'function') try { hfSpeak(perm.session ? `${perm.session} aprobado` : 'Aprobado'); } catch(e) {}
                        if (typeof flashHorizonSuccess === 'function') try { flashHorizonSuccess(); } catch(e) {}
                    } else {
                        stats.approved++;
                        updateStats();
                        playSound('approve');
                        toast('APPROVED (sent to terminal)', 'warning', false);
                        if (typeof flashHorizonSuccess === 'function') try { flashHorizonSuccess(); } catch(e) {}
                    }
                    hidePerm();
                    pendingPerm = null;
                    if (typeof refreshNexusSessions === 'function') setTimeout(() => refreshNexusSessions(), 500);
                } else {
                    // No hay permisos, enviar 'y' a Claude
                    console.log('[BTN APPROVE] No pending permissions, sending "y"');
                    const targetSession = getCurrentTargetSession();
                    await fetch('/api/permission-respond', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ response: 'y', session: targetSession })
                    });
                    playSound('approve');
                    toast('APPROVED', 'success', false);
                    if (typeof refreshNexusSessions === 'function') setTimeout(() => refreshNexusSessions(), 500);
                }
            } catch (e) {
                console.error('[BTN APPROVE] Error:', e);
                // Emergency fallback: still try to send 'y' to tmux
                try {
                    const targetSession = getCurrentTargetSession();
                    await fetch('/api/permission-respond', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ response: 'y', session: targetSession })
                    });
                    playSound('approve');
                    toast('APPROVED (emergency)', 'warning', false);
                } catch (e2) {
                    toast('APPROVE FAILED', 'error', false);
                }
            }
        }

        // Acción de denegar - PRIORIZA pendingPerm (lo que se muestra al usuario)
        async function denyAction() {
            // Capture the permission at decision time to avoid race conditions
            const permToProcess = pendingPerm;
            try {
                // FIRST: Use pendingPerm if available (this is what user is looking at)
                if (permToProcess) {
                    const session = permToProcess.session || homeSession || TMUX_SESSION || 'claude';
                    const permId = encodeURIComponent(permToProcess.id);
                    console.log('[BTN DENY] Using pendingPerm ID:', permToProcess.id, 'Session:', session);

                    // 1. Deny via API (for the hook) - with retry
                    let result = null;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            const res = await fetch('/api/permission/' + permId + '/deny', { method: 'POST' });
                            result = await res.json();
                            console.log('[BTN DENY] API response (attempt ' + attempt + '):', result);
                            if (result.success) break;
                        } catch (retryErr) {
                            console.warn('[BTN DENY] Attempt ' + attempt + ' failed:', retryErr);
                            if (attempt < 3) await new Promise(r => setTimeout(r, 300));
                        }
                    }

                    // 2. CRITICAL: Also send 'n' to tmux (for Claude's prompt)
                    try {
                        await fetch('/api/permission-respond', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ response: 'n', session: session })
                        });
                        console.log('[BTN DENY] Sent "n" to tmux session:', session);
                    } catch (tmuxErr) {
                        console.error('[BTN DENY] Failed to send "n" to tmux:', tmuxErr);
                    }

                    if (result && result.success && result.found) {
                        playSound('deny');
                        toast('DENIED', 'error', false);
                        if (typeof hfSpeak === 'function') try { hfSpeak(permToProcess.session ? `${permToProcess.session} denegado` : 'Denegado'); } catch(e) {}
                    } else {
                        console.error('[BTN DENY] Permission not found or API failed:', result);
                        playSound('deny');
                        toast('DENIED (sent to terminal)', 'warning', false);
                    }
                    hidePerm();
                    if (typeof refreshNexusSessions === 'function') setTimeout(() => refreshNexusSessions(), 500);
                    return;
                }
                // FALLBACK: Fetch from server if no pendingPerm displayed
                const r = await fetch('/api/permissions', { headers: { Authorization: token } });
                const d = await r.json();
                if (d.permissions && d.permissions.length > 0) {
                    const perm = d.permissions[0];
                    const session = perm.session || homeSession || TMUX_SESSION || 'claude';
                    const permId = encodeURIComponent(perm.id);
                    console.log('[BTN DENY] Using server perm ID:', perm.id, 'Session:', session);

                    // 1. Deny via API
                    const res = await fetch('/api/permission/' + permId + '/deny', { method: 'POST' });
                    const result = await res.json();
                    console.log('[BTN DENY] Server response:', result);

                    // 2. CRITICAL: Also send 'n' to tmux
                    await fetch('/api/permission-respond', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ response: 'n', session: session })
                    });
                    console.log('[BTN DENY] Sent "n" to tmux session:', session);

                    if (result.success && result.found) {
                        playSound('deny');
                        toast('DENIED', 'error', false);
                        if (typeof hfSpeak === 'function') try { hfSpeak(perm.session ? `${perm.session} denegado` : 'Denegado'); } catch(e) {}
                    } else {
                        playSound('deny');
                        toast('DENIED (sent to terminal)', 'warning', false);
                    }
                    hidePerm();
                    pendingPerm = null;
                    if (typeof refreshNexusSessions === 'function') setTimeout(() => refreshNexusSessions(), 500);
                } else {
                    // No hay permisos, enviar 'n' a Claude
                    console.log('[BTN DENY] No pending permissions, sending "n"');
                    const targetSession = getCurrentTargetSession();
                    await fetch('/api/permission-respond', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ response: 'n', session: targetSession })
                    });
                    playSound('deny');
                    toast('DENIED', 'error', false);
                    if (typeof refreshNexusSessions === 'function') setTimeout(() => refreshNexusSessions(), 500);
                }
            } catch (e) {
                console.error('[BTN DENY] Error:', e);
                // Emergency fallback: still try to send 'n' to tmux
                try {
                    const targetSession = getCurrentTargetSession();
                    await fetch('/api/permission-respond', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ response: 'n', session: targetSession })
                    });
                    playSound('deny');
                    toast('DENIED (emergency)', 'warning', false);
                } catch (e2) {
                    toast('DENY FAILED', 'error', false);
                }
            }
        }

        function quick(t) {
            $('prompt').value = t; send();
        }

        // Análisis completo del proyecto
        function analyzeProject() {
            const prompt = `Perform a comprehensive deep-dive analysis of this entire project. Your goal is to become an absolute expert on this codebase so you can handle any modification, fix, or feature request with precision.

Use sub-agents (Task tool with Explore/Plan agents) if the project size or complexity warrants it. Be thorough - I need you to understand everything.

Analyze and document:

1. **Architecture & Structure**: Directory layout, module organization, design patterns used, separation of concerns

2. **Tech Stack**: All languages, frameworks, libraries, dependencies (check package.json, requirements.txt, go.mod, Cargo.toml, etc.)

3. **Entry Points & Flow**: Main entry files, how the application bootstraps, request/data flow through the system

4. **Core Components**: Key classes, functions, services, their responsibilities and how they interact

5. **Data Layer**: Database schemas, models, ORMs, data structures, state management

6. **API/Interfaces**: Endpoints, routes, external integrations, contracts

7. **Configuration**: Environment variables, config files, feature flags, secrets management

8. **Build & Deploy**: Build scripts, CI/CD, containerization, deployment targets

9. **Testing**: Test framework, coverage areas, how to run tests

10. **Code Patterns**: Naming conventions, error handling patterns, logging approach, common idioms used

After analysis, provide:
- A concise project summary (what it does, who it's for)
- Architecture diagram in ASCII if helpful
- Key files I should know about
- Any tech debt, anti-patterns, or improvement opportunities you notice
- How to run/build/test the project

Take your time, be thorough. I want you ready to tackle any task in this codebase.`;

            $('prompt').value = prompt;
            send();
            toast('SCANNING...', 'success');
        }

        // Toggle entre menus Claude/Terminal/Tools
        function setQuickMode(mode) {
            $('toggle-claude').classList.toggle('active', mode === 'claude');
            $('toggle-term').classList.toggle('active', mode === 'term');
            $('toggle-tools').classList.toggle('active', mode === 'tools');
            $('quick-claude').classList.toggle('hidden', mode !== 'claude');
            $('quick-term').classList.toggle('hidden', mode !== 'term');
            $('quick-tools').classList.toggle('hidden', mode !== 'tools');
        }

        // Enviar Ctrl+tecla
        async function sendCtrl(key) {
            try {
                const targetSession = getCurrentTargetSession();
                const r = await fetch('/api/key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ key: 'C-' + key, session: targetSession })
                });
                const d = await r.json();
                if (d.success) {
                    toast('^' + key.toUpperCase(), 'success');
                    schedulePoll(500);
                }
            } catch (e) { toast('ERROR', 'error'); }
        }

        // Ejecutar comando de terminal
        async function termCmd(cmd) {
            try {
                const targetSession = getCurrentTargetSession();
                const r = await fetch('/api/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ prompt: cmd, session: targetSession, vault: false })   // a shell command, never a prompt
                });
                toast('> ' + cmd.substring(0, 15), 'success');
                schedulePoll(500);
            } catch (e) { toast('ERROR', 'error'); }
        }

        // Switch to next tmux pane
        async function tmuxPane() {
            try {
                const targetSession = getCurrentTargetSession();
                await fetch('/api/tmux/pane', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ session: targetSession })
                });
                toast('Switched pane', 'success');
                playSound('tap');
            } catch (e) { toast('Pane switch failed', 'error'); }
        }

        // Prompt para cd a directorio custom
        function promptCd() {
            const dir = prompt('Directorio:');
            if (dir) termCmd('cd ' + dir);
        }

        // Git Rollback Modal
        function showRollbackModal() {
            $('rollback-modal').classList.remove('hidden');
            playSound('notify');
        }

        function hideRollbackModal() {
            $('rollback-modal').classList.add('hidden');
        }

        async function gitRollback(type) {
            hideRollbackModal();
            try {
                const r = await fetch('/api/git/rollback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ type })
                });
                const d = await r.json();
                if (d.success) {
                    playSound('success');
                    toast(d.message, 'success', false);
                } else {
                    playSound('error');
                    toast(d.error || 'Rollback failed', 'error', false);
                }
            } catch (e) {
                toast('ERROR: ' + e.message, 'error');
            }
        }

        // Project Switcher Modal
        async function showProjectModal() {
            $('project-modal').classList.remove('hidden');
            playSound('tap');
            // Load projects
            try {
                const r = await fetch('/api/projects', { headers: { Authorization: token } });
                const d = await r.json();
                renderProjects(d.projects || []);
            } catch (e) {
                $('project-list').innerHTML = '<div class="modal-btn-desc" style="text-align:center;padding:20px;color:var(--red)">Failed to load projects</div>';
            }
        }

        function hideProjectModal() {
            $('project-modal').classList.add('hidden');
        }

        function renderProjects(projects) {
            const list = $('project-list');
            if (!projects.length) {
                list.innerHTML = '<div class="modal-btn-desc" style="text-align:center;padding:20px">No projects found</div>';
                return;
            }
            list.innerHTML = projects.map(p => `
                <button class="modal-btn ${p.current ? 'current' : ''}" onclick="switchProject('${p.path.replace(/'/g, "\\'")}')">
                    <span class="modal-btn-title">${p.current ? '● ' : ''}${escapeHtml(p.name)}</span>
                    <span class="modal-btn-desc">${escapeHtml(p.path)}${p.hasGit ? ' • git' : ''}${p.hasPkg ? ' • npm' : ''}</span>
                </button>
            `).join('');
        }

        async function switchProject(path) {
            hideProjectModal();
            try {
                // First cd in terminal
                await termCmd('cd "' + path + '"');
                // Also change server cwd
                await fetch('/api/cwd', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ path })
                });
                playSound('success');
                toast('Switched to ' + path.split(/[/\\]/).pop(), 'success', false);
            } catch (e) {
                toast('Failed to switch', 'error');
            }
        }

        // Project Context Modal
        async function showContextModal() {
            $('context-modal').classList.remove('hidden');
            playSound('tap');
            try {
                const r = await fetch('/api/project-context', { headers: { Authorization: token } });
                const d = await r.json();
                renderContext(d);
            } catch (e) {
                $('context-body').innerHTML = '<div style="text-align:center;padding:20px;color:var(--red)">Failed to load</div>';
            }
        }
        function hideContextModal() { $('context-modal').classList.add('hidden'); }

        // Sessions Modal
        async function showSessionsModal() {
            $('sessions-modal').classList.remove('hidden');
            playSound('tap');
            try {
                const r = await fetch('/api/sessions', { headers: { Authorization: token } });
                const d = await r.json();
                renderSessions(d.sessions || [], d.current);
            } catch (e) {
                $('sessions-list').innerHTML = '<div style="text-align:center;padding:20px;color:var(--red)">Failed to load sessions</div>';
            }
        }
        function hideSessionsModal() { $('sessions-modal').classList.add('hidden'); }

        // Gallery: see gallery.js
        // OCR: see ocr.js
        // QR: see qr.js

        // ═══════════════════════════════════════════════════════════════════════
        // INITIALIZATION - Must run after all functions are defined
        // ═══════════════════════════════════════════════════════════════════════
        // Auto-connect FIRST (before any other init that might fail). Prefer the
        // trusted-device fast path when there's no live session token yet, so a
        // server restart (which clears in-memory sessions) doesn't force re-2FA.
        (async function authBootstrap() {
            checkServerReachable();
            if (!token && localStorage.getItem('cbt_device')) {
                console.log('[INIT] No session - trying trusted device...');
                await tryDeviceLogin();
            }
            if (token) {
                console.log('[INIT] Auto-connecting...');
                connect();
            }
        })();

        // Other initializations (can fail without breaking auto-connect)
        try {
            initKeyboardScroll();
            initInputDrag();
            updateSoundButton();
            hfInit();
            updateStats();
            initFontSizeSliders();
        } catch (e) {
            console.error('[INIT] Non-critical init error:', e);
        }

        // ── Public API (Phase 3B): index.html inline handlers + cross-file refs
        //    (world-manager uses playSound/vibe; everything uses send/sendCtrl) +
        //    this file's own generated onclick. autoAcceptSessions is already
        //    exported live above (Set, shared by ref). ──
        Object.assign(window, {
            send, sendCtrl, quick, termCmd, tmuxPane,
            auth, connect, poll, pollHomeSession, restartServer,
            // Exported so gallery.js pokes the SAME poll chain instead of
            // starting a parallel one (see the scheduling note above poll()).
            schedulePoll, schedulePerms,
            playSound, vibe, toggleSound, setQuickMode, setTerminalFontSize,
            approveAction, denyAction, approvePerm, denyPerm, purgeAllPermissions,
            clearAllAutoAccept, toggleAutoAcceptModal, closeAutoAcceptModal,
            toggleAutoAcceptSession, updateAutoAcceptButton, setAutoAccept,
            showAbbreviationsModal, hideAbbreviationsModal, addNewAbbreviation,
            renderAbbreviationsList, removeAbbreviation, resetAbbreviations, expandAbbreviation, quickUseAbbr,
            showContextModal, hideContextModal, showProjectModal, hideProjectModal,
            showSessionsModal, hideSessionsModal, showHomeSessionPicker, updateHomeSessionDisplay,
            showRollbackModal, hideRollbackModal, gitRollback,
            analyzeProject, switchProject, buildAttachmentPrefix, clearAttachments,
            getAttachmentCount, trackMessageSent, trackTranscription, updateStats,
            clearPromptDraft,
        });
        // Reassigned -> getter keeps window value live (external readers only):
        Object.defineProperty(window, 'userCommands', { get: () => userCommands, configurable: true });

})();
