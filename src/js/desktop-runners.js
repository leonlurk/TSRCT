/* ==============================================
   TSRCT - Desktop runners (mini terminals) and their nano mode
   ============================================== */
// Moved out of desktop.js (cleanup P2 #11). Loads BEFORE desktop.js; see desktop-git.js.
(function () {

// ==============================================
// RUNNERS (Mini Terminals)
// ==============================================

// Load runners from localStorage and verify they still exist in tmux
async function loadRunners() {
    try {
        // The roll-call decides whether this window is a fresh one; restoring
        // before it answers would rebuild the sibling's desk by default.
        if (window.tsrctPresenceReady) await window.tsrctPresenceReady;
        // Runner layout is PER WINDOW. sessionStorage holds this window's own
        // set (survives its reloads, invisible to other windows). The
        // localStorage copy is only a "last layout" snapshot, and it is adopted
        // ONLY when this window opened with no other TSRCT running -- otherwise
        // a second window would restore the first one's runners and look like a
        // clone of it, which is exactly what it must not do.
        let saved;
        const ownLayout = sessionStorage.getItem('pc_runners');
        if (ownLayout !== null) {
            saved = JSON.parse(ownLayout || '[]');
        } else if (window.tsrctStartsClean && window.tsrctStartsClean()) {
            saved = [];                      // opened beside a live window -> start clean
        } else {
            saved = JSON.parse(localStorage.getItem('pc_runners') || '[]');
        }

        // Get list of actual tmux sessions starting with "run-"
        const res = await fetch('/api/runner/list', {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();
        const activeSessions = new Set(data.sessions || []);
        const savedSessionNames = new Set(saved.map(r => r.session));

        // Only restore runners that still exist in tmux
        Desktop.runners = saved.filter(r => activeSessions.has(r.session)).map(r => ({
            ...r,
            status: 'running',
            output: ''
        }));

        // Detect orphan sessions (exist in tmux but not in localStorage)
        const orphans = [...activeSessions].filter(s => !savedSessionNames.has(s));
        if (orphans.length > 0) {
            orphans.forEach(session => {
                const name = session.replace('run-', '');
                Desktop.runners.push({
                    id: `runner-orphan-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    name: name.substring(0, 8),
                    cwd: '~',
                    session: session,
                    status: 'running',
                    output: '',
                    startTime: Date.now(),
                    orphan: true
                });
            });
        }

        // Start polling for active runners
        Desktop.runners.forEach(r => runnerStartPolling(r));

        renderRunners();
        saveRunners();
    } catch (e) {
        console.error('[RUNNERS] Failed to load:', e);
        Desktop.runners = [];
        renderRunners();
    }
}

// Sync runners with actual tmux state
async function runnerSyncSessions() {
    try {
        // Stop all current polling
        Desktop.runners.forEach(r => {
            if (r.pollInterval) clearInterval(r.pollInterval);
        });

        // Reload from tmux
        await loadRunners();

        if (typeof toast === 'function') toast('Runners synced', 'success');
    } catch (e) {
        if (typeof toast === 'function') toast('Sync failed', 'error');
    }
}

function saveRunners() {
    try {
        // Save only essential data (not output or polling intervals)
        const toSave = Desktop.runners.map(r => ({
            id: r.id,
            name: r.name,
            cwd: r.cwd,
            session: r.session,
            startTime: r.startTime
        }));
        // This window's own layout (per-window), plus a shared "last layout"
        // snapshot that only a solo window will ever restore from.
        try { sessionStorage.setItem('pc_runners', JSON.stringify(toSave)); } catch (e) {}
        localStorage.setItem('pc_runners', JSON.stringify(toSave));
        // Counter stays shared so two windows can never mint the same runner id.
        localStorage.setItem('pc_runner_counter', Desktop.runnerIdCounter.toString());
    } catch (e) {
        console.error('[RUNNERS] Failed to save:', e);
    }
}

async function runnerShowCreate() {
    const modal = document.createElement('div');
    modal.className = 'pc-runner-modal';
    modal.id = 'runner-create-modal';
    modal.innerHTML = `
        <div class="pc-runner-modal-content">
            <div class="pc-runner-modal-header">
                <span>New Runner</span>
                <button onclick="runnerCloseCreate()">[x]</button>
            </div>
            <div class="pc-runner-modal-body">
                <div class="pc-runner-field">
                    <label>Name</label>
                    <input type="text" id="runner-name" placeholder="api, web, db..." maxlength="8" autocomplete="off">
                </div>
                <div class="pc-runner-field">
                    <label>Directory</label>
                    <div class="pc-runner-dir-picker">
                        <input type="text" id="runner-cwd" value="${window.TSRCT_PROJECTS_ROOT}" placeholder="/path/to/project" autocomplete="off">
                        <button onclick="runnerToggleDirDropdown()" class="pc-runner-dir-btn">[v]</button>
                    </div>
                    <div id="runner-dir-dropdown" class="pc-runner-dir-dropdown hidden">
                        <div class="pc-runner-dir-path" id="runner-dir-path">~</div>
                        <div class="pc-runner-dir-list" id="runner-dir-list">
                            <div class="pc-runner-dir-loading">Loading...</div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="pc-runner-modal-footer">
                <button class="cancel" onclick="runnerCloseCreate()">Cancel</button>
                <button class="create" onclick="runnerCreate()">Create [>]</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Focus name input
    setTimeout(() => document.getElementById('runner-name')?.focus(), 100);

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) runnerCloseCreate();
    });

    // Enter to create
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !document.getElementById('runner-dir-dropdown')?.classList.contains('hidden') === false) {
            runnerCreate();
        }
        if (e.key === 'Escape') {
            const dropdown = document.getElementById('runner-dir-dropdown');
            if (dropdown && !dropdown.classList.contains('hidden')) {
                dropdown.classList.add('hidden');
            } else {
                runnerCloseCreate();
            }
        }
    });
}

function runnerCloseCreate() {
    document.getElementById('runner-create-modal')?.remove();
}

// Directory browser for runner creation
async function runnerToggleDirDropdown() {
    const dropdown = document.getElementById('runner-dir-dropdown');
    if (!dropdown) return;

    if (dropdown.classList.contains('hidden')) {
        dropdown.classList.remove('hidden');
        const cwd = document.getElementById('runner-cwd')?.value || window.TSRCT_PROJECTS_ROOT;
        await runnerBrowseDir(cwd);
    } else {
        dropdown.classList.add('hidden');
    }
}

async function runnerBrowseDir(dir) {
    const listEl = document.getElementById('runner-dir-list');
    const pathEl = document.getElementById('runner-dir-path');
    if (!listEl) return;

    listEl.innerHTML = '<div class="pc-runner-dir-loading">Loading...</div>';

    try {
        const res = await fetch(`/api/runner/browse?dir=${encodeURIComponent(dir)}`, {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();

        if (data.error) {
            listEl.innerHTML = `<div class="pc-runner-dir-error">${escapeHtml(data.error)}</div>`;
            return;
        }

        if (pathEl) pathEl.textContent = data.current || dir;

        let html = '';

        // Parent directory
        if (data.parent) {
            html += `<div class="pc-runner-dir-item pc-runner-dir-up" onclick="runnerBrowseDir('${escapeHtml(data.parent)}')">[..] Parent</div>`;
        }

        // Select current directory
        html += `<div class="pc-runner-dir-item pc-runner-dir-select" onclick="runnerSelectDir('${escapeHtml(data.current)}')">[*] Select this directory</div>`;

        // Directories
        if (data.directories && data.directories.length > 0) {
            data.directories.forEach(d => {
                html += `<div class="pc-runner-dir-item">
                    <span class="pc-runner-dir-name" onclick="runnerBrowseDir('${escapeHtml(d.path)}')">[>] ${escapeHtml(d.name)}</span>
                    <button class="pc-runner-dir-pick" onclick="event.stopPropagation(); runnerSelectDir('${escapeHtml(d.path)}')" title="Select">[*]</button>
                </div>`;
            });
        } else {
            html += '<div class="pc-runner-dir-empty">No subdirectories</div>';
        }

        listEl.innerHTML = html;

    } catch (e) {
        listEl.innerHTML = `<div class="pc-runner-dir-error">Failed to browse</div>`;
    }
}

function runnerSelectDir(path) {
    const cwdInput = document.getElementById('runner-cwd');
    if (cwdInput) cwdInput.value = path;
    document.getElementById('runner-dir-dropdown')?.classList.add('hidden');
}

async function runnerCreate() {
    const nameInput = document.getElementById('runner-name');
    const cwdInput = document.getElementById('runner-cwd');

    const name = nameInput?.value.trim() || `r${Desktop.runnerIdCounter}`;
    const cwd = cwdInput?.value.trim() || '~';

    const runnerId = `runner-${Date.now()}`;
    const sessionName = `run-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

    // Create runner object
    const runner = {
        id: runnerId,
        name: name.substring(0, 8),
        cwd,
        session: sessionName,
        status: 'starting',
        output: '',
        startTime: Date.now()
    };

    Desktop.runners.push(runner);
    Desktop.runnerIdCounter++;

    runnerCloseCreate();
    renderRunners();
    saveRunners();

    // Start the runner via API (just opens terminal at directory)
    try {
        const res = await fetch('/api/runner/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ session: sessionName, cwd })
        });

        const data = await res.json();

        if (data.success) {
            runner.status = 'running';
            runnerStartPolling(runner);
            // Auto-open the runner view for immediate interaction
            runnerView(runnerId);
        } else {
            runner.status = 'error';
            runner.output = data.error || 'Failed to start';
        }
    } catch (e) {
        runner.status = 'error';
        runner.output = e.message;
    }

    renderRunners();
}

function renderRunners() {
    const container = document.getElementById('pc-runners');
    if (!container) return;

    if (Desktop.runners.length === 0) {
        container.innerHTML = `<div class="pc-runners-empty">Click [+] to add</div>`;
        return;
    }

    container.innerHTML = Desktop.runners.map(r => `
        <div class="pc-runner ${r.status}${r.orphan ? ' orphan' : ''}" data-id="${r.id}" onclick="runnerView('${r.id}')" title="${r.orphan ? '[Recovered] ' : ''}${escapeHtml(r.cwd)}">
            <div class="pc-runner-header">
                <span class="pc-runner-name">${r.orphan ? '[?] ' : ''}${escapeHtml(r.name)}</span>
                <span class="pc-runner-status">${r.status === 'running' ? '[*]' : r.status === 'starting' ? '[~]' : '[x]'}</span>
            </div>
            <div class="pc-runner-output">${escapeHtml((r.output || '').slice(-50) || '...')}</div>
            <div class="pc-runner-actions">
                <button onclick="event.stopPropagation(); runnerRemove('${r.id}')" title="Remove">[x]</button>
            </div>
        </div>
    `).join('');
}

function runnerStartPolling(runner) {
    if (!runner._pollInterval) {
        runner._pollInterval = setInterval(() => runnerPollOutput(runner), 1000);
    }
}

function runnerStopPolling(runner) {
    if (runner._pollInterval) {
        clearInterval(runner._pollInterval);
        runner._pollInterval = null;
    }
}

async function runnerPollOutput(runner) {
    try {
        const res = await fetch(`/api/runner/output?session=${runner.session}`, {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();

        if (data.output !== undefined) {
            runner.output = data.output;
            runner.status = data.running ? 'running' : 'stopped';

            if (!data.running) {
                runnerStopPolling(runner);
            }
        }
    } catch (e) {
        runner.status = 'error';
    }

    renderRunners();
}

async function runnerRemove(id) {
    const runner = Desktop.runners.find(r => r.id === id);
    if (!runner) return;

    // Kill the tmux session
    try {
        await fetch('/api/runner/kill', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ session: runner.session })
        });
    } catch (e) {}

    runnerStopPolling(runner);
    Desktop.runners = Desktop.runners.filter(r => r.id !== id);

    // Close the view window if open
    runnerCloseView(id);

    renderRunners();
    saveRunners();
}

// Track open runner windows for staggering positions
let openRunnerWindows = [];
let runnerZIndex = 1000;

function runnerView(id) {
    const runner = Desktop.runners.find(r => r.id === id);
    if (!runner) return;

    const viewId = `runner-view-${id}`;

    // If already open, just focus it
    const existing = document.getElementById(viewId);
    if (existing) {
        runnerFocusWindow(viewId);
        return;
    }

    // Store current runner ID for input handling
    Desktop.currentRunnerId = id;

    // Calculate staggered position for new window
    const openCount = openRunnerWindows.length;
    const baseTop = 80 + (openCount * 30);
    const baseLeft = 300 + (openCount * 30);

    // Create floating window (no backdrop)
    const modal = document.createElement('div');
    modal.className = 'pc-runner-floating';
    modal.id = viewId;
    modal.innerHTML = `
        <div class="pc-runner-view-content" style="top: ${baseTop}px; left: ${baseLeft}px; width: 600px; height: 450px;">
            <div class="pc-runner-modal-header" data-runner-id="${id}">
                <span>${escapeHtml(runner.name)}</span>
                <div class="pc-runner-view-actions">
                    <button onclick="runnerExportOutput('${id}')" title="Export to .md">[E]</button>
                    <button onclick="runnerToggleNanoMode('${id}')" title="Nano Mode" id="runner-nano-toggle-${id}" class="pc-runner-nano-toggle">[N]</button>
                    <button onclick="runnerSendCtrl('c', '${id}')" title="^C">[C]</button>
                    <button onclick="runnerSendCtrl('d', '${id}')" title="^D">[D]</button>
                    <button onclick="runnerSendCtrl('z', '${id}')" title="^Z">[Z]</button>
                    <button onclick="runnerCloseView('${id}')">[x]</button>
                </div>
            </div>
            <div class="pc-runner-view-output" id="runner-output-${id}">${escapeHtml(runner.output) || 'Waiting for output...'}</div>

            <!-- Nano Mode Panel (hidden by default) - Compact -->
            <div class="pc-runner-nano-panel hidden" id="runner-nano-panel-${id}">
                <div class="pc-runner-nano-bar">
                    <div class="pc-runner-nano-cmds">
                        <button onclick="runnerSendCtrl('o', '${id}')" title="^O Save">Save</button>
                        <button onclick="runnerSendCtrl('x', '${id}')" title="^X Exit">Exit</button>
                        <button onclick="runnerSendCtrl('k', '${id}')" title="^K Cut">Cut</button>
                        <button onclick="runnerSendCtrl('u', '${id}')" title="^U Paste">Paste</button>
                        <button onclick="runnerSendCtrl('w', '${id}')" title="^W Find">Find</button>
                        <button onclick="runnerSendCtrl('g', '${id}')" title="^G Help">Help</button>
                    </div>
                    <div class="pc-runner-nano-arrows">
                        <button onclick="runnerNanoKey('${id}', 'Up')">[^]</button>
                        <button onclick="runnerNanoKey('${id}', 'Down')">[v]</button>
                        <button onclick="runnerNanoKey('${id}', 'Left')">[<]</button>
                        <button onclick="runnerNanoKey('${id}', 'Right')">[>]</button>
                    </div>
                    <div class="pc-runner-nano-actions">
                        <button onclick="runnerNanoKey('${id}', 'Enter')" title="Enter">RET</button>
                        <button onclick="runnerNanoKey('${id}', 'BSpace')" title="Backspace">DEL</button>
                        <button onclick="runnerNanoBulkOpen('${id}')" title="Bulk text input" class="pc-runner-nano-bulk-btn">[+]</button>
                    </div>
                </div>
                <input type="text" id="runner-nano-input-${id}" class="pc-runner-nano-keys" placeholder="type here..." autocomplete="off" spellcheck="false">
            </div>

            <div class="pc-runner-view-input" id="runner-normal-input-${id}">
                <span class="pc-runner-prompt">$</span>
                <input type="text" id="runner-cmd-input-${id}" placeholder="Type command..." autocomplete="off" spellcheck="false">
                <button onclick="runnerSendCmdTo('${id}')" title="Send">[>]</button>
            </div>
            <div class="pc-runner-view-footer">
                <span class="pc-runner-view-cwd">${escapeHtml(runner.cwd)}</span>
                <div class="pc-runner-quick-cmds">
                    <button onclick="runnerQuickCmdTo('${id}', 'ls -la')">ls</button>
                    <button onclick="runnerQuickCmdTo('${id}', 'npm run dev')">dev</button>
                    <button onclick="runnerQuickCmdTo('${id}', 'npm start')">start</button>
                    <button onclick="runnerQuickCmdTo('${id}', 'npm install')">install</button>
                </div>
                <span class="pc-runner-view-status ${runner.status}" id="runner-status-${id}">${runner.status}</span>
            </div>
            <div class="pc-runner-resize-handle" data-runner-id="${id}"></div>
        </div>
    `;

    document.body.appendChild(modal);
    openRunnerWindows.push(id);

    // Focus this window
    runnerFocusWindow(viewId);

    // Setup drag functionality
    const content = modal.querySelector('.pc-runner-view-content');
    const header = modal.querySelector('.pc-runner-modal-header');
    runnerSetupDrag(header, content, viewId);

    // Setup resize functionality
    const resizeHandle = modal.querySelector('.pc-runner-resize-handle');
    runnerSetupResize(resizeHandle, content);

    // Focus input
    setTimeout(() => document.getElementById(`runner-cmd-input-${id}`)?.focus(), 100);

    // Click on window brings it to front
    content.addEventListener('mousedown', () => {
        runnerFocusWindow(viewId);
        Desktop.currentRunnerId = id;
    });

    // Handle input keydown with history navigation
    const cmdInput = document.getElementById(`runner-cmd-input-${id}`);
    if (cmdInput) {
        // Initialize history index for this runner
        if (Desktop.runnerHistoryIndex[id] === undefined) {
            Desktop.runnerHistoryIndex[id] = -1;
        }

        cmdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.ctrlKey) {
                e.preventDefault();
                runnerSendCmdTo(id);
            } else if (e.ctrlKey && e.key === 'Enter') {
                // Ctrl+Enter sends Enter to terminal (useful for nano, etc.)
                e.preventDefault();
                runnerSendCtrl('m', id); // Ctrl+M is equivalent to Enter in terminal
                runnerShowCtrlIndicator(id, 'Enter');
            } else if (e.key === 'Escape') {
                runnerCloseView(id);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                runnerHistoryNav(id, 'up', cmdInput);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                runnerHistoryNav(id, 'down', cmdInput);
            } else if (e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) {
                // Ctrl+key handling for terminal control
                const key = e.key.toLowerCase();

                // Allow Ctrl+C for clipboard copy if text is selected in input
                if (key === 'c' && cmdInput.selectionStart !== cmdInput.selectionEnd) {
                    return; // Let browser handle copy
                }
                // Allow Ctrl+V for paste into input
                if (key === 'v') {
                    return; // Let browser handle paste
                }
                // Allow Ctrl+A for select all in input
                if (key === 'a') {
                    return; // Let browser handle select all
                }
                // Allow Ctrl+X for cut if text is selected
                if (key === 'x' && cmdInput.selectionStart !== cmdInput.selectionEnd) {
                    return; // Let browser handle cut
                }

                // Send all other Ctrl+keys to terminal
                e.preventDefault();
                e.stopPropagation();
                runnerSendCtrl(key, id);
                runnerShowCtrlIndicator(id, key);
            }
        });
    }

    // Also capture Ctrl+keys on the output area for full terminal interaction
    const outputEl = document.getElementById(`runner-output-${id}`);
    if (outputEl) {
        // Make output focusable
        outputEl.setAttribute('tabindex', '0');

        outputEl.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) {
                const key = e.key.toLowerCase();
                e.preventDefault();
                e.stopPropagation();
                runnerSendCtrl(key, id);
                runnerShowCtrlIndicator(id, key);
            } else if (e.key === 'Escape') {
                runnerCloseView(id);
            }
        });

        // Click output to focus it (for Ctrl+key capture)
        outputEl.addEventListener('click', () => {
            outputEl.focus();
        });
    }

    // Start live refresh for this specific runner
    runner._viewInterval = setInterval(() => {
        const outputEl = document.getElementById(`runner-output-${id}`);
        if (outputEl) {
            // Check if user is near the bottom before updating
            const isNearBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 50;

            outputEl.textContent = runner.output || 'Waiting for output...';

            // Only auto-scroll if user was already at the bottom
            if (isNearBottom) {
                outputEl.scrollTop = outputEl.scrollHeight;
            }
        }
        // Update status
        const statusEl = document.getElementById(`runner-status-${id}`);
        if (statusEl) {
            statusEl.className = `pc-runner-view-status ${runner.status}`;
            statusEl.textContent = runner.status;
        }
    }, 500);
}

// Focus a runner window (bring to front)
function runnerFocusWindow(viewId) {
    // Remove focused class from all
    document.querySelectorAll('.pc-runner-floating').forEach(el => {
        el.classList.remove('focused');
    });
    // Add to this one
    const modal = document.getElementById(viewId);
    if (modal) {
        modal.classList.add('focused');
        runnerZIndex++;
        const content = modal.querySelector('.pc-runner-view-content');
        if (content) {
            content.style.zIndex = runnerZIndex;
        }
    }
}

// Setup drag functionality for runner window
function runnerSetupDrag(header, content, viewId) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
        // Don't drag if clicking buttons (or the projector's session dropdown)
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = content.offsetLeft;
        startTop = content.offsetTop;

        runnerFocusWindow(viewId);

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
    });

    function onMouseMove(e) {
        if (!isDragging) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newLeft = startLeft + dx;
        let newTop = startTop + dy;

        // Keep window within viewport
        newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - 100));
        newTop = Math.max(0, Math.min(newTop, window.innerHeight - 50));

        content.style.left = newLeft + 'px';
        content.style.top = newTop + 'px';
    }

    function onMouseUp() {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }
}

// Setup resize functionality for runner window
function runnerSetupResize(handle, content) {
    let isResizing = false;
    let startX, startY, startWidth, startHeight;

    handle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startWidth = content.offsetWidth;
        startHeight = content.offsetHeight;

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
        e.stopPropagation();
    });

    function onMouseMove(e) {
        if (!isResizing) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        const newWidth = Math.max(400, startWidth + dx);
        const newHeight = Math.max(300, startHeight + dy);

        content.style.width = newWidth + 'px';
        content.style.height = newHeight + 'px';
    }

    function onMouseUp() {
        isResizing = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }
}

// Close a specific runner view window
function runnerCloseView(runnerId) {
    if (runnerId) {
        // Close specific runner
        const runner = Desktop.runners.find(r => r.id === runnerId);
        if (runner && runner._viewInterval) {
            clearInterval(runner._viewInterval);
            runner._viewInterval = null;
        }
        const viewId = `runner-view-${runnerId}`;
        document.getElementById(viewId)?.remove();
        openRunnerWindows = openRunnerWindows.filter(id => id !== runnerId);
    } else {
        // Close all runners (backwards compatibility)
        Desktop.runners.forEach(r => {
            if (r._viewInterval) {
                clearInterval(r._viewInterval);
                r._viewInterval = null;
            }
        });
        document.querySelectorAll('.pc-runner-floating').forEach(el => el.remove());
        openRunnerWindows = [];
    }
}

async function runnerViewRefresh(id) {
    const runner = Desktop.runners.find(r => r.id === id);
    if (runner) {
        await runnerPollOutput(runner);
        const outputEl = document.getElementById(`runner-output-${id}`);
        if (outputEl) {
            outputEl.textContent = runner.output || 'Waiting for output...';
        }
    }
}

// Send command to a specific runner
async function runnerSendCmdTo(runnerId) {
    const input = document.getElementById(`runner-cmd-input-${runnerId}`);
    if (!input) return;

    const cmd = input.value.trim();
    if (!cmd) return;

    const runner = Desktop.runners.find(r => r.id === runnerId);
    if (!runner) return;

    // Save to history
    if (!Desktop.runnerHistory[runner.id]) {
        Desktop.runnerHistory[runner.id] = [];
    }
    // Avoid duplicates at the end
    const hist = Desktop.runnerHistory[runner.id];
    if (hist[hist.length - 1] !== cmd) {
        hist.push(cmd);
        // Keep last 50 commands per runner
        if (hist.length > 50) hist.shift();
        localStorage.setItem('pc_runner_history', JSON.stringify(Desktop.runnerHistory));
    }
    // Reset history index
    Desktop.runnerHistoryIndex[runner.id] = -1;

    input.value = '';

    try {
        await fetch('/api/runner/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ session: runner.session, cmd })
        });

        // Immediate refresh
        await runnerPollOutput(runner);
    } catch (e) {
        console.error('[RUNNER] Send failed:', e);
    }
}

// Legacy: Send command to current runner (backwards compatibility)
async function runnerSendCmd() {
    if (Desktop.currentRunnerId) {
        await runnerSendCmdTo(Desktop.currentRunnerId);
    }
}

// Navigate runner command history
function runnerHistoryNav(runnerId, direction, input) {
    const hist = Desktop.runnerHistory[runnerId] || [];
    if (hist.length === 0) return;

    let idx = Desktop.runnerHistoryIndex[runnerId];

    if (direction === 'up') {
        if (idx === -1) {
            idx = hist.length - 1;
        } else if (idx > 0) {
            idx--;
        }
    } else {
        if (idx === -1) return;
        if (idx < hist.length - 1) {
            idx++;
        } else {
            idx = -1;
            input.value = '';
            Desktop.runnerHistoryIndex[runnerId] = idx;
            return;
        }
    }

    Desktop.runnerHistoryIndex[runnerId] = idx;
    input.value = hist[idx] || '';
    // Move cursor to end
    setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
}

// Quick command button for specific runner
function runnerQuickCmdTo(runnerId, cmd) {
    const input = document.getElementById(`runner-cmd-input-${runnerId}`);
    if (input) {
        input.value = cmd;
        input.focus();
    }
}

// Legacy: Quick command for current runner
function runnerQuickCmd(cmd) {
    if (Desktop.currentRunnerId) {
        runnerQuickCmdTo(Desktop.currentRunnerId, cmd);
    }
}

// Send control key to runner
async function runnerSendCtrl(key, runnerId) {
    const targetId = runnerId || Desktop.currentRunnerId;
    const runner = Desktop.runners.find(r => r.id === targetId);
    if (!runner) return;

    try {
        await fetch('/api/runner/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ session: runner.session, ctrl: key })
        });

        // Immediate refresh
        setTimeout(() => runnerPollOutput(runner), 200);
    } catch (e) {
        console.error('[RUNNER] Ctrl send failed:', e);
    }
}

// Show visual indicator when Ctrl+key is sent to terminal
function runnerShowCtrlIndicator(runnerId, key) {
    const outputEl = document.getElementById(`runner-output-${runnerId}`);
    if (!outputEl) return;

    // Create indicator element
    const indicator = document.createElement('div');
    indicator.className = 'pc-runner-ctrl-indicator';
    indicator.textContent = `^${key.toUpperCase()}`;

    // Position relative to output area
    const rect = outputEl.getBoundingClientRect();
    indicator.style.position = 'fixed';
    indicator.style.top = `${rect.top + 10}px`;
    indicator.style.right = `${window.innerWidth - rect.right + 10}px`;

    document.body.appendChild(indicator);

    // Fade out and remove
    setTimeout(() => {
        indicator.classList.add('fade-out');
        setTimeout(() => indicator.remove(), 300);
    }, 400);
}

// Export runner output to markdown file in runner's directory
async function runnerExportOutput(runnerId) {
    const targetId = runnerId || Desktop.currentRunnerId;
    const runner = Desktop.runners.find(r => r.id === targetId);
    if (!runner) {
        if (typeof toast === 'function') toast('No runner selected', 'error');
        return;
    }

    const output = runner.output || '';
    if (!output.trim()) {
        if (typeof toast === 'function') toast('No output to export', 'error');
        return;
    }

    // Format as markdown
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `runner-${runner.name}-${timestamp}.md`;

    const markdown = `# Runner Output: ${runner.name}

## Metadata
- **Runner**: ${runner.name}
- **Session**: ${runner.session}
- **Directory**: ${runner.cwd}
- **Status**: ${runner.status}
- **Exported**: ${new Date().toLocaleString()}

## Terminal Output

\`\`\`
${output}
\`\`\`
`;

    // Save to runner's directory via server
    try {
        const res = await fetch('/api/runner/export', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({
                filename,
                content: markdown,
                cwd: runner.cwd
            })
        });

        const data = await res.json();
        if (data.success) {
            if (typeof toast === 'function') toast(`Exported: ${data.path}`, 'success');
        } else {
            if (typeof toast === 'function') toast(`Export failed: ${data.error}`, 'error');
        }
    } catch (e) {
        if (typeof toast === 'function') toast(`Export error: ${e.message}`, 'error');
    }
}

// ==============================================
// NANO MODE - Terminal Editor Support
// ==============================================

// Track nano mode state per runner
const runnerNanoModeState = {};

// Toggle nano mode for a runner
function runnerToggleNanoMode(runnerId) {
    const panel = document.getElementById(`runner-nano-panel-${runnerId}`);
    const toggle = document.getElementById(`runner-nano-toggle-${runnerId}`);
    const normalInput = document.getElementById(`runner-normal-input-${runnerId}`);
    const nanoInput = document.getElementById(`runner-nano-input-${runnerId}`);

    if (!panel || !toggle) return;

    const isActive = !panel.classList.contains('hidden');

    if (isActive) {
        // Deactivate nano mode
        panel.classList.add('hidden');
        toggle.classList.remove('active');
        if (normalInput) normalInput.classList.remove('hidden');
        runnerNanoModeState[runnerId] = false;
        if (typeof toast === 'function') toast('Nano mode OFF', 'info');
    } else {
        // Activate nano mode
        panel.classList.remove('hidden');
        toggle.classList.add('active');
        if (normalInput) normalInput.classList.add('hidden');
        runnerNanoModeState[runnerId] = true;
        if (nanoInput) {
            nanoInput.focus();
            runnerSetupNanoInput(runnerId);
        }
        if (typeof toast === 'function') toast('Nano mode ON - Keys sent directly', 'success');
    }
}

// Setup nano input to send each keystroke
function runnerSetupNanoInput(runnerId) {
    const input = document.getElementById(`runner-nano-input-${runnerId}`);
    if (!input || input._nanoSetup) return;

    input._nanoSetup = true;

    input.addEventListener('keydown', async (e) => {
        const runner = Desktop.runners.find(r => r.id === runnerId);
        if (!runner) return;

        // Handle special keys
        if (e.key === 'Escape') {
            runnerToggleNanoMode(runnerId);
            return;
        }

        // Ctrl combinations
        if (e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) {
            e.preventDefault();
            runnerSendCtrl(e.key.toLowerCase(), runnerId);
            runnerShowCtrlIndicator(runnerId, e.key.toLowerCase());
            return;
        }

        // Alt/Meta combinations (for nano M- commands)
        if (e.altKey && e.key.length === 1) {
            e.preventDefault();
            runnerNanoKey(runnerId, `M-${e.key.toLowerCase()}`);
            return;
        }

        // Arrow keys
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            const keyMap = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
            runnerNanoKey(runnerId, keyMap[e.key]);
            return;
        }

        // Special keys
        const specialKeys = {
            'Enter': 'Enter',
            'Backspace': 'BSpace',
            'Delete': 'DC',
            'Tab': 'Tab',
            'Home': 'Home',
            'End': 'End',
            'PageUp': 'PgUp',
            'PageDown': 'PgDn'
        };

        if (specialKeys[e.key]) {
            e.preventDefault();
            runnerNanoKey(runnerId, specialKeys[e.key]);
            return;
        }

        // Regular character - send it directly
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            runnerNanoSendChar(runnerId, e.key);
            input.value = ''; // Clear input after each char
        }
    });

    // Also handle paste
    input.addEventListener('paste', async (e) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text');
        if (text) {
            runnerNanoSendText(runnerId, text);
        }
    });
}

// Send a special key to nano via tmux
async function runnerNanoKey(runnerId, key) {
    const runner = Desktop.runners.find(r => r.id === runnerId);
    if (!runner) return;

    try {
        await fetch('/api/runner/send-key', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ session: runner.session, key: key })
        });

        // Immediate refresh
        setTimeout(() => runnerPollOutput(runner), 100);
    } catch (e) {
        console.error('[RUNNER] Nano key send failed:', e);
    }
}

// Send a single character to nano
async function runnerNanoSendChar(runnerId, char) {
    const runner = Desktop.runners.find(r => r.id === runnerId);
    if (!runner) return;

    try {
        await fetch('/api/runner/send-char', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ session: runner.session, char: char })
        });

        // Immediate refresh
        setTimeout(() => runnerPollOutput(runner), 50);
    } catch (e) {
        console.error('[RUNNER] Nano char send failed:', e);
    }
}

// Send text (for paste) to nano
async function runnerNanoSendText(runnerId, text) {
    const runner = Desktop.runners.find(r => r.id === runnerId);
    if (!runner) return;

    try {
        await fetch('/api/runner/send-text', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ session: runner.session, text: text })
        });

        // Refresh
        setTimeout(() => runnerPollOutput(runner), 100);
        if (typeof toast === 'function') toast('Text pasted', 'success');
    } catch (e) {
        console.error('[RUNNER] Nano text send failed:', e);
    }
}

// Track bulk windows
let nanoBulkZIndex = 90000;

// Open bulk text floating window for runner
function runnerNanoBulkOpen(runnerId) {
    const windowId = `nano-bulk-window-${runnerId}`;

    // If already open, focus it
    const existing = document.getElementById(windowId);
    if (existing) {
        nanoBulkFocusWindow(windowId);
        return;
    }

    // Calculate position (offset from runner window if exists)
    const runnerView = document.getElementById(`runner-view-${runnerId}`);
    let top = 100, left = 350;
    if (runnerView) {
        const content = runnerView.querySelector('.pc-runner-view-content');
        if (content) {
            const rect = content.getBoundingClientRect();
            top = rect.top + 40;
            left = rect.left + 40;
        }
    }

    const win = document.createElement('div');
    win.id = windowId;
    win.className = 'pc-nano-bulk-floating';
    win.innerHTML = `
        <div class="pc-nano-bulk-content" style="top: ${top}px; left: ${left}px;">
            <div class="pc-nano-bulk-header" data-bulk-id="${runnerId}">
                <span>BULK EDITOR</span>
                <div class="pc-nano-bulk-actions">
                    <button onclick="runnerNanoBulkClose('${runnerId}')">[x]</button>
                </div>
            </div>
            <div class="pc-nano-bulk-toolbar">
                <button onclick="runnerNanoBulkPull('${runnerId}')" title="Capture screen content">[Pull Screen]</button>
                <div class="pc-nano-bulk-mode">
                    <button id="nano-bulk-mode-add-${runnerId}" class="active" onclick="runnerNanoBulkSetMode('${runnerId}', 'add')">Add</button>
                    <button id="nano-bulk-mode-replace-${runnerId}" onclick="runnerNanoBulkSetMode('${runnerId}', 'replace')">Replace</button>
                </div>
                <button onclick="runnerNanoBulkSend('${runnerId}')" title="Send to nano" class="pc-nano-bulk-send">[Send]</button>
            </div>
            <textarea id="nano-bulk-textarea-${runnerId}" placeholder="paste or edit code here..." spellcheck="false"></textarea>
            <div class="pc-nano-bulk-footer">
                <span id="nano-bulk-status-${runnerId}">Mode: Add</span>
            </div>
            <div class="pc-nano-bulk-resize" data-bulk-id="${runnerId}"></div>
        </div>
    `;

    // Store mode state
    if (!window.nanoBulkModes) window.nanoBulkModes = {};
    window.nanoBulkModes[runnerId] = 'add';

    document.body.appendChild(win);
    nanoBulkFocusWindow(windowId);

    // Setup drag
    const content = win.querySelector('.pc-nano-bulk-content');
    const header = win.querySelector('.pc-nano-bulk-header');
    nanoBulkSetupDrag(header, content, windowId);

    // Setup resize
    const resizeHandle = win.querySelector('.pc-nano-bulk-resize');
    nanoBulkSetupResize(resizeHandle, content);

    // Focus textarea
    setTimeout(() => document.getElementById(`nano-bulk-textarea-${runnerId}`)?.focus(), 100);

    // Click brings to front
    content.addEventListener('mousedown', () => nanoBulkFocusWindow(windowId));
}

// Focus bulk window
function nanoBulkFocusWindow(windowId) {
    document.querySelectorAll('.pc-nano-bulk-floating').forEach(el => el.classList.remove('focused'));
    const win = document.getElementById(windowId);
    if (win) {
        win.classList.add('focused');
        nanoBulkZIndex++;
        const content = win.querySelector('.pc-nano-bulk-content');
        if (content) content.style.zIndex = nanoBulkZIndex;
    }
}

// Setup drag for bulk window
function nanoBulkSetupDrag(header, content, windowId) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = content.offsetLeft;
        startTop = content.offsetTop;
        nanoBulkFocusWindow(windowId);
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        content.style.left = Math.max(0, startLeft + dx) + 'px';
        content.style.top = Math.max(0, startTop + dy) + 'px';
    });

    document.addEventListener('mouseup', () => isDragging = false);
}

// Setup resize for bulk window
function nanoBulkSetupResize(handle, content) {
    let isResizing = false;
    let startX, startY, startW, startH;

    handle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = content.offsetWidth;
        startH = content.offsetHeight;
        e.preventDefault();
        e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const w = Math.max(300, Math.min(startW + (e.clientX - startX), window.innerWidth * 0.9));
        const h = Math.max(200, Math.min(startH + (e.clientY - startY), window.innerHeight * 0.9));
        content.style.width = w + 'px';
        content.style.height = h + 'px';
    });

    document.addEventListener('mouseup', () => isResizing = false);
}

// Close bulk window
function runnerNanoBulkClose(runnerId) {
    document.getElementById(`nano-bulk-window-${runnerId}`)?.remove();
    if (window.nanoBulkModes) delete window.nanoBulkModes[runnerId];
}

// Set mode (add or replace)
function runnerNanoBulkSetMode(runnerId, mode) {
    if (!window.nanoBulkModes) window.nanoBulkModes = {};
    window.nanoBulkModes[runnerId] = mode;

    // Update button states
    const addBtn = document.getElementById(`nano-bulk-mode-add-${runnerId}`);
    const replaceBtn = document.getElementById(`nano-bulk-mode-replace-${runnerId}`);
    const status = document.getElementById(`nano-bulk-status-${runnerId}`);

    if (addBtn && replaceBtn) {
        addBtn.classList.toggle('active', mode === 'add');
        replaceBtn.classList.toggle('active', mode === 'replace');
    }
    if (status) {
        status.textContent = `Mode: ${mode === 'add' ? 'Add' : 'Replace'}`;
    }
}

// Pull screen content into textarea (captures what's visible in tmux, strips nano UI)
async function runnerNanoBulkPull(runnerId) {
    const textarea = document.getElementById(`nano-bulk-textarea-${runnerId}`);
    const runner = Desktop.runners.find(r => r.id === runnerId);

    if (!textarea || !runner) return;

    try {
        if (typeof toast === 'function') toast('Capturing screen...', 'info');

        const res = await fetch('/api/runner/read-file', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ session: runner.session })
        });

        const data = await res.json();
        if (data.success) {
            textarea.value = data.content;
            if (typeof toast === 'function') toast('Screen captured', 'success');
        } else {
            if (typeof toast === 'function') toast(`Error: ${data.error}`, 'error');
        }
    } catch (e) {
        if (typeof toast === 'function') toast(`Failed: ${e.message}`, 'error');
    }
}

// Send bulk text (respects add/replace mode)
async function runnerNanoBulkSend(runnerId) {
    const textarea = document.getElementById(`nano-bulk-textarea-${runnerId}`);
    const runner = Desktop.runners.find(r => r.id === runnerId);
    if (!textarea || !runner) return;

    const text = textarea.value;
    if (!text) {
        if (typeof toast === 'function') toast('Nothing to send', 'error');
        return;
    }

    const mode = window.nanoBulkModes?.[runnerId] || 'add';

    try {
        if (mode === 'replace') {
            // First clear nano content: M-\ (go to start), M-} (mark to end), Ctrl-K (cut)
            // Or simpler: Ctrl-6 (mark), M-> (end of file), Ctrl-K (cut all)
            if (typeof toast === 'function') toast('Replacing content...', 'info');

            // Select all and cut in nano
            await fetch('/api/runner/send-key', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': (typeof token !== 'undefined' ? token : '')
                },
                body: JSON.stringify({ session: runner.session, key: 'M-\\\\' }) // Go to start
            });
            await new Promise(r => setTimeout(r, 50));

            await fetch('/api/runner/send', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': (typeof token !== 'undefined' ? token : '')
                },
                body: JSON.stringify({ session: runner.session, ctrl: '6' }) // Set mark
            });
            await new Promise(r => setTimeout(r, 50));

            await fetch('/api/runner/send-key', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': (typeof token !== 'undefined' ? token : '')
                },
                body: JSON.stringify({ session: runner.session, key: 'M-/' }) // Go to end
            });
            await new Promise(r => setTimeout(r, 50));

            await fetch('/api/runner/send', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': (typeof token !== 'undefined' ? token : '')
                },
                body: JSON.stringify({ session: runner.session, ctrl: 'k' }) // Cut
            });
            await new Promise(r => setTimeout(r, 100));
        }

        // Send the text
        await runnerNanoSendText(runnerId, text);

        if (typeof toast === 'function') toast(mode === 'replace' ? 'Content replaced' : 'Text added', 'success');
    } catch (e) {
        if (typeof toast === 'function') toast(`Error: ${e.message}`, 'error');
    }
}

window.runnerShowCreate = runnerShowCreate;
window.runnerSyncSessions = runnerSyncSessions;
window.runnerCloseCreate = runnerCloseCreate;
window.runnerCreate = runnerCreate;
window.runnerToggleDirDropdown = runnerToggleDirDropdown;
window.runnerBrowseDir = runnerBrowseDir;
window.runnerSelectDir = runnerSelectDir;
window.runnerRemove = runnerRemove;
window.runnerView = runnerView;
window.runnerCloseView = runnerCloseView;
window.runnerViewRefresh = runnerViewRefresh;
window.runnerSendCmd = runnerSendCmd;
window.runnerSendCmdTo = runnerSendCmdTo;
window.runnerQuickCmd = runnerQuickCmd;
window.runnerQuickCmdTo = runnerQuickCmdTo;
window.runnerSendCtrl = runnerSendCtrl;
window.runnerExportOutput = runnerExportOutput;
window.runnerFocusWindow = runnerFocusWindow;
window.runnerSetupDrag = runnerSetupDrag;
window.runnerSetupResize = runnerSetupResize;
window.renderRunners = renderRunners;
// was private; desktop.js's initDesktopMode calls it
window.loadRunners = loadRunners;
// were in desktop.js's "Public API gap" block: reached from generated onclick HTML
Object.assign(window, {
    runnerToggleNanoMode, runnerNanoKey, runnerNanoBulkOpen, runnerNanoBulkClose,
    runnerNanoBulkPull, runnerNanoBulkSend, runnerNanoBulkSetMode,
});

})();
