// ─────────────────────────────────────────────────────────────────────────
// projector.js — the PROJECTOR window (2026-10-12).
//
// A floating window, built and moved exactly like a RUNNER window (it reuses
// runnerSetupDrag / runnerSetupResize / runnerFocusWindow from desktop.js), that
// shows live the separate browser a Claude session is driving
// (scripts/projector.js). Leon picks the session from the dropdown; if it has a
// browser, the picture streams in; if not, the window says so in plain words.
// Clicking or typing INTO the picture drives that browser, never his PC: that is
// how he types his own password while a course session runs.
//
// The dropdown re-reads the sessions every 5 s while the window is open, so a
// browser that starts or stops shows up without a refresh. Frames flow only
// while the window is open AND that session is picked: closing the window or
// picking another session closes the stream, and the server stops the
// screencast when nobody watches.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const VIEW_ID = 'projector-view';
    const PICK_KEY = 'tsrct_projector_session';
    const REFRESH_MS = 5000;

    const st = {
        es: null, session: '', sources: [], timer: null,
        frameW: 1280, frameH: 800, live: false, stopped: {}, held: false,
        lastMove: 0, wheel: null, touch: null,
    };

    const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s)
        .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const el = (id) => document.getElementById(id);
    const authToken = () => { try { return (typeof token !== 'undefined' ? token : '') || ''; } catch (e) { return ''; } };

    // Where on the PAGE a point of the picture is. The picture is shown with
    // object-fit: contain, so a box wider (or taller) than the page has bars;
    // a click on a bar lands nowhere (null).
    function projectorToPage(clientX, clientY, rect, frameW, frameH) {
        if (!rect || !frameW || !frameH || !rect.width || !rect.height) return null;
        const scale = Math.min(rect.width / frameW, rect.height / frameH);
        const w = frameW * scale, h = frameH * scale;
        const left = rect.left + (rect.width - w) / 2, top = rect.top + (rect.height - h) / 2;
        const x = (clientX - left) / scale, y = (clientY - top) / scale;
        if (x < 0 || y < 0 || x > frameW || y > frameH) return null;
        return { x, y };
    }

    function setMsg(text, kind) {
        const m = el('projector-msg'), img = el('projector-img');
        if (!m) return;
        m.textContent = text || '';
        m.className = 'projector-msg' + (kind ? ' ' + kind : '');
        m.style.display = text ? '' : 'none';
        if (img) img.style.display = text ? 'none' : '';
    }

    function setStatus(text) { const s = el('projector-status'); if (s) s.textContent = text || ''; }

    function stopStream() {
        if (st.es) { try { st.es.close(); } catch (e) {} }
        st.es = null;
        st.live = false;
    }

    function sourceOf(name) {
        const row = st.sources.find(s => s.name === name);
        return row ? row.source : null;
    }

    function startStream() {
        stopStream();
        const name = st.session;
        if (!name) { setMsg('Pick a session above. If it has its own browser open, it shows here live.'); return; }
        const src = sourceOf(name);
        if (!src) {
            setMsg(`Nothing to project for ${name}. It has no separate browser open.`);
            setStatus('');
            return;
        }
        if (st.stopped[name] === src.startedAt) return;   // refused for this browser; wait for a new one
        setMsg('Connecting...');
        const es = new EventSource('/api/projector/stream?session=' + encodeURIComponent(name) + '&token=' + encodeURIComponent(authToken()));
        st.es = es;
        es.onmessage = (m) => {
            if (st.es !== es) return;
            let ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
            if (ev.kind === 'frame') {
                const img = el('projector-img');
                if (!img) return;
                if (ev.w && ev.h) { st.frameW = ev.w; st.frameH = ev.h; }
                img.src = 'data:image/jpeg;base64,' + ev.data;
                if (!st.live) { st.live = true; setMsg(''); }
                return;
            }
            // Every other event ends this stream on the server. Close it here
            // too, or EventSource reconnects by itself in a loop.
            stopStream();
            if (ev.kind === 'switch') { startStream(); return; }
            if (ev.kind === 'refused') st.stopped[name] = src.startedAt;
            setMsg(ev.why || 'The stream ended.', ev.kind === 'refused' ? 'warn' : '');
        };
        es.onerror = () => {
            if (st.es !== es) return;
            stopStream();
            setMsg('Lost the connection. Trying again in a few seconds...');
        };
        showSource(src);
    }

    function showSource(src) {
        if (!src) { setStatus(''); return; }
        setStatus((src.title ? src.title + '  ' : '') + (src.url || ''));
    }

    async function projectorRefresh() {
        // runnerCloseView() with no id removes every floating window, this one
        // included: then stop here too, or the stream would run on unseen.
        if (!el(VIEW_ID)) { projectorClose(); return; }
        let data = null;
        try {
            const r = await fetch('/api/projector/sources');
            data = await r.json();
        } catch (e) { return; }
        if (!data || !data.success) return;
        st.sources = data.sessions || [];
        const sel = el('projector-session');
        if (!sel) return;
        const opts = ['<option value="">-- pick a session --</option>'].concat(st.sources.map(s =>
            `<option value="${esc(s.name)}"${s.name === st.session ? ' selected' : ''}>${esc(s.name)}${s.source ? '  [browser]' : ''}</option>`));
        const html = opts.join('');
        if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
        // Reality changed under the picked session: a browser appeared or went.
        const src = sourceOf(st.session);
        if (src && !st.es) startStream();
        else if (!src && st.session) { stopStream(); setMsg(`Nothing to project for ${st.session}. It has no separate browser open.`); setStatus(''); }
        else if (src) showSource(src);
    }

    function projectorPick(name) {
        st.session = String(name || '');
        try { sessionStorage.setItem(PICK_KEY, st.session); } catch (e) {}
        startStream();
    }

    function post(body) {
        if (!st.live || !st.session) return;
        fetch('/api/projector/input', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ session: st.session }, body)),
        }).catch(() => {});
    }

    function pagePoint(e) {
        const img = el('projector-img');
        return img ? projectorToPage(e.clientX, e.clientY, img.getBoundingClientRect(), st.frameW, st.frameH) : null;
    }

    function wireInput(img) {
        img.addEventListener('contextmenu', e => e.preventDefault());
        img.addEventListener('dragstart', e => e.preventDefault());
        img.addEventListener('mousedown', (e) => {
            img.focus();
            const p = pagePoint(e);
            if (!p) return;
            e.preventDefault();
            st.held = true;
            post({ kind: 'mouse', type: 'down', x: p.x, y: p.y, button: e.button, clickCount: e.detail || 1 });
            const move = (ev) => {
                const now = Date.now();
                if (now - st.lastMove < 40) return;
                st.lastMove = now;
                const q = pagePoint(ev);
                if (q) post({ kind: 'mouse', type: 'move', x: q.x, y: q.y, held: true, button: e.button });
            };
            const up = (ev) => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                st.held = false;
                const q = pagePoint(ev) || p;
                post({ kind: 'mouse', type: 'up', x: q.x, y: q.y, button: e.button, clickCount: ev.detail || 1 });
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
        // Hover (menus that open on hover), throttled harder than a drag.
        img.addEventListener('mousemove', (e) => {
            if (st.held) return;
            const now = Date.now();
            if (now - st.lastMove < 150) return;
            st.lastMove = now;
            const p = pagePoint(e);
            if (p) post({ kind: 'mouse', type: 'move', x: p.x, y: p.y });
        });
        img.addEventListener('wheel', (e) => {
            e.preventDefault();
            const p = pagePoint(e);
            if (!p) return;
            if (!st.wheel) {
                st.wheel = { dx: 0, dy: 0, x: p.x, y: p.y };
                setTimeout(() => { const w = st.wheel; st.wheel = null; if (w) post({ kind: 'wheel', x: w.x, y: w.y, dx: w.dx, dy: w.dy }); }, 60);
            }
            st.wheel.dx += e.deltaX; st.wheel.dy += e.deltaY;
        }, { passive: false });
        // A PHONE (2026-10-14, "agregar al modo mobile el projector en las tools"):
        // a tap is a click, a swipe scrolls the page. Handled here, not by the
        // browser's synthetic mouse events, which arrive late and turn a swipe
        // into a drag.
        img.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const t = e.touches[0];
            st.touch = { x: t.clientX, y: t.clientY, lastY: t.clientY, lastX: t.clientX, moved: false };
        }, { passive: true });
        img.addEventListener('touchmove', (e) => {
            const T = st.touch;
            if (!T || e.touches.length !== 1) return;
            const t = e.touches[0];
            if (!T.moved && Math.hypot(t.clientX - T.x, t.clientY - T.y) < 10) return;
            T.moved = true;
            e.preventDefault();
            // A finger moves the page the other way round from a wheel, and the
            // picture is smaller than the page: scale to page pixels.
            const r = img.getBoundingClientRect();
            const k = r.width ? st.frameW / Math.min(r.width, r.height * st.frameW / st.frameH) : 1;
            const p = projectorToPage(T.x, T.y, r, st.frameW, st.frameH) || { x: st.frameW / 2, y: st.frameH / 2 };
            if (!st.wheel) {
                st.wheel = { dx: 0, dy: 0, x: p.x, y: p.y };
                setTimeout(() => { const w = st.wheel; st.wheel = null; if (w) post({ kind: 'wheel', x: w.x, y: w.y, dx: w.dx, dy: w.dy }); }, 60);
            }
            st.wheel.dx += (T.lastX - t.clientX) * k;
            st.wheel.dy += (T.lastY - t.clientY) * k;
            T.lastX = t.clientX; T.lastY = t.clientY;
        }, { passive: false });
        img.addEventListener('touchend', (e) => {
            const T = st.touch;
            st.touch = null;
            if (!T || T.moved) return;
            e.preventDefault();              // no synthetic mouse click on top of this one
            const p = projectorToPage(T.x, T.y, img.getBoundingClientRect(), st.frameW, st.frameH);
            if (!p) return;
            post({ kind: 'mouse', type: 'down', x: p.x, y: p.y, button: 0, clickCount: 1 });
            post({ kind: 'mouse', type: 'up', x: p.x, y: p.y, button: 0, clickCount: 1 });
        }, { passive: false });
        img.addEventListener('keydown', (e) => {
            // Ctrl+V: let the browser fire `paste`, which carries the text.
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
            if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
            e.preventDefault();
            e.stopPropagation();   // TSRCT's own shortcuts (Ctrl+K, Ctrl+B ...) stay out of it
            post({ kind: 'key', key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
        });
    }

    function onPaste(e) {
        const img = el('projector-img');
        if (!img || document.activeElement !== img) return;
        const text = (e.clipboardData || window.clipboardData || { getData: () => '' }).getData('text');
        if (!text) return;
        e.preventDefault();
        post({ kind: 'text', text });
    }

    // The phone's keyboard does not open on a picture, so a phone gets a text box:
    // what is typed there goes into the projected page (field clicked first), and
    // is never logged - it can be a password.
    function projectorSendText(enter) {
        const box = el('projector-text');
        const text = box ? box.value : '';
        if (text) post({ kind: 'text', text });
        if (box) box.value = '';
        if (enter) post({ kind: 'key', key: 'Enter', code: 'Enter' });
    }
    function projectorKey(key) {
        if (!/^(Enter|Backspace|Tab|Escape)$/.test(key)) return;
        post({ kind: 'key', key, code: key });
    }
    const isPhone = () => !document.body.classList.contains('pc-mode');

    // `pick` (optional): the session to show, e.g. Tesla's "mostrame el proyector de hands".
    function projectorOpen(pick) {
        const want = typeof pick === 'string' && /^[A-Za-z0-9._-]{1,60}$/.test(pick) ? pick : '';
        if (want) { try { sessionStorage.setItem(PICK_KEY, want); } catch (e) {} }
        const existing = el(VIEW_ID);
        if (existing) {
            if (typeof runnerFocusWindow === 'function') runnerFocusWindow(VIEW_ID);
            if (want && want !== st.session) {
                projectorPick(want);
                const sel = el('projector-session');
                if (sel) sel.value = want;
            }
            return;
        }
        const box = document.createElement('div');
        const phone = isPhone();
        box.className = 'pc-runner-floating projector-floating' + (phone ? ' projector-phone' : '');
        box.id = VIEW_ID;
        box.innerHTML = `
            <div class="pc-runner-view-content projector-content"${phone ? '' : ' style="top: 70px; left: 260px; width: 860px; height: 600px;"'}>
                <div class="pc-runner-modal-header projector-header">
                    <span>Projector</span>
                    <select id="projector-session" class="projector-session" onchange="projectorPick(this.value)" title="The session whose own browser you want to watch">
                        <option value="">-- pick a session --</option>
                    </select>
                    <div class="pc-runner-view-actions">
                        <button onclick="projectorRefresh()" title="Re-read the sessions">[r]</button>
                        <button onclick="projectorClose()" title="Close (stops the stream)">[x]</button>
                    </div>
                </div>
                <div class="projector-stage">
                    <img id="projector-img" class="projector-img" tabindex="0" alt="" style="display:none">
                    <div id="projector-msg" class="projector-msg">Loading sessions...</div>
                </div>
                ${phone ? `<div class="projector-typebar">
                    <input id="projector-text" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="type here" onkeydown="if(event.key==='Enter'){event.preventDefault();projectorSendText(true)}">
                    <button onclick="projectorSendText(false)" title="Type it into the page">[send]</button>
                    <button onclick="projectorKey('Backspace')" title="Delete one character">[del]</button>
                    <button onclick="projectorKey('Enter')" title="Press Enter">[enter]</button>
                </div>` : ''}
                <div class="projector-foot">
                    <span id="projector-status" class="projector-status"></span>
                    <span class="projector-hint">${phone ? 'tap = click, swipe = scroll' : 'click the picture to type into it'}</span>
                </div>
                ${phone ? '' : '<div class="pc-runner-resize-handle"></div>'}
            </div>`;
        document.body.appendChild(box);
        const content = box.querySelector('.pc-runner-view-content');
        if (!phone && typeof runnerSetupDrag === 'function') runnerSetupDrag(box.querySelector('.pc-runner-modal-header'), content, VIEW_ID);
        if (!phone && typeof runnerSetupResize === 'function') runnerSetupResize(box.querySelector('.pc-runner-resize-handle'), content);
        if (typeof runnerFocusWindow === 'function') {
            runnerFocusWindow(VIEW_ID);
            content.addEventListener('mousedown', () => runnerFocusWindow(VIEW_ID));
        }
        wireInput(el('projector-img'));
        document.addEventListener('paste', onPaste);
        try { st.session = sessionStorage.getItem(PICK_KEY) || ''; } catch (e) { st.session = ''; }
        projectorRefresh().then(() => {
            // No remembered pick: take the first session that has something to show.
            // A session she asked for is kept even before its browser exists
            // (hands may still be starting); the 5 s refresh brings it in.
            if (!want && (!st.session || !st.sources.some(s => s.name === st.session))) {
                const first = st.sources.find(s => s.source);
                st.session = first ? first.name : '';
                const sel = el('projector-session');
                if (sel) sel.value = st.session;
            }
            startStream();
        });
        st.timer = setInterval(projectorRefresh, REFRESH_MS);
    }

    function projectorClose() {
        stopStream();
        clearInterval(st.timer);
        st.timer = null;
        document.removeEventListener('paste', onPaste);
        const box = el(VIEW_ID);
        if (box) box.remove();
    }

    window.projectorOpen = projectorOpen;
    window.projectorClose = projectorClose;
    window.projectorPick = projectorPick;
    window.projectorRefresh = projectorRefresh;
    window.projectorToPage = projectorToPage;
    window.projectorSendText = projectorSendText;
    window.projectorKey = projectorKey;
})();
