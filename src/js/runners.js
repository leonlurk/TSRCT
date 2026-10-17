// ==============================================
// TSRCT - Mobile Runners
// Mini-terminals backed by tmux sessions
// ==============================================

(function() {
    'use strict';

    // Runner state
    let mobileRunners = [];
    let mobileRunnerPolls = {};    // id -> intervalId
    let activeRunnerView = null;   // currently open runner id
    let runnerViewPoll = null;     // fast poll for active view
    let mRunnerHistory = {};
    let mRunnerHistoryIdx = {};

    // ── Persistence ──────────────────────────────────────────
    function loadMobileRunners() {
        try {
            const saved = localStorage.getItem('m_runners');
            if (saved) mobileRunners = JSON.parse(saved);
        } catch (e) { mobileRunners = []; }
    }

    function saveMobileRunners() {
        const slim = mobileRunners.map(r => ({
            id: r.id, name: r.name, cwd: r.cwd,
            session: r.session, startTime: r.startTime
        }));
        localStorage.setItem('m_runners', JSON.stringify(slim));
    }

    function loadRunnerHistory() {
        try {
            const saved = localStorage.getItem('m_runner_history');
            if (saved) mRunnerHistory = JSON.parse(saved);
        } catch (e) { mRunnerHistory = {}; }
    }

    function saveRunnerHistory() {
        localStorage.setItem('m_runner_history', JSON.stringify(mRunnerHistory));
    }

    // ── Room Callbacks ───────────────────────────────────────
    function onRunnersOpen() {
        loadMobileRunners();
        loadRunnerHistory();
        syncWithTmux().then(() => {
            renderRunnerList();
            startAllPolling();
        });
    }

    function onRunnersClose() {
        stopAllPolling();
        stopViewPoll();
        activeRunnerView = null;
    }

    // ── Sync with tmux ───────────────────────────────────────
    async function syncWithTmux() {
        try {
            const res = await fetch('/api/runner/list', {
                headers: { Authorization: token }
            });
            const data = await res.json();

            const liveSessions = data.sessions || [];

            // Mark dead runners
            mobileRunners.forEach(r => {
                const alive = liveSessions.includes(r.session);
                r.status = alive ? 'running' : 'stopped';
            });

            // Recover orphans
            liveSessions.forEach(sessionName => {
                const exists = mobileRunners.some(r => r.session === sessionName);
                if (!exists) {
                    mobileRunners.push({
                        id: 'runner-' + Date.now() + Math.random().toString(36).slice(2, 5),
                        name: sessionName.replace('run-', ''),
                        cwd: '~',
                        session: sessionName,
                        status: 'running',
                        output: '',
                        startTime: Date.now(),
                        orphan: true
                    });
                }
            });

            saveMobileRunners();
        } catch (e) {}
    }

    // ── Polling ──────────────────────────────────────────────
    function startAllPolling() {
        mobileRunners.forEach(r => {
            if (r.status === 'running' && !mobileRunnerPolls[r.id]) {
                mobileRunnerPolls[r.id] = setInterval(() => pollRunner(r), 2000);
            }
        });
    }

    function stopAllPolling() {
        Object.values(mobileRunnerPolls).forEach(clearInterval);
        mobileRunnerPolls = {};
    }

    function startViewPoll(runner) {
        stopViewPoll();
        runnerViewPoll = setInterval(() => {
            pollRunner(runner);
            updateViewOutput(runner);
        }, 500);
    }

    function stopViewPoll() {
        if (runnerViewPoll) {
            clearInterval(runnerViewPoll);
            runnerViewPoll = null;
        }
    }

    async function pollRunner(runner) {
        try {
            const res = await fetch(`/api/runner/output?session=${encodeURIComponent(runner.session)}`, {
                headers: { Authorization: token }
            });
            const data = await res.json();
            if (data.output !== undefined) {
                runner.output = data.output;
                runner.status = data.running ? 'running' : 'stopped';
                if (!data.running && mobileRunnerPolls[runner.id]) {
                    clearInterval(mobileRunnerPolls[runner.id]);
                    delete mobileRunnerPolls[runner.id];
                }
            }
        } catch (e) {}
    }

    // ── Render Runner List ───────────────────────────────────
    function renderRunnerList() {
        const list = document.getElementById('runners-list');
        if (!list) return;

        if (mobileRunners.length === 0) {
            list.innerHTML = '<div class="mr-empty">No runners yet. Tap [+] to create one.</div>';
            return;
        }

        list.innerHTML = mobileRunners.map(r => {
            const statusIcon = r.status === 'running' ? '[*]' : r.status === 'stopped' ? '[x]' : '[~]';
            const preview = (r.output || '').trim().split('\n').pop() || '(no output)';
            const orphanTag = r.orphan ? '[?] ' : '';
            return `<div class="mr-card ${r.status}" onclick="mRunnerOpen('${r.id}')">
                <div class="mr-card-top">
                    <span class="mr-card-name">${orphanTag}${escapeHtml(r.name)}</span>
                    <span class="mr-card-status">${statusIcon}</span>
                </div>
                <div class="mr-card-preview">${escapeHtml(preview).slice(0, 80)}</div>
                <div class="mr-card-bottom">
                    <span class="mr-card-cwd">${escapeHtml(r.cwd || '~')}</span>
                    <button class="mr-card-kill" onclick="event.stopPropagation();mRunnerRemove('${r.id}')">[x]</button>
                </div>
            </div>`;
        }).join('');
    }

    // ── Create Runner ────────────────────────────────────────
    window.mRunnerShowCreate = function() {
        const body = document.getElementById('runners-create');
        if (!body) return;
        body.classList.remove('hidden');
        document.getElementById('runners-list-wrap').classList.add('hidden');

        // Load directory browser - start at PROJECTS dir
        mRunnerBrowseDirs(window.TSRCT_PROJECTS_ROOT);
    };

    window.mRunnerHideCreate = function() {
        document.getElementById('runners-create').classList.add('hidden');
        document.getElementById('runners-list-wrap').classList.remove('hidden');
    };

    async function mRunnerBrowseDirs(dir) {
        const list = document.getElementById('mr-dir-list');
        list.innerHTML = '<div class="mr-empty">Loading...</div>';
        try {
            const res = await fetch('/api/runner/browse?dir=' + encodeURIComponent(dir || '~'), {
                headers: { Authorization: token }
            });
            const data = await res.json();

            const current = data.current || dir;
            const dirs = data.directories || [];
            const parent = data.parent;

            document.getElementById('mr-dir-current').textContent = current;
            document.getElementById('mr-dir-current').dataset.path = current;

            let html = '';
            if (parent) {
                html += `<div class="mr-dir-item" onclick="mRunnerBrowse('${escapeHtml(parent)}')">..</div>`;
            }
            dirs.forEach(d => {
                html += `<div class="mr-dir-item" onclick="mRunnerBrowse('${escapeHtml(d.path)}')">${escapeHtml(d.name)}/</div>`;
            });
            list.innerHTML = html || '<div class="mr-empty">No subdirectories</div>';
        } catch (e) {
            list.innerHTML = `<div class="mr-empty" style="color:var(--red)">${e.message}</div>`;
        }
    }

    window.mRunnerBrowse = function(dirPath) {
        mRunnerBrowseDirs(dirPath);
    };

    window.mRunnerCreate = async function() {
        const nameInput = document.getElementById('mr-name-input');
        const name = (nameInput.value || '').trim().slice(0, 8);
        if (!name) { toast('Enter a name', 'error'); return; }

        const cwdEl = document.getElementById('mr-dir-current');
        const cwd = cwdEl.dataset.path || '';
        const session = 'run-' + name.replace(/[^a-zA-Z0-9_-]/g, '');

        // Check duplicate
        if (mobileRunners.some(r => r.session === session)) {
            toast('Runner name already exists', 'error');
            return;
        }

        try {
            const res = await fetch('/api/runner/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: token },
                body: JSON.stringify({ session, cwd })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);

            const runner = {
                id: 'runner-' + Date.now(),
                name, cwd: data.cwd || cwd, session,
                status: 'running', output: '',
                startTime: Date.now()
            };
            mobileRunners.push(runner);
            saveMobileRunners();

            // Start polling
            mobileRunnerPolls[runner.id] = setInterval(() => pollRunner(runner), 2000);

            nameInput.value = '';
            mRunnerHideCreate();
            renderRunnerList();
            toast('RUNNER CREATED: ' + name, 'success');

            // Auto-open the new runner
            setTimeout(() => mRunnerOpen(runner.id), 300);
        } catch (e) {
            toast('FAILED: ' + e.message, 'error');
        }
    };

    // ── Remove Runner ────────────────────────────────────────
    window.mRunnerRemove = async function(id) {
        const runner = mobileRunners.find(r => r.id === id);
        if (!runner) return;

        try {
            await fetch('/api/runner/kill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: token },
                body: JSON.stringify({ session: runner.session })
            });
        } catch (e) {}

        if (mobileRunnerPolls[id]) {
            clearInterval(mobileRunnerPolls[id]);
            delete mobileRunnerPolls[id];
        }

        mobileRunners = mobileRunners.filter(r => r.id !== id);
        saveMobileRunners();

        if (activeRunnerView === id) {
            mRunnerBack();
        }
        renderRunnerList();
        toast('RUNNER REMOVED', 'warn');
    };

    // ── Open Runner View ─────────────────────────────────────
    window.mRunnerOpen = function(id) {
        const runner = mobileRunners.find(r => r.id === id);
        if (!runner) return;

        activeRunnerView = id;
        const wrap = document.getElementById('runners-list-wrap');
        const view = document.getElementById('runners-view');
        if (wrap) wrap.classList.add('hidden');
        if (view) view.classList.remove('hidden');

        // Build view
        const header = document.getElementById('mr-view-name');
        const status = document.getElementById('mr-view-status');
        const output = document.getElementById('mr-view-output');
        const cwdEl = document.getElementById('mr-view-cwd');

        if (header) header.textContent = runner.name;
        if (status) {
            status.textContent = runner.status === 'running' ? '[*]' : '[x]';
            status.className = 'mr-view-status ' + runner.status;
        }
        if (cwdEl) cwdEl.textContent = runner.cwd || '~';

        updateViewOutput(runner);
        startViewPoll(runner);

        // Focus input
        const input = document.getElementById('mr-view-input');
        if (input) {
            input.value = '';
            input.focus();
        }
    };

    function updateViewOutput(runner) {
        const output = document.getElementById('mr-view-output');
        if (!output) return;

        const isNearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
        output.textContent = runner.output || 'Waiting for output...';
        if (isNearBottom) output.scrollTop = output.scrollHeight;

        // Update status
        const status = document.getElementById('mr-view-status');
        if (status) {
            status.textContent = runner.status === 'running' ? '[*]' : '[x]';
            status.className = 'mr-view-status ' + runner.status;
        }
    }

    // ── Back to List ─────────────────────────────────────────
    window.mRunnerBack = function() {
        stopViewPoll();
        activeRunnerView = null;
        document.getElementById('runners-view').classList.add('hidden');
        document.getElementById('runners-list-wrap').classList.remove('hidden');
        renderRunnerList();
    };

    // ── Send Command ─────────────────────────────────────────
    window.mRunnerSend = async function() {
        const runner = mobileRunners.find(r => r.id === activeRunnerView);
        if (!runner) return;

        const input = document.getElementById('mr-view-input');
        const cmd = (input.value || '').trim();
        if (!cmd) return;

        // History
        if (!mRunnerHistory[runner.id]) mRunnerHistory[runner.id] = [];
        mRunnerHistory[runner.id].push(cmd);
        if (mRunnerHistory[runner.id].length > 50) mRunnerHistory[runner.id].shift();
        mRunnerHistoryIdx[runner.id] = mRunnerHistory[runner.id].length;
        saveRunnerHistory();

        input.value = '';

        try {
            await fetch('/api/runner/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: token },
                body: JSON.stringify({ session: runner.session, cmd })
            });
        } catch (e) {
            toast('SEND FAILED', 'error');
        }
    };

    // ── Send Ctrl Key ────────────────────────────────────────
    window.mRunnerCtrl = async function(key) {
        const runner = mobileRunners.find(r => r.id === activeRunnerView);
        if (!runner) return;

        try {
            await fetch('/api/runner/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: token },
                body: JSON.stringify({ session: runner.session, ctrl: key })
            });
        } catch (e) {}
    };

    // ── Attach Runner to Message ──────────────────────────────
    window.mRunnerAttach = function() {
        const runner = mobileRunners.find(r => r.id === activeRunnerView);
        if (!runner) return;

        // Avoid duplicates
        const already = attachedRunners.some(r => r.id === runner.id);
        if (already) {
            toast('ALREADY ATTACHED', 'warn');
            return;
        }

        attachedRunners.push({
            id: runner.id,
            name: runner.name,
            session: runner.session
        });
        updateAttachmentIndicator();
        toast('RUNNER ATTACHED: ' + runner.name, 'success');
    };

    // ── Send Special Key ─────────────────────────────────────
    window.mRunnerKey = async function(key) {
        const runner = mobileRunners.find(r => r.id === activeRunnerView);
        if (!runner) return;

        try {
            await fetch('/api/runner/send-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: token },
                body: JSON.stringify({ session: runner.session, key })
            });
        } catch (e) {}
    };

    // ── Input Key Handler ────────────────────────────────────
    window.mRunnerInputKey = function(e) {
        const runner = mobileRunners.find(r => r.id === activeRunnerView);
        if (!runner) return;

        if (e.key === 'Enter') {
            e.preventDefault();
            mRunnerSend();
            return;
        }

        // History navigation
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const hist = mRunnerHistory[runner.id] || [];
            if (hist.length === 0) return;

            let idx = mRunnerHistoryIdx[runner.id] || hist.length;
            if (e.key === 'ArrowUp') idx = Math.max(0, idx - 1);
            else idx = Math.min(hist.length, idx + 1);
            mRunnerHistoryIdx[runner.id] = idx;

            const input = document.getElementById('mr-view-input');
            input.value = idx < hist.length ? hist[idx] : '';
        }
    };

    // ── Quick Attach Picker (from main screen) ────────────────
    window.showRunnerAttachPicker = async function() {
        // Load runners if not loaded
        if (mobileRunners.length === 0) {
            loadMobileRunners();
            await syncWithTmux();
        }

        const runners = mobileRunners.filter(r => r.status === 'running');
        if (runners.length === 0) {
            toast('NO RUNNERS ACTIVE', 'warn');
            return;
        }

        // Build quick picker as a modal overlay
        let overlay = document.getElementById('runner-attach-picker');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'runner-attach-picker';
            overlay.className = 'modal-overlay';
            overlay.onclick = function(e) { if (e.target === overlay) overlay.classList.add('hidden'); };
            document.body.appendChild(overlay);
        }

        const alreadyAttached = new Set(attachedRunners.map(r => r.id));
        overlay.innerHTML = `<div class="modal" style="max-width:350px" onclick="event.stopPropagation()">
            <div class="modal-header" style="color:var(--amber)">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                ATTACH RUNNER
            </div>
            <div class="modal-body" style="padding:8px">
                ${runners.map(r => {
                    const attached = alreadyAttached.has(r.id);
                    return `<button class="modal-btn" style="border-color:${attached ? 'var(--neon)' : 'var(--border)'}" onclick="pickRunnerAttach('${r.id}')">
                        <span class="modal-btn-title" style="color:${attached ? 'var(--neon)' : 'var(--amber)'}">${attached ? '[+] ' : ''}${r.name}</span>
                        <span class="modal-btn-desc">${r.session} ${attached ? '(attached)' : ''}</span>
                    </button>`;
                }).join('')}
            </div>
            <button class="modal-close" onclick="document.getElementById('runner-attach-picker').classList.add('hidden')">CLOSE</button>
        </div>`;
        overlay.classList.remove('hidden');
    };

    window.pickRunnerAttach = function(id) {
        const runner = mobileRunners.find(r => r.id === id);
        if (!runner) return;

        const already = attachedRunners.some(r => r.id === runner.id);
        if (already) {
            // Toggle off
            const idx = attachedRunners.findIndex(r => r.id === runner.id);
            attachedRunners.splice(idx, 1);
            toast('RUNNER DETACHED: ' + runner.name, 'warn');
        } else {
            attachedRunners.push({ id: runner.id, name: runner.name, session: runner.session });
            toast('RUNNER ATTACHED: ' + runner.name, 'success');
        }
        updateAttachmentIndicator();
        // Refresh picker UI
        showRunnerAttachPicker();
    };

    // ── Register Room ────────────────────────────────────────
    if (typeof WorldManager !== 'undefined') {
        WorldManager.rooms.runners = {
            id: 'runners-room',
            theme: 'terminal',
            title: 'Runners',
            icon: 'terminal',
            description: 'Mobile mini-terminals',
            onOpen: null,
            onClose: null
        };
        WorldManager.onRoomOpen('runners', onRunnersOpen);
        WorldManager.onRoomClose('runners', onRunnersClose);
    }

})();
