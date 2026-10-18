// ─────────────────────────────────────────────────────────────────────────
// tour.js — the guided first look at TSRCT. Optional, and short.
//
// The first time a logged-in browser opens TSRCT it offers the tour once
// ("Show me" / "No thanks"); either answer is remembered in this browser.
// After that it runs only when asked: the [?] button (desktop header), the
// TOUR button (phone tools), or Tesla ("mostrame la app" / "show me around").
//
// Each step points at one real control and says what it is for in a line or
// two. A step whose control is not on screen (a panel that is closed, a
// feature turned off) is skipped, never shown pointing at nothing.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const DONE_KEY = 'tsrct-tour-done';
    const pc = () => document.body.classList.contains('pc-mode');

    const DESKTOP = [
        ['#pc-rail', 'The rail', 'Sessions, runners, notes, git, Salesforce and what today cost. One panel at a time; Ctrl+B hides it.'],
        ['#pc-sessions', 'Every session, live', 'Each Claude Code session in tmux, with a dot for its state: working, waiting for you, or failed. Drag one onto another to see them side by side.'],
        ['button[onclick="pcCreateSession()"]', 'A new session', 'Start Claude Code in any project folder. It keeps running in tmux even when this page is closed.'],
        ['#pc-terminal', 'The session on screen', 'What it is doing right now. When it asks for permission, the request shows up here and on your phone.'],
        ['#pc-input', 'Your prompt', 'Type here and press Enter. A half-written prompt is kept per session.'],
        ['#pc-mic-btn', 'Dictate', 'Speak instead of typing.'],
        ['#pc-tab-bar', 'The tabs', 'Automations is everything that runs by itself, including the ones you add. Codemap keeps each project mapped for Claude. Notifs has the security audit. Hands On is for learning by typing.'],
        ['#pc-vault-toggle', 'Your notes', 'When this is on, sessions are told to read and update your notes vault.'],
        ['#pc-morning-btn', 'The morning brief', 'What the morning routine found, and the sessions it wants to open.'],
        ['#asst-orb', 'Tesla', 'Your voice assistant. Click and talk: open or stop sessions, ask what one is doing, approve permissions, or have her work on your PC.'],
    ];
    const PHONE = [
        ['#session-btn', 'Your sessions', 'Tap to switch between your Claude Code sessions.'],
        ['#terminal-panel', 'The session, live', 'What it is doing right now. A permission request appears here with Yes and No.'],
        ['#prompt', 'Your prompt', 'Type to the session; the microphone next to it dictates.'],
        ['#quick-bar', 'Quick keys', 'The keys a terminal needs, and the tools: runners, remote desktop, automations and more.'],
        ['#vault-toggle', 'Your notes', 'When this is on, sessions are told to read and update your notes vault.'],
        ['#asst-orb', 'Tesla', 'Your voice assistant. Tap and talk to her.'],
    ];

    let steps = [], at = 0, layer = null;

    function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden';
    }

    function close(done) {
        if (layer) layer.remove();
        layer = null;
        window.removeEventListener('resize', draw);
        if (done) { try { localStorage.setItem(DONE_KEY, '1'); } catch { /* private mode */ } }
    }

    function draw() {
        if (!layer) return;
        const [sel, title, text] = steps[at];
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        const box = layer.querySelector('.tour-spot');
        Object.assign(box.style, { left: (r.left - 6) + 'px', top: (r.top - 6) + 'px', width: (r.width + 12) + 'px', height: (r.height + 12) + 'px' });
        const tip = layer.querySelector('.tour-tip');
        tip.querySelector('.tour-title').textContent = `${title}  (${at + 1}/${steps.length})`;
        tip.querySelector('.tour-text').textContent = text;
        tip.querySelector('.tour-next').textContent = at === steps.length - 1 ? 'Done' : 'Next';
        // Below the control when it fits, otherwise above it.
        const below = r.bottom + 12 + tip.offsetHeight < window.innerHeight;
        const left = Math.min(Math.max(12, r.left), window.innerWidth - tip.offsetWidth - 12);
        tip.style.left = left + 'px';
        tip.style.top = (below ? r.bottom + 12 : Math.max(12, r.top - tip.offsetHeight - 12)) + 'px';
    }

    function tourNext() {
        at++;
        if (at >= steps.length) { close(true); if (typeof toast === 'function') toast('Tour again any time: the [?] button, or ask Tesla', 'info'); return; }
        draw();
    }

    function tourStart() {
        close(false);
        const offer = document.querySelector('.tour-offer');
        if (offer) offer.remove();
        steps = (pc() ? DESKTOP : PHONE).filter(([sel]) => visible(document.querySelector(sel)));
        if (!steps.length) return false;
        at = 0;
        layer = document.createElement('div');
        layer.className = 'tour-layer';
        layer.innerHTML = '<div class="tour-spot"></div><div class="tour-tip"><div class="tour-title"></div><div class="tour-text"></div>' +
            '<div class="tour-btns"><button class="tour-skip" onclick="tourEnd()">Skip tour</button><button class="tour-next" onclick="tourNext()">Next</button></div></div>';
        document.body.appendChild(layer);
        window.addEventListener('resize', draw);
        draw();
        return true;
    }

    function tourEnd() { close(true); }

    // Once per browser, only when logged in and nothing else is on top.
    function offerOnce() {
        try { if (localStorage.getItem(DONE_KEY)) return; } catch { return; }
        if (typeof token === 'undefined' || !token) return;
        const authOpen = document.getElementById('auth');
        if (authOpen && visible(authOpen)) return;
        const card = document.createElement('div');
        card.className = 'tour-offer';
        card.innerHTML = '<div class="tour-title">New to TSRCT?</div><div class="tour-text">A one-minute look at what each part does.</div>' +
            '<div class="tour-btns"><button class="tour-skip" onclick="tourEnd();this.closest(\'.tour-offer\').remove()">No thanks</button>' +
            '<button class="tour-next" onclick="tourStart()">Show me</button></div>';
        document.body.appendChild(card);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(offerOnce, 5000));
    else setTimeout(offerOnce, 5000);

    window.tourStart = tourStart;
    window.tourNext = tourNext;
    window.tourEnd = tourEnd;
})();
