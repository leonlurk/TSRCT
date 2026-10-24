// ==============================================
// TSRCT - Sessions: the sessions modal, the phone deck, window presence, toast
// Was gallery.js until 2026-10-24, when the gallery itself moved to attachments.js. This
// file keeps what the rest of the app shares: toast, getCurrentTargetSession, the
// live homeSession proxy and the multi-window roll-call, plus the mobile session
// modal, the fullscreen input and mic, and the deck of split panels.
// Phase 3B: IIFE-wrapped; explicit exports at bottom.
// ==============================================
(function () {

        function renderSessions(sessions, current) {
            // Mobile session modal -- same workspace filter as the PC sidebar.
            sessions = filterVisibleSessions(sessions);
            if (!sessions.length) {
                $('sessions-list').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">No tmux sessions found</div>';
                return;
            }
            $('sessions-list').innerHTML = sessions.map(s => `
                <div style="display:flex;gap:6px;align-items:stretch">
                    <button class="modal-btn ${s.current ? 'current' : ''}" style="flex:1" onclick="switchSession('${s.name.replace(/'/g, "\\'")}')">
                        <span class="modal-btn-title">${s.current ? '● ' : ''}${s.protected ? '[P] ' : ''}${escapeHtml(s.name)}${window.SessionWeight ? window.SessionWeight.badge(s.name) : ''}</span>
                        <span class="modal-btn-desc">${s.windows} win${s.attached ? ' • attached' : ''}${s.protected ? ' • server' : ''}</span>
                    </button>
                    ${s.protected ? '' : `<button class="modal-btn danger" style="width:44px;display:flex;align-items:center;justify-content:center" onclick="killSession('${s.name.replace(/'/g, "\\'")}')">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>`}
                </div>
            `).join('');
        }
        async function switchSession(name) {
            hideSessionsModal();
            try {
                const r = await fetch('/api/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ session: name })
                });
                const d = await r.json();
                if (d.success) {
                    homeSession = name; // Update local session tracker
                    updateHomeSessionDisplay(); // Update UI label
                    $('terminal').textContent = '> Switched to ' + name + '...'; // Clear old output
                    playSound('success');
                    toast('Session: ' + name, 'success', false);
                    schedulePoll(300); // Poll faster to show new content
                } else {
                    playSound('error');
                    toast(d.error || 'Failed', 'error', false);
                }
            } catch (e) {
                toast('Error switching session', 'error');
            }
        }
        async function createNewSession() {
            const name = prompt('Session name (leave empty for auto):');
            if (name === null) return; // cancelled
            hideSessionsModal();
            try {
                const r = await fetch('/api/session/new', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ name: name || '' })
                });
                const d = await r.json();
                if (d.success) {
                    // Auto-switch to the new session, and claim it for this window.
                    if (window.tsrctOwnSession) window.tsrctOwnSession(d.session);
                    homeSession = d.session;
                    updateHomeSessionDisplay();
                    $('terminal').textContent = '> New session: ' + d.session;
                    playSound('success');
                    toast('Created & switched: ' + d.session, 'success', false);
                    schedulePoll(300);
                } else {
                    playSound('error');
                    toast(d.error || 'Failed', 'error', false);
                }
            } catch (e) {
                toast('Error creating session', 'error');
            }
        }
        async function killSession(name) {
            if (!confirm('Kill session "' + name + '"?')) return;
            try {
                const r = await fetch('/api/session/kill', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ name })
                });
                const d = await r.json();
                if (d.success) {
                    playSound('deny');
                    toast('Killed: ' + name, 'error', false);
                    showSessionsModal(); // Refresh list
                } else {
                    playSound('error');
                    toast(d.error || 'Failed', 'error', false);
                }
            } catch (e) {
                toast('Error killing session', 'error');
            }
        }
        function renderContext(ctx) {
            if (ctx.error) { $('context-body').innerHTML = '<div style="text-align:center;padding:20px;color:var(--red)">' + escapeHtml(ctx.error) + '</div>'; return; }
            let h = '<div class="ctx-section"><div class="ctx-label">Project</div><div class="ctx-value">' + escapeHtml(ctx.projectName) + '</div><div style="font-size:0.5rem;color:var(--text-muted)">' + escapeHtml(ctx.path) + '</div></div>';
            if (ctx.branch && ctx.branch !== 'N/A') {
                h += '<div class="ctx-section"><div class="ctx-label">Git</div><div class="ctx-branch">' + escapeHtml(ctx.branch) + '</div>';
                if (ctx.lastCommit) h += '<div class="ctx-commit">' + escapeHtml(ctx.lastCommit) + '</div>';
                h += '</div>';
            }
            if (ctx.gitStatus) h += '<div class="ctx-section"><div class="ctx-label">Changes</div><div class="ctx-changes">' + escapeHtml(ctx.gitStatus) + '</div></div>';
            if (ctx.packageInfo) {
                const p = ctx.packageInfo;
                h += '<div class="ctx-section"><div class="ctx-label">Package</div><div class="ctx-stats"><div class="ctx-stat"><div class="ctx-stat-val">' + p.version + '</div><div class="ctx-stat-lbl">Ver</div></div><div class="ctx-stat"><div class="ctx-stat-val">' + p.deps + '</div><div class="ctx-stat-lbl">Deps</div></div><div class="ctx-stat"><div class="ctx-stat-val">' + p.devDeps + '</div><div class="ctx-stat-lbl">Dev</div></div></div>';
                if (p.scripts && p.scripts.length) h += '<div class="ctx-pkg">' + p.scripts.map(s => '<span class="ctx-pkg-item">' + s + '</span>').join('') + '</div>';
                h += '</div>';
            }
            if (ctx.tree) h += '<div class="ctx-section"><div class="ctx-label">Tree</div><div class="ctx-tree">' + escapeHtml(ctx.tree) + '</div></div>';
            if (ctx.readme) h += '<div class="ctx-section"><div class="ctx-label">README</div><div class="ctx-readme">' + escapeHtml(ctx.readme) + '</div></div>';
            $('context-body').innerHTML = h;
        }

        // Speech Recognition
        function initSpeechRecognition() {
            const rec = createSpeechRecognizer({
                continuous: false, // Desactivado para evitar duplicación
                interimResults: false, // Solo resultados finales
                lang: speechLang, // Usar idioma seleccionado
                onResult: (e) => {
                    let transcript = '';
                    for (let i = e.resultIndex; i < e.results.length; i++) {
                        transcript += e.results[i][0].transcript;
                    }
                    // Actualizar input con el texto reconocido
                    const input = $('prompt');
                    const existing = input.dataset.preVoice || '';
                    input.value = existing + transcript;
                },
                onStart: () => {
                    isRecording = true;
                    $('mic-btn').classList.add('recording');
                    $('prompt').dataset.preVoice = $('prompt').value;
                    toast('LISTENING...', 'success');
                },
                onEnd: () => {
                    isRecording = false;
                    $('mic-btn').classList.remove('recording');
                    delete $('prompt').dataset.preVoice;
                },
                onError: (e) => {
                    console.error('Speech error:', e.error);
                    isRecording = false;
                    $('mic-btn').classList.remove('recording');
                    if (e.error === 'not-allowed') {
                        toast('MIC DENIED', 'error');
                    } else {
                        toast('MIC ERROR', 'error');
                    }
                }
            });
            if (!rec) { console.log('Speech recognition not supported'); return null; }
            return rec;
        }

        function toggleMic() {
            // Si ya estamos grabando, solo parar y cerrar fullscreen
            if (wantRecording) {
                toggleMicFs();
                closeInputFs();
                return;
            }
            // Abrir fullscreen sin focus (para no abrir teclado) y empezar a dictar
            openInputFs(true);
            setTimeout(() => toggleMicFs(), 100);
        }

        // Toggle idioma de dictado
        function toggleLang() {
            // Cambiar idioma
            if (speechLang === 'es-ES') {
                speechLang = 'en-US';
                $('ifs-lang-btn').textContent = 'EN';
                toast('ENGLISH', 'success');
            } else {
                speechLang = 'es-ES';
                $('ifs-lang-btn').textContent = 'ES';
                toast('ESPAÑOL', 'success');
            }
            // Reiniciar recognition para aplicar nuevo idioma
            if (recognition) {
                if (wantRecording) {
                    wantRecording = false;
                    recognition.stop();
                }
                recognition = null;
            }
        }

        // Fullscreen Input functions
        function openInputFs(noFocus) {
            $('ifs-input').value = $('prompt').value;
            $('input-fs').classList.add('active');
            document.body.style.overflow = 'hidden';
            updateIfsAttach();
            if (!noFocus) {
                $('ifs-input').focus();
            }
        }

        function closeInputFs() {
            // Sync back to small input
            $('prompt').value = $('ifs-input').value;
            $('input-fs').classList.remove('active');
            document.body.style.overflow = '';
            // Stop mic if recording
            if (isRecording && recognition) {
                recognition.stop();
            }
        }

        function sendFromFs() {
            // Capture the dictated text into the real input, then CLEAR the
            // fullscreen buffer so it can't be re-synced back into #prompt when the
            // mic is later turned off (that resync was the "sent text reappears" bug).
            // Close inline (NOT closeInputFs, which would re-copy ifs-input → prompt).
            $('prompt').value = $('ifs-input').value;
            $('ifs-input').value = '';
            $('prompt').dataset.preVoice = '';   // reset the dictation base so nothing accumulates
            $('input-fs').classList.remove('active');
            document.body.style.overflow = '';
            send();
        }

        function toggleMicFs() {
            if (!recognition) {
                recognition = initSpeechRecognition();
                if (!recognition) {
                    toast('NOT SUPPORTED', 'error');
                    return;
                }
                // Override to update fullscreen input - solo agregar resultado final
                recognition.onresult = (e) => {
                    const input = $('ifs-input');
                    // Tomar solo el último resultado final
                    const result = e.results[e.results.length - 1];
                    if (result && result.isFinal) {
                        const text = result[0].transcript.toLowerCase();
                        // Agregar al texto existente con espacio
                        if (input.value && !input.value.endsWith(' ')) {
                            input.value += ' ';
                        }
                        input.value += text;
                    }
                };
                recognition.onstart = () => {
                    isRecording = true;
                    $('ifs-mic-btn')?.classList.add('recording');
                    $('mic-btn')?.classList.add('recording');
                };
                recognition.onend = () => {
                    isRecording = false;
                    // Si queremos seguir grabando, reiniciar
                    if (wantRecording) {
                        try {
                            recognition.start();
                        } catch (e) {
                            // Ignorar errores de reinicio
                        }
                    } else {
                        $('ifs-mic-btn')?.classList.remove('recording');
                        $('mic-btn')?.classList.remove('recording');
                    }
                };
            }

            if (wantRecording) {
                // Parar grabación
                wantRecording = false;
                recognition.stop();
                toast('MIC OFF', 'error');
                trackTranscription();
            } else {
                // Iniciar grabación
                wantRecording = true;
                toast('LISTENING...', 'success');
                recognition.start();
            }
        }

        // Voice recognition for fullscreen terminal input
        let fsRecognition = null;
        let fsMicRecording = false;

        function toggleFsMic() {
            if (!fsRecognition) {
                fsRecognition = initSpeechRecognition();
                if (!fsRecognition) {
                    toast('NOT SUPPORTED', 'error');
                    return;
                }
                fsRecognition.onresult = (e) => {
                    const input = $('fs-prompt');
                    const result = e.results[e.results.length - 1];
                    if (result && result.isFinal) {
                        const text = result[0].transcript.toLowerCase();
                        if (input.value && !input.value.endsWith(' ')) {
                            input.value += ' ';
                        }
                        input.value += text;
                        // Also save to panel state
                        if (splitPanels[activePanel]) {
                            splitPanels[activePanel].inputValue = input.value;
                        }
                    }
                };
                fsRecognition.onstart = () => {
                    fsMicRecording = true;
                    $('fs-mic-btn')?.classList.add('recording');
                };
                fsRecognition.onend = () => {
                    // Keep recording if wanted
                    if (fsMicRecording) {
                        try {
                            fsRecognition.start();
                        } catch (e) {
                            fsMicRecording = false;
                            $('fs-mic-btn')?.classList.remove('recording');
                        }
                    } else {
                        $('fs-mic-btn')?.classList.remove('recording');
                    }
                };
                fsRecognition.onerror = (e) => {
                    fsMicRecording = false;
                    $('fs-mic-btn')?.classList.remove('recording');
                    if (e.error === 'not-allowed') {
                        toast('MIC DENIED', 'error');
                    }
                };
            }

            if (fsMicRecording) {
                // Stop recording
                fsMicRecording = false;
                fsRecognition.stop();
                toast('MIC OFF', 'error');
                trackTranscription();
            } else {
                // Start recording
                fsMicRecording = true;
                toast('LISTENING...', 'success');
                fsRecognition.start();
            }
        }

        function updateIfsAttach() {
            const ind = $('ifs-attach');
            if (attachedImages.length > 0) {
                ind.classList.remove('hidden');
                ind.innerHTML = attachedImages.length === 1
                    ? `[img] ${attachedImages[0].split(/[/\\]/).pop()} <button onclick="clearAttachment();updateIfsAttach()">×</button>`
                    : `[img] ${attachedImages.length} images <button onclick="clearAttachment();updateIfsAttach()">×</button>`;
            } else {
                ind.classList.add('hidden');
            }
        }

        // Drag up gesture on small input to open fullscreen
        function initInputDrag() {
            const input = $('prompt');
            let startY = 0;
            let isDragging = false;

            input.addEventListener('touchstart', (e) => {
                startY = e.touches[0].clientY;
                isDragging = true;
            });

            input.addEventListener('touchmove', (e) => {
                if (!isDragging) return;
                const deltaY = startY - e.touches[0].clientY;
                if (deltaY > 50) { // Drag up threshold
                    isDragging = false;
                    openInputFs();
                }
            });

            input.addEventListener('touchend', () => {
                isDragging = false;
            });
        }

        // Tab autocomplete - envía texto del input + Tab
        async function tabComplete() {
            const text = $('prompt').value;
            const targetSession = getCurrentTargetSession();
            try {
                if (text) {
                    // Enviar texto sin Enter
                    await fetch('/api/sendraw', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: token },
                        body: JSON.stringify({ text, session: targetSession })
                    });
                    $('prompt').value = '';
                }
                // Enviar Tab
                await fetch('/api/key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ key: 'Tab', session: targetSession })
                });
                toast('TAB', 'success');
                schedulePoll(300);
            } catch (e) { toast('ERROR', 'error'); }
        }

        // Enviar tecla especial
        async function sendKey(key) {
            try {
                const targetSession = getCurrentTargetSession();
                const r = await fetch('/api/key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ key, session: targetSession })
                });
                const d = await r.json();
                if (d.success) {
                    schedulePoll(500);
                }
            } catch (e) { toast('ERROR', 'error'); }
        }

        function addChat(msg, type) {
            chatHistory.push({ msg, type, time: new Date() });
            renderChat();
        }

        function renderChat() {
            const c = $('chat');
            c.innerHTML = chatHistory.slice(-20).map(m =>
                '<div class="chat-msg ' + m.type + '">' + escapeHtml(m.msg) + '<div class="chat-time">' + m.time.toLocaleTimeString() + '</div></div>'
            ).join('');
            c.scrollTop = c.scrollHeight;
        }

        // ── Fullscreen terminal: the SESSION DECK (mobile) ─────────────────────
        // 2026-10-08. The old fullscreen split cut a phone screen into 2-4 tiny
        // panes (two columns at 2), with three separate font controls and a typed
        // prompt() to pick a session. A phone is too narrow for side by side, so
        // the deck shows ONE session at full size and makes moving between them
        // instant:
        //   - swipe sideways = next/previous session (native CSS scroll-snap, so
        //     the motion is the browser's own, not a JS animation);
        //   - a dot strip on top carries the desktop's attention states; a
        //     session that starts waiting for you while you look at another one
        //     lights its dot and buzzes the phone once;
        //   - pinch (two fingers together) or [#] = overview of live tiles;
        //   - landscape shows two at a time, the only case where that fits;
        //   - the deck is one of the PC sidebar's FOLDERS (the same
        //     /api/sessions/groups the desktop reads), so groups are never built
        //     twice. "all" = every session this window may show.
        // splitPanels / activePanel keep their names: getCurrentTargetSession,
        // fsSend, the input drag and the keyboard scroll all read them.
        let splitPanels = [{ session: null, content: '', inputValue: '' }];
        let activePanel = 0;
        let deckGroup = null;          // a folder id, or 'all'
        let deckGroups = { groups: [], assignments: {} };
        let deckLive = [];             // live session names this window may show
        let deckStates = {};           // session -> dispatcher state
        let deckAttn = new Set();      // sessions waiting for you, not yet looked at
        let deckRemoved = new Set();   // sessions closed out of the deck this visit
        let deckOverview = false;
        let deckScrollRaf = 0;
        let deckProgrammatic = 0;      // ignore scroll events we caused ourselves
        const DECK_ATTN = new Set(['waiting_input', 'failed']);
        const DECK_POLL_MS = 3000;     // the session(s) on screen
        const DECK_BG_EVERY = 3;       // off-screen sessions: every 3rd tick
        const DECK_LIST_MS = 15000;    // session list + folders
        const DECK_STATES_MS = 6000;   // same pace as desktop's PC_STATES_EVERY_MS

        function deckEl() { return $('fs-split-container'); }
        function deckIsOpen() { const fs = $('terminal-fs'); return !!(fs && fs.classList.contains('active')); }

        function toggleFullscreen() {
            const fs = $('terminal-fs');
            const isActive = fs.classList.contains('active');
            if (!isActive) {
                fs.classList.add('active');
                document.body.style.overflow = 'hidden';
                deckRemoved = new Set();
                deckOverview = false;
                const target = homeSession || TMUX_SESSION || '';
                // Paint the current session at once; the folder fills in after.
                splitPanels = [{ session: target || null, content: '', inputValue: '' }];
                activePanel = 0;
                deckRender();
                const fsPrompt = $('fs-prompt');
                if (fsPrompt) fsPrompt.value = '';
                deckRefreshList(target).then(() => deckGoTo(deckIndexOf(target), false));
                startSplitPolling();
            } else {
                const fsPrompt = $('fs-prompt');
                if (fsPrompt && splitPanels[activePanel]) {
                    splitPanels[activePanel].inputValue = fsPrompt.value;
                }
                // The session you were looking at becomes the home screen's.
                homeSession = splitPanels[activePanel]?.session || TMUX_SESSION;
                updateHomeSessionDisplay();
                pollHomeSession();
                if (fsMicRecording && fsRecognition) {
                    fsMicRecording = false;
                    fsRecognition.stop();
                }
                fs.classList.remove('active');
                document.body.style.overflow = '';
                $('fs-quick').classList.add('hidden');
                if (window.resetFsQuickPosition) window.resetFsQuickPosition();
                stopSplitPolling();
            }
        }

        // ── Which sessions are in the deck ──────────────────────────────────
        function deckGroupOf(name) {
            const a = deckGroups.assignments || {};
            const byId = {};
            (deckGroups.groups || []).forEach(g => { byId[g.id] = g; });
            let gid = a[name];
            // A session in a sub-folder belongs to its top folder's deck, the
            // same way desktop's [Split] on a folder takes its children too.
            const seen = new Set();
            while (gid && byId[gid] && byId[gid].parent && byId[byId[gid].parent] && !seen.has(gid)) {
                seen.add(gid);
                gid = byId[gid].parent;
            }
            return gid && byId[gid] ? gid : null;
        }

        function deckMembers(group) {
            const live = deckLive.filter(n => !deckRemoved.has(n));
            if (!group || group === 'all') return live;
            return live.filter(n => deckGroupOf(n) === group);
        }

        async function deckRefreshList(preferSession) {
            try {
                const [rs, rg] = await Promise.all([
                    fetch('/api/sessions', { headers: { Authorization: token } }),
                    fetch('/api/sessions/groups', { headers: { Authorization: token } }),
                ]);
                const ds = await rs.json();
                let names = (ds.sessions || []).map(s => s.name);
                if (typeof window.tsrctFilterSessions === 'function') names = window.tsrctFilterSessions(names);
                deckLive = names;
                try { deckGroups = await rg.json(); } catch (e) { deckGroups = { groups: [], assignments: {} }; }
            } catch (e) { return; }
            if (!deckIsOpen()) return;
            // First fill: the deck is the folder of the session you opened from.
            if (deckGroup === null || (deckGroup !== 'all' && !(deckGroups.groups || []).some(g => g.id === deckGroup))) {
                const g = preferSession ? deckGroupOf(preferSession) : null;
                deckGroup = g && deckMembers(g).length > 1 ? g : 'all';
            }
            deckSync();
        }

        // Rebuild splitPanels from the folder WITHOUT losing what each panel
        // already shows (content, unsent draft) or which session you are on.
        function deckSync() {
            const current = splitPanels[activePanel]?.session || null;
            const names = deckMembers(deckGroup);
            if (current && !names.includes(current) && deckLive.includes(current)) names.unshift(current);
            if (!names.length) names.push(current || homeSession || TMUX_SESSION || null);
            const old = new Map(splitPanels.map(p => [p.session, p]));
            const same = names.length === splitPanels.length && names.every((n, i) => splitPanels[i].session === n);
            splitPanels = names.map(n => old.get(n) || { session: n, content: '', inputValue: '' });
            const idx = Math.max(0, names.indexOf(current));
            if (!same) {
                deckRender();
                deckGoTo(idx, false);
            } else {
                activePanel = idx;
                deckPaintChrome();
            }
        }

        function deckIndexOf(session) {
            const i = splitPanels.findIndex(p => p.session === session);
            return i < 0 ? 0 : i;
        }

        // ── Drawing ─────────────────────────────────────────────────────────
        function deckRender() {
            const track = deckEl();
            if (!track) return;
            track.className = 'fs-split-container fs-deck' + (deckOverview ? ' overview' : '');
            track.style.cssText = '';
            track.innerHTML = '';
            splitPanels.forEach((p, i) => track.appendChild(createPanel(i)));
            deckBindGestures(track);
            deckPaintChrome();
        }

        function createPanel(i) {
            const panel = document.createElement('div');
            const p = splitPanels[i];
            panel.className = 'fs-panel' + (i === activePanel ? ' active' : '');
            panel.id = 'fs-panel-' + i;
            panel.dataset.session = p.session || '';
            panel.addEventListener('click', () => {
                if (deckOverview) { deckSetOverview(false); deckGoTo(i, false); return; }
                if (i !== activePanel) setActivePanel(i);
            });
            panel.innerHTML = `
                <div class="fs-panel-header">
                    <span class="fs-panel-title"><span class="fs-deck-mark"></span><span class="session-name" id="panel-session-${i}">${escapeHtml(p.session || '--')}</span></span>
                    <div class="fs-panel-actions">
                        <button class="fs-panel-close" onclick="event.stopPropagation();showPanelSessionPicker(${i})" title="Change session">[*]</button>
                        ${splitPanels.length > 1 ? `<button class="fs-panel-x" onclick="event.stopPropagation();closePanel(${i})" title="Take out of this deck">x</button>` : ''}
                    </div>
                </div>
                <div class="fs-panel-content" id="panel-content-${i}"></div>`;
            const content = panel.querySelector('.fs-panel-content');
            if (p.content) {
                if (window.TermFocus) TermFocus.write(content, p.content, false);
                else content.textContent = p.content;
            }
            return panel;
        }

        // Header title, dot strip, active ring, per-panel state marks.
        function deckPaintChrome() {
            const cur = splitPanels[activePanel];
            const groupName = deckGroup === 'all' || !deckGroup ? 'all'
                : ((deckGroups.groups || []).find(g => g.id === deckGroup) || {}).name || 'folder';
            const title = $('fs-active-title');
            if (title) title.textContent = (cur && cur.session) || '--';
            const gbtn = $('fs-deck-group');
            if (gbtn) gbtn.textContent = groupName + ' ' + (activePanel + 1) + '/' + splitPanels.length + ' v';
            const strip = $('fs-deck-dots');
            if (strip) {
                strip.innerHTML = splitPanels.map((p, i) => {
                    const st = deckStates[p.session] || '';
                    const cls = ['fs-dot'];
                    if (i === activePanel) cls.push('active');
                    if (deckAttn.has(p.session)) cls.push('attn');
                    else if (st === 'working') cls.push('working');
                    const label = String(p.session || '--');
                    return `<button class="${cls.join(' ')}" data-i="${i}" title="${escapeHtml(label)}"><i></i><span>${escapeHtml(label.length > 12 ? label.slice(0, 11) + '.' : label)}</span></button>`;
                }).join('');
                const on = strip.querySelector('.fs-dot.active');
                if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
            document.querySelectorAll('#fs-split-container .fs-panel').forEach((el, i) => {
                const s = splitPanels[i] && splitPanels[i].session;
                el.classList.toggle('active', i === activePanel);
                el.classList.toggle('needs-attention', deckAttn.has(s));
                el.classList.toggle('working', !deckAttn.has(s) && deckStates[s] === 'working');
            });
        }

        // ── Moving between sessions ─────────────────────────────────────────
        function deckGoTo(idx, smooth) {
            const track = deckEl();
            if (!track || !splitPanels.length) return;
            idx = Math.max(0, Math.min(splitPanels.length - 1, idx));
            const panel = track.children[idx];
            if (!deckOverview && panel) {
                deckProgrammatic = Date.now();
                track.scrollTo({ left: panel.offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
            }
            setActivePanel(idx, true);
        }

        function deckOnScroll() {
            if (deckOverview || deckScrollRaf) return;
            deckScrollRaf = requestAnimationFrame(() => {
                deckScrollRaf = 0;
                // A jump we started (a dot tap) passes through the panels in
                // between; those are not visits, and each would swap the draft.
                if (Date.now() - deckProgrammatic < 600) return;
                const track = deckEl();
                if (!track || !track.children.length) return;
                const w = track.children[0].offsetWidth || track.clientWidth || 1;
                const idx = Math.round(track.scrollLeft / w);
                if (idx !== activePanel && idx >= 0 && idx < splitPanels.length) {
                    setActivePanel(idx, true);
                    updatePanel(idx);
                }
            });
        }

        function setActivePanel(idx, quiet) {
            if (!splitPanels[idx]) return;
            const fsPrompt = $('fs-prompt');
            if (idx !== activePanel && splitPanels[activePanel] && fsPrompt) {
                splitPanels[activePanel].inputValue = fsPrompt.value;
                if (fsPrompt && splitPanels[idx]) fsPrompt.value = splitPanels[idx].inputValue || '';
            }
            const changed = idx !== activePanel;
            activePanel = idx;
            const session = splitPanels[idx].session;
            // Looking at it IS the acknowledgement, as on desktop (pcAttentionAck).
            if (session) deckAttn.delete(session);
            deckPaintChrome();
            if (!quiet) playSound('tap');
            if (changed && session && navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
        }

        function deckSetOverview(on) {
            deckOverview = !!on;
            const track = deckEl();
            if (track) track.classList.toggle('overview', deckOverview);
            const b = $('fs-deck-overview');
            if (b) b.classList.toggle('active', deckOverview);
            if (deckOverview) {
                updateAllPanels();
                const cur = track && track.children[activePanel];
                if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
            } else {
                deckGoTo(activePanel, false);
            }
        }
        function deckToggleOverview() { playSound('tap'); deckSetOverview(!deckOverview); }

        // Pinch = overview. A two-finger gesture never fights the one-finger
        // swipe, and the page has user-scalable=no, so the browser does not
        // claim it either.
        function deckBindGestures(track) {
            if (track.dataset.deckBound) return;
            track.dataset.deckBound = '1';
            track.addEventListener('scroll', deckOnScroll, { passive: true });
            let d0 = 0;
            const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
            track.addEventListener('touchstart', e => {
                d0 = e.touches.length === 2 ? dist(e.touches) : 0;
            }, { passive: true });
            track.addEventListener('touchmove', e => {
                if (!d0 || e.touches.length !== 2) return;
                const r = dist(e.touches) / d0;
                if (!deckOverview && r < 0.7) { d0 = 0; deckSetOverview(true); }
                else if (deckOverview && r > 1.4) { d0 = 0; deckSetOverview(false); }
            }, { passive: true });
            track.addEventListener('touchend', () => { d0 = 0; }, { passive: true });
            const strip = $('fs-deck-dots');
            if (strip && !strip.dataset.deckBound) {
                strip.dataset.deckBound = '1';
                strip.addEventListener('click', e => {
                    const b = e.target.closest('.fs-dot');
                    if (!b) return;
                    if (deckOverview) deckSetOverview(false);
                    deckGoTo(parseInt(b.dataset.i, 10) || 0, true);
                });
            }
        }

        // ── Pickers (a sheet, not prompt()) ─────────────────────────────────
        function deckSheet(title, items, onPick) {
            let sheet = $('fs-deck-sheet');
            if (!sheet) {
                sheet = document.createElement('div');
                sheet.id = 'fs-deck-sheet';
                sheet.className = 'fs-deck-sheet';
                sheet.addEventListener('click', e => {
                    if (e.target === sheet) { sheet.classList.remove('visible'); return; }
                    const b = e.target.closest('[data-k]');
                    if (!b) return;
                    sheet.classList.remove('visible');
                    const fn = sheet._onPick;
                    if (fn) fn(b.dataset.k);
                });
                $('terminal-fs').appendChild(sheet);
            }
            sheet._onPick = onPick;
            sheet.innerHTML = `<div class="fs-deck-sheet-panel">
                <div class="fs-deck-sheet-title">${escapeHtml(title)}</div>
                ${items.map(it => `<button class="fs-deck-sheet-row${it.on ? ' on' : ''}" data-k="${escapeHtml(it.key)}">
                    <span>${escapeHtml(it.label)}</span><em>${escapeHtml(it.note || '')}</em></button>`).join('')}
            </div>`;
            sheet.classList.add('visible');
        }

        function deckPickGroup() {
            playSound('tap');
            const items = [{ key: 'all', label: 'all sessions', note: String(deckMembers('all').length), on: deckGroup === 'all' }];
            (deckGroups.groups || []).filter(g => !g.parent).forEach(g => {
                const n = deckMembers(g.id).length;
                if (n) items.push({ key: g.id, label: g.name || g.id, note: String(n), on: deckGroup === g.id });
            });
            deckSheet('deck', items, key => {
                deckGroup = key;
                deckRemoved = new Set();
                deckSync();
                deckGoTo(0, false);
                updateAllPanels();
            });
        }

        async function showPanelSessionPicker(idx) {
            playSound('tap');
            await deckRefreshList();
            const used = new Set(splitPanels.map((p, i) => i !== idx && p.session).filter(Boolean));
            const items = deckLive.map(n => ({
                key: n, label: n,
                note: n === splitPanels[idx]?.session ? 'here' : used.has(n) ? 'in deck' : (deckStates[n] || ''),
                on: n === splitPanels[idx]?.session,
            }));
            if (!items.length) { toast('No sessions available', 'error'); return; }
            deckSheet('session', items, name => {
                const at = splitPanels.findIndex(p => p.session === name);
                if (at >= 0) { deckGoTo(at, true); return; }   // already here: just go to it
                splitPanels[idx] = { session: name, content: '', inputValue: '' };
                deckRemoved.delete(name);
                deckRender();
                deckGoTo(idx, false);
                updatePanel(idx);
            });
        }

        function closePanel(idx) {
            if (splitPanels.length <= 1) return;
            playSound('tap');
            const gone = splitPanels[idx].session;
            if (gone) deckRemoved.add(gone);
            splitPanels.splice(idx, 1);
            const next = Math.min(idx, splitPanels.length - 1);
            activePanel = Math.min(activePanel, splitPanels.length - 1);
            deckRender();
            deckGoTo(next, false);
        }

        // ── Polling ─────────────────────────────────────────────────────────
        let splitPollInterval = null;
        let deckTick = 0, deckListAt = 0, deckStatesAt = 0;
        function startSplitPolling() {
            stopSplitPolling();
            deckTick = 0;
            deckListAt = Date.now();
            deckStatesAt = 0;
            deckPollTick();
            splitPollInterval = setInterval(deckPollTick, DECK_POLL_MS);
        }
        function stopSplitPolling() {
            if (splitPollInterval) clearInterval(splitPollInterval);
            splitPollInterval = null;
        }

        // On screen every tick; the rest every DECK_BG_EVERY ticks, so the
        // neighbour you swipe to is never more than ~9s stale and a deck of 8
        // does not cost 8 captures every 3 seconds.
        async function deckPollTick() {
            if (document.hidden || !deckIsOpen()) return;
            deckTick++;
            const now = Date.now();
            if (now - deckStatesAt >= DECK_STATES_MS) { deckStatesAt = now; deckRefreshStates(); }
            if (now - deckListAt >= DECK_LIST_MS) { deckListAt = now; deckRefreshList(); }
            const visible = new Set([activePanel]);
            if (deckOverview) splitPanels.forEach((p, i) => visible.add(i));
            else if (window.matchMedia('(orientation: landscape)').matches) visible.add(activePanel + 1);
            for (let i = 0; i < splitPanels.length; i++) {
                if (visible.has(i) || deckTick % DECK_BG_EVERY === 0) await updatePanel(i);
            }
        }

        async function deckRefreshStates() {
            try {
                const r = await fetch('/api/dispatcher/session-states', { headers: { Authorization: token } });
                if (!r.ok) return;
                const d = await r.json();
                const next = {};
                (d.sessions || []).forEach(s => { if (s && s.name) next[s.name] = s.state; });
                const inDeck = new Set(splitPanels.map(p => p.session));
                const onScreen = splitPanels[activePanel]?.session;
                let buzz = false;
                Object.keys(next).forEach(n => {
                    const was = deckStates[n], now = next[n];
                    if (DECK_ATTN.has(now) && !DECK_ATTN.has(was) && was !== undefined && n !== onScreen && inDeck.has(n)) {
                        deckAttn.add(n);
                        buzz = true;
                    }
                    if (now === 'working') deckAttn.delete(n);
                });
                deckStates = next;
                if (buzz && navigator.vibrate) { try { navigator.vibrate([40, 60, 40]); } catch (e) {} }
                deckPaintChrome();
            } catch (e) { /* dispatcher off: no states, no error */ }
        }

        async function updateAllPanels() {
            for (let i = 0; i < splitPanels.length; i++) await updatePanel(i);
        }

        async function updatePanel(idx) {
            const p = splitPanels[idx];
            if (!p) return;
            const session = p.session;
            try {
                // ?output=1 on the fallback: a panel with no session assigned
                // still wants a screen to show, and /api/status only ships the
                // capture when asked now.
                const url = session ? '/api/output?session=' + encodeURIComponent(session) : '/api/status?output=1';
                const r = await fetch(url, { headers: { Authorization: token } });
                const d = await r.json();
                const content = d.output || '';
                if (splitPanels[idx] !== p) return;   // the deck changed under us
                p.content = content;
                const el = $('panel-content-' + idx);
                if (el) {
                    if (window.TermFocus) {
                        TermFocus.write(el, content, false);
                    } else {
                        const wasAtBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 50;
                        el.textContent = content;
                        if (wasAtBottom) el.scrollTop = el.scrollHeight;
                    }
                }
            } catch (e) {}
        }

        // Track current TMUX session for panels. Empty = no session targeted yet
        // (no hardcoded 'claude'); the sidebar adopts the first real session, or
        // shows an empty state when there are none.
        let TMUX_SESSION = '';
        // Track which session is displayed on home screen (syncs with selected panel when exiting fullscreen).
        // Shared mutable state: declared here but ALSO written by desktop.js/main.js, so it lives on
        // window via a get/set proxy -- bare `homeSession` reads/writes in ANY file route through here.
        // ── MULTI-WINDOW COORDINATION ───────────────────────────────────────
        // Two TSRCT windows are two workstations, never one window twice.
        //
        // Presence is negotiated over a BroadcastChannel instead of localStorage
        // timestamps. A timestamp cannot answer the only question that matters
        // at startup -- "is another window ALIVE right now" -- because it cannot
        // tell a live sibling from a stale row, nor from THIS window's own row
        // after a reload. That ambiguity is what made the previous attempt fail.
        //
        // It also covers the case that silently defeated it: a window opened
        // FROM another window inherits a COPY of its sessionStorage, so it
        // arrives already believing it owns the opener's session and its own
        // window id. Both are re-derived here instead of trusted.
        const WIN_ID = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2) + Date.now();   // per PAGE LOAD, never persisted
        const peerSessions = new Map();   // peer window id -> session it is showing
        const peerOwned = new Map();      // peer window id -> sessions that window owns
        let emptyMode = false;            // fresh window: no session until the user picks
        let presenceResolved = false;
        // A window opened ALONE is the "home" workstation: it sees every session
        // on the machine except the ones another live window has taken. A window
        // opened beside a sibling is a fresh workspace: it sees ONLY what it
        // creates. This asymmetry is deliberate -- without it, the first window
        // would suddenly hide the 12 sessions that already existed, since it did
        // not create any of them in this page load.
        let isHome = true;
        let owned = new Set();
        try { owned = new Set(JSON.parse(sessionStorage.getItem('tsrct_owned') || '[]')); } catch (e) {}
        function saveOwned() {
            try { sessionStorage.setItem('tsrct_owned', JSON.stringify([...owned])); } catch (e) {}
        }

        let _homeSession = null;
        try { _homeSession = sessionStorage.getItem('tsrct_home_session') || null; } catch (e) {}

        let bc = null;
        try { bc = new BroadcastChannel('tsrct-windows'); } catch (e) {}
        function announce(t) {
            if (!bc) return;
            try { bc.postMessage({ t, id: WIN_ID, session: _homeSession, owned: [...owned] }); } catch (e) {}
        }
        if (bc) {
            bc.onmessage = e => {
                const m = e.data || {};
                if (!m.id || m.id === WIN_ID) return;
                if (m.t === 'bye') { peerSessions.delete(m.id); peerOwned.delete(m.id); redrawSessions(); return; }
                peerSessions.set(m.id, m.session || null);
                const before = JSON.stringify(peerOwned.get(m.id) || []);
                peerOwned.set(m.id, m.owned || []);
                // A sibling taking or releasing a session changes what THIS
                // window may show, so the sidebar has to be redrawn for it.
                if (before !== JSON.stringify(m.owned || [])) redrawSessions();
                if (m.t === 'ping') announce('pong');   // answer a newcomer's roll-call
            };
            window.addEventListener('pagehide', () => {
                try { bc.postMessage({ t: 'bye', id: WIN_ID }); } catch (e) {}
            });
        }
        function sessionsClaimedElsewhere() {
            return new Set([...peerSessions.values()].filter(Boolean));
        }

        Object.defineProperty(window, 'homeSession', {
            get: () => _homeSession,
            set: v => {
                _homeSession = v;
                // A deliberate pick ends the blank slate.
                if (v) emptyMode = false;
                try {
                    if (v) sessionStorage.setItem('tsrct_home_session', v);
                    else sessionStorage.removeItem('tsrct_home_session');
                } catch (e) {}
                if (window.pcLayout) window.pcLayout.mirror();
                announce('session');
                if (typeof updateHomeSessionDisplay === 'function') {
                    try { updateHomeSessionDisplay(); } catch (e) {}
                }
            },
            configurable: true,
        });

        // Roll-call at startup, then decide what kind of window this is.
        const presenceReady = new Promise(resolve => {
            if (!bc) { presenceResolved = true; resolve(); return; }
            announce('ping');
            setTimeout(() => {
                if (peerSessions.size > 0) {
                    isHome = false;   // a sibling is live -> this is a fresh workspace
                    const taken = sessionsClaimedElsewhere();
                    // Either no session of our own, or the one we "have" is the
                    // sibling's (that is the inherited-copy case) -> start clean.
                    if (!_homeSession || taken.has(_homeSession)) {
                        emptyMode = true;
                        window.homeSession = null;
                    }
                }
                presenceResolved = true;
                resolve();
            }, 300);
        });

        // THE single place that decides which session this window targets.
        // It exists because the rule was duplicated: main.js (mobile) and
        // desktop.js (PC mode) each had their own "adopt the first live
        // session" copy, so fixing one left the other mirroring.
        function pickSessionForThisWindow(names) {
            if (!presenceResolved) return _homeSession;   // never adopt before the roll-call
            if (emptyMode) return null;                   // fresh window: the user chooses
            if (!names || !names.length) return null;
            if (_homeSession && names.includes(_homeSession)) return _homeSession;
            const taken = sessionsClaimedElsewhere();
            return names.find(n => !taken.has(n)) || names[0];
        }

        function redrawSessions() {
            if (typeof refreshPCSessions === 'function') { try { refreshPCSessions(); } catch (e) {} }
        }
        function peerOwnedSet() {
            const out = new Set();
            for (const arr of peerOwned.values()) (arr || []).forEach(n => out.add(n));
            return out;
        }
        // This window created (or was handed) this session -- it is now its own.
        function ownSession(name) {
            if (!name || owned.has(name)) return;
            owned.add(name);
            saveOwned();
            announce('session');
        }
        function isVisibleSession(name) {
            if (!name) return false;
            if (owned.has(name)) return true;
            // Home shows everything not taken by a live sibling; a secondary
            // workspace shows nothing but its own.
            return isHome && !peerOwnedSet().has(name);
        }
        // Accepts ['a','b'] or [{name:'a'},...] -- both shapes are used.
        function filterVisibleSessions(list) {
            return (list || []).filter(x => isVisibleSession(typeof x === 'string' ? x : (x && x.name)));
        }

        window.sessionsClaimedElsewhere = sessionsClaimedElsewhere;
        window.pickSessionForThisWindow = pickSessionForThisWindow;
        window.tsrctOwnSession = ownSession;
        window.tsrctIsVisibleSession = isVisibleSession;
        window.tsrctFilterSessions = filterVisibleSessions;
        window.tsrctIsHome = () => isHome;
        window.tsrctPresenceReady = presenceReady;
        window.tsrctStartsClean = () => emptyMode;

        // Get the current target session based on context
        // In fullscreen split mode: use active panel's session
        // Otherwise: use homeSession
        function getCurrentTargetSession() {
            const fs = $('terminal-fs');
            if (fs && fs.classList.contains('active') && splitPanels[activePanel]?.session) {
                return splitPanels[activePanel].session;
            }
            return homeSession || TMUX_SESSION || '';
        }

        // Toggle Fullscreen Quick Menu
        function toggleFsMenu() {
            $('fs-quick').classList.toggle('hidden');
        }

        // Toggle entre menus en fullscreen
        function setFsMode(mode) {
            $('fs-toggle-claude').classList.toggle('active', mode === 'claude');
            $('fs-toggle-term').classList.toggle('active', mode === 'term');
            $('fs-claude').classList.toggle('hidden', mode !== 'claude');
            $('fs-term').classList.toggle('hidden', mode !== 'term');
        }

        // Send desde fullscreen. Goes through main.js send() (2026-10-08): the
        // fullscreen copy posted the bare text, so photos and files attached
        // from fullscreen never travelled, abbreviations did not expand, and the
        // vault switch was ignored. send() already targets the panel on screen
        // (getCurrentTargetSession) and restores the text if the send fails.
        async function fsSend() {
            const fsPrompt = $('fs-prompt');
            const home = $('prompt');
            if (!fsPrompt || !home || typeof window.send !== 'function') return;
            home.value = fsPrompt.value;
            fsPrompt.value = '';
            if (splitPanels[activePanel]) splitPanels[activePanel].inputValue = '';
            await window.send();
            // A failed send puts the text back in the home box; bring it here.
            if (home.value) { fsPrompt.value = home.value; home.value = ''; }
            schedulePoll(500);
            if (deckIsOpen()) setTimeout(() => updatePanel(activePanel), 600);
        }

        // Toast
        function toast(msg, type = 'success', sound = true) {
            const t = $('toast');
            t.className = 'toast ' + type;
            $('toast-msg').textContent = msg;
            t.classList.add('show');
            if (sound) playSound(type === 'success' ? 'success' : 'error');
            setTimeout(() => t.classList.remove('show'), 2500);
        }

        // Keyboard
        $('prompt')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); send(); }
        });
        $('fs-prompt')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); fsSend(); }
        });

        // Hide quick action buttons when keyboard opens (mobile)
        let keyboardOpen = false;
        let viewportInitialHeight = 0;

        function initKeyboardScroll() {
            const fsQuick = $('fs-quick');

            // Use visualViewport API - most reliable for mobile keyboards
            if (window.visualViewport) {
                viewportInitialHeight = window.visualViewport.height;

                const updateFsQuickPosition = () => {
                    const fs = $('terminal-fs');
                    if (!fs || !fs.classList.contains('active')) return;
                    if (!fsQuick || fsQuick.classList.contains('hidden')) return;

                    const currentHeight = window.visualViewport.height;
                    const heightDiff = viewportInitialHeight - currentHeight;

                    // Keyboard open if viewport shrinks by more than 150px
                    const isKeyboardNowOpen = heightDiff > 150;

                    if (isKeyboardNowOpen && !keyboardOpen) {
                        // Keyboard just opened - hide buttons, keep input
                        keyboardOpen = true;
                        fsQuick.classList.add('keyboard-open');
                    } else if (!isKeyboardNowOpen && keyboardOpen) {
                        // Keyboard closed - show buttons again
                        keyboardOpen = false;
                        fsQuick.classList.remove('keyboard-open');
                    }

                    // Position input at bottom of visual viewport (above keyboard)
                    const offsetTop = window.visualViewport.offsetTop;
                    const viewportBottom = offsetTop + currentHeight;
                    const windowHeight = window.innerHeight;
                    const bottomOffset = windowHeight - viewportBottom;

                    fsQuick.style.bottom = bottomOffset + 'px';

                    // Scroll panels to bottom
                    scrollPanelsToBottom();
                };

                window.visualViewport.addEventListener('resize', updateFsQuickPosition);
                window.visualViewport.addEventListener('scroll', updateFsQuickPosition);

                // Update initial height when orientation changes
                window.addEventListener('orientationchange', () => {
                    setTimeout(() => {
                        viewportInitialHeight = window.visualViewport.height;
                        keyboardOpen = false;
                        if (fsQuick) {
                            fsQuick.classList.remove('keyboard-open');
                            fsQuick.style.bottom = '0px';
                        }
                    }, 500);
                });

                // Reset position when fullscreen closes
                const resetFsQuickPosition = () => {
                    if (fsQuick) {
                        fsQuick.style.bottom = '0px';
                        fsQuick.classList.remove('keyboard-open');
                    }
                    keyboardOpen = false;
                };
                window.resetFsQuickPosition = resetFsQuickPosition;
            }
        }

        function scrollPanelsToBottom() {
            const fsContent = $('terminal-fs-content');
            if (fsContent) fsContent.scrollTop = fsContent.scrollHeight;
            const panelContent = $('panel-content-' + activePanel);
            if (panelContent) panelContent.scrollTop = panelContent.scrollHeight;
        }

        // ── Public API (Phase 3B): index.html inline handlers + cross-file refs
        //    (app/main/desktop/remote-desktop) + this file's own generated onclick ──
        Object.assign(window, {
            // shared utils used everywhere:
            toast, getCurrentTargetSession,
            // attachments.js asks whether the deck is open:
            deckIsOpen,
            // sessions / terminal / panels:
            updateIfsAttach,
            renderSessions, createNewSession, switchSession, killSession, showPanelSessionPicker,
            renderContext, addChat, sendKey, tabComplete, setActivePanel, setFsMode,
            closePanel, deckPickGroup, deckToggleOverview,
            closeInputFs, fsSend, sendFromFs, toggleFsMenu, toggleFsMic, toggleFullscreen,
            toggleLang, toggleMic, toggleMicFs, initInputDrag, initKeyboardScroll,
        });
        // TMUX_SESSION is never reassigned -> a getter is enough (homeSession proxy is above):
        Object.defineProperty(window, 'TMUX_SESSION', { get: () => TMUX_SESSION, configurable: true });

})();

