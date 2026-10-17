/* ==============================================
   TSRCT - Desktop/PC Mode JavaScript
   Ultimate Terminal Experience - Better than any IDE
   ============================================== */
// Phase 3B: IIFE-wrapped -- internal helpers private; explicit exports are the
// 121 existing scattered window.* assignments + the gap block at the bottom.
(function () {

// ── Preference scopes ───────────────────────────────────────────────────────
// ONE place decides where a preference lives, because picking wrong is what made
// two TSRCT windows look identical (2026-08-13): scope is per-WINDOW vs
// per-BROWSER, and it is a scope decision, not a durability one.
//   window  -> sessionStorage : this window's own working state (which panel is
//              open, how wide the sidebar is, which session it targets). Two
//              monitors want different answers, so this is the default.
//   browser -> localStorage   : a taste that should follow you to every window
//              (theme, font size, sounds).
//   server  -> the `config` table, via an API route the caller owns. Only for
//              things that must survive a reinstall (session groups).
// NOTE: a window opened FROM another window inherits a COPY of its
// sessionStorage, so anything used to detect "am I a new window?" must be
// re-derived per page load, never read from here.
const PREF_STORE = {
    window: () => { try { return window.sessionStorage; } catch (e) { return null; } },
    browser: () => { try { return window.localStorage; } catch (e) { return null; } },
};

function pcPrefGet(key, scope = 'window', fallback = null) {
    const store = (PREF_STORE[scope] || PREF_STORE.window)();
    if (!store) return fallback;
    try {
        const v = store.getItem(key);
        return v === null ? fallback : v;
    } catch (e) { return fallback; }
}

function pcPrefSet(key, value, scope = 'window') {
    const store = (PREF_STORE[scope] || PREF_STORE.window)();
    if (!store) return;
    try {
        if (value === null || value === undefined) store.removeItem(key);
        else store.setItem(key, String(value));
    } catch (e) {}
    // Layout keys are mirrored to the server so a restart's NEW window gets them back.
    if (window.pcLayout && window.pcLayout.KEYS.includes(key)) window.pcLayout.mirror();
}

const Desktop = {
    isPC: false,
    initialized: false,
    commandHistory: [],
    historyIndex: -1,
    currentInput: '', // Save input before navigating history
    terminalContent: '',
    isWorking: false,
    lastOutputLength: 0,
    tunnelUrl: null, // current cloudflared public URL (from /api/status)
    fontSizeLevel: parseInt(localStorage.getItem('pc_font_size') || '2'),

    // Tab state
    activeTab: 'terminal',

    // name -> dispatcher state (waiting_input/failed/working/...). Drives sidebar order.
    sessionStates: {},

    // Auto-suggestions
    suggestions: [],
    selectedSuggestion: -1,

    // Search
    searchOpen: false,
    searchMatches: [],
    searchIndex: 0,

    // Nexus Notes
    notes: JSON.parse(localStorage.getItem('nexus_notes') || '[]'),
    activeNoteId: localStorage.getItem('nexus_active_note') || null,
    notesCollapsed: localStorage.getItem('nexus_notes_collapsed') === 'true',
    notesSaveTimeout: null,

    // Command palette
    paletteOpen: false,
    paletteFilter: '',

    // Smart scroll
    userScrolled: false,
    scrollPosition: 0,

    // Favorites/Bookmarks
    favorites: JSON.parse(localStorage.getItem('pc_favorites') || '[]'),

    // Runners (mini terminals)
    runners: [],
    runnerIdCounter: parseInt(localStorage.getItem('pc_runner_counter') || '0'),
    runnerHistory: JSON.parse(localStorage.getItem('pc_runner_history') || '{}'),
    runnerHistoryIndex: {},

    // Git panel
    git: {
        cwd: localStorage.getItem('pc_git_cwd') || window.TSRCT_PROJECTS_ROOT,
        isRepo: false,
        branch: '',
        branches: [],
        changedCount: 0,
        remoteUrl: '',
        hasUpstream: false,
        lastCommit: ''
    },

    // Quick snippets
    snippets: [
        { label: 'Analyze', cmd: 'Analyze this code and explain what it does', icon: '>' },
        { label: 'Fix', cmd: 'Fix the errors in this code', icon: 'x' },
        { label: 'Refactor', cmd: 'Refactor this to be cleaner and more efficient', icon: '*' },
        { label: 'Test', cmd: 'Write tests for this code', icon: 't' },
        { label: 'Docs', cmd: 'Add documentation and comments', icon: '#' },
        { label: 'Explain', cmd: 'Explain step by step what happened', icon: '?' },
    ],


    // System Notifications
    notifications: {
        enabled: false,
        permission: 'default', // 'granted', 'denied', 'default'
        lastPermissionCheck: null,
        titleFlashing: false,
        originalTitle: document.title,
        flashInterval: null,
    },

    // Voice Input (Speech Recognition)
    voice: {
        recognition: null,
        isRecording: false,
        wantRecording: false,
        lang: 'es-ES', // Default language
    },

    // Combined Terminals (multi-session split view)
    combined: {
        enabled: false,
        sessions: [],           // Array of selected session names
        activeIndex: 0,         // Which panel has focus for input
        pollInterval: null,     // Polling timer reference
        layout: 'auto',         // 'auto' | 'horizontal' | 'vertical'
        groupId: null           // which split group owns what is on screen ('' = manual checkboxes)
    },
    // Desktop session grouping (server-persisted via /api/sessions/groups).
    // groups: [{id, name, collapsed}]; assignments: { sessionName: groupId }
    groups: { groups: [], assignments: {} },
    // Focus mode: prune + flatten the sidebar tree down to the folders that hold a
    // living tmux. A view mode, not data — nothing about the tree itself changes.
    focusMode: false,
    // Split groups: { [groupId]: {sessions, activeIndex, bounds} }. sessionStorage
    // only, and pruned to living tmux on every refresh — a dead session leaves no trace.
    splitGroups: {}
};

// Planning Templates
const PLAN_TEMPLATES = {
    feature: {
        name: 'New Feature',
        icon: 'F',
        tasks: [
            { title: 'Define requirements', type: 'research', size: 'S' },
            { title: 'Design architecture', type: 'research', size: 'M' },
            { title: 'Implement core logic', type: 'feature', size: 'L' },
            { title: 'Add error handling', type: 'feature', size: 'M' },
            { title: 'Write unit tests', type: 'test', size: 'M' },
            { title: 'Integration testing', type: 'test', size: 'M' },
            { title: 'Documentation', type: 'doc', size: 'S' },
        ]
    },
    bug: {
        name: 'Bug Fix',
        icon: 'B',
        tasks: [
            { title: 'Reproduce the bug', type: 'research', size: 'S' },
            { title: 'Investigate root cause', type: 'research', size: 'M' },
            { title: 'Implement fix', type: 'bug', size: 'M' },
            { title: 'Verify fix works', type: 'test', size: 'S' },
            { title: 'Add regression test', type: 'test', size: 'S' },
            { title: 'Update changelog', type: 'doc', size: 'XS' },
        ]
    },
    refactor: {
        name: 'Refactor',
        icon: 'R',
        tasks: [
            { title: 'Map current implementation', type: 'research', size: 'M' },
            { title: 'Identify improvements', type: 'research', size: 'S' },
            { title: 'Plan refactoring steps', type: 'research', size: 'S' },
            { title: 'Execute refactoring', type: 'refactor', size: 'L' },
            { title: 'Verify functionality', type: 'test', size: 'M' },
            { title: 'Clean up & optimize', type: 'refactor', size: 'S' },
        ]
    },
    performance: {
        name: 'Performance',
        icon: 'P',
        tasks: [
            { title: 'Profile current performance', type: 'research', size: 'M' },
            { title: 'Identify bottlenecks', type: 'research', size: 'M' },
            { title: 'Implement optimizations', type: 'feature', size: 'L' },
            { title: 'Benchmark improvements', type: 'test', size: 'M' },
            { title: 'Document changes', type: 'doc', size: 'S' },
        ]
    },
    security: {
        name: 'Security Audit',
        icon: 'S',
        tasks: [
            { title: 'Review authentication', type: 'research', size: 'M' },
            { title: 'Check authorization', type: 'research', size: 'M' },
            { title: 'Audit data validation', type: 'research', size: 'M' },
            { title: 'Review dependencies', type: 'research', size: 'S' },
            { title: 'Fix vulnerabilities', type: 'bug', size: 'L' },
            { title: 'Add security tests', type: 'test', size: 'M' },
        ]
    }
};

// Task type definitions
const TASK_TYPES = {
    feature: { label: 'Feature', icon: 'F', color: 'neon' },
    bug: { label: 'Bug Fix', icon: 'B', color: 'red' },
    refactor: { label: 'Refactor', icon: 'R', color: 'cyan' },
    test: { label: 'Test', icon: 'T', color: 'amber' },
    doc: { label: 'Docs', icon: 'D', color: 'purple' },
    research: { label: 'Research', icon: '?', color: 'pink' },
};

// Task sizes with estimates
const TASK_SIZES = {
    XS: { label: 'XS', description: 'Trivial' },
    S: { label: 'S', description: 'Small' },
    M: { label: 'M', description: 'Medium' },
    L: { label: 'L', description: 'Large' },
    XL: { label: 'XL', description: 'Complex' },
};

// Task statuses
const TASK_STATUSES = {
    pending: { label: 'Pending', icon: ' ' },
    in_progress: { label: 'In Progress', icon: '>' },
    blocked: { label: 'Blocked', icon: '!' },
    done: { label: 'Done', icon: '*' },
};

// Common commands for suggestions
const COMMON_COMMANDS = [
    '/clear', '/compact', '/undo', '/cost', '/help', '/status',
    'git status', 'git diff', 'git log', 'git add .', 'git commit -m ""', 'git push',
    'npm install', 'npm run dev', 'npm run build', 'npm test',
    'ls -la', 'pwd', 'cd ', 'cat ', 'mkdir ', 'rm -rf ',
    'Analyze this project', 'Fix the bug', 'Explain this code', 'Write tests',
    'Refactor this', 'Add documentation', 'Review my changes', 'Continue'
];

// ==============================================
// SYSTEM NOTIFICATIONS
// ==============================================

// Request notification permission
async function initNotifications() {
    if (!('Notification' in window)) {
        console.log('[NOTIFICATIONS] Not supported in this browser');
        return;
    }

    Desktop.notifications.permission = Notification.permission;

    if (Notification.permission === 'granted') {
        Desktop.notifications.enabled = true;
        console.log('[NOTIFICATIONS] Already granted');
    } else if (Notification.permission !== 'denied') {
        // Show a subtle prompt in the UI instead of immediately requesting
        showNotificationPrompt();
    }
}

function showNotificationPrompt() {
    // Disabled - do nothing
    return;
}

function dismissNotificationPrompt() {
    document.getElementById('notification-prompt')?.remove();
    localStorage.setItem('notification_prompt_dismissed', 'true');
}

async function requestNotificationPermission() {
    try {
        const permission = await Notification.requestPermission();
        Desktop.notifications.permission = permission;
        Desktop.notifications.enabled = permission === 'granted';

        document.getElementById('notification-prompt')?.remove();

        if (permission === 'granted') {
            if (typeof toast === 'function') toast('Notifications enabled!', 'success');
            // Show test notification
            showSystemNotification('Notifications Active', 'You will be notified when Claude needs permission approval.');
        } else {
            if (typeof toast === 'function') toast('Notifications denied', 'error');
        }
    } catch (err) {
        console.error('[NOTIFICATIONS] Error requesting permission:', err);
    }
}

function showSystemNotification(title, body, options = {}) {
    if (!Desktop.notifications.enabled) return;

    try {
        const notification = new Notification(title, {
            body: body,
            icon: '/src/assets/icon.png',
            badge: '/src/assets/icon.png',
            tag: options.tag || 'claude-notification',
            requireInteraction: options.requireInteraction || false,
            silent: options.silent || false,
        });

        notification.onclick = () => {
            window.focus();
            notification.close();
            stopTitleFlash();
        };

        // Auto-close after 10 seconds unless requireInteraction
        if (!options.requireInteraction) {
            setTimeout(() => notification.close(), 10000);
        }

        return notification;
    } catch (err) {
        console.error('[NOTIFICATIONS] Error showing notification:', err);
    }
}

// Title flashing for background tab
function startTitleFlash(message = 'Permission Needed') {
    if (Desktop.notifications.titleFlashing) return;

    Desktop.notifications.titleFlashing = true;
    Desktop.notifications.originalTitle = document.title;

    let showOriginal = true;
    Desktop.notifications.flashInterval = setInterval(() => {
        document.title = showOriginal ? `[!] ${message}` : Desktop.notifications.originalTitle;
        showOriginal = !showOriginal;
    }, 1000);
}

function stopTitleFlash() {
    if (!Desktop.notifications.titleFlashing) return;

    Desktop.notifications.titleFlashing = false;
    clearInterval(Desktop.notifications.flashInterval);
    document.title = Desktop.notifications.originalTitle;
}

// Detect permission requests in terminal
function initPermissionDetector() {
    const terminal = document.getElementById('pc-terminal');
    if (!terminal) {
        setTimeout(initPermissionDetector, 1000);
        return;
    }

    // Patterns that indicate a permission request
    const permissionPatterns = [
        /Allow|Deny|allow this|permission/i,
        /\[A\]llow|\[D\]eny/,
        /Yes.*No.*─/i,
        /Do you want to/i,
        /Proceed\?/i,
    ];

    let lastContent = '';
    let permissionShown = false;

    const observer = new MutationObserver(() => {
        const content = terminal.innerText;
        if (content === lastContent) return;

        const newContent = content.slice(lastContent.length);
        lastContent = content;

        // Check if new content contains permission patterns
        const hasPermission = permissionPatterns.some(pattern => pattern.test(newContent));

        if (hasPermission && !permissionShown && document.hidden) {
            permissionShown = true;

            // Show notification
            showSystemNotification(
                'Claude needs permission',
                'A permission request is waiting for your approval.',
                { requireInteraction: true, tag: 'claude-permission' }
            );

            // Flash title
            startTitleFlash('Permission Needed');
        }

        // Reset when content changes significantly (user responded)
        if (permissionShown && !hasPermission) {
            permissionShown = false;
            stopTitleFlash();
        }
    });

    observer.observe(terminal, {
        childList: true,
        subtree: true,
        characterData: true,
    });

    // Stop flashing when tab becomes visible
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            stopTitleFlash();
        }
    });

    console.log('[NOTIFICATIONS] Permission detector initialized');
}

// ==============================================
// VOICE INPUT (Speech Recognition)
// ==============================================

function pcInitSpeechRecognition() {
    const rec = createSpeechRecognizer({
        continuous: true,
        interimResults: false,
        lang: Desktop.voice.lang,
        onResult: (e) => {
            const input = document.getElementById('pc-input');
            if (!input) return;
            // Get the last result
            const result = e.results[e.results.length - 1];
            if (result && result.isFinal) {
                // Lowercase and trim to match mobile behavior
                const text = result[0].transcript.toLowerCase().trim();
                if (!text) return;
                // Add single space between words if needed
                if (input.value && !input.value.endsWith(' ')) input.value += ' ';
                input.value += text;
                input.focus();
            }
        },
        onStart: () => {
            Desktop.voice.isRecording = true;
            document.getElementById('pc-mic-btn')?.classList.add('recording');
            if (typeof toast === 'function') toast('Listening...', 'success');
        },
        onEnd: () => {
            Desktop.voice.isRecording = false;
            // If we want to keep recording, restart
            if (Desktop.voice.wantRecording) {
                try { rec.start(); } catch (e) { /* ignore restart errors */ }
            } else {
                document.getElementById('pc-mic-btn')?.classList.remove('recording');
            }
        },
        onError: (e) => {
            console.error('[VOICE] Error:', e.error);
            Desktop.voice.isRecording = false;
            Desktop.voice.wantRecording = false;
            document.getElementById('pc-mic-btn')?.classList.remove('recording');
            if (e.error === 'not-allowed') {
                if (typeof toast === 'function') toast('Microphone access denied', 'error');
            } else if (e.error === 'network') {
                if (typeof toast === 'function') toast('Voice requires internet connection', 'error');
            } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
                if (typeof toast === 'function') toast('Voice input error: ' + e.error, 'error');
            }
        }
    });
    if (!rec) { console.log('[VOICE] Speech recognition not supported'); return null; }
    return rec;
}

function pcToggleMic() {
    // Open expanded input modal with mic auto-start
    pcOpenExpandedInput(true);
}

function pcToggleVoiceLang() {
    // Toggle between Spanish and English
    if (Desktop.voice.lang === 'es-ES') {
        Desktop.voice.lang = 'en-US';
        if (typeof toast === 'function') toast('Voice: English', 'success');
    } else {
        Desktop.voice.lang = 'es-ES';
        if (typeof toast === 'function') toast('Voice: Spanish', 'success');
    }

    // Reinit recognition with new language
    if (Desktop.voice.recognition) {
        if (Desktop.voice.wantRecording) {
            Desktop.voice.wantRecording = false;
            Desktop.voice.recognition.stop();
        }
        Desktop.voice.recognition = null;
    }
}

// ==============================================
// INPUT EXPAND MODAL
// ==============================================

Desktop.inputExpanded = false;

function pcOpenExpandedInput(startMic = false) {
    if (Desktop.inputExpanded) {
        // If already open and startMic requested, just start mic
        if (startMic) pcExpandedToggleMic();
        return;
    }
    Desktop.inputExpanded = true;

    const input = document.getElementById('pc-input');
    const currentText = input?.value || '';
    const currentLang = Desktop.voice.lang === 'es-ES' ? 'ES' : 'EN';

    // Create modal
    const modal = document.createElement('div');
    modal.id = 'pc-expand-modal';
    modal.className = 'pc-expand-modal';
    modal.innerHTML = `
        <div class="pc-expand-backdrop" onclick="pcCloseExpandedInput(false)"></div>
        <div class="pc-expand-content">
            <div class="pc-expand-header">
                <span>Expanded Input</span>
                <div class="pc-expand-header-actions">
                    <span class="pc-expand-hint">Ctrl+Enter to send</span>
                    <button onclick="pcCloseExpandedInput(false)" title="Close">[x]</button>
                </div>
            </div>
            <textarea id="pc-expand-textarea" placeholder="Type or dictate your message...">${escapeHtml(currentText)}</textarea>
            <div class="pc-expand-footer">
                <div class="pc-expand-mic-controls">
                    <button onclick="pcExpandedToggleMic()" id="pc-expand-mic-btn" title="Toggle microphone">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                        MIC
                    </button>
                    <button onclick="pcExpandedToggleLang()" id="pc-expand-lang-btn" title="Toggle language">${currentLang}</button>
                </div>
                <div class="pc-expand-actions">
                    <button onclick="pcCloseExpandedInput(false)">Cancel</button>
                    <button class="primary" onclick="pcCloseExpandedInput(true)">Send</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Focus and move cursor to end
    const textarea = document.getElementById('pc-expand-textarea');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Handle keyboard
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            pcCloseExpandedInput(false);
        } else if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            pcCloseExpandedInput(true);
        }
    });

    // Auto-start mic if requested
    if (startMic) {
        setTimeout(() => pcExpandedToggleMic(), 100);
    }
}

// Mic for expanded modal - uses same recognition but targets the modal textarea
function pcExpandedToggleMic() {
    if (!Desktop.voice.recognition) {
        Desktop.voice.recognition = pcInitSpeechRecognition();
        if (!Desktop.voice.recognition) {
            if (typeof toast === 'function') toast('Voice not supported', 'error');
            return;
        }
    }

    const btn = document.getElementById('pc-expand-mic-btn');

    if (Desktop.voice.wantRecording) {
        // Stop recording
        Desktop.voice.wantRecording = false;
        Desktop.voice.recognition.stop();
        btn?.classList.remove('recording');
    } else {
        // Start recording - redirect results to modal textarea
        Desktop.voice.wantRecording = true;
        Desktop.voice.recognition.onresult = pcExpandedOnResult;
        try {
            Desktop.voice.recognition.start();
            btn?.classList.add('recording');
        } catch (e) {
            Desktop.voice.recognition.stop();
            setTimeout(() => {
                if (Desktop.voice.wantRecording) {
                    Desktop.voice.recognition.start();
                    btn?.classList.add('recording');
                }
            }, 100);
        }
    }
}

function pcExpandedOnResult(e) {
    const textarea = document.getElementById('pc-expand-textarea');
    if (!textarea) return;

    const result = e.results[e.results.length - 1];
    if (result && result.isFinal) {
        const text = result[0].transcript.toLowerCase().trim();
        if (!text) return;

        // Add single space between words if needed
        if (textarea.value && !textarea.value.endsWith(' ') && !textarea.value.endsWith('\n')) {
            textarea.value += ' ';
        }
        textarea.value += text;
        textarea.focus();
    }
}

function pcExpandedToggleLang() {
    if (Desktop.voice.lang === 'es-ES') {
        Desktop.voice.lang = 'en-US';
    } else {
        Desktop.voice.lang = 'es-ES';
    }

    const btn = document.getElementById('pc-expand-lang-btn');
    if (btn) btn.textContent = Desktop.voice.lang === 'es-ES' ? 'ES' : 'EN';

    if (typeof toast === 'function') {
        toast(Desktop.voice.lang === 'es-ES' ? 'Español' : 'English', 'success');
    }

    // Restart recognition with new language
    if (Desktop.voice.recognition) {
        const wasRecording = Desktop.voice.wantRecording;
        if (wasRecording) {
            Desktop.voice.wantRecording = false;
            Desktop.voice.recognition.stop();
        }
        Desktop.voice.recognition = null;
        if (wasRecording) {
            setTimeout(() => pcExpandedToggleMic(), 100);
        }
    }
}

function pcCloseExpandedInput(send = false) {
    // Stop mic if recording
    if (Desktop.voice.wantRecording) {
        Desktop.voice.wantRecording = false;
        Desktop.voice.recognition?.stop();
    }

    const modal = document.getElementById('pc-expand-modal');
    const textarea = document.getElementById('pc-expand-textarea');
    const input = document.getElementById('pc-input');

    if (textarea && input) {
        input.value = textarea.value;
    }

    if (modal) modal.remove();
    Desktop.inputExpanded = false;

    if (send && input?.value.trim()) {
        pcSend();
    } else {
        input?.focus();
    }
}

// ==============================================
// INITIALIZATION
// ==============================================

function initDesktopMode() {
    Desktop.isPC = window.innerWidth >= 900;

    if (!Desktop.isPC) {
        console.log('[DESKTOP] Mobile mode - skipping');
        return;
    }

    if (Desktop.initialized) return;

    console.log('[DESKTOP] Initializing Ultimate PC Mode...');
    Desktop.initialized = true;

    // Mark body as PC mode for CSS
    document.body.classList.add('pc-mode');

    buildPCLayout();
    // session-voice.js runs its init before this DOM exists, so MUTE and [V]
    // would render in their default state however they are actually set.
    if (window.SessionVoice && typeof window.SessionVoice.updateButton === 'function') {
        window.SessionVoice.updateButton();
    }
    pcSidebarInitLayout();
    // windows.js loads after this file, so it may have missed its own init when the
    // layout did not exist yet. Applying the role is idempotent.
    if (window.tsrctWindows && typeof window.tsrctWindows.init === 'function') {
        window.tsrctWindows.init();
    }
    initKeyboardShortcuts();
    initContextMenu();
    initDragAndDrop();
    initSmartScroll();
    loadCommandHistory();
    loadRunners();
    pcGitInit();
    pcCombineInit();

    // Initialize auto-accept button state
    setTimeout(pcUpdateAutoAcceptBtn, 100);

    // Load persisted session groups (server-side), then keep sessions fresh.
    pcGroupsLoad();

    // Fast intervals for responsiveness
    setInterval(syncTerminalContent, 200);
    setInterval(pcSessionsTick, 1000);
    setInterval(checkPermissions, 300);
    setInterval(detectWorkingState, 500);

    // Public tunnel URL label: populate now, then refresh occasionally
    // (the quick-tunnel URL changes whenever cloudflared is restarted).
    pcRefreshTunnel();
    setInterval(pcRefreshTunnel, 30000);

    window.addEventListener('resize', handleResize);

    setTimeout(() => {
        document.getElementById('pc-input')?.focus();
        showWelcomeHint();
    }, 500);

    console.log('[DESKTOP] Ultimate PC mode ready');
}

// Fetch the remote-access URL and reflect it in the sidebar label. Since 2026-08-11
// this is the PERMANENT Tailscale hostname (server REMOTE_URL), not the old rotating
// cloudflared one -- so it no longer changes between restarts and no longer needs
// re-copying. The API field is still named `tunnel` for compatibility.
async function pcRefreshTunnel() {
    const label = document.getElementById('pc-tunnel-url');
    const box = document.getElementById('pc-tunnel');
    if (!label) return;
    try {
        const r = await fetch('/api/status', { headers: { Authorization: token } });
        const d = await r.json();
        const url = d.tunnel || null;
        Desktop.tunnelUrl = url;
        if (url) {
            // Show just the host for compactness; full URL is copied on click.
            label.textContent = url.replace(/^https?:\/\//, '');
            box?.classList.remove('pc-tunnel-off');
        } else {
            label.textContent = 'remote: not configured';
            box?.classList.add('pc-tunnel-off');
        }
    } catch (e) { /* server unreachable -- keep whatever we have */ }
}

// Copy the current tunnel URL to the clipboard.
function pcCopyTunnel() {
    const url = Desktop.tunnelUrl;
    if (!url) {
        if (typeof toast === 'function') toast('No remote URL configured', 'error');
        return;
    }
    navigator.clipboard.writeText(url).then(() => {
        if (typeof toast === 'function') toast('Remote URL copied', 'success');
    }).catch(() => {
        if (typeof toast === 'function') toast('Copy failed', 'error');
    });
}

function showWelcomeHint() {
    const hint = document.createElement('div');
    hint.className = 'pc-welcome-hint';
    hint.innerHTML = `
        <span>Pro tips:</span>
        <kbd>Ctrl+P</kbd> Command Palette
        <kbd>Ctrl+F</kbd> Search
        <kbd>↑↓</kbd> History
        <kbd>/</kbd> Focus
    `;
    document.querySelector('.pc-main')?.appendChild(hint);
    setTimeout(() => hint.classList.add('visible'), 100);
    setTimeout(() => {
        hint.classList.remove('visible');
        setTimeout(() => hint.remove(), 300);
    }, 5000);
}

function handleResize() {
    const wasPC = Desktop.isPC;
    Desktop.isPC = window.innerWidth >= 900;
    if (wasPC !== Desktop.isPC) location.reload();
}

// ==============================================
// BUILD PC LAYOUT
// ==============================================

function buildPCLayout() {
    const app = document.getElementById('app');
    if (!app) return;

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.className = 'pc-sidebar';
    sidebar.innerHTML = `
        <div class="pc-rail" id="pc-rail">
            <div class="pc-rail-logo" title="TSRCT"><img src="/logo.png" alt="TSRCT"></div>
            <button class="pc-rail-item active" data-panel="sessions" onclick="pcRailSelect('sessions')" title="Sessions">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                <span class="pc-rail-badge hidden" id="pc-rail-badge-sessions"></span>
            </button>
            <button class="pc-rail-item" data-panel="runners" onclick="pcRailSelect('runners')" title="Runners">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <button class="pc-rail-item" data-panel="notes" onclick="pcRailSelect('notes')" title="Notes">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </button>
            <button class="pc-rail-item" data-panel="git" onclick="pcRailSelect('git')" title="Git">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>
            </button>
            <button class="pc-rail-item" data-panel="sf" onclick="pcRailSelect('sf')" title="SF CLI">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            </button>
            <button class="pc-rail-item" data-panel="usage" onclick="pcRailSelect('usage')" title="Usage: what today really cost">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            </button>
            <!-- The PROJECTOR (src/js/projector.js): not a panel - one tap opens its floating window. -->
            <button class="pc-rail-item" onclick="projectorOpen()" title="Projector: watch a session's own browser live">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="11" rx="2"/><circle cx="8" cy="12.5" r="2.5"/><line x1="14" y1="11" x2="18" y2="11"/><line x1="14" y1="14" x2="18" y2="14"/><line x1="6" y1="18" x2="5" y2="21"/><line x1="18" y1="18" x2="19" y2="21"/></svg>
            </button>
            <div class="pc-rail-spacer"></div>
            <button class="pc-rail-item pc-rail-collapse" onclick="pcSidebarToggleCollapse()" title="Collapse sidebar (Ctrl+B)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
        </div>

        <div class="pc-panel" id="pc-panel">
        <div class="pc-tunnel" id="pc-tunnel" onclick="pcCopyTunnel()" title="Click to copy the remote-access URL (permanent)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            <span class="pc-tunnel-url" id="pc-tunnel-url">remote: ...</span>
            <span class="pc-tunnel-copy">[copy]</span>
        </div>

        <div class="pc-sidebar-section" data-panel="sessions">
            <div class="pc-sidebar-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/></svg>
                Sessions
                <button class="pc-sidebar-action" onclick="pcCreateSession()" title="New session">[+]</button>
                <button class="pc-sidebar-action" onclick="pcCombineToggleMode()" title="Toggle combine mode">[C]</button>
                <button class="pc-sidebar-action pc-focus-toggle" id="pc-focus-btn" onclick="pcToggleFocusMode()" title="Focus mode: hide the folders with no live session, fold single-child paths into one line">[F]</button>
                <button class="pc-sidebar-action pc-auto-toggle" id="pc-sidebar-auto-btn" onclick="pcToggleAutoAccept()" title="Toggle auto-approve for current session">[A]</button>
                <button class="pc-sidebar-action pc-voice-toggle" id="pc-sidebar-voice-btn" onclick="SessionVoice.toggle()" title="Session attention alerts: voice when TSRCT is unfocused, panel glow when focused">[V]</button>
                <button class="pc-sidebar-action" id="pc-legend-btn" onclick="pcToggleLegend()" title="Color legend: define what each color means">[#]</button>
                <button class="pc-sidebar-action" id="pc-handoff-btn" onclick="SessionWeight.open()" title="Handoffs: list heavy sessions, hand off several at once">[H]</button>
            </div>
            <input id="pc-session-filter" class="pc-session-filter" type="text" placeholder="filter sessions..." autocomplete="off" oninput="pcSessionFilterInput()">
            <div id="pc-sessions"></div>
            <div id="pc-color-legend" class="pc-color-legend hidden"></div>
            <div class="pc-combine-controls hidden" id="pc-combine-controls">
                <span class="pc-combine-count">Selected: <strong id="pc-combine-count">0</strong></span>
                <button class="pc-combine-btn" onclick="pcCombineEnable()" title="Split view">[Split]</button>
                <button class="pc-combine-btn" onclick="pcCombineDisable()" title="Single view">[Unsplit]</button>
            </div>
        </div>

        <div class="pc-sidebar-section pc-sidebar-grow" data-panel="runners">
            <div class="pc-sidebar-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Runners
                <button class="pc-runner-add" onclick="runnerSyncSessions()" title="Sync with tmux">[~]</button>
                <button class="pc-runner-add" onclick="runnerShowCreate()" title="New runner">[+]</button>
            </div>
            <div id="pc-runners" class="pc-runners-grid"></div>
        </div>

        <div class="pc-sidebar-section pc-notes-section" data-panel="notes">
            <div class="pc-sidebar-title pc-notes-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span>Notes</span>
                <span class="pc-notes-status" id="pc-notes-status"></span>
                <div class="pc-notes-actions">
                    <button onclick="nexusNotesAdd()" title="New fragment">[+]</button>
                    <button onclick="nexusNotesToggle()" title="Expand/Collapse" id="pc-notes-toggle">[^]</button>
                </div>
            </div>
            <div class="pc-notes-container" id="pc-notes-container">
                <div class="pc-notes-tabs" id="pc-notes-tabs"></div>
                <div class="pc-notes-editor">
                    <textarea id="pc-notes-textarea" placeholder="// Type here... auto-saves&#10;// Ctrl+Enter to send to terminal&#10;// Ctrl+Shift+C to copy all" spellcheck="false"></textarea>
                    <div class="pc-notes-toolbar">
                        <span class="pc-notes-info" id="pc-notes-info">0 chars</span>
                        <button onclick="nexusNotesCopy()" title="Copy">[C]</button>
                        <button onclick="nexusNotesToTerminal()" title="Send to input">[>]</button>
                        <button onclick="nexusNotesExport()" title="Export as .md">[E]</button>
                        <button onclick="nexusNotesDelete()" title="Delete fragment">[x]</button>
                    </div>
                </div>
            </div>
        </div>

        <div class="pc-sidebar-section pc-git-section" data-panel="git">
            <div class="pc-sidebar-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>
                Git
                <button class="pc-sidebar-action pc-git-collapse" onclick="pcGitToggleCollapse()" title="Collapse">[_]</button>
            </div>
            <div class="pc-git-panel" id="pc-git-panel">
                <div class="pc-git-project">
                    <div class="pc-git-project-btn" onclick="pcGitShowProjectPicker()" title="Select project">
                        <span id="pc-git-project-name">Select project...</span>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                </div>
                <div class="pc-git-info" id="pc-git-info">
                    <div class="pc-git-placeholder">No project selected</div>
                </div>
                <div class="pc-git-actions" id="pc-git-actions">
                </div>
            </div>
        </div>

        <div class="pc-sidebar-section pc-sf-section" data-panel="sf" onclick="pcSfLazyInit(event)">
            <div class="pc-sidebar-title pc-sf-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                <span>SF CLI</span>
                <div class="pc-sf-actions">
                    <button onclick="pcSfAction('sfShowCreateModal')" title="New Workspace">[+]</button>
                    <button onclick="pcSfAction('sfRefreshSidebar')" title="Refresh">[~]</button>
                    <button onclick="pcSfAction('sfToggleCollapse')" title="Collapse" id="pc-sf-toggle">[_]</button>
                </div>
            </div>
            <div class="pc-sf-panel" id="pc-sf-panel">
                <div class="pc-sf-ws-select">
                    <select id="pc-sf-workspace" class="pc-sf-select" onchange="pcSfAction('sfSwitchWorkspaceSidebar',this.value)">
                        <option value="">-- Select Workspace --</option>
                    </select>
                </div>
                <div id="pc-sf-orgs" class="pc-sf-orgs"><div class="pc-sf-empty">Click to load SF CLI</div></div>
                <div class="pc-sf-quick" id="pc-sf-quick" style="display:none">
                    <button onclick="pcSfAction('sfShowSOQLModal')" title="SOQL Runner">[Q] SOQL</button>
                    <button onclick="pcSfAction('sfShowApexModal')" title="Apex Runner">[A] Apex</button>
                    <button onclick="pcSfAction('sfShowEditModal')" title="Edit Workspace">[E] Edit</button>
                    <button onclick="pcSfAction('sfShowLoginModal')" title="Login new org">[L] Login</button>
                </div>
            </div>
        </div>

        <div class="pc-sidebar-section pc-usage-section" data-panel="usage">
            <div class="pc-sidebar-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                Usage
                <button class="pc-sidebar-action" id="pc-usage-refresh" onclick="usageRefresh()" title="Re-measure the day. Nothing here polls -- this is the only thing that reads the transcripts.">[refresh]</button>
            </div>
            <div class="pc-usage-body" id="pc-usage-body"></div>
        </div>
        </div>
        <div class="pc-sidebar-resize" onmousedown="pcSidebarResizeStart(event)" ondblclick="pcSidebarResizeReset()" title="Drag to resize -- double-click to reset"></div>
    `;
    app.insertBefore(sidebar, app.firstChild);

    // Main area
    const main = document.createElement('div');
    main.className = 'pc-main';
    main.innerHTML = `
        <div class="pc-header">
            <div class="pc-header-left">
                <button class="pc-session-btn" onclick="showHomeSessionPicker()">
                    <span id="pc-session-name">claude</span>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <div class="pc-quick-actions">
                    <button onclick="pcQuick('/clear')" title="Clear conversation">CLR</button>
                    <button onclick="pcQuick('/compact')" title="Compact context">CMP</button>
                    <button onclick="pcQuick('/undo')" title="Undo last">UND</button>
                    <button onclick="pcQuick('/cost')" title="Show cost">$</button>
                    <button onclick="toggleCommandPalette()" title="Command Palette (Ctrl+P)">⌘</button>
                </div>
            </div>
            <div class="pc-omni" id="pc-omni">
                <div class="pc-omni-bar" onclick="omniOpen()">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input type="text" id="pc-omni-input" placeholder="Search files in /PROJECTS…" autocomplete="off" spellcheck="false"
                        oninput="omniOnInput()" onkeydown="omniOnKeydown(event)" onfocus="omniOpen()">
                    <kbd class="pc-omni-kbd">Ctrl K</kbd>
                </div>
                <div class="pc-omni-panel hidden" id="pc-omni-panel">
                    <div class="pc-omni-crumbs" id="pc-omni-crumbs"></div>
                    <div class="pc-omni-results" id="pc-omni-results"></div>
                    <div class="pc-omni-foot" id="pc-omni-foot"></div>
                </div>
            </div>
            <div class="pc-header-right">
                <div class="pc-role-group" title="Window role -- click the chip to cycle, [>|] opens a second window on the other monitor, [<>] swaps roles between windows">
                    <button class="pc-role-chip" id="pc-role-chip" onclick="pcCycleRole()">FULL</button>
                    <button class="pc-role-btn" onclick="pcExpandToScreen('focus')" title="Open a second window on the other monitor">[&gt;|]</button>
                    <button class="pc-role-btn" onclick="pcSwapRoles()" title="Swap roles with the other window">[&lt;&gt;]</button>
                </div>
                <div class="pc-font-btns">
                    <button class="${Desktop.fontSizeLevel === 1 ? 'active' : ''}" onclick="pcSetFontSize(1)">S</button>
                    <button class="${Desktop.fontSizeLevel === 2 ? 'active' : ''}" onclick="pcSetFontSize(2)">M</button>
                    <button class="${Desktop.fontSizeLevel === 3 ? 'active' : ''}" onclick="pcSetFontSize(3)">L</button>
                    <button class="${Desktop.fontSizeLevel === 4 ? 'active' : ''}" onclick="pcSetFontSize(4)">XL</button>
                </div>
                <button class="pc-vault-toggle ${vaultEnabled ? 'active' : ''}" id="pc-vault-toggle" onclick="toggleVault();document.getElementById('pc-vault-toggle').classList.toggle('active',vaultEnabled)" title="Toggle vault augmentation">VAULT</button>
                <button class="pc-vault-reset" onclick="resetVaultCycle()" title="Reset vault cycle for active session">RST</button>
                <button class="pc-pb-toggle" id="pc-pb-toggle" onclick="togglePlainBrief()" title="Plain brief: force short, plain answers in this session">PB</button>
                <button class="pc-mute-toggle" id="pc-mute-toggle" onclick="toggleVoiceMute()" title="Mute every voice TSRCT can make (session alerts and hands-free)">MUTE</button>
                <button class="pc-morning-btn" id="pc-morning-btn" onclick="mrnToggle()" title="Morning brief: what the 06:00 routine found and which sessions it wants to open">[A]</button>
                <button class="pc-eye-protect" onclick="toggleEyeProtect()" title="Eye protection mode" style="padding:3px 8px;border:1px solid #d4a040;color:#d4a040;background:transparent;font-size:0.55rem;font-family:var(--mono);cursor:pointer;">EYE</button>
                <button class="pc-navy-theme" onclick="toggleNavyTheme()" title="leonlurk navy theme" style="padding:3px 8px;border:1px solid #22a7ff;color:#22a7ff;background:transparent;font-size:0.55rem;font-family:var(--mono);cursor:pointer;">NAVY</button>
                <button class="pc-restart-btn" onclick="showRestartConfirm()" title="Restart the TSRCT bridge server (native splash)" style="display:flex;align-items:center;padding:3px 7px;border:1px solid var(--amber,#ffb000);color:var(--amber,#ffb000);background:transparent;cursor:pointer;">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                </button>
                <button class="pc-search-btn" onclick="toggleSearch()" title="Search (Ctrl+F)">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </button>
                <div class="pc-status" id="pc-status">
                    <div class="dot"></div>
                    <span>IDLE</span>
                </div>
            </div>
        </div>

        <div class="pc-search-bar hidden" id="pc-search-bar">
            <input type="text" id="pc-search-input" placeholder="Search in terminal..." autocomplete="off">
            <span class="pc-search-count" id="pc-search-count">0/0</span>
            <button onclick="searchPrev()">↑</button>
            <button onclick="searchNext()">↓</button>
            <button onclick="toggleSearch()">✕</button>
        </div>

        <div class="pc-perm-banner hidden" id="pc-perm-banner">
            <div class="pc-perm-content">
                <div class="pc-perm-icon">⚠</div>
                <div class="pc-perm-text">
                    <div class="pc-perm-title" id="pc-perm-title">Permission Required</div>
                    <div class="pc-perm-desc" id="pc-perm-desc">Waiting...</div>
                </div>
            </div>
            <div class="pc-perm-btns">
                <button class="approve" onclick="approvePerm()">
                    <span>APPROVE</span>
                    <kbd>Y / NUM ENT</kbd>
                </button>
                <button class="deny" onclick="denyPerm()">
                    <span>DENY</span>
                    <kbd>N / NUM .</kbd>
                </button>
                <button class="auto" id="pc-auto-accept-btn" onclick="pcToggleAutoAccept()" title="Toggle auto-accept for current session">
                    <span id="pc-auto-accept-label">AUTO</span>
                    <kbd>A</kbd>
                </button>
                <button class="purge" onclick="purgeAllPermissions()" title="Purge all pending permissions">
                    <span>PURGE</span>
                </button>
            </div>
        </div>

        <!-- Tab Bar -->
        <div class="pc-tab-bar" id="pc-tab-bar">
            <button class="pc-tab active" data-tab="terminal" onclick="pcSwitchTab('terminal')">
                [>] Terminal
            </button>
            <button class="pc-tab" data-tab="factory" onclick="pcSwitchTab('factory')">
                [F] Factory
            </button>
            <button class="pc-tab" data-tab="tasks" onclick="pcSwitchTab('tasks')">
                [T] Tasks
            </button>
            <button class="pc-tab" data-tab="clients" onclick="pcSwitchTab('clients')">
                [C] Clients
            </button>
            <button class="pc-tab" data-tab="automations" onclick="pcSwitchTab('automations')">
                [@] Automations<span class="nf-tab-badge hidden" id="au-tab-badge"></span>
            </button>
            <button class="pc-tab" data-tab="codemap" onclick="pcSwitchTab('codemap')">
                [M] Codemap
            </button>
            <button class="pc-tab" data-tab="notifs" onclick="pcSwitchTab('notifs')">
                [!] Notifs<span class="nf-tab-badge hidden" id="nf-tab-badge"></span>
            </button>
            <button class="pc-tab" data-tab="lurk" onclick="pcSwitchTab('lurk')">
                [N] NULL
            </button>
            <button class="pc-tab" data-tab="studio" onclick="pcSwitchTab('studio')">
                [G] Studio
            </button>
            <button class="pc-tab" data-tab="playlist" onclick="pcSwitchTab('playlist')">
                [P] LABS
            </button>
            <button class="pc-tab" data-tab="handson" onclick="pcSwitchTab('handson')">
                [H] Hands On
            </button>
        </div>

        <!-- Split-group chips: one per folder split that is armed. Lives OUTSIDE
             pc-combined-wrap on purpose — that wrap is hidden in single view, and the
             whole point of the chips is getting back into a split with one click. -->
        <div class="pc-split-chips hidden" id="pc-split-chips"></div>

        <div class="pc-terminal-wrap">
            <div class="pc-terminal" id="pc-terminal"></div>
            <div class="pc-scroll-indicator" id="pc-scroll-indicator">
                <button onclick="scrollToBottom()">↓ New output</button>
            </div>
        </div>


        <!-- Factory Panel: the software factory (RUN / CANDIDATES / BUILDS / RUNS) -->
        <div class="pc-factory-panel hidden" id="pc-factory-panel">
            <div class="pc-panel-head">
                <span class="pc-tw-title">[F] FACTORY</span>
                <span class="tw-stamp" id="fx-stamp-time"></span>
            </div>
            <div class="fx-root" id="pc-factory-body"></div>
        </div>

        <!-- Tasks (Productivity Dashboard) Panel (hidden by default) -->
        <div class="pc-tasks-panel hidden" id="pc-tasks-panel">
            <div class="pc-dash-header">
                <span class="pc-dash-title">[T] TASKS</span>
                <div class="pc-dash-header-actions">
                    <button onclick="window.dashInit && dashInit()" title="Refresh">[~]</button>
                </div>
            </div>
            <div class="pc-dash-body">
                <div class="dash-target" id="pc-dashboard-list"></div>
            </div>
        </div>

        <!-- Clients (client-health board) Panel (hidden by default) -->
        <div class="pc-clients-panel hidden" id="pc-clients-panel">
            <div class="pc-dash-header">
                <span class="pc-dash-title">[C] CLIENTS</span>
                <div class="pc-dash-header-actions">
                    <button onclick="window.clientsInit && clientsInit()" title="Reload">[~]</button>
                </div>
            </div>
            <div class="pc-dash-body">
                <div class="cl-root" id="pc-clients-body"></div>
            </div>
        </div>

        <!-- Automations (everything that runs by itself) Panel (hidden by default) -->
        <div class="pc-automations-panel hidden" id="pc-automations-panel">
            <div class="pc-dash-header">
                <span class="pc-dash-title">[@] AUTOMATIONS</span>
            </div>
            <div class="pc-dash-body">
                <div class="au-mount" id="pc-automations-body"></div>
            </div>
        </div>

        <!-- Codemap (repo-map MAP.md control) Panel (hidden by default) -->
        <div class="pc-codemap-panel hidden" id="pc-codemap-panel">
            <div class="pc-dash-header">
                <span class="pc-dash-title">[M] CODEMAP</span>
                <div class="pc-dash-header-actions">
                    <button onclick="window.codemapInit && codemapInit()" title="Refresh">[~]</button>
                </div>
            </div>
            <div class="pc-dash-body">
                <div class="cm-root" id="pc-codemap-body"></div>
            </div>
        </div>

        <!-- Notifications / Security Audit review panel (hidden by default) -->
        <div class="pc-notifs-panel hidden" id="pc-notifs-panel">
            <div class="pc-dash-header">
                <span class="pc-dash-title">[!] NOTIFICATIONS</span>
                <div class="pc-dash-header-actions">
                    <button onclick="window.notifsClearEverything && notifsClearEverything()"
                            title="Dismiss every notification in all three sections (recoverable)">[Clear all]</button>
                    <button onclick="window.notifsInit && notifsInit()" title="Refresh">[~]</button>
                </div>
            </div>
            <div class="pc-dash-body">
                <div class="nf-root" id="pc-notifs-body"></div>
            </div>
        </div>

        <div class="pc-studio-panel hidden" id="pc-studio-panel">
            <div id="pc-studio-body"></div>
        </div>

        <div class="pc-playlist-panel hidden" id="pc-playlist-panel">
            <div id="pc-playlist-body"></div>
        </div>

        <div class="pc-lurk-panel hidden" id="pc-lurk-panel">
            <div id="pc-lurk-body"></div>
        </div>

        <!-- HANDS ON: the inverse of HANDS FREE. Claude publishes a plan, you
             type it. Three columns: project files | the step you are typing |
             the Claude terminal (BORROWED — hoBorrowTerminal moves the live
             .pc-terminal-wrap node in here and puts it back on teardown, so
             this is not a fourth terminal implementation). -->
        <div class="pc-handson-panel hidden" id="pc-handson-panel">
            <div class="ho-body" id="pc-handson-body"></div>
        </div>

        <!-- MORNING: not a tab. The brief is something you read once and act on,
             so it is an overlay over whatever you were doing ([A] in the header,
             Esc to close), and it opens itself once when a new brief lands.
             Rendered entirely by src/js/morning.js. -->
        <div class="mrn-overlay hidden" id="pc-morning-overlay">
            <div class="mrn-sheet" id="pc-morning-body"></div>
        </div>

        <!-- Combined Terminals View (split screen with cables) -->
        <div class="pc-combined-wrap hidden" id="pc-combined-wrap">
            <svg class="pc-cables" id="pc-cables"></svg>
            <div class="pc-combined-grid" id="pc-combined-grid" data-count="0">
                <!-- Panels rendered dynamically -->
            </div>
        </div>

        <div class="pc-suggestions hidden" id="pc-suggestions"></div>

        <div class="pc-input-wrap">
            <div class="pc-attach-indicator hidden" id="pc-attach-indicator"></div>
            <div class="pc-input-container">
                <div class="pc-input-prefix">❯</div>
                <input type="text" class="pc-input" id="pc-input" placeholder="Type a message or command..." autocomplete="off" spellcheck="false">
                <div class="pc-input-actions">
                    <button onclick="pcOpenExpandedInput()" title="Expand input (Ctrl+E)" id="pc-expand-btn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                    </button>
                    <button onclick="pcShowGallery()" title="Attach images (Ctrl+I)">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    </button>
                    <button onclick="pcShowFileAttach()" title="Attach files (Ctrl+U)">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                    </button>
                    <button onclick="pcShowRunnerAttach()" title="Attach runner terminal (Ctrl+T)">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                    </button>
                    <button onclick="pcShowOrgAttach()" title="Attach SF org context">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                    </button>
                    <button onclick="pcToggleMic()" title="Voice input (Ctrl+M)" id="pc-mic-btn" class="pc-mic-btn">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                    </button>
                    <button onclick="toggleHistoryPanel()" title="History">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="12 19 12 5"/><polyline points="5 12 12 5 19 12"/></svg>
                    </button>
                    <button class="send" onclick="pcSend()">
                        SEND
                        <kbd>↵</kbd>
                    </button>
                </div>
            </div>
            <div class="pc-input-hints">
                <span><kbd>Tab</kbd> complete</span>
                <span><kbd>↑↓</kbd> history</span>
                <span><kbd>Ctrl+E</kbd> expand</span>
                <span><kbd>Ctrl+M</kbd> voice</span>
                <span><kbd>Ctrl+P</kbd> palette</span>
            </div>
        </div>

        <div class="pc-history-panel hidden" id="pc-history-panel">
            <div class="pc-panel-header">
                <span>Command History</span>
                <button onclick="toggleHistoryPanel()">✕</button>
            </div>
            <div class="pc-history-list" id="pc-history-list"></div>
        </div>

        <div class="pc-command-palette hidden" id="pc-command-palette">
            <div class="pc-palette-input-wrap">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" id="pc-palette-input" placeholder="Type a command..." autocomplete="off">
            </div>
            <div class="pc-palette-list" id="pc-palette-list"></div>
        </div>

        <div class="pc-gallery-modal hidden" id="pc-gallery-modal">
            <div class="pc-gallery-header">
                <span>Image Gallery</span>
                <span class="pc-gallery-hint">Ctrl+click to preview</span>
                <button onclick="pcHideGallery()">[x]</button>
            </div>
            <div class="pc-gallery-info" id="pc-gallery-info">Loading...</div>
            <div class="pc-gallery-grid" id="pc-gallery-grid"></div>
            <div class="pc-gallery-actions">
                <button class="cancel" onclick="pcHideGallery()">CANCEL</button>
                <button class="attach" id="pc-gallery-attach" onclick="pcAttachImages()" disabled>ATTACH (0)</button>
            </div>
        </div>

        <div class="pc-file-modal hidden" id="pc-file-modal">
            <div class="pc-file-header">
                <span>Attach Files</span>
                <button onclick="pcHideFileAttach()">[x]</button>
            </div>
            <div class="pc-file-tabs">
                <button class="active" onclick="pcFileTab('text')" id="pc-file-tab-text">New Text File</button>
                <button onclick="pcFileTab('browse')" id="pc-file-tab-browse">Browse Files</button>
            </div>
            <div class="pc-file-content">
                <div class="pc-file-text-panel" id="pc-file-text-panel">
                    <div class="pc-file-field">
                        <label>Filename (without extension)</label>
                        <input type="text" id="pc-file-name" placeholder="logs, context, notes..." autocomplete="off">
                    </div>
                    <div class="pc-file-field">
                        <label>Content (paste logs, code, etc.)</label>
                        <textarea id="pc-file-content" placeholder="Paste your content here..."></textarea>
                    </div>
                </div>
                <div class="pc-file-browse-panel hidden" id="pc-file-browse-panel">
                    <div class="pc-file-path" id="pc-file-path">Loading...</div>
                    <div class="pc-file-list" id="pc-file-list"></div>
                    <div class="pc-file-selected" id="pc-file-selected"></div>
                </div>
            </div>
            <div class="pc-file-actions">
                <button class="cancel" onclick="pcHideFileAttach()">CANCEL</button>
                <button class="attach" id="pc-file-attach-btn" onclick="pcAttachFiles()">ATTACH</button>
            </div>
        </div>

        <!-- Runner Terminal Attach Modal -->
        <div class="pc-runner-attach-modal hidden" id="pc-runner-attach-modal">
            <div class="pc-runner-attach-header">
                <span>Attach Runner Terminal</span>
                <button onclick="pcHideRunnerAttach()">[x]</button>
            </div>
            <div class="pc-runner-attach-info">Select runners to include their output in your message</div>
            <div class="pc-runner-attach-list" id="pc-runner-attach-list">
                <!-- Runners rendered dynamically -->
            </div>
            <div class="pc-runner-attach-actions">
                <button class="cancel" onclick="pcHideRunnerAttach()">CANCEL</button>
                <button class="attach" id="pc-runner-attach-btn" onclick="pcAttachRunners()" disabled>ATTACH (0)</button>
            </div>
        </div>

        <!-- SF Org Attach Modal -->
        <div class="pc-runner-attach-modal hidden" id="pc-org-attach-modal">
            <div class="pc-runner-attach-header">
                <span>Attach SF Org</span>
                <button onclick="pcHideOrgAttach()">[x]</button>
            </div>
            <div class="pc-runner-attach-info">Select orgs to include their context in your message</div>
            <div class="pc-runner-attach-list" id="pc-org-attach-list">
                <!-- Orgs rendered dynamically -->
            </div>
            <div class="pc-runner-attach-actions">
                <button class="cancel" onclick="pcHideOrgAttach()">CANCEL</button>
                <button class="attach" id="pc-org-attach-btn" onclick="pcAttachOrgs()" disabled>ATTACH (0)</button>
            </div>
        </div>
    `;
    app.appendChild(main);

    // Omni file finder (center header search bar)
    if (typeof window.omniInit === 'function') window.omniInit();

    // Context menu
    createContextMenu();

    // Drop overlay
    createDropOverlay();

    // Input listeners
    const input = document.getElementById('pc-input');
    if (input) {
        input.addEventListener('keydown', handleInputKeydown);
        input.addEventListener('input', handleInputChange);
        input.addEventListener('focus', () => document.querySelector('.pc-input-container')?.classList.add('focused'));
        input.addEventListener('blur', () => {
            document.querySelector('.pc-input-container')?.classList.remove('focused');
            setTimeout(hideSuggestions, 150);
        });
    }

    // Palette input
    const paletteInput = document.getElementById('pc-palette-input');
    if (paletteInput) {
        paletteInput.addEventListener('keydown', handlePaletteKeydown);
        paletteInput.addEventListener('input', handlePaletteInput);
    }

    // Search input
    const searchInput = document.getElementById('pc-search-input');
    if (searchInput) {
        searchInput.addEventListener('keydown', handleSearchKeydown);
        searchInput.addEventListener('input', handleSearchInput);
    }

    pcApplyFontSize(Desktop.fontSizeLevel);
    syncSessionName();
    renderFavorites();
    populatePalette();
    pcUpdateAttachIndicator();
    nexusNotesInit();

    // System notifications disabled - no auto-prompt
    initPermissionDetector();
}

// ==============================================
// AUTO-SUGGESTIONS
// ==============================================

function handleInputChange(e) {
    const value = e.target.value;

    if (!value || value.length < 2) {
        hideSuggestions();
        return;
    }

    const lower = value.toLowerCase();

    // Build suggestions from history + common commands + user abbreviations
    let suggestions = [];

    // From command history
    suggestions.push(...Desktop.commandHistory
        .filter(cmd => cmd.toLowerCase().includes(lower) && cmd !== value)
        .slice(0, 3)
        .map(cmd => ({ type: 'history', text: cmd, icon: '↺' }))
    );

    // From common commands
    suggestions.push(...COMMON_COMMANDS
        .filter(cmd => cmd.toLowerCase().includes(lower) && !suggestions.find(s => s.text === cmd))
        .slice(0, 3)
        .map(cmd => ({ type: 'command', text: cmd, icon: '⌘' }))
    );

    // From user abbreviations
    if (typeof userCommands !== 'undefined') {
        Object.entries(userCommands).forEach(([abbr, cmd]) => {
            if (abbr.toLowerCase().startsWith(lower)) {
                const display = cmd.type === 'ctrl' ? `^${cmd.key.toUpperCase()}` : (cmd.value || cmd);
                suggestions.push({ type: 'abbr', text: abbr, expand: display, icon: '⚡' });
            }
        });
    }

    Desktop.suggestions = suggestions.slice(0, 6);
    Desktop.selectedSuggestion = -1;

    if (Desktop.suggestions.length > 0) {
        showSuggestions();
    } else {
        hideSuggestions();
    }
}

function showSuggestions() {
    const container = document.getElementById('pc-suggestions');
    if (!container || Desktop.suggestions.length === 0) return;

    container.innerHTML = Desktop.suggestions.map((s, i) => `
        <div class="pc-suggestion ${i === Desktop.selectedSuggestion ? 'selected' : ''}"
             onmousedown="selectSuggestion(${i})"
             onmouseenter="Desktop.selectedSuggestion = ${i}; showSuggestions();">
            <span class="icon">${s.icon}</span>
            <span class="text">${escapeHtml(s.text)}</span>
            ${s.expand ? `<span class="expand">→ ${escapeHtml(s.expand.substring(0, 40))}${s.expand.length > 40 ? '...' : ''}</span>` : ''}
            ${s.type === 'abbr' ? '<kbd>Tab</kbd>' : ''}
        </div>
    `).join('');

    container.classList.remove('hidden');
}

function hideSuggestions() {
    document.getElementById('pc-suggestions')?.classList.add('hidden');
    Desktop.suggestions = [];
    Desktop.selectedSuggestion = -1;
}

function selectSuggestion(index) {
    const suggestion = Desktop.suggestions[index];
    if (!suggestion) return;

    const input = document.getElementById('pc-input');
    if (!input) return;

    if (suggestion.type === 'abbr' && suggestion.expand) {
        // For abbreviations, check if it's a ctrl command
        if (typeof userCommands !== 'undefined') {
            const cmd = userCommands[suggestion.text];
            if (cmd?.type === 'ctrl') {
                pcSendCtrl(cmd.key);
                input.value = '';
                hideSuggestions();
                return;
            }
        }
        input.value = suggestion.expand;
    } else {
        input.value = suggestion.text;
    }

    hideSuggestions();
    input.focus();

    // Move cursor to end, or to quotes if git commit
    if (suggestion.text.includes('""')) {
        const pos = suggestion.text.indexOf('""') + 1;
        input.setSelectionRange(pos, pos);
    }
}

// ==============================================
// COMMAND PALETTE
// ==============================================

const PALETTE_COMMANDS = [
    { id: 'clear', label: 'Clear Conversation', shortcut: 'Ctrl+K', action: () => pcQuick('/clear') },
    { id: 'compact', label: 'Compact Context', shortcut: '', action: () => pcQuick('/compact') },
    { id: 'undo', label: 'Undo Last', shortcut: '', action: () => pcQuick('/undo') },
    { id: 'cost', label: 'Show Cost', shortcut: '', action: () => pcQuick('/cost') },
    { id: 'search', label: 'Search in Terminal', shortcut: 'Ctrl+F', action: () => toggleSearch() },
    { id: 'analyze', label: 'Analyze Project', shortcut: '', action: () => { if(typeof analyzeProject === 'function') analyzeProject(); } },
    { id: 'interrupt', label: 'Interrupt (^C)', shortcut: 'Ctrl+C', action: () => pcSendCtrl('c') },
    { id: 'stop', label: 'Stop Claude (Escape)', shortcut: 'Ctrl+Shift+X', action: () => sendKeyToTerminal('Escape') },
    { id: 'voice', label: 'Voice Input', shortcut: 'Ctrl+M', action: () => pcToggleMic() },
    { id: 'expand', label: 'Expand Input', shortcut: 'Ctrl+E', action: () => pcOpenExpandedInput() },
    { id: 'eof', label: 'Send EOF (^D)', shortcut: 'Ctrl+D', action: () => pcSendCtrl('d') },
    { id: 'suspend', label: 'Suspend (^Z)', shortcut: 'Ctrl+Z', action: () => pcSendCtrl('z') },
    { id: 'clearterm', label: 'Clear Terminal (^L)', shortcut: 'Ctrl+L', action: () => pcSendCtrl('l') },
    { id: 'history', label: 'Show Command History', shortcut: '↑', action: () => toggleHistoryPanel() },
    { id: 'top', label: 'Scroll to Top', shortcut: 'g', action: () => { document.getElementById('pc-terminal').scrollTop = 0; } },
    { id: 'bottom', label: 'Scroll to Bottom', shortcut: 'G', action: () => scrollToBottom() },
    { id: 'fontup', label: 'Increase Font Size', shortcut: '', action: () => pcSetFontSize(Math.min(4, Desktop.fontSizeLevel + 1)) },
    { id: 'fontdown', label: 'Decrease Font Size', shortcut: '', action: () => pcSetFontSize(Math.max(1, Desktop.fontSizeLevel - 1)) },
];

function populatePalette(filter = '') {
    const container = document.getElementById('pc-palette-list');
    if (!container) return;

    const lower = filter.toLowerCase();
    const filtered = PALETTE_COMMANDS.filter(cmd =>
        cmd.label.toLowerCase().includes(lower) || cmd.id.includes(lower)
    );

    container.innerHTML = filtered.map((cmd, i) => `
        <div class="pc-palette-item ${i === 0 ? 'selected' : ''}" onclick="executePaletteCommand('${cmd.id}')">
            <span class="label">${cmd.label}</span>
            ${cmd.shortcut ? `<kbd>${cmd.shortcut}</kbd>` : ''}
        </div>
    `).join('') || '<div class="pc-palette-empty">No commands found</div>';
}

function toggleCommandPalette() {
    const palette = document.getElementById('pc-command-palette');
    const input = document.getElementById('pc-palette-input');

    if (palette.classList.contains('hidden')) {
        palette.classList.remove('hidden');
        input.value = '';
        input.focus();
        populatePalette();
        Desktop.paletteOpen = true;
    } else {
        palette.classList.add('hidden');
        Desktop.paletteOpen = false;
        document.getElementById('pc-input')?.focus();
    }
}

function handlePaletteInput(e) {
    populatePalette(e.target.value);
}

function handlePaletteKeydown(e) {
    const items = document.querySelectorAll('.pc-palette-item');
    let selected = Array.from(items).findIndex(el => el.classList.contains('selected'));

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[selected]?.classList.remove('selected');
        selected = (selected + 1) % items.length;
        items[selected]?.classList.add('selected');
        items[selected]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[selected]?.classList.remove('selected');
        selected = selected <= 0 ? items.length - 1 : selected - 1;
        items[selected]?.classList.add('selected');
        items[selected]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
        e.preventDefault();
        items[selected]?.click();
    } else if (e.key === 'Escape') {
        toggleCommandPalette();
    }
}

function executePaletteCommand(id) {
    const cmd = PALETTE_COMMANDS.find(c => c.id === id);
    if (cmd) {
        toggleCommandPalette();
        cmd.action();
    }
}

// ==============================================
// TERMINAL SEARCH
// ==============================================

function toggleSearch() {
    const bar = document.getElementById('pc-search-bar');
    const input = document.getElementById('pc-search-input');

    if (bar.classList.contains('hidden')) {
        bar.classList.remove('hidden');
        input.value = '';
        input.focus();
        Desktop.searchOpen = true;
    } else {
        bar.classList.add('hidden');
        clearSearchHighlights();
        Desktop.searchOpen = false;
        document.getElementById('pc-input')?.focus();
    }
}

function handleSearchInput(e) {
    const query = e.target.value;
    if (query.length < 2) {
        clearSearchHighlights();
        document.getElementById('pc-search-count').textContent = '0/0';
        return;
    }

    performSearch(query);
}

function handleSearchKeydown(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) searchPrev();
        else searchNext();
    } else if (e.key === 'Escape') {
        toggleSearch();
    }
}

function performSearch(query) {
    const terminal = document.getElementById('pc-terminal');
    if (!terminal) return;

    clearSearchHighlights();

    const text = terminal.textContent;
    const regex = new RegExp(escapeRegex(query), 'gi');

    Desktop.searchMatches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        Desktop.searchMatches.push({ index: match.index, length: match[0].length });
    }

    Desktop.searchIndex = 0;
    document.getElementById('pc-search-count').textContent =
        Desktop.searchMatches.length > 0
            ? `1/${Desktop.searchMatches.length}`
            : '0/0';

    if (Desktop.searchMatches.length > 0) {
        highlightSearchMatches(query);
        scrollToMatch(0);
    }
}

function highlightSearchMatches(query) {
    const terminal = document.getElementById('pc-terminal');
    if (!terminal) return;

    const walker = document.createTreeWalker(terminal, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');

    textNodes.forEach(node => {
        if (regex.test(node.textContent)) {
            const span = document.createElement('span');
            span.innerHTML = node.textContent.replace(regex, '<mark class="pc-search-match">$1</mark>');
            node.parentNode.replaceChild(span, node);
        }
    });
}

function clearSearchHighlights() {
    const terminal = document.getElementById('pc-terminal');
    if (!terminal) return;

    terminal.querySelectorAll('mark.pc-search-match').forEach(mark => {
        mark.replaceWith(mark.textContent);
    });
    terminal.querySelectorAll('.pc-search-current').forEach(el => {
        el.classList.remove('pc-search-current');
    });

    Desktop.searchMatches = [];
    Desktop.searchIndex = 0;
}

function searchNext() {
    if (Desktop.searchMatches.length === 0) return;
    Desktop.searchIndex = (Desktop.searchIndex + 1) % Desktop.searchMatches.length;
    scrollToMatch(Desktop.searchIndex);
    document.getElementById('pc-search-count').textContent =
        `${Desktop.searchIndex + 1}/${Desktop.searchMatches.length}`;
}

function searchPrev() {
    if (Desktop.searchMatches.length === 0) return;
    Desktop.searchIndex = Desktop.searchIndex <= 0 ? Desktop.searchMatches.length - 1 : Desktop.searchIndex - 1;
    scrollToMatch(Desktop.searchIndex);
    document.getElementById('pc-search-count').textContent =
        `${Desktop.searchIndex + 1}/${Desktop.searchMatches.length}`;
}

function scrollToMatch(index) {
    const marks = document.querySelectorAll('.pc-search-match');
    marks.forEach(m => m.classList.remove('pc-search-current'));

    if (marks[index]) {
        marks[index].classList.add('pc-search-current');
        marks[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ==============================================
// SMART SCROLL
// ==============================================

function initSmartScroll() {
    const terminal = document.getElementById('pc-terminal');
    if (!terminal) return;

    terminal.addEventListener('scroll', () => {
        const atBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 50;
        Desktop.userScrolled = !atBottom;

        const indicator = document.getElementById('pc-scroll-indicator');
        if (indicator) {
            indicator.classList.toggle('visible', Desktop.userScrolled && Desktop.isWorking);
        }
    });
}

function scrollToBottom() {
    const terminal = document.getElementById('pc-terminal');
    if (terminal) {
        terminal.scrollTop = terminal.scrollHeight;
        Desktop.userScrolled = false;
        document.getElementById('pc-scroll-indicator')?.classList.remove('visible');
    }
}

// ==============================================
// HISTORY PANEL
// ==============================================

function toggleHistoryPanel() {
    const panel = document.getElementById('pc-history-panel');

    if (panel.classList.contains('hidden')) {
        panel.classList.remove('hidden');
        renderHistoryPanel();
    } else {
        panel.classList.add('hidden');
    }
}

function renderHistoryPanel() {
    const container = document.getElementById('pc-history-list');
    if (!container) return;

    if (Desktop.commandHistory.length === 0) {
        container.innerHTML = '<div class="pc-history-empty">No commands yet</div>';
        return;
    }

    container.innerHTML = Desktop.commandHistory.slice(0, 50).map((cmd, i) => `
        <div class="pc-history-item" onclick="useHistoryItem(${i})">
            <span class="index">${i + 1}</span>
            <span class="cmd">${escapeHtml(cmd.substring(0, 80))}${cmd.length > 80 ? '...' : ''}</span>
        </div>
    `).join('');
}

function useHistoryItem(index) {
    const input = document.getElementById('pc-input');
    if (input && Desktop.commandHistory[index]) {
        input.value = Desktop.commandHistory[index];
        input.focus();
        toggleHistoryPanel();
    }
}

// ==============================================
// FAVORITES / BOOKMARKS
// ==============================================

function pcAddFavorite() {
    const terminal = document.getElementById('pc-terminal');
    if (!terminal) return;

    const selection = window.getSelection().toString() || terminal.textContent.slice(-500);
    const timestamp = new Date().toLocaleString();

    Desktop.favorites.unshift({
        id: Date.now(),
        text: selection.substring(0, 200),
        time: timestamp
    });

    if (Desktop.favorites.length > 20) Desktop.favorites.pop();

    localStorage.setItem('pc_favorites', JSON.stringify(Desktop.favorites));
    renderFavorites();

    if (typeof toast === 'function') toast('Bookmarked!', 'success');
}

function renderFavorites() {
    const container = document.getElementById('pc-favorites');
    if (!container) return;

    if (Desktop.favorites.length === 0) {
        container.innerHTML = '<div class="pc-favorites-empty">No bookmarks</div>';
        return;
    }

    container.innerHTML = Desktop.favorites.slice(0, 10).map(fav => `
        <div class="pc-favorite-item" onclick="copyFavorite(${fav.id})" title="${escapeHtml(fav.text)}">
            <span class="text">${escapeHtml(fav.text.substring(0, 30))}...</span>
            <button onclick="event.stopPropagation(); deleteFavorite(${fav.id})">✕</button>
        </div>
    `).join('');
}

function copyFavorite(id) {
    const fav = Desktop.favorites.find(f => f.id === id);
    if (fav) {
        navigator.clipboard.writeText(fav.text);
        if (typeof toast === 'function') toast('Copied!', 'success');
    }
}

function deleteFavorite(id) {
    Desktop.favorites = Desktop.favorites.filter(f => f.id !== id);
    localStorage.setItem('pc_favorites', JSON.stringify(Desktop.favorites));
    renderFavorites();
}

// ==============================================
// SNIPPETS
// ==============================================

function pcInsertSnippet(text) {
    const input = document.getElementById('pc-input');
    if (input) {
        input.value = text;
        input.focus();
    }
}

// ==============================================
// TERMINAL SYNC
// ==============================================

function syncTerminalContent() {
    if (!Desktop.isPC) return;

    const mobile = document.getElementById('terminal');
    const pc = document.getElementById('pc-terminal');

    if (mobile && pc) {
        const content = mobile.innerHTML || mobile.textContent;
        if (content !== Desktop.terminalContent) {
            Desktop.terminalContent = content;

            // Preserve search if active
            const wasSearching = Desktop.searchOpen;
            const searchQuery = document.getElementById('pc-search-input')?.value;

            // Route through TermFocus so a frozen pane buffers instead of repainting.
            const painted = window.TermFocus
                ? TermFocus.write(pc, content, true)
                : (pc.innerHTML = content, !Desktop.userScrolled && (pc.scrollTop = pc.scrollHeight), true);

            // Inline images copied from the mobile terminal carry their <img>
            // slots; give the PC copies a source too (cache hit == instant).
            if (painted && window.TermImg) TermImg.hydrate(pc);

            // Re-apply search highlights only if we actually repainted
            if (painted && wasSearching && searchQuery && searchQuery.length >= 2) {
                highlightSearchMatches(searchQuery);
            }
        }
    }
}

function syncSessionName() {
    const mobile = document.getElementById('home-session-label');
    const pc = document.getElementById('pc-session-name');
    if (mobile && pc) pc.textContent = mobile.textContent;
}

// ==============================================
// WORKING STATE
// ==============================================

function detectWorkingState() {
    if (!Desktop.isPC) return;

    const terminal = document.getElementById('pc-terminal');
    const status = document.getElementById('pc-status');
    if (!terminal || !status) return;

    const len = terminal.textContent?.length || 0;
    const working = len !== Desktop.lastOutputLength;
    Desktop.lastOutputLength = len;

    if (working !== Desktop.isWorking) {
        Desktop.isWorking = working;
        status.className = 'pc-status' + (working ? ' working' : '');
        status.innerHTML = working
            ? '<div class="dot"></div><span>WORKING</span>'
            : '<div class="dot"></div><span>IDLE</span>';

        // Show scroll indicator if user scrolled up
        const indicator = document.getElementById('pc-scroll-indicator');
        if (indicator && working && Desktop.userScrolled) {
            indicator.classList.add('visible');
        }
    }
}

// ==============================================
// PERMISSIONS
// ==============================================

function checkPermissions() {
    if (!Desktop.isPC) return;

    const mobile = document.getElementById('perm-card');
    const banner = document.getElementById('pc-perm-banner');
    if (!mobile || !banner) return;

    const has = !mobile.classList.contains('hidden');

    if (has) {
        banner.classList.remove('hidden');
        banner.classList.add('visible');

        const title = document.getElementById('perm-title');
        const desc = document.getElementById('perm-desc');
        if (title) document.getElementById('pc-perm-title').textContent = title.textContent;
        if (desc) document.getElementById('pc-perm-desc').textContent = desc.textContent;
    } else {
        banner.classList.add('hidden');
        banner.classList.remove('visible');
    }

    // Update auto-accept button state
    pcUpdateAutoAcceptBtn();
}

// Toggle auto-accept for current session (PC mode). The server owns the list
// (main.js setAutoAccept), so the phone sees the same state and nothing needs
// this window open to be approved.
function pcToggleAutoAccept() {
    const session = (typeof homeSession !== 'undefined' && homeSession) || 'claude';
    pcAutoAcceptFlip(session);
}

function pcAutoAcceptFlip(session) {
    if (typeof window.setAutoAccept !== 'function' || typeof autoAcceptSessions === 'undefined') {
        if (typeof toast === 'function') toast('Auto-accept not available', 'error');
        return;
    }
    const on = !autoAcceptSessions.has(session);
    window.setAutoAccept(session, on);
    if (typeof toast === 'function') toast(`Auto-accept ${on ? 'ON' : 'OFF'}: ${session}`, on ? 'success' : 'info');
}

// Update PC auto-accept button visual state
function pcUpdateAutoAcceptBtn() {
    const session = (typeof homeSession !== 'undefined' && homeSession) || 'claude';
    const isActive = typeof autoAcceptSessions !== 'undefined' && autoAcceptSessions.has(session);

    // Update permission banner button
    const btn = document.getElementById('pc-auto-accept-btn');
    const label = document.getElementById('pc-auto-accept-label');
    if (btn && label) {
        btn.classList.toggle('active', isActive);
        label.textContent = isActive ? 'AUTO [*]' : 'AUTO';
    }

    // Update sidebar button
    const sidebarBtn = document.getElementById('pc-sidebar-auto-btn');
    if (sidebarBtn) {
        sidebarBtn.classList.toggle('active', isActive);
        sidebarBtn.textContent = isActive ? '[A*]' : '[A]';
        sidebarBtn.title = isActive
            ? `Auto-approve ON for "${session}" - click to disable`
            : `Auto-approve OFF for "${session}" - click to enable`;
    }

    // Update combined panel auto-accept buttons
    pcCombineUpdateAutoAcceptBtns();
}

// Toggle auto-accept for a specific session (used in combined view).
// setAutoAccept repaints every auto button, this panel's included.
function pcCombineToggleAutoAccept(session, panelIndex) {
    pcAutoAcceptFlip(session);
}

// Update all combined panel auto-accept buttons
function pcCombineUpdateAutoAcceptBtns() {
    if (!Desktop.combined.enabled) return;

    Desktop.combined.sessions.forEach((session, idx) => {
        const btn = document.getElementById(`pc-combined-auto-${idx}`);
        if (btn) {
            const isActive = typeof autoAcceptSessions !== 'undefined' && autoAcceptSessions.has(session);
            btn.classList.toggle('active', isActive);
            btn.textContent = isActive ? '[A*]' : '[A]';
        }
    });
}

// ==============================================
// INPUT HANDLING
// ==============================================

function handleInputKeydown(e) {
    // Suggestions navigation
    if (Desktop.suggestions.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            Desktop.selectedSuggestion = Math.min(Desktop.selectedSuggestion + 1, Desktop.suggestions.length - 1);
            showSuggestions();
            return;
        }
        if (e.key === 'ArrowUp' && Desktop.selectedSuggestion >= 0) {
            e.preventDefault();
            Desktop.selectedSuggestion = Math.max(Desktop.selectedSuggestion - 1, -1);
            showSuggestions();
            return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && Desktop.selectedSuggestion >= 0)) {
            e.preventDefault();
            if (Desktop.selectedSuggestion >= 0) {
                selectSuggestion(Desktop.selectedSuggestion);
            } else if (Desktop.suggestions.length > 0) {
                selectSuggestion(0);
            }
            return;
        }
        if (e.key === 'Escape') {
            hideSuggestions();
            return;
        }
    }

    // Ctrl+Arrow in split view: let it bubble to panel navigation
    if (e.ctrlKey && e.key.startsWith('Arrow') && Desktop.combined.enabled) return;

    // History navigation (when no suggestions)
    if (e.key === 'ArrowUp' && Desktop.suggestions.length === 0) {
        e.preventDefault();
        if (Desktop.historyIndex < Desktop.commandHistory.length - 1) {
            // Save current input before first navigation
            if (Desktop.historyIndex === -1) {
                Desktop.currentInput = e.target.value;
            }
            Desktop.historyIndex++;
            e.target.value = Desktop.commandHistory[Desktop.historyIndex];
        }
        return;
    }

    if (e.key === 'ArrowDown' && Desktop.suggestions.length === 0) {
        e.preventDefault();
        if (Desktop.historyIndex > 0) {
            Desktop.historyIndex--;
            e.target.value = Desktop.commandHistory[Desktop.historyIndex];
        } else if (Desktop.historyIndex === 0) {
            // Restore saved input
            Desktop.historyIndex = -1;
            e.target.value = Desktop.currentInput;
        }
        // If already at -1, do nothing (keep current text)
        return;
    }

    // Send
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        pcSend();
        return;
    }

    // Clear input
    if (e.key === 'Escape') {
        if (e.target.value) {
            e.target.value = '';
            hideSuggestions();
        }
        return;
    }
}

async function pcSend() {
    const input = document.getElementById('pc-input');
    if (!input) return;

    let msg = input.value.trim();
    if (!msg) return;

    // Expand abbreviations
    if (typeof expandAbbreviation === 'function') {
        msg = expandAbbreviation(msg);
    }

    // Add to history
    if (msg !== Desktop.commandHistory[0]) {
        Desktop.commandHistory.unshift(msg);
        if (Desktop.commandHistory.length > 100) Desktop.commandHistory.pop();
        saveCommandHistory();
    }
    Desktop.historyIndex = -1;
    Desktop.currentInput = '';

    input.value = '';
    hideSuggestions();

    // Visual feedback
    input.classList.add('sending');
    setTimeout(() => input.classList.remove('sending'), 200);

    // Send via mobile
    const mobileInput = document.getElementById('prompt');
    if (mobileInput && typeof send === 'function') {
        mobileInput.value = msg;
        await send();
        // Clear attachment indicator after send
        pcUpdateAttachIndicator();
    }
}

function pcQuick(cmd) {
    const input = document.getElementById('pc-input');
    if (input) input.value = cmd;
    pcSend();
}

function loadCommandHistory() {
    try {
        const saved = localStorage.getItem('pc_command_history');
        if (saved) Desktop.commandHistory = JSON.parse(saved);
    } catch (e) {
        Desktop.commandHistory = [];
    }
}

function saveCommandHistory() {
    try {
        localStorage.setItem('pc_command_history', JSON.stringify(Desktop.commandHistory.slice(0, 100)));
    } catch (e) {}
}

// ==============================================
// TERMINAL CONTROLS
// ==============================================

async function pcSendCtrl(key) {
    if (typeof sendCtrl === 'function') {
        await sendCtrl(key);
        return;
    }

    try {
        const session = typeof getCurrentTargetSession === 'function'
            ? getCurrentTargetSession()
            : (typeof homeSession !== 'undefined' ? homeSession : 'claude');

        await fetch('/api/key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': typeof token !== 'undefined' ? token : '' },
            body: JSON.stringify({ key: 'C-' + key, session })
        });

        if (typeof toast === 'function') toast(`^${key.toUpperCase()}`, 'success');
    } catch (e) {}
}

async function pcTmuxPane() {
    try {
        const session = typeof getCurrentTargetSession === 'function'
            ? getCurrentTargetSession()
            : (typeof homeSession !== 'undefined' ? homeSession : 'claude');

        await fetch('/api/tmux/pane', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': typeof token !== 'undefined' ? token : '' },
            body: JSON.stringify({ session })
        });

        if (typeof toast === 'function') toast('PANE', 'success');
    } catch (e) {}
}

async function pcTmuxWindow() {
    try {
        const session = typeof getCurrentTargetSession === 'function'
            ? getCurrentTargetSession()
            : (typeof homeSession !== 'undefined' ? homeSession : 'claude');

        await fetch('/api/tmux/window', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': typeof token !== 'undefined' ? token : '' },
            body: JSON.stringify({ session })
        });

        if (typeof toast === 'function') toast('WINDOW', 'success');
    } catch (e) {}
}

// ==============================================
// FONT SIZE
// ==============================================

function pcSetFontSize(level) {
    Desktop.fontSizeLevel = level;
    localStorage.setItem('pc_font_size', level.toString());
    pcApplyFontSize(level);

    document.querySelectorAll('.pc-font-btns button').forEach((btn, i) => {
        btn.classList.toggle('active', i + 1 === level);
    });
}

function pcApplyFontSize(level) {
    const terminal = document.getElementById('pc-terminal');
    if (!terminal) return;

    const sizes = { 1: '0.7rem', 2: '0.85rem', 3: '1rem', 4: '1.15rem' };
    terminal.style.fontSize = sizes[level] || sizes[2];
}

// ==============================================
// KEYBOARD SHORTCUTS
// ==============================================

function initKeyboardShortcuts() {
    document.addEventListener('keydown', handleGlobalKeydown);
}

function handleGlobalKeydown(e) {
    if (!Desktop.isPC) return;

    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    const input = document.getElementById('pc-input');
    if (handleAppShortcut(e, typing, input)) return;

    // Skip if typing
    if (typing) return;
    handleQuickKeys(e, input);
}

// The shortcuts that work anywhere, typing or not (Ctrl/Alt combos, numpad, Escape).
// Answers true when it handled the key, so handleGlobalKeydown stops right there.
function handleAppShortcut(e, typing, input) {
    // Command palette
    if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        toggleCommandPalette();
        return true;
    }

    // Search
    if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        toggleSearch();
        return true;
    }

    // Image gallery
    if (e.ctrlKey && e.key === 'i') {
        e.preventDefault();
        pcShowGallery();
        return true;
    }

    // File attachment
    if (e.ctrlKey && e.key === 'u') {
        e.preventDefault();
        pcShowFileAttach();
        return true;
    }

    // Runner terminal attachment (Ctrl+T)
    if (e.ctrlKey && e.key === 't') {
        e.preventDefault();
        pcShowRunnerAttach();
        return true;
    }

    // Clear
    if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        if (typing && document.activeElement === input) {
            input.value = '';
        } else {
            pcQuick('/clear');
        }
        return true;
    }

    // Session cycling - Ctrl+Tab / Ctrl+Shift+Tab
    if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        pcCycleSession(e.shiftKey ? -1 : 1);
        return true;
    }

    // Session jump - Alt+1-9
    if (e.altKey && !e.ctrlKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        pcJumpToSession(parseInt(e.key));
        return true;
    }

    // Numpad * toggles vault augmentation (only when not typing a literal *)
    if (e.code === 'NumpadMultiply' && !typing) {
        e.preventDefault();
        if (typeof toggleVault === 'function') toggleVault();
        return true;
    }

    // NO KEY FOR [PB]. Numpad / is FOCUS INPUT -- it emits `e.key === '/'`, which
    // is handled further down, so binding `e.code === 'NumpadDivide'` up here
    // silently ate it (a `code` test and a `key` test for the same physical key,
    // and the earlier one wins). The free-looking numpad keys are all taken:
    // * vault · + vault reset · - unfocus · / focus · Enter approve · . deny,
    // and the digits collide with `e.key >= '1' && e.key <= '9'` below.
    // The button in the PC status row is the way in until Leon names a key.

    // Numpad + resets the vault cycle (RST) for the active session (only when input is unfocused)
    if (e.code === 'NumpadAdd' && !typing) {
        e.preventDefault();
        if (typeof resetVaultCycle === 'function') resetVaultCycle();
        return true;
    }

    // Numpad - unfocuses the current input (preventDefault eats the '-' so it never types)
    if (e.code === 'NumpadSubtract' && typing) {
        e.preventDefault();
        document.activeElement.blur();
        return true;
    }

    // Terminal controls
    if (e.ctrlKey && !typing) {
        if (e.key === 'c' && !window.getSelection().toString()) {
            e.preventDefault();
            pcSendCtrl('c');
            return true;
        }
        if (e.key === 'd') { e.preventDefault(); pcSendCtrl('d'); return true; }
        if (e.key === 'z') { e.preventDefault(); pcSendCtrl('z'); return true; }
        if (e.key === 'l') { e.preventDefault(); pcSendCtrl('l'); return true; }
    }

    // Stop Claude (Ctrl+Shift+X) - sends Escape to terminal
    if (e.ctrlKey && e.shiftKey && e.key === 'X') {
        e.preventDefault();
        sendKeyToTerminal('Escape');
        if (typeof toast === 'function') toast('Stop signal sent', 'success');
        return true;
    }

    // Voice input (Ctrl+M)
    if (e.ctrlKey && e.key === 'm') {
        e.preventDefault();
        pcToggleMic();
        return true;
    }

    // Expand input (Ctrl+E)
    if (e.ctrlKey && e.key === 'e') {
        e.preventDefault();
        pcOpenExpandedInput();
        return true;
    }

    // Close modals (plain Escape)
    if (e.key === 'Escape') {
        // Close preview first if open
        const preview = document.getElementById('pc-gallery-preview');
        if (preview && preview.classList.contains('visible')) { pcClosePreview(); return true; }
        if (Desktop.paletteOpen) { toggleCommandPalette(); return true; }
        if (Desktop.searchOpen) { toggleSearch(); return true; }
        // Close gallery if open
        const gallery = document.getElementById('pc-gallery-modal');
        if (gallery && !gallery.classList.contains('hidden')) { pcHideGallery(); return true; }
        // Close file modal if open
        const fileModal = document.getElementById('pc-file-modal');
        if (fileModal && !fileModal.classList.contains('hidden')) { pcHideFileAttach(); return true; }
        hideContextMenu();
        document.getElementById('pc-history-panel')?.classList.add('hidden');
        document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
        return true;
    }

    // Ctrl/Cmd+B collapses the sidebar to its rail. Deliberately ABOVE the
    // `typing` gate: it is a chord, so it cannot steal a keystroke, and the one
    // moment you want the terminal wider is while writing in it.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        pcSidebarToggleCollapse();
        return true;
    }
    return false;
}

// The keys that only mean something when he is NOT typing: permission answers,
// focus the input, Ctrl/Alt navigation, scrolling the terminal.
function handleQuickKeys(e, input) {

    // Permission shortcuts (input unfocused only -- `typing` already returned above).
    // Numpad variants use e.code so they work regardless of NumLock and never collide
    // with the main-row keys: NumpadEnter = approve, NumpadDecimal = deny, A = auto-accept.
    const permOpen = !document.getElementById('pc-perm-banner')?.classList.contains('hidden');
    if (permOpen && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === 'y' || e.key === 'Y' || e.code === 'NumpadEnter') {
            e.preventDefault();
            if (typeof approvePerm === 'function') approvePerm();
            return;
        }
        if (e.key === 'n' || e.key === 'N' || e.code === 'NumpadDecimal') {
            e.preventDefault();
            if (typeof denyPerm === 'function') denyPerm();
            return;
        }
        if (e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            if (typeof pcToggleAutoAccept === 'function') pcToggleAutoAccept();
            return;
        }
    }

    // Focus input
    if (e.key === '/' || e.key === 'i') {
        e.preventDefault();
        input?.focus();
        return;
    }

    // Terminal control keys (Ctrl + key sends to tmux)
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
        // In split view, Ctrl+Arrow is handled by panel navigation
        if (Desktop.combined.enabled && e.key.startsWith('Arrow')) return;

        // Allow Ctrl+C to copy if there's a selection
        if (e.key === 'c' && window.getSelection().toString().length > 0) {
            return; // Let browser handle copy
        }
        // Allow Ctrl+V to paste normally
        if (e.key === 'v') {
            return; // Let browser handle paste
        }

        const keyMap = {
            'Enter': 'Enter',
            'ArrowUp': 'Up',
            'ArrowDown': 'Down',
            'ArrowLeft': 'Left',
            'ArrowRight': 'Right',
            'Escape': 'Escape',
            'Backspace': 'BSpace',
            'Tab': 'Tab',
            'c': 'C-c',
            'd': 'C-d',
            'z': 'C-z',
            'l': 'C-l'
        };

        if (keyMap[e.key]) {
            e.preventDefault();
            e.stopPropagation();
            sendKeyToTerminal(keyMap[e.key]);
            return;
        }
    }

    // Alt + arrows for word navigation
    if (e.altKey && !e.ctrlKey) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); sendKeyToTerminal('M-b'); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); sendKeyToTerminal('M-f'); return; }
    }

    // Vim-style scroll
    const terminal = document.getElementById('pc-terminal');
    if (terminal) {
        if (e.key === 'j') { terminal.scrollTop += 60; return; }
        if (e.key === 'k') { terminal.scrollTop -= 60; return; }
        if (e.key === 'g') { terminal.scrollTop = 0; return; }
        if (e.key === 'G') { scrollToBottom(); return; }
        if (e.key === 'PageUp') { terminal.scrollTop -= terminal.clientHeight; return; }
        if (e.key === 'PageDown') { terminal.scrollTop += terminal.clientHeight; return; }
    }
}

// ==============================================
// TERMINAL KEY SENDER
// ==============================================

async function sendKeyToTerminal(key) {
    const session = (typeof homeSession !== 'undefined' && homeSession) ||
                    (typeof TMUX_SESSION !== 'undefined' && TMUX_SESSION) || '';
    if (!session) { if (typeof toast === 'function') toast('No active session — create one with [+]'); return; }
    try {
        const res = await fetch('/api/terminal/key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session, key })
        });
        const data = await res.json();

        // Use the output from the response if available (instant update)
        if (data.output) {
            const pcTerminal = document.getElementById('pc-terminal');
            const mobileTerminal = document.getElementById('terminal');
            const formatted = escapeHtml(data.output).replace(/\n/g, '<br>');
            if (pcTerminal) pcTerminal.innerHTML = formatted;
            if (mobileTerminal) mobileTerminal.innerHTML = formatted;
        }
    } catch (e) {
        console.error('[TERMINAL] Key send failed:', e);
    }
}

// ==============================================
// CONTEXT MENU
// ==============================================

function initContextMenu() {
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('click', hideContextMenu);
}

function createContextMenu() {
    const menu = document.createElement('div');
    menu.className = 'pc-context-menu';
    menu.id = 'pc-context-menu';
    menu.innerHTML = `
        <div class="pc-ctx-item" onclick="pcCopy()"><span>[C]</span> Copy <kbd>Ctrl+C</kbd></div>
        <div class="pc-ctx-item" onclick="pcPaste()"><span>[V]</span> Paste <kbd>Ctrl+V</kbd></div>
        <div class="pc-ctx-divider"></div>
        <div class="pc-ctx-item" onclick="pcSendSelection()"><span>[>]</span> Send to Claude</div>
        <div class="pc-ctx-item" onclick="pcSearchSelection()"><span>[?]</span> Search</div>
        <div class="pc-ctx-item" onclick="pcAddFavorite()"><span>[+]</span> Bookmark</div>
        <div class="pc-ctx-divider"></div>
        <div class="pc-ctx-item" onclick="pcSendCtrl('c'); hideContextMenu();"><span>[X]</span> Interrupt ^C</div>
        <div class="pc-ctx-item" onclick="pcQuick('/clear'); hideContextMenu();"><span>[-]</span> Clear</div>
        <div class="pc-ctx-divider"></div>
        <div class="pc-ctx-item" onclick="pcSelectAll()"><span>[A]</span> Select All</div>
    `;
    document.body.appendChild(menu);
}

function handleContextMenu(e) {
    if (!Desktop.isPC) return;

    const terminal = document.getElementById('pc-terminal');
    if (!terminal?.contains(e.target)) return;

    e.preventDefault();
    const menu = document.getElementById('pc-context-menu');
    if (!menu) return;

    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 300) + 'px';
    menu.classList.add('visible');
}

function hideContextMenu() {
    document.getElementById('pc-context-menu')?.classList.remove('visible');
}

function pcCopy() {
    const sel = window.getSelection().toString();
    if (sel) {
        navigator.clipboard.writeText(sel);
        if (typeof toast === 'function') toast('Copied', 'success');
    }
    hideContextMenu();
}

function pcPaste() {
    navigator.clipboard.readText().then(text => {
        const input = document.getElementById('pc-input');
        if (input) {
            input.value += text;
            input.focus();
        }
    });
    hideContextMenu();
}

function pcSendSelection() {
    const sel = window.getSelection().toString();
    if (sel) {
        const input = document.getElementById('pc-input');
        if (input) {
            input.value = sel;
            pcSend();
        }
    }
    hideContextMenu();
}

function pcSearchSelection() {
    const sel = window.getSelection().toString();
    if (sel) {
        toggleSearch();
        const searchInput = document.getElementById('pc-search-input');
        if (searchInput) {
            searchInput.value = sel;
            performSearch(sel);
        }
    }
    hideContextMenu();
}

function pcSelectAll() {
    const terminal = document.getElementById('pc-terminal');
    if (terminal) {
        const range = document.createRange();
        range.selectNodeContents(terminal);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
    hideContextMenu();
}

// ==============================================
// UTILITIES
// ==============================================


// ==============================================
// TAB SYSTEM & Desktop Functions
// ==============================================

// ==============================================
// SURFACE REGISTRY
// A surface is a mountable panel that does NOT know where it lives: it owns an
// element id, an optional lazy room CSS, and its module's init/teardown hooks.
// This replaced a 170-line if/else that named nine panel ids in four places
// each -- adding a panel used to mean editing all four and forgetting one was
// how a panel ended up visible under another. It is also what makes a panel
// re-mountable in a DIFFERENT window (window roles, multi-monitor).
// `terminal` is deliberately special: it has no panel of its own, it restores
// the main/split sub-view instead.
// ==============================================
const SURFACES = {
    terminal:   { title: 'Terminal',   el: null,                    css: null,         init: null,             teardown: null,                where: 'main' },
    factory:    { title: 'Factory',    el: 'pc-factory-panel',      css: 'factory',    init: 'fxInit',         teardown: 'fxTeardown',   where: 'main' },
    tasks:      { title: 'Tasks',      el: 'pc-tasks-panel',        css: 'dashboard',  init: 'dashInit',       teardown: 'dashTeardown',      where: 'main' },
    clients:    { title: 'Clients',    el: 'pc-clients-panel',      css: 'clients',    init: 'clientsInit',    teardown: 'clientsTeardown',   where: 'main' },
    automations:{ title: 'Automations',el: 'pc-automations-panel',  css: 'automations',init: 'automationsInit',teardown: 'automationsTeardown', where: 'main' },
    codemap:    { title: 'Codemap',    el: 'pc-codemap-panel',      css: 'codemap',    init: 'codemapInit',    teardown: 'codemapTeardown',   where: 'main' },
    notifs:     { title: 'Notifs',     el: 'pc-notifs-panel',       css: 'notifs',     init: 'notifsInit',     teardown: 'notifsTeardown',    where: 'main' },
    lurk:       { title: 'NULL',       el: 'pc-lurk-panel',         css: 'lurk',       init: 'lurkInit',       teardown: 'lurkTeardown',      where: 'main' },
    studio:     { title: 'Studio',     el: 'pc-studio-panel',       css: 'studio',     init: 'studioInit',     teardown: 'studioTeardown',    where: 'main' },
    playlist:   { title: 'Labs',       el: 'pc-playlist-panel',     css: 'playlist',   init: 'playlistInit',   teardown: 'playlistTeardown',  where: 'main' },
    handson:    { title: 'Hands On',   el: 'pc-handson-panel',      css: 'handson',    init: 'hoInit',         teardown: 'hoTeardown',        where: 'main' },
    // NOTE: morning is deliberately NOT a surface. The brief is read once and
    // acted on, not switched to, so it is an overlay ([A] in the header) that
    // sits over whatever surface you were already on. See src/js/morning.js.
};
Desktop.surfaces = SURFACES;

function pcSurfaceCall(name) {
    if (name && typeof window[name] === 'function') window[name]();
}

function pcSwitchTab(tabName) {
    if (!Desktop.isPC) return;

    const prevTab = Desktop.activeTab;

    const terminalWrap = document.querySelector('.pc-terminal-wrap');
    const combinedWrap = document.getElementById('pc-combined-wrap');

    // Remember which terminal sub-view was active BEFORE we leave the terminal tab.
    if ((prevTab === 'terminal' || !prevTab) && tabName !== 'terminal') {
        const combinedVisible = combinedWrap && !combinedWrap.classList.contains('hidden');
        Desktop._terminalSubView = combinedVisible ? 'combined' : 'main';
    }

    Desktop.activeTab = tabName;

    // Update tab buttons
    document.querySelectorAll('.pc-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabName);
    });

    // Stop polling for the module we are leaving.
    if (prevTab && prevTab !== tabName) pcSurfaceCall(SURFACES[prevTab]?.teardown);

    // Hide every panel, then re-show only the one we are switching to. The old
    // code hid a hand-written subset inside each branch, which is why four
    // panels had to be force-hidden up front to stay correct.
    for (const key in SURFACES) {
        const el = SURFACES[key].el;
        if (el) document.getElementById(el)?.classList.add('hidden');
    }

    const surf = SURFACES[tabName];
    if (surf && surf.el) {
        terminalWrap?.classList.add('hidden');
        combinedWrap?.classList.add('hidden');
        document.getElementById(surf.el)?.classList.remove('hidden');
        if (surf.css && typeof WorldManager !== 'undefined' && WorldManager.loadRoomCSS) {
            WorldManager.loadRoomCSS(surf.css);
        }
        pcSurfaceCall(surf.init);
    } else {
        // terminal (default) — restore prior sub-view (main vs split)
        if (Desktop._terminalSubView === 'combined' && combinedWrap) {
            terminalWrap?.classList.add('hidden');
            combinedWrap.classList.remove('hidden');
        } else {
            terminalWrap?.classList.remove('hidden');
            combinedWrap?.classList.add('hidden');
        }
    }
}

// ==============================================
// INIT
// ==============================================

// The layout a restart's new window had is fetched back BEFORE anything reads it
// (src/js/layout-memory.js); on failure the window simply starts as before.
function pcStartDesktop() {
    const ready = window.pcLayout ? window.pcLayout.restore().catch(() => false) : Promise.resolve(false);
    ready.then(() => {
        let hs = null;
        try { hs = sessionStorage.getItem('tsrct_home_session'); } catch (e) {}
        // gallery.js read the session on screen before the restore landed.
        if (hs && !window.homeSession) window.homeSession = hs;
        initDesktopMode();
    });
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(pcStartDesktop, 200));
} else {
    setTimeout(pcStartDesktop, 200);
}

// Exports
window.Desktop = Desktop;
window.pcSend = pcSend;
window.pcQuick = pcQuick;
window.pcSendCtrl = pcSendCtrl;
window.pcTmuxPane = pcTmuxPane;
window.pcTmuxWindow = pcTmuxWindow;
window.pcSetFontSize = pcSetFontSize;
window.toggleCommandPalette = toggleCommandPalette;
window.toggleSearch = toggleSearch;
window.toggleHistoryPanel = toggleHistoryPanel;
window.scrollToBottom = scrollToBottom;
window.pcInsertSnippet = pcInsertSnippet;
window.pcAddFavorite = pcAddFavorite;
window.copyFavorite = copyFavorite;
window.deleteFavorite = deleteFavorite;
window.selectSuggestion = selectSuggestion;
window.executePaletteCommand = executePaletteCommand;
window.useHistoryItem = useHistoryItem;
window.searchNext = searchNext;
window.searchPrev = searchPrev;
window.pcCopy = pcCopy;
window.pcPaste = pcPaste;
window.pcSelectAll = pcSelectAll;
window.pcSendSelection = pcSendSelection;
window.pcSearchSelection = pcSearchSelection;
window.hideContextMenu = hideContextMenu;
window.pcToggleAutoAccept = pcToggleAutoAccept;
window.pcUpdateAutoAcceptBtn = pcUpdateAutoAcceptBtn;

// Runner exports
// Shared with the projector window (projector.js), which floats the same way.



window.pcSwitchTab = pcSwitchTab;


// Combined Terminals exports
window.pcCombineToggleAutoAccept = pcCombineToggleAutoAccept;
window.pcCombineUpdateAutoAcceptBtns = pcCombineUpdateAutoAcceptBtns;
// Session grouping — unified manual drag (sessions + groups). All reachable from inline handlers.


// Notification exports
window.requestNotificationPermission = requestNotificationPermission;
window.dismissNotificationPrompt = dismissNotificationPrompt;
window.showSystemNotification = showSystemNotification;

// Voice input exports
window.pcToggleMic = pcToggleMic;
window.pcToggleVoiceLang = pcToggleVoiceLang;
window.pcRefreshTunnel = pcRefreshTunnel;
window.pcCopyTunnel = pcCopyTunnel;

// ── Public API gap (Phase 3B): names reached from this file's own generated
//    onclick HTML or cross-file (main/dispatcher) that weren't already exported.
//    toggleEyeProtect included (desktop's version must stay the active one). ──
Object.assign(window, {
    pcOpenExpandedInput, pcCloseExpandedInput, pcExpandedToggleMic, pcExpandedToggleLang,
    toggleHistoryPanel, showSuggestions,
    // The canonical preference path (CLAUDE.md): scope is per-window vs
    // per-browser, not a durability choice. It lived private in this IIFE, so
    // every other module had to hand-roll sessionStorage and get the scope
    // decision wrong on its own. handson.js is the first caller.
    pcPrefGet, pcPrefSet,
});

})();
