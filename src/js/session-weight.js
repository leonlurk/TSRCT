/**
 * session-weight.js — warns when sessions have grown expensive, and hands them
 * off to fresh ones: as many at once as you tick.
 *
 * Why: measured on August 2026 transcripts, turns above 300k of context were 27%
 * of the turns and 51% of the token bill. The waste is not what a session reads
 * (the vault and MAP.md already fixed that) — it is what it carries: every turn
 * re-sends the whole conversation. Capping context near 200k cuts about a third
 * of the bill for the same work.
 *
 * The weight itself is measured by a Stop hook reading the transcript file, so
 * nothing here costs tokens. The handoff sends /compact to the old pane, reads
 * the summary Claude Code writes to disk, primes a new session in the same
 * directory with it, and only then retires the old one.
 *
 * 2026-09-17: the bar used to follow the SELECTED session only, polled every 45s
 * (so a switch or a snooze took up to 45s to show, which read as "I have to
 * reload the PWA"), tracked one handoff at a time, and a 30m snooze had no undo
 * or way back in. Now: one floating bar for ALL heavy sessions, a modal that
 * lists them with checkboxes, parallel handoffs (the server always supported
 * them — lib/sessionWeight.js keys every handoff by session), a wake button per
 * snoozed row, and a pill + clickable badges that reopen the modal at any time.
 *
 * Listeners are attached with addEventListener / delegation, never inline
 * onclick, so the generated markup cannot go stale against the export block.
 */
(function () {
    'use strict';

    const POLL_IDLE_MS = 15000;     // nothing running: cheap, one tmux list-sessions
    const POLL_BUSY_MS = 4000;      // a handoff running or the modal open
    const STYLE_ID = 'sw-weight-style';
    const BAR_ID = 'sw-weight-bar';
    const PILL_ID = 'sw-weight-pill';
    const MODAL_ID = 'sw-weight-modal';

    let pollTimer = null;
    let lastData = { thresholds: { warn: 200000, urgent: 300000 }, sessions: [] };
    let lastPollAt = 0;
    let dismissed = null;        // the sessions the user hid the bar over, this page-load
    let modalOpen = false;
    let showLight = false;
    let confirming = false;
    let confirmTimer = null;
    const selected = new Set();
    // Sessions whose handoff we are following to its end (started here, or seen
    // running in a poll — another window may have started it). Each one gets its
    // ending announced exactly once.
    const watching = new Set();
    // Old names whose successor was already put in their place (once per handoff).
    const succeeded = new Set();
    // Per-row error from the START request (e.g. SecretCo refusal, no such session).
    const startErrors = new Map();

    // app.js declares `token` with `let`, so it is NOT on window — reading
    // window.token yields undefined, and sending `Authorization: undefined`
    // actually DEFEATS app.js's auto-attach wrapper (it only fills the header in
    // when one is absent), so every call 401s silently. Same defensive read as
    // lurk.js:88.
    function authHeaders(extra) {
        const t = (typeof token !== 'undefined' && token) ? token : (window.token || '');
        return Object.assign({ Authorization: t }, extra || {});
    }

    function activeSession() {
        try {
            if (typeof window.getCurrentTargetSession === 'function') {
                const s = window.getCurrentTargetSession();
                if (s) return s;
            }
        } catch (e) { /* fall through */ }
        return window.homeSession || '';
    }

    function esc(s) {
        return typeof window.escapeHtml === 'function'
            ? window.escapeHtml(String(s))
            : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function toast(msg, kind) {
        if (typeof window.toast === 'function') window.toast(msg, kind, false);
    }

    function fmtK(n) {
        if (!n) return '0';
        if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
        return Math.round(n / 1000) + 'k';
    }

    function fmtAgo(ms) {
        const m = Math.round(ms / 60000);
        if (m < 1) return 'now';
        if (m < 60) return m + 'm';
        return Math.round(m / 60) + 'h';
    }

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const st = document.createElement('style');
        st.id = STYLE_ID;
        // Palette from variables.css only. --radius is 0 by design (sharp corners
        // = the TSRCT aesthetic); there is no --accent token in this codebase, so
        // buttons are transparent + 1px border like .quick-btn / .modal-btn.
        st.textContent = `
#${BAR_ID}{position:fixed;left:0;right:0;bottom:0;z-index:9400;display:none;
  padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px));
  background:var(--bg-darker);border:1px solid var(--amber);border-radius:var(--radius);
  font-family:var(--mono);font-size:0.62rem;color:var(--text)}
#${BAR_ID}.visible{display:block}
#${BAR_ID}.urgent{border-color:var(--red)}
#${BAR_ID} .sw-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;flex-wrap:wrap}
#${BAR_ID} .sw-tag{font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--amber)}
#${BAR_ID}.urgent .sw-tag{color:var(--red)}
#${BAR_ID} .sw-sub{color:var(--text-dim);letter-spacing:.3px}
.sw-actions{display:flex;gap:4px;flex-wrap:wrap}
.sw-btn{flex:1 1 auto;min-height:26px;padding:5px 8px;border-radius:var(--radius);
  border:1px solid var(--border);background:transparent;color:var(--text-dim);
  font-family:var(--mono);font-size:0.55rem;font-weight:500;letter-spacing:.5px;
  text-transform:uppercase;cursor:pointer;transition:all .15s}
.sw-btn:hover{border-color:var(--border-light);color:var(--text)}
.sw-btn.sw-primary{flex:2 1 auto;border-color:var(--amber);color:var(--amber)}
.sw-btn.sw-primary:hover{background:var(--amber-bg)}
.sw-btn.sw-danger{border-color:var(--red);color:var(--red)}
.sw-btn.sw-danger:hover{background:var(--red-bg)}
.sw-btn:disabled{opacity:.4;cursor:default}
#${PILL_ID}{position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:9400;
  display:none;padding:3px 7px;border-radius:var(--radius);border:1px solid var(--border);
  background:var(--bg-darker);color:var(--text-dim);font-family:var(--mono);font-size:0.55rem;
  letter-spacing:.5px;cursor:pointer;opacity:.75}
#${PILL_ID}:hover{opacity:1;color:var(--amber);border-color:var(--amber)}
#${PILL_ID}.visible{display:block}
#${PILL_ID}.sw-docked{position:absolute;bottom:8px;z-index:6;padding:3px 8px;border-radius:4px;
  font-size:var(--text-xs,0.7rem);letter-spacing:.05em;opacity:.45}
#${PILL_ID}.sw-heavy{color:var(--amber);border-color:var(--amber);opacity:.85}
#${PILL_ID}.sw-docked:hover{opacity:1}
#${MODAL_ID}{position:fixed;inset:0;z-index:9450;display:none;align-items:center;justify-content:center;
  background:rgba(0,0,0,.6)}
#${MODAL_ID}.visible{display:flex}
#${MODAL_ID} .sw-panel{width:calc(100% - 20px);max-width:620px;max-height:84vh;display:flex;flex-direction:column;
  background:var(--bg-darker);border:1px solid var(--amber);border-radius:var(--radius);
  font-family:var(--mono);font-size:0.62rem;color:var(--text)}
#${MODAL_ID} .sw-mhead{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border)}
#${MODAL_ID} .sw-mtitle{flex:1;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--amber)}
#${MODAL_ID} .sw-mhead .sw-btn{flex:0 0 auto}
#${MODAL_ID} .sw-msub{padding:5px 10px;color:var(--text-muted);letter-spacing:.3px;border-bottom:1px solid var(--border);
  display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#${MODAL_ID} .sw-msub label{margin-left:auto;cursor:pointer;display:flex;gap:4px;align-items:center}
#${MODAL_ID} .sw-list{overflow-y:auto;flex:1;min-height:60px}
#${MODAL_ID} .sw-row{display:flex;gap:8px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--border)}
#${MODAL_ID} .sw-row input{flex:0 0 auto;margin:0;cursor:pointer}
#${MODAL_ID} .sw-row input:disabled{cursor:default}
#${MODAL_ID} .sw-rmain{flex:1;min-width:0}
#${MODAL_ID} .sw-rname{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${MODAL_ID} .sw-rname.urgent{color:var(--red)}
#${MODAL_ID} .sw-rname.warn{color:var(--amber)}
#${MODAL_ID} .sw-rstate{color:var(--text-muted);letter-spacing:.3px;margin-top:2px;word-break:break-word}
#${MODAL_ID} .sw-rstate.run{color:var(--cyan)}
#${MODAL_ID} .sw-rstate.bad{color:var(--red)}
#${MODAL_ID} .sw-row .sw-btn{flex:0 0 auto}
#${MODAL_ID} .sw-empty{padding:18px 10px;text-align:center;color:var(--text-muted)}
#${MODAL_ID} .sw-mfoot{padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--border)}
#${MODAL_ID} .sw-confirm-text{margin-bottom:6px;padding:5px 6px;border-left:2px solid var(--red);
  background:var(--red-bg);color:var(--text-dim);letter-spacing:.3px;line-height:1.4}
.sw-badge{display:inline-block;margin-left:5px;padding:0 3px;border-radius:var(--radius);
  border:1px solid currentColor;font-family:var(--mono);font-size:0.5rem;
  font-weight:500;letter-spacing:.5px;vertical-align:middle;cursor:pointer}
.sw-badge.warn{color:var(--amber);background:var(--amber-bg)}
.sw-badge.urgent{color:var(--red);background:var(--red-bg)}
@media (min-width:900px){#${BAR_ID}{left:auto;right:12px;bottom:12px;max-width:420px}
  #${PILL_ID}{right:12px;bottom:12px}}
`;
        document.head.appendChild(st);
    }

    // ── Read model helpers ──────────────────────────────────────────────────
    function rows() { return lastData.sessions || []; }
    function rowFor(session) { return rows().find(s => s.session === session) || null; }
    function isRunning(row) { return !!(row && row.handoff && !row.handoff.done); }
    function isHeavy(row) { return row && row.level !== 'ok'; }

    function phaseText(h) {
        const to = h.newSession || 'new';
        const map = {
            queued: 'queued',
            checking: 'checking the session...',
            waiting_idle: 'waiting for idle...',
            compacting: 'compacting... (~2m)',
            reading_summary: 'reading summary...',
            starting_new: `booting ${to}...`,
            priming: `priming ${to}...`,
            killing_old: 'killing old...',
            done: `done -> ${to}`,
            failed: `failed: ${h.error || 'unknown'} · old session alive`,
            lost: 'lost track (server restarted?) · old session alive',
        };
        return map[h.phase] || h.phase;
    }

    // ── Polling ─────────────────────────────────────────────────────────────
    function schedule(ms) {
        if (pollTimer) clearTimeout(pollTimer);
        const busy = modalOpen || watching.size > 0;
        pollTimer = setTimeout(tick, ms != null ? ms : (busy ? POLL_BUSY_MS : POLL_IDLE_MS));
    }

    function tick() {
        if (document.hidden) { schedule(); return; }
        poll();
    }

    async function poll() {
        try {
            const r = await fetch('/api/session/weights', { headers: authHeaders() });
            if (r.ok) {
                lastData = await r.json();
                lastPollAt = Date.now();
                track();
                render();
            }
        } catch (e) { /* offline: stay quiet */ }
        schedule();
    }

    // Follow every running handoff to its end and announce each ending once.
    // A terminal state is exactly the one that MUST reach the screen (BUG
    // 2026-08-25: the old bar froze on the last phase it happened to see).
    function track() {
        for (const row of rows()) {
            if (isRunning(row)) watching.add(row.session);
            // The new session takes the old one's place in the layout (panel, size,
            // folder, colour) BEFORE the toast and the follow below. Every finished
            // handoff, not only the watched ones: Tesla's refresh_sessions starts
            // them from the server, where this page may never have seen one running.
            const h = row.handoff;
            if (h && h.phase === 'done' && h.newSession && !succeeded.has(row.session)) {
                succeeded.add(row.session);
                if (typeof window.pcSessionSucceeded === 'function') window.pcSessionSucceeded(row.session, h.newSession);
            }
        }
        for (const session of Array.from(watching)) {
            const row = rowFor(session);
            // No row and no handoff state at all: the server restarted (the
            // weight map is in-memory). Nothing is running any more; say so.
            const h = row && row.handoff ? row.handoff : { phase: 'lost', done: true };
            if (!h.done) continue;
            watching.delete(session);
            if (h.phase === 'done' && h.newSession) {
                toast(`${session} -> ${h.newSession}`, 'success');
                // Only follow the handoff if you were LOOKING at the old session;
                // five parallel handoffs must not yank the terminal five times.
                if (activeSession() === session && typeof window.switchSession === 'function') {
                    window.switchSession(h.newSession);
                }
            } else {
                // The reason, not the word "failed": the abort messages in
                // lib/sessionWeight.js name what was actually seen.
                toast(`${session}: ${phaseText(h)}`, 'error');
            }
        }
    }

    // ── Floating bar + pill ─────────────────────────────────────────────────
    function ensureBar() {
        ensureStyle();
        let bar = document.getElementById(BAR_ID);
        if (bar) return bar;
        bar = document.createElement('div');
        bar.id = BAR_ID;
        bar.innerHTML = `
            <div class="sw-head">
                <span class="sw-tag" id="sw-weight-tag"></span>
                <span class="sw-sub" id="sw-weight-detail"></span>
            </div>
            <div class="sw-actions">
                <button class="sw-btn sw-primary" id="sw-weight-open">[&gt;] handoffs</button>
                <button class="sw-btn" id="sw-weight-hide">[x] hide</button>
            </div>`;
        document.body.appendChild(bar);
        bar.querySelector('#sw-weight-open').addEventListener('click', () => open());
        bar.querySelector('#sw-weight-hide').addEventListener('click', () => dismiss());
        return bar;
    }

    function ensurePill() {
        ensureStyle();
        let pill = document.getElementById(PILL_ID);
        if (pill) return pill;
        pill = document.createElement('div');
        pill.id = PILL_ID;
        pill.title = 'Heavy sessions - open handoffs';
        pill.addEventListener('click', () => open());
        document.body.appendChild(pill);
        return pill;
    }

    // Sit beside the visible terminal's FREEZE toggle (terminal-focus.js puts it
    // in the pane's parent), in the same style. Floating at the screen corner it
    // landed stuck under the input row. Falls back to the corner if no terminal
    // toggle is on screen (a room is open, or the DOM is mid-rebuild). In the corner
    // it sits on the phone's ATT key, so it looks again every second instead of
    // waiting for the next poll (up to 15 s).
    let redockTimer = null;
    function dockPill(p) {
        const toggle = Array.from(document.querySelectorAll('.tf-toggle'))
            .find(t => t.offsetParent !== null);
        if (!toggle) {
            p.classList.remove('sw-docked');
            p.style.right = '';
            if (p.parentElement !== document.body) document.body.appendChild(p);
            if (!redockTimer) redockTimer = setTimeout(() => {
                redockTimer = null;
                if (p.classList.contains('visible')) dockPill(p);
            }, 1000);
            return;
        }
        if (p.parentElement !== toggle.parentElement) toggle.parentElement.appendChild(p);
        p.classList.add('sw-docked');
        const gap = 6;
        const right = parseFloat(getComputedStyle(toggle).right) || 10;
        p.style.right = (right + toggle.offsetWidth + gap) + 'px';
    }

    function namesOf(...lists) { return new Set([].concat(...lists).map(r => r.session)); }

    function render() {
        // A FAILED handoff leaves the session alive and still heavy, so it keeps
        // nagging; only a finished one is out of the count.
        const heavy = rows().filter(r => isHeavy(r) && !isRunning(r) && !(r.handoff && r.handoff.phase === 'done'));
        const nagging = heavy.filter(r => !r.silenced);
        const running = rows().filter(isRunning);
        // A hide lasts until a NEW session shows up (one crosses the line or
        // starts handing off), not forever - and not merely until one of the
        // hidden ones finishes. It covers running handoffs too: a compaction
        // takes minutes, and a bar that "hide" could not hide sat over the
        // input row for all of them.
        const shownNow = namesOf(nagging, running);
        if (dismissed && [...shownNow].some(n => !dismissed.has(n))) dismissed = null;

        // Mobile: never pop the bar on its own (2026-10-07, Leon: it covered the
        // quick keys every time a session crossed the line). The docked pill
        // already turns amber and says "[~] N heavy"; tapping it opens the modal.
        const pc = document.body.classList.contains('pc-mode');
        const showBar = pc && !modalOpen && shownNow.size > 0 && !dismissed;
        const bar = document.getElementById(BAR_ID);
        if (showBar) {
            const b = ensureBar();
            b.classList.toggle('urgent', nagging.some(r => r.level === 'urgent'));
            const parts = [];
            if (nagging.length) parts.push(`[!] ${nagging.length} heavy`);
            if (running.length) parts.push(`[>] ${running.length} handing off`);
            b.querySelector('#sw-weight-tag').textContent = parts.join(' · ');
            const shown = (running.length ? running : nagging).slice(0, 3);
            b.querySelector('#sw-weight-detail').textContent = shown
                .map(r => isRunning(r) ? `${r.session} ${r.handoff.phase}` : `${r.session} ${fmtK(r.ctx)}`)
                .join(' · ') + (running.length + nagging.length > 3 ? ' ...' : '');
            b.classList.add('visible');
        } else if (bar) {
            bar.classList.remove('visible');
        }

        // The manual way in (after a snooze, a hide, or just to check): ALWAYS
        // there whenever the bar is not. Hiding it while nothing was heavy made
        // the button impossible to find.
        // PC mode: the way in is the [H] button in the sidebar Sessions header
        // (desktop.js), so no floating pill there; it only tints when heavy.
        const hBtn = document.getElementById('pc-handoff-btn');
        if (hBtn) {
            hBtn.style.color = heavy.length ? 'var(--amber)' : '';
            hBtn.title = heavy.length
                ? `Handoffs: ${heavy.length} heavy session${heavy.length > 1 ? 's' : ''}`
                : 'Handoffs: list heavy sessions, hand off several at once';
        }
        const showPill = !modalOpen && !showBar && !pc;
        const pill = document.getElementById(PILL_ID);
        if (showPill) {
            const p = ensurePill();
            p.textContent = running.length ? `[>] ${running.length} handing off`
                : heavy.length ? `[~] ${heavy.length} heavy` : '[>] handoffs';
            p.classList.toggle('sw-heavy', heavy.length > 0);
            dockPill(p);
            p.classList.add('visible');
        } else if (pill) {
            pill.classList.remove('visible');
        }

        if (modalOpen) renderModal();
    }

    function dismiss() {
        const nagging = rows().filter(r => isHeavy(r) && !r.silenced && !isRunning(r));
        dismissed = namesOf(nagging, rows().filter(isRunning));
        render();
    }

    // ── Modal ───────────────────────────────────────────────────────────────
    function ensureModal() {
        ensureStyle();
        let m = document.getElementById(MODAL_ID);
        if (m) return m;
        m = document.createElement('div');
        m.id = MODAL_ID;
        m.innerHTML = `
            <div class="sw-panel">
                <div class="sw-mhead">
                    <span class="sw-mtitle">[&gt;] handoffs</span>
                    <button class="sw-btn" data-act="refresh">[~] refresh</button>
                    <button class="sw-btn" data-act="close">[x]</button>
                </div>
                <div class="sw-msub" id="sw-m-sub"></div>
                <div class="sw-list" id="sw-m-list"></div>
                <div class="sw-mfoot" id="sw-m-foot"></div>
            </div>`;
        document.body.appendChild(m);
        m.addEventListener('click', onModalClick);
        m.addEventListener('change', onModalChange);
        return m;
    }

    function modalRows() {
        return rows().filter(r => showLight || isHeavy(r) || r.handoff || watching.has(r.session));
    }

    function selectable(r) {
        return !isRunning(r) && !(r.handoff && r.handoff.phase === 'done');
    }

    function renderModal() {
        const m = ensureModal();
        const t = lastData.thresholds || {};
        const list = modalRows();
        // Drop selections that no longer exist or are no longer selectable.
        for (const s of Array.from(selected)) {
            const r = rowFor(s);
            if (!r || !selectable(r)) selected.delete(s);
        }

        m.querySelector('#sw-m-sub').innerHTML = `
            <span>warn ${fmtK(t.warn)} · urgent ${fmtK(t.urgent)}</span>
            <span>updated ${lastPollAt ? fmtAgo(Date.now() - lastPollAt) : '...'}</span>
            <label><input type="checkbox" data-act="light" ${showLight ? 'checked' : ''}> show light sessions</label>`;

        const now = Date.now();
        m.querySelector('#sw-m-list').innerHTML = list.length ? list.map(r => {
            const s = esc(r.session);
            let state, cls = '', action = '';
            const err = startErrors.get(r.session);
            if (isRunning(r)) {
                state = '[>] ' + phaseText(r.handoff); cls = 'run';
            } else if (r.handoff && r.handoff.done) {
                state = '[>] ' + phaseText(r.handoff); cls = r.handoff.phase === 'done' ? 'run' : 'bad';
            } else if (err) {
                state = '[!] ' + err; cls = 'bad';
            } else {
                const bits = [`measured ${fmtAgo(r.ageMs || 0)} ago`];
                if (r.silenced) bits.push(`snoozed ${fmtAgo(r.snoozedUntil - now)} left`);
                if (r.cwd) bits.push(r.cwd);
                state = bits.join(' · ');
            }
            if (selectable(r) && r.ctx) {
                action = r.silenced
                    ? `<button class="sw-btn" data-act="wake" data-session="${s}">[+] wake</button>`
                    : `<button class="sw-btn" data-act="snooze" data-session="${s}">[~] 30m</button>`;
            }
            return `
                <div class="sw-row">
                    <input type="checkbox" data-act="pick" data-session="${s}"
                        ${selected.has(r.session) ? 'checked' : ''} ${selectable(r) ? '' : 'disabled'}>
                    <div class="sw-rmain">
                        <div class="sw-rname ${r.level}">${s}${r.session === activeSession() ? ' (current)' : ''}
                            ${r.ctx ? `<span style="font-weight:400;color:var(--text-dim)"> · ${fmtK(r.ctx)}</span>` : ''}</div>
                        <div class="sw-rstate ${cls}">${esc(state)}</div>
                    </div>
                    ${action}
                </div>`;
        }).join('') : `<div class="sw-empty">no session over ${fmtK(t.warn)} · a session is measured when it finishes a turn</div>`;

        const foot = m.querySelector('#sw-m-foot');
        const n = selected.size;
        if (confirming && n) {
            foot.innerHTML = `
                <div class="sw-confirm-text">${n} session${n > 1 ? 's' : ''}: ${esc(Array.from(selected).join(', '))}
                    · each: /compact -> summary -> new session, same cwd -> kill old
                    · all run at the same time · fails closed · ~2m, do not type in them</div>
                <div class="sw-actions">
                    <button class="sw-btn sw-danger" data-act="go">[&gt;] confirm ${n}</button>
                    <button class="sw-btn" data-act="cancel">[x] cancel</button>
                </div>`;
        } else {
            confirming = false;
            const pickable = list.filter(selectable).length;
            foot.innerHTML = `
                <div class="sw-actions">
                    <button class="sw-btn" data-act="all" ${pickable ? '' : 'disabled'}>[+] all</button>
                    <button class="sw-btn" data-act="none" ${n ? '' : 'disabled'}>[-] none</button>
                    <button class="sw-btn sw-primary" data-act="ask" ${n ? '' : 'disabled'}>[&gt;] handoff ${n || ''}</button>
                </div>`;
        }
    }

    function onModalClick(e) {
        if (e.target.id === MODAL_ID) { close(); return; }     // backdrop
        const el = e.target.closest('[data-act]');
        if (!el || el.tagName === 'INPUT') return;
        const act = el.dataset.act;
        const session = el.dataset.session;
        if (act === 'close') close();
        else if (act === 'refresh') { startErrors.clear(); poll(); }
        else if (act === 'snooze') doSnooze(30, session);
        else if (act === 'wake') doSnooze(0, session);
        else if (act === 'all') { modalRows().filter(selectable).forEach(r => selected.add(r.session)); renderModal(); }
        else if (act === 'none') { selected.clear(); renderModal(); }
        else if (act === 'ask') {
            confirming = true;
            if (confirmTimer) clearTimeout(confirmTimer);
            confirmTimer = setTimeout(() => { confirming = false; if (modalOpen) renderModal(); }, 15000);
            renderModal();
        }
        else if (act === 'cancel') { confirming = false; renderModal(); }
        else if (act === 'go') {
            confirming = false;
            const list = Array.from(selected);
            selected.clear();
            doHandoff(list);
        }
    }

    function onModalChange(e) {
        const el = e.target;
        if (el.dataset.act === 'pick') {
            if (el.checked) selected.add(el.dataset.session); else selected.delete(el.dataset.session);
            confirming = false;
            renderModal();
        } else if (el.dataset.act === 'light') {
            showLight = el.checked;
            renderModal();
        }
    }

    function onKey(e) {
        if (modalOpen && e.key === 'Escape') close();
    }

    function open() {
        modalOpen = true;
        startErrors.clear();
        ensureModal().classList.add('visible');
        render();          // hides bar/pill, draws the last known data at once
        poll();            // then re-measures, and keeps a 4s cadence while open
    }

    function close() {
        modalOpen = false;
        confirming = false;
        const m = document.getElementById(MODAL_ID);
        if (m) m.classList.remove('visible');
        render();
        schedule();
    }

    // ── Actions ─────────────────────────────────────────────────────────────
    // minutes = 0 wakes a snoozed session back up (server clears the snooze).
    async function doSnooze(minutes, sessionName) {
        const session = sessionName || activeSession();
        if (!session) return;
        try {
            const r = await fetch('/api/session/weight/snooze', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ session, minutes }),
            });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            if (minutes === 0) dismissed = null;
            toast(minutes === 0 ? `${session} awake` : `${session} snoozed ${minutes}m`, 'info');
        } catch (e) {
            toast('snooze failed', 'error');
        }
        poll();
    }

    // Accepts one name or an array. Every start request goes out at once; the
    // server runs each handoff independently.
    async function doHandoff(sessions) {
        const list = (Array.isArray(sessions) ? sessions : [sessions || activeSession()]).filter(Boolean);
        if (!list.length) return;
        await Promise.all(list.map(async (session) => {
            startErrors.delete(session);
            try {
                const r = await fetch('/api/session/handoff', {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ session }),
                });
                const d = await r.json();
                if (d.error) { startErrors.set(session, d.error); toast(`${session}: ${d.error}`, 'error'); return; }
                watching.add(session);
                // Show "queued" before the next poll lands.
                const row = rowFor(session);
                if (row) row.handoff = { phase: d.phase || 'queued', done: false, error: '', newSession: '' };
            } catch (e) {
                startErrors.set(session, 'handoff would not start');
                toast(`${session}: handoff would not start`, 'error');
            }
        }));
        render();
        poll();
    }

    // Badge markup for the session list (sessions.js renderSessions and
    // desktop.js pcRenderSessionItem call this). Clicking it opens the modal.
    function badge(sessionName) {
        const row = rowFor(sessionName);
        if (!row || row.level === 'ok') return '';
        return `<span class="sw-badge ${row.level}" title="context weight - open handoffs">${fmtK(row.ctx)}</span>`;
    }

    function start() {
        if (pollTimer) return;
        ensureStyle();
        // The badge lives inside session-list buttons whose own inline onclick
        // switches session. A capture listener runs first and stops that.
        document.addEventListener('click', (e) => {
            if (e.target.closest && e.target.closest('.sw-badge')) {
                e.stopPropagation();
                e.preventDefault();
                open();
            }
        }, true);
        document.addEventListener('keydown', onKey);
        // Coming back to a hidden tab / locked phone: re-measure now instead of
        // showing numbers from before the lock.
        document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
        window.addEventListener('focus', () => poll());
        poll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    // Sessions whose handoff has not finished yet. The split layout keeps their
    // panels while the old tmux is already dead: the sidebar refresh runs every
    // second and this poll every 4, so without it the panel was pruned (and the
    // layout reset) before the new name ever arrived.
    function handingOff() {
        const out = new Set(watching);
        for (const row of rows()) if (isRunning(row)) out.add(row.session);
        return Array.from(out);
    }

    window.SessionWeight = {
        poll, render, badge, doHandoff, doSnooze, start, open, close, dismiss, handingOff,
        get data() { return lastData; },
    };
})();
