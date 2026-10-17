/* ==============================================
   TSRCT - Remote desktop: VR (cardboard) mode
   ============================================== */
// Moved out of remote-desktop.js (cleanup P2 #12). The two modules import each
// other. This one is evaluated FIRST, so nothing at its top level may read a
// binding from remote-desktop.js (only code inside functions does). Imported
// bindings are read-only: remote-desktop.js changes VR state only through
// rdVrSetTerminalMode / rdVrInsertAtCursor.
import {
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
} from './remote-desktop.js';

// ═══════════════════════════════════════════════════════════════════
// VR CARDBOARD MODE - Clean Stereo Split
// Strategy: Canvas 2D side-by-side with GPU-accelerated CSS filters for
// brightness/contrast/sharpening. No barrel distortion (blurs text).
// Mouse uses rdSendPointer() which handles all noVNC versions.
// Head tracking uses heavy complementary filter for stability.
// ═══════════════════════════════════════════════════════════════════

let rdVrActive = false;
let rdVrCtx = null;
let rdVrRaf = null;
let rdVrPanX = 0;          // legacy horizontal pan (used by desktop VNC scene internally)
let rdVrPanY = 0;          // vertical pan (pitch) - smoothed
let rdVrTargetPanX = 0;
let rdVrTargetPanY = 0;
let rdVrOrientationHandler = null;
let rdVrScreenAngle = 0;

// 360-degree yaw tracking
let rdVrYaw = 0;            // smoothed yaw (0-360 degrees)
let rdVrTargetYaw = 0;      // raw integrated yaw from gyroscope
let rdVrLastFacingScene = null; // for lifecycle hysteresis
let rdVr360Mode = false;    // toggle: true = 360 head rotation, false = flat pan mode (for lying down)
// Multi-monitor (Option A: auto-detect by aspect). VNC sends extended displays as
// ONE ultra-wide framebuffer; an aspect >= this is treated as 2+ equal monitors
// (50% split) so each is scaled readable and head-pan sweeps across them.
const RD_MULTIMON_ASPECT = 2.4;

// Settings (persisted)
const RD_VR_SETTINGS_KEY = 'tsrct_rd_vr';
let rdVrScale = 1.4;       // zoom (>1 = bigger text, default comfortable reading)
let rdVrIPD = 0;            // pixel offset between eyes
let rdVrVOffset = 0;        // vertical lens alignment offset (px)
let rdVrBrightness = 20;    // extra brightness to compensate lens light loss (0-80)
let rdVrContrast = 1.2;     // contrast boost for text clarity (1.0-2.0)
let rdVrSensitivity = 60;   // head tracking sensitivity (1=sluggish, 100=precise 1:1)
let rdVrSaturate = 100;     // color saturation % (100=normal, 0=grayscale, 150=vivid)
let rdVrWarmth = 0;         // color temperature shift (0=neutral, +50=warm/yellow, -50=cool/blue)
let rdVrBlur = 0;           // slight blur to reduce pixel grid/sharpen (0=off, 0.5=soft)
let rdVrInvert = 0;         // invert colors % (0=normal, 100=full invert for dark mode)
let rdVrNightMode = 0;      // blue light filter (0=off, 100=full warm)

// Immersive VR state
let rdVrSessionStart = 0;   // timestamp when VR started
let rdVrFadeIn = 0;         // fade-in opacity (0=black, 1=fully visible)
let rdVrClickRipples = [];  // [{x, y, t, eye}] active click ripples
let rdVrFrameCount = 0;     // frame counter for animations
let rdVrTerminalMode = false; // legacy - replaced by scene system
let rdVrTerminalCanvas = null; // offscreen canvas for terminal VR rendering

// VR Native Interface - Scene system
let rdVrScene = 'desktop';       // 'desktop' | 'hub' | 'session' | 'permissions'
let rdVrTransition = null;       // { from, to, progress, startTime, duration }
let rdVrHubCanvas = null;        // offscreen canvas for hub
let rdVrSessionCanvas = null;    // offscreen canvas for session view
let rdVrPermCanvas = null;       // offscreen canvas for permissions
let rdVrNativeData = {
    sessions: [],
    permissions: [],
    activeSession: null,
    lastFetch: 0,
    output: '',
    outputSession: null,
    outputScroll: 0
};
let rdVrNativePollTimer = null;
let rdVrHubHover = -1;           // which card cursor is over
let rdVrPermHover = -1;          // which perm card cursor is over
let rdVrSessionHover = null;     // which button cursor is over in session view
let rdVrInputBuffer = '';        // text being composed in VR native session view
let rdVrInputCursor = 0;         // cursor position within buffer (0 = start)
let rdVrInputHandler = null;     // keyboard event handler for VR input

// The rest of the file changes VR state only through these (an imported
// binding is read-only, and the VR code lives in its own module).
function rdVrSetTerminalMode(on) { rdVrTerminalMode = on; }
// Dictation in the VR session view: insert at the cursor, with a space before
// it unless the buffer already ends in one.
function rdVrInsertAtCursor(text) {
    const space = (rdVrInputCursor > 0 && rdVrInputBuffer[rdVrInputCursor - 1] !== ' ') ? ' ' : '';
    const insert = space + text;
    rdVrInputBuffer = rdVrInputBuffer.slice(0, rdVrInputCursor) + insert + rdVrInputBuffer.slice(rdVrInputCursor);
    rdVrInputCursor += insert.length;
}

function rdVrLoadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(RD_VR_SETTINGS_KEY));
        if (s) {
            if (s.scale !== undefined) rdVrScale = s.scale;
            if (s.ipd !== undefined) rdVrIPD = s.ipd;
            if (s.voffset !== undefined) rdVrVOffset = s.voffset;
            if (s.brightness !== undefined) rdVrBrightness = s.brightness;
            if (s.contrast !== undefined) rdVrContrast = s.contrast;
            if (s.sensitivity !== undefined) rdVrSensitivity = s.sensitivity;
            if (s.saturate !== undefined) rdVrSaturate = s.saturate;
            if (s.warmth !== undefined) rdVrWarmth = s.warmth;
            if (s.blur !== undefined) rdVrBlur = s.blur;
            if (s.invert !== undefined) rdVrInvert = s.invert;
            if (s.nightMode !== undefined) rdVrNightMode = s.nightMode;
        }
    } catch (_) {}
}
function rdVrSaveSettings() {
    try { localStorage.setItem(RD_VR_SETTINGS_KEY, JSON.stringify({
        scale: rdVrScale, ipd: rdVrIPD, voffset: rdVrVOffset,
        brightness: rdVrBrightness, contrast: rdVrContrast,
        sensitivity: rdVrSensitivity, saturate: rdVrSaturate,
        warmth: rdVrWarmth, blur: rdVrBlur, invert: rdVrInvert,
        nightMode: rdVrNightMode
    })); } catch (_) {}
}

function rdVrToggle() {
    if (rdVrActive) rdVrStop(); else rdVrStart();
}

function rdVrStart() {
    if (!rdConnected || !rdRfb) {
        if (typeof toast === 'function') toast('Connect to VNC first', 'error');
        return;
    }

    const overlay = document.getElementById('rd-vr-overlay');
    const canvas = document.getElementById('rd-vr-canvas');
    if (!overlay || !canvas) return;

    rdVrLoadSettings();
    rdVrDetectOrientation();

    // Use Canvas 2D for pixel-perfect rendering (no WebGL resampling)
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        if (typeof toast === 'function') toast('Canvas not supported', 'error');
        return;
    }

    rdVrCtx = ctx;
    rdVrActive = true;
    document.body.dataset.teslaWhere = 'vr';   // Tesla reads "abri..." as his PC while he is in here (assistant.js ask)
    rdVrPanX = 0;
    rdVrPanY = 0;

    // Show overlay, hide normal UI
    overlay.style.display = 'flex';
    const toolbar = document.getElementById('rd-toolbar');
    const clickStrip = document.getElementById('rd-click-strip');
    const scrollBar = document.getElementById('rd-scroll-bar');
    if (toolbar) toolbar.style.display = 'none';
    if (clickStrip) clickStrip.classList.remove('visible');
    if (scrollBar) scrollBar.style.display = 'none';

    // Fullscreen + landscape
    const room = document.getElementById('remote-room');
    if (room) {
        const goFs = room.requestFullscreen || room.webkitRequestFullscreen;
        if (goFs) {
            goFs.call(room).then(() => {
                if (screen.orientation && screen.orientation.lock)
                    screen.orientation.lock('landscape').catch(() => {});
            }).catch(() => {});
        }
    }

    rdVrResize();
    window.addEventListener('resize', rdVrResize);
    rdVrStartTracking();
    rdVrAttachMouse();
    rdVrRender();

    if (screen.orientation) {
        screen.orientation.addEventListener('change', rdVrOnOrientationChange);
    }
    window.addEventListener('orientationchange', rdVrOnOrientationChange);

    const btn = document.getElementById('rd-vr-btn');
    if (btn) btn.classList.add('active');

    // Apply saved IPD offset to HTML controls
    const controls = document.querySelector('.rd-vr-controls');
    if (controls) controls.style.marginLeft = (-rdVrIPD) + 'px';

    // Immersive: cinematic fade-in and session timer
    rdVrFadeIn = 0;
    rdVrSessionStart = Date.now();
    rdVrClickRipples = [];
    rdVrFrameCount = 0;

    rdLog('vr: started (canvas2d, no distortion)');
    if (typeof toast === 'function') toast('VR Mode ON', 'success');
}

function rdVrStop() {
    rdVrActive = false;
    delete document.body.dataset.teslaWhere;
    if (rdVrRaf) { cancelAnimationFrame(rdVrRaf); rdVrRaf = null; }
    rdVrStopTracking();
    rdVrDetachMouse();
    window.removeEventListener('resize', rdVrResize);
    if (screen.orientation) {
        screen.orientation.removeEventListener('change', rdVrOnOrientationChange);
    }
    window.removeEventListener('orientationchange', rdVrOnOrientationChange);

    const overlay = document.getElementById('rd-vr-overlay');
    if (overlay) overlay.style.display = 'none';

    const settings = document.getElementById('rd-vr-settings');
    if (settings) settings.style.display = 'none';

    if (rdConnected) rdShowConnectedUI();

    rdVrCtx = null;

    const btn = document.getElementById('rd-vr-btn');
    if (btn) btn.classList.remove('active');
    rdLog('vr: stopped');
    if (typeof toast === 'function') toast('VR Mode OFF', 'info');
}

function rdVrDetectOrientation() {
    if (screen.orientation && screen.orientation.angle !== undefined) {
        rdVrScreenAngle = screen.orientation.angle;
    } else if (window.orientation !== undefined) {
        rdVrScreenAngle = window.orientation;
    } else {
        rdVrScreenAngle = 90;
    }
}

function rdVrOnOrientationChange() {
    rdVrDetectOrientation();
    rdVrResize();
}

function rdVrResize() {
    const canvas = document.getElementById('rd-vr-canvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
}

// Main render loop: draw VNC canvas into left and right eye halves
let rdVrLastSentPointer = null;   // the last point sent to VNC (see the cursor block below)


function rdVrDrawEyeFrames(ctx, halfW, ch, vrAccent, t, dpr) {
    for (let eye = 0; eye < 2; eye++) {
        const ox = eye * halfW;
        const cx2 = halfW / 2;
        const cy2 = ch / 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, 0, halfW, ch);
        ctx.clip();

        const gridLines = 16;
        const gridCols = 12;
        ctx.strokeStyle = vrAccent;
        ctx.lineWidth = 1;

        // Floor grid - horizontal lines
        for (let i = 1; i <= gridLines; i++) {
            const depth = i / gridLines;
            const y = cy2 + (ch / 2) * depth;
            const perspScale = 0.2 + depth * 0.8;
            const alpha = 0.08 + (1 - depth) * 0.12;
            ctx.globalAlpha = alpha;
            const x1 = ox + cx2 - cx2 * perspScale;
            const x2 = ox + cx2 + cx2 * perspScale;
            ctx.beginPath();
            ctx.moveTo(x1, y); ctx.lineTo(x2, y);
            ctx.stroke();
        }

        // Ceiling grid - horizontal lines
        for (let i = 1; i <= gridLines; i++) {
            const depth = i / gridLines;
            const y = cy2 - (ch / 2) * depth;
            const perspScale = 0.2 + depth * 0.8;
            const alpha = 0.06 + (1 - depth) * 0.08;
            ctx.globalAlpha = alpha;
            const x1 = ox + cx2 - cx2 * perspScale;
            const x2 = ox + cx2 + cx2 * perspScale;
            ctx.beginPath();
            ctx.moveTo(x1, y); ctx.lineTo(x2, y);
            ctx.stroke();
        }

        // Vertical converging lines (floor + ceiling)
        ctx.globalAlpha = 0.1;
        for (let i = -gridCols / 2; i <= gridCols / 2; i++) {
            const xBottom = ox + cx2 + (i / gridCols) * halfW * 0.9;
            ctx.beginPath();
            ctx.moveTo(ox + cx2, cy2);
            ctx.lineTo(xBottom, ch);
            ctx.stroke();
            // Ceiling mirror
            ctx.beginPath();
            ctx.moveTo(ox + cx2, cy2);
            ctx.lineTo(xBottom, 0);
            ctx.stroke();
        }

        // Floating particles - bigger, brighter, more of them
        ctx.fillStyle = vrAccent;
        for (let p = 0; p < 15; p++) {
            const seed = p * 137.5 + eye * 50;
            const px = ox + (Math.sin(seed + t * 0.7) * 0.5 + 0.5) * halfW;
            const py = (Math.cos(seed * 1.3 + t * 0.5) * 0.5 + 0.5) * ch;
            const sz = (Math.sin(seed * 2.1 + t) * 0.5 + 1.5) * dpr;
            const alpha = (Math.sin(seed * 0.7 + t * 1.5) * 0.5 + 0.5) * 0.2;
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(px, py, sz, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }
}


// Desktop VNC scene (renders when facing.scene === 'desktop' OR legacy terminal mode)
function rdVrDrawDesktopScene(facing, ctx, halfW, ch, baseX, baseY, drawW, drawH, dpr, vncCanvas, rdMonitorCount) {
    if (facing.scene === 'desktop' || rdVrTerminalMode) {
    if (rdVrTerminalMode) {
        const termOut = document.getElementById('rd-terminal-output');
        const termText = termOut ? termOut.textContent : '';
        const lines = termText.split('\n').slice(-35);

        // Create/reuse offscreen canvas for terminal rendering
        if (!rdVrTerminalCanvas) {
            rdVrTerminalCanvas = document.createElement('canvas');
        }
        const tc = rdVrTerminalCanvas;
        // Size it like a virtual monitor (16:9)
        tc.width = 960;
        tc.height = 540;
        const tctx = tc.getContext('2d');

        // Draw terminal background
        tctx.fillStyle = 'rgba(2, 6, 14, 0.95)';
        tctx.fillRect(0, 0, tc.width, tc.height);

        // Border
        tctx.strokeStyle = 'rgba(48, 208, 255, 0.3)';
        tctx.lineWidth = 2;
        tctx.strokeRect(1, 1, tc.width - 2, tc.height - 2);

        // Header bar
        const sessName = typeof rdOverlaySession === 'string' ? rdOverlaySession : 'terminal';
        tctx.fillStyle = 'rgba(48, 208, 255, 0.15)';
        tctx.fillRect(0, 0, tc.width, 22);
        tctx.font = 'bold 12px monospace';
        tctx.fillStyle = '#30d0ff';
        tctx.textBaseline = 'top';
        tctx.fillText(' [' + sessName + ']', 6, 5);

        // Terminal text
        tctx.font = '13px monospace';
        tctx.fillStyle = '#30d0ff';
        const lh = 15;
        const maxLines = Math.floor((tc.height - 30) / lh);
        const visLines = lines.slice(-maxLines);
        for (let i = 0; i < visLines.length; i++) {
            tctx.fillText(visLines[i], 8, 28 + i * lh, tc.width - 16);
        }

        // Now draw this terminal canvas exactly like the VNC desktop (stereo split)
        ctx.filter = 'none';
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, halfW, ch); ctx.clip();
        ctx.drawImage(tc, baseX - rdVrIPD, baseY, drawW, drawH);
        ctx.restore();

        ctx.save();
        ctx.beginPath(); ctx.rect(halfW, 0, halfW, ch); ctx.clip();
        ctx.drawImage(tc, halfW + baseX + rdVrIPD, baseY, drawW, drawH);
        ctx.restore();

        // Screen border glow for terminal
        ctx.strokeStyle = 'rgba(48, 208, 255, 0.2)';
        ctx.lineWidth = 1 * dpr;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, halfW, ch); ctx.clip();
        ctx.strokeRect(baseX - rdVrIPD, baseY, drawW, drawH);
        ctx.restore();
        ctx.save();
        ctx.beginPath(); ctx.rect(halfW, 0, halfW, ch); ctx.clip();
        ctx.strokeRect(halfW + baseX + rdVrIPD, baseY, drawW, drawH);
        ctx.restore();

    } else {

    // ── Build CSS filter string ──
    const bright = 1 + (rdVrBrightness / 100);
    const contr = rdVrContrast;
    const sat = rdVrSaturate / 100;
    const inv = rdVrInvert / 100;
    const blr = rdVrBlur > 0 ? ` blur(${rdVrBlur}px)` : '';
    const warmStr = rdVrWarmth > 0 ? ` sepia(${rdVrWarmth / 100})` : (rdVrWarmth < 0 ? ` hue-rotate(${rdVrWarmth * 2}deg)` : '');
    // Night mode: additive sepia filter for blue light reduction
    const nightStr = rdVrNightMode > 0 ? ` sepia(${rdVrNightMode / 100})` : '';
    ctx.filter = `brightness(${bright}) contrast(${contr}) saturate(${sat}) invert(${inv})${warmStr}${nightStr}${blr}`;

    ctx.imageSmoothingEnabled = rdVrScale < 2.0;
    ctx.imageSmoothingQuality = 'high';

    // ── Draw VNC desktop in both eyes ──
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, halfW, ch); ctx.clip();
    ctx.drawImage(vncCanvas, baseX - rdVrIPD, baseY, drawW, drawH);
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(halfW, 0, halfW, ch); ctx.clip();
    ctx.drawImage(vncCanvas, halfW + baseX + rdVrIPD, baseY, drawW, drawH);
    ctx.restore();

    ctx.filter = 'none';

    // ── Multi-monitor orientation: draw the seam(s) between monitors ──
    // Key anchor — at neutral head position (recenter) the divider sits dead
    // center, so you always know where one monitor ends and the next begins.
    if (rdMonitorCount >= 2) {
        const seamGlow = 'rgba(168, 0, 255, 0.55)';
        const drawSeams = (eyeImgX) => {
            for (let m = 1; m < rdMonitorCount; m++) {
                const x = eyeImgX + (m / rdMonitorCount) * drawW;
                ctx.strokeStyle = seamGlow;
                ctx.lineWidth = 2 * dpr;
                ctx.beginPath(); ctx.moveTo(x, baseY); ctx.lineTo(x, baseY + drawH); ctx.stroke();
                // small monitor labels above the seam (e.g. "1 | 2")
                ctx.fillStyle = 'rgba(200, 120, 255, 0.7)';
                ctx.font = `${Math.round(12 * dpr)}px monospace`;
                ctx.textBaseline = 'bottom';
                ctx.textAlign = 'right'; ctx.fillText(String(m), x - 6 * dpr, baseY + 16 * dpr);
                ctx.textAlign = 'left';  ctx.fillText(String(m + 1), x + 6 * dpr, baseY + 16 * dpr);
            }
        };
        ctx.textAlign = 'left';
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, halfW, ch); ctx.clip();
        drawSeams(baseX - rdVrIPD);
        ctx.restore();
        ctx.save(); ctx.beginPath(); ctx.rect(halfW, 0, halfW, ch); ctx.clip();
        drawSeams(halfW + baseX + rdVrIPD);
        ctx.restore();
        ctx.textAlign = 'left'; // reset
    }

    // ── Screen border glow line (subtle edge around the desktop) ──
    ctx.strokeStyle = 'rgba(168, 0, 255, 0.15)';
    ctx.lineWidth = 1 * dpr;
    // Left eye border
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, halfW, ch); ctx.clip();
    ctx.strokeRect(baseX - rdVrIPD, baseY, drawW, drawH);
    ctx.restore();
    // Right eye border
    ctx.save();
    ctx.beginPath(); ctx.rect(halfW, 0, halfW, ch); ctx.clip();
    ctx.strokeRect(halfW + baseX + rdVrIPD, baseY, drawW, drawH);
    ctx.restore();

    } // end else (desktop mode vs terminal mode)
    }
}


// ── Smooth cursor interpolation ──
function rdVrDrawPointer(vncCanvas, drawW, drawH, baseX, baseY, halfW, ctx, dpr, ch, cw) {
    if (rdVrCursorTarget) {
        if (!rdVrCursorNorm) {
            rdVrCursorNorm = { x: rdVrCursorTarget.x, y: rdVrCursorTarget.y };
        } else {
            // Interpolate toward target (0.4 = responsive yet smooth)
            rdVrCursorNorm.x += (rdVrCursorTarget.x - rdVrCursorNorm.x) * 0.4;
            rdVrCursorNorm.y += (rdVrCursorTarget.y - rdVrCursorNorm.y) * 0.4;
        }
        // Send smoothed position to VNC at render rate - but only when it MOVED.
        // Re-sending the same point every frame put the Windows cursor back
        // ~60 times a second, which dragged it off wherever Tesla had just
        // clicked (lib/desk.js reads a moved cursor as "Leon took the mouse").
        const vncCanvas = rdFindCanvas();
        if (vncCanvas && rdRfb) {
            const sx = Math.round(rdVrCursorNorm.x * vncCanvas.width);
            const sy = Math.round(rdVrCursorNorm.y * vncCanvas.height);
            const last = rdVrLastSentPointer;
            if (!last || last.x !== sx || last.y !== sy || last.b !== rdVrMouseBtnState) {
                rdSendPointer(sx, sy, rdVrMouseBtnState);
                rdVrLastSentPointer = { x: sx, y: sy, b: rdVrMouseBtnState };
            }
        }
    }

    // ── Virtual cursor (both eyes) - thin red dot with fine crosshair ──
    if (rdVrCursorNorm) {
        const curX = rdVrCursorNorm.x * drawW;
        const curY = rdVrCursorNorm.y * drawH;
        const lCurX = baseX - rdVrIPD + curX;
        const lCurY = baseY + curY;
        const rCurX = halfW + baseX + rdVrIPD + curX;
        const rCurY = baseY + curY;

        function rdVrDrawCursor(cx, cy) {
            // Outer ring - thin, high contrast against any background
            ctx.strokeStyle = '#ff0000';
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.arc(cx, cy, 4 * dpr, 0, Math.PI * 2);
            ctx.stroke();
            // Center dot - precise click point
            ctx.fillStyle = '#ff0000';
            ctx.globalAlpha = 1.0;
            ctx.beginPath();
            ctx.arc(cx, cy, 1 * dpr, 0, Math.PI * 2);
            ctx.fill();
        }

        if (lCurX > 0 && lCurX < halfW && lCurY > 0 && lCurY < ch) {
            rdVrDrawCursor(lCurX, lCurY);
        }
        if (rCurX > halfW && rCurX < cw && rCurY > 0 && rCurY < ch) {
            rdVrDrawCursor(rCurX, rCurY);
        }
        ctx.globalAlpha = 1.0;
    }
}

function rdVrDrawRipples(now, dpr, drawW, drawH, ctx, baseX, baseY, halfW, cw) {
    rdVrClickRipples = rdVrClickRipples.filter(r => now - r.t < 500);
    for (const rip of rdVrClickRipples) {
        const age = (now - rip.t) / 500; // 0→1 over 500ms
        const radius = age * 25 * dpr;
        const alpha = (1 - age) * 0.5;
        const rx = rip.x * drawW;
        const ry = rip.y * drawH;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#a800ff';
        ctx.lineWidth = 2 * dpr;
        // Left eye
        const lrx = baseX - rdVrIPD + rx;
        const lry = baseY + ry;
        if (lrx > 0 && lrx < halfW) {
            ctx.beginPath(); ctx.arc(lrx, lry, radius, 0, Math.PI * 2); ctx.stroke();
        }
        // Right eye
        const rrx = halfW + baseX + rdVrIPD + rx;
        if (rrx > halfW && rrx < cw) {
            ctx.beginPath(); ctx.arc(rrx, lry, radius, 0, Math.PI * 2); ctx.stroke();
        }
    }
}


// ── Compass HUD (360 panel indicator, only in 360 mode) ──
function rdVrDraw360Guide(dpr, halfW, ctx) {
    if (rdVr360Mode) {
    const compassY = 28 * dpr;
    const compassW = halfW * 0.5;

    for (let eye = 0; eye < 2; eye++) {
        const compassX = eye * halfW + (halfW - compassW) / 2;

        // Track line
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(compassX, compassY);
        ctx.lineTo(compassX + compassW, compassY);
        ctx.stroke();

        for (const p of RD_VR_PANELS) {
            let angleDelta = p.yaw - rdVrYaw;
            if (angleDelta > 180) angleDelta -= 360;
            if (angleDelta < -180) angleDelta += 360;
            if (Math.abs(angleDelta) > 90) continue; // behind user

            const xPos = compassX + compassW * (0.5 + angleDelta / 180);
            const isFacing = Math.abs(angleDelta) < RD_VR_PANEL_ARC / 2;

            ctx.globalAlpha = isFacing ? 0.8 : 0.25;
            ctx.fillStyle = p.accent;

            // Tick
            ctx.fillRect(xPos - 1, compassY - 3, 2, 6);

            // Label
            ctx.font = (isFacing ? 'bold ' : '') + (7 * dpr) + 'px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(p.label.slice(0, 3), xPos, compassY + 10 * dpr);
        }
    }
    ctx.globalAlpha = 1.0;
    ctx.textAlign = 'start';
    }
}


// ── CRT Scanlines - slow downward sweep ──
function rdVrDrawScanlines(ctx, cw, ch, dpr, vrAccent) {
    ctx.save();
    const scanSpeed = rdVrFrameCount * 0.5;
    const scanSpacing = 3 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    for (let sy = 0; sy < ch; sy += scanSpacing) {
        ctx.globalAlpha = 0.015;
        ctx.beginPath();
        ctx.moveTo(0, sy); ctx.lineTo(cw, sy);
        ctx.stroke();
    }
    // Bright sweep band (moves down slowly)
    const sweepY = (scanSpeed % ch);
    const sweepH = 40 * dpr;
    for (let sy = 0; sy < sweepH; sy += scanSpacing) {
        const dist = sy / sweepH;
        ctx.globalAlpha = 0.04 * (1 - Math.abs(dist - 0.5) * 2);
        ctx.beginPath();
        ctx.moveTo(0, sweepY + sy); ctx.lineTo(cw, sweepY + sy);
        ctx.stroke();
    }
    ctx.restore();

    // Horizon line glow
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.strokeStyle = vrAccent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, ch / 2); ctx.lineTo(cw, ch / 2);
    ctx.stroke();
    ctx.restore();
}


// ── Screen glow (visible halo behind desktop viewport) ──
function rdVrDrawGlow(ctx, halfW, ch, dpr, baseX, baseY, drawW, drawH) {
    const glowAccent = (rdVrScene === 'desktop') ? '#a800ff' : '#30d0ff';
    const glowFill = (rdVrScene === 'desktop') ? 'rgba(100, 40, 200, 0.15)' : 'rgba(20, 100, 180, 0.15)';
    const glowPad = 20 * dpr;
    const lGlowX = baseX - rdVrIPD - glowPad;
    const lGlowY = baseY - glowPad;
    // Left eye glow
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, halfW, ch); ctx.clip();
    ctx.shadowColor = glowAccent;
    ctx.shadowBlur = 50 * dpr;
    ctx.fillStyle = glowFill;
    ctx.fillRect(lGlowX, lGlowY, drawW + glowPad * 2, drawH + glowPad * 2);
    ctx.restore();
    // Right eye glow
    ctx.save();
    ctx.beginPath(); ctx.rect(halfW, 0, halfW, ch); ctx.clip();
    ctx.shadowColor = glowAccent;
    ctx.shadowBlur = 50 * dpr;
    ctx.fillStyle = glowFill;
    ctx.fillRect(halfW + baseX + rdVrIPD - glowPad, lGlowY, drawW + glowPad * 2, drawH + glowPad * 2);
    ctx.restore();
    ctx.shadowBlur = 0;
}


// ── HUD: status bar + session timer (left eye only, top area) ──
function rdVrDrawHud(ctx, now, halfW, dpr) {
    const sessionSec = Math.floor((now - rdVrSessionStart) / 1000);
    const sessionMin = Math.floor(sessionSec / 60);
    const sessionRemain = Math.max(0, 40 - sessionMin);
    const clockStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const hudText = clockStr + '  |  ' + sessionMin + 'm  |  ' + sessionRemain + 'm left';

    ctx.font = 'bold ' + (11 * dpr) + 'px monospace';
    ctx.textAlign = 'center';

    // Warning: flash when < 5 min remain
    if (sessionRemain <= 5 && sessionRemain > 0) {
        ctx.fillStyle = (rdVrFrameCount % 60 < 30) ? 'rgba(255, 80, 80, 0.9)' : 'rgba(255, 80, 80, 0.4)';
    } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    }

    // Draw in both eyes at top
    ctx.fillText(hudText, halfW * 0.5, 16 * dpr);
    ctx.fillText(hudText, halfW + halfW * 0.5, 16 * dpr);
}

function rdVrRender() {
    if (!rdVrActive) return;
    rdVrRaf = requestAnimationFrame(rdVrRender);

    const ctx = rdVrCtx;
    if (!ctx) return;

    const vncCanvas = rdFindCanvas();
    if (!vncCanvas || !vncCanvas.width || !vncCanvas.height) return;

    const smoothFactor = 0.95 - (rdVrSensitivity / 100) * 0.2;

    // Smooth vertical pan (always active)
    rdVrPanY = rdVrPanY * smoothFactor + rdVrTargetPanY * (1 - smoothFactor);
    if (Math.abs(rdVrPanY) < 0.002) rdVrPanY = 0;

    // Horizontal tracking depends on mode:
    // Desktop = always flat pan (no 360)
    // Hub world (hub/session/permissions) = 360 if enabled, flat pan if not
    let facing;
    const inHubWorld = rdVrScene !== 'desktop';

    if (inHubWorld && rdVr360Mode) {
        // 360 mode inside hub world: yaw rotation between panels
        // Extra smoothing for yaw (0.95 min) to prevent jerky rotation
        const yawSmooth = Math.max(smoothFactor, 0.93);
        let yawDelta = ((rdVrTargetYaw - rdVrYaw + 180) % 360 + 360) % 360 - 180;
        rdVrYaw += yawDelta * (1 - yawSmooth);
        rdVrYaw = ((rdVrYaw % 360) + 360) % 360;
        facing = rdVrGetFacingPanel(rdVrYaw);

        // Scene lifecycle with hysteresis
        if (facing.scene !== rdVrLastFacingScene && Math.abs(facing.offset) < 0.44) {
            rdVrOnSceneChange(rdVrLastFacingScene, facing.scene);
            rdVrLastFacingScene = facing.scene;
            rdVrScene = facing.scene;
        }
    } else {
        // Flat pan mode (desktop always, or hub world without 360)
        rdVrPanX = rdVrPanX * smoothFactor + rdVrTargetPanX * (1 - smoothFactor);
        if (Math.abs(rdVrPanX) < 0.002) rdVrPanX = 0;
        const panelIdx = Math.max(0, RD_VR_PANELS.findIndex(p => p.scene === rdVrScene));
        facing = { index: panelIdx, scene: rdVrScene, offset: 0, panel: RD_VR_PANELS[panelIdx] || RD_VR_PANELS[0] };
    }

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const halfW = cw / 2;

    // Source dimensions
    const srcW = vncCanvas.width;
    const srcH = vncCanvas.height;
    const srcAspect = srcW / srcH;

    // Multi-monitor: extended displays come over VNC as ONE ultra-wide framebuffer
    // (two 1920x1080 => 3840x1080, ~32:9). When 360 is on, auto-detect by aspect
    // (Option A: equal monitors, 50% split) and scale to a SINGLE monitor so it's
    // readable; the full desktop is rdMonitorCount× wider and head-pan sweeps across.
    const rdAllowMultiMon = (facing.scene === 'desktop') && !rdVrTerminalMode;
    let rdMonitorCount = 1;
    if (rdAllowMultiMon && rdVr360Mode && srcAspect >= RD_MULTIMON_ASPECT) {
        rdMonitorCount = Math.max(2, Math.round(srcAspect / (16 / 9)));
    }
    const fitAspect = srcAspect / rdMonitorCount; // aspect of one monitor

    // Each eye viewport aspect
    const eyeAspect = halfW / ch;

    // Fit ONE monitor into the eye viewport; full framebuffer is rdMonitorCount× wider.
    let drawW, drawH;
    if (eyeAspect > fitAspect) {
        drawH = ch * rdVrScale;
        drawW = drawH * fitAspect;
    } else {
        drawW = halfW * rdVrScale;
        drawH = drawW / fitAspect;
    }
    drawW *= rdMonitorCount;

    // Pan offset in pixels
    const panPixX = rdVrPanX * drawW;
    const panPixY = rdVrPanY * drawH;

    // Center the image in each eye viewport, with vertical lens offset
    const dpr = window.devicePixelRatio || 1;
    const baseX = (halfW - drawW) / 2 - panPixX;
    const baseY = (ch - drawH) / 2 - panPixY + (rdVrVOffset * dpr);

    rdVrFrameCount++;
    const vrAccent = (rdVrScene === 'desktop') ? '#a800ff' : (facing.panel ? facing.panel.accent : '#30d0ff');

    // ── Clear to black ──
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    // ── Tron Grid with perspective (floor + ceiling receding into depth) ──
    const t = rdVrFrameCount * 0.003;
    rdVrDrawEyeFrames(ctx, halfW, ch, vrAccent, t, dpr);
    rdVrDrawScanlines(ctx, cw, ch, dpr, vrAccent);
    rdVrDrawGlow(ctx, halfW, ch, dpr, baseX, baseY, drawW, drawH);

    // ── Scene dispatcher with horizontal slide (360) or direct render (flat) ──
    function rdVrRenderSceneAt(sceneName, offsetX) {
        const shiftedBaseX = baseX + offsetX;
        if (sceneName === 'hub') {
            rdVrRenderHub(ctx, halfW, ch, shiftedBaseX, baseY, drawW, drawH, dpr);
        } else if (sceneName === 'session') {
            rdVrRenderSession(ctx, halfW, ch, shiftedBaseX, baseY, drawW, drawH, dpr);
        } else if (sceneName === 'permissions') {
            rdVrRenderPermissions(ctx, halfW, ch, shiftedBaseX, baseY, drawW, drawH, dpr);
        }
    }

    if (rdVr360Mode && Math.abs(facing.offset) > 0.05) {
        // 360 mode: slide panels horizontally based on yaw offset
        // offset: -0.5 to +0.5 from panel center
        // Positive offset = looking right of center = panel slides left
        const slideAmount = -facing.offset * drawW * 2; // slide proportional to panel width
        const adjDir = facing.offset > 0 ? 1 : -1;
        const adjPanel = rdVrGetAdjacentPanel(facing.index, adjDir);

        // Primary panel (slides in the direction you're turning)
        if (facing.scene !== 'desktop') {
            rdVrRenderSceneAt(facing.scene, slideAmount);
        }
        // Adjacent panel (enters from the side)
        const adjOffset = slideAmount + (adjDir > 0 ? drawW * 2 : -drawW * 2);
        if (adjPanel.scene !== 'desktop') {
            rdVrRenderSceneAt(adjPanel.scene, adjOffset);
        }

        // Desktop scene needs special handling (rendered inline below)
        if (facing.scene === 'desktop') {
            // Store slide offset for desktop renderer
            baseX += slideAmount;
        }
    } else {
        // Center of panel or flat mode: render only primary
        if (facing.scene !== 'desktop') {
            rdVrRenderSceneAt(facing.scene, 0);
        }
    }
    rdVrDrawDesktopScene(facing, ctx, halfW, ch, baseX, baseY, drawW, drawH, dpr, vncCanvas, rdMonitorCount);
    rdVrDrawPointer(vncCanvas, drawW, drawH, baseX, baseY, halfW, ctx, dpr, ch, cw);

    // ── Click ripples (both eyes) ──
    const now = Date.now();
    rdVrDrawRipples(now, dpr, drawW, drawH, ctx, baseX, baseY, halfW, cw);
    ctx.globalAlpha = 1.0;
    rdVrDrawHud(ctx, now, halfW, dpr);

    // ── Tesla, in both eyes (the ONE orb's state, src/js/assistant.js) ──
    rdVrDrawTesla(ctx, halfW, ch, dpr);
    rdVrDraw360Guide(dpr, halfW, ctx);

    // ── Cinematic fade-in ──
    if (rdVrFadeIn < 1) {
        rdVrFadeIn = Math.min(1, rdVrFadeIn + 0.015); // ~1.1 seconds to full
        ctx.globalAlpha = 1 - rdVrFadeIn;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cw, ch);
        ctx.globalAlpha = 1.0;
    }
}

// Head tracking using gyroscope angular velocity (DeviceMotion)
// No gimbal lock, no wraparound, no jumps - integrates rotation rate directly
function rdVrStartTracking() {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
        // iOS 13+ requires permission for motion sensors
        DeviceMotionEvent.requestPermission().then(perm => {
            if (perm === 'granted') rdVrAttachOrientation();
        }).catch(() => rdVrAttachOrientation());
    } else {
        rdVrAttachOrientation();
    }
}

function rdVrAttachOrientation() {
    // Use DeviceMotion (gyroscope angular velocity) instead of DeviceOrientation.
    // DeviceOrientation uses Euler angles which have gimbal lock at beta=90
    // (exactly the VR headset position). DeviceMotion gives raw rotation RATE
    // in deg/sec - no singularities, no wraparound, no jumps.
    // We integrate the rate to get relative position.

    let lastTime = null;

    rdVrOrientationHandler = function(e) {
        if (!rdVrActive) return;

        const rate = e.rotationRate;
        if (!rate) return;

        const now = e.timeStamp || performance.now();
        if (lastTime === null) {
            lastTime = now;
            return;
        }

        // Delta time in seconds (cap at 100ms to avoid jumps after tab-switch)
        const dt = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;

        // rotationRate is in deg/sec:
        // alpha = rotation around Z axis (yaw - turn head left/right)
        // beta = rotation around X axis (pitch - nod up/down)
        // gamma = rotation around Y axis (roll - tilt head sideways)
        const rateAlpha = rate.alpha || 0; // yaw rate (deg/sec)
        const rateBeta = rate.beta || 0;   // pitch rate (deg/sec)
        const rateGamma = rate.gamma || 0; // roll rate (deg/sec)

        // Dead zone: scales with sensitivity (high sensitivity = smaller dead zone for precision)
        // At sensitivity 100: deadZone = 1.0 deg/sec (catches micro-movements)
        // At sensitivity 10: deadZone = 4.0 deg/sec (rejects more noise)
        const deadZone = 4.0 - (rdVrSensitivity / 100) * 3.0;
        const filteredAlpha = Math.abs(rateAlpha) < deadZone ? 0 : (rateAlpha - Math.sign(rateAlpha) * deadZone);
        const filteredBeta = Math.abs(rateBeta) < deadZone ? 0 : (rateBeta - Math.sign(rateBeta) * deadZone);

        // Yaw gain: convert filtered rate to degrees of rotation
        // At sensitivity 100: 1:1 feel, at low: sluggish
        // Yaw gain: ~1:1 mapping - real head rotation matches virtual rotation
        // The smoothing in the render loop prevents jumps, not the gain
        const yawGain = (rdVrSensitivity / 100) * 1.0;
        const pitchGain = (rdVrSensitivity / 100) * 0.08;

        let yawDelta = 0;
        let pitchDelta = 0;

        if (rdVrScreenAngle === 270 || rdVrScreenAngle === -90) {
            yawDelta = filteredAlpha * dt * yawGain;
            pitchDelta = -filteredBeta * dt * pitchGain;
        } else {
            yawDelta = -filteredAlpha * dt * yawGain;
            pitchDelta = filteredBeta * dt * pitchGain;
        }

        // Accumulate based on mode
        if (rdVr360Mode && rdVrScene !== 'desktop') {
            // 360 inside hub world: accumulate yaw in degrees (wrapping)
            rdVrTargetYaw += yawDelta;
            rdVrTargetYaw = ((rdVrTargetYaw % 360) + 360) % 360;
        } else {
            // Desktop or flat mode: accumulate horizontal pan (clamped)
            const flatGain = (rdVrSensitivity / 100) * 0.08;
            const flatDx = (rdVrScreenAngle === 270 || rdVrScreenAngle === -90)
                ? filteredAlpha * dt * flatGain
                : -filteredAlpha * dt * flatGain;
            rdVrTargetPanX += flatDx;
            rdVrTargetPanX = Math.max(-0.45, Math.min(0.45, rdVrTargetPanX));
        }

        rdVrTargetPanY += pitchDelta;
        rdVrTargetPanY = Math.max(-0.45, Math.min(0.45, rdVrTargetPanY));
    };

    // Use devicemotion (gyroscope rate) instead of deviceorientation (Euler angles)
    window.addEventListener('devicemotion', rdVrOrientationHandler);
    rdLog('vr: head tracking active (sensitivity=' + rdVrSensitivity + ')');
}

function rdVrStopTracking() {
    if (rdVrOrientationHandler) {
        window.removeEventListener('devicemotion', rdVrOrientationHandler);
        rdVrOrientationHandler = null;
    }
    rdVrPanX = 0;
    rdVrPanY = 0;
    rdVrTargetPanX = 0;
    rdVrTargetPanY = 0;
}

// Bluetooth mouse - direct VNC interaction via rdSendPointer()
// Uses the same pointer API as normal remote desktop (handles all noVNC versions).
// Events captured at document level in capture phase so nothing blocks them.
let rdVrMouseHandlers = null;
let rdVrMouseBtnState = 0;
let rdVrLastPointerPos = null;
let rdVrCursorNorm = null;       // current smoothed cursor position
let rdVrCursorTarget = null;     // raw target from last mouse event
let rdVrMouseSendTimer = null;   // throttle pointer sends to reduce lag

function rdVrScreenToVnc(screenX, screenY) {
    const vncCanvas = rdFindCanvas();
    if (!vncCanvas || !vncCanvas.width || !vncCanvas.height) return null;

    const dpr = window.devicePixelRatio || 1;
    const cw = window.innerWidth * dpr;
    const ch = window.innerHeight * dpr;
    const halfW = cw / 2;

    const srcW = vncCanvas.width;
    const srcH = vncCanvas.height;
    const srcAspect = srcW / srcH;

    // Mirror the render's multi-monitor fit EXACTLY so taps map to the right VNC
    // pixel (this is always the desktop VNC, so multi-mon is allowed here).
    let rdMonitorCount = 1;
    if (rdVr360Mode && srcAspect >= RD_MULTIMON_ASPECT) {
        rdMonitorCount = Math.max(2, Math.round(srcAspect / (16 / 9)));
    }
    const fitAspect = srcAspect / rdMonitorCount;
    const eyeAspect = halfW / ch;

    let drawW, drawH;
    if (eyeAspect > fitAspect) {
        drawH = ch * rdVrScale;
        drawW = drawH * fitAspect;
    } else {
        drawW = halfW * rdVrScale;
        drawH = drawW / fitAspect;
    }
    drawW *= rdMonitorCount;

    const panPixX = rdVrPanX * drawW;
    const panPixY = rdVrPanY * drawH;
    const baseX = (halfW - drawW) / 2 - panPixX;
    const baseY = (ch - drawH) / 2 - panPixY + (rdVrVOffset * dpr);

    // Convert screen coords to canvas pixel coords
    const px = screenX * dpr;
    const py = screenY * dpr;

    // Determine which eye half, normalize within that half
    const eyePx = px < halfW ? px : (px - halfW);

    // Position within the drawn VNC image (account for IPD offset)
    const ipdOff = px < halfW ? rdVrIPD : -rdVrIPD;
    const imgX = eyePx - (baseX + ipdOff);
    const imgY = py - baseY;

    // Convert to normalized VNC coords
    const normX = imgX / drawW;
    const normY = imgY / drawH;

    if (normX < 0 || normX > 1 || normY < 0 || normY > 1) {
        rdVrCursorTarget = null;
        return null;
    }

    // Store as target for smooth cursor interpolation
    rdVrCursorTarget = { x: normX, y: normY };

    return {
        x: Math.round(normX * srcW),
        y: Math.round(normY * srcH)
    };
}

function rdVrAttachMouse() {
    const handlers = {};

    function isOnControls(e) {
        // If settings panel is open, ALL mouse events are handled by adjust system
        if (rdVrSettingsOpen) return true;
        const el = e.target;
        if (!el) return false;
        return el.closest('.rd-vr-controls') || el.closest('.rd-vr-settings');
    }

    handlers.mousemove = function(e) {
        if (!rdVrActive) return;
        if (isOnControls(e)) return;
        // Update cursor target position
        rdVrScreenToVnc(e.clientX, e.clientY);
        // Update hover state for native scenes
        if (rdVrScene !== 'desktop' && rdVrCursorTarget) {
            rdVrNativeHitTest(rdVrCursorTarget.x, rdVrCursorTarget.y);
        }
    };

    handlers.mousedown = function(e) {
        if (!rdVrActive) return;
        // When settings open + param selected: hold click adjusts value
        if (rdVrSettingsOpen && rdVrActiveParam) {
            e.preventDefault();
            e.stopPropagation();
            const dir = e.button === 2 ? -1 : 1;
            rdVrStartAdjust(dir);
            return;
        }
        if (isOnControls(e)) return;
        // VR Native scenes: handle clicks on cards/buttons
        if (rdVrScene !== 'desktop' && rdVrCursorTarget) {
            e.preventDefault();
            e.stopPropagation();
            if (rdVrNativeClick(rdVrCursorTarget.x, rdVrCursorTarget.y)) return;
            return;
        }
        if (!rdRfb) return;
        e.preventDefault();
        e.stopPropagation();
        const pos = rdVrScreenToVnc(e.clientX, e.clientY);
        if (!pos) return;
        rdVrLastPointerPos = pos;
        // VNC button mask: bit0=left(1), bit1=middle(2), bit2=right(4)
        const bit = e.button === 0 ? 1 : e.button === 1 ? 2 : e.button === 2 ? 4 : 1;
        rdVrMouseBtnState |= bit;
        rdSendPointer(pos.x, pos.y, rdVrMouseBtnState);
        // Click ripple effect
        if (rdVrCursorNorm && bit === 1) {
            rdVrClickRipples.push({ x: rdVrCursorNorm.x, y: rdVrCursorNorm.y, t: Date.now() });
            if (rdVrClickRipples.length > 5) rdVrClickRipples.shift();
        }
    };

    handlers.mouseup = function(e) {
        if (!rdVrActive) return;
        // Stop adjust on release
        if (rdVrSettingsOpen && rdVrActiveParam) {
            rdVrStopAdjust();
            e.preventDefault();
            return;
        }
        if (isOnControls(e)) return;
        if (!rdRfb) return;
        e.preventDefault();
        e.stopPropagation();
        const pos = rdVrScreenToVnc(e.clientX, e.clientY);
        if (!pos) return;
        rdVrLastPointerPos = pos;
        const bit = e.button === 0 ? 1 : e.button === 1 ? 2 : e.button === 2 ? 4 : 1;
        rdVrMouseBtnState &= ~bit;
        rdSendPointer(pos.x, pos.y, rdVrMouseBtnState);
    };

    handlers.wheel = function(e) {
        if (!rdVrActive) return;
        if (isOnControls(e)) return;
        e.preventDefault();
        // Session view: vertical scroll = terminal, horizontal scroll = swipe sessions
        if (rdVrScene === 'session') {
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 10) {
                // Horizontal scroll = switch session
                rdVrSwipeSession(e.deltaX > 0 ? 1 : -1);
            } else {
                rdVrNativeData.outputScroll += (e.deltaY > 0 ? -3 : 3);
                rdVrNativeData.outputScroll = Math.max(0, rdVrNativeData.outputScroll);
            }
            return;
        }
        if (!rdRfb || rdVrScene !== 'desktop') return;
        const pos = rdVrScreenToVnc(e.clientX, e.clientY) || rdVrLastPointerPos;
        if (!pos) return;
        const scrollBit = e.deltaY < 0 ? 8 : 16;
        rdSendPointer(pos.x, pos.y, rdVrMouseBtnState | scrollBit);
        setTimeout(() => {
            if (rdRfb) rdSendPointer(pos.x, pos.y, rdVrMouseBtnState);
        }, 50);
    };

    handlers.contextmenu = function(e) {
        if (!rdVrActive) return;
        if (isOnControls(e)) return;
        e.preventDefault();
    };

    // Capture phase = intercepts BEFORE any element's own handlers
    document.addEventListener('mousemove', handlers.mousemove, true);
    document.addEventListener('mousedown', handlers.mousedown, true);
    document.addEventListener('mouseup', handlers.mouseup, true);
    document.addEventListener('wheel', handlers.wheel, { capture: true, passive: false });
    document.addEventListener('contextmenu', handlers.contextmenu, true);

    rdVrMouseHandlers = handlers;
    rdVrMouseBtnState = 0;
    rdVrLastPointerPos = null;
    rdLog('vr: mouse active (using rdSendPointer)');
}

function rdVrDetachMouse() {
    if (!rdVrMouseHandlers) return;
    const h = rdVrMouseHandlers;
    document.removeEventListener('mousemove', h.mousemove, true);
    document.removeEventListener('mousedown', h.mousedown, true);
    document.removeEventListener('mouseup', h.mouseup, true);
    document.removeEventListener('wheel', h.wheel, true);
    document.removeEventListener('contextmenu', h.contextmenu, true);
    rdVrMouseHandlers = null;
    rdVrMouseBtnState = 0;
    rdVrLastPointerPos = null;
}

// Gaze tap: click where you're looking
function rdVrTap() {
    if (!rdVrActive || !rdRfb) return;
    const vncCanvas = rdFindCanvas();
    if (!vncCanvas) return;

    const cx = Math.max(0, Math.min(1, 0.5 + rdVrPanX));
    const cy = Math.max(0, Math.min(1, 0.5 + rdVrPanY));
    const vncX = Math.round(cx * vncCanvas.width);
    const vncY = Math.round(cy * vncCanvas.height);

    rdSendPointer(vncX, vncY, 1);
    setTimeout(() => { if (rdRfb) rdSendPointer(vncX, vncY, 0); }, 80);
}

// Settings panel - click-to-select, hold-click-to-adjust system
let rdVrActiveParam = null;   // which param is being adjusted
let rdVrAdjustInterval = null; // interval for hold-to-adjust
let rdVrSettingsOpen = false;

// Param definitions: { key, get, set, step, min, max }
const RD_VR_PARAMS = {
    scale:       { get: () => rdVrScale,       set: v => { rdVrScale = v; },       step: 0.02, min: 0.8, max: 3.5 },
    ipd:         { get: () => rdVrIPD,         set: v => { rdVrIPD = v; },         step: 1,    min: -120, max: 120 },
    voffset:     { get: () => rdVrVOffset,     set: v => { rdVrVOffset = v; },     step: 1,    min: -80, max: 80 },
    brightness:  { get: () => rdVrBrightness,  set: v => { rdVrBrightness = v; },  step: 1,    min: -80, max: 80 },
    contrast:    { get: () => rdVrContrast,    set: v => { rdVrContrast = v; },    step: 0.02, min: 0.5, max: 2.0 },
    sensitivity: { get: () => rdVrSensitivity, set: v => { rdVrSensitivity = v; }, step: 1,    min: 1,   max: 100 },
    saturate:    { get: () => rdVrSaturate,    set: v => { rdVrSaturate = v; },    step: 2,    min: 0,   max: 200 },
    warmth:      { get: () => rdVrWarmth,      set: v => { rdVrWarmth = v; },      step: 2,    min: -50, max: 50 },
    blur:        { get: () => rdVrBlur,        set: v => { rdVrBlur = v; },        step: 0.1,  min: 0,   max: 2.0 },
    invert:      { get: () => rdVrInvert,      set: v => { rdVrInvert = v; },      step: 5,    min: 0,   max: 100 },
    nightMode:   { get: () => rdVrNightMode,  set: v => { rdVrNightMode = v; },  step: 5,    min: 0,   max: 100 }
};

function rdVrShowSettings() {
    const panel = document.getElementById('rd-vr-settings');
    if (!panel) return;
    if (rdVrSettingsOpen) {
        rdVrCloseSettings();
        return;
    }
    // Pause head tracking (freeze position, don't reset)
    if (rdVrOrientationHandler) {
        window.removeEventListener('devicemotion', rdVrOrientationHandler);
        rdVrOrientationHandler = null;
    }
    rdVrSettingsOpen = true;
    rdVrActiveParam = null;
    panel.style.display = 'grid';
    rdVrUpdateDisplays();
}

function rdVrCloseSettings() {
    const panel = document.getElementById('rd-vr-settings');
    if (panel) panel.style.display = 'none';
    rdVrSettingsOpen = false;
    rdVrActiveParam = null;
    rdVrStopAdjust();
    rdVrSaveSettings();
    // Resume head tracking
    rdVrStartTracking();
    // Apply IPD to controls
    const controls = document.querySelector('.rd-vr-controls');
    if (controls) controls.style.marginLeft = (-rdVrIPD) + 'px';
}

function rdVrSelectParam(key) {
    rdVrActiveParam = key;
    // Highlight active button
    document.querySelectorAll('.rd-vr-param-btn').forEach(btn => btn.classList.remove('active'));
    const btns = document.querySelectorAll('.rd-vr-param-btn');
    const keys = ['scale', 'ipd', 'voffset', 'brightness', 'contrast', 'sensitivity', 'saturate', 'warmth', 'blur', 'invert', 'nightMode'];
    const idx = keys.indexOf(key);
    if (idx >= 0 && btns[idx]) btns[idx].classList.add('active');
}

function rdVrConfirmParam() {
    rdVrCloseSettings();
}

// Hold-click adjustment: left click = increase, right click = decrease
// Runs every 60ms while held for smooth gradual change
function rdVrStartAdjust(direction) {
    if (!rdVrActiveParam) return;
    const param = RD_VR_PARAMS[rdVrActiveParam];
    if (!param) return;

    // Apply one step immediately
    rdVrApplyStep(param, direction);

    // Then repeat while held
    rdVrAdjustInterval = setInterval(() => {
        rdVrApplyStep(param, direction);
    }, 60);
}

function rdVrApplyStep(param, direction) {
    let val = param.get();
    val += param.step * direction;
    val = Math.max(param.min, Math.min(param.max, val));
    // Round to avoid floating point drift
    if (param.step >= 1) val = Math.round(val);
    else val = Math.round(val * 100) / 100;
    param.set(val);
    rdVrUpdateDisplays();
}

function rdVrStopAdjust() {
    if (rdVrAdjustInterval) {
        clearInterval(rdVrAdjustInterval);
        rdVrAdjustInterval = null;
    }
    rdVrSaveSettings();
}

function rdVrUpdateDisplays() {
    const u = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    u('rd-vr-scale-val', rdVrScale.toFixed(1));
    u('rd-vr-ipd-val', rdVrIPD);
    u('rd-vr-voffset-val', rdVrVOffset);
    u('rd-vr-bright-val', rdVrBrightness);
    u('rd-vr-contrast-val', rdVrContrast.toFixed(1));
    u('rd-vr-sensitivity-val', rdVrSensitivity);
    u('rd-vr-saturate-val', rdVrSaturate);
    u('rd-vr-warmth-val', rdVrWarmth);
    u('rd-vr-blur-val', rdVrBlur.toFixed(1));
    u('rd-vr-invert-val', rdVrInvert);
    u('rd-vr-night-val', rdVrNightMode);
}

function rdVrRecenter() {
    // Recenter: current facing direction becomes the current panel's center
    const facing = rdVrGetFacingPanel(rdVrYaw);
    rdVrYaw = facing.panel.yaw;
    rdVrTargetYaw = facing.panel.yaw;
    rdVrPanX = 0;
    rdVrPanY = 0;
    rdVrTargetPanX = 0;
    rdVrTargetPanY = 0;
    rdVrStopTracking();
    rdVrStartTracking();
    if (typeof toast === 'function') toast('Recentered', 'success');
}

function rdVrToggleLang() {
    if (typeof speechLang !== 'undefined') {
        if (speechLang === 'es-ES') {
            speechLang = 'en-US';
        } else {
            speechLang = 'es-ES';
        }
    } else {
        window.speechLang = 'en-US';
    }
    const btn = document.getElementById('rd-vr-lang-btn');
    if (btn) btn.textContent = speechLang === 'es-ES' ? 'ES' : 'EN';
    if (typeof toast === 'function') toast(speechLang, 'info');
}

// ── Tesla inside VR (2026-10-10) ────────────────────────────────────────────
// Leon wants to talk to Tesla with the headset on and have her work his PC. The
// VR view is a fullscreen canvas on this room, so the orb (src/js/assistant.js,
// fixed to the page corner) is not visible in it - but it is still the ONE
// Tesla: this draws the orb's own state into both eyes and the TSL button calls
// the orb's own toggle. No second conversation, recogniser or voice lives here
// (Leon, 2026-10-10: "do not duplicate the code for tesla").
let rdVrTeslaCache = null;
let rdVrTeslaAt = 0;
function rdVrTeslaState() {
    // state() copies the conversation; read it 4 times a second, not every frame.
    const now = Date.now();
    if (now - rdVrTeslaAt > 250) {
        rdVrTeslaAt = now;
        try {
            const st = window.Assistant && window.Assistant.state();
            const speaking = !!(window.TeslaVoice && window.TeslaVoice.speaking());
            rdVrTeslaCache = st ? {
                on: st.on, listening: st.listening, thinking: st.thinking, speaking,
                caption: st.caption ? String(st.caption.text || '') : '',
                who: st.caption ? st.caption.who : '',
                job: (st.jobs || []).find(j => j.state === 'running') || null,
            } : null;
        } catch (e) { rdVrTeslaCache = null; }
    }
    return rdVrTeslaCache;
}

function rdVrWrap(ctx, text, maxW, maxLines) {
    const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
        const next = cur ? cur + ' ' + w : w;
        if (ctx.measureText(next).width > maxW && cur) {
            lines.push(cur);
            cur = w;
            if (lines.length === maxLines) break;
        } else cur = next;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,3}$/, '...');
    return lines;
}

function rdVrDrawTesla(ctx, halfW, ch, dpr) {
    const t = rdVrTeslaState();
    if (!t || !t.on) return;
    const glyph = t.speaking ? '[)]' : t.thinking ? '[~]' : t.listening ? '[o]' : '[.]';
    const color = t.speaking ? '#30d0ff' : t.thinking ? '#ffb000' : t.listening ? '#40ff80' : 'rgba(255,255,255,0.5)';
    const pulse = t.thinking ? 0.55 + 0.45 * Math.abs(Math.sin(rdVrFrameCount / 12)) : 1;
    const lines = [];
    if (t.caption) lines.push(...(t.who === 'you' ? ['> ' + t.caption] : [t.caption]));
    if (t.job) lines.push(`working: ${t.job.goal || t.job.what || ''}`);
    ctx.save();
    ctx.font = (12 * dpr) + 'px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const maxW = halfW * 0.62;
    const wrapped = lines.flatMap((l, i) => rdVrWrap(ctx, l, maxW, i === 0 ? 3 : 1));
    const lineH = 15 * dpr;
    const boxH = (wrapped.length + 1) * lineH + 10 * dpr;
    for (let eye = 0; eye < 2; eye++) {
        // Bottom centre of each eye, above the lens edge; same place in both = flat in depth.
        const x = eye * halfW + (halfW - maxW) / 2;
        const y = ch * 0.86 - boxH;
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = 'rgba(5, 10, 25, 0.85)';
        ctx.fillRect(x - 8 * dpr, y, maxW + 16 * dpr, boxH);
        ctx.globalAlpha = pulse;
        ctx.fillStyle = color;
        ctx.font = 'bold ' + (12 * dpr) + 'px monospace';
        ctx.fillText(`${glyph} TESLA`, x, y + lineH);
        ctx.globalAlpha = 0.95;
        ctx.font = (12 * dpr) + 'px monospace';
        ctx.fillStyle = 'rgba(230, 240, 255, 0.95)';
        wrapped.forEach((l, i) => ctx.fillText(l, x, y + lineH * (i + 2)));
    }
    ctx.restore();
}

// The TSL button: start or end the conversation with the one orb. Its mic and
// the VNC dictation (MIC) would fight over the same recogniser, so MIC stops.
function rdVrTesla() {
    if (!window.Assistant) { if (typeof toast === 'function') toast('TESLA IS NOT LOADED', 'error'); return; }
    if (rdVncWantRecording) rdVncDictateToggle();
    window.Assistant.toggle();
}

function rdVrSendEnter() {
    if (rdVrScene === 'session') {
        if (rdVrInputBuffer.trim()) {
            rdVrNativeSend(rdVrInputBuffer.trim());
            rdVrInputBuffer = '';
            rdVrInputCursor = 0;
        }
        return;
    }
    if (!rdRfb) return;
    try { rdRfb.sendKey(0xFF0D); } catch (_) {}
}

function rdVrReload() {
    // Save state + VNC credentials so everything reconnects automatically
    const pwd = document.getElementById('rd-password')?.value || '';
    localStorage.setItem('tsrct_vr_autorestart', JSON.stringify({
        scene: rdVrScene,
        activeSession: rdVrNativeData.activeSession,
        vncPassword: pwd,
        vncConnected: rdConnected
    }));
    window.location.reload();
}

function rdVrCheckAutoRestart() {
    const raw = localStorage.getItem('tsrct_vr_autorestart');
    if (!raw) return;
    localStorage.removeItem('tsrct_vr_autorestart');
    try {
        const state = JSON.parse(raw);

        function startVrAfterRoomOpen() {
            const overlay = document.getElementById('rd-vr-overlay');
            const canvas = document.getElementById('rd-vr-canvas');
            if (!overlay || !canvas) return;

            rdVrLoadSettings();
            rdVrDetectOrientation();
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            rdVrCtx = ctx;
            rdVrActive = true;
            document.body.dataset.teslaWhere = 'vr';   // Tesla reads "abri..." as his PC while he is in here (assistant.js ask)
            rdVrPanX = 0; rdVrPanY = 0;
            rdVrTargetPanX = 0; rdVrTargetPanY = 0;
            rdVrFadeIn = 0;
            rdVrSessionStart = Date.now();
            rdVrClickRipples = [];
            rdVrFrameCount = 0;

            overlay.style.display = 'flex';
            const toolbar = document.getElementById('rd-toolbar');
            const clickStrip = document.getElementById('rd-click-strip');
            const scrollBar = document.getElementById('rd-scroll-bar');
            if (toolbar) toolbar.style.display = 'none';
            if (clickStrip) clickStrip.classList.remove('visible');
            if (scrollBar) scrollBar.style.display = 'none';

            // Try fullscreen (may fail without user gesture on auto-restart)
            const room = document.getElementById('remote-room');
            if (room) {
                const goFs = room.requestFullscreen || room.webkitRequestFullscreen;
                if (goFs) goFs.call(room).then(() => {
                    if (screen.orientation && screen.orientation.lock)
                        screen.orientation.lock('landscape').catch(() => {});
                }).catch(() => {
                    // Fullscreen denied (no user gesture) - try landscape lock anyway
                    if (screen.orientation && screen.orientation.lock)
                        screen.orientation.lock('landscape').catch(() => {});
                });
            }
            // Also try lock directly in case fullscreen is pending
            if (screen.orientation && screen.orientation.lock)
                screen.orientation.lock('landscape').catch(() => {});

            rdVrResize();
            window.addEventListener('resize', rdVrResize);
            rdVrStartTracking();
            rdVrAttachMouse();
            rdVrRender();

            if (screen.orientation) screen.orientation.addEventListener('change', rdVrOnOrientationChange);
            window.addEventListener('orientationchange', rdVrOnOrientationChange);

            const btn = document.getElementById('rd-vr-btn');
            if (btn) btn.classList.add('active');
            const controls = document.querySelector('.rd-vr-controls');
            if (controls) controls.style.marginLeft = (-rdVrIPD) + 'px';

            // Restore scene
            if (state.scene && state.scene !== 'desktop') {
                if (state.activeSession) rdVrNativeData.activeSession = state.activeSession;
                rdVrScene = state.scene;
                rdVrNativeFetch();
                if (rdVrNativePollTimer) clearInterval(rdVrNativePollTimer);
                rdVrNativePollTimer = setInterval(rdVrNativeFetch, 3000);
                if (state.scene === 'session' && state.activeSession) {
                    rdVrNativeFetchOutput(state.activeSession);
                    rdVrAttachInput();
                }
            }
        }

        // Hook into the remote room open callback - when rdInit runs, reconnect VNC then start VR
        const origRdInit = window.rdInit;
        window.rdInit = function() {
            if (origRdInit) origRdInit();
            // Auto-reconnect VNC if was connected before reload
            if (state.vncConnected) {
                const pwdInput = document.getElementById('rd-password');
                if (pwdInput && state.vncPassword) pwdInput.value = state.vncPassword;
                if (typeof rdConnect === 'function') rdConnect();
                // Wait for connection before starting VR desktop
                setTimeout(startVrAfterRoomOpen, 1500);
            } else {
                setTimeout(startVrAfterRoomOpen, 300);
            }
            window.rdInit = origRdInit;
        };

        // Open the remote room (this triggers rdInit via WorldManager callback)
        setTimeout(() => {
            if (typeof WorldManager !== 'undefined' && WorldManager.open) {
                WorldManager.open('remote');
            }
        }, 800);

    } catch (_) {}
}

function rdVrSendBackspace() {
    if (rdVrScene === 'session') {
        if (rdVrInputCursor > 0) {
            rdVrInputBuffer = rdVrInputBuffer.slice(0, rdVrInputCursor - 1) + rdVrInputBuffer.slice(rdVrInputCursor);
            rdVrInputCursor--;
        }
        return;
    }
    if (!rdRfb) return;
    try { rdRfb.sendKey(0xFF08); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════
// VR NATIVE INTERFACE - COMMAND CENTER
// ═══════════════════════════════════════════════════════════════════

// 360 Panel Layout
// Desktop is NOT part of 360 ring - it's a separate mode
// 360 ring only contains the native hub panels
// Panels at 60 degrees apart = comfortable head turn from bed (~20-30 deg real movement)
const RD_VR_PANELS = [
    { scene: 'hub',         label: 'HUB',     yaw: 0,   accent: '#30d0ff' },
    { scene: 'session',     label: 'SESSION',  yaw: 60,  accent: '#30d0ff' },
    { scene: 'permissions', label: 'PERMS',    yaw: 300, accent: '#ff8030' }
];
const RD_VR_PANEL_ARC = 60; // degrees per panel (not 360/n since we don't fill the whole ring)

function rdVrGetFacingPanel(yaw) {
    const arc = RD_VR_PANEL_ARC;
    // Shift yaw so panel center is at 0, then find which panel
    const shifted = ((yaw + arc / 2) % 360 + 360) % 360;
    const index = Math.floor(shifted / arc) % RD_VR_PANELS.length;
    const panel = RD_VR_PANELS[index];
    // Offset from panel center: -0.5 to +0.5
    let delta = yaw - panel.yaw;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const offset = delta / arc; // -0.5 to +0.5
    return { index, scene: panel.scene, offset, panel };
}

function rdVrGetAdjacentPanel(index, dir) {
    return RD_VR_PANELS[((index + dir) % RD_VR_PANELS.length + RD_VR_PANELS.length) % RD_VR_PANELS.length];
}

const VRN_BG = 'rgba(2, 6, 14, 0.95)';
const VRN_CYAN = '#30d0ff';
const VRN_GREEN = '#00ffaa';
const VRN_RED = '#ff4060';
const VRN_DIM = 'rgba(48, 208, 255, 0.3)';
const VRN_W = 960;
const VRN_H = 540;

// Data layer
async function rdVrNativeFetch() {
    try {
        const tk = localStorage.getItem('cbt') || '';
        const [sessRes, permRes] = await Promise.all([
            fetch('/api/sessions', { headers: { Authorization: tk } }),
            fetch('/api/permissions', { headers: { Authorization: tk } })
        ]);
        if (sessRes.ok) {
            const d = await sessRes.json();
            rdVrNativeData.sessions = d.sessions || [];
        }
        if (permRes.ok) {
            const d = await permRes.json();
            rdVrNativeData.permissions = d.permissions || [];
        }
        rdVrNativeData.lastFetch = Date.now();
    } catch (_) {}
}

async function rdVrNativeFetchOutput(session) {
    if (!session) return;
    try {
        const tk = localStorage.getItem('cbt') || '';
        const res = await fetch('/api/output?session=' + encodeURIComponent(session), { headers: { Authorization: tk } });
        if (res.ok) {
            const d = await res.json();
            rdVrNativeData.output = (d.output || '').replace(/\x1b\[[0-9;]*m/g, '');
            rdVrNativeData.outputSession = session;
        }
    } catch (_) {}
}

async function rdVrNativeSend(text) {
    if (!rdVrNativeData.activeSession || !text) return;
    try {
        const tk = localStorage.getItem('cbt') || '';
        await fetch('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: tk },
            body: JSON.stringify({ prompt: text, session: rdVrNativeData.activeSession, vault: localStorage.getItem('vault_enabled') !== 'false' })
        });
        setTimeout(() => rdVrNativeFetchOutput(rdVrNativeData.activeSession), 1500);
    } catch (_) {}
}

async function rdVrPermAction(id, action) {
    try {
        const tk = localStorage.getItem('cbt') || '';
        await fetch('/api/permission/' + id + '/' + action, {
            method: 'POST', headers: { Authorization: tk }
        });
        rdVrNativeData.permissions = rdVrNativeData.permissions.filter(p => p.id !== id);
    } catch (_) {}
}

// Scene transitions
function rdVrSwitchScene(to) {
    if (rdVrScene === to) return;
    rdVrTransition = { from: rdVrScene, to, progress: 0, startTime: Date.now(), duration: 400 };
    if (to === 'session' && rdVrNativeData.activeSession) {
        rdVrNativeFetchOutput(rdVrNativeData.activeSession);
        rdVrInputBuffer = '';
        if (rdVrNativeData._outputPoll) clearInterval(rdVrNativeData._outputPoll);
        rdVrNativeData._outputPoll = setInterval(() => {
            if (rdVrScene === 'session' && rdVrNativeData.activeSession) {
                rdVrNativeFetchOutput(rdVrNativeData.activeSession);
            }
        }, 3000);
        // Attach keyboard input capture
        rdVrAttachInput();
    } else {
        if (rdVrNativeData._outputPoll) { clearInterval(rdVrNativeData._outputPoll); rdVrNativeData._outputPoll = null; }
        rdVrDetachInput();
    }
}

function rdVrAttachInput() {
    rdVrDetachInput();
    rdVrInputHandler = function(e) {
        if (!rdVrActive || rdVrScene !== 'session') return;
        if (rdVrSettingsOpen) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            if (rdVrInputBuffer.trim()) {
                rdVrNativeSend(rdVrInputBuffer.trim());
                rdVrInputBuffer = '';
                rdVrInputCursor = 0;
            }
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (rdVrInputBuffer && rdVrInputCursor > 0) {
                rdVrInputCursor--;
            } else if (!rdVrInputBuffer) {
                rdVrSwipeSession(-1);
            }
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (rdVrInputBuffer && rdVrInputCursor < rdVrInputBuffer.length) {
                rdVrInputCursor++;
            } else if (!rdVrInputBuffer) {
                rdVrSwipeSession(1);
            }
        } else if (e.key === 'Backspace') {
            e.preventDefault();
            if (rdVrInputCursor > 0) {
                rdVrInputBuffer = rdVrInputBuffer.slice(0, rdVrInputCursor - 1) + rdVrInputBuffer.slice(rdVrInputCursor);
                rdVrInputCursor--;
            }
        } else if (e.key === 'Delete') {
            e.preventDefault();
            if (rdVrInputCursor < rdVrInputBuffer.length) {
                rdVrInputBuffer = rdVrInputBuffer.slice(0, rdVrInputCursor) + rdVrInputBuffer.slice(rdVrInputCursor + 1);
            }
        } else if (e.key === 'Home') {
            e.preventDefault();
            rdVrInputCursor = 0;
        } else if (e.key === 'End') {
            e.preventDefault();
            rdVrInputCursor = rdVrInputBuffer.length;
        } else if (e.key.length === 1) {
            e.preventDefault();
            rdVrInputBuffer = rdVrInputBuffer.slice(0, rdVrInputCursor) + e.key + rdVrInputBuffer.slice(rdVrInputCursor);
            rdVrInputCursor++;
        }
    };
    document.addEventListener('keydown', rdVrInputHandler, true);
}

function rdVrDetachInput() {
    if (rdVrInputHandler) {
        document.removeEventListener('keydown', rdVrInputHandler, true);
        rdVrInputHandler = null;
    }
}

// Scene lifecycle handler (shared by 360 rotation and button navigation)
function rdVrOnSceneChange(from, to) {
    // Leaving
    if (from === 'session') {
        if (rdVrNativeData._outputPoll) { clearInterval(rdVrNativeData._outputPoll); rdVrNativeData._outputPoll = null; }
        rdVrDetachInput();
    }
    if ((from === 'hub' || from === 'session' || from === 'permissions') && to === 'desktop') {
        if (rdVrNativePollTimer) { clearInterval(rdVrNativePollTimer); rdVrNativePollTimer = null; }
    }
    // Entering
    if (to === 'hub' || to === 'permissions') {
        if (!rdVrNativePollTimer) {
            rdVrNativeFetch();
            rdVrNativePollTimer = setInterval(rdVrNativeFetch, 3000);
        }
    }
    if (to === 'session' && rdVrNativeData.activeSession) {
        rdVrNativeFetchOutput(rdVrNativeData.activeSession);
        rdVrNativeData._outputPoll = setInterval(() => {
            if (rdVrScene === 'session' && rdVrNativeData.activeSession)
                rdVrNativeFetchOutput(rdVrNativeData.activeSession);
        }, 3000);
        rdVrAttachInput();
    }
}

// Navigate within hub world (works in both 360 and flat mode)
function rdVrNavigateTo(sceneName) {
    if (sceneName === 'desktop') { rdVrGoDesktop(); return; }
    if (rdVrScene === 'desktop') { rdVrGoHub(); } // enter hub world first
    if (rdVr360Mode) {
        const panel = RD_VR_PANELS.find(p => p.scene === sceneName);
        if (panel) rdVrTargetYaw = panel.yaw;
    } else {
        rdVrOnSceneChange(rdVrScene, sceneName);
        rdVrScene = sceneName;
        rdVrLastFacingScene = sceneName;
    }
}

function rdVrToggle360() {
    rdVr360Mode = !rdVr360Mode;
    if (rdVr360Mode) {
        // Entering 360: set yaw to current scene's panel position
        const panel = RD_VR_PANELS.find(p => p.scene === rdVrScene);
        if (panel) { rdVrYaw = panel.yaw; rdVrTargetYaw = panel.yaw; }
    } else {
        // Leaving 360: reset horizontal pan
        rdVrPanX = 0; rdVrTargetPanX = 0;
    }
    if (typeof toast === 'function') toast('360: ' + (rdVr360Mode ? 'ON' : 'OFF'), 'info');
}

function rdVrGoHub() {
    // Enter hub world from desktop (scene switch, not 360 rotation)
    rdVrOnSceneChange(rdVrScene, 'hub');
    rdVrScene = 'hub';
    rdVrLastFacingScene = 'hub';
    rdVrYaw = 0; rdVrTargetYaw = 0; // reset yaw to hub center
    rdVrFadeIn = 0; // cinematic entrance into the hub world
    if (!rdVrNativePollTimer) {
        rdVrNativeFetch();
        rdVrNativePollTimer = setInterval(rdVrNativeFetch, 3000);
    }
}

function rdVrSwipeSession(direction) {
    const sessions = rdVrNativeData.sessions;
    if (sessions.length < 2) return;
    const curIdx = sessions.findIndex(s => s.name === rdVrNativeData.activeSession);
    if (curIdx < 0) return;
    let nextIdx = curIdx + direction;
    if (nextIdx < 0) nextIdx = sessions.length - 1;
    if (nextIdx >= sessions.length) nextIdx = 0;
    rdVrNativeData.activeSession = sessions[nextIdx].name;
    rdVrNativeData.outputScroll = 0;
    rdVrInputBuffer = '';
    rdVrNativeFetchOutput(rdVrNativeData.activeSession);
}

function rdVrGoDesktop() {
    // Exit hub world back to desktop
    rdVrOnSceneChange(rdVrScene, 'desktop');
    rdVrScene = 'desktop';
    rdVrLastFacingScene = 'desktop';
    rdVrPanX = 0; rdVrTargetPanX = 0;
    rdVrFadeIn = 0; // cinematic transition back
    if (rdVrNativePollTimer) { clearInterval(rdVrNativePollTimer); rdVrNativePollTimer = null; }
}

// ── Hub Renderer ──
function rdVrRenderHub(ctx, halfW, ch, baseX, baseY, drawW, drawH, dpr) {
    if (!rdVrHubCanvas) rdVrHubCanvas = document.createElement('canvas');
    const c = rdVrHubCanvas;
    c.width = VRN_W; c.height = VRN_H;
    const g = c.getContext('2d');

    g.fillStyle = VRN_BG;
    g.fillRect(0, 0, VRN_W, VRN_H);

    // Border
    g.strokeStyle = VRN_DIM;
    g.lineWidth = 2;
    g.strokeRect(1, 1, VRN_W - 2, VRN_H - 2);

    // Header
    g.fillStyle = 'rgba(48, 208, 255, 0.1)';
    g.fillRect(0, 0, VRN_W, 28);
    g.font = 'bold 13px monospace';
    g.fillStyle = VRN_CYAN;
    g.textBaseline = 'top';
    g.fillText('TSRCT COMMAND CENTER', 10, 7);

    // Clock + perm count
    const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const permCount = rdVrNativeData.permissions.length;
    g.font = '11px monospace';
    g.textAlign = 'right';
    g.fillText(clock, VRN_W - 10, 9);
    if (permCount > 0) {
        g.fillStyle = VRN_RED;
        g.fillText('[!' + permCount + ']', VRN_W - 70, 9);
    }
    g.textAlign = 'left';

    // Session cards - 2 column grid
    const sessions = rdVrNativeData.sessions;
    const cardW = 440;
    const cardH = 110;
    const gap = 10;
    const startX = (VRN_W - cardW * 2 - gap) / 2;
    const startY = 38;

    for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const col = i % 2;
        const row = Math.floor(i / 2);
        const cx = startX + col * (cardW + gap);
        const cy = startY + row * (cardH + gap);

        if (cy + cardH > VRN_H - 40) break; // don't draw off-screen

        // Check if this session has pending permissions
        const hasPerm = rdVrNativeData.permissions.some(p => p.session === s.name);

        // Card background
        g.fillStyle = (rdVrHubHover === i) ? 'rgba(48, 208, 255, 0.08)' : 'rgba(255, 255, 255, 0.02)';
        g.fillRect(cx, cy, cardW, cardH);

        // Card border
        if (hasPerm) {
            const pulse = Math.sin(rdVrFrameCount * 0.08) * 0.5 + 0.5;
            g.strokeStyle = `rgba(255, 64, 96, ${0.3 + pulse * 0.5})`;
            g.lineWidth = 2;
        } else if (rdVrHubHover === i) {
            g.strokeStyle = VRN_CYAN;
            g.lineWidth = 2;
        } else {
            g.strokeStyle = VRN_DIM;
            g.lineWidth = 1;
        }
        g.strokeRect(cx, cy, cardW, cardH);

        // Session name
        g.font = 'bold 13px monospace';
        g.fillStyle = VRN_CYAN;
        g.fillText(s.name, cx + 10, cy + 10);

        // Badges
        g.font = '10px monospace';
        let badgeX = cx + 10;
        const badgeY = cy + 30;
        if (s.current) {
            g.fillStyle = VRN_GREEN;
            g.fillText('[>]', badgeX, badgeY); badgeX += 30;
        }
        if (s.protected) {
            g.fillStyle = 'rgba(255, 200, 0, 0.7)';
            g.fillText('[*]', badgeX, badgeY); badgeX += 30;
        }
        g.fillStyle = 'rgba(255, 255, 255, 0.4)';
        g.fillText('[' + (s.windows || 1) + ' win]', badgeX, badgeY); badgeX += 60;
        if (s.attached) {
            g.fillStyle = VRN_GREEN;
            g.fillText('[att]', badgeX, badgeY);
        }
        if (hasPerm) {
            g.fillStyle = VRN_RED;
            g.fillText('[PERM]', cx + cardW - 55, badgeY);
        }

        // Status dot
        g.beginPath();
        g.arc(cx + cardW - 14, cy + 14, 4, 0, Math.PI * 2);
        g.fillStyle = hasPerm ? VRN_RED : (s.attached ? VRN_GREEN : VRN_DIM);
        g.fill();
    }

    // Bottom bar buttons
    const btnY = VRN_H - 30;
    const btns = [
        { label: '[+NEW]', x: 30, w: 70, id: 'new' },
        { label: '[PERMS:' + permCount + ']', x: 130, w: 100, id: 'perms' },
        { label: '[DESKTOP]', x: VRN_W - 120, w: 100, id: 'desktop' }
    ];
    g.font = '11px monospace';
    for (const b of btns) {
        g.fillStyle = (b.id === 'perms' && permCount > 0) ? 'rgba(255, 64, 96, 0.2)' : 'rgba(255, 255, 255, 0.05)';
        g.fillRect(b.x, btnY, b.w, 22);
        g.strokeStyle = VRN_DIM;
        g.lineWidth = 1;
        g.strokeRect(b.x, btnY, b.w, 22);
        g.fillStyle = (b.id === 'perms' && permCount > 0) ? VRN_RED : VRN_CYAN;
        g.fillText(b.label, b.x + 6, btnY + 5);
    }

    // Draw stereo
    rdVrDrawStereo(ctx, c, halfW, ch, baseX, baseY, drawW, drawH);
}

// ── Session View Renderer ──
function rdVrRenderSession(ctx, halfW, ch, baseX, baseY, drawW, drawH, dpr) {
    if (!rdVrSessionCanvas) rdVrSessionCanvas = document.createElement('canvas');
    const c = rdVrSessionCanvas;
    c.width = VRN_W; c.height = VRN_H;
    const g = c.getContext('2d');

    const sess = rdVrNativeData.activeSession || '?';
    const hasPerm = rdVrNativeData.permissions.some(p => p.session === sess);

    g.fillStyle = VRN_BG;
    g.fillRect(0, 0, VRN_W, VRN_H);

    // Permission alert bar
    let headerOffset = 0;
    if (hasPerm) {
        const perm = rdVrNativeData.permissions.find(p => p.session === sess);
        const pulse = Math.sin(rdVrFrameCount * 0.1) * 0.3 + 0.7;
        g.fillStyle = `rgba(255, 64, 96, ${0.15 * pulse})`;
        g.fillRect(0, 0, VRN_W, 40);
        g.font = '11px monospace';
        g.fillStyle = VRN_RED;
        g.textBaseline = 'top';
        const desc = perm ? ('[' + (perm.tool || '?') + '] ' + (perm.description || '').slice(0, 70)) : 'Permission pending';
        g.fillText(desc, 10, 5);
        // Approve/deny buttons
        g.fillStyle = 'rgba(0, 255, 170, 0.2)';
        g.fillRect(VRN_W - 120, 22, 50, 16);
        g.fillStyle = VRN_GREEN;
        g.fillText('[OK]', VRN_W - 115, 24);
        g.fillStyle = 'rgba(255, 64, 96, 0.2)';
        g.fillRect(VRN_W - 60, 22, 50, 16);
        g.fillStyle = VRN_RED;
        g.fillText('[NO]', VRN_W - 55, 24);
        headerOffset = 40;
    }

    // Header
    g.fillStyle = 'rgba(48, 208, 255, 0.1)';
    g.fillRect(0, headerOffset, VRN_W, 22);
    g.font = 'bold 12px monospace';
    g.fillStyle = VRN_CYAN;
    g.textBaseline = 'top';
    g.fillText('[' + sess + ']', 10, headerOffset + 5);
    g.font = '10px monospace';
    g.fillStyle = VRN_DIM;
    g.fillText('[<< HUB]', VRN_W - 70, headerOffset + 6);

    // Input bar (bottom 30px)
    const inputH = 30;
    const inputY = VRN_H - inputH;
    g.fillStyle = 'rgba(48, 208, 255, 0.08)';
    g.fillRect(0, inputY, VRN_W, inputH);
    g.strokeStyle = VRN_DIM;
    g.lineWidth = 1;
    g.moveTo(0, inputY); g.lineTo(VRN_W, inputY); g.stroke();

    // Input text with cursor at correct position
    g.font = '12px monospace';
    g.fillStyle = VRN_GREEN;
    const prompt = '> ';
    // Clamp cursor
    if (rdVrInputCursor > rdVrInputBuffer.length) rdVrInputCursor = rdVrInputBuffer.length;
    // Draw text before cursor, cursor, text after cursor
    const beforeCur = rdVrInputBuffer.slice(0, rdVrInputCursor);
    const afterCur = rdVrInputBuffer.slice(rdVrInputCursor);
    const cursorChar = (rdVrFrameCount % 40 < 25) ? '|' : '';
    g.fillText(prompt + beforeCur + cursorChar + afterCur, 8, inputY + 8, VRN_W - 16);

    // Store input bar metrics for click-to-position
    g._vrInputY = inputY;
    g._vrInputCharW = g.measureText('M').width; // monospace char width
    g._vrInputPromptW = g.measureText(prompt).width;

    // MIC indicator
    if (typeof rdVncWantRecording !== 'undefined' && rdVncWantRecording) {
        g.fillStyle = VRN_RED;
        g.beginPath();
        g.arc(VRN_W - 16, inputY + 15, 5, 0, Math.PI * 2);
        g.fill();
    }

    // Terminal output
    const lines = (rdVrNativeData.output || '').split('\n');
    const lineH = 14;
    const termTop = headerOffset + 26;
    const termH = inputY - termTop - 4;
    const maxLines = Math.floor(termH / lineH);
    const scroll = Math.max(0, rdVrNativeData.outputScroll);
    const visStart = Math.max(0, lines.length - maxLines - scroll);
    const visLines = lines.slice(visStart, visStart + maxLines);

    g.font = '12px monospace';
    g.fillStyle = VRN_CYAN;
    for (let i = 0; i < visLines.length; i++) {
        g.fillText(visLines[i], 8, termTop + i * lineH, VRN_W - 16);
    }

    // Border
    g.strokeStyle = VRN_DIM;
    g.lineWidth = 2;
    g.strokeRect(1, 1, VRN_W - 2, VRN_H - 2);

    rdVrDrawStereo(ctx, c, halfW, ch, baseX, baseY, drawW, drawH);
}

// ── Permission View Renderer ──
function rdVrRenderPermissions(ctx, halfW, ch, baseX, baseY, drawW, drawH, dpr) {
    if (!rdVrPermCanvas) rdVrPermCanvas = document.createElement('canvas');
    const c = rdVrPermCanvas;
    c.width = VRN_W; c.height = VRN_H;
    const g = c.getContext('2d');

    g.fillStyle = VRN_BG;
    g.fillRect(0, 0, VRN_W, VRN_H);

    // Header
    const perms = rdVrNativeData.permissions;
    g.fillStyle = 'rgba(48, 208, 255, 0.1)';
    g.fillRect(0, 0, VRN_W, 28);
    g.font = 'bold 13px monospace';
    g.fillStyle = VRN_CYAN;
    g.textBaseline = 'top';
    g.fillText('PENDING PERMISSIONS [' + perms.length + ']', 10, 7);
    g.font = '10px monospace';
    g.fillStyle = VRN_DIM;
    g.textAlign = 'right';
    g.fillText('[<< HUB]', VRN_W - 10, 9);
    g.textAlign = 'left';

    if (perms.length === 0) {
        g.font = '14px monospace';
        g.fillStyle = VRN_GREEN;
        g.textAlign = 'center';
        g.fillText('No pending permissions', VRN_W / 2, VRN_H / 2 - 10);
        g.textAlign = 'left';
    } else {
        const cardH = 80;
        const gap = 6;
        let y = 36;

        for (let i = 0; i < perms.length && y + cardH < VRN_H - 35; i++) {
            const p = perms[i];
            const hovered = (rdVrPermHover === i);

            // Tool color
            const toolColor = (p.tool === 'Bash') ? 'rgba(255, 180, 0, 0.3)' :
                (p.tool === 'Edit' || p.tool === 'Write') ? 'rgba(255, 200, 60, 0.2)' : 'rgba(48, 208, 255, 0.15)';

            g.fillStyle = hovered ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.3)';
            g.fillRect(8, y, VRN_W - 16, cardH);
            g.strokeStyle = toolColor;
            g.lineWidth = hovered ? 2 : 1;
            g.strokeRect(8, y, VRN_W - 16, cardH);

            // Tool name
            g.font = 'bold 12px monospace';
            g.fillStyle = VRN_CYAN;
            g.fillText('[' + (p.tool || '?') + ']', 16, y + 8);

            // Session
            if (p.session) {
                g.font = '9px monospace';
                g.fillStyle = VRN_DIM;
                g.fillText(p.session, 100, y + 10);
            }

            // Description
            g.font = '11px monospace';
            g.fillStyle = 'rgba(255, 255, 255, 0.7)';
            g.fillText((p.description || '').slice(0, 80), 16, y + 28, VRN_W - 40);

            // Detail (command/file)
            const detail = p.command || p.file || p.detail || '';
            if (detail) {
                g.font = '10px monospace';
                g.fillStyle = 'rgba(255, 255, 255, 0.4)';
                g.fillText(detail.slice(0, 90), 16, y + 44, VRN_W - 40);
            }

            // Approve/Deny buttons
            g.fillStyle = 'rgba(0, 255, 170, 0.15)';
            g.fillRect(VRN_W - 130, y + 56, 50, 18);
            g.fillStyle = VRN_GREEN;
            g.font = '10px monospace';
            g.fillText('[OK]', VRN_W - 124, y + 60);

            g.fillStyle = 'rgba(255, 64, 96, 0.15)';
            g.fillRect(VRN_W - 70, y + 56, 50, 18);
            g.fillStyle = VRN_RED;
            g.fillText('[NO]', VRN_W - 64, y + 60);

            y += cardH + gap;
        }
    }

    // Bottom bar
    const btnY = VRN_H - 28;
    if (perms.length > 0) {
        g.fillStyle = 'rgba(0, 255, 170, 0.1)';
        g.fillRect(30, btnY, 100, 20);
        g.strokeStyle = VRN_DIM; g.lineWidth = 1;
        g.strokeRect(30, btnY, 100, 20);
        g.fillStyle = VRN_GREEN;
        g.font = '10px monospace';
        g.fillText('[APPROVE ALL]', 36, btnY + 5);

        g.fillStyle = 'rgba(255, 64, 96, 0.1)';
        g.fillRect(140, btnY, 90, 20);
        g.strokeRect(140, btnY, 90, 20);
        g.fillStyle = VRN_RED;
        g.fillText('[DENY ALL]', 146, btnY + 5);
    }

    g.strokeStyle = VRN_DIM;
    g.lineWidth = 2;
    g.strokeRect(1, 1, VRN_W - 2, VRN_H - 2);

    rdVrDrawStereo(ctx, c, halfW, ch, baseX, baseY, drawW, drawH);
}

// Helper: draw offscreen canvas into both eyes with correct stereo
function rdVrDrawStereo(ctx, src, halfW, ch, baseX, baseY, drawW, drawH) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, halfW, ch); ctx.clip();
    ctx.drawImage(src, baseX - rdVrIPD, baseY, drawW, drawH);
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(halfW, 0, halfW, ch); ctx.clip();
    ctx.drawImage(src, halfW + baseX + rdVrIPD, baseY, drawW, drawH);
    ctx.restore();

    // Glow border
    const glowColor = (rdVrScene === 'desktop') ? 'rgba(168, 0, 255, 0.15)' : 'rgba(48, 208, 255, 0.15)';
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = 1;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, halfW, ch); ctx.clip();
    ctx.strokeRect(baseX - rdVrIPD, baseY, drawW, drawH);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(halfW, 0, halfW, ch); ctx.clip();
    ctx.strokeRect(halfW + baseX + rdVrIPD, baseY, drawW, drawH);
    ctx.restore();
}

// Hit testing for VR Native scenes
function rdVrNativeHitTest(normX, normY) {
    // Convert normalized cursor pos (0-1 within VNC texture) to offscreen canvas coords
    const cx = normX * VRN_W;
    const cy = normY * VRN_H;

    if (rdVrScene === 'hub') {
        const sessions = rdVrNativeData.sessions;
        const cardW = 440, cardH = 110, gap = 10;
        const startX = (VRN_W - cardW * 2 - gap) / 2;
        const startY = 38;

        // Check session cards
        for (let i = 0; i < sessions.length; i++) {
            const col = i % 2, row = Math.floor(i / 2);
            const bx = startX + col * (cardW + gap);
            const by = startY + row * (cardH + gap);
            if (cx >= bx && cx <= bx + cardW && cy >= by && cy <= by + cardH) {
                rdVrHubHover = i;
                return { type: 'card', index: i, session: sessions[i].name };
            }
        }
        rdVrHubHover = -1;

        // Bottom buttons
        const btnY = VRN_H - 30;
        if (cy >= btnY && cy <= btnY + 22) {
            if (cx >= 30 && cx <= 100) return { type: 'button', id: 'new' };
            if (cx >= 130 && cx <= 230) return { type: 'button', id: 'perms' };
            if (cx >= VRN_W - 120 && cx <= VRN_W - 20) return { type: 'button', id: 'desktop' };
        }
        return null;
    }

    if (rdVrScene === 'session') {
        const hasPerm = rdVrNativeData.permissions.some(p => p.session === rdVrNativeData.activeSession);
        const headerOffset = hasPerm ? 40 : 0;

        // Back button
        if (cy >= headerOffset && cy <= headerOffset + 22 && cx >= VRN_W - 70) {
            return { type: 'button', id: 'hub' };
        }
        // Permission buttons
        if (hasPerm && cy >= 22 && cy <= 38) {
            if (cx >= VRN_W - 120 && cx <= VRN_W - 70) return { type: 'button', id: 'approve' };
            if (cx >= VRN_W - 60 && cx <= VRN_W - 10) return { type: 'button', id: 'deny' };
        }
        // Click on input bar = position cursor
        const inputY = VRN_H - 30;
        if (cy >= inputY) {
            // Calculate char position from click X
            // Monospace: each char ~7.2px at 12px font
            const charW = 7.2;
            const promptW = charW * 2; // "> " = 2 chars
            const clickCharPos = Math.round((cx - 8 - promptW) / charW);
            const newPos = Math.max(0, Math.min(rdVrInputBuffer.length, clickCharPos));
            return { type: 'input_click', pos: newPos };
        }
        return null;
    }

    if (rdVrScene === 'permissions') {
        // Back button
        if (cy <= 28 && cx >= VRN_W - 70) return { type: 'button', id: 'hub' };

        // Permission cards
        const perms = rdVrNativeData.permissions;
        const cardH = 80, gap = 6;
        let y = 36;
        for (let i = 0; i < perms.length && y + cardH < VRN_H - 35; i++) {
            if (cy >= y && cy <= y + cardH) {
                rdVrPermHover = i;
                // Approve/deny buttons within card
                if (cy >= y + 56 && cy <= y + 74) {
                    if (cx >= VRN_W - 130 && cx <= VRN_W - 80) return { type: 'perm_approve', index: i, id: perms[i].id };
                    if (cx >= VRN_W - 70 && cx <= VRN_W - 20) return { type: 'perm_deny', index: i, id: perms[i].id };
                }
                return { type: 'perm_card', index: i };
            }
            y += cardH + gap;
        }
        rdVrPermHover = -1;

        // Bottom buttons
        const btnY = VRN_H - 28;
        if (cy >= btnY && cy <= btnY + 20) {
            if (cx >= 30 && cx <= 130) return { type: 'button', id: 'approve_all' };
            if (cx >= 140 && cx <= 230) return { type: 'button', id: 'deny_all' };
        }
        return null;
    }

    return null;
}

// Handle clicks in VR Native scenes
function rdVrNativeClick(normX, normY) {
    const hit = rdVrNativeHitTest(normX, normY);
    if (!hit) return false;

    if (rdVrScene === 'hub') {
        if (hit.type === 'card') {
            rdVrNativeData.activeSession = hit.session;
            rdVrNativeData.outputScroll = 0;
            rdVrInputBuffer = '';
            rdVrInputCursor = 0;
            rdVrNavigateTo('session');
            return true;
        }
        if (hit.type === 'button') {
            if (hit.id === 'new') {
                const tk = localStorage.getItem('cbt') || '';
                fetch('/api/session/new', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: tk }, body: '{}' })
                    .then(() => rdVrNativeFetch());
            }
            if (hit.id === 'perms') rdVrNavigateTo('permissions');
            if (hit.id === 'desktop') rdVrGoDesktop();
            return true;
        }
    }

    if (rdVrScene === 'session') {
        if (hit.type === 'input_click') {
            rdVrInputCursor = hit.pos;
            return true;
        }
        if (hit.type === 'button') {
            if (hit.id === 'hub') rdVrNavigateTo('hub');
            if (hit.id === 'approve') {
                const perm = rdVrNativeData.permissions.find(p => p.session === rdVrNativeData.activeSession);
                if (perm) rdVrPermAction(perm.id, 'approve');
            }
            if (hit.id === 'deny') {
                const perm = rdVrNativeData.permissions.find(p => p.session === rdVrNativeData.activeSession);
                if (perm) rdVrPermAction(perm.id, 'deny');
            }
            return true;
        }
    }

    if (rdVrScene === 'permissions') {
        if (hit.type === 'button') {
            if (hit.id === 'hub') rdVrNavigateTo('hub');
            if (hit.id === 'approve_all') {
                rdVrNativeData.permissions.forEach(p => rdVrPermAction(p.id, 'approve'));
            }
            if (hit.id === 'deny_all') {
                rdVrNativeData.permissions.forEach(p => rdVrPermAction(p.id, 'deny'));
            }
            return true;
        }
        if (hit.type === 'perm_approve') { rdVrPermAction(hit.id, 'approve'); return true; }
        if (hit.type === 'perm_deny') { rdVrPermAction(hit.id, 'deny'); return true; }
    }

    return false;
}

export {
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
};
