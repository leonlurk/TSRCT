/**
 * morning.js — the morning brief, as an OVERLAY (not a tab).
 *
 * Why not a tab: the brief is something you read once, act on, and close. A tab
 * is for a surface you live in. So [A] in the header opens this over whatever
 * you were doing, Esc closes it, and it opens itself once when a new brief
 * lands — the one moment it is genuinely worth interrupting you.
 *
 * Reading order inside the sheet, top to bottom, most useful first:
 *   1. STATUS — a real progress card while it is thinking (the ask takes about
 *      five minutes and used to look like nothing was happening);
 *   2. the BRIEF — the thing he actually wants to read;
 *   3. THE PLAN — the sessions it wants to open, each with a tick box and one
 *      button that opens them. A dry run decides and opens nothing, so without
 *      this button the plan was a dead end;
 *   4. PENDING — everything it found, with where it came from;
 *   5. SCHEDULE + PROJECT FOLDERS — settings, at the bottom, folded away.
 *
 * Listeners are delegated from the overlay, never inline onclick, so generated
 * markup cannot go stale against an export block.
 */
(function () {
    'use strict';

    const POLL_MS = 20000;         // open and idle
    const POLL_BUSY_MS = 4000;     // a job is running: show it moving
    const WATCH_MS = 60000;        // closed: just watching for a new brief
    const SEEN_KEY = 'tsrct_morning_seen';

    let timer = null;
    let tick = null;               // 1s elapsed clock, so the sheet is not re-rendered every second
    let data = { jobs: [], morning: null };
    let registry = null;
    let open = false;
    let showRegistry = false;
    let unchecked = new Set();     // sessions he has UNticked (default is all in)

    function authHeaders(extra) {
        const t = (typeof token !== 'undefined' && token) ? token : (window.token || '');
        return Object.assign({ Authorization: t }, extra || {});
    }

    function esc(s) {
        return typeof window.escapeHtml === 'function'
            ? window.escapeHtml(String(s == null ? '' : s))
            : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function toast(m, kind) { if (typeof window.toast === 'function') window.toast(m, kind || 'info', false); }

    function fmtWhen(ms) {
        if (!ms) return 'never';
        const d = new Date(ms);
        const sameDay = d.toDateString() === new Date().toDateString();
        const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        return sameDay ? `today ${hh}` : `${d.toLocaleDateString()} ${hh}`;
    }

    function fmtDur(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    }

    function running() {
        const m = data.morning;
        return (data.jobs || []).some(j => j.running)
            || !!(m && (m.phase === 'asking' || m.phase === 'opening'));
    }

    // ── data ─────────────────────────────────────────────────────────────────
    async function load() {
        try {
            const r = await fetch('/api/scheduler', { headers: authHeaders() });
            if (r.ok) {
                data = await r.json();
                maybeAutoOpen();
                if (open) render();
                markButton();
            }
        } catch (e) { /* offline: keep what we have */ }
        schedule();
    }

    function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(load, open ? (running() ? POLL_BUSY_MS : POLL_MS) : WATCH_MS);
    }

    async function loadRegistry() {
        try {
            const r = await fetch('/api/projects/registry', { headers: authHeaders() });
            if (r.ok) { registry = await r.json(); if (open) render(true); }
        } catch (e) { /* leave it loading */ }
    }

    // ── "there is something new" ─────────────────────────────────────────────
    function seenAt() {
        try {
            if (typeof window.pcPrefGet === 'function') return Number(window.pcPrefGet(SEEN_KEY, 'browser')) || 0;
            return Number(localStorage.getItem(SEEN_KEY)) || 0;
        } catch { return 0; }
    }

    function markSeen(ms) {
        try {
            if (typeof window.pcPrefSet === 'function') window.pcPrefSet(SEEN_KEY, String(ms), 'browser');
            else localStorage.setItem(SEEN_KEY, String(ms));
        } catch { /* private window: it will just offer itself again */ }
    }

    function isNew() {
        const m = data.morning;
        return !!(m && m.finishedAt && m.brief && m.finishedAt > seenAt());
    }

    function markButton() {
        const b = document.getElementById('pc-morning-btn');
        if (b) b.classList.toggle('has-new', isNew());
    }

    // It interrupts you ONCE per brief, and only on the desktop: a phone waking
    // up into a fullscreen brief you did not ask for is not a feature.
    function maybeAutoOpen() {
        if (open || !isNew()) return;
        if (!document.body.classList.contains('pc-mode')) return;
        if (data.morning.phase !== 'done' && data.morning.phase !== 'planned') return;
        mrnOpen();
    }

    // ── render ───────────────────────────────────────────────────────────────
    // Two rules, both learned from the brief jumping back to the top while he
    // was reading it: the poll re-renders every 20s (4s while a job runs), and
    // rewriting innerHTML throws away the scroll position of .mrn-scroll.
    //   1. IDENTICAL STATE DOES NOT RE-RENDER. A poll that brings back the same
    //      answer must not touch the DOM at all — that is the common case while
    //      he reads, and skipping it also keeps the tick boxes and the folded
    //      sections exactly as he left them.
    //   2. WHEN IT DOES RE-RENDER, THE SCROLL POSITION IS CARRIED OVER, because
    //      a real change (a session finished opening) must not eject him from
    //      the paragraph he is on either.
    let lastSig = null;

    function signature() {
        try {
            return JSON.stringify([
                data.morning, data.jobs, showRegistry,
                registry ? registry.projects.length : -1,
                Array.from(unchecked).sort(),
            ]);
        } catch { return null; }
    }

    // render()      - redraw only if something actually changed.
    // render(true)  - redraw now (he clicked something; the state he sees must
    //                 reflect it even when the server payload is unchanged).
    function render(force) {
        const body = document.getElementById('pc-morning-body');
        if (!body) return;
        const sig = signature();
        if (!force && sig !== null && sig === lastSig && body.firstChild) return;
        const m = data.morning;
        const scroller = body.querySelector('.mrn-scroll');
        const keep = scroller ? scroller.scrollTop : 0;
        const keepX = scroller ? scroller.scrollLeft : 0;
        body.innerHTML = renderHead(m) + `<div class="mrn-scroll">
            ${running() ? renderProgress(m) : ''}
            ${renderBrief(m)}
            ${renderPlan(m)}
            ${renderPending(m)}
            ${renderSkipped(m)}
            ${renderSchedule()}
            ${renderPush()}
            ${renderRegistry()}
        </div>`;
        if (keep || keepX) {
            const next = body.querySelector('.mrn-scroll');
            // Both axes: the sideways offset resetting to 0 reads exactly like
            // the panel jumping, and it was the half nobody carried over.
            if (next) { next.scrollTop = keep; next.scrollLeft = keepX; }
        }
        lastSig = sig;
        startTick();
    }

    function statusChip(m) {
        if (!m) return '<span class="mrn-chip">never run</span>';
        const map = {
            asking: ['working', 'asking Claude'],
            opening: ['working', 'opening sessions'],
            planned: ['plan', 'plan ready - nothing opened'],
            done: ['ok', 'done'],
            failed: ['bad', 'failed'],
        };
        const [cls, label] = map[m.phase] || ['', m.phase || ''];
        return `<span class="mrn-chip ${cls}">${esc(label)}</span>`;
    }

    function renderHead(m) {
        const canSpeak = !!(m && m.brief);
        return `<div class="mrn-top">
            <span class="mrn-title">MORNING BRIEF</span>
            <span class="mrn-stamp">${esc(m && m.today ? m.today : '')}${m && m.finishedAt ? ' · ' + esc(fmtWhen(m.finishedAt)) : ''}</span>
            ${statusChip(m)}
            <span class="mrn-spacer"></span>
            ${canSpeak ? `<button class="mrn-btn ${playing() ? 'on' : ''}" data-act="speak"
                title="Read the brief out loud (runs on the processor, the graphics card is not used)">${speakLabel()}</button>` : ''}
            <button class="mrn-btn" data-act="reload" title="Fetch the latest state from the server">[~]</button>
            <button class="mrn-btn" data-act="close" title="Close (Esc)">[x]</button>
        </div>`;
    }

    // ── reading it out loud ──────────────────────────────────────────────────
    // Piper on the server: any text, spoken on the CPU, card untouched. If that
    // is not installed the browser's own voice reads it instead — a panel whose
    // job is to be read must never go silent because an engine is missing.
    let audio = null;      // the clip currently playing
    let audioUrl = '';
    let fetching = false;

    function playing() { return !!(audio && !audio.paused) || browserBusy(); }
    function browserBusy() {
        try { return !!(window.speechSynthesis && window.speechSynthesis.speaking); } catch { return false; }
    }
    function speakLabel() { return fetching ? '[..] voice' : (playing() ? '[#] stop' : '[)] speak'); }

    function setSpeakLabel() {
        const b = document.querySelector('#pc-morning-body [data-act="speak"]');
        if (!b) return;
        b.textContent = speakLabel();
        b.classList.toggle('on', playing());
    }

    function stopSpeaking() {
        if (audio) { try { audio.pause(); } catch {} }
        if (audioUrl) { try { URL.revokeObjectURL(audioUrl); } catch {} audioUrl = ''; }
        audio = null;
        try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
        setSpeakLabel();
    }

    function browserSpeak(text) {
        try {
            if (!window.speechSynthesis) return false;
            const u = new SpeechSynthesisUtterance(text);
            u.rate = 1; u.lang = 'en-US';
            u.onend = setSpeakLabel;
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(u);
            setSpeakLabel();
            return true;
        } catch { return false; }
    }

    // Say one piece of text in the server's voice, and RESOLVE WHEN IT HAS
    // FINISHED SAYING IT. TALK needs that last part: the microphone has to stay
    // shut while the machine is talking, or it hears itself and answers itself.
    async function sayAloud(say, voice, onStart) {
        const r = await fetch('/api/tts/say', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(voice ? { text: say, voice } : { text: say }),
        });
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(d.error || ('HTTP ' + r.status));
        }
        const buf = await r.arrayBuffer();
        if (!buf || buf.byteLength < 64) throw new Error(`the server sent ${buf ? buf.byteLength : 0} bytes`);
        // Web Audio, not <audio>. An <audio> element given a blob decides for
        // itself whether it likes the container and answers a failure with "no
        // supported source was found", which says nothing about what actually
        // arrived. decodeAudioData reports the real problem, plays from memory,
        // and needs no URL object to leak.
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') await ctx.resume();
        const decoded = await ctx.decodeAudioData(buf.slice(0));
        const src = ctx.createBufferSource();
        src.buffer = decoded;
        src.connect(ctx.destination);
        const done = new Promise((resolve) => {
            src.onended = () => { try { ctx.close(); } catch (e) {} stopSpeaking(); resolve(); };
        });
        // `audio` is what playing()/stopSpeaking() look at, so the Web Audio
        // pair is wrapped to present the same two things they use.
        audio = { paused: false, pause() { this.paused = true; try { src.stop(); } catch (e) {} try { ctx.close(); } catch (e) {} } };
        src.start(0);
        // The fetch is over the moment the sound starts; only the waiting for it
        // to END continues past here, so the caller's "loading" state is dropped
        // now rather than when the clip finishes.
        if (typeof onStart === 'function') onStart();
        setSpeakLabel();
        return done;
    }

    async function speakBrief() {
        if (playing()) { stopSpeaking(); return; }
        const m = data.morning;
        const text = (m && m.brief) ? String(m.brief).trim() : '';
        if (!text) { toast('there is no brief to read', 'error'); return; }
        if (fetching) return;
        fetching = true;
        setSpeakLabel();
        try {
            // Ask the server WHAT to say and in WHICH voice before saying it.
            // The written brief is English; the House voice is Spanish, and the
            // local model does that rewrite. When it is off, this comes back
            // with the English text and no voice, and the default (English)
            // voice reads it - the button still works, it just sounds generic.
            let say = text, voice = '';
            try {
                const sp = await fetch('/api/morning/spoken', {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({}),
                });
                const d = await sp.json().catch(() => ({}));
                if (d && d.ok && d.text) { say = d.text; voice = d.voice || ''; }
            } catch (e) { /* speak the written brief instead */ }

            await sayAloud(say, voice, () => { fetching = false; setSpeakLabel(); });
        } catch (e) {
            // The reason matters: "not installed" is a different job from "it
            // broke". Say it once, then read it anyway with the browser voice.
            toast(`${e.message} - using the browser voice`, 'error');
            console.error('[morning] speak failed:', e);
            browserSpeak(text);
        } finally {
            fetching = false;
            setSpeakLabel();
        }
    }

    // TALK used to live here, inside this overlay. It moved out on 2026-09-19
    // to src/js/assistant.js, because a modal is the wrong shape for an
    // assistant: to talk to it you had to keep this sheet open over whatever you
    // were doing, and closing the sheet ended the conversation. The orb is
    // present in every room and both layouts instead. What stayed here is the
    // brief's own [)] SPEAK button, which reads a long text with its own label
    // and stop control — a different job from a spoken turn.

    // The loader. A run takes about five minutes, and the old panel showed a
    // dead screen for all of it — which is indistinguishable from broken.
    function renderProgress(m) {
        const job = (data.jobs || []).find(j => j.running);
        const since = (m && m.startedAt) || (job && job.lastRun) || Date.now();
        const what = m && m.phase === 'opening'
            ? (m.opening ? `starting <b>${esc(m.opening)}</b>` : 'opening the sessions')
            : 'reading ClickUp, Slack, mail, calendar, the vault and your recent sessions';
        return `<div class="mrn-card mrn-working">
            <div class="mrn-bar"><span></span></div>
            <div class="mrn-work-line">
                <span class="mrn-work-what">${what}</span>
                <span class="mrn-elapsed" data-since="${since}">${esc(fmtDur(Date.now() - since))}</span>
                <button class="mrn-btn" data-act="stop" title="Stop this run. Sessions already opened stay open.">[x] STOP</button>
            </div>
            <div class="mrn-dim">It asks Claude one big question across every source. Usually four to six minutes. You can close this - it keeps going.</div>
        </div>`;
    }

    function renderBrief(m) {
        if (!m) {
            return `<div class="mrn-card"><div class="mrn-empty">
                Nothing yet. <b>[?] dry run</b> below shows you exactly what it would do without opening a single session.</div></div>`;
        }
        if (m.error) {
            return `<div class="mrn-card"><div class="mrn-bad">${esc(m.error)}</div>
                ${m.raw ? `<div class="mrn-dim mrn-raw">${esc(m.raw)}</div>` : ''}</div>`;
        }
        if (!m.brief) return '';
        return `<div class="mrn-card mrn-hero"><div class="mrn-brief">${esc(m.brief)}</div></div>`;
    }

    // The plan, with the button the dry run never had.
    function renderPlan(m) {
        if (!m) return '';
        const planned = m.plannedSessions || [];
        const opened = (m.opened || []).filter(o => !o.dryRun);

        if (opened.length) {
            // What is left of the plan after the ones that really opened — by
            // project, because a name collision renames the session (foo -> foo-2)
            // and matching on the name would list an open session twice.
            const rest = openablePlan(m);
            return `<div class="mrn-card">
                <div class="mrn-h">SESSIONS OPEN <span class="mrn-sub">${opened.length}</span></div>
                ${opened.map(o => `<div class="mrn-srow">
                    <button class="mrn-go" data-act="go" data-session="${esc(o.session)}" title="Switch to this session">${esc(o.session)}</button>
                    <div class="mrn-smain"><div class="mrn-why">${esc(o.why)}</div><div class="mrn-dim">${esc(o.cwd)}</div></div>
                </div>`).join('')}
                ${rest.length ? `<div class="mrn-h mrn-rest">ALSO IN THE PLAN <span class="mrn-sub">not opened</span>
                    <span class="mrn-spacer"></span>
                    <button class="mrn-btn mrn-go-btn" data-act="openplan" ${running() ? 'disabled' : ''}>[&gt;] OPEN ${countChecked(m)} MORE</button>
                    </div>${renderPlanList(m, rest, false)}` : ''}
            </div>`;
        }
        if (!planned.length) return '';
        return `<div class="mrn-card mrn-plan">
            <div class="mrn-h">THE PLAN <span class="mrn-sub">${planned.length} session${planned.length === 1 ? '' : 's'} it wants open</span>
                <span class="mrn-spacer"></span>
                <button class="mrn-btn mrn-go-btn" data-act="openplan" ${running() ? 'disabled' : ''}>[&gt;] OPEN ${countChecked(m)} NOW</button>
            </div>
            <div class="mrn-note">Nothing is open yet - this is what it decided. Untick anything you do not want.</div>
            ${renderPlanList(m, planned, false)}
        </div>`;
    }

    function planName(s, i) {
        const raw = String(s.session || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
        return (raw || `am-${s.project || i}`).slice(0, 40);
    }

    // What is still openable: the plan minus whatever already really opened.
    // Everything that offers to open sessions goes through this, so the button,
    // the count and what gets posted can never disagree.
    function openablePlan(m) {
        const done = new Set(((m && m.opened) || []).filter(o => !o.dryRun).map(o => o.project));
        return ((m && m.plannedSessions) || []).filter(s => !done.has(s.project));
    }

    function checkedNames(m) {
        return openablePlan(m).map((s, i) => planName(s, i)).filter(n => !unchecked.has(n));
    }

    function countChecked(m) { return checkedNames(m).length; }

    function renderPlanList(m, planned, dim) {
        return planned.map((s, i) => {
            const name = planName(s, i);
            const on = !unchecked.has(name);
            return `<label class="mrn-srow ${dim ? 'dim' : ''}">
                ${dim ? '' : `<input type="checkbox" data-act="pick" data-session="${esc(name)}" ${on ? 'checked' : ''}>`}
                <span class="mrn-sname">${esc(name)}</span>
                <div class="mrn-smain">
                    <div class="mrn-why">${esc(s.why || '')}</div>
                    <div class="mrn-dim">${esc(s.project || '')}${s.priority ? ' · priority ' + esc(s.priority) : ''}</div>
                </div>
            </label>`;
        }).join('');
    }

    function renderPending(m) {
        const pending = (m && m.pending) || [];
        if (!pending.length) return '';
        return `<div class="mrn-card">
            <div class="mrn-h">PENDING <span class="mrn-sub">${pending.length}</span></div>
            ${pending.map(p => `<div class="mrn-prow">
                <div class="mrn-ptitle">${esc(p.title)}</div>
                <div class="mrn-why">${esc(p.why)}</div>
                <div class="mrn-dim">${esc(p.source)}${p.project ? ' · ' + esc(p.project) : ''}</div>
            </div>`).join('')}
        </div>`;
    }

    function renderSkipped(m) {
        const skipped = (m && m.skipped) || [];
        if (!skipped.length) return '';
        return `<div class="mrn-card">
            <div class="mrn-h bad">NOT OPENED <span class="mrn-sub">${skipped.length}</span></div>
            ${skipped.map(s => `<div class="mrn-prow">
                <div class="mrn-ptitle">${esc(s.project || s.session || '?')}</div>
                <div class="mrn-why bad">${esc(s.why)}</div>
            </div>`).join('')}
        </div>`;
    }

    function renderSchedule() {
        const jobs = data.jobs || [];
        if (!jobs.length) {
            return `<div class="mrn-card mrn-foot"><div class="mrn-empty">No jobs registered - restart the server if you just updated it.</div></div>`;
        }
        return `<div class="mrn-card mrn-foot">
            ${jobs.map(j => `<div class="mrn-job ${j.enabled ? '' : 'off'}">
                <div class="mrn-job-top">
                    <span class="mrn-job-name">${esc(j.name)}</span>
                    <input class="mrn-time" type="time" value="${esc(j.at)}" data-act="time" data-job="${esc(j.name)}" title="What time this fires">
                    <button class="mrn-btn ${j.enabled ? 'on' : ''}" data-act="toggle" data-job="${esc(j.name)}"
                        title="${j.enabled ? 'Stop it firing automatically' : 'Let it fire automatically'}">${j.enabled ? '[ON]' : '[OFF]'}</button>
                    <span class="mrn-spacer"></span>
                    <button class="mrn-btn" data-act="run" data-job="${esc(j.name)}" ${j.running ? 'disabled' : ''}
                        title="Ask now and open the sessions for real">[&gt;] run now</button>
                    <button class="mrn-btn" data-act="dry" data-job="${esc(j.name)}" ${j.running ? 'disabled' : ''}
                        title="Ask now, decide, report - open nothing">[?] dry run</button>
                    <button class="mrn-btn" data-act="clear" data-job="${esc(j.name)}"
                        title="Forget that it already ran today, so it can fire again">[~] again today</button>
                </div>
                <div class="mrn-job-state ${j.lastOk === false ? 'bad' : ''}">
                    ${j.running ? 'running now'
                        : `last ${esc(fmtWhen(j.lastRun))}${j.durationMs ? ' · ' + esc(fmtDur(j.durationMs)) : ''}`
                          + (j.lastOk === false ? ` · failed: ${esc(j.lastError)}` : '')}
                    ${j.enabled ? ` · next ${esc(fmtWhen(j.nextDue))}` : ' · off'}
                </div>
            </div>`).join('')}
        </div>`;
    }

    // ── waking the phone ─────────────────────────────────────────────────────
    // Web Push: the one thing that reaches him with TSRCT closed. Outbound only
    // from the server, so nothing about the machine's exposure changes.
    let pushInfo = null;

    let pushWhy = '';

    async function loadPush() {
        try {
            const r = await fetch('/api/push/status', { headers: authHeaders() });
            if (r.ok) { pushInfo = await r.json(); pushWhy = ''; }
            else pushWhy = `could not read the push status (HTTP ${r.status})`;
        } catch (e) { pushWhy = e.message; }
        if (open) render(true);
    }

    function renderPush() {
        // The card used to VANISH when the status call had not landed (or had
        // failed), which on the phone looks exactly like the feature not being
        // there. It is the entry point for waking that phone, so it always draws
        // and says what state it is in instead.
        if (!pushInfo) {
            const supported = ('serviceWorker' in navigator) && ('PushManager' in window);
            return `<div class="mrn-card mrn-foot">
                <div class="mrn-h">WAKE MY PHONE <span class="mrn-sub">${pushWhy ? 'unavailable' : 'checking...'}</span>
                    <span class="mrn-spacer"></span>
                    ${supported ? `<button class="mrn-btn" data-act="push-on">[+] this device</button>` : ''}
                </div>
                <div class="mrn-note">${pushWhy
                    ? `<span class="bad">${esc(pushWhy)}</span>`
                    : (supported ? 'Asking the server which devices are registered...'
                        : 'This browser cannot receive notifications. On iPhone, add TSRCT to the home screen and open it from there.')}</div>
            </div>`;
        }
        const n = (pushInfo.devices || []).length;
        const supported = ('serviceWorker' in navigator) && ('PushManager' in window);
        return `<div class="mrn-card mrn-foot">
            <div class="mrn-h">WAKE MY PHONE <span class="mrn-sub">${n ? `${n} device${n === 1 ? '' : 's'}` : 'nobody yet'}</span>
                <span class="mrn-spacer"></span>
                ${supported ? `<button class="mrn-btn" data-act="push-on" title="Let this device be woken when a brief lands">[+] this device</button>
                <button class="mrn-btn" data-act="push-test" ${n ? '' : 'disabled'} title="Send a test notification now">[>] test</button>` : ''}
                <button class="mrn-btn" data-act="ring-test" title="Make the phone RING - loud, and again every 40s until you answer">[!] ring me</button>
            </div>
            <div class="mrn-note">${supported
                ? 'The notification tells you what happened - meeting, brief, something broken. It is encrypted end to end, and anything SecretCo is refused before it leaves.'
                : 'This browser cannot be woken. Install TSRCT to the home screen on the phone and add it there.'}</div>
            <div class="mrn-note">[!] ring me is the CALL: it goes out through the ntfy app at urgent
                priority (that is the one that can be loud and override silent) and repeats every 40
                seconds, up to five times, until you open it. Opening it from the alert hangs up.</div>
            ${(pushInfo.devices || []).map(d => `<div class="mrn-preg">
                <span class="mrn-pname">${esc(d.label || d.host)}</span>
                <span class="mrn-dim">${d.lastOk ? 'last woken ' + esc(fmtWhen(d.lastOk)) : 'never woken'}${d.fails ? ' · ' + d.fails + ' failed' : ''}</span>
            </div>`).join('')}
        </div>`;
    }

    function urlB64ToBytes(s) {
        const pad = '='.repeat((4 - (s.length % 4)) % 4);
        const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
    }

    async function pushEnable() {
        try {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('this browser cannot be woken');
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') throw new Error('notifications are blocked for this site');
            const reg = await navigator.serviceWorker.ready;
            if (!pushInfo || !pushInfo.publicKey) await loadPush();
            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlB64ToBytes(pushInfo.publicKey),
            });
            const label = /android|iphone|ipad/i.test(navigator.userAgent) ? 'phone' : 'desktop';
            await post('/api/push/subscribe', { subscription: sub.toJSON(), label });
            toast('this device will be woken');
            loadPush();
        } catch (e) { toast(e.message, 'error'); }
    }

    function renderRegistry() {
        const n = registry ? registry.projects.filter(p => !p.known).length : 0;
        const head = `<div class="mrn-h mrn-fold" data-act="fold">
            <span>${showRegistry ? '[-]' : '[+]'} PROJECT FOLDERS</span>
            <span class="mrn-sub">${registry ? `${registry.projects.length - n} placed${n ? ' · ' + n + ' with no folder' : ''}` : 'loading...'}</span>
        </div>`;
        if (!showRegistry) return `<div class="mrn-card mrn-foot">${head}</div>`;
        if (!registry) return `<div class="mrn-card mrn-foot">${head}<div class="mrn-empty">Loading...</div></div>`;
        const known = registry.projects.filter(p => p.known);
        const unknown = registry.projects.filter(p => !p.known);
        return `<div class="mrn-card mrn-foot">${head}
            <div class="mrn-note">The routine can only open a session for a project that has a folder here.</div>
            ${unknown.map(p => `<div class="mrn-preg">
                <span class="mrn-pname">${esc(p.project)}</span>
                <input class="mrn-pin" type="text" placeholder="${window.TSRCT_PROJECTS_ROOT}/..." data-act="pin" data-project="${esc(p.project)}">
            </div>`).join('')}
            ${known.map(p => `<div class="mrn-preg">
                <span class="mrn-pname">${esc(p.project)}</span>
                <span class="mrn-dim mrn-pcwd" title="${esc(p.cwd)}">${esc(p.cwd)}</span>
                <span class="mrn-src">${esc(p.source)}</span>
            </div>`).join('')}
        </div>`;
    }

    // The elapsed clock updates ONE span. Re-rendering the sheet every second
    // would throw away his scroll position and the tick boxes he just set.
    function startTick() {
        stopTick();
        const el = document.querySelector('#pc-morning-body .mrn-elapsed');
        if (!el) return;
        tick = setInterval(() => {
            const node = document.querySelector('#pc-morning-body .mrn-elapsed');
            if (!node) { stopTick(); return; }
            node.textContent = fmtDur(Date.now() - Number(node.dataset.since || Date.now()));
        }, 1000);
    }

    function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

    // ── actions ──────────────────────────────────────────────────────────────
    async function post(url, body) {
        const r = await fetch(url, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
    }

    async function onClick(e) {
        const el = e.target.closest('[data-act]');
        if (!el || el.tagName === 'INPUT') return;
        const act = el.dataset.act;
        const job = el.dataset.job;
        try {
            if (act === 'close') { mrnClose(); return; }
            // Deliberately NOT stopped by closing the sheet: reading it while
            // you do something else is the point. Reopening shows [#] stop.
            if (act === 'speak') { speakBrief(); return; }
            if (act === 'push-on') { pushEnable(); return; }
            if (act === 'stop') {
                el.disabled = true;
                await post('/api/morning/stop', {});
                toast('stopping');
                load();
                return;
            }
            if (act === 'ring-test') {
                const r = await post('/api/ring/start', {
                    title: 'TSRCT is calling',
                    body: 'Test call. Open it and it stops ringing.',
                    url: '/?speak=morning', kind: 'ring',
                });
                toast(`ringing - ${r.rings} times, every ${Math.round((r.everyMs || 40000) / 1000)}s until you answer`);
                return;
            }
            if (act === 'push-test') {
                await post('/api/push/test', {
                    title: 'Morning brief ready', body: '2 sessions open, first: coldwell-audit. Daily Front at 9:30.',
                    url: '/?speak=morning', kind: 'morning',
                });
                toast('sent - check the phone');
                return;
            }
            if (act === 'fold') { showRegistry = !showRegistry; render(true); if (showRegistry && !registry) loadRegistry(); return; }
            if (act === 'reload') { load(); loadRegistry(); return; }
            if (act === 'go') {
                const s = el.dataset.session;
                mrnClose();
                if (typeof window.pcSwitchSession === 'function') window.pcSwitchSession(s);
                else if (typeof window.switchSession === 'function') window.switchSession(s);
                return;
            }
            if (act === 'openplan') {
                const picked = checkedNames(data.morning || {});
                if (!picked.length) { toast('nothing ticked', 'error'); return; }
                await post('/api/morning/open', { sessions: picked });
                toast(`opening ${picked.length} session${picked.length === 1 ? '' : 's'}`);
            } else if (act === 'toggle') {
                const cur = (data.jobs || []).find(j => j.name === job);
                await post('/api/scheduler/job', { name: job, enabled: !(cur && cur.enabled) });
                toast(`${job} ${cur && cur.enabled ? 'off' : 'on'}`);
            } else if (act === 'run' || act === 'dry') {
                const dry = act === 'dry';
                await post('/api/scheduler/run', { name: job, dryRun: dry });
                unchecked = new Set();
                toast(dry ? 'dry run started - nothing will be opened' : `${job} started`);
            } else if (act === 'clear') {
                await post('/api/scheduler/job', { name: job, clearToday: true });
                toast('it can run again today');
            }
        } catch (err) {
            toast(err.message, 'error');
        }
        load();
    }

    function onChange(e) {
        const el = e.target;
        if (el.dataset.act === 'pick') {
            const n = el.dataset.session;
            if (el.checked) unchecked.delete(n); else unchecked.add(n);
            const btn = document.querySelector('#pc-morning-body [data-act="openplan"]');
            if (btn) btn.textContent = `[>] OPEN ${countChecked(data.morning || {})} NOW`;
            return;
        }
        (async () => {
            try {
                if (el.dataset.act === 'time') {
                    await post('/api/scheduler/job', { name: el.dataset.job, at: el.value });
                    toast(`${el.dataset.job} at ${el.value}`);
                    load();
                } else if (el.dataset.act === 'pin') {
                    const cwd = el.value.trim();
                    if (!cwd) return;
                    await post('/api/projects/registry', { project: el.dataset.project, cwd });
                    toast(`${el.dataset.project} -> ${cwd}`);
                    loadRegistry();
                }
            } catch (err) { toast(err.message, 'error'); }
        })();
    }

    function onKey(e) {
        if (e.key !== 'Escape' || !open) return;
        // This listener is on the document in CAPTURE, so it sees Esc before the
        // sheet does: while he is typing into TALK, Esc has to leave the box and
        // not take the whole brief down with it.
        const a = document.activeElement;
        e.stopPropagation();
        mrnClose();
    }

    // ── open / close ─────────────────────────────────────────────────────────
    // The overlay markup lives in Desktop.buildPCLayout(), which never runs on a
    // phone — so on mobile the element simply did not exist and the BRIEF button
    // did nothing at all. Build it here when it is missing instead: the overlay
    // is this module's DOM, and room-morning.css already has the phone layout.
    function overlay() {
        let ov = document.getElementById('pc-morning-overlay');
        if (!ov) {
            ov = document.createElement('div');
            ov.className = 'mrn-overlay hidden';
            ov.id = 'pc-morning-overlay';
            ov.innerHTML = '<div class="mrn-sheet" id="pc-morning-body"></div>';
            document.body.appendChild(ov);
        }
        return ov;
    }

    function mrnOpen() {
        const ov = overlay();
        if (!ov) return;
        if (window.WorldManager && typeof WorldManager.loadRoomCSS === 'function') WorldManager.loadRoomCSS('morning');
        if (!ov.dataset.wired) {
            ov.dataset.wired = '1';
            ov.addEventListener('click', onClick);
            ov.addEventListener('change', onChange);
            // Click the backdrop (not the sheet) to close.
            ov.addEventListener('mousedown', (e) => { if (e.target === ov) mrnClose(); });
        }
        open = true;
        ov.classList.remove('hidden');
        document.addEventListener('keydown', onKey, true);
        const m = data.morning;
        if (m && m.finishedAt) { markSeen(m.finishedAt); markButton(); }
        // Opening starts at the top: the sheet from the last time it was open is
        // still in the DOM, and carrying ITS scroll position over would drop him
        // mid-brief on a brief he has not started reading.
        const body = document.getElementById('pc-morning-body');
        if (body) body.innerHTML = '';
        lastSig = null;
        render(true);
        load();
        // The push status is fetched at boot, 2.5s in. On a phone that call can
        // land before the token is set (or not at all, on a cold PWA start), and
        // the panel then had no way back - so opening it asks again.
        if (!pushInfo) loadPush();
        if (showRegistry && !registry) loadRegistry();
    }

    function mrnClose() {
        const ov = overlay();
        if (ov) ov.classList.add('hidden');
        open = false;
        // Reading the brief out loud deliberately survives closing the sheet,
        // and so does the assistant now — it does not live in here any more, so
        // closing this sheet has nothing to do with whether he is talking.
        stopTick();
        document.removeEventListener('keydown', onKey, true);
        const m = data.morning;
        if (m && m.finishedAt) markSeen(m.finishedAt);
        markButton();
        schedule();
    }

    function mrnToggle() { if (open) mrnClose(); else mrnOpen(); }

    // ── arriving from a notification ─────────────────────────────────────────
    // Two ways in, and both have to end the same: the sheet open and talking.
    //   - the app was already running: the service worker posts a message;
    //   - the app was closed: it opens at /?speak=morning.
    // The tap is what allows audio to play at all, so speaking is started off
    // the back of it rather than on a timer.
    // Picking up. The phone keeps ringing until the server is told somebody
    // answered, so this is sent the moment TSRCT opens from the alert - before
    // the brief has even loaded, because the ringing is the thing to stop first.
    function ringAck(who) {
        try {
            fetch('/api/ring/ack', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ who: who || 'phone' }),
            });
        } catch (e) { /* the ring gives up on its own after the last one */ }
    }

    // ── answering the call ──────────────────────────────────────────────────
    // It used to end here: the brief was read and then nothing. Now the call is
    // HANDED OVER to the assistant — the orb turns on off the back of the same
    // tap (which is the gesture that allows audio at all), and the server is
    // asked to offer the board the brief just proposed. So the whole thing is:
    // it rings, he answers, it reads him the brief, it says "¿abro las tres que
    // te propuse?" and he says "dale" with his eyes shut.
    //
    // None of that wakes the local model: Piper is CPU, the offer is written by
    // lib/actions.js, and his "dale" runs a declared action. The model is loaded
    // only if he then asks something that needs one.
    async function handOver() {
        try {
            // light: the call must not wait on a model, and must work with Ollama off.
            if (window.Assistant && !(window.Assistant.state() || {}).on) await window.Assistant.start({ light: true });
        } catch (e) { /* no assistant on this page: the brief was still read */ }
        try {
            await fetch('/api/morning/offer', {
                method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}',
            });
        } catch (e) { /* nothing to offer is not an error */ }
    }

    function openAndSpeak() {
        ringAck('opened from the alert');
        mrnOpen();
        const go = () => {
            if (data.morning && data.morning.brief) speakBrief().then(handOver, handOver);
            else setTimeout(go, 1500);           // the poll has not landed yet
        };
        setTimeout(go, 400);
    }

    function wireArrival() {
        try {
            navigator.serviceWorker.addEventListener('message', (e) => {
                const d = e.data || {};
                if (d.type === 'tsrct-push-open' && (!d.kind || d.kind === 'morning')) openAndSpeak();
            });
        } catch (e) { /* no service worker: the button still works */ }
        try {
            if (new URLSearchParams(location.search).get('speak') === 'morning') {
                // Opened cold from the notification. Wait for the first poll so
                // there is something to read.
                setTimeout(openAndSpeak, 3000);
            }
        } catch (e) {}
    }

    // Watch from boot, closed: that is what makes [A] light up and what lets a
    // brief that landed while he slept show itself once.
    function boot() {
        const start = () => { load(); loadPush(); wireArrival(); };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(start, 2500));
        } else {
            setTimeout(start, 2500);
        }
    }
    boot();

    window.mrnOpen = mrnOpen;
    window.mrnClose = mrnClose;
    window.mrnToggle = mrnToggle;
    window.Morning = { load, render, open: mrnOpen, close: mrnClose, get data() { return data; } };
})();
