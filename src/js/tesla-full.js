// ─────────────────────────────────────────────────────────────────────────
// tesla-full.js — Tesla full screen (2026-10-24): one real-time interface for
// her, on desktop and on a phone alike.
//
// Her sphere big in the middle, the line she is saying under it, what he said
// above it, and one box to type in. The left column is his PLAN (tesla-plan.js,
// 2026-10-25): goals and steps, the ones she orchestrates. The right side is the
// command center (tesla-center.js): her connections to the plan's sessions on
// top, the cards waiting for him and her updates below. A grid on a PC, one
// column on a phone.
//
// It owns no conversation: it reads window.Assistant.state() ten times a second
// and asks through Assistant.ask(), so the orb and this view are one Tesla.
// Esc, [x] or the browser's own exit leaves it; the orb is still in the corner.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    let box = null, sphere = null, timer = 0, lastLine = '';
    const MODE = { think: 'think', speak: 'speak', listen: 'listen' };
    const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function build() {
        box = document.createElement('div');
        box.className = 'tf';
        box.id = 'tesla-full';
        box.innerHTML = `
            <div class="tf-top">
                <span class="tf-name" id="tf-name">TESLA</span>
                <span class="tf-sub" id="tf-sub"></span>
                <span class="tf-gap"></span>
                <button class="tf-btn" data-tf="power" id="tf-power"></button>
                <button class="tf-btn" data-tf="close" title="Back to TSRCT (Esc)">[x]</button>
            </div>
            <div class="tf-grid">
                <div class="tf-zone tf-zone-plan" id="tf-zone-plan"></div>
                <div class="tf-zone tf-zone-ne" id="tf-zone-ne"></div>
                <div class="tf-stage">
                    <div class="tf-heard" id="tf-heard"></div>
                    <div class="tf-sphere" id="tf-sphere"></div>
                    <div class="tf-say" id="tf-say" aria-live="polite"></div>
                </div>
                <div class="tf-zone tf-zone-se" id="tf-zone-se"></div>
            </div>
            <form class="tf-row" id="tf-form">
                <input class="tf-in" id="tf-in" type="text" autocomplete="off" placeholder="talk to her, or type it here">
                <button class="tf-btn" type="submit">[&gt;]</button>
            </form>`;
        document.body.appendChild(box);
        box.addEventListener('click', onClick);
        box.querySelector('#tf-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const input = box.querySelector('#tf-in');
            const text = input.value.trim();
            if (!text || !window.Assistant) return;
            input.value = '';
            window.Assistant.ask(text, 'typed');
        });
        // keys typed here never reach the terminal's keymap
        box.addEventListener('keydown', (e) => { e.stopPropagation(); });
    }

    function onClick(e) {
        const el = e.target.closest('[data-tf]');
        if (!el || !window.Assistant) return;
        const a = el.dataset.tf;
        if (a === 'close') { close(); return; }
        if (a === 'power') {
            const st = window.Assistant.state();
            if (st.on && st.speaking) window.Assistant.hush();
            else if (st.on) window.Assistant.stop('full screen off');
            else window.Assistant.start();
            paint();
        }
    }

    function paint() {
        if (!box || !window.Assistant) return;
        const st = window.Assistant.state();
        const mode = MODE[st.mode] || 'idle';
        box.dataset.mode = mode;
        if (sphere) sphere.state(mode);
        box.querySelector('#tf-name').textContent = String(st.name || 'Tesla').toUpperCase();
        const label = { think: 'thinking', speak: 'speaking', listen: 'listening' }[mode] || (st.on ? 'ready' : 'off');
        box.querySelector('#tf-sub').textContent = label + (st.session && st.watch ? ` · following ${st.session}` : '');
        box.querySelector('#tf-power').textContent = st.on ? (st.speaking ? '[shh]' : '[off]') : '[on]';
        // what she is saying now, as it is typed; else the last thing she said
        const lines = st.lines || [];
        const mine = [...lines].reverse().find(l => l.who === 'it' || l.who === 'watch');
        const said = st.caption ? (st.caption.shown !== undefined ? st.caption.shown : st.caption.text) : (mine ? mine.text : '');
        const say = box.querySelector('#tf-say');
        if (said !== lastLine) { say.textContent = said; lastLine = said; }
        say.classList.toggle('typing', !!(st.caption && st.caption.typing));
        const his = [...lines].reverse().find(l => l.who === 'you');
        box.querySelector('#tf-heard').textContent = his ? his.text : (st.on ? '' : 'tap [on], or type below');
    }

    function open() {
        if (!box) build();
        box.classList.remove('hidden');
        document.body.classList.add('tf-open');
        if (!sphere && window.TeslaSphere) sphere = window.TeslaSphere.mount(box.querySelector('#tf-sphere'));
        if (sphere) sphere.run(true);
        const plan = box.querySelector('#tf-zone-plan');
        if (window.TeslaPlan && !plan.dataset.on) { plan.dataset.on = '1'; window.TeslaPlan.mount(plan); }
        else if (window.TeslaPlan) window.TeslaPlan.refresh();
        if (window.TeslaCenter && !box.dataset.center) { box.dataset.center = '1'; window.TeslaCenter.mount(box.querySelector('#tf-zone-ne'), box.querySelector('#tf-zone-se')); }
        if (window.TeslaCenter) window.TeslaCenter.start();
        paint();
        clearInterval(timer);
        timer = setInterval(paint, 100);
        try { if (box.requestFullscreen && window.innerWidth > 700) box.requestFullscreen().catch(() => {}); } catch (e) { /* optional */ }
        // the browser's own exit (Esc in real full screen) closes this view too
        document.addEventListener('fullscreenchange', onFsChange);
        // Esc first, before PC mode's own shortcuts (they listen in the capture phase too)
        window.addEventListener('keydown', onKey, true);
        setTimeout(() => { const i = box.querySelector('#tf-in'); if (i && window.innerWidth > 700) i.focus(); }, 50);
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
    function onFsChange() { if (!document.fullscreenElement && box && !box.classList.contains('hidden')) close(); }

    function close() {
        if (!box) return;
        document.removeEventListener('fullscreenchange', onFsChange);
        window.removeEventListener('keydown', onKey, true);
        try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) { /* optional */ }
        clearInterval(timer); timer = 0;
        if (sphere) sphere.run(false);
        if (window.TeslaPlan) window.TeslaPlan.stop();
        if (window.TeslaCenter) window.TeslaCenter.stop();
        box.classList.add('hidden');
        document.body.classList.remove('tf-open');
    }

    window.TeslaFull = { open, close, isOpen: () => !!(box && !box.classList.contains('hidden')) };
})();
