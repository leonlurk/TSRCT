// ==============================================
// TSRCT - Hands-Free Mode v4 REMARKABLE
// Unified voice control - ZERO TOUCH required
// Phase 3B: IIFE-wrapped -- 27 internal fns private; explicit exports at bottom.
// ==============================================
(function () {

// ═══════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════

const HF = {
    // Core state
    active: false,
    session: null,
    recognition: null,
    listening: false,
    speaking: false,

    // SSE connection
    sse: null,
    sseReconnecting: false,
    sseWatchdog: null,
    sseLastMessage: 0,

    // Timing
    startTime: 0,
    timeInterval: null,
    watchdogInterval: null,
    lastActivityTime: 0,

    // Message handling
    messageBuffer: '',
    processingMessage: false,

    // Permission handling
    pendingPermission: null,
    awaitingPermission: false,

    // Session (single session only)

    // Working directory and resume
    cwd: null,
    resumeConversationId: null,

    // TTS
    voice: null,
    ttsQueue: [],

    // Debug
    debugVisible: false,

    // Voice command keywords (Spanish)
    COMMANDS: {
        // Send message
        SEND: ['enviar'],
        // Cancel/clear buffer
        CANCEL: ['cancelar'],
        // Exit immersive mode
        EXIT: ['salir'],
        // Approve permission
        APPROVE: ['aprobar'],
        // Deny permission
        DENY: ['denegar'],
        // Repeat last response
        REPEAT: ['repetir']
    },

    // Last response for repeat
    lastResponse: ''
};

// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

// Initialize TTS voice (prefer Spanish)
function hfInitVoice() {
    if (!('speechSynthesis' in window)) return;

    const voices = speechSynthesis.getVoices();
    HF.voice = voices.find(v => v.lang.startsWith('es')) ||
               voices.find(v => v.lang.startsWith('en')) ||
               voices[0];
    console.log('[HF] Voice:', HF.voice?.name || 'default');
}

// Load voices (async)
if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = hfInitVoice;
    hfInitVoice();
}

// Initialize hands-free voice system
function hfInit() {
    console.log('[HF] Initializing Hands-Free v4');
    hfInitVoice();
}

// ═══════════════════════════════════════════════════════════════════
// DEBUG LOGGING
// ═══════════════════════════════════════════════════════════════════

function hfLog(msg, type = 'log') {
    const time = new Date().toLocaleTimeString('es-ES', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    // Console
    if (type === 'error') console.error('[HF]', msg);
    else if (type === 'warn') console.warn('[HF]', msg);
    else console.log('[HF]', msg);

    // Debug panel
    const panel = $('hf-debug-content');
    if (panel) {
        const line = document.createElement('div');
        line.className = type === 'error' ? 'log-error' :
                        type === 'warn' ? 'log-warn' :
                        type === 'info' ? 'log-info' : '';
        line.textContent = `[${time}] ${msg}`;
        panel.appendChild(line);
        panel.scrollTop = panel.scrollHeight;

        // Keep max 100 lines
        while (panel.children.length > 100) {
            panel.removeChild(panel.firstChild);
        }
    }
}

function hfToggleDebug() {
    HF.debugVisible = !HF.debugVisible;
    const panel = $('hf-debug-panel');
    if (panel) panel.classList.toggle('visible', HF.debugVisible);
}

function hfClearDebug() {
    const panel = $('hf-debug-content');
    if (panel) panel.innerHTML = '';
}

// ═══════════════════════════════════════════════════════════════════
// ENTER / EXIT IMMERSIVE MODE
// ═══════════════════════════════════════════════════════════════════

// Show setup modal before entering immersive mode
async function hfShowSetup() {
    if (HF.active) return;

    // Create setup modal if not exists
    let modal = $('hf-setup-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'hf-setup-modal';
        modal.className = 'hf-setup-modal';
        modal.innerHTML = `
            <div class="hf-setup-content">
                <div class="hf-setup-header">
                    <span>CONFIGURAR MANOS LIBRES</span>
                    <button class="hf-setup-close" onclick="hfCloseSetup()">X</button>
                </div>
                <div class="hf-setup-body">
                    <div class="hf-setup-section">
                        <label>Carpeta de trabajo:</label>
                        <input type="text" id="hf-setup-cwd" class="hf-setup-input" placeholder="Loading...">
                        <div class="hf-setup-projects" id="hf-setup-projects"></div>
                    </div>
                    <div class="hf-setup-section">
                        <label>Resumir conversacion (opcional):</label>
                        <input type="text" id="hf-setup-resume" class="hf-setup-input" placeholder="Leave empty for a new conversation">
                        <div class="hf-setup-conversations" id="hf-setup-conversations"></div>
                    </div>
                    <div class="hf-setup-info" id="hf-setup-info">
                        Claude se ejecutara en la carpeta seleccionada.
                    </div>
                </div>
                <div class="hf-setup-footer">
                    <button class="hf-setup-cancel" onclick="hfCloseSetup()">Cancelar</button>
                    <button class="hf-setup-start" onclick="hfStartFromSetup()">INICIAR</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    // Load current cwd
    let currentCwd = '/home';
    try {
        const cwdRes = await fetch('/api/cwd', { headers: { 'Authorization': token } });
        const cwdData = await cwdRes.json();
        currentCwd = cwdData.cwd || '/home';
        $('hf-setup-cwd').value = currentCwd;
        HF.cwd = currentCwd;
    } catch (e) {
        $('hf-setup-cwd').value = currentCwd;
    }

    // Load recent projects
    hfLoadProjects();

    // Load recent conversations for current project
    hfLoadConversations(currentCwd);

    // Show modal
    modal.classList.add('visible');
    playSound('tap');
}

function hfCloseSetup() {
    const modal = $('hf-setup-modal');
    if (modal) modal.classList.remove('visible');
}

async function hfLoadProjects() {
    const container = $('hf-setup-projects');
    if (!container) return;

    try {
        const res = await fetch('/api/projects', { headers: { 'Authorization': token } });
        const data = await res.json();

        if (data.projects && data.projects.length > 0) {
            container.innerHTML = data.projects.slice(0, 5).map(p =>
                `<button class="hf-setup-project" onclick="hfSelectProject('${p.path}')">${p.name}</button>`
            ).join('');
        } else {
            container.innerHTML = '<span class="hf-setup-hint">No hay proyectos recientes</span>';
        }
    } catch (e) {
        container.innerHTML = '<span class="hf-setup-hint">Could not load projects</span>';
    }
}

async function hfLoadConversations(projectPath = null) {
    const container = $('hf-setup-conversations');
    if (!container) return;

    // Use provided path or get from input
    const path = projectPath || $('hf-setup-cwd')?.value || '';

    try {
        // Pass project filter to API
        const apiUrl = path
            ? `/api/conversations?project=${encodeURIComponent(path)}`
            : '/api/conversations';

        const res = await fetch(apiUrl, { headers: { 'Authorization': token } });
        const data = await res.json();

        if (data.conversations && data.conversations.length > 0) {
            container.innerHTML = data.conversations.slice(0, 6).map(c => {
                // Truncate preview for display
                const previewText = c.preview
                    ? (c.preview.length > 40 ? c.preview.substring(0, 40) + '...' : c.preview)
                    : 'Sin resumen';

                return `<button class="hf-setup-conv" onclick="hfSelectConversation('${c.id}')" title="${c.preview || c.id}">
                    <span class="hf-conv-preview">${previewText}</span>
                    <span class="hf-conv-date">${c.date || ''}</span>
                </button>`;
            }).join('');
        } else {
            container.innerHTML = '<span class="hf-setup-hint">No conversations - a new one will be created</span>';
        }
    } catch (e) {
        console.error('[HF] Error loading conversations:', e);
        container.innerHTML = '<span class="hf-setup-hint">New conversation</span>';
    }
}

function hfSelectProject(path) {
    $('hf-setup-cwd').value = path;
    HF.cwd = path;
    // Clear previous conversation selection
    $('hf-setup-resume').value = '';
    HF.resumeConversationId = null;
    // Reload conversations for this project
    hfLoadConversations(path);
    playSound('tap');
}

function hfSelectConversation(id) {
    $('hf-setup-resume').value = id;
    HF.resumeConversationId = id;
    playSound('tap');
}

function hfBrowseProjects() {
    // Toggle projects visibility
    const container = $('hf-setup-projects');
    if (container) {
        container.classList.toggle('expanded');
    }
}

async function hfStartFromSetup() {
    const cwd = $('hf-setup-cwd')?.value?.trim();
    const resumeId = $('hf-setup-resume')?.value?.trim();

    if (!cwd) {
        toast('Pick a folder', 'error');
        return;
    }

    HF.cwd = cwd;
    HF.resumeConversationId = resumeId || null;

    hfCloseSetup();
    await hfEnterImmersive();
}

async function hfEnterImmersive() {
    if (HF.active) return;

    // If no cwd set, show setup first
    if (!HF.cwd) {
        hfShowSetup();
        return;
    }

    hfLog('Entering immersive mode...', 'info');
    hfLog(`CWD: ${HF.cwd}`, 'info');
    if (HF.resumeConversationId) {
        hfLog(`Resume: ${HF.resumeConversationId}`, 'info');
    }
    playSound('mode');

    // Show UI
    const el = $('hf-immersive');
    el.classList.add('active');
    HF.active = true;
    hfMuteWarned = false;
    HF.startTime = Date.now();
    HF.lastActivityTime = Date.now();
    HF.messageBuffer = '';
    HF.pendingPermission = null;
    HF.awaitingPermission = false;

    hfSetState('idle', 'INICIANDO...');

    // Update cwd display in UI
    const cwdDisplay = $('hf-cwd-display');
    if (cwdDisplay) {
        const shortCwd = HF.cwd.split('/').slice(-2).join('/');
        cwdDisplay.textContent = shortCwd;
        cwdDisplay.title = HF.cwd;
    }

    // Start timers
    HF.timeInterval = setInterval(hfUpdateTime, 1000);
    hfStartWatchdog();

    try {
        // Create HF session with cwd and optional resume
        hfLog('Creating session...');
        const payload = {
            name: 'main',
            cwd: HF.cwd
        };
        if (HF.resumeConversationId) {
            payload.resume = HF.resumeConversationId;
        }

        const res = await fetch('/api/hf/start', {
            method: 'POST',
            headers: { 'Authorization': token, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to create session');

        HF.session = data.session;
        hfLog(`Session: ${HF.session.id} in ${HF.session.cwd || HF.cwd}`, 'info');

        // Connect SSE
        hfConnectSSE(HF.session.id);

        // Init speech recognition
        hfInitRecognition();

        // Voice greeting
        const cwdName = HF.cwd.split('/').pop();
        const resumeMsg = HF.resumeConversationId ? ', resumiendo conversación anterior' : '';
        hfSpeak(`Modo manos libres en ${cwdName}${resumeMsg}. Di tu mensaje y luego enviar.`, () => {
            if (HF.active) hfStartListening();
        });

    } catch (e) {
        hfLog(`Error: ${e.message}`, 'error');
        hfSetState('error', 'ERROR: ' + e.message);
        hfSpeak('Error iniciando. ' + e.message);
    }
}

function hfExit() {
    if (!HF.active) return;

    hfLog('Exiting immersive mode', 'info');
    playSound('mode');

    // Stop everything
    hfStopListening();
    hfStopWatchdog();
    speechSynthesis.cancel();

    if (HF.sse) { HF.sse.close(); HF.sse = null; }
    if (HF.sseWatchdog) { clearInterval(HF.sseWatchdog); HF.sseWatchdog = null; }
    if (HF.timeInterval) { clearInterval(HF.timeInterval); HF.timeInterval = null; }

    // Stop session on server
    if (HF.session) {
        fetch(`/api/hf/stop/${HF.session.id}`, {
            method: 'POST',
            headers: { 'Authorization': token }
        }).catch(() => {});
    }

    // Hide UI
    const el = $('hf-immersive');
    el.classList.remove('active', 'listening', 'processing', 'speaking', 'error', 'permission');

    // Reset state
    HF.active = false;
    HF.session = null;
    HF.listening = false;
    HF.speaking = false;
    HF.messageBuffer = '';
    HF.processingMessage = false;
    HF.pendingPermission = null;
    HF.awaitingPermission = false;
    HF.sseReconnecting = false;

    // Reset cwd and resume for next session
    HF.cwd = null;
    HF.resumeConversationId = null;

    // Reset UI
    $('hf-transcript').textContent = '...';
    $('hf-response').textContent = 'Esperando...';
    $('hf-status').textContent = 'LISTO';
    const cwdDisplay = $('hf-cwd-display');
    if (cwdDisplay) cwdDisplay.textContent = '~/';
}

// ═══════════════════════════════════════════════════════════════════
// SPEECH RECOGNITION
// ═══════════════════════════════════════════════════════════════════

function hfInitRecognition() {
    let lastProcessedTranscript = '';

    HF.recognition = createSpeechRecognizer({
        continuous: false,
        interimResults: true,
        lang: 'es-ES',
        maxAlternatives: 1,
        onStart: () => {
            HF.listening = true;
            HF.lastActivityTime = Date.now();
            lastProcessedTranscript = ''; // Reset on new session
            hfSetState('listening', 'LISTENING...');
        },
        onEnd: () => {
            HF.listening = false;
            // Auto-restart if active and not speaking/processing
            if (HF.active && !HF.speaking && !HF.processingMessage) {
                setTimeout(() => {
                    if (HF.active && !HF.speaking && !HF.listening && !HF.processingMessage) {
                        hfStartListening();
                    }
                }, 300);
            }
        },
        onResult: (e) => {
            HF.lastActivityTime = Date.now();
            // Simple: get the first (and only) result
            const result = e.results[0];
            const transcript = result[0].transcript.toLowerCase().trim();
            // Show what user is saying (only interim, buffer already has processed text)
            if (!result.isFinal) {
                const display = HF.messageBuffer + (HF.messageBuffer ? ' ' : '') + transcript;
                $('hf-transcript').textContent = display || 'Listening...';
            }
            // When final, process it (only once per session)
            if (result.isFinal && transcript && transcript !== lastProcessedTranscript) {
                lastProcessedTranscript = transcript;
                hfLog(`Heard: "${transcript}"`);
                hfProcessVoiceInput(transcript);
                // Update display after processing
                $('hf-transcript').textContent = HF.messageBuffer || 'Listening...';
            }
        },
        onError: (e) => {
            hfLog(`Recognition error: ${e.error}`, 'warn');
            HF.listening = false;
            if (e.error === 'not-allowed') {
                hfSetState('error', 'PERMISO DE MIC DENEGADO');
                hfSpeak('Necesito permiso del micrófono');
            } else if (e.error === 'no-speech' || e.error === 'aborted') {
                // Normal - auto-restart will handle
            } else {
                // Other errors - try to recover
                setTimeout(() => {
                    if (HF.active && !HF.speaking && !HF.processingMessage) {
                        hfStartListening();
                    }
                }, 500);
            }
        }
    });

    if (!HF.recognition) {
        hfLog('Speech recognition not supported', 'error');
        hfSpeak('Reconocimiento de voz no soportado');
        return;
    }
}

function hfStartListening() {
    if (!HF.recognition || HF.listening || HF.speaking) return;

    try {
        HF.recognition.start();
    } catch (e) {
        // Might already be running
        try {
            HF.recognition.abort();
            setTimeout(() => {
                if (HF.active && !HF.speaking) {
                    HF.recognition.start();
                }
            }, 100);
        } catch (e2) {}
    }
}

function hfStopListening() {
    if (HF.recognition && HF.listening) {
        try { HF.recognition.stop(); } catch (e) {}
    }
    HF.listening = false;
}

// ═══════════════════════════════════════════════════════════════════
// VOICE COMMAND PROCESSING
// ═══════════════════════════════════════════════════════════════════

function hfNormalize(text) {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function hfMatchesAny(text, keywords) {
    const norm = hfNormalize(text);
    return keywords.some(kw => {
        const normKw = hfNormalize(kw);
        return norm === normKw || norm.startsWith(normKw + ' ') || norm.endsWith(' ' + normKw);
    });
}

function hfContainsAny(text, keywords) {
    const norm = hfNormalize(text);
    return keywords.some(kw => norm.includes(hfNormalize(kw)));
}

function hfProcessVoiceInput(transcript) {
    const norm = hfNormalize(transcript);

    // ─────────────────────────────────────────────────────────────
    // PRIORITY 1: Permission response (if awaiting)
    // ─────────────────────────────────────────────────────────────
    if (HF.awaitingPermission && HF.pendingPermission) {
        if (hfMatchesAny(transcript, HF.COMMANDS.APPROVE)) {
            hfLog('Command: APPROVE permission');
            hfRespondPermission(true);
            return;
        }
        if (hfMatchesAny(transcript, HF.COMMANDS.DENY)) {
            hfLog('Command: DENY permission');
            hfRespondPermission(false);
            return;
        }
        // Didn't understand - repeat the question
        hfSpeak('Di aprobar o denegar.');
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // PRIORITY 2: Exit command
    // ─────────────────────────────────────────────────────────────
    if (hfMatchesAny(transcript, HF.COMMANDS.EXIT)) {
        hfLog('Command: EXIT');
        hfSpeak('Cerrando modo manos libres.', () => hfExit());
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // PRIORITY 3: Repeat last response
    // ─────────────────────────────────────────────────────────────
    if (hfMatchesAny(transcript, HF.COMMANDS.REPEAT)) {
        hfLog('Command: REPEAT');
        if (HF.lastResponse) {
            hfSpeak(HF.lastResponse);
        } else {
            hfSpeak('No hay nada que repetir.');
        }
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // PRIORITY 4: Cancel/Clear buffer
    // ─────────────────────────────────────────────────────────────
    if (hfMatchesAny(transcript, HF.COMMANDS.CANCEL)) {
        hfLog('Command: CANCEL');
        HF.messageBuffer = '';
        $('hf-transcript').textContent = 'Borrado. Di tu mensaje...';
        hfSpeak('Borrado.');
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // PRIORITY 5: Send message
    // ─────────────────────────────────────────────────────────────
    if (hfMatchesAny(transcript, HF.COMMANDS.SEND)) {
        hfLog('Command: SEND');

        // Extract message without send keyword
        let msg = transcript;
        for (const kw of HF.COMMANDS.SEND) {
            const pattern = new RegExp(`\\s*${kw}\\s*`, 'gi');
            msg = msg.replace(pattern, ' ');
        }
        msg = msg.trim();

        // Add any remaining text to buffer
        if (msg) {
            HF.messageBuffer += (HF.messageBuffer ? ' ' : '') + msg;
        }

        // Send accumulated message
        if (HF.messageBuffer.trim()) {
            const toSend = HF.messageBuffer.trim();
            HF.messageBuffer = '';
            hfSendMessage(toSend);
        } else {
            hfSpeak('No hay mensaje para enviar.');
        }
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // DEFAULT: Accumulate to buffer
    // ─────────────────────────────────────────────────────────────
    HF.messageBuffer += (HF.messageBuffer ? ' ' : '') + transcript;
    // Display is updated by onresult, not here
    hfLog(`Buffer: "${HF.messageBuffer}"`);
}

// ═══════════════════════════════════════════════════════════════════
// SEND MESSAGE TO CLAUDE
// ═══════════════════════════════════════════════════════════════════

async function hfSendMessage(message) {
    if (!HF.session || !message) {
        hfLog('Cannot send - no session or message', 'error');
        return;
    }

    hfLog(`Sending: "${message.substring(0, 50)}..."`);

    HF.processingMessage = true;
    hfStopListening();
    hfSetState('processing', 'ENVIANDO...');
    $('hf-transcript').textContent = message;
    $('hf-response').textContent = 'Procesando...';

    try {
        const res = await fetch('/api/hf/send', {
            method: 'POST',
            headers: { 'Authorization': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: HF.session.id, message })
        });

        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || 'Error desconocido');
        }

        hfLog('Message sent, waiting for response...');
        // Response will come via SSE

    } catch (e) {
        hfLog(`Send error: ${e.message}`, 'error');
        hfSetState('error', 'Error: ' + e.message);
        hfSpeak('Error enviando mensaje. ' + e.message, () => {
            HF.processingMessage = false;
            if (HF.active) hfStartListening();
        });
    }
}

// ═══════════════════════════════════════════════════════════════════
// PERMISSION HANDLING
// ═══════════════════════════════════════════════════════════════════

function hfShowPermission(perm) {
    HF.pendingPermission = perm;
    HF.awaitingPermission = true;

    hfSetState('permission', 'PERMISO REQUERIDO');

    // Build speech message
    let msg = '';
    const file = perm.file ? perm.file.split('/').pop().split('\\').pop() : '';

    if (perm.tool === 'Bash') {
        const cmd = (perm.command || '').substring(0, 40);
        msg = `Claude quiere ejecutar: ${cmd}`;
    } else if (perm.tool === 'Edit') {
        msg = `Claude quiere editar: ${file}`;
    } else if (perm.tool === 'Write') {
        msg = `Claude quiere crear: ${file}`;
    } else if (perm.tool === 'Read') {
        msg = `Claude quiere leer: ${file}`;
    } else {
        msg = `Claude solicita permiso para: ${perm.tool}`;
    }

    msg += '. ¿Sí o no?';

    // Update UI
    $('hf-response').textContent = `PERMISO: ${perm.tool}\n${perm.command || perm.file || ''}`;

    // Speak and listen for response
    hfSpeak(msg, () => {
        if (HF.active && HF.awaitingPermission) {
            hfStartListening();
        }
    });
}

async function hfRespondPermission(approved) {
    if (!HF.pendingPermission) return;

    const perm = HF.pendingPermission;
    HF.pendingPermission = null;
    HF.awaitingPermission = false;

    hfSetState('processing', approved ? 'APROBANDO...' : 'DENEGANDO...');

    try {
        const res = await fetch('/api/hf/permission', {
            method: 'POST',
            headers: { 'Authorization': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: HF.session.id,
                permissionId: perm.id,
                decision: approved ? 'approve' : 'deny'
            })
        });

        const data = await res.json();

        if (data.success) {
            hfLog(`Permission ${approved ? 'approved' : 'denied'}`);
            hfSpeak(approved ? 'Aprobado.' : 'Denegado.');
            // Wait for Claude to continue (response via SSE)
        } else {
            throw new Error(data.error || 'Error');
        }

    } catch (e) {
        hfLog(`Permission error: ${e.message}`, 'error');
        hfSpeak('Error respondiendo permiso.', () => {
            HF.processingMessage = false;
            if (HF.active) hfStartListening();
        });
    }
}

// ═══════════════════════════════════════════════════════════════════
// SSE CONNECTION
// ═══════════════════════════════════════════════════════════════════

function hfConnectSSE(sessionId) {
    if (HF.sse) {
        HF.sse.close();
        HF.sse = null;
    }
    if (HF.sseWatchdog) {
        clearInterval(HF.sseWatchdog);
        HF.sseWatchdog = null;
    }
    HF.sseReconnecting = false;
    HF.sseLastMessage = Date.now();

    hfLog(`Connecting SSE to ${sessionId}`);
    const sseUrl = `/api/hf/output/${sessionId}?token=${encodeURIComponent(token)}`;
    HF.sse = new EventSource(sseUrl);

    HF.sse.onopen = () => {
        hfLog('SSE connected');
        HF.sseReconnecting = false;
        HF.sseLastMessage = Date.now();
    };

    HF.sse.onmessage = (e) => {
        HF.sseLastMessage = Date.now();
        try {
            const data = JSON.parse(e.data);
            hfHandleSSE(data);
        } catch (err) {
            hfLog(`SSE parse error: ${err}`, 'warn');
        }
    };

    HF.sse.onerror = () => {
        hfLog('SSE error, reconnecting...', 'warn');
        hfTriggerReconnect();
    };

    // Watchdog: Check connection every 20 seconds
    // If no message (including keepalives) for 25 seconds, reconnect
    HF.sseWatchdog = setInterval(() => {
        if (!HF.active || !HF.session) {
            clearInterval(HF.sseWatchdog);
            return;
        }
        const elapsed = Date.now() - HF.sseLastMessage;
        if (elapsed > 25000) {
            hfLog(`SSE watchdog: no message for ${Math.round(elapsed/1000)}s, reconnecting...`, 'warn');
            hfTriggerReconnect();
        }
    }, 20000);
}

function hfTriggerReconnect() {
    if (HF.sseReconnecting) return;
    HF.sseReconnecting = true;

    if (HF.sse) {
        HF.sse.close();
        HF.sse = null;
    }

    // Quick reconnect for mobile stability
    setTimeout(() => {
        if (HF.active && HF.session && HF.sseReconnecting) {
            hfLog('SSE reconnecting...');
            hfConnectSSE(HF.session.id);
        }
    }, 1500);
}

function hfHandleSSE(data) {
    HF.lastActivityTime = Date.now();

    switch (data.type) {
        case 'connected':
            hfLog('Session connected');
            break;

        case 'state':
            if (data.state === 'processing') {
                hfSetState('processing', 'PROCESANDO...');
            } else if (data.state === 'idle' && !HF.speaking) {
                hfSetState('idle', 'LISTO');
            } else if (data.state === 'error') {
                hfSetState('error', data.message || 'ERROR');
            }
            break;

        case 'permission':
            // Claude needs permission
            hfLog('Permission request received');
            hfShowPermission(data.permission);
            break;

        case 'permission_response':
            hfLog(`Permission ${data.decision}`);
            hfSetState('processing', 'PROCESANDO...');
            break;

        case 'assistant':
        case 'assistant_done':
            // Extract text from message (can be string or object with content array)
            let msg = '';
            if (typeof data.message === 'string') {
                msg = data.message;
            } else if (data.message?.content) {
                // Extract text from content array
                msg = data.message.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('');
            } else if (data.message) {
                // Fallback: stringify unknown format
                msg = JSON.stringify(data.message);
            }
            console.log('[HF] Processing', data.type, 'message length:', msg.length);
            $('hf-response').textContent = msg || '(empty response)';

            // Update stats
            if (data.stats) {
                const costEl = $('hf-cost');
                const msgsEl = $('hf-msgs');
                if (costEl) costEl.textContent = (data.stats.cost || 0).toFixed(4);
                if (msgsEl) msgsEl.textContent = data.stats.messages || 0;
            }

            // TTS for final response (only if not already spoken)
            if (data.type === 'assistant_done') {
                // Skip if we already spoke this exact message (prevents duplicate on SSE reconnect)
                if (msg && msg === HF.lastResponse) {
                    console.log('[HF] Skipping duplicate assistant_done (already spoken)');
                    break;
                }

                console.log('[HF] assistant_done received, calling TTS for:', msg.substring(0, 50));
                HF.lastResponse = msg;
                if (msg) {
                    hfSpeakResponse(msg);
                } else {
                    // No message - still need to reset state
                    HF.processingMessage = false;
                    hfSetState('idle', 'LISTO');
                    if (HF.active) hfStartListening();
                }
            }
            break;

        case 'assistant_delta':
            // Streaming text
            const current = $('hf-response').textContent;
            if (current === 'Esperando...' || current === 'Procesando...') {
                $('hf-response').textContent = data.text || '';
            } else {
                $('hf-response').textContent += data.text || '';
            }
            break;

        case 'tool_use':
            hfLog(`Tool: ${data.data?.name}`);
            hfSetState('processing', `TOOL: ${data.data?.name || '...'}`);
            break;

        case 'error':
            hfLog(`Error: ${data.message}`, 'error');
            hfSetState('error', data.message || 'Error');
            HF.processingMessage = false;
            hfSpeak('Error. ' + (data.message || ''), () => {
                if (HF.active) hfStartListening();
            });
            break;

        default:
            // Log unknown for debugging
            if (data.type !== 'system' && data.type !== 'raw') {
                hfLog(`SSE: ${data.type}`);
            }
    }
}

// ═══════════════════════════════════════════════════════════════════
// TEXT-TO-SPEECH
// ═══════════════════════════════════════════════════════════════════

// Said once per hands-free session, so MUTE does not look like a broken mic.
let hfMuteWarned = false;

function hfSpeak(text, callback = null) {
    // ONLY speak if hands-free mode is active
    if (!HF.active || !text || !('speechSynthesis' in window)) {
        if (callback) callback();
        return;
    }
    // The MUTE switch in the header outranks every voice in TSRCT, including
    // this one. Said out loud once per mode, or hands-free would look broken.
    if (window.SessionVoice && window.SessionVoice.isMuted && window.SessionVoice.isMuted()) {
        if (!hfMuteWarned) {
            hfMuteWarned = true;
            if (typeof window.toast === 'function') window.toast('[x] VOICE MUTED - unmute with MUTE in the header', 'info', false);
        }
        if (callback) callback();
        return;
    }

    // Stop recognition while speaking
    hfStopListening();
    speechSynthesis.cancel();

    HF.speaking = true;
    hfSetState('speaking', 'SPEAKING...');

    const utter = new SpeechSynthesisUtterance(text);
    utter.voice = HF.voice;
    utter.lang = HF.voice?.lang || 'es-ES';
    utter.rate = 1.15;
    utter.pitch = 1;
    utter.volume = 1;

    const finish = () => {
        HF.speaking = false;
        if (callback) callback();
    };

    utter.onend = finish;
    utter.onerror = finish;

    speechSynthesis.speak(utter);
}

function hfSpeakResponse(text) {
    if (!text) {
        HF.processingMessage = false;
        if (HF.active) hfStartListening();
        return;
    }

    // Truncate very long responses for TTS
    const maxLength = 500;
    let toSpeak = text.length > maxLength ?
        text.substring(0, maxLength) + '... mensaje truncado.' : text;

    hfSpeak(toSpeak, () => {
        HF.processingMessage = false;
        if (HF.active) {
            setTimeout(() => {
                if (HF.active && !HF.speaking) {
                    hfStartListening();
                }
            }, 300);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════
// WATCHDOG - Auto-recovery
// ═══════════════════════════════════════════════════════════════════

function hfStartWatchdog() {
    hfStopWatchdog();

    HF.watchdogInterval = setInterval(() => {
        if (!HF.active) return;

        const inactiveTime = Date.now() - HF.lastActivityTime;

        // If no activity for 60 seconds and not speaking/processing, try to restart
        if (inactiveTime > 60000 && !HF.speaking && !HF.processingMessage && !HF.listening) {
            hfLog('Watchdog: Restarting recognition...', 'warn');
            hfStartListening();
            HF.lastActivityTime = Date.now();
        }

        // If SSE disconnected for too long, reconnect
        if (inactiveTime > 90000 && HF.session && !HF.sseReconnecting) {
            hfLog('Watchdog: Reconnecting SSE...', 'warn');
            hfConnectSSE(HF.session.id);
        }

    }, 15000); // Check every 15 seconds
}

function hfStopWatchdog() {
    if (HF.watchdogInterval) {
        clearInterval(HF.watchdogInterval);
        HF.watchdogInterval = null;
    }
}

// ═══════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════

function hfSetState(state, statusText) {
    const el = $('hf-immersive');
    if (!el) return;

    el.classList.remove('listening', 'processing', 'speaking', 'error', 'permission');
    if (state !== 'idle') el.classList.add(state);

    const statusEl = $('hf-status');
    if (statusEl) statusEl.textContent = statusText || state.toUpperCase();
}

function hfUpdateTime() {
    if (!HF.active) return;
    const secs = Math.floor((Date.now() - HF.startTime) / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    const timeEl = $('hf-time');
    if (timeEl) timeEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

// Tap orb handler (backup - voice should handle everything)
function hfTapOrb() {
    if (!HF.active) return;

    // If speaking, stop
    if (HF.speaking) {
        speechSynthesis.cancel();
        HF.speaking = false;
        hfSetState('listening', 'LISTENING...');
        hfStartListening();
        return;
    }

    // If has buffer, send it
    if (HF.messageBuffer.trim()) {
        const toSend = HF.messageBuffer.trim();
        HF.messageBuffer = '';
        hfSendMessage(toSend);
        return;
    }

    // Otherwise restart listening
    if (!HF.listening && !HF.processingMessage) {
        hfStartListening();
    }
}

// ═══════════════════════════════════════════════════════════════════
// LEGACY COMPATIBILITY - Button handlers for HTML
// ═══════════════════════════════════════════════════════════════════

// Called from HTML onclick - launches immersive mode
function hfToggle() {
    if (!HF.active) {
        hfEnterImmersive();
    }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS FOR MAIN.JS INTEGRATION
// ═══════════════════════════════════════════════════════════════════

// Called when main terminal receives permission (legacy support)
function hfSpeakPermissionAndListen(p) {
    // If immersive mode is active, handle there
    if (HF.active) {
        hfShowPermission(p);
    }
    // Otherwise ignore - user should use immersive mode
}

// Called when main terminal task completes (legacy support)
function hfSpeakComplete(message) {
    if (HF.active && message) {
        hfSpeak(message);
    }
}

// Called when main terminal has error (legacy support)
function hfSpeakError(error) {
    if (HF.active && error) {
        hfSpeak('Error: ' + error);
    }
}

// Test function for debugging
function hfTest() {
    if (!HF.active) {
        hfEnterImmersive();
    } else {
        hfShowPermission({
            id: 'test-' + Date.now(),
            tool: 'Bash',
            command: 'npm install && npm run build',
            description: 'Test permission'
        });
    }
}

// ── Public API (Phase 3B): used by index.html, main.js, and this file's own
//    onclick HTML; everything else is private to the module ──
Object.assign(window, {
    HF,
    hfInit, hfTapOrb, hfExit, hfEnterImmersive, hfToggleDebug, hfClearDebug,
    hfSpeak, hfSpeakComplete, hfSpeakError, hfSpeakPermissionAndListen,
    hfCloseSetup, hfStartFromSetup, hfSelectProject, hfSelectConversation,
});

})();
