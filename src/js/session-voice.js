// TSRCT - Session Voice Alerts
//
// Speaks a session's name aloud when it finishes / needs you, but ONLY while the
// TSRCT window is unfocused (you're working on another window/monitor). The point:
// when you're not looking at TSRCT, you still hear "wineries finished" and know to
// go back and check that one.
//
// Detection is backend-driven: lib/dispatcher/sessionMonitor polls tmux every ~10s,
// classifies each session (working / waiting_input / done / failed / idle), and logs
// real state TRANSITIONS to the activity log. We poll /api/dispatcher/session-events
// for those transitions and announce the ones that mean "finished / needs you":
//   done          -> "<name> finished"
//   waiting_input -> "<name> needs input"
//   failed        -> "<name> failed"
// Transitions INTO working/idle are ignored (no chatter while it's mid-run).
//
// Opt-in: toggled with the [V] button in the PC sidebar. The enabling click also
// primes the Web Speech API (browsers gate speech behind a user gesture).

const SessionVoice = (() => {
    const STORAGE_KEY = 'tsrct_session_voice';
    const POLL_MS = 8000;
    const REPEAT_COOLDOWN_MS = 20000; // don't re-announce the same session within 20s

    // States worth speaking, and how to phrase them.
    const ANNOUNCE = {
        done: 'finished',
        waiting_input: 'needs input',
        failed: 'failed',
    };

    // MUTE is a separate, louder switch than [V] (2026-09-18). [V] is a
    // preference ("announce sessions when I am away"); MUTE is "no voice comes
    // out of TSRCT at all, whatever asked for it" — it also gates hands-free's
    // hfSpeak(). Separate keys on purpose: unmuting must not silently turn
    // session alerts back on, and muting must not lose the [V] preference.
    const MUTE_KEY = 'tsrct_voice_mute';
    let muted = false;
    let enabled = false;
    let timer = null;
    let lastSeenId = 0;                 // activity-log cursor
    let primed = false;                 // speechSynthesis unlocked by a gesture
    const lastSpokenAt = new Map();     // session name -> ms timestamp

    const hasTTS = typeof window !== 'undefined' && 'speechSynthesis' in window;

    // Voice selection: prefer a female English voice. Voice names vary by OS/browser
    // (Windows: Zira/Aria/Jenny; macOS: Samantha/Karen; Chrome: Google US English),
    // so we match on a hint list, then fall back to any en-US, any English, then default.
    const FEMALE_HINTS = [
        'zira', 'aria', 'jenny', 'michelle', 'eva', 'samantha', 'karen', 'tessa',
        'moira', 'fiona', 'serena', 'catherine', 'susan', 'linda', 'heera', 'female',
        'google us english', 'google uk english female',
    ];
    let selectedVoice = null;

    function pickVoice() {
        if (!hasTTS) return;
        const voices = window.speechSynthesis.getVoices() || [];
        if (!voices.length) return; // not loaded yet; voiceschanged will re-run this
        const en = voices.filter(v => /^en([-_]|$)/i.test(v.lang));
        const pool = en.length ? en : voices;
        const female = pool.find(v => FEMALE_HINTS.some(h => v.name.toLowerCase().includes(h)));
        selectedVoice = female
            || pool.find(v => /en[-_]us/i.test(v.lang))
            || pool[0]
            || null;
    }

    if (hasTTS) {
        pickVoice();
        // Voices often load asynchronously after first access.
        try { window.speechSynthesis.addEventListener('voiceschanged', pickVoice); } catch (e) {}
    }

    // Strip the dispatcher's "cc-" prefix and turn dashes into spaces so the name
    // reads naturally ("cc-winery-recon" -> "winery recon").
    function speakable(name) {
        return String(name || '')
            .replace(/^cc-/, '')
            .replace(/[-_]+/g, ' ')
            .trim() || 'a session';
    }

    function speak(text) {
        if (!hasTTS || muted) return;
        try {
            const u = new SpeechSynthesisUtterance(text);
            u.lang = 'en-US';
            if (!selectedVoice) pickVoice();
            if (selectedVoice) u.voice = selectedVoice;
            u.rate = 1.0;
            u.volume = 1.0;
            window.speechSynthesis.speak(u);
        } catch (e) { /* ignore */ }
    }

    function updateButton() {
        const btn = document.getElementById('pc-sidebar-voice-btn');
        if (btn) {
            btn.classList.toggle('active', enabled && !muted);
            btn.classList.toggle('muted', muted);
        }
        const mute = document.getElementById('pc-mute-toggle');
        if (mute) {
            mute.classList.toggle('active', muted);
            mute.textContent = muted ? 'MUTED' : 'MUTE';
            mute.title = muted
                ? 'Voice is off: no session alerts, no hands-free speech. Click to allow voice again'
                : 'Mute every voice TSRCT can make (session alerts and hands-free)';
        }
    }

    function toast(msg) {
        // sessions.js exports `toast`; `showToast` does not exist in this tree, so
        // on its own this helper was a no-op and every message here was lost.
        if (typeof window.toast === 'function') window.toast(msg, 'info', false);
        else if (typeof window.showToast === 'function') window.showToast(msg);
    }

    async function poll() {
        if (!enabled) return;
        try {
            const r = await fetch(`/api/dispatcher/session-events?since=${lastSeenId}`);
            if (r.ok) {
                const data = await r.json();
                const events = Array.isArray(data.events) ? data.events : [];
                // Focused (looking at TSRCT)  -> glow the session's split panel in its color.
                // Unfocused (another window)  -> speak the session name aloud.
                // Either branch advances the cursor so we never replay a backlog later.
                const focused = document.hasFocus();
                for (const ev of events) {
                    const to = ev.meta && ev.meta.to;
                    const session = (ev.meta && ev.meta.session) || '';
                    if (!session) continue;
                    // Resumed working -> any prior glow no longer applies.
                    if (to === 'working' && typeof window.pcClearAttention === 'function') {
                        window.pcClearAttention(session);
                    }
                    const phrase = ANNOUNCE[to];
                    if (!phrase) continue;
                    if (focused) {
                        // Glow instead of speak. No-op outside split mode (no panel).
                        if (typeof window.pcGlowAttention === 'function') window.pcGlowAttention(session);
                    } else {
                        const now = ev.at || Date.now();
                        const prev = lastSpokenAt.get(session) || 0;
                        if (now - prev < REPEAT_COOLDOWN_MS) continue; // anti-spam per session
                        lastSpokenAt.set(session, Date.now());
                        speak(`${speakable(session)} ${phrase}`);
                    }
                }
                // Advance cursor past everything we just saw.
                lastSeenId = Math.max(lastSeenId, Number(data.latest) || lastSeenId);
            }
        } catch (e) { /* network hiccup — try again next tick */ }
    }

    function loop() {
        if (!enabled) return;
        poll().finally(() => {
            if (enabled) timer = setTimeout(loop, POLL_MS);
        });
    }

    async function primeCursor() {
        // Start from the current tail so enabling doesn't dump a backlog of old
        // transitions as a burst of speech.
        try {
            const r = await fetch('/api/dispatcher/session-events?since=0');
            if (r.ok) {
                const data = await r.json();
                lastSeenId = Number(data.latest) || 0;
            }
        } catch (e) { /* if it fails, first poll will catch up */ }
    }

    async function enable() {
        if (enabled) return;
        // Turning [V] on while muted would light the button and stay silent, so
        // the explicit request wins over the standing one.
        if (muted) setMuted(false);
        enabled = true;
        localStorage.setItem(STORAGE_KEY, '1');
        updateButton();
        // This call typically rides on a user click -> unlock speech.
        if (hasTTS && !primed) { primed = true; speak('Voice alerts on'); }
        if (!hasTTS) toast('[!] Speech synthesis not supported in this browser');
        await primeCursor();
        loop();
    }

    function disable() {
        enabled = false;
        localStorage.setItem(STORAGE_KEY, '0');
        if (timer) { clearTimeout(timer); timer = null; }
        if (hasTTS) { try { window.speechSynthesis.cancel(); } catch (e) {} }
        updateButton();
    }

    function toggle() {
        if (enabled) { disable(); toast('[V] Session alerts off'); }
        else { enable(); toast('[V] Session alerts on (voice when away, panel glow when here)'); }
    }

    function isEnabled() { return enabled; }

    // ── The kill switch ──────────────────────────────────────────────────────
    function setMuted(on) {
        muted = !!on;
        try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* private mode */ }
        // Shut up whatever is mid-sentence, including a hands-free answer.
        if (muted && hasTTS) { try { window.speechSynthesis.cancel(); } catch (e) {} }
        updateButton();
    }

    function isMuted() { return muted; }

    function toggleMute() {
        setMuted(!muted);
        toast(muted
            ? '[x] Voice muted (session alerts and hands-free)'
            : '[V] Voice allowed again' + (enabled ? '' : ' - [V] session alerts are still off'));
    }

    // Manual smoke test from the console: SessionVoice.test()
    function test() {
        if (!hasTTS) { toast('[!] No speech synthesis'); return; }
        primed = true;
        speak('wineries finished');
    }

    // Restore the saved preference on load. We don't auto-speak here (no gesture
    // yet), but if it was on we resume polling; the first real event after a user
    // gesture will speak fine.
    function init() {
        try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { muted = false; }
        enabled = localStorage.getItem(STORAGE_KEY) === '1';
        updateButton();
        // Still poll while muted: the panel glow for a session that needs you is
        // the silent half of this feature, and muting is about the noise.
        if (enabled) { primeCursor().then(loop); }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return { enable, disable, toggle, isEnabled, test, setMuted, isMuted, toggleMute, updateButton };
})();

window.SessionVoice = SessionVoice;
// The header button is inline onclick in desktop.js, so the name has to be global.
window.toggleVoiceMute = () => SessionVoice.toggleMute();
