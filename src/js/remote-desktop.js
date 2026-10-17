// ==============================================
// TSRCT - Remote Desktop
// VNC Remote Control via noVNC
// ==============================================

import {
    rdVrActive,
    rdVrCheckAutoRestart,
    rdVrConfirmParam,
    rdVrGoDesktop,
    rdVrGoHub,
    rdVrInsertAtCursor,
    rdVrRecenter,
    rdVrReload,
    rdVrScene,
    rdVrSelectParam,
    rdVrSendBackspace,
    rdVrSendEnter,
    rdVrSetTerminalMode,
    rdVrShowSettings,
    rdVrStop,
    rdVrTap,
    rdVrTesla,
    rdVrToggle,
    rdVrToggle360,
    rdVrToggleLang,
} from './remote-desktop-vr.js';

let RFB = null;
try {
    const mod = await import('https://cdn.jsdelivr.net/gh/novnc/noVNC@v1.5.0/core/rfb.js');
    RFB = mod.default;
} catch (e) {
    console.error('[Remote Desktop] Failed to load noVNC:', e);
}
console.log('[Remote Desktop] Module loaded, RFB:', RFB ? 'OK' : 'FAILED');

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let rdRfb = null;
let rdConnected = false;
let rdReconnectTimer = null;
let rdReconnectAttempts = 0;
let rdToolbarTimer = null;
let rdInitDone = false;
const RD_MAX_RECONNECT = 5;
const RD_RECONNECT_DELAY = 3000;
const RD_TOOLBAR_AUTOHIDE = 4000;
const RD_SETTINGS_KEY = 'tsrct_rd_settings';

const rdModifiers = { ctrl: false, alt: false, shift: false, super: false };
const rdModKeysyms = { ctrl: 0xffe3, alt: 0xffe9, shift: 0xffe1, super: 0xffeb };

// Current VNC cursor position (for click buttons)
let rdLastVncX = 0;
let rdLastVncY = 0;

// Debug log (console only)
function rdLog(msg) {
    console.log('[RD]', msg);
}

// Drag mode: left button held while moving
let rdDragHeld = false;

// Left button held (L button hold)
let rdLeftHeld = false;

// Touch tracking (trackpad-style cursor)
let rdFingerDown = false;
let rdLastFingerX = 0;
let rdLastFingerY = 0;

// Trackpad speed. 1.0 means the cursor tracks the finger exactly 1:1 on screen.
//
// The default is 0.74 because that is what the code did BEFORE the monitor crop:
// rdCacheCanvasRect() measured the canvas ELEMENT box while object-fit:contain
// letterboxed the picture inside it, so a finger pixel moved the cursor only
// 0.74 screen pixels. That was a bug — and it is also the feel Leon had and
// asked to get back, so it becomes the default rather than the accident.
// Measured, not guessed (~/headless-chrome/tsrct-rd-mouse-check.mjs):
//   old 3.0332 fb-px/finger-px x 0.2436 drawn = 0.7389 screen-px/finger-px
//   now 4.1052 fb-px/finger-px x 0.2436 drawn = 1.0000 screen-px/finger-px  (+35.3%)
const RD_SPEED_DEFAULT = 0.74;
let rdPointerSpeed = RD_SPEED_DEFAULT;

// Magnifier
const RD_MAG_SIZE = 140;
const RD_MAG_ZOOM = 3;
let rdMagCtx = null;

// Robust pointer event sender - writes raw RFB PointerEvent (msg type 5)
// Format: [5][mask][x_hi][x_lo][y_hi][y_lo] = 6 bytes
function rdSendPointer(x, y, mask) {
    if (!rdRfb) return false;
    x = Math.round(Math.max(0, x));
    y = Math.round(Math.max(0, y));

    // Try public API first (varies by noVNC version)
    if (typeof rdRfb.sendPointerEvent === 'function') {
        try { rdRfb.sendPointerEvent(x, y, mask); return true; } catch (e) {}
    }

    // Fallback: write raw RFB protocol to internal Websock
    try {
        const sock = rdRfb._sock;
        const buff = sock._sQ;
        const offset = sock._sQlen;
        buff[offset]     = 5;
        buff[offset + 1] = mask;
        buff[offset + 2] = (x >> 8) & 0xFF;
        buff[offset + 3] = x & 0xFF;
        buff[offset + 4] = (y >> 8) & 0xFF;
        buff[offset + 5] = y & 0xFF;
        sock._sQlen += 6;
        sock.flush();
        return true;
    } catch (e) {
        rdLog('ptr err: ' + e.message);
        return false;
    }
}

// Scroll strip
let rdScrolling = false;
let rdScrollStartY = 0;

// Zoom
let rdZoomLevel = 1;
let rdPanX = 0;
let rdPanY = 0;
let rdPinchStartDist = 0;
let rdPinchStartZoom = 1;
let rdPanStartX = 0;
let rdPanStartY = 0;
let rdPanStartTouchX = 0;
let rdPanStartTouchY = 0;
let rdIsPinching = false;
let rdPinchMidX = 0;
let rdPinchMidY = 0;

// Mouse mode: true when mouse is detected, hides touch controls
let rdMouseMode = false;

// Edge swipe detection
let rdEdgeStartX = 0;
let rdEdgeStartY = 0;
let rdEdgeStartTime = 0;
let rdEdgeFired = false;

// Adaptive quality
let rdAdaptiveQuality = true;
let rdIdleTimer = null;
let rdActiveQuality = 3;
let rdIdleQuality = 7;
let rdUserQuality = 6;

// Quick actions
const RD_QUICK_ACTIONS_KEY = 'tsrct_rd_quick_actions';
let rdQuickActions = [];
const RD_DEFAULT_ACTIONS = [
    { name: 'Chrome', icon: 'globe', keys: [{ type: 'combo', keys: ['super'] }, { type: 'text', text: 'chrome' }, { type: 'key', keysym: 0xff0d }] },
    { name: 'Terminal', icon: 'terminal', keys: [{ type: 'combo', keys: ['super'] }, { type: 'text', text: 'cmd' }, { type: 'key', keysym: 0xff0d }] },
    { name: 'Explorer', icon: 'folder', keys: [{ type: 'combo', keys: ['super'] }, { type: 'text', text: 'explorer' }, { type: 'key', keysym: 0xff0d }] },
    { name: 'Lock', icon: 'lock', keys: [{ type: 'raw_combo', keysyms: [0xffeb, 0x006c] }] },
    { name: 'Desktop', icon: 'monitor', keys: [{ type: 'raw_combo', keysyms: [0xffeb, 0x0064] }] },
    { name: 'Task Mgr', icon: 'activity', keys: [{ type: 'raw_combo', keysyms: [0xffe3, 0xffe1, 0xff1b] }] },
    { name: 'Close Win', icon: 'x', keys: [{ type: 'raw_combo', keysyms: [0xffe9, 0xffc1] }] },
    { name: 'Minimize', icon: 'minus', keys: [{ type: 'raw_combo', keysyms: [0xffeb, 0xff54] }] },
    { name: 'Imp Pant', icon: 'camera', keys: [{ type: 'key', keysym: 0xff61 }] },
];

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

function rdInit() {
    rdLog('init RFB=' + !!RFB);
    rdLoadSettings();
    rdLoadQuickActions();
    rdUpdateStatus('offline', 'OFFLINE');
    if (!rdInitDone) {
        rdSetupTouch();
        rdSetupMouse();
        rdSetupScrollStrip();
        rdSetupNativeKeyboard();
        rdInitMagnifier();
        rdInitBackgroundPersistence();
        // The crop is computed against the container size, so it must be
        // recomputed whenever that changes (rotation, keyboard, fullscreen).
        const relayout = () => { if (rdConnected) setTimeout(rdApplyCanvasLayout, 60); };
        window.addEventListener('resize', relayout);
        window.addEventListener('orientationchange', relayout);
        rdInitDone = true;
        rdLog('listeners OK');
    }
    rdRenderQuickActions();
}

// ═══════════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════════

function rdConnect() {
    const host = document.getElementById('rd-host').value || 'localhost';
    const port = document.getElementById('rd-port').value || '5900';
    const password = document.getElementById('rd-password').value || '';

    if (rdReconnectTimer) { clearTimeout(rdReconnectTimer); rdReconnectTimer = null; }
    rdUpdateStatus('connecting', 'CONNECTING');

    const token = localStorage.getItem('cbt') || '';
    fetch('/api/vnc/config', {
        method: 'POST',
        headers: { 'Authorization': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port: parseInt(port), password })
    }).catch(() => {});

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${location.host}/api/vnc/ws?token=${encodeURIComponent(token)}`;

    if (rdRfb) { rdRfb.disconnect(); rdRfb = null; }

    const container = document.getElementById('rd-canvas-container');
    container.innerHTML = '';

    if (!RFB) {
        rdUpdateStatus('offline', 'NO VNC LIB');
        if (typeof toast === 'function') toast('noVNC library failed to load', 'error');
        return;
    }

    try {
        rdRfb = new RFB(container, wsUrl, { credentials: { password } });
        console.log('[RD] RFB created, connecting to', wsUrl);
    } catch (e) {
        console.error('[RD] RFB creation failed:', e);
        rdUpdateStatus('offline', 'ERROR');
        return;
    }

    rdRfb.viewOnly = false;
    // We size the canvas ourselves (rdApplyCanvasLayout) so a single monitor can
    // be cropped out of the framebuffer; noVNC's autoscale would fight the
    // inline width/height it sets.
    rdRfb.scaleViewport = false;
    rdRfb.resizeSession = false;
    rdRfb.qualityLevel = rdAdaptiveQuality ? rdIdleQuality : rdUserQuality;
    // zlib level the VNC SERVER uses for Tight encoding. This was 2 -- nearly
    // raw -- which is the right pick on a LAN and the wrong one on mobile data.
    // 6 sends materially less for a modest cost in CPU on the Windows side
    // (not WSL). Drop it back toward 2 if the laptop starts running hot.
    rdRfb.compressionLevel = 6;
    rdRfb.showDotCursor = true;

    rdRfb.addEventListener('connect', rdOnConnect);
    rdRfb.addEventListener('disconnect', rdOnDisconnect);
    rdRfb.addEventListener('credentialsrequired', rdOnCredentials);
    rdRfb.addEventListener('clipboard', rdOnClipboard);
    rdRfb.addEventListener('desktopname', rdOnDesktopName);

    rdShowConnectedUI();
    rdSaveSettings();
}

function rdDisconnect() {
    if (rdReconnectTimer) { clearTimeout(rdReconnectTimer); rdReconnectTimer = null; }
    rdReconnectAttempts = 0;
    if (rdRfb) { rdRfb.disconnect(); rdRfb = null; }
    rdConnected = false;
    rdDragHeld = false;
    rdLeftHeld = false;
    rdFingerDown = false;
    rdMouseMode = false;
    const room = document.getElementById('remote-room');
    if (room) room.classList.remove('rd-mouse-mode');
    rdHideMagnifier();
    rdSetKeyboardActive(false);
    // Stop VNC dictation
    if (rdVncWantRecording) { rdVncWantRecording = false; if (rdVncRecognition) try { rdVncRecognition.abort(); } catch(e) {} rdVncDictateUpdateBtn(); }
    rdUnlockOrientation();
    rdResetModifiers();
    rdResetZoom();
    rdAudioStop();
    if (rdVrActive) rdVrStop();
    rdCleanupBackgroundPersistence();
    rdShowDisconnectedUI();
    rdUpdateStatus('offline', 'OFFLINE');
}

function rdReconnect() {
    if (rdReconnectAttempts >= RD_MAX_RECONNECT) { rdUpdateStatus('offline', 'FAILED'); rdShowDisconnectedUI(); return; }
    rdReconnectAttempts++;
    rdUpdateStatus('connecting', `RETRY ${rdReconnectAttempts}/${RD_MAX_RECONNECT}`);
    rdReconnectTimer = setTimeout(() => rdConnect(), RD_RECONNECT_DELAY);
}

function rdOnConnect() {
    rdConnected = true;
    rdReconnectAttempts = 0;
    rdUpdateStatus('connected', 'CONNECTED');
    try { rdLastVncX = Math.round(rdRfb._fbWidth / 2); rdLastVncY = Math.round(rdRfb._fbHeight / 2); } catch(e) {}

    rdLog('connected, pointer via sendPointerEvent');

    // Force landscape on mobile
    rdLockLandscape();

    setTimeout(() => rdFitToScreen(), 100);
    rdLoadMonitors();
    rdStartBackgroundKeepAlive();
    if (typeof playSound === 'function') playSound('accept');
    if (typeof toast === 'function') toast('Connected', 'success');
}

function rdOnDisconnect(e) {
    rdConnected = false; rdRfb = null; rdResetModifiers();
    if (e.detail && e.detail.clean === false) rdReconnect();
    else { rdCleanupBackgroundPersistence(); rdShowDisconnectedUI(); rdUpdateStatus('offline', 'DISCONNECTED'); }
}

function rdOnCredentials() {
    const pw = document.getElementById('rd-password').value;
    if (rdRfb && pw) rdRfb.sendCredentials({ password: pw });
    else { rdDisconnect(); if (typeof toast === 'function') toast('VNC password required', 'error'); }
}

function rdOnClipboard(e) { if (e.detail?.text) { const el = document.getElementById('rd-clipboard-text'); if (el) el.value = e.detail.text; } }
function rdOnDesktopName(e) { if (e.detail?.name) rdUpdateStatus('connected', e.detail.name); }

// ═══════════════════════════════════════════════════════════════════
// TOUCH ENGINE v2 - Trackpad Cursor + Magnifier
//
// Intercepts ALL touch on the canvas (capture phase, blocks noVNC).
// Single finger = trackpad-style relative cursor movement.
// Magnifier lens shows zoomed view around cursor while touching.
// Click strip buttons (L/R/2x/Drag) act at cursor position.
// ═══════════════════════════════════════════════════════════════════

// Touch performance cache (module scope for shared access)
let rdMoveRAF = null;
let rdCachedRect = null;
let rdCachedFbW = 0;
let rdCachedFbH = 0;
let rdCachedScaleX = 1;
let rdCachedScaleY = 1;
let rdRectCacheTime = 0;

function rdCacheCanvasRect() {
    const now = performance.now();
    if (now - rdRectCacheTime < 500 && rdCachedRect) return true;
    const canvas = rdFindCanvas();
    if (!canvas || !rdRfb) return false;
    // Self-heal: noVNC rewrites the canvas style whenever the framebuffer
    // resizes (remote resolution change / monitor hot-plug), which would drop
    // our crop layout. Re-apply before measuring so the mapping stays exact.
    const fbNowW = rdRfb._fbWidth || canvas.width;
    const fbNowH = rdRfb._fbHeight || canvas.height;
    if (rdCachedFbW && (fbNowW !== rdCachedFbW || fbNowH !== rdCachedFbH)) rdApplyCanvasLayout();
    rdCachedRect = canvas.getBoundingClientRect();
    rdCachedFbW = rdRfb._fbWidth || canvas.width;
    rdCachedFbH = rdRfb._fbHeight || canvas.height;
    rdCachedScaleX = rdCachedFbW / rdCachedRect.width;
    rdCachedScaleY = rdCachedFbH / rdCachedRect.height;
    rdRectCacheTime = now;
    return true;
}

function rdSetupTouch() {
    const wrap = document.getElementById('rd-canvas-wrap');
    if (!wrap) return;

    rdLog('Touch v2: trackpad + magnifier');

    // Capture phase - intercept BEFORE noVNC sees touch events
    wrap.addEventListener('touchstart', (e) => {
        if (!rdConnected) return;

        // Re-enter fullscreen + landscape after returning from background
        rdRelockOnTouch();

        // Don't intercept touches on controls inside the wrap
        if (e.target.closest('.rd-toolbar-toggle, .rd-native-keyboard, .rd-terminal-overlay, .rd-keyboard-panel, .rd-nexus-pip, .rd-edge-zone')) return;

        // --- Pinch-to-zoom: 2 fingers ---
        if (e.targetTouches.length === 2) {
            e.stopPropagation();
            e.preventDefault();
            rdFingerDown = false;
            rdHideMagnifier();
            rdHideCursorDot();
            rdIsPinching = true;
            const t0 = e.targetTouches[0], t1 = e.targetTouches[1];
            rdPinchStartDist = rdTouchDist(t0, t1);
            rdPinchStartZoom = rdZoomLevel;
            // Store midpoint for zoom origin
            rdPinchMidX = (t0.clientX + t1.clientX) / 2;
            rdPinchMidY = (t0.clientY + t1.clientY) / 2;
            rdPanStartX = rdPanX;
            rdPanStartY = rdPanY;
            rdPanStartTouchX = rdPinchMidX;
            rdPanStartTouchY = rdPinchMidY;
            return;
        }

        if (e.targetTouches.length === 1 && !rdIsPinching) {
            e.stopPropagation();
            e.preventDefault();

            rdFingerDown = true;
            const t = e.targetTouches[0];
            rdLastFingerX = t.clientX;
            rdLastFingerY = t.clientY;

            // Edge swipe detection - store start position
            rdEdgeStartX = t.clientX;
            rdEdgeStartY = t.clientY;
            rdEdgeStartTime = performance.now();
            rdEdgeFired = false;

            // Send hover at current cursor pos (don't jump on first touch)
            rdSendPointer(rdLastVncX, rdLastVncY, (rdDragHeld || rdLeftHeld) ? 1 : 0);

            rdBlurIfInactive();
            rdAutoSideStrip(t.clientX);
            rdShowMagnifier(t.clientX, t.clientY);
            rdShowCursorDot();
            rdOnInteraction();
        }

        if (e.touches.length === 3) rdShowToolbar();
    }, { capture: true, passive: false });

    wrap.addEventListener('touchmove', (e) => {
        if (!rdConnected) return;
        if (e.target.closest('.rd-toolbar-toggle, .rd-native-keyboard, .rd-keyboard-panel, .rd-nexus-pip, .rd-edge-zone')) return;

        // --- Pinch-to-zoom move ---
        if (rdIsPinching && e.targetTouches.length === 2) {
            e.stopPropagation();
            e.preventDefault();
            const t0 = e.targetTouches[0], t1 = e.targetTouches[1];
            const dist = rdTouchDist(t0, t1);
            const midX = (t0.clientX + t1.clientX) / 2;
            const midY = (t0.clientY + t1.clientY) / 2;
            // Zoom centered on current midpoint
            const newZoom = Math.max(1, Math.min(5, rdPinchStartZoom * (dist / rdPinchStartDist)));
            rdSetZoom(newZoom, midX, midY);
            // Pan follows midpoint drift
            const panDx = midX - rdPanStartTouchX;
            const panDy = midY - rdPanStartTouchY;
            rdPanX = rdPanStartX + panDx;
            rdPanY = rdPanStartY + panDy;
            rdClampPan();
            rdApplyTransform();
            rdOnInteraction();
            return;
        }

        if (!rdFingerDown) return;

        if (e.targetTouches.length === 1 && !rdIsPinching) {
            e.stopPropagation();
            e.preventDefault();

            const t = e.targetTouches[0];

            // Edge swipe detection
            if (!rdEdgeFired) {
                const dx = t.clientX - rdEdgeStartX;
                const dy = t.clientY - rdEdgeStartY;
                const elapsed = performance.now() - rdEdgeStartTime;
                if (elapsed < 400 && Math.abs(dx) > 50) {
                    const sw = window.innerWidth;
                    // Left edge swipe (start < 25px from left, swipe right)
                    if (rdEdgeStartX < 25 && dx > 50) {
                        rdEdgeFired = true;
                        rdEdgeAction('left');
                        return;
                    }
                    // Right edge swipe (start < 25px from right, swipe left)
                    if (rdEdgeStartX > sw - 25 && dx < -50) {
                        rdEdgeFired = true;
                        rdEdgeAction('right');
                        return;
                    }
                }
                if (elapsed < 400 && dy < -60) {
                    const sh = window.innerHeight;
                    // Bottom edge swipe (start in bottom 30px, swipe up)
                    if (rdEdgeStartY > sh - 30) {
                        rdEdgeFired = true;
                        rdEdgeAction('bottom');
                        return;
                    }
                }
            }

            const dx = t.clientX - rdLastFingerX;
            const dy = t.clientY - rdLastFingerY;
            rdLastFingerX = t.clientX;
            rdLastFingerY = t.clientY;

            // If zoomed in, pan instead of moving cursor
            if (rdZoomLevel > 1.05) {
                rdPanX += dx;
                rdPanY += dy;
                rdClampPan();
                rdApplyTransform();
                rdOnInteraction();
                return;
            }

            // Update VNC coords + send pointer immediately (low cost)
            if (rdCacheCanvasRect()) {
                rdLastVncX = Math.max(0, Math.min(rdCachedFbW - 1, rdLastVncX + dx * rdCachedScaleX * rdPointerSpeed));
                rdLastVncY = Math.max(0, Math.min(rdCachedFbH - 1, rdLastVncY + dy * rdCachedScaleY * rdPointerSpeed));
                rdSendPointer(Math.round(rdLastVncX), Math.round(rdLastVncY), (rdDragHeld || rdLeftHeld) ? 1 : 0);
            }

            // Throttle expensive visual updates to animation frame
            if (!rdMoveRAF) {
                const fx = t.clientX, fy = t.clientY;
                rdMoveRAF = requestAnimationFrame(() => {
                    rdUpdateMagnifier(fx, fy);
                    rdShowCursorDot();
                    rdMoveRAF = null;
                });
            }
        }
    }, { capture: true, passive: false });

    wrap.addEventListener('touchend', (e) => {
        if (e.targetTouches.length === 0) {
            if (rdIsPinching) { rdIsPinching = false; return; }
            rdFingerDown = false;
            rdHideMagnifier();
            rdHideCursorDot();
            rdRefocusKeyboard();
        }
        // Transition from 2 fingers to 1 — don't start cursor move
        if (e.targetTouches.length === 1 && rdIsPinching) {
            rdIsPinching = false;
        }
    }, { capture: true, passive: false });

    wrap.addEventListener('touchcancel', () => {
        rdFingerDown = false;
        rdIsPinching = false;
        rdHideMagnifier();
        rdHideCursorDot();
    }, { capture: true, passive: false });
}

function rdTouchDist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }

// ═══════════════════════════════════════════════════════════════════
// MOUSE MODE - Auto-detect mouse, hide touch controls, let noVNC handle natively
// ═══════════════════════════════════════════════════════════════════

function rdSetupMouse() {
    const wrap = document.getElementById('rd-canvas-wrap');
    if (!wrap) return;

    // Detect mouse: any mousemove with no touch origin switches to mouse mode
    wrap.addEventListener('mousemove', (e) => {
        if (!rdConnected || rdMouseMode) return;
        // Ignore synthetic mouse events from touch (sourceCapabilities check)
        if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
        rdEnterMouseMode();
    });

    // Detect touch: any touch switches back to touch mode
    wrap.addEventListener('touchstart', () => {
        if (!rdConnected || !rdMouseMode) return;
        rdExitMouseMode();
    }, { capture: false, passive: true });

    // Block context menu on canvas so right-click goes to VNC
    wrap.addEventListener('contextmenu', (e) => {
        if (rdMouseMode && rdConnected) e.preventDefault();
    });

    // Mouse wheel scroll - noVNC handles this natively, but track activity
    wrap.addEventListener('wheel', () => {
        if (rdConnected) rdOnInteraction();
    }, { passive: true });
}

function rdEnterMouseMode() {
    if (rdMouseMode) return;
    rdMouseMode = true;
    rdLog('mouse mode ON');

    // Hide touch-specific controls
    const strip = document.getElementById('rd-click-strip');
    const scroll = document.getElementById('rd-scroll-bar');
    if (strip) strip.classList.remove('visible');
    if (scroll) scroll.style.display = 'none';
    rdHideMagnifier();
    rdHideCursorDot();

    // Release any held touch state
    rdFingerDown = false;
    rdDragHeld = false;
    rdLeftHeld = false;
    const dragBtn = document.getElementById('rd-drag-btn');
    if (dragBtn) dragBtn.classList.remove('active');

    // Add mouse-mode class for CSS adjustments
    const room = document.getElementById('remote-room');
    if (room) room.classList.add('rd-mouse-mode');
}

function rdExitMouseMode() {
    if (!rdMouseMode) return;
    rdMouseMode = false;
    rdLog('mouse mode OFF (touch detected)');

    // Restore touch controls
    if (rdConnected) {
        const strip = document.getElementById('rd-click-strip');
        const scroll = document.getElementById('rd-scroll-bar');
        if (strip) strip.classList.add('visible');
        if (scroll) scroll.style.display = 'flex';
    }

    const room = document.getElementById('remote-room');
    if (room) room.classList.remove('rd-mouse-mode');
}

// Cache the canvas reference once found
let rdCanvasEl = null;

function rdFindCanvas() {
    if (rdCanvasEl && rdCanvasEl.isConnected) return rdCanvasEl;

    // Method 1: noVNC internal
    if (rdRfb && rdRfb._canvas) {
        rdCanvasEl = rdRfb._canvas;
        rdLog('canvas: rfb._canvas');
        return rdCanvasEl;
    }

    // Method 2: search inside our container
    let c = document.getElementById('rd-canvas-container')?.querySelector('canvas');
    if (c) { rdCanvasEl = c; rdLog('canvas: container>canvas'); return c; }

    // Method 3: search inside wrap
    c = document.getElementById('rd-canvas-wrap')?.querySelector('canvas');
    if (c) { rdCanvasEl = c; rdLog('canvas: wrap>canvas'); return c; }

    // Method 4: any canvas in the room
    c = document.querySelector('#remote-room canvas');
    if (c) { rdCanvasEl = c; rdLog('canvas: room>canvas'); return c; }

    // Method 5: any canvas on the page
    const all = document.querySelectorAll('canvas');
    rdLog('canvas: NOT FOUND. Total canvases on page: ' + all.length);
    if (all.length > 0) {
        // Use the last canvas (likely noVNC's)
        rdCanvasEl = all[all.length - 1];
        rdLog('canvas: fallback last canvas ' + rdCanvasEl.width + 'x' + rdCanvasEl.height);
        return rdCanvasEl;
    }

    // Debug: what's in the container?
    const cont = document.getElementById('rd-canvas-container');
    if (cont) rdLog('container HTML: ' + cont.innerHTML.substring(0, 100));

    return null;
}

function rdScreenToVNC(sx, sy) {
    if (!rdRfb) return null;

    const c = rdFindCanvas();
    if (!c) return null;

    const r = c.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;

    const fbW = rdRfb._fbWidth || c.width;
    const fbH = rdRfb._fbHeight || c.height;

    return {
        x: Math.max(0, Math.min(fbW, Math.round((sx - r.left) * (fbW / r.width)))),
        y: Math.max(0, Math.min(fbH, Math.round((sy - r.top) * (fbH / r.height))))
    };
}

// ═══════════════════════════════════════════════════════════════════
// MAGNIFIER - zoomed lens showing area around cursor
// ═══════════════════════════════════════════════════════════════════

function rdInitMagnifier() {
    const magCanvas = document.getElementById('rd-magnifier-canvas');
    if (magCanvas) {
        magCanvas.width = RD_MAG_SIZE;
        magCanvas.height = RD_MAG_SIZE;
        rdMagCtx = magCanvas.getContext('2d');
    }
}

function rdShowMagnifier(fingerX, fingerY) {
    const mag = document.getElementById('rd-magnifier');
    if (!mag) return;
    mag.classList.add('visible');
    rdUpdateMagnifier(fingerX, fingerY);
}

let rdMagEl = null;

function rdUpdateMagnifier(fingerX, fingerY) {
    if (!rdMagEl) rdMagEl = document.getElementById('rd-magnifier');
    if (!rdMagEl || !rdMagCtx) return;
    if (!rdBodyEl) rdBodyEl = document.getElementById('rd-body');
    if (!rdBodyEl || !rdBodyRect) return;

    let magX = fingerX - rdBodyRect.left;
    let magY = fingerY - rdBodyRect.top - RD_MAG_SIZE - 30;
    if (magY < 0) magY = fingerY - rdBodyRect.top + 50;
    magX = Math.max(RD_MAG_SIZE / 2 + 4, Math.min(rdBodyRect.width - RD_MAG_SIZE / 2 - 4, magX));

    rdMagEl.style.left = magX + 'px';
    rdMagEl.style.top = magY + 'px';

    // Draw zoomed region from VNC canvas
    const vncCanvas = rdFindCanvas();
    if (!vncCanvas) return;

    const sourceRadius = RD_MAG_SIZE / (2 * RD_MAG_ZOOM);
    const sx = rdLastVncX - sourceRadius;
    const sy = rdLastVncY - sourceRadius;
    const sSize = sourceRadius * 2;

    try {
        rdMagCtx.clearRect(0, 0, RD_MAG_SIZE, RD_MAG_SIZE);
        rdMagCtx.drawImage(vncCanvas, sx, sy, sSize, sSize, 0, 0, RD_MAG_SIZE, RD_MAG_SIZE);
    } catch (e) {}
}

function rdHideMagnifier() {
    const mag = document.getElementById('rd-magnifier');
    if (mag) mag.classList.remove('visible');
}

// ═══════════════════════════════════════════════════════════════════
// CURSOR DOT - shows cursor position on main canvas view
// ═══════════════════════════════════════════════════════════════════

let rdDotEl = null;
let rdBodyEl = null;
let rdBodyRect = null;
let rdBodyRectTime = 0;

function rdShowCursorDot() {
    if (!rdDotEl) rdDotEl = document.getElementById('rd-cursor-dot');
    if (!rdDotEl || !rdConnected || !rdCachedRect) return;

    if (!rdBodyEl) rdBodyEl = document.getElementById('rd-body');
    if (!rdBodyEl) return;

    const now = performance.now();
    if (!rdBodyRect || now - rdBodyRectTime > 500) {
        rdBodyRect = rdBodyEl.getBoundingClientRect();
        rdBodyRectTime = now;
    }

    const screenX = rdCachedRect.left + (rdLastVncX / rdCachedFbW) * rdCachedRect.width - rdBodyRect.left;
    const screenY = rdCachedRect.top + (rdLastVncY / rdCachedFbH) * rdCachedRect.height - rdBodyRect.top;

    rdDotEl.style.left = screenX + 'px';
    rdDotEl.style.top = screenY + 'px';
    rdDotEl.classList.add('visible');
}

function rdHideCursorDot() {
    if (!rdDotEl) rdDotEl = document.getElementById('rd-cursor-dot');
    if (rdDotEl) rdDotEl.classList.remove('visible');
}

// ═══════════════════════════════════════════════════════════════════
// CLICK STRIP ACTIONS
// These run at rdLastVncX/rdLastVncY - wherever the cursor is.
// ═══════════════════════════════════════════════════════════════════

function rdClickDown() {
    rdLeftHeld = true;
    const x = Math.round(rdLastVncX), y = Math.round(rdLastVncY);
    rdLog('L dn ' + x + ',' + y);
    rdSendPointer(x, y, 1);
    if (navigator.vibrate) navigator.vibrate(10);
    const btn = document.getElementById('rd-left-btn');
    if (btn) btn.classList.add('active');
}

function rdClickUp() {
    if (!rdLeftHeld) return;
    rdLeftHeld = false;
    const x = Math.round(rdLastVncX), y = Math.round(rdLastVncY);
    rdLog('L up');
    rdSendPointer(x, y, 0);
    const btn = document.getElementById('rd-left-btn');
    if (btn) btn.classList.remove('active');
}

function rdClickAtCursor() {
    rdClickDown();
    setTimeout(() => rdClickUp(), 80);
}

function rdDoubleClickAtCursor() {
    const x = Math.round(rdLastVncX), y = Math.round(rdLastVncY);
    rdSendPointer(x, y, 1);
    rdSendPointer(x, y, 0);
    setTimeout(() => {
        rdSendPointer(x, y, 1);
        rdSendPointer(x, y, 0);
    }, 50);
    if (navigator.vibrate) navigator.vibrate([10, 30, 10]);
}

function rdRightClickAtCursor() {
    const x = Math.round(rdLastVncX), y = Math.round(rdLastVncY);
    rdSendPointer(x, y, 4);
    setTimeout(() => rdSendPointer(x, y, 0), 60);
    if (navigator.vibrate) navigator.vibrate(20);
}

function rdToggleDrag() {
    if (!rdRfb) return;
    rdDragHeld = !rdDragHeld;
    const btn = document.getElementById('rd-drag-btn');
    if (btn) btn.classList.toggle('active', rdDragHeld);

    const x = Math.round(rdLastVncX), y = Math.round(rdLastVncY);
    if (rdDragHeld) {
        rdSendPointer(x, y, 1);
        if (typeof toast === 'function') toast('Drag ON', 'info');
    } else {
        rdSendPointer(x, y, 0);
        if (typeof toast === 'function') toast('Drag OFF', 'info');
    }
}

// ═══════════════════════════════════════════════════════════════════
// SCROLL STRIP
// ═══════════════════════════════════════════════════════════════════

function rdSetupScrollStrip() {
    const bar = document.getElementById('rd-scroll-bar');
    if (!bar) return;

    bar.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        rdScrolling = true;
        rdScrollStartY = e.touches[0].clientY;
    }, { passive: false });

    let rdScrollQueue = 0;
    let rdScrollBusy = false;

    function rdProcessScroll() {
        if (rdScrollQueue === 0 || !rdRfb) { rdScrollBusy = false; return; }
        rdScrollBusy = true;
        const x = Math.round(rdLastVncX), y = Math.round(rdLastVncY);
        const mask = rdScrollQueue > 0 ? 8 : 16;
        rdScrollQueue += (rdScrollQueue > 0) ? -1 : 1;
        rdSendPointer(x, y, mask);
        setTimeout(() => {
            rdSendPointer(x, y, 0);
            setTimeout(rdProcessScroll, 30);
        }, 40);
    }

    bar.addEventListener('touchmove', (e) => {
        if (!rdScrolling || !rdRfb) return;
        e.preventDefault();
        e.stopPropagation();
        const dy = rdScrollStartY - e.touches[0].clientY;
        if (Math.abs(dy) >= 12) {
            const ticks = Math.floor(Math.abs(dy) / 12);
            rdScrollQueue += (dy > 0 ? 1 : -1) * Math.min(ticks, 3);
            rdScrollQueue = Math.max(-10, Math.min(10, rdScrollQueue));
            rdScrollStartY = e.touches[0].clientY;
            rdLog('scroll ' + (dy > 0 ? 'up' : 'dn') + ' q=' + rdScrollQueue);
            if (!rdScrollBusy) rdProcessScroll();
        }
    }, { passive: false });

    bar.addEventListener('touchend', (e) => { rdScrolling = false; e.stopPropagation(); }, { passive: false });
    bar.addEventListener('touchcancel', () => { rdScrolling = false; });
}

// ═══════════════════════════════════════════════════════════════════
// EDGE SWIPE PANELS
// ═══════════════════════════════════════════════════════════════════

function rdEdgeAction(edge) {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(15);
    if (edge === 'left') {
        // Quick actions
        rdToggleQuickActions();
        rdResetToolbarTimer();
    } else if (edge === 'right') {
        // Clipboard
        rdToggleClipboard();
        rdResetToolbarTimer();
    } else if (edge === 'bottom') {
        // Keyboard
        rdToggleNativeKeyboard();
    }
}

// ═══════════════════════════════════════════════════════════════════
// MONITOR SELECTION - crop the framebuffer to ONE physical screen
// ═══════════════════════════════════════════════════════════════════
//
// VNC serves the WHOLE virtual desktop as one framebuffer and TightVNC has no
// per-monitor mode, so viewing a single screen means cropping client-side.
//
// The trick that keeps input correct: the canvas element always carries the
// FULL framebuffer (scaled), and we just translate it so the wanted monitor
// lands inside the container while the rest overflows and is clipped by
// .rd-canvas-wrap's overflow:hidden. Because the element box still maps 1:1 to
// the framebuffer, rdScreenToVNC()/rdCacheCanvasRect() keep working untouched.
// (It also FIXES their latent letterbox bug: they assumed the image filled the
// element box, which object-fit:contain broke whenever aspects differed.)

let rdMonitors = [];         // [{name,label,primary,x,y,w,h}] sorted by display number
let rdVirtualBounds = null;  // {x,y,w,h} bounding box of the virtual desktop
let rdMonitorIndex = -1;     // -1 = whole desktop, else index into rdMonitors
let rdSolo = false;          // server-owned: did WE collapse the desktop to one screen?
let rdSoloBusy = false;

async function rdLoadMonitors() {
    try {
        const token = localStorage.getItem('cbt') || '';
        const r = await fetch('/api/vnc/monitors', { headers: { 'Authorization': token } });
        const d = await r.json();
        rdMonitors = Array.isArray(d.screens) ? d.screens : [];
        rdVirtualBounds = d.virtual || null;
        rdMonitorIndex = Number.isInteger(d.selected) ? d.selected : -1;
        if (rdMonitorIndex >= rdMonitors.length) rdMonitorIndex = -1;
        rdSolo = !!d.solo;
        rdLog('monitors: ' + rdMonitors.length + ' selected=' + rdMonitorIndex + (rdSolo ? ' SOLO' : ''));
    } catch (e) {
        rdLog('monitors failed: ' + e.message);
    }
    rdUpdateMonitorBtn();
    rdApplyCanvasLayout();
}

// Rect of the current selection in FRAMEBUFFER pixels.
function rdCropRect() {
    if (!rdRfb) return null;
    const fbW = rdRfb._fbWidth, fbH = rdRfb._fbHeight;
    if (!fbW || !fbH) return null;

    const whole = { x: 0, y: 0, w: fbW, h: fbH };
    const s = rdMonitors[rdMonitorIndex];
    if (rdMonitorIndex < 0 || !s || !rdVirtualBounds || !rdVirtualBounds.w) return whole;

    // The framebuffer IS the virtual desktop, but not necessarily at 1:1 pixel
    // scale (DPI scaling), so convert through a ratio instead of assuming it.
    const kx = fbW / rdVirtualBounds.w;
    const ky = fbH / rdVirtualBounds.h;
    const x = Math.round((s.x - rdVirtualBounds.x) * kx);
    const y = Math.round((s.y - rdVirtualBounds.y) * ky);
    const w = Math.round(s.w * kx);
    const h = Math.round(s.h * ky);

    // A stale layout (monitor unplugged, resolution changed) must degrade to the
    // whole desktop, never to an empty or off-framebuffer crop.
    if (w < 16 || h < 16 || x >= fbW || y >= fbH || x + w <= 0 || y + h <= 0) return whole;

    const cx = Math.max(0, x), cy = Math.max(0, y);
    return { x: cx, y: cy, w: Math.min(w, fbW - cx), h: Math.min(h, fbH - cy) };
}

let rdLayoutRetries = 0;

function rdApplyCanvasLayout() {
    const container = document.getElementById('rd-canvas-container');
    const canvas = rdFindCanvas();
    const fbW = rdRfb && rdRfb._fbWidth, fbH = rdRfb && rdRfb._fbHeight;
    const cw = container ? container.clientWidth : 0;
    const ch = container ? container.clientHeight : 0;
    const crop = (container && canvas && fbW && fbH) ? rdCropRect() : null;

    // The room may not be laid out yet on the first connect (wrap still
    // display:none, canvas not attached). Retry briefly rather than silently
    // leaving the crop unapplied until the next touch.
    if (!crop || !cw || !ch) {
        if (rdConnected && rdLayoutRetries < 20) {
            rdLayoutRetries++;
            setTimeout(rdApplyCanvasLayout, 150);
        }
        return;
    }
    rdLayoutRetries = 0;

    // Scale so the CROP fills the container; the canvas keeps the full
    // framebuffer at that scale and everything outside the crop overflows.
    const k = Math.min(cw / crop.w, ch / crop.h);
    canvas.style.position = 'absolute';
    canvas.style.width = (fbW * k) + 'px';
    canvas.style.height = (fbH * k) + 'px';
    canvas.style.maxWidth = 'none';
    canvas.style.maxHeight = 'none';
    canvas.style.objectFit = 'fill';
    canvas.style.left = ((cw - crop.w * k) / 2 - crop.x * k) + 'px';
    canvas.style.top = ((ch - crop.h * k) / 2 - crop.y * k) + 'px';

    // Clip to the CROP, not to the container. `.rd-canvas-wrap`'s overflow:hidden
    // only cuts at the CONTAINER edge, so whenever the crop's aspect differs from
    // the container's, the centring leaves a band inside the container that gets
    // filled with the NEIGHBOURING monitor instead of black. Measured on Leon's
    // layout (monitor 1 = 2560x1601 of a 5440x2172 framebuffer, landscape phone):
    // a 110px strip of monitor 2's right edge, ~13% of the screen.
    // clip-path does NOT change layout geometry, so getBoundingClientRect() still
    // returns the full element box and rdScreenToVNC()/rdCacheCanvasRect() keep
    // mapping against the whole framebuffer exactly as before.
    const clipT = Math.max(0, crop.y * k);
    const clipL = Math.max(0, crop.x * k);
    const clipR = Math.max(0, (fbW - crop.x - crop.w) * k);
    const clipB = Math.max(0, (fbH - crop.y - crop.h) * k);
    canvas.style.clipPath = (clipT || clipR || clipB || clipL)
        ? `inset(${clipT}px ${clipR}px ${clipB}px ${clipL}px)`
        : 'none';

    rdRectCacheTime = 0; // force the pointer-mapping cache to re-read
}

function rdMonitorLabel() {
    if (rdMonitorIndex < 0 || !rdMonitors[rdMonitorIndex]) return '*';
    return rdMonitors[rdMonitorIndex].label;
}

function rdUpdateMonitorBtn() {
    const b = document.getElementById('rd-mon-badge');
    if (b) b.textContent = rdMonitorLabel();
    const btn = document.getElementById('rd-monitor-btn');
    if (btn) {
        btn.classList.toggle('active', rdMonitorIndex >= 0);
        btn.title = rdMonitorIndex < 0 ? 'Screen: all monitors'
            : 'Screen: monitor ' + rdMonitorLabel();
    }
    // Only offer "pull window here" when there IS a here and an elsewhere.
    const pull = document.getElementById('rd-pull-btn');
    if (pull) {
        const usable = rdMonitors.length >= 2 && rdMonitorIndex >= 0;
        pull.style.display = usable ? '' : 'none';
        if (usable) pull.title = 'Pull focused window to monitor ' + rdMonitorLabel();
    }
    // SOLO is offered when there is a second screen to drop, and stays offered
    // while we are collapsed so there is always a way back.
    const solo = document.getElementById('rd-solo-btn');
    if (solo) {
        solo.style.display = (rdMonitors.length >= 2 || rdSolo) ? '' : 'none';
        solo.classList.toggle('active', rdSolo);
        solo.title = rdSolo ? 'Restore both screens'
            : 'Use only this screen (turns the other one off)';
    }
}

// Collapse Windows onto the single screen being watched, or put both back.
//
// This is the only lever that shrinks the FRAMEBUFFER: the monitor crop is
// cosmetic, so the phone still paints a canvas the size of the whole virtual
// desktop either way. It also drags every window onto the visible screen, which
// is the other half of why it exists.
//
// The server tries a mode and VERIFIES the result, reverting to extended if it
// cannot land on the screen we asked to keep — so a failure here gives you your
// desktop back rather than a machine showing the screen you cannot see.
async function rdToggleSolo() {
    if (rdSoloBusy) return;
    if (!rdSolo && rdMonitors.length < 2) {
        if (typeof toast === 'function') toast('Only one screen attached', 'error');
        return;
    }
    const goingSolo = !rdSolo;
    rdSoloBusy = true;
    const btn = document.getElementById('rd-solo-btn');
    if (btn) btn.classList.add('working');
    if (typeof toast === 'function') {
        toast(goingSolo ? 'Collapsing to this screen...' : 'Restoring both screens...', 'success', false);
    }

    try {
        const token = localStorage.getItem('cbt') || '';
        const r = await fetch('/api/vnc/display', {
            method: 'POST',
            headers: { 'Authorization': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: goingSolo ? 'solo' : 'extend', keep: rdMonitorLabel() })
        });
        const d = await r.json();
        if (typeof toast === 'function') {
            if (!d.success) {
                // Say what actually happened — "failed" sends you hunting.
                toast(d.error || 'Display switch failed', 'error');
            } else if (!goingSolo) {
                toast('Both screens back', 'success');
            } else if (d.alreadySingle) {
                toast('Already a single screen', 'success');
            } else if (d.ambiguous) {
                toast('Single screen - identical panels, check it kept the right one', 'success');
            } else {
                toast('Solo: monitor ' + d.kept, 'success');
            }
        }
    } catch (e) {
        if (typeof toast === 'function') toast('Display switch failed: ' + e.message, 'error');
    }

    rdSoloBusy = false;
    if (btn) btn.classList.remove('working');
    // The framebuffer just changed size. Re-read the layout rather than assuming
    // what it became, and re-apply once more after noVNC has processed its own
    // resize (which rewrites the canvas style out from under our crop).
    await rdLoadMonitors();
    setTimeout(rdApplyCanvasLayout, 500);
}

// Move the FOCUSED window onto the monitor currently on screen.
//
// This is why the drag-detection idea is not needed: Windows already moves the
// focused window between displays with Win+Shift+Left/Right. The only thing to
// work out is which way "here" is, and the monitor rects answer that — if any
// other screen sits to our LEFT, the window has to travel RIGHT to reach us.
// (Windows does not wrap at the outer edge, so the direction has to be right.)
function rdPullWindowHere() {
    if (!rdRfb) return;
    if (rdMonitorIndex < 0 || rdMonitors.length < 2) {
        if (typeof toast === 'function') toast('Pick a single monitor first', 'error');
        return;
    }
    const here = rdMonitors[rdMonitorIndex];
    const othersToTheLeft = rdMonitors.some((s, i) => i !== rdMonitorIndex && s.x < here.x);
    const arrow = othersToTheLeft ? 0xff53 : 0xff51;   // Right : Left
    const keysyms = [0xffeb, 0xffe1, arrow];           // Super_L, Shift_L, arrow

    try {
        for (const ks of keysyms) rdRfb.sendKey(ks, null, true);
        for (const ks of [...keysyms].reverse()) rdRfb.sendKey(ks, null, false);
    } catch (e) {
        rdLog('pull err: ' + e.message);
        return;
    }
    if (navigator.vibrate) navigator.vibrate(10);
    if (typeof toast === 'function') toast('Window -> monitor ' + here.label, 'success');
}

// Cycle: all -> 1 -> 2 -> ... -> all
function rdCycleMonitor() {
    if (!rdMonitors.length) { rdLoadMonitors(); return; }
    rdMonitorIndex = rdMonitorIndex < 0 ? 0
        : (rdMonitorIndex + 1 >= rdMonitors.length ? -1 : rdMonitorIndex + 1);

    rdResetZoom();
    rdApplyCanvasLayout();
    rdUpdateMonitorBtn();

    try {
        const token = localStorage.getItem('cbt') || '';
        fetch('/api/vnc/monitor', {
            method: 'POST',
            headers: { 'Authorization': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: rdMonitorIndex })
        }).catch(() => {});
    } catch (e) {}

    if (typeof toast === 'function') {
        toast(rdMonitorIndex < 0 ? 'All monitors' : 'Monitor ' + rdMonitorLabel(), 'success');
    }
}

// ═══════════════════════════════════════════════════════════════════
// ZOOM & PAN
// ═══════════════════════════════════════════════════════════════════

function rdSetZoom(nz, ox, oy) {
    const c = document.getElementById('rd-canvas-container'); if (!c) return;
    const oz = rdZoomLevel; rdZoomLevel = nz;
    if (ox !== undefined) {
        const r = c.getBoundingClientRect();
        const cx = ox - r.left - r.width / 2, cy = oy - r.top - r.height / 2;
        rdPanX = cx - (cx - rdPanX) * (nz / oz);
        rdPanY = cy - (cy - rdPanY) * (nz / oz);
    }
    rdClampPan(); rdApplyTransform();
    const el = document.getElementById('rd-zoom-indicator');
    if (el) { if (nz > 1.05) { el.textContent = Math.round(nz * 100) + '%'; el.classList.add('visible'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('visible'), 2000); } else el.classList.remove('visible'); }
}
function rdSetPan(x, y) { rdPanX = x; rdPanY = y; rdClampPan(); rdApplyTransform(); }
function rdClampPan() { const c = document.getElementById('rd-canvas-container'); if (!c) return; const r = c.getBoundingClientRect(); const mx = (r.width * (rdZoomLevel - 1)) / 2, my = (r.height * (rdZoomLevel - 1)) / 2; rdPanX = Math.max(-mx, Math.min(mx, rdPanX)); rdPanY = Math.max(-my, Math.min(my, rdPanY)); }
function rdApplyTransform() { const c = document.getElementById('rd-canvas-container'); if (!c) return; c.style.transform = rdZoomLevel <= 1 ? '' : `translate(${rdPanX}px,${rdPanY}px) scale(${rdZoomLevel})`; if (rdZoomLevel <= 1) { rdPanX = 0; rdPanY = 0; } }
function rdResetZoom() { rdZoomLevel = 1; rdPanX = 0; rdPanY = 0; rdApplyTransform(); }
function rdFitToScreen() { rdResetZoom(); rdApplyCanvasLayout(); }

// ═══════════════════════════════════════════════════════════════════
// NATIVE KEYBOARD
// ═══════════════════════════════════════════════════════════════════

let rdKeyboardActive = false;
let rdClosingKeyboard = false;
let rdTypedText = '';
let rdTypedClearTimer = null;

function rdUpdateTypePreview() {
    const el = document.getElementById('rd-type-text');
    const fl = document.getElementById('rd-type-floating');
    if (!el) return;
    el.textContent = rdTypedText.slice(-40);
    if (fl) {
        if (rdTypedText.length > 0) fl.classList.add('visible');
        else fl.classList.remove('visible');
    }
}

function rdClearTypePreview() {
    rdTypedText = '';
    rdUpdateTypePreview();
}

let rdKeysExpanded = false;
function rdToggleKeysExpanded() {
    rdKeysExpanded = !rdKeysExpanded;
    const extra = document.getElementById('rd-keys-extra');
    const btn = document.getElementById('rd-keys-expand');
    if (extra) extra.classList.toggle('visible', rdKeysExpanded);
    if (btn) { btn.classList.toggle('expanded', rdKeysExpanded); btn.textContent = rdKeysExpanded ? '+' : '+'; }
}

function rdRepositionKeyboardPanel() {
    const panel = document.getElementById('rd-keyboard-panel');
    const floating = document.getElementById('rd-type-floating');
    if (!panel || !rdKeyboardActive) return;
    if (window.visualViewport) {
        const vv = window.visualViewport;
        const kbHeight = window.innerHeight - vv.height - vv.offsetTop;
        const bottomPx = kbHeight > 50 ? kbHeight : 0;
        panel.style.bottom = bottomPx + 'px';
        // Position floating preview just above the panel
        if (floating) {
            const panelH = panel.offsetHeight || 40;
            floating.style.bottom = (bottomPx + panelH + 6) + 'px';
        }
    }
}

function rdSetupNativeKeyboard() {
    // Track OS keyboard open/close via visualViewport
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', rdRepositionKeyboardPanel);
        window.visualViewport.addEventListener('scroll', rdRepositionKeyboardPanel);
    }

    const inp = document.getElementById('rd-native-keyboard'); if (!inp) return;
    // Prevent predictive text / autocomplete from interfering
    inp.setAttribute('inputmode', 'text');
    inp.setAttribute('enterkeyhint', 'send');

    let rdLastInputValue = ' ';
    inp.addEventListener('input', (e) => {
        if (!rdRfb) return;
        const cur = inp.value;
        const prev = rdLastInputValue;

        if (e.inputType === 'deleteContentBackward' || cur.length < prev.length) {
            // Backspace
            rdRfb.sendKey(0xff08);
            rdTypedText = rdTypedText.slice(0, -1);
            rdUpdateTypePreview();
        } else if (cur.length > prev.length) {
            // New character(s) added — only send the diff
            const added = cur.slice(prev.length);
            for (let i = 0; i < added.length; i++) rdRfb.sendKey(added.charCodeAt(i));
            rdTypedText += added;
            rdUpdateTypePreview();
            if (rdTypedClearTimer) clearTimeout(rdTypedClearTimer);
            rdTypedClearTimer = setTimeout(rdClearTypePreview, 4000);
        } else if (e.inputType === 'insertReplacementText' || e.inputType === 'insertCompositionText') {
            // Autocorrect/predictive replacement — send only the last char
            if (e.data && e.data.length === 1) {
                rdRfb.sendKey(e.data.charCodeAt(0));
                rdTypedText += e.data;
                rdUpdateTypePreview();
            }
        }

        // Reset input to single space
        rdLastInputValue = ' ';
        setTimeout(() => { inp.value = ' '; inp.setSelectionRange(1, 1); rdLastInputValue = ' '; }, 0);
    });
    inp.addEventListener('keydown', (e) => {
        if (!rdRfb) return;
        const m = { Enter: 0xff0d, Tab: 0xff09, Escape: 0xff1b, ArrowUp: 0xff52, ArrowDown: 0xff54, ArrowLeft: 0xff51, ArrowRight: 0xff53, Backspace: 0xff08, Delete: 0xffff };
        if (m[e.key]) {
            e.preventDefault();
            rdRfb.sendKey(m[e.key]);
            if (e.key === 'Enter') rdClearTypePreview();
            if (e.key === 'Backspace') { rdTypedText = rdTypedText.slice(0, -1); rdUpdateTypePreview(); }
        }
    });
    // If OS keyboard dismissed externally (back button, etc), sync state
    inp.addEventListener('blur', () => {
        if (rdKeyboardActive && !rdClosingKeyboard) {
            setTimeout(() => {
                if (rdKeyboardActive && !rdClosingKeyboard && document.activeElement !== inp) {
                    rdSetKeyboardActive(false);
                }
            }, 400);
        }
    });
}

function rdSetKeyboardActive(on) {
    rdKeyboardActive = on;
    const inp = document.getElementById('rd-native-keyboard');
    const p = document.getElementById('rd-keyboard-panel');
    const b = document.getElementById('rd-kb-btn');
    const tb = document.getElementById('rd-toolbar');
    if (on) {
        if (inp) { inp.value = ' '; inp.focus(); inp.setSelectionRange(1, 1); }
        if (p) p.style.display = 'flex';
        if (b) b.classList.add('active');
        if (tb) tb.style.display = 'none';
        rdClearTypePreview();
        setTimeout(rdRepositionKeyboardPanel, 100);
    } else {
        if (inp) inp.blur();
        if (p) { p.style.display = 'none'; p.style.bottom = '0'; }
        if (b) b.classList.remove('active');
        if (tb) tb.style.display = 'flex';
        rdClearTypePreview();
        // Collapse expanded keys and hide floating preview
        rdKeysExpanded = false;
        const extra = document.getElementById('rd-keys-extra');
        const expBtn = document.getElementById('rd-keys-expand');
        if (extra) extra.classList.remove('visible');
        if (expBtn) expBtn.classList.remove('expanded');
        const fl = document.getElementById('rd-type-floating');
        if (fl) fl.classList.remove('visible');
    }
}

let rdKbToggleLock = false;
function rdToggleNativeKeyboard() {
    if (rdKbToggleLock) return;
    rdKbToggleLock = true;
    rdResetToolbarTimer();
    if (rdKeyboardActive) {
        rdClosingKeyboard = true;
        rdSetKeyboardActive(false);
        setTimeout(() => { rdClosingKeyboard = false; rdKbToggleLock = false; }, 600);
    } else {
        rdSetKeyboardActive(true);
        setTimeout(() => { rdKbToggleLock = false; }, 300);
    }
}

// Re-focus hidden input after canvas interaction (keeps keyboard open)
function rdRefocusKeyboard() {
    if (!rdKeyboardActive || rdClosingKeyboard) return;
    const inp = document.getElementById('rd-native-keyboard');
    if (inp) { setTimeout(() => { inp.value = ' '; inp.focus(); inp.setSelectionRange(1, 1); }, 50); }
}

// Blur keyboard if not in keyboard mode (prevents phantom keyboard)
function rdBlurIfInactive() {
    if (rdKeyboardActive) return;
    const inp = document.getElementById('rd-native-keyboard');
    if (inp && document.activeElement === inp) inp.blur();
}

// ═══════════════════════════════════════════════════════════════════
// CLIPBOARD OCR GRAB
// ═══════════════════════════════════════════════════════════════════

let rdOcrSelecting = false;
let rdOcrStartX = 0, rdOcrStartY = 0;

function rdClipOcrGrab() {
    // Close clipboard panel, show selection overlay
    const cp = document.getElementById('rd-clipboard-panel');
    if (cp) cp.style.display = 'none';
    const ov = document.getElementById('rd-ocr-overlay');
    if (!ov) return;
    ov.style.display = 'flex';
    rdOcrSelecting = false;

    // Touch handlers for region selection
    const rect = document.getElementById('rd-ocr-rect');

    function onStart(e) {
        e.preventDefault();
        const t = e.touches ? e.touches[0] : e;
        rdOcrStartX = t.clientX;
        rdOcrStartY = t.clientY;
        rdOcrSelecting = true;
        if (rect) { rect.style.left = t.clientX + 'px'; rect.style.top = t.clientY + 'px'; rect.style.width = '0'; rect.style.height = '0'; rect.style.display = 'block'; }
    }
    function onMove(e) {
        if (!rdOcrSelecting) return;
        e.preventDefault();
        const t = e.touches ? e.touches[0] : e;
        const x = Math.min(rdOcrStartX, t.clientX), y = Math.min(rdOcrStartY, t.clientY);
        const w = Math.abs(t.clientX - rdOcrStartX), h = Math.abs(t.clientY - rdOcrStartY);
        if (rect) { rect.style.left = x + 'px'; rect.style.top = y + 'px'; rect.style.width = w + 'px'; rect.style.height = h + 'px'; }
    }
    function onEnd(e) {
        if (!rdOcrSelecting) return;
        rdOcrSelecting = false;
        const t = e.changedTouches ? e.changedTouches[0] : e;
        const x1 = Math.min(rdOcrStartX, t.clientX), y1 = Math.min(rdOcrStartY, t.clientY);
        const w = Math.abs(t.clientX - rdOcrStartX), h = Math.abs(t.clientY - rdOcrStartY);
        // Cleanup listeners
        ov.removeEventListener('touchstart', onStart);
        ov.removeEventListener('touchmove', onMove);
        ov.removeEventListener('touchend', onEnd);
        ov.removeEventListener('mousedown', onStart);
        ov.removeEventListener('mousemove', onMove);
        ov.removeEventListener('mouseup', onEnd);
        if (w < 20 || h < 20) { rdClipOcrCancel(); return; }
        rdClipOcrProcess(x1, y1, w, h);
    }

    ov.addEventListener('touchstart', onStart, { passive: false });
    ov.addEventListener('touchmove', onMove, { passive: false });
    ov.addEventListener('touchend', onEnd, { passive: false });
    ov.addEventListener('mousedown', onStart);
    ov.addEventListener('mousemove', onMove);
    ov.addEventListener('mouseup', onEnd);
}

function rdClipOcrCancel() {
    const ov = document.getElementById('rd-ocr-overlay');
    if (ov) ov.style.display = 'none';
    const rect = document.getElementById('rd-ocr-rect');
    if (rect) rect.style.display = 'none';
}

async function rdClipOcrProcess(sx, sy, sw, sh) {
    rdClipOcrCancel();
    if (typeof toast === 'function') toast('OCR SCANNING...', 'success');

    // Extract region from VNC canvas
    const canvas = rdFindCanvas();
    if (!canvas) { if (typeof toast === 'function') toast('NO CANVAS', 'error'); return; }

    const cr = canvas.getBoundingClientRect();
    const fbW = rdRfb?._fbWidth || canvas.width;
    const fbH = rdRfb?._fbHeight || canvas.height;
    const scaleX = fbW / cr.width, scaleY = fbH / cr.height;

    // Map screen coords to canvas coords
    const cx = Math.round((sx - cr.left) * scaleX);
    const cy = Math.round((sy - cr.top) * scaleY);
    const cw = Math.round(sw * scaleX);
    const ch = Math.round(sh * scaleY);

    // Create cropped canvas
    const crop = document.createElement('canvas');
    crop.width = cw; crop.height = ch;
    const ctx = crop.getContext('2d');
    ctx.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);

    // Use Tesseract.js if available, otherwise try native
    try {
        if (typeof Tesseract !== 'undefined') {
            const { data: { text } } = await Tesseract.recognize(crop, 'eng', { logger: () => {} });
            rdClipOcrResult(text);
        } else {
            // Lazy-load Tesseract from CDN
            if (typeof toast === 'function') toast('LOADING OCR ENGINE...', 'success');
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
            script.onload = async () => {
                try {
                    const { data: { text } } = await Tesseract.recognize(crop, 'eng', { logger: () => {} });
                    rdClipOcrResult(text);
                } catch(e) {
                    if (typeof toast === 'function') toast('OCR FAILED: ' + e.message, 'error');
                }
            };
            script.onerror = () => { if (typeof toast === 'function') toast('OCR LOAD FAILED', 'error'); };
            document.head.appendChild(script);
        }
    } catch(e) {
        if (typeof toast === 'function') toast('OCR FAILED: ' + e.message, 'error');
    }
}

function rdClipOcrResult(text) {
    const cleaned = text.trim();
    if (!cleaned) { if (typeof toast === 'function') toast('NO TEXT FOUND', 'error'); return; }
    // Put result in clipboard textarea and show panel
    const ta = document.getElementById('rd-clipboard-text');
    if (ta) ta.value = cleaned;
    const cp = document.getElementById('rd-clipboard-panel');
    if (cp) cp.style.display = 'flex';
    const b = document.getElementById('rd-clip-btn');
    if (b) b.classList.add('active');
    rdResetToolbarTimer();
    if (typeof toast === 'function') toast('OCR: ' + cleaned.length + ' CHARS', 'success');
    // Also copy to system clipboard
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cleaned).catch(() => {});
    }
}

// ═══════════════════════════════════════════════════════════════════
// ADAPTIVE QUALITY
// ═══════════════════════════════════════════════════════════════════

function rdOnInteraction() {
    if (!rdAdaptiveQuality || !rdRfb) return;
    if (rdRfb.qualityLevel !== rdActiveQuality) rdRfb.qualityLevel = rdActiveQuality;
    if (rdIdleTimer) clearTimeout(rdIdleTimer);
    rdIdleTimer = setTimeout(() => { if (rdRfb && rdAdaptiveQuality) rdRfb.qualityLevel = rdIdleQuality; }, 800);
}

// ═══════════════════════════════════════════════════════════════════
// QUICK ACTIONS
// ═══════════════════════════════════════════════════════════════════

function rdLoadQuickActions() { try { const r = localStorage.getItem(RD_QUICK_ACTIONS_KEY); rdQuickActions = r ? JSON.parse(r) : [...RD_DEFAULT_ACTIONS]; } catch(e) { rdQuickActions = [...RD_DEFAULT_ACTIONS]; } }

function rdExecuteAction(idx) {
    if (!rdRfb || idx >= rdQuickActions.length) return;
    const action = rdQuickActions[idx];
    let delay = 0;
    for (const step of action.keys) {
        setTimeout(() => {
            if (!rdRfb) return;
            if (step.type === 'key') rdRfb.sendKey(step.keysym);
            else if (step.type === 'combo') { for (const k of step.keys) if (rdModKeysyms[k]) { rdRfb.sendKey(rdModKeysyms[k], null, true); rdRfb.sendKey(rdModKeysyms[k], null, false); } }
            else if (step.type === 'text') { for (let i = 0; i < step.text.length; i++) rdRfb.sendKey(step.text.charCodeAt(i)); }
            else if (step.type === 'raw_combo') { for (const ks of step.keysyms) rdRfb.sendKey(ks, null, true); for (const ks of [...step.keysyms].reverse()) rdRfb.sendKey(ks, null, false); }
        }, delay);
        delay += 200;
    }
    if (typeof toast === 'function') toast(action.name, 'info');
}

function rdRenderQuickActions() {
    const c = document.getElementById('rd-quick-actions-list'); if (!c) return; c.innerHTML = '';
    const icons = { globe:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>', terminal:'<svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>', folder:'<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>', lock:'<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>', monitor:'<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>', activity:'<svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>', x:'<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>', minus:'<svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>', camera:'<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>' };
    rdQuickActions.forEach((a, i) => { const b = document.createElement('button'); b.className = 'rd-action-btn'; b.onclick = () => rdExecuteAction(i); b.innerHTML = `<span class="rd-action-icon">${icons[a.icon] || icons.monitor}</span><span class="rd-action-name">${a.name}</span>`; c.appendChild(b); });
}

function rdToggleQuickActions() {
    rdResetToolbarTimer();
    const p = document.getElementById('rd-quick-actions-panel'), b = document.getElementById('rd-actions-btn');
    if (p) { const v = p.style.display !== 'none'; p.style.display = v ? 'none' : 'grid'; if (b) b.classList.toggle('active', !v); }
}

// ═══════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════

// Lock/unlock screen orientation (requires fullscreen)
function rdLockLandscape() {
    try {
        const room = document.getElementById('remote-room');
        if (!room) return;
        const goFullscreen = room.requestFullscreen || room.webkitRequestFullscreen;
        if (goFullscreen) {
            goFullscreen.call(room).then(() => {
                if (screen.orientation && screen.orientation.lock) {
                    screen.orientation.lock('landscape').catch(() => {});
                }
            }).catch(() => {
                // Fullscreen denied, try lock anyway (works in installed PWAs)
                if (screen.orientation && screen.orientation.lock) {
                    screen.orientation.lock('landscape').catch(() => {});
                }
            });
        } else if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(() => {});
        }
    } catch (e) {}
}

function rdUnlockOrientation() {
    try {
        if (screen.orientation && screen.orientation.unlock) {
            screen.orientation.unlock();
        }
        if (document.fullscreenElement) {
            (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        }
    } catch (e) {}
}

// Auto-swap click strip to opposite side of finger
function rdAutoSideStrip(fingerX) {
    const strip = document.getElementById('rd-click-strip');
    const scroll = document.getElementById('rd-scroll-bar');
    if (!strip) return;
    const mid = window.innerWidth / 2;
    const onRight = fingerX > mid;
    strip.classList.toggle('left', onRight);
    // Scroll bar always opposite side of strip
    // strip: onRight=true → left side. So scroll should stay right (no .left class)
    // strip: onRight=false → right side. So scroll should go left (.left class)
    if (scroll) scroll.classList.toggle('left', !onRight);
}

function rdToggleKeyboard() { rdToggleNativeKeyboard(); }
function rdToggleClipboard() { rdResetToolbarTimer(); const p = document.getElementById('rd-clipboard-panel'), b = document.getElementById('rd-clip-btn'); if (p) { const v = p.style.display !== 'none'; p.style.display = v ? 'none' : 'flex'; if (b) b.classList.toggle('active', !v); } }
function rdSendClipboard() { const t = document.getElementById('rd-clipboard-text')?.value; if (rdRfb && t) { rdRfb.clipboardPasteFrom(t); if (typeof toast === 'function') toast('Clipboard sent', 'success'); } }
function rdToggleQuality() { rdResetToolbarTimer(); const p = document.getElementById('rd-quality-panel'), b = document.getElementById('rd-quality-btn'); if (p) { const v = p.style.display !== 'none'; p.style.display = v ? 'none' : 'flex'; if (b) b.classList.toggle('active', !v); if (v) rdDataMeterStop(); else rdDataMeterStart(); } }

// ── Live data meter ────────────────────────────────────────────────────
// The RD room's cost used to be completely invisible, which is how audio
// managed to sit at 691 MB/hour without anyone noticing. The proxy counts
// the real bytes; this just reads them back.
//
// It polls ONLY while the quality panel is open. A meter that ran in the
// background would be one more thing quietly spending the data it reports.
let rdDataMeterTimer = null;

function rdFormatMB(bytes) {
    if (bytes < 1e6) return (bytes / 1e3).toFixed(0) + ' KB';
    return (bytes / 1e6).toFixed(1) + ' MB';
}

async function rdDataMeterTick() {
    const out = document.getElementById('rd-qp-data');
    if (!out) return;
    try {
        const token = localStorage.getItem('cbt') || '';
        const r = await fetch('/api/vnc/status', { headers: { Authorization: token } });
        const d = await r.json();
        const m = d.meter;
        if (!m) { out.textContent = 'data: --'; return; }
        const mins = Math.max(1, Math.round(m.seconds / 60));
        let line = `data: ${rdFormatMB(m.total)} in ${mins}m  ·  ~${m.mbPerHour} MB/h`;
        line += `\nscreen ${rdFormatMB(m.vnc)}  ·  audio ${rdFormatMB(m.audio)}`;
        if (m.audioSaved > 0) line += `  (silence saved ${rdFormatMB(m.audioSaved)})`;
        out.textContent = line;
    } catch (e) { /* leave the last reading up */ }
}

function rdDataMeterStart() {
    rdDataMeterStop();
    rdDataMeterTick();
    rdDataMeterTimer = setInterval(rdDataMeterTick, 5000);
}

function rdDataMeterStop() {
    if (rdDataMeterTimer) { clearInterval(rdDataMeterTimer); rdDataMeterTimer = null; }
}
function rdSetQuality(v) { document.getElementById('rd-quality-value').textContent = v; rdUserQuality = parseInt(v); rdIdleQuality = Math.min(9, rdUserQuality + 2); rdActiveQuality = Math.max(0, rdUserQuality - 3); if (rdRfb) rdRfb.qualityLevel = rdAdaptiveQuality ? rdIdleQuality : rdUserQuality; }
// Slider carries whole numbers (30-200) so it steps cleanly; the multiplier is /100.
function rdSetPointerSpeed(v) {
    rdPointerSpeed = Math.max(0.3, Math.min(2, (parseInt(v, 10) || 74) / 100));
    const el = document.getElementById('rd-speed-value');
    if (el) el.textContent = rdPointerSpeed.toFixed(2) + 'x';
    rdSaveSettings();
}
function rdToggleFullscreen() { const b = document.getElementById('rd-fs-btn'); if (!document.fullscreenElement) { const r = document.getElementById('remote-room'); (r.requestFullscreen || r.webkitRequestFullscreen).call(r); if (b) b.classList.add('active'); } else { (document.exitFullscreen || document.webkitExitFullscreen).call(document); if (b) b.classList.remove('active'); } }

function rdSendKey(ks) { if (!rdRfb) return; for (const [m,h] of Object.entries(rdModifiers)) if (h) rdRfb.sendKey(rdModKeysyms[m], null, true); rdRfb.sendKey(ks); for (const [m,h] of Object.entries(rdModifiers)) if (h) { rdRfb.sendKey(rdModKeysyms[m], null, false); rdModifiers[m] = false; const b = document.getElementById(`rd-key-${m}`); if (b) b.classList.remove('held'); } }
function rdToggleModifier(m) { rdModifiers[m] = !rdModifiers[m]; const b = document.getElementById(`rd-key-${m}`); if (b) b.classList.toggle('held', rdModifiers[m]); }
function rdSendCombo(keys) { if (!rdRfb) return; const ks = keys.map(k => rdModKeysyms[k] || (k === 'del' ? 0xffff : k === 'tab' ? 0xff09 : k.length === 1 ? k.charCodeAt(0) : 0)).filter(Boolean); for (const k of ks) rdRfb.sendKey(k, null, true); for (const k of ks.reverse()) rdRfb.sendKey(k, null, false); }
function rdCopy() { rdSendCombo(['ctrl', 'c']); }
function rdPaste() { rdSendCombo(['ctrl', 'v']); }
function rdResetModifiers() { for (const m of Object.keys(rdModifiers)) { rdModifiers[m] = false; const b = document.getElementById(`rd-key-${m}`); if (b) b.classList.remove('held'); } }

function rdUpdateStatus(state, text) { const el = document.getElementById('rd-status'); if (!el) return; el.textContent = text; el.className = 'rd-status'; if (state === 'connecting') el.classList.add('connecting'); else if (state === 'connected') el.classList.add('connected'); }

function rdShowConnectedUI() {
    const el = (id) => document.getElementById(id);
    if (el('rd-connect-panel')) el('rd-connect-panel').style.display = 'none';
    if (el('rd-canvas-wrap')) el('rd-canvas-wrap').style.display = 'flex';
    if (el('rd-toolbar')) el('rd-toolbar').style.display = 'flex';
    if (!rdMouseMode) {
        if (el('rd-click-strip')) el('rd-click-strip').classList.add('visible');
        if (el('rd-scroll-bar')) el('rd-scroll-bar').style.display = 'flex';
    }
    if (el('rd-overlay-toggle')) el('rd-overlay-toggle').classList.add('visible');
    const h = document.querySelector('.rd-header'); if (h) h.classList.add('rd-compact');
    // Kill ambient animations during VNC (huge perf drain)
    const ambient = document.querySelector('#remote-room .room-ambient');
    if (ambient) ambient.style.display = 'none';
    rdResetToolbarTimer();
}

function rdShowDisconnectedUI() {
    const el = (id) => document.getElementById(id);
    ['rd-keyboard-panel', 'rd-quality-panel', 'rd-clipboard-panel', 'rd-quick-actions-panel'].forEach(id => { const e = el(id); if (e) e.style.display = 'none'; });
    rdDataMeterStop();   // the quality panel just went away with it
    if (rdPipOpen) rdPipClose();
    if (el('rd-type-floating')) el('rd-type-floating').classList.remove('visible');
    if (el('rd-connect-panel')) el('rd-connect-panel').style.display = 'block';
    if (el('rd-canvas-wrap')) el('rd-canvas-wrap').style.display = 'none';
    // Restore ambient animations
    const ambient = document.querySelector('#remote-room .room-ambient');
    if (ambient) ambient.style.display = '';
    if (el('rd-toolbar')) { el('rd-toolbar').style.display = 'none'; el('rd-toolbar').classList.remove('rd-toolbar-hidden'); }
    if (el('rd-click-strip')) el('rd-click-strip').classList.remove('visible');
    if (el('rd-overlay-toggle')) el('rd-overlay-toggle').classList.remove('visible');
    if (el('rd-scroll-bar')) el('rd-scroll-bar').style.display = 'none';
    if (el('rd-terminal-overlay')) el('rd-terminal-overlay').classList.remove('visible');
    rdTerminalOverlayOpen = false;
    if (el('rd-toolbar-toggle')) el('rd-toolbar-toggle').classList.remove('visible');
    const h = document.querySelector('.rd-header'); if (h) h.classList.remove('rd-compact');
    if (rdToolbarTimer) { clearTimeout(rdToolbarTimer); rdToolbarTimer = null; }
    rdDragHeld = false; const db = el('rd-drag-btn'); if (db) db.classList.remove('active');
}

function rdResetToolbarTimer() {
    if (rdToolbarTimer) clearTimeout(rdToolbarTimer);
    const tb = document.getElementById('rd-toolbar'), tg = document.getElementById('rd-toolbar-toggle');
    if (tb) tb.classList.remove('rd-toolbar-hidden');
    if (tg) tg.classList.remove('visible');
    rdToolbarTimer = setTimeout(() => { if (!rdConnected) return; if (tb) tb.classList.add('rd-toolbar-hidden'); if (tg) tg.classList.add('visible'); }, RD_TOOLBAR_AUTOHIDE);
}
function rdShowToolbar() { rdResetToolbarTimer(); }

// ═══════════════════════════════════════════════════════════════════
// BACKGROUND PERSISTENCE
// ═══════════════════════════════════════════════════════════════════

let rdKeepAliveAudio = null;
let rdPersistentNotification = false;
let rdWebLockAbort = null;

function rdRequestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// Web Lock keeps the tab alive in background - browser won't freeze/discard it
function rdAcquireWebLock() {
    if (rdWebLockAbort || !('locks' in navigator)) return;
    rdWebLockAbort = new AbortController();
    navigator.locks.request('rd-session-active', { signal: rdWebLockAbort.signal }, () => {
        return new Promise(() => {}); // Hold lock forever until aborted
    }).catch(() => {});
}

function rdReleaseWebLock() {
    if (rdWebLockAbort) { rdWebLockAbort.abort(); rdWebLockAbort = null; }
}

function rdStartBackgroundKeepAlive() {
    if (rdKeepAliveAudio) return;
    rdRequestNotificationPermission();
    rdAcquireWebLock();
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        rdKeepAliveAudio = { ctx, osc, gain };
    } catch(e) {}

    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Remote Desktop Active',
            artist: 'TSRCT'
        });
        navigator.mediaSession.playbackState = 'playing';
    }

    // Show ONE persistent notification on connect - never toggle it
    rdShowPersistentNotification();
}

function rdStopBackgroundKeepAlive() {
    if (rdKeepAliveAudio) {
        try { rdKeepAliveAudio.osc.stop(); rdKeepAliveAudio.ctx.close(); } catch(e) {}
        rdKeepAliveAudio = null;
    }
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'none';
        navigator.mediaSession.metadata = null;
    }
    rdReleaseWebLock();
}

function rdShowPersistentNotification() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(reg => {
        reg.showNotification('Remote Desktop Active', {
            body: 'Tap to return to your session',
            icon: '/src/icons/icon-192.png',
            badge: '/src/icons/icon-192.png',
            tag: 'rd-session',
            renotify: false,
            requireInteraction: true,
            silent: true
        });
        rdPersistentNotification = true;
    });
}

function rdDismissPersistentNotification() {
    if (!rdPersistentNotification) return;
    rdPersistentNotification = false;
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(reg => {
            reg.getNotifications({ tag: 'rd-session' }).then(n => n.forEach(x => x.close()));
        });
    }
}

let rdNeedsLandscapeRelock = false;

function rdOnVisibilityChange() {
    if (!rdConnected) return;
    if (document.hidden) {
        rdPersistentNotification = false;
        rdShowPersistentNotification();
    } else {
        // Fullscreen + orientation lock require a user gesture.
        // visibilitychange is not one, so flag it for the next touch.
        rdNeedsLandscapeRelock = true;
    }
}

function rdRelockOnTouch() {
    if (!rdNeedsLandscapeRelock || !rdConnected) return;
    rdNeedsLandscapeRelock = false;
    rdLockLandscape();
}

function rdInitBackgroundPersistence() {
    document.addEventListener('visibilitychange', rdOnVisibilityChange);

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'rd-return') {
                const modal = document.getElementById('room-remote');
                if (modal && !modal.classList.contains('active')) {
                    if (typeof openRoom === 'function') openRoom('remote');
                }
                // Flag for landscape relock on next touch (needs user gesture)
                rdNeedsLandscapeRelock = true;
            }
        });
    }
}

function rdCleanupBackgroundPersistence() {
    rdStopBackgroundKeepAlive();
    rdDismissPersistentNotification();
}

// ═══════════════════════════════════════════════════════════════════
// TERMINAL OVERLAY
// ═══════════════════════════════════════════════════════════════════

let rdTerminalOverlayOpen = false;
let rdTerminalPollInterval = null;
let rdOverlaySession = null; // currently viewed session
let rdOverlaySessions = []; // all available sessions

function rdToggleTerminalOverlay() {
    const overlay = document.getElementById('rd-terminal-overlay');
    if (!overlay) return;
    rdTerminalOverlayOpen = !rdTerminalOverlayOpen;
    overlay.classList.toggle('visible', rdTerminalOverlayOpen);
    const toggleBtn = document.getElementById('rd-overlay-toggle');
    if (toggleBtn) toggleBtn.classList.toggle('active', rdTerminalOverlayOpen);
    if (rdTerminalOverlayOpen) {
        if (rdVrActive) {
            // VR mode: switch canvas render source to terminal
            // Hide normal terminal overlay (we render it into VR canvas instead)
            overlay.classList.remove('visible');
            rdVrSetTerminalMode(true);
        }
        rdLoadOverlaySessions();
        rdRefreshTerminalOverlay();
        rdTerminalPollInterval = setInterval(rdRefreshTerminalOverlay, 3000);
        const inp = document.getElementById('rd-terminal-input');
        if (inp) {
            if (!rdVrActive) setTimeout(() => inp.focus(), 100);
            inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); rdOverlaySend(); } };
        }
    } else {
        overlay.style.zIndex = '';
        rdVrSetTerminalMode(false);
        if (rdTerminalPollInterval) { clearInterval(rdTerminalPollInterval); rdTerminalPollInterval = null; }
    }
}

async function rdLoadOverlaySessions() {
    try {
        const tk = localStorage.getItem('cbt') || '';
        const res = await fetch('/api/sessions', { headers: { Authorization: tk } });
        if (!res.ok) return;
        const data = await res.json();
        rdOverlaySessions = data.sessions || [];
        if (!rdOverlaySession && rdOverlaySessions.length > 0) {
            // Default to current home session or first session
            const home = typeof homeSession !== 'undefined' && homeSession ? homeSession : (data.current || rdOverlaySessions[0].name);
            rdOverlaySession = home;
        }
        rdRenderSessionPicker();
    } catch(e) {}
}

function rdRenderSessionPicker() {
    const picker = document.getElementById('rd-session-picker');
    if (!picker) return;
    picker.innerHTML = rdOverlaySessions.map(s =>
        `<button class="rd-session-tab ${s.name === rdOverlaySession ? 'active' : ''}" onclick="rdSwitchOverlaySession('${s.name}')">${s.name}</button>`
    ).join('');
}

function rdSwitchOverlaySession(name) {
    rdOverlaySession = name;
    rdRenderSessionPicker();
    rdRefreshTerminalOverlay();
}

async function rdRefreshTerminalOverlay() {
    try {
        const session = rdOverlaySession || (typeof getCurrentTargetSession === 'function' ? getCurrentTargetSession() : 'claude');
        const tk = localStorage.getItem('cbt') || '';
        const res = await fetch(`/api/output?session=${encodeURIComponent(session)}`, {
            headers: { Authorization: tk }
        });
        if (!res.ok) return;
        const data = await res.json();
        const output = document.getElementById('rd-terminal-output');
        if (!output) return;
        const text = data.output || '';
        const lines = text.split('\n').slice(-80).join('\n');
        const wasAtBottom = (output.scrollHeight - output.scrollTop - output.clientHeight) < 40;
        output.textContent = lines;
        if (wasAtBottom) output.scrollTop = output.scrollHeight;
    } catch(e) {}
}

async function rdOverlaySend() {
    const input = document.getElementById('rd-terminal-input');
    if (!input) return;
    let p = input.value.trim();
    if (!p && rdOverlayAttached.length === 0) return;

    // Include attached images
    if (rdOverlayAttached.length > 0) {
        const prefix = `[Images attached: ${rdOverlayAttached.join(', ')}]`;
        p = p ? `${prefix} ${p}` : `${prefix} - please analyze`;
        rdOverlayAttached.length = 0;
        rdUpdateOverlayAttachIndicator();
    }

    input.value = '';
    try {
        const session = rdOverlaySession || (typeof getCurrentTargetSession === 'function' ? getCurrentTargetSession() : 'claude');
        const tk = localStorage.getItem('cbt') || '';
        await fetch('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: tk },
            body: JSON.stringify({ prompt: p, session, vault: localStorage.getItem('vault_enabled') !== 'false' })
        });
        if (typeof toast === 'function') toast('SENT', 'success', false);
        setTimeout(rdRefreshTerminalOverlay, 1500);
    } catch(e) {
        if (typeof toast === 'function') toast('SEND ERROR', 'error');
    }
}

// ── Overlay Dictation ──────────────────────────────────────────
let rdOverlayRecognition = null;
let rdOverlayRecording = false;

function rdOverlayToggleMic() {
    if (!rdOverlayRecognition) {
        rdOverlayRecognition = createSpeechRecognizer({
            continuous: false,
            interimResults: false,
            lang: (typeof speechLang !== 'undefined') ? speechLang : 'es-ES',
            onResult: (e) => {
                const input = document.getElementById('rd-terminal-input');
                if (!input) return;
                const result = e.results[e.results.length - 1];
                if (result && result.isFinal) {
                    const text = result[0].transcript.toLowerCase();
                    if (input.value && !input.value.endsWith(' ')) input.value += ' ';
                    input.value += text;
                }
            },
            onStart: () => {
                rdOverlayRecording = true;
                document.getElementById('rd-overlay-mic')?.classList.add('recording');
            },
            onEnd: () => {
                if (rdOverlayRecording) {
                    try { rdOverlayRecognition.start(); } catch(e) {}
                } else {
                    document.getElementById('rd-overlay-mic')?.classList.remove('recording');
                }
            }
        });
        if (!rdOverlayRecognition) { if (typeof toast === 'function') toast('NOT SUPPORTED', 'error'); return; }
    }

    if (rdOverlayRecording) {
        rdOverlayRecording = false;
        rdOverlayRecognition.stop();
        if (typeof toast === 'function') toast('MIC OFF', 'error');
    } else {
        rdOverlayRecording = true;
        rdOverlayRecognition.start();
        if (typeof toast === 'function') toast('LISTENING...', 'success');
    }
}

// ── VNC Dictation (types directly into remote desktop) ────────
let rdVncRecognition = null;
let rdVncWantRecording = false;
let rdVncFirstWord = true;

function rdVncDictateUpdateBtn() {
    const btn = document.getElementById('rd-vnc-mic');
    if (btn) {
        if (rdVncWantRecording) btn.classList.add('recording');
        else btn.classList.remove('recording');
    }
    // Also update VR mic button indicator
    const vrMicBtns = document.querySelectorAll('.rd-vr-controls .rd-vr-ctrl-btn');
    vrMicBtns.forEach(b => {
        if (b.textContent.trim().startsWith('MIC')) {
            if (rdVncWantRecording) {
                b.style.background = 'rgba(255, 0, 0, 0.4)';
                b.style.borderColor = '#f00';
                b.textContent = 'MIC*';
            } else {
                b.style.background = '';
                b.style.borderColor = '';
                b.textContent = 'MIC';
            }
        }
    });
}

function rdVncDictateToggle() {
    // Allow MIC in VR native mode even without VNC connection
    if (!rdRfb && !(rdVrActive && rdVrScene === 'session')) {
        if (typeof toast === 'function') toast('NOT CONNECTED', 'error'); return;
    }

    if (rdVncWantRecording) {
        // Stop
        rdVncWantRecording = false;
        rdVncDictateUpdateBtn();
        if (rdVncRecognition) { try { rdVncRecognition.stop(); } catch(e) {} }
        if (typeof toast === 'function') toast('MIC OFF', 'error');
        return;
    }

    // Destroy previous instance to get fresh mic permissions
    if (rdVncRecognition) { try { rdVncRecognition.abort(); } catch(e) {} rdVncRecognition = null; }

    const rec = createSpeechRecognizer({
        continuous: false,
        interimResults: false,
        lang: (typeof speechLang !== 'undefined') ? speechLang : 'es-ES',
        onResult: (e) => {
            const result = e.results[e.results.length - 1];
            if (result && result.isFinal) {
                const text = result[0].transcript.toLowerCase();

                // VR native session: insert at cursor position
                if (rdVrActive && rdVrScene === 'session') {
                    rdVrInsertAtCursor(text);
                    return;
                }

                if (!rdRfb) return;
                // Add space before new words if not first word
                if (!rdVncFirstWord) {
                    rdRfb.sendKey(0x0020);
                    rdTypedText += ' ';
                }
                rdVncFirstWord = false;
                // Send each character as a VNC keystroke
                for (let i = 0; i < text.length; i++) {
                    rdRfb.sendKey(text.charCodeAt(i));
                }
                rdTypedText += text;
                rdUpdateTypePreview();
                if (rdTypedClearTimer) clearTimeout(rdTypedClearTimer);
                rdTypedClearTimer = setTimeout(rdClearTypePreview, 4000);
            }
        },
        onStart: () => {
            rdVncDictateUpdateBtn();
        },
        onEnd: () => {
            if (rdVncWantRecording) {
                // Restart after small delay to avoid "already started" race
                setTimeout(() => {
                    if (!rdVncWantRecording) { rdVncDictateUpdateBtn(); return; }
                    try { rec.start(); } catch(e) {
                        // If restart fails, recreate on next toggle
                        rdVncWantRecording = false;
                        rdVncDictateUpdateBtn();
                        if (typeof toast === 'function') toast('MIC LOST - TAP AGAIN', 'error');
                    }
                }, 150);
            } else {
                rdVncDictateUpdateBtn();
            }
        },
        onError: (e) => {
            console.error('VNC dictation error:', e.error);
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                rdVncWantRecording = false;
                rdVncDictateUpdateBtn();
                if (typeof toast === 'function') toast('MIC DENIED - CHECK PERMISSIONS', 'error');
            } else if (e.error === 'no-speech') {
                // Normal timeout, onend will restart if wanted
            } else if (e.error === 'network') {
                rdVncWantRecording = false;
                rdVncDictateUpdateBtn();
                if (typeof toast === 'function') toast('MIC NETWORK ERROR', 'error');
            } else if (e.error === 'aborted') {
                // User or system aborted, ignore
            } else {
                if (typeof toast === 'function') toast('MIC: ' + e.error, 'error');
            }
        }
    });
    if (!rec) { if (typeof toast === 'function') toast('NOT SUPPORTED', 'error'); return; }

    rdVncRecognition = rec;
    rdVncWantRecording = true;
    rdVncFirstWord = true;
    rdVncDictateUpdateBtn();

    try {
        rec.start();
        if (typeof toast === 'function') toast('LISTENING...', 'success');
    } catch(e) {
        rdVncWantRecording = false;
        rdVncDictateUpdateBtn();
        if (typeof toast === 'function') toast('MIC FAILED: ' + e.message, 'error');
    }
}

// ── Overlay Image Upload ───────────────────────────────────────
let rdOverlayAttached = [];

async function rdOverlayUpload(input) {
    if (!input.files || !input.files.length) return;
    const files = Array.from(input.files);
    if (typeof toast === 'function') toast(`PROCESSING ${files.length} IMG...`, 'success');

    // Temporarily swap attachedImages target so processAndUploadImage pushes to our array
    const savedAttached = (typeof attachedImages !== 'undefined') ? [...attachedImages] : [];
    let uploaded = 0;

    for (const file of files) {
        try {
            if (typeof processAndUploadImage === 'function') {
                const path = await processAndUploadImage(file);
                // processAndUploadImage pushed to global attachedImages - grab the last one
                if (typeof attachedImages !== 'undefined' && attachedImages.length > savedAttached.length + uploaded) {
                    const newPath = attachedImages[attachedImages.length - 1];
                    rdOverlayAttached.push(newPath);
                }
            }
            uploaded++;
        } catch(e) {}
    }

    // Restore original attachedImages (remove what we added)
    if (typeof attachedImages !== 'undefined') {
        attachedImages.length = 0;
        savedAttached.forEach(p => attachedImages.push(p));
    }
    if (typeof updateAttachmentIndicator === 'function') updateAttachmentIndicator();

    input.value = '';
    rdUpdateOverlayAttachIndicator();
    if (uploaded > 0 && typeof toast === 'function') toast(`${uploaded} IMG ATTACHED`, 'success');
}

function rdUpdateOverlayAttachIndicator() {
    const input = document.getElementById('rd-terminal-input');
    if (!input) return;
    if (rdOverlayAttached.length > 0) {
        input.placeholder = `${rdOverlayAttached.length} file(s) attached - add prompt...`;
    } else {
        input.placeholder = '> prompt...';
    }
}

// ── Overlay Server Gallery ─────────────────────────────────────
// Shared on window so gallery.js (non-module) can access them
window.rdOverlayGalleryMode = false;

function rdOverlayServerGallery() {
    if (typeof showGalleryModal === 'function') {
        window.rdOverlayGalleryMode = true;
        const modal = document.getElementById('gallery-modal');
        const overlay = document.getElementById('rd-terminal-overlay');
        if (modal) {
            modal.classList.add('rd-themed');
            modal.style.zIndex = '10000';
        }
        // Temporarily lower overlay so modal is on top
        if (overlay) overlay.style.zIndex = '999';
        showGalleryModal();
    } else if (typeof toast === 'function') {
        toast('Gallery not available', 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════
// NEXUS PICTURE-IN-PICTURE
// ═══════════════════════════════════════════════════════════════════

let rdPipOpen = false;
let rdPipSession = null;
let rdPipSessions = [];
let rdPipPollTimer = null;
let rdPipExpanded = false;
let rdPipDragOffX = 0, rdPipDragOffY = 0, rdPipDragging = false;

function rdPipToggle() {
    rdPipOpen = !rdPipOpen;
    const pip = document.getElementById('rd-nexus-pip');
    const btn = document.getElementById('rd-pip-btn');
    if (!pip) return;

    if (rdPipOpen) {
        pip.style.display = 'flex';
        if (btn) btn.classList.add('active');
        rdPipLoadSessions();
        rdPipRefresh();
        rdPipPollTimer = setInterval(rdPipRefresh, 2500);
        rdPipInitDrag();
    } else {
        pip.style.display = 'none';
        if (btn) btn.classList.remove('active');
        if (rdPipPollTimer) { clearInterval(rdPipPollTimer); rdPipPollTimer = null; }
    }
    rdResetToolbarTimer();
}

function rdPipClose() {
    rdPipOpen = false;
    const pip = document.getElementById('rd-nexus-pip');
    const btn = document.getElementById('rd-pip-btn');
    if (pip) pip.style.display = 'none';
    if (btn) btn.classList.remove('active');
    if (rdPipPollTimer) { clearInterval(rdPipPollTimer); rdPipPollTimer = null; }
}

function rdPipToggleSize() {
    rdPipExpanded = !rdPipExpanded;
    const pip = document.getElementById('rd-nexus-pip');
    if (pip) pip.classList.toggle('expanded', rdPipExpanded);
}

async function rdPipLoadSessions() {
    try {
        const tk = localStorage.getItem('cbt') || '';
        const res = await fetch('/api/sessions', { headers: { Authorization: tk } });
        if (!res.ok) return;
        const data = await res.json();
        rdPipSessions = data.sessions || [];
        if (!rdPipSession && rdPipSessions.length > 0) {
            rdPipSession = data.current || rdPipSessions[0].name;
        }
        const sel = document.getElementById('rd-pip-session');
        if (sel) {
            sel.innerHTML = rdPipSessions.map(s =>
                `<option value="${s.name}" ${s.name === rdPipSession ? 'selected' : ''}>${s.name}</option>`
            ).join('');
        }
    } catch(e) {}
}

function rdPipSwitchSession(name) {
    rdPipSession = name;
    rdPipRefresh();
}

async function rdPipRefresh() {
    if (!rdPipOpen) return;
    try {
        const tk = localStorage.getItem('cbt') || '';
        const session = rdPipSession || 'claude';
        const res = await fetch(`/api/output?session=${encodeURIComponent(session)}`, { headers: { Authorization: tk } });
        if (!res.ok) return;
        const data = await res.json();
        const output = document.getElementById('rd-pip-output');
        if (!output) return;

        const raw = data.output || '';
        // Strip ANSI codes
        const clean = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/[\x00-\x1F]/g, ' ');
        const lines = clean.split('\n').filter(l => l.trim());
        const showLines = rdPipExpanded ? 20 : 8;
        const wasAtBottom = (output.scrollHeight - output.scrollTop - output.clientHeight) < 30;
        output.textContent = lines.slice(-showLines).join('\n');
        if (wasAtBottom) output.scrollTop = output.scrollHeight;

        // Detect status
        const statusEl = document.getElementById('rd-pip-status');
        const lastLines = lines.slice(-10).join('\n');
        const hasPermission = /\[Y\/n\]|\[A\]llow|\[D\]eny|Allow|Deny|permission/i.test(lastLines);
        const isWorking = /Reading|Writing|Editing|Running|Task|Searching|Indexing/i.test(lastLines);

        if (hasPermission) {
            if (statusEl) { statusEl.textContent = '[!]'; statusEl.className = 'rd-pip-status permission'; }
            // Show permission bar
            const permBar = document.getElementById('rd-pip-perm');
            const permText = document.getElementById('rd-pip-perm-text');
            if (permBar) permBar.style.display = 'flex';
            // Extract permission line
            const permLine = lines.filter(l => /\[Y\/n\]|\[A\]llow|\[D\]eny|Allow|Deny/i.test(l)).pop() || '';
            if (permText) permText.textContent = permLine.slice(0, 80);
        } else {
            const permBar = document.getElementById('rd-pip-perm');
            if (permBar) permBar.style.display = 'none';
            if (isWorking) {
                if (statusEl) { statusEl.textContent = '[*]'; statusEl.className = 'rd-pip-status working'; }
            } else {
                if (statusEl) { statusEl.textContent = '[~]'; statusEl.className = 'rd-pip-status idle'; }
            }
        }
    } catch(e) {}
}

async function rdPipApprove() {
    const tk = localStorage.getItem('cbt') || '';
    const session = rdPipSession || 'claude';
    try {
        await fetch('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: tk },
            body: JSON.stringify({ prompt: 'y', session, vault: false })
        });
        if (typeof toast === 'function') toast('APPROVED', 'success');
        const permBar = document.getElementById('rd-pip-perm');
        if (permBar) permBar.style.display = 'none';
        setTimeout(rdPipRefresh, 1000);
    } catch(e) {}
}

async function rdPipDeny() {
    const tk = localStorage.getItem('cbt') || '';
    const session = rdPipSession || 'claude';
    try {
        await fetch('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: tk },
            body: JSON.stringify({ prompt: 'n', session, vault: false })
        });
        if (typeof toast === 'function') toast('DENIED', 'error');
        const permBar = document.getElementById('rd-pip-perm');
        if (permBar) permBar.style.display = 'none';
        setTimeout(rdPipRefresh, 1000);
    } catch(e) {}
}

// Draggable PiP
function rdPipInitDrag() {
    const header = document.getElementById('rd-pip-header');
    const pip = document.getElementById('rd-nexus-pip');
    if (!header || !pip) return;

    function onStart(e) {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        const t = e.touches ? e.touches[0] : e;
        const rect = pip.getBoundingClientRect();
        rdPipDragOffX = t.clientX - rect.left;
        rdPipDragOffY = t.clientY - rect.top;
        rdPipDragging = true;
    }
    function onMove(e) {
        if (!rdPipDragging) return;
        e.preventDefault();
        const t = e.touches ? e.touches[0] : e;
        const x = Math.max(0, Math.min(window.innerWidth - 60, t.clientX - rdPipDragOffX));
        const y = Math.max(0, Math.min(window.innerHeight - 40, t.clientY - rdPipDragOffY));
        pip.style.left = x + 'px';
        pip.style.top = y + 'px';
        pip.style.right = 'auto';
        pip.style.bottom = 'auto';
    }
    function onEnd() { rdPipDragging = false; }

    header.addEventListener('touchstart', onStart, { passive: false });
    header.addEventListener('mousedown', onStart);
    document.addEventListener('touchmove', (e) => { if (rdPipDragging) onMove(e); }, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchend', onEnd);
    document.addEventListener('mouseup', onEnd);
}

// ═══════════════════════════════════════════════════════════════════
// AUDIO STREAMING - Raw PCM from Windows WASAPI loopback via ffmpeg
// ═══════════════════════════════════════════════════════════════════

let rdAudioWs = null;
let rdAudioCtx = null;
let rdAudioActive = false;
let rdAudioBufferQueue = [];
let rdAudioNextTime = 0;

// ── Stream shape, and what it costs ────────────────────────────────────
// This stream is uncompressed PCM, so the bill is pure arithmetic:
// rate x 2 bytes x channels, every second it stays connected. The old
// fixed 48 kHz stereo is 192 KB/s -- 691 MB PER HOUR of mobile data,
// spent identically whether music is playing or the PC is silent.
//
// The server now also gates silence, so an idle desktop costs ~nothing.
// These presets cover the rest. The hourly figure is rendered next to
// each one in the picker: this is a choice that should never be made
// without the number in view.
const RD_AUDIO_PRESETS = [
    { id: 'full',  label: 'FULL',   rate: 48000, ch: 2 },
    { id: 'high',  label: 'HIGH',   rate: 48000, ch: 1 },
    { id: 'med',   label: 'MEDIUM', rate: 24000, ch: 1 },
    { id: 'low',   label: 'LOW',    rate: 16000, ch: 1 },
    { id: 'voice', label: 'VOICE',  rate: 8000,  ch: 1 },
];
const RD_AUDIO_PRESET_KEY = 'tsrct_rd_audio_preset';
// MEDIUM by default, not FULL. This room is reached over mobile data more
// often than not, and 691 MB/hour was never a default anybody picked -- it
// was just the first thing that worked.
let rdAudioPreset = RD_AUDIO_PRESETS[2];
const RD_AUDIO_BUFFER_SIZE = 4096; // samples per buffer (per channel)

function rdAudioMbPerHour(p) { return Math.round(p.rate * 2 * p.ch * 3600 / 1e6); }

function rdAudioLoadPreset() {
    try {
        const p = RD_AUDIO_PRESETS.find(x => x.id === localStorage.getItem(RD_AUDIO_PRESET_KEY));
        if (p) rdAudioPreset = p;
    } catch (e) {}
}
rdAudioLoadPreset();

function rdAudioToggle() {
    if (rdAudioActive) {
        rdAudioStop();
    } else {
        rdAudioStart();
    }
}

async function rdAudioStart() {
    if (rdAudioActive) return;

    const token = localStorage.getItem('cbt') || '';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${location.host}/api/vnc/audio?token=${encodeURIComponent(token)}`
                + `&rate=${rdAudioPreset.rate}&ch=${rdAudioPreset.ch}`;

    rdLog(`audio: connecting at ${rdAudioPreset.rate}Hz/${rdAudioPreset.ch}ch `
        + `(~${rdAudioMbPerHour(rdAudioPreset)} MB/h)`);

    try {
        // Context at the device's OWN rate, not the stream's. Web Audio
        // resamples an AudioBuffer that declares a different sampleRate, so
        // this plays every preset -- including 8 kHz, which a hardware context
        // may refuse to be constructed at.
        rdAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
        rdLog('audio: AudioContext failed: ' + e.message);
        if (typeof toast === 'function') toast('Audio not supported', 'error');
        return;
    }

    rdAudioWs = new WebSocket(wsUrl);
    rdAudioWs.binaryType = 'arraybuffer';
    rdAudioBufferQueue = [];
    rdAudioNextTime = 0;

    rdAudioWs.onopen = () => {
        rdLog('audio: WebSocket connected');
        rdAudioActive = true;
        rdAudioUpdateBtn();
        if (typeof toast === 'function') toast('Audio streaming', 'success');
    };

    rdAudioWs.onmessage = (e) => {
        if (typeof e.data === 'string') {
            // Control/error message from server
            try {
                const msg = JSON.parse(e.data);
                if (msg.error) {
                    rdLog('audio: server error: ' + msg.message);
                    if (typeof toast === 'function') toast('Audio: ' + (msg.message || msg.error), 'error');
                    rdAudioStop();
                }
            } catch (_) {}
            return;
        }

        // Binary: raw PCM s16le stereo 48kHz
        rdAudioScheduleBuffer(e.data);
    };

    rdAudioWs.onerror = (e) => {
        rdLog('audio: WebSocket error');
    };

    rdAudioWs.onclose = () => {
        rdLog('audio: WebSocket closed');
        if (rdAudioActive) {
            rdAudioActive = false;
            rdAudioUpdateBtn();
            if (typeof toast === 'function') toast('Audio disconnected', 'info');
        }
    };
}

function rdAudioScheduleBuffer(arrayBuffer) {
    if (!rdAudioCtx || rdAudioCtx.state === 'closed') return;

    // Resume context if suspended (autoplay policy)
    if (rdAudioCtx.state === 'suspended') {
        rdAudioCtx.resume();
    }

    const channels = rdAudioPreset.ch;
    const pcmData = new Int16Array(arrayBuffer);
    const numSamples = Math.floor(pcmData.length / channels);
    if (numSamples < 1) return;

    // Buffer declares the STREAM's rate; the context resamples on playback.
    const audioBuffer = rdAudioCtx.createBuffer(channels, numSamples, rdAudioPreset.rate);

    // Deinterleave and convert Int16 -> Float32
    for (let ch = 0; ch < channels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < numSamples; i++) {
            channelData[i] = pcmData[i * channels + ch] / 32768;
        }
    }

    // Schedule playback with minimal latency
    const source = rdAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(rdAudioCtx.destination);

    const currentTime = rdAudioCtx.currentTime;
    // Keep a small buffer ahead to prevent gaps (50ms lookahead)
    if (rdAudioNextTime < currentTime) {
        rdAudioNextTime = currentTime + 0.05;
    }

    source.start(rdAudioNextTime);
    rdAudioNextTime += audioBuffer.duration;
}

function rdAudioStop() {
    rdAudioActive = false;

    if (rdAudioWs) {
        try { rdAudioWs.close(); } catch (e) {}
        rdAudioWs = null;
    }

    if (rdAudioCtx) {
        try { rdAudioCtx.close(); } catch (e) {}
        rdAudioCtx = null;
    }

    rdAudioBufferQueue = [];
    rdAudioNextTime = 0;
    rdAudioUpdateBtn();
    rdLog('audio: stopped');
}

function rdAudioUpdateBtn() {
    const btn = document.getElementById('rd-audio-btn');
    if (btn) {
        btn.classList.toggle('active', rdAudioActive);
        btn.title = rdAudioActive ? 'Stop Audio' : 'Stream Audio';
    }
}

// Audio device picker
async function rdAudioShowDevices(forceOpen) {
    const token = localStorage.getItem('cbt') || '';
    const panel = document.getElementById('rd-audio-panel');
    if (!panel) return;

    // Toggle -- unless a caller is REFRESHING after changing a setting, in
    // which case closing the panel is the opposite of what it wants. Picking a
    // device used to do exactly that: the "refresh to show the selection" call
    // hit this toggle and shut the panel instead.
    if (!forceOpen && panel.style.display === 'flex') {
        panel.style.display = 'none';
        return;
    }

    panel.innerHTML = rdAudioQualityHtml()
        + '<div style="padding:8px;color:var(--dim);">Scanning devices...</div>';
    panel.style.display = 'flex';

    try {
        const res = await fetch('/api/vnc/audio/devices', {
            headers: { Authorization: token }
        });
        const data = await res.json();

        if (data.error || !data.devices || data.devices.length === 0) {
            panel.innerHTML = rdAudioQualityHtml()
                + '<div style="padding:8px;color:#ff4444;">No audio devices found. Is ffmpeg.exe installed?</div>';
            return;
        }

        const selected = data.selected || '';
        panel.innerHTML = rdAudioQualityHtml() + data.devices.map(d =>
            `<button class="rd-audio-device ${d === selected ? 'selected' : ''}" onclick="rdAudioSelectDevice('${d.replace(/'/g, "\\'")}')">` +
            `${d === selected ? '[*] ' : '[ ] '}${d}</button>`
        ).join('');
    } catch (e) {
        panel.innerHTML = rdAudioQualityHtml()
            + '<div style="padding:8px;color:#ff4444;">Failed to list devices</div>';
    }
}

// The quality picker, with the hourly data cost printed on every row. The
// number is the whole point: FULL and VOICE differ by 12x, and nothing in
// the UI used to say so.
function rdAudioQualityHtml() {
    return '<div class="rd-audio-quality-hdr">STREAM QUALITY &middot; MOBILE DATA</div>'
        + RD_AUDIO_PRESETS.map(p => {
            const on = p.id === rdAudioPreset.id;
            return `<button class="rd-audio-device rd-audio-quality ${on ? 'selected' : ''}" `
                 + `onclick="rdAudioSelectPreset('${p.id}')">`
                 + `${on ? '[*] ' : '[ ] '}${p.label}`
                 + `<span class="rd-audio-cost">~${rdAudioMbPerHour(p)} MB/h</span>`
                 + `</button>`;
        }).join('')
        + '<div class="rd-audio-quality-note">Silence is not sent, so an idle PC costs nothing.</div>'
        + '<div class="rd-audio-quality-hdr">CAPTURE DEVICE</div>';
}

function rdAudioSelectPreset(id) {
    const p = RD_AUDIO_PRESETS.find(x => x.id === id);
    if (!p) return;
    rdAudioPreset = p;
    try { localStorage.setItem(RD_AUDIO_PRESET_KEY, id); } catch (e) {}
    rdAudioShowDevices(true);   // re-render with the new row marked
    if (typeof toast === 'function') {
        toast(`Audio ${p.label} - ~${rdAudioMbPerHour(p)} MB/h`, 'success');
    }
    // The shape is fixed at connect time, so an active stream has to be redialled.
    if (rdAudioActive) {
        rdAudioStop();
        setTimeout(() => rdAudioStart(), 300);
    }
}

async function rdAudioSelectDevice(device) {
    const token = localStorage.getItem('cbt') || '';
    try {
        await fetch('/api/vnc/audio/device', {
            method: 'POST',
            headers: { Authorization: token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ device })
        });
        if (typeof toast === 'function') toast('Audio: ' + device, 'success');
        // Refresh device list to show selection
        rdAudioShowDevices(true);
        // Restart audio if active
        if (rdAudioActive) {
            rdAudioStop();
            setTimeout(() => rdAudioStart(), 300);
        }
    } catch (e) {
        if (typeof toast === 'function') toast('Failed to set device', 'error');
    }
}


// ═══════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════

function rdSaveSettings() { try { localStorage.setItem(RD_SETTINGS_KEY, JSON.stringify({ host: document.getElementById('rd-host')?.value, port: document.getElementById('rd-port')?.value, quality: document.getElementById('rd-quality-slider')?.value, adaptiveQuality: rdAdaptiveQuality, pointerSpeed: rdPointerSpeed })); } catch(e) {} }
function rdLoadSettings() { try { const r = localStorage.getItem(RD_SETTINGS_KEY); if (!r) return; const s = JSON.parse(r); if (s.host) document.getElementById('rd-host').value = s.host; if (s.port) document.getElementById('rd-port').value = s.port; if (s.quality) { document.getElementById('rd-quality-slider').value = s.quality; document.getElementById('rd-quality-value').textContent = s.quality; rdUserQuality = parseInt(s.quality); rdIdleQuality = Math.min(9, rdUserQuality + 2); rdActiveQuality = Math.max(0, rdUserQuality - 3); } if (s.adaptiveQuality !== undefined) rdAdaptiveQuality = s.adaptiveQuality; if (s.pointerSpeed !== undefined) { rdPointerSpeed = Math.max(0.3, Math.min(2, Number(s.pointerSpeed) || RD_SPEED_DEFAULT)); const sl = document.getElementById('rd-speed-slider'); if (sl) sl.value = Math.round(rdPointerSpeed * 100); const sv = document.getElementById('rd-speed-value'); if (sv) sv.textContent = rdPointerSpeed.toFixed(2) + 'x'; } } catch(e) {} }

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

window.rdInit = rdInit;
window.rdConnect = rdConnect;
window.rdDisconnect = rdDisconnect;
window.rdToggleKeyboard = rdToggleKeyboard;
window.rdToggleNativeKeyboard = rdToggleNativeKeyboard;
window.rdToggleKeysExpanded = rdToggleKeysExpanded;
window.rdToggleClipboard = rdToggleClipboard;
window.rdSendClipboard = rdSendClipboard;
window.rdFitToScreen = rdFitToScreen;
window.rdCycleMonitor = rdCycleMonitor;
window.rdPullWindowHere = rdPullWindowHere;
window.rdToggleSolo = rdToggleSolo;
window.rdToggleQuality = rdToggleQuality;
window.rdSetQuality = rdSetQuality;
window.rdSetPointerSpeed = rdSetPointerSpeed;
window.rdToggleFullscreen = rdToggleFullscreen;
window.rdVrTesla = rdVrTesla;
window.rdSetKeyboardActive = rdSetKeyboardActive;
window.rdSendKey = rdSendKey;
window.rdToggleModifier = rdToggleModifier;
window.rdSendCombo = rdSendCombo;
window.rdCopy = rdCopy;
window.rdPaste = rdPaste;
window.rdShowToolbar = rdShowToolbar;
window.rdToggleQuickActions = rdToggleQuickActions;
window.rdExecuteAction = rdExecuteAction;
window.rdResetZoom = rdResetZoom;
window.rdClickAtCursor = rdClickAtCursor;
window.rdClickDown = rdClickDown;
window.rdClickUp = rdClickUp;
window.rdDoubleClickAtCursor = rdDoubleClickAtCursor;
window.rdRightClickAtCursor = rdRightClickAtCursor;
window.rdToggleDrag = rdToggleDrag;
window.rdToggleTerminalOverlay = rdToggleTerminalOverlay;
window.rdOverlaySend = rdOverlaySend;
window.rdSwitchOverlaySession = rdSwitchOverlaySession;
window.rdOverlayToggleMic = rdOverlayToggleMic;
window.rdOverlayUpload = rdOverlayUpload;
window.rdOverlayServerGallery = rdOverlayServerGallery;
window.rdOverlayAttached = rdOverlayAttached;
window.rdUpdateOverlayAttachIndicator = rdUpdateOverlayAttachIndicator;
window.rdVncDictateToggle = rdVncDictateToggle;
window.rdClipOcrGrab = rdClipOcrGrab;
window.rdClipOcrCancel = rdClipOcrCancel;
window.rdPipToggle = rdPipToggle;
window.rdPipClose = rdPipClose;
window.rdPipToggleSize = rdPipToggleSize;
window.rdPipSwitchSession = rdPipSwitchSession;
window.rdPipApprove = rdPipApprove;
window.rdPipDeny = rdPipDeny;
window.rdAudioToggle = rdAudioToggle;
window.rdAudioShowDevices = rdAudioShowDevices;
window.rdAudioSelectDevice = rdAudioSelectDevice;
window.rdAudioSelectPreset = rdAudioSelectPreset;
window.rdVrToggle = rdVrToggle;
window.rdVrShowSettings = rdVrShowSettings;
window.rdVrSelectParam = rdVrSelectParam;
window.rdVrConfirmParam = rdVrConfirmParam;
window.rdVrRecenter = rdVrRecenter;
window.rdVrTap = rdVrTap;
window.rdVrGoHub = rdVrGoHub;
window.rdVrGoDesktop = rdVrGoDesktop;
window.rdVrToggle360 = rdVrToggle360;
window.rdVrReload = rdVrReload;
window.rdVrToggleLang = rdVrToggleLang;
window.rdVrSendEnter = rdVrSendEnter;
window.rdVrSendBackspace = rdVrSendBackspace;

// Auto-restart VR after reload
(function() {
    if (!localStorage.getItem('tsrct_vr_autorestart')) return;
    // Try multiple hooks to ensure we catch the right moment
    function tryAutoRestart() {
        if (typeof WorldManager !== 'undefined' && WorldManager.open) {
            rdVrCheckAutoRestart();
        } else {
            setTimeout(tryAutoRestart, 500);
        }
    }
    if (document.readyState === 'complete') {
        setTimeout(tryAutoRestart, 300);
    } else {
        window.addEventListener('load', () => setTimeout(tryAutoRestart, 300));
    }
})();

// Read by remote-desktop-vr.js (moved out of this file, cleanup P2 #12).
export {
    rdConnect,
    rdConnected,
    rdFindCanvas,
    rdLog,
    rdOverlaySession,
    rdRfb,
    rdSendPointer,
    rdShowConnectedUI,
    rdVncDictateToggle,
    rdVncWantRecording,
};
