// ==============================================
// TSRCT - Shared Utilities
// Loaded right after app.js, before every other module, so these globals
// are available everywhere (including the IIFE-wrapped modules via closure).
// ==============================================

// Escape a value for safe interpolation into HTML -- both text nodes AND
// attribute values (escapes quotes too). Null-safe. This is the single source
// of truth; per-module copies were removed in the Phase 2 de-dup.
function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Single source of truth for Web Speech recognition setup. Each call site passes
// its own handlers; this only de-duplicates the boilerplate (vendor prefix,
// support check, instance creation, config). Returns the recognition instance,
// or null if the browser has no SpeechRecognition. NOTE: handlers that restart
// recognition (rec.start() inside onEnd) should capture the returned instance.
function createSpeechRecognizer(opts) {
    const o = opts || {};
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const rec = new SR();
    rec.continuous = !!o.continuous;
    rec.interimResults = !!o.interimResults;
    rec.lang = o.lang || 'es-ES';
    if (o.maxAlternatives) rec.maxAlternatives = o.maxAlternatives;
    if (o.onStart) rec.onstart = o.onStart;
    if (o.onEnd) rec.onend = o.onEnd;
    if (o.onResult) rec.onresult = o.onResult;
    if (o.onError) rec.onerror = o.onError;
    // A tick every time Chrome opens or closes the microphone - its own
    // automatic restarts included (2026-09-24: "maybe i am dictating something
    // long and i lose signal for a second"). `tick: false` opts out.
    //
    // The OPEN tick plays when start() is CALLED, not on the 'start' event
    // (2026-09-25, "hay silencio en mi turno para hablar" - on DESKTOP; the
    // phone was fine): Windows' default "reduce other sounds by 80% when
    // communications activity is detected" ducks every other sound the moment
    // Chrome takes the microphone, so a tone played on 'start' was swallowed
    // exactly at his turn (Android can duck the same way). start() takes a few hundred ms to open the mic; 70 ms of tone fits
    // before it. A start() that throws is followed by the close tick.
    if (o.tick !== false && rec.addEventListener) {
        const realStart = rec.start.bind(rec);
        rec.start = function () {
            micTick(true);
            try { return realStart(); } catch (e) { micTick(false); throw e; }
        };
        rec.addEventListener('end', () => micTick(false));
    }
    return rec;
}

// Two short tones made on the spot (no sound files): a rising one when the
// microphone opens, a falling one when it closes. ~70 ms each. Scheduled one
// after the other, so Chrome's close-and-reopen (a few ms apart) is heard as
// two distinct ticks and not one smeared chirp.
let micTickCtx = null;
let micTickNext = 0;
function micTickContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    micTickCtx = micTickCtx || new AC();
    return micTickCtx;
}
// A phone keeps a page's audio muted until the page is touched. Unlock on the
// first touch, so a tick that comes later (no touch of its own) is heard.
(function unlockOnTouch() {
    const unlock = () => {
        try { const c = micTickContext(); if (c && c.state === 'suspended') c.resume().catch(() => {}); } catch (e) {}
    };
    ['pointerdown', 'touchend', 'keydown'].forEach(ev => document.addEventListener(ev, unlock, { capture: true, passive: true }));
})();
function micTick(on) {
    try {
        const ctx = micTickContext();
        if (!ctx) return;
        const play = () => {
            const at = Math.max(ctx.currentTime + 0.005, micTickNext);
            micTickNext = at + 0.09;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(on ? 880 : 660, at);
            osc.frequency.exponentialRampToValueAtTime(on ? 1320 : 440, at + 0.06);
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(0.1, at + 0.008);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
            osc.connect(gain).connect(ctx.destination);
            osc.start(at);
            osc.stop(at + 0.08);
        };
        if (ctx.state === 'suspended') ctx.resume().then(play).catch(() => {});
        else play();
    } catch (e) { /* a missing tick must never break dictation */ }
}
