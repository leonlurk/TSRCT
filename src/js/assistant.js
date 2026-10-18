/**
 * assistant.js — the assistant as an ENTITY, not a screen.
 *
 * WHY THIS FILE EXISTS (2026-09-19). TALK was born inside the morning brief's
 * overlay, which made it a modal: to talk to it you had to keep a sheet open
 * over whatever you were doing, and closing that sheet ended the conversation
 * and unloaded the model. Leon, on seeing it work: "tiene que ser literalmente
 * una interfaz de asistente, no un modal que si o si tenes que dejar abierto ...
 * si estoy en una sesion especifica me gustaria poder estar en ese chat y al
 * mismo tiempo poder hablar en paralelo con el asistente ... es un ENTE, no
 * necesita obligarme a mantenerme en una interfaz".
 *
 * So: one orb, fixed to the corner, on every screen and in every room, mobile
 * and desktop alike. Nothing it draws is modal — no backdrop, nothing that eats
 * a click meant for the terminal, and the strip and panel are as small as they
 * can be while still saying what is happening.
 *
 *   [·] off      the orb, alone
 *   [o] listening    strip: state + the last thing said
 *   [~] thinking
 *   [)] speaking
 *   [...] expands the panel: which session, the switches, the log, a text box
 *
 * THE CONVERSATION IS NOT HERE. It lives in the server (lib/talk.js), which owns
 * the model, the memory policy and the session watcher; this file is a mouth, a
 * speaker and a state light. That is why leaving the panel closed costs nothing
 * and why a second window shows the same conversation: both are clients of one
 * state. The corollary is the rule that replaced "a panel is open" as proof he
 * is present — the server closes the conversation after half an hour without a
 * word FROM HIM, however much the sessions are narrating.
 *
 * RELAY IS OFF BY DEFAULT and says so loudly when armed. On 2026-09-19 it
 * shipped on, one test word ("Hello") was typed into a live session, and Claude
 * answered it. Typing into a running session is a decision, never a default.
 */
(function () {
    'use strict';

    // ── ONE orb, two apps (2026-10-09) ──────────────────────────────────────
    // Ghost Runner (personal/runner-app) loads THIS file too, served from this
    // folder by its own server, so a fix to Tesla's orb lands in both at once.
    // It sets window.TESLA_ORB before loading it; TSRCT sets nothing and gets
    // the defaults below. Everything that differs between the two is here.
    const CFG = Object.assign({
        app: 'tsrct',
        base: '/api',            // where /talk/*, /tts/*, /sessions live
        headers: null,           // () => auth headers; default: TSRCT's token
        unauthorized: null,      // (response) => true when it handled a refusal (re-pair)
        toast: null,             // (text) => void; default: window.toast
        lang: null,              // () => recogniser language; default: his ES/EN button
        headExtra: null,         // () => html for extra header buttons
        footExtra: null,         // () => html under the panel
        gate: null,              // () => html shown INSTEAD of the panel (not paired), or ''
        onAct: null,             // (act, el) => true when it handled a data-act itself
        canPoll: null,           // () => may it poll in the background right now
        // TSRCT keeps a silent loop playing so the headset button reaches it.
        // A running app must not: it held audio focus and ducked his music for
        // a whole run (Ghost Runner, 2026-09-06).
        silentLoop: true,
        // WALKIE-TALKIE (2026-10-14, Ghost Runner): an open microphone makes the
        // phone turn his music down, so a mic left open for a whole conversation
        // kept Spotify low for the whole run. With walkie on, a tap opens the mic
        // for ONE sentence, it closes the moment that sentence is sent, and the
        // next tap opens it again. The conversation itself stays open on the server.
        walkie: false,
        // Another voice on the same page (Ghost Runner's kilometre calls):
        // { speaking(): bool, isEcho(text): bool }. They take turns.
        otherVoice: null,
        offlineWhy: '',          // said when a poll cannot reach the server at all
    }, window.TESLA_ORB || {});
    const api = (p) => CFG.base + p;
    const refused = (r) => !!(r && CFG.unauthorized && CFG.unauthorized(r));
    function otherSpeaking() {
        try { return !!(CFG.otherVoice && CFG.otherVoice.speaking()); } catch (e) { return false; }
    }
    function waitForOther(maxMs) {
        if (!otherSpeaking()) return Promise.resolve();
        const t0 = Date.now();
        return new Promise((resolve) => {
            const check = () => (!otherSpeaking() || Date.now() - t0 > (maxMs || 12000) ? resolve() : setTimeout(check, 250));
            setTimeout(check, 250);
        });
    }

    const POLL_MS = 3500;

    const talk = {
        on: false, listening: false, thinking: false, warm: false,
        why: '', draft: '',
        session: '', toClaude: false, watch: true, live: true,
        sessions: [],
        lines: [],          // [{who:'you'|'it'|'watch'|'sent', text}]
        since: 0,
        queue: [],          // spoken lines taken from the server, not yet said
        expanded: false,
        picking: false,    // the session list is open
        home: '',          // the session the rest of TSRCT is showing
        name: 'Tesla',
        // What it JUST said, shown beside the orb for a few seconds and then
        // gone. The permanent strip that used to live here read as a disabled
        // element: dimmed text, one truncated line, always on screen.
        caption: null,      // { who, text }
        // Work running in the background (a prompt being researched): which
        // model, how long, its last step. From the server on every poll.
        jobs: [],
        // Attached in the panel, sent with the next thing he says (Sam's
        // screenshots): [{ path, name }] as the server stored them.
        files: [],
    };

    let rec = null;
    let recWanted = false;
    let poll = null;
    let bgPoll = null;
    let captionTimer = null;
    let typeTimer = null;
    let audio = null;
    let ctxAudio = null;

    // ── plumbing ─────────────────────────────────────────────────────────────
    function authHeaders(extra) {
        if (CFG.headers) return Object.assign({}, CFG.headers(), extra || {});
        const t = (typeof token !== 'undefined' && token) ? token : (window.token || '');
        return Object.assign({ Authorization: t }, extra || {});
    }

    function esc(s) {
        return typeof window.escapeHtml === 'function'
            ? window.escapeHtml(String(s == null ? '' : s))
            : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // What happened here that the server cannot see, for its log of every
    // conversation (lib/teslaLog.js). Fire and forget: never in the way.
    function logEvent(kind, detail, data) {
        fetch(api('/talk/event'), {
            method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ kind, detail: String(detail || '').slice(0, 300),
                data: CFG.app !== 'tsrct' ? Object.assign({ app: CFG.app }, data || {}) : (data || undefined) }),
        }).catch(() => {});
    }
    // The clock of one exchange as HE lives it, which the server cannot see:
    // when his first and last phrase were heard, when its voice last stopped,
    // and when the mic came back after it. Read and reset by ask().
    const tm = { first: 0, last: 0, phrases: 0 };
    let voiceEndAt = 0;          // when it last finished speaking
    let micBackMs = null;        // from that moment to the mic listening again
    let lastVoice = null;        // { ttsMs, audioMs, fallback } of the last thing said
    function toast(m, kind) {
        if (CFG.toast) { CFG.toast(m, kind); return; }
        if (typeof window.toast === 'function') window.toast(m, kind || 'info', false);
    }

    function micSupported() {
        return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    // The panel says one short line about a failure; the whole server message
    // (the SecretCo refusal is 164 characters of contract) goes to the console,
    // where it is useful. A log line is not a piece of interface.
    function shortWhy(why) {
        const w = String(why || '').trim();
        if (!w) return '';
        // One sentence for every SecretCo refusal read like a stuck machine. Each
        // door gets its own words, because they mean different things to him.
        if (/answer mentioned secretco/i.test(w)) return 'it wrote something it is not allowed to say, so I dropped it';
        if (/session screen|screen of/i.test(w)) return 'that session has content this assistant cannot look at';
        if (/secretco/i.test(w)) return 'that one stays off this assistant';
        if (/circuit/i.test(w)) return 'the model is backing off - try again in a moment';
        if (/timeout|took too long/i.test(w)) return 'it took too long to answer';
        if (/failed to fetch|networkerror|load failed/i.test(w)) return CFG.offlineWhy || 'TSRCT cannot be reached';
        if (/not running|unreachable/i.test(w)) return 'the local model is not running';
        if (/graphics card is busy/i.test(w)) return w;
        return w.length <= 80 ? w : w.slice(0, 77).replace(/[\s,;:.-]+$/, '') + '...';
    }

    // ── the voice ────────────────────────────────────────────────────────────
    // Resolves when the sound has FINISHED, which is what lets the microphone
    // stay shut while the machine talks. (morning.js has its own copy for the
    // brief: that one reads a long text with its own stop button and label.)
    // `speaking` covers the WHOLE act of saying something — asking the server
    // for the clip, decoding it, playing it — not only the seconds with sound.
    // It used to be the sound alone: the microphone came back up while the clip
    // was still being fetched, was open when the voice started, and House's own
    // sentence came back as something Leon had said.
    let speaking = 0;
    let hushGen = 0;            // bumped by hush(): a clip still being fetched must not play
    function playing() { return speaking > 0 || !!(audio && !audio.paused); }

    function stopSpeaking() {
        if (audio) { try { audio.pause(); } catch (e) {} }
        audio = null;
        try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
    }

    function browserSpeak(text) {
        try {
            if (!window.speechSynthesis) return false;
            const u = new SpeechSynthesisUtterance(text);
            u.rate = 1; u.lang = window.TSRCT_LANG === 'en-US' ? 'en-US' : 'es-AR';
            window.speechSynthesis.cancel();
            // Resolves when it has finished talking, like say() — the microphone
            // waits on this one too.
            const done = new Promise((resolve) => {
                u.onend = resolve; u.onerror = resolve;
                setTimeout(resolve, Math.min(60000, 2000 + text.length * 90));
            });
            window.speechSynthesis.speak(u);
            return done;
        } catch { return false; }
    }

    async function say(text, voice, onStart) {
        const gen = hushGen;
        const r = await fetch(api('/tts/say'), {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(voice ? { text, voice } : { text }),
        });
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(d.error || ('HTTP ' + r.status));
        }
        const buf = await r.arrayBuffer();
        if (!buf || buf.byteLength < 64) throw new Error('the server sent no audio');
        ctxAudio = ctxAudio || new (window.AudioContext || window.webkitAudioContext)();
        if (ctxAudio.state === 'suspended') await ctxAudio.resume();
        const decoded = await ctxAudio.decodeAudioData(buf.slice(0));
        if (gen !== hushGen) return;
        // Another voice mid-line (a kilometre call): it finishes first.
        await waitForOther();
        if (gen !== hushGen) return;
        const src = ctxAudio.createBufferSource();
        src.buffer = decoded;
        src.connect(ctxAudio.destination);
        const done = new Promise((resolve) => { src.onended = () => { audio = null; render(); resolve(); }; });
        audio = { paused: false, pause() { this.paused = true; try { src.stop(); } catch (e) {} } };
        // The AudioBuffer knows exactly how long this will take to say, and it
        // knows it BEFORE a sound comes out — which is what lets the subtitle be
        // written at the speed of the voice instead of guessed at.
        if (typeof onStart === 'function') onStart(decoded.duration);
        src.start(0);
        render();
        return done;
    }

    // ── the UI ───────────────────────────────────────────────────────────────
    function dock() {
        let d = document.getElementById('asst');
        if (d) return d;
        d = document.createElement('div');
        d.id = 'asst';
        d.className = 'asst';
        // Built here rather than in index.html for the reason the mobile BRIEF
        // button did nothing for weeks: markup that lives in one layout's
        // builder exists only in that layout. This one has to exist everywhere.
        d.innerHTML = '<div class="asst-panel hidden" id="asst-panel"></div>'
            + '<div class="asst-cap hidden" id="asst-cap" data-act="asst-expand"></div>'
            + '<button class="asst-orb" id="asst-orb" data-act="asst-toggle"></button>';
        document.body.appendChild(d);
        d.addEventListener('click', onClick);
        d.addEventListener('change', onChange);
        d.addEventListener('input', onInput);
        d.addEventListener('keydown', onKeydown);
        makeMovable(d, d.querySelector('#asst-orb'));
        return d;
    }

    // ── kicking it out of the way ────────────────────────────────────────────
    // The dock is pinned to whichever CORNER the orb was dropped nearest, as an
    // offset from that corner — not as a left/top pair. That is what keeps it on
    // screen through a rotation or a resize, and it is what tells the panel and
    // the caption which way to open: they always unfold toward the middle.
    const POS_KEY = 'tsrct_asst_pos';
    const EDGE = 6;
    const DRAG_PX = 6;          // less than this is a tap, not a drag

    function placeDock(d, pos) {
        const orb = d.querySelector('#asst-orb');
        const w = orb.offsetWidth || 46, h = orb.offsetHeight || 46;
        const x = Math.max(EDGE, Math.min(pos.x, window.innerWidth - w - EDGE));
        const y = Math.max(EDGE, Math.min(pos.y, window.innerHeight - h - EDGE));
        d.style.left = pos.side === 'l' ? x + 'px' : 'auto';
        d.style.right = pos.side === 'l' ? 'auto' : x + 'px';
        d.style.top = pos.vert === 't' ? y + 'px' : 'auto';
        d.style.bottom = pos.vert === 't' ? 'auto' : y + 'px';
        // What is left between the orb and the far edge — the panel may not be taller.
        d.style.setProperty('--asst-room', Math.max(160, window.innerHeight - y - h - 22) + 'px');
        d.classList.toggle('asst-left', pos.side === 'l');
        d.classList.toggle('asst-top', pos.vert === 't');
    }

    // The phone's default spot when he never dragged the orb: just above the
    // typing row, on the left where no button lives. The CSS spot (76 px up)
    // sat on the key area, which is ~120 px tall: it covered TOOLS and ENT.
    function phoneDefaultPos(viewH, rowTop) {
        if (!rowTop || !viewH) return null;
        return { side: 'l', vert: 'b', x: 12, y: Math.max(12, viewH - rowTop + 10) };
    }
    function placePhoneDefault(d) {
        if (document.body.classList.contains('pc-mode')) return;
        const row = document.getElementById('prompt');
        const card = row && row.closest('.card');
        const r = card && card.getBoundingClientRect();
        const p = phoneDefaultPos(window.innerHeight, r && r.height ? r.top : null);
        if (p) placeDock(d, p);
    }

    function makeMovable(d, orb) {
        let pos = null;
        try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch { pos = null; }
        if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') placeDock(d, pos);
        else {
            pos = null;
            // Not saved: a default is recomputed, never remembered as his choice.
            placePhoneDefault(d);
            setTimeout(() => { if (!pos) placePhoneDefault(d); }, 1500);
            window.addEventListener('resize', () => { if (!pos) placePhoneDefault(d); });
        }

        let drag = null, moved = false;
        orb.addEventListener('pointerdown', e => {
            if (e.button) return;
            const r = orb.getBoundingClientRect();
            drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
            moved = false;
        });
        orb.addEventListener('pointermove', e => {
            if (!drag || e.pointerId !== drag.id) return;
            if (!moved) {
                if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < DRAG_PX) return;
                moved = true;
                orb.setPointerCapture(drag.id);
                d.classList.add('asst-dragging');
            }
            const w = orb.offsetWidth, h = orb.offsetHeight;
            const left = e.clientX - drag.dx, top = e.clientY - drag.dy;
            const side = left + w / 2 < window.innerWidth / 2 ? 'l' : 'r';
            const vert = top + h / 2 < window.innerHeight / 2 ? 't' : 'b';
            pos = {
                side, vert,
                x: side === 'l' ? left : window.innerWidth - left - w,
                y: vert === 't' ? top : window.innerHeight - top - h,
            };
            placeDock(d, pos);
        });
        const end = e => {
            if (!drag || e.pointerId !== drag.id) return;
            drag = null;
            d.classList.remove('asst-dragging');
            // On a phone the panel is as wide as the screen, so an orb parked
            // mid-screen would push it off the side: it settles on the edge.
            if (moved && pos && window.innerWidth <= 700) { pos.x = 12; placeDock(d, pos); }
            if (moved && pos) { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* private window */ } }
        };
        orb.addEventListener('pointerup', end);
        orb.addEventListener('pointercancel', end);
        // The click that ends a drag must not also start a conversation.
        orb.addEventListener('click', e => {
            if (!moved) return;
            moved = false;
            e.stopPropagation();
            e.preventDefault();
        }, true);
        window.addEventListener('resize', () => { if (pos) placeDock(d, pos); });
    }

    function stateOf() {
        if (talk.thinking) return { cls: 'think', glyph: '[~]', label: 'thinking' };
        if (playing()) return { cls: 'speak', glyph: '[)]', label: 'speaking' };
        if (talk.listening) return { cls: 'listen', glyph: '[o]', label: 'listening' };
        if (talk.on && CFG.walkie) return { cls: 'ready', glyph: '[>]', label: 'tap to talk' };
        if (talk.on) return { cls: 'ready', glyph: '[o]', label: 'ready' };
        return { cls: '', glyph: '[·]', label: 'off' };
    }

    // The target: what it is pointed at, and a list to change it.
    //
    // This was a native <select>. On a phone that is an OS sheet in the OS's own
    // blue, and on desktop a grey listbox — the one thing in TSRCT that did not
    // look like TSRCT. It is now a row that opens a list drawn in the palette,
    // and choosing is QUIET: the chosen row lights up and that is the whole
    // feedback. It used to announce itself in the log, which read like a
    // commitment for something that is only "look over there".
    function renderTarget() {
        if (!talk.picking) {
            return `
                <button class="asst-target" data-act="asst-pick" title="Which session it is pointed at">
                    <span class="asst-target-k">${talk.session ? (talk.watch ? 'watching' : 'attached') : 'talking'}</span>
                    <span class="asst-target-v ${talk.session ? '' : 'none'}">${esc(talk.session || 'no session')}</span>
                    <span class="asst-target-c">[v]</span>
                </button>`;
        }
        const row = (value, label, extra) => `
            <button class="asst-opt ${value === talk.session ? 'sel' : ''}" data-act="asst-choose" data-session="${esc(value)}">
                <span class="asst-opt-m">${value === talk.session ? '>' : ' '}</span>
                <span class="asst-opt-n">${esc(label)}</span>
                ${extra || ''}
            </button>`;
        return `
            <div class="asst-pick">
                <div class="asst-pick-h">
                    <span>point it at</span>
                    <span class="asst-gap"></span>
                    <button class="asst-btn tiny" data-act="asst-pick">[x]</button>
                </div>
                <div class="asst-pick-l">
                    ${row('', 'no session - just talk')}
                    ${talk.sessions.map(sn => row(sn, sn, sn === talk.home ? '<span class="asst-opt-t">on screen</span>' : '')).join('')}
                </div>
            </div>`;
    }

    function renderPanel() {
        const gate = CFG.gate && CFG.gate();
        if (gate) return gate;
        const log = talk.lines.slice(-14).map(l => {
            const who = l.who === 'you' ? 'you'
                : l.who === 'sent' ? '-->'
                    : l.who === 'watch' ? (talk.session || 'session') : talk.name.toLowerCase();
            return `<div class="asst-line ${esc(l.who)}"><span class="asst-who">${esc(who)}</span><span class="asst-text">${esc(l.text)}</span></div>`;
        }).join('');
        // The three switches, as switches: a name, what it does in his words, and
        // a state you can read without hovering anything. Three identical buttons
        // in a row said nothing about which were on.
        const sw = (act, on, label, what, cls) => `
            <button class="asst-sw ${on ? 'on' : ''} ${cls || ''}" data-act="${act}">
                <span class="asst-sw-d">${on ? '[#]' : '[ ]'}</span>
                <span class="asst-sw-b"><span class="asst-sw-n">${label}</span><span class="asst-sw-w">${what}</span></span>
            </button>`;
        return `
            <div class="asst-head">
                <span class="asst-name">${esc(talk.name.toUpperCase())}</span>
                <span class="asst-sub">${esc(stateOf().label)}${talk.warm ? '' : (talk.on ? ' - waking up' : '')}</span>
                <span class="asst-gap"></span>
                ${CFG.headExtra ? CFG.headExtra() : ''}
                ${playing() ? '<button class="asst-btn" data-act="asst-hush" title="Stop talking - the conversation stays on">[shh]</button>' : ''}
                <button class="asst-btn" data-act="asst-end" title="Turn it off and give the memory back">[off]</button>
                <button class="asst-btn" data-act="asst-collapse" title="Fold the panel - the conversation stays on">[-]</button>
            </div>
            ${talk.why ? `<div class="asst-why">${esc(talk.why)}</div>` : ''}
            ${renderTarget()}
            <div class="asst-sws">
                ${sw('asst-relay', talk.toClaude, talk.toClaude ? 'typing into the session' : 'side by side', talk.toClaude ? 'what you say is sent as a prompt' : 'it listens, the session hears nothing', 'relay')}
                ${sw('asst-watch', talk.watch, 'watch', 'tell me when it finishes')}
                ${sw('asst-live', talk.live, 'live', 'and while it works')}
            </div>
            ${renderJobs()}
            <div class="asst-log">${log || '<div class="asst-dim">say something, or type it below</div>'}</div>
            ${talk.files.length ? `<div class="asst-files">${talk.files.map((f, i) => `
                <span class="asst-file"><span>${/\.(png|jpe?g|gif|webp)$/i.test(f.name) ? '[img]' : '[file]'} ${esc(f.name)}</span>
                <button class="asst-btn tiny" data-act="asst-unfile" data-i="${i}" title="Remove">[x]</button></span>`).join('')}</div>` : ''}
            <div class="asst-row">
                <button class="asst-btn" data-act="asst-attach" title="Attach screenshots or files - they go with the next thing you say">[+]</button>
                <input class="asst-in" type="text" value="${esc(talk.draft || '')}" data-act="asst-input"
                    placeholder="${micSupported() ? 'or type it here' : 'no microphone in this browser - type it'}">
                <button class="asst-btn" data-act="asst-send" ${talk.thinking ? 'disabled' : ''}>[&gt;]</button>
                ${micSupported() ? `<button class="asst-btn ${talk.listening ? 'on' : ''}" data-act="asst-mic">${talk.listening ? '[#]' : '[o]'}</button>` : ''}
            </div>
            <div class="asst-foot">"${esc(talk.name.toLowerCase())}, ..." talks only to me · "${esc(talk.name.toLowerCase())}, terminamos" ends it${CFG.footExtra ? CFG.footExtra() : ''}</div>`;
    }

    // ── background work ─────────────────────────────────────────────────────
    // 2026-09-24: a prompt Opus finished in two minutes never reached him and
    // nothing on screen said so. Each job is one row: the model it chose, what
    // it is for, the clock, and either its last step or where the result went.
    function clock(ms) {
        const s = Math.max(0, Math.round((ms || 0) / 1000));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    const JOB_DONE = { sent: 'sent to the session', drafted: 'in your input box', ready: 'ready - ask for "el ultimo prompt"',
        failed: 'failed', refused: 'dropped (SecretCo)', starting: 'opening the session', started: 'session open and working', done: 'done' };
    function renderJobs() {
        if (!talk.jobs.length) return '';
        const rows = talk.jobs.map(j => {
            const run = j.state === 'running';
            const what = j.what === 'workaround' ? `no button: ${j.goal || ''}` : j.what === 'task' ? `task${j.files ? ` · ${j.files} file${j.files === 1 ? '' : 's'}` : ''}` : `prompt${j.session ? ` for ${j.session}` : ''}`;
            const where = j.plan ? `${j.plan.isNew ? 'new folder ' : ''}${j.plan.project} · session ${j.plan.session}` : '';
            const detail = run
                ? `${j.step || 'starting'}${j.steps ? ` · ${j.steps} step${j.steps === 1 ? '' : 's'}` : ''}`
                : j.what === 'workaround' ? `${j.state === 'done' ? 'done' : 'failed'}${j.summary ? ` - ${j.summary}` : ''}${j.error ? ` - ${j.error}` : ''}`
                : j.state === 'waiting' ? `waiting for your yes: ${where}${j.error ? ` - ${j.error}` : ''}`
                    : `${JOB_DONE[j.state] || j.state}${where ? ` · ${where}` : ''}${j.error ? ` - ${j.error}` : ''}`;
            const buttons = j.state === 'waiting' ? `<span class="asst-job-b">
                    <button class="asst-btn tiny" data-act="asst-job-start" data-key="${esc(j.key)}" title="Open the session there with this prompt">[open]</button>
                    <button class="asst-btn tiny" data-act="asst-job-drop" data-key="${esc(j.key)}" title="Drop this plan">[x]</button>
                </span>` : '';
            return `<div class="asst-job ${run ? 'run' : esc(j.state)}" title="${esc(j.goal)}">
                    <span class="asst-job-m">[${esc(j.model || '?')}]</span>
                    <span class="asst-job-w">${esc(what)}</span>
                    <span class="asst-job-c">${run ? clock(j.elapsedMs) : 'done ' + clock(j.elapsedMs)}</span>
                    <span class="asst-job-d">${esc(detail)}</span>
                    ${j.plan && j.plan.why ? `<span class="asst-job-d why">${esc(j.plan.why)}</span>` : ''}
                    ${buttons}
                </div>`;
        }).join('');
        return `<div class="asst-jobs"><div class="asst-jobs-h">in the background</div>${rows}</div>`;
    }

    // While the conversation is OFF the orb still checks on background work,
    // slowly: a result is shown (and toasted) even when nobody is talking. In a
    // conversation, tick() carries the same list and says the line out loud.
    const BG_POLL_MS = 12000;
    function startBgPoll() { if (!bgPoll) bgPoll = setInterval(() => { bgTick().catch(() => {}); }, BG_POLL_MS); }
    async function bgTick() {
        if (talk.on) return;                       // tick() has it
        if (CFG.canPoll && !CFG.canPoll()) return;
        const r = await fetch(api(`/talk/jobs?since=${talk.since}`), { headers: authHeaders() });
        if (refused(r)) return;
        const d = await r.json().catch(() => null);
        if (!d) return;
        const before = JSON.stringify(talk.jobs);
        talk.jobs = Array.isArray(d.jobs) ? d.jobs : [];
        let shown = false;
        // The first look only sets the mark: lines from before this page loaded
        // were already pushed to his phone, and a toast storm on reload helps nobody.
        const first = !talk.since;
        if (Array.isArray(d.say) && !first) {
            for (const item of d.say) {
                talk.since = Math.max(talk.since, item.id);
                push('it', item.text);
                toast(item.text, 'info');
                talk.caption = { who: talk.name.toLowerCase(), text: item.text };
                holdCaption();
                shown = true;
            }
        }
        if (!talk.since && d.seq) talk.since = d.seq;
        if (shown || before !== JSON.stringify(talk.jobs)) render();
    }

    // A subtitle, not a status bar: it says the last thing out loud in full
    // contrast, then disappears. Tapping it opens the panel.
    function renderCaption() {
        const c = talk.caption;
        if (!c) return '';
        return `<div class="asst-cap-who">${esc(c.who)}</div>
            <div class="asst-cap-text">${esc(c.shown !== undefined ? c.shown : c.text)}</div>`;
    }

    // Write it out at the speed it is being said. The reveal is linear over the
    // clip's real duration, so the last word lands with the last sound — near
    // enough that it reads as lip-sync, with none of the machinery that real
    // word timings would need.
    // A subtitle is ONE LINE, replaced by the next — never a paragraph filling
    // up. Lines break between words, and early at a full stop or a comma when
    // the line is already mostly full, so a line ends where a breath would.
    function captionLines(text) {
        const max = window.innerWidth <= 700 ? 30 : 44;
        const lines = [];
        let cur = '';
        for (const w of String(text).split(/\s+/).filter(Boolean)) {
            if (cur && (cur.length + 1 + w.length > max)) { lines.push(cur); cur = w; }
            else cur = cur ? cur + ' ' + w : w;
            if (cur.length >= max * 0.6 && /[.,;:!?]$/.test(w)) { lines.push(cur); cur = ''; }
        }
        if (cur) lines.push(cur);
        // [{ text, from }] — `from` is where the line starts in the running count
        let at = 0;
        return lines.map(l => { const o = { text: l, from: at }; at += l.length; return o; });
    }

    function typeCaption(who, text, seconds) {
        const lines = captionLines(text);
        const chars = lines.reduce((n, l) => n + l.text.length, 0) || 1;
        talk.caption = { who, text, shown: '', typing: true };
        render();
        const total = Math.max(0.4, seconds || text.length / 14);
        const t0 = (window.performance || Date).now();
        if (typeTimer) clearInterval(typeTimer);
        typeTimer = setInterval(() => {
            if (!talk.caption) { clearInterval(typeTimer); typeTimer = null; return; }
            const p = Math.min(1, (((window.performance || Date).now()) - t0) / (total * 1000));
            const c = Math.round(p * chars);
            let line = lines[0] || { text: '', from: 0 };
            for (const l of lines) { if (l.from < c || c === 0) line = l; else break; }
            talk.caption.shown = line.text.slice(0, Math.max(0, c - line.from));
            // One text node, not a re-render: this runs twenty times a second.
            const node = document.querySelector('#asst-cap .asst-cap-text');
            if (node) node.textContent = talk.caption.shown;
            if (p >= 1) {
                clearInterval(typeTimer); typeTimer = null;
                talk.caption.typing = false;
                render();
            }
        }, 50);
    }

    // It stays readable for a moment after the voice stops, then goes.
    function holdCaption() {
        if (captionTimer) clearTimeout(captionTimer);
        const check = () => {
            // Never pull the subtitle while the voice is still on it.
            if (playing() || (talk.caption && talk.caption.typing)) { captionTimer = setTimeout(check, 800); return; }
            talk.caption = null;
            render();
        };
        captionTimer = setTimeout(check, 4500);
    }

    // No voice (TTS down, browser fallback): the subtitle still runs, paced by
    // a reading speed instead of by a clip that does not exist.
    function sayWithCaption(who, text, voice) {
        speaking++;
        try { if (rec) rec.abort(); } catch (e) {}
        rec = null;
        talk.listening = false;
        const s0 = Date.now();
        const v = lastVoice = { started: s0, ttsMs: null, audioMs: null, fallback: false };
        return say(text, voice || '', (dur) => { v.ttsMs = Date.now() - s0; v.audioMs = dur * 1000; typeCaption(who, text, dur); })
            .catch(async (e) => {
                v.fallback = true;
                logEvent('tts-failed', e && e.message);
                typeCaption(who, text, null);
                await waitForOther();
                return browserSpeak(text);
            })
            // The room is still ringing for a moment after the clip ends, and a
            // phone's recogniser is quick enough to catch the tail.
            .then(() => new Promise((resolve) => setTimeout(resolve, 350)))
            .finally(() => { speaking = Math.max(0, speaking - 1); voiceEndAt = Date.now(); micBackMs = null; holdCaption(); });
    }

    function render() {
        const d = dock();
        const orb = d.querySelector('#asst-orb');
        const cap = d.querySelector('#asst-cap');
        const panel = d.querySelector('#asst-panel');
        const st = stateOf();
        if (orb) {
            orb.textContent = st.glyph;
            orb.className = `asst-orb ${st.cls}`;
            orb.title = talk.on ? `${talk.name}: ${st.label}` : `Talk to ${talk.name}`;
            // Background work shows ON the orb, panel open or not: the model and the clock.
            const running = talk.jobs.find(j => j.state === 'running');
            orb.classList.toggle('bg', !!running);
            if (running) {
                orb.dataset.bg = `${running.model || '...'} ${clock(running.elapsedMs)}`;
                orb.title += ` - ${running.model || 'a model'} is writing a prompt${running.session ? ` for ${running.session}` : ''}`;
            } else delete orb.dataset.bg;
        }
        // The caption exists only when there is something to show, and never
        // while the panel is open (the panel already has the whole log).
        const showCap = !!talk.caption && !talk.expanded;
        cap.classList.toggle('hidden', !showCap);
        cap.className = `asst-cap ${showCap ? '' : 'hidden'} ${st.cls} ${talk.caption && talk.caption.typing ? 'typing' : ''}`.replace(/\s+/g, ' ').trim();
        if (showCap) cap.innerHTML = renderCaption();
        panel.classList.toggle('hidden', !talk.expanded);
        if (talk.expanded) {
            // Keep the caret: a poll every three and a half seconds must not
            // take the sentence he is typing with it.
            // A field the app's gate drew (a pair code) is never redrawn under his thumb.
            if (panel.contains(document.activeElement) && document.activeElement.matches('[data-keep]')) return;
            const typing = panel.contains(document.activeElement)
                && document.activeElement.matches('[data-act="asst-input"]');
            // Where he was in the log. The panel is redrawn on every poll, and
            // it used to jump to the bottom each time - reading an older line
            // was impossible (2026-09-24: "el scroll del chat se sigue
            // scrolleando hacia abajo"). Follow the bottom only if he was there.
            const oldLog = panel.querySelector('.asst-log');
            const keep = oldLog ? { top: oldLog.scrollTop, atBottom: oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40 } : null;
            panel.innerHTML = renderPanel();
            if (typing) {
                const box = panel.querySelector('[data-act="asst-input"]');
                if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
            }
            const log = panel.querySelector('.asst-log');
            if (log) log.scrollTop = (!keep || keep.atBottom) ? log.scrollHeight : keep.top;
        }
    }

    // A reason is about the last thing that happened, not a permanent label: it
    // sat in the panel long after the attempt it belonged to.
    let whyTimer = null;
    function setWhy(text) {
        talk.why = text || '';
        if (whyTimer) { clearTimeout(whyTimer); whyTimer = null; }
        if (talk.why) whyTimer = setTimeout(() => { talk.why = ''; render(); }, 12000);
    }

    function push(who, text) {
        talk.lines.push({ who, text });
        if (talk.lines.length > 40) talk.lines = talk.lines.slice(-40);
    }

    // ── the conversation ─────────────────────────────────────────────────────
    let sessionsAt = 0;
    async function loadSessions() {
        sessionsAt = Date.now();
        try {
            const r = await fetch(api('/sessions'), { headers: authHeaders() });
            if (refused(r)) return;
            const d = await r.json().catch(() => ({}));
            const list = Array.isArray(d) ? d : (d.sessions || []);
            talk.sessions = list.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean);
            if (typeof window.getCurrentTargetSession === 'function') {
                const cur = window.getCurrentTargetSession();
                talk.home = (cur && talk.sessions.includes(cur)) ? cur : '';
                if (!talk.session && talk.home) talk.session = talk.home;
            }
        } catch (e) { /* the picker just offers "no session" */ }
    }

    async function start(opts) {
        // Not allowed to talk yet (Ghost Runner, not paired): show why instead.
        if (CFG.gate && CFG.gate()) { talk.expanded = true; render(); return; }
        logEvent('start', '', { light: !!(opts && opts.light), session: talk.session || '' });
        setWhy('');
        talk.on = true;
        talk.queue = [];
        render();
        await loadSessions();
        const ask = (light) => fetch(api('/talk/open'), {
            method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ session: talk.session, watch: talk.watch, toClaude: talk.toClaude, live: talk.live, light }),
        }).then(r => (refused(r) ? { ok: false, why: 'not allowed' } : r.json().catch(() => ({}))));
        try {
            let d = await ask(!!(opts && opts.light));
            // The model being off, or the card being busy, used to mean no
            // assistant at all. It does not any more: the parser understands
            // him, the buttons press themselves and Piper speaks on the CPU, so
            // it opens anyway and says what it cannot do. Only what genuinely
            // needs the model is missing, and that is said when he asks for it.
            if (!d.ok && !(opts && opts.light)) {
                const half = await ask(true);
                if (half.ok) { d = half; setWhy('the local model is off - I can still hear you, press things and read to you'); }
            }
            if (!d.ok) {
                talk.on = false;
                setWhy(shortWhy(d.why) || 'the local model would not open');
                render();
                return;
            }
            talk.warm = !!d.warm;
            if (d.session !== undefined) talk.session = d.session || '';
            if (d.name) talk.name = d.name;
            // Join at the END of what has been said. Starting from zero made a
            // phone that joined a running conversation read out the last twenty
            // narrations, one after another, about work he had watched happen.
            talk.since = 0;
            try {
                const s0 = await (await fetch(api('/talk/status?since=0'), { headers: authHeaders() })).json();
                talk.since = (s0 && s0.seq) || 0;
            } catch (e) { /* nothing spooled yet is the common case */ }
            startPoll();
            // His pocket: the screen stops sleeping, and a silent loop keeps the
            // page from being frozen when he switches apps.
            holdScreen();
            keepAwake();
            listen();
        } catch (e) {
            talk.on = false;
            setWhy(shortWhy(e.message));
        }
        render();
    }

    // `why` is logged (2026-10-05): a conversation closed mid-sentence twice and
    // the log could not say who closed it.
    async function stop(why) {
        logEvent('stop', why || '', { session: talk.session || '', why: why || 'unknown' });
        recWanted = false;
        if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
        heard = '';
        try { if (rec) rec.abort(); } catch (e) {}
        rec = null;
        talk.on = false;
        talk.listening = false;
        talk.thinking = false;
        talk.queue = [];
        talk.caption = null;
        if (captionTimer) { clearTimeout(captionTimer); captionTimer = null; }
        if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
        stopPoll();
        stopSpeaking();
        dropScreen();
        letSleep();
        render();
        try {
            await fetch(api('/talk/close'), {
                method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ reason: 'orb' }), keepalive: true,
            });
        } catch (e) { /* the server's idle timer closes it anyway */ }
    }

    // ── staying alive in his pocket ─────────────────────────────────────────
    // Two different problems with two different answers.
    //
    //   THE SCREEN GOING DARK while TSRCT is in front: a Wake Lock. It is
    //   released by the browser on every tab switch, so it is re-taken on
    //   visibilitychange rather than requested once.
    //
    //   THE PAGE BEING FROZEN when he switches apps: Android does not freeze a
    //   page that is PLAYING MEDIA. So while the assistant is on, a silent loop
    //   plays, the page keeps polling, and the narrations keep arriving with the
    //   screen off. It shows up as a media notification, like a podcast — which
    //   is also what puts the headset button in reach: MediaSession routes it
    //   here instead of to Spotify.
    //
    // What this does NOT do is let it HEAR him with the screen off: browser
    // speech recognition stops when the page is hidden and no API gets it back.
    // The button press is what is left, and it is enough for the two things he
    // asked for from his pocket: shut up, and say that again.
    let wake = null;
    let silent = null;

    async function holdScreen() {
        if (!talk.on || document.visibilityState !== 'visible') return;
        if (wake || !navigator.wakeLock) return;
        try {
            wake = await navigator.wakeLock.request('screen');
            wake.addEventListener('release', () => { wake = null; });
        } catch (e) { wake = null; }      // denied, or no battery for it
    }
    function dropScreen() {
        try { if (wake) wake.release(); } catch (e) {}
        wake = null;
    }

    // One second of silence, looped. Tiny enough to inline, and it has to be
    // real audio: a muted element does not count as playing.
    const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
    function keepAwake() {
        if (!talk.on || !CFG.silentLoop) return;
        if (!silent) {
            silent = new Audio(SILENCE);
            silent.loop = true;
            silent.volume = 0.02;         // inaudible, but not "muted"
        }
        // Started from his tap on the orb, which is the gesture that allows it.
        silent.play().catch(() => {});
        if (!('mediaSession' in navigator)) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: talk.name || 'Tesla',
                artist: talk.session ? `mirando ${talk.session}` : 'TSRCT',
                album: 'TSRCT',
            });
            navigator.mediaSession.playbackState = 'playing';
            // The headset button arrives as pause (it thinks something is
            // playing). It is not a pause: it is "be quiet".
            const quiet = () => { hush(); try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {} };
            navigator.mediaSession.setActionHandler('pause', quiet);
            navigator.mediaSession.setActionHandler('play', () => { try { silent.play(); } catch (e) {} });
            navigator.mediaSession.setActionHandler('nexttrack', repeatLast);
            navigator.mediaSession.setActionHandler('previoustrack', repeatLast);
            navigator.mediaSession.setActionHandler('stop', () => { stop('phone media stop'); });
        } catch (e) { /* an older browser: the silent loop still works */ }
    }
    function letSleep() {
        try { if (silent) { silent.pause(); silent.currentTime = 0; } } catch (e) {}
        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.playbackState = 'none';
                for (const a of ['pause', 'play', 'nexttrack', 'previoustrack', 'stop']) navigator.mediaSession.setActionHandler(a, null);
            } catch (e) {}
        }
    }

    // Two presses on the headset: say the last thing again. It costs no model
    // turn — it is the sentence he already has.
    function repeatLast() {
        const last = [...talk.lines].reverse().find(x => x.who !== 'you');
        if (!last || !last.text) return;
        logEvent('repeat', last.text);
        talk.queue.push({ id: 0, text: last.text, voice: null, kind: 'repeat', at: Date.now() });
        drain();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') holdScreen();
    });

    // "Be quiet": cuts the sentence in the air and drops whatever was queued
    // behind it. The conversation stays on — this is not stop().
    function hush() {
        // Cutting it off mid-sentence is the clearest "too long / not that" there is.
        if (playing() || talk.queue.length) logEvent('hush', talk.caption && talk.caption.text);
        hushGen++;
        talk.queue = [];
        stopSpeaking();
        talk.caption = null;
        if (captionTimer) { clearTimeout(captionTimer); captionTimer = null; }
        if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
        render();
    }

    function startPoll() { stopPoll(); poll = setInterval(() => { tick().catch(() => {}); }, POLL_MS); }
    function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

    // One poll at a time (Tesla review #3): on a 3.5 s timer, a slow answer left
    // two polls in flight with the same `since`, both queued the same narration,
    // and he heard it three times in a row (2026-10-07 00:50, hushed it).
    let ticking = false;
    let offlineSince = 0;
    async function tick() {
        if (!talk.on) { stopPoll(); return; }
        if (ticking) return;
        ticking = true;
        try {
            await tickOnce();
            if (offlineSince) { offlineSince = 0; setWhy(''); render(); }
        } catch (e) {
            // No signal (the runner app on a run): say it once, keep trying.
            if (CFG.offlineWhy && !offlineSince) { offlineSince = Date.now(); setWhy(CFG.offlineWhy); render(); }
        } finally { ticking = false; }
    }
    async function tickOnce() {
        const r = await fetch(api(`/talk/status?since=${talk.since}`), { headers: authHeaders() });
        if (refused(r)) return;
        const d = await r.json().catch(() => ({}));
        if (!d) return;
        // Only he ends a conversation (END, or "tesla, terminamos"). The server
        // lets go by itself in one case: no TSRCT window polled for a long while.
        // Say which, instead of looking alive.
        if (!d.open && talk.on) {
            talk.on = false;
            setWhy(d.closedReason === 'nobody'
                ? 'closed: no TSRCT window was open for a while, so the graphics card was freed'
                : 'conversation ended');
            recWanted = false;
            try { if (rec) rec.abort(); } catch (e) {}
            rec = null;
            stopPoll();
            render();
            return;
        }
        if (d.error) {
            const short = shortWhy(d.error);
            if (short !== talk.why) { console.warn('[assistant]', d.error); setWhy(short); }
        }
        // Whatever the server says about the attachment WINS: an SecretCo screen
        // detaches the session mid-conversation, and a panel that goes on
        // showing the session it no longer has is a panel that lies.
        let changed = false;
        // Not for a few seconds after he changed something here: this answer may
        // have left the server before his change arrived.
        const fresh = Date.now() - attachAt < 5000;
        const sync = (k, v) => { if (!fresh && v !== undefined && talk[k] !== v) { talk[k] = v; changed = true; } };
        // A session opened a minute ago has to be in the picker.
        if (Date.now() - sessionsAt > 20000) { sessionsAt = Date.now(); loadSessions().then(() => { if (talk.expanded) render(); }).catch(() => {}); }
        sync('session', d.session === undefined ? undefined : (d.session || ''));
        sync('watch', d.watch === undefined ? undefined : !!d.watch);
        sync('toClaude', d.toClaude === undefined ? undefined : !!d.toClaude);
        sync('live', d.live === undefined ? undefined : !!d.live);
        sync('warm', d.warm === undefined ? undefined : !!d.warm);
        press(d.do);
        if (Array.isArray(d.jobs) && JSON.stringify(d.jobs) !== JSON.stringify(talk.jobs)) { talk.jobs = d.jobs; changed = true; }
        if (Array.isArray(d.say) && d.say.length) {
            for (const item of d.say) {
                // Already queued or spoken: never twice.
                if (item.id <= talk.since) continue;
                talk.since = item.id;
                talk.queue.push(item);
            }
            drain();
        } else if (changed) {
            render();
        }
    }

    // ── the buttons it was asked to press ───────────────────────────────────
    // The server queues a press; this runs it through src/js/ui-actions.js,
    // which has its own allowlist, and reports back what happened. A press that
    // fails is reported honestly — the assistant has already said "listo", so
    // the server turns a failure into a spoken correction.
    const pressed = new Set();
    function press(list) {
        if (!Array.isArray(list) || !list.length || !window.UIActions) return;
        for (const item of list) {
            if (!item || pressed.has(item.id)) continue;
            pressed.add(item.id);
            if (pressed.size > 50) pressed.clear();
            const r = window.UIActions.run(item.fn, item.args || {});
            if (!r.ok) console.warn('[assistant] no pude apretar', item.fn, r.why);
            fetch(api('/talk/did'), {
                method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ id: item.id, ok: !!r.ok, why: r.why || '' }),
            }).catch(() => {});
        }
    }

    // ── never over him (2026-10-05) ─────────────────────────────────────────
    // "when i'm dictating a prompt i get interrupted and my prompt is just lost",
    // and "when i'm about to respond to that confirmation i get interrupted by
    // another thing that happened in the session". A narration was spoken the
    // moment it arrived: drain() aborted the microphone, and with no interim
    // results the phrase he was in the middle of was never final, so it vanished
    // without even a 'dropped' row (the log showed none). And a narration landing
    // between its "si o no?" and his answer made the session update the last
    // thing on the table. Now its own lines WAIT while he is talking (a phrase in
    // progress, words not sent yet, or a word in the last 1.5 s) and while it is
    // waiting for the answer to a question it asked him (up to ASK_HOLD_MS).
    // Its answers to him are not held - he asked for those.
    const ASK_HOLD_MS = 30000;
    let voiceAt = 0;             // last time a phrase of his finished
    let speechOn = false;        // Chrome says speech started and has not ended
    let speechAt = 0;
    let awaitUntil = 0;          // it asked him something; hold its own lines until then
    let held = '';               // his words that arrived while it could not take them
    let drainTimer = null;
    // 2026-10-14: "progress updates from Tesla never interrupt Leon while he is
    // speaking". Two microphones count: hers, and his prompt dictation (the MIC in
    // his input, desktop or phone) - she used to talk straight into a prompt he was
    // dictating, and the dictation wrote her words into it. Her updates wait until
    // he has been quiet for SILENCE_MS on both. A permission request (`urgent`,
    // set by the server) is the exception: a session stopped on a card is waiting
    // on him, so it is said at once.
    // <hold-rule>
    const SILENCE_MS = 2000;
    function holdLine(item, s) {
        if (item && item.urgent) return false;
        if (s.talking || s.pauseOn || String(s.heard || '').trim()) return true;
        if (s.dictating || s.now - (s.dictAt || 0) < SILENCE_MS) return true;
        return s.now - (s.voiceAt || 0) < SILENCE_MS || s.now < (s.awaitUntil || 0);
    }
    // </hold-rule>
    // His prompt dictation, seen from here. Remembered when it was last on, so
    // the silence after it is counted from the moment he turned it off.
    let dictAt = 0;
    function dictating() {
        let on = false;
        try {
            on = CFG.dictating ? !!CFG.dictating()
                : !!((window.Desktop && window.Desktop.voice && (window.Desktop.voice.wantRecording || window.Desktop.voice.isRecording))
                    || document.querySelector('#mic-btn.recording, #pc-mic-btn.recording, #pc-expand-mic-btn.recording'));
        } catch (e) { on = false; }
        if (on) dictAt = Date.now();
        return on;
    }
    function holdState() {
        const now = Date.now();
        // Speech "on" with nothing new for 8 s is room noise or a missed end
        // event, not him: stop holding.
        return { now, talking: speechOn && now - speechAt < 8000, pauseOn: !!pauseTimer, heard,
            voiceAt, awaitUntil, dictating: dictating(), dictAt };
    }
    // After it speaks: his held words first, then the next line, then the mic.
    function resume() {
        if (held && talk.on && !talk.thinking && !playing()) {
            const s = held; held = '';
            ask(s, 'voice');
            return;
        }
        if (talk.queue.length) setTimeout(drain, 200);
        else if (recWanted && talk.on) setTimeout(listen, 400);
    }

    // One voice at a time, and never while the microphone is up.
    async function drain() {
        if (!talk.on || !talk.queue.length) return;
        if (talk.thinking || playing()) return;
        // The first line allowed to speak now: everything when he is quiet, only
        // a permission request while he talks or dictates (it jumps the queue).
        const s = holdState();
        const at = otherSpeaking() ? -1 : talk.queue.findIndex(x => !holdLine(x, s));
        if (at < 0) {
            if (!drainTimer) drainTimer = setTimeout(() => { drainTimer = null; drain(); }, 600);
            return;
        }
        const item = talk.queue.splice(at, 1)[0];
        try { if (rec) rec.abort(); } catch (e) {}
        rec = null;
        talk.listening = false;
        const mine = item.kind === 'bg';           // background work speaks as the assistant, not as the session
        push(mine ? 'it' : 'watch', item.text);
        const d0 = Date.now();
        try {
            await sayWithCaption(mine ? talk.name.toLowerCase() : (talk.session || 'session'), item.text, item.voice);
            const v = lastVoice && lastVoice.started >= d0 ? lastVoice : null;
            // queuedMs uses the server's clock for item.at: exact on this laptop, approximate on the phone.
            logEvent('narration-timing', item.text.slice(0, 120), { id: item.id || 0, kind: item.kind || '', queuedMs: item.at ? d0 - item.at : undefined,
                ttsMs: v && v.ttsMs !== null ? v.ttsMs : undefined, audioMs: v && v.audioMs !== null ? v.audioMs : undefined, voiceFallback: v ? v.fallback : undefined });
        }
        finally {
            render();
            resume();
        }
    }

    // A MIRROR of his prompt input's dictation (desktop.js pcInitSpeechRecognition
    // + pcExpandedOnResult), setting for setting - 2026-09-24: "asegurate de que
    // funcione exactamente igual que el dictador que uso en mi input normal".
    // Same: continuous, NO interim results, his input's language (the ES/EN
    // button), the last result only when final, lowercased and trimmed, appended
    // with one space, into a box he can SEE; and when Chrome ends a session, the
    // same instance is restarted at once. Different, on purpose, and only two:
    // it sends by itself after PAUSE_MS without a new phrase (his input waits for
    // SEND), and a no-speech timeout does not switch it off - a conversation
    // stays open.
    const PAUSE_MS = 2500;
    // A bare answer to a question it just asked ("si", "dale", "yes please") is
    // complete the moment it is said (Tesla review #4: "si por favor" waited the
    // whole 2.5 s pause and then took 0.8 s to run - a felt 4-6 s for one word).
    // Only while it is waiting for that answer, and only for a few words.
    const SHORT_PAUSE_MS = 1000;
    const SHORT_ANSWER = /^(s[ií]|no|dale|ok|okay|yes|yeah|yep|sure|nope|listo|perfecto|hacelo|h[aá]galo|mand[aá]selo|mandalo|de una|claro)\b/i;
    // A sentence that stops on a word no sentence ends on is not finished: he is
    // thinking, and 2.5 s sent "okay le puedes pedir hasta" half-said (2026-10-08
    // 22:52; he said it all again five minutes later). It waits longer.
    const LONG_PAUSE_MS = 4500;
    const DANGLING = /(^|\s)(hasta|que|de|del|a|al|para|con|y|o|e|el|la|los|las|lo|un|una|unos|unas|en|por|porque|pero|si|como|cuando|donde|le|les|mi|tu|su|sobre|desde|entre|sin|mira|entonces|osea|the|to|and|of|for|with|that|an?|so|but|if|my|your|in|on|at)\s*$/i;
    function pauseFor(text) {
        const t = String(text || '').trim();
        if (Date.now() < awaitUntil && t.split(/\s+/).length <= 4 && SHORT_ANSWER.test(t)) return SHORT_PAUSE_MS;
        return DANGLING.test(t) ? LONG_PAUSE_MS : PAUSE_MS;
    }
    let heard = '';
    let pauseTimer = null;
    let recLang = '';
    const inputLang = () => (CFG.lang && CFG.lang()) || (window.Desktop && window.Desktop.voice && window.Desktop.voice.lang) || window.TSRCT_LANG || 'es-ES';
    function showHeard() {
        talk.draft = heard.trim();
        const box = document.querySelector('#asst-panel [data-act="asst-input"]');
        if (box) box.value = talk.draft;
    }
    const WALKIE_IDLE_MS = 8000;
    let walkieTimer = null;
    function clearWalkie() { if (walkieTimer) { clearTimeout(walkieTimer); walkieTimer = null; } }
    function closeMic(why) {
        clearWalkie();
        recWanted = false;
        try { if (rec) rec.abort(); } catch (e) {}
        rec = null;
        talk.listening = false;
        logEvent('mic-closed', why || '');
        render();
    }
    function listen() {
        if (!talk.on || !micSupported()) return;
        if (rec || talk.thinking || playing()) return;
        recWanted = true;
        heard = '';
        recLang = inputLang();
        const me = window.createSpeechRecognizer({
            continuous: true,
            // OFF, like his input. It was turned on for one night (2026-10-05)
            // to tell he was mid-phrase, and on the phone Chrome repeated every
            // phrase ("hola hola hola ya sos hola ya sos mas"). Speech start/end
            // events below do that job without touching the text.
            interimResults: false,
            lang: recLang,
            onStart: () => {
                talk.listening = true;
                if (voiceEndAt && micBackMs === null) micBackMs = Date.now() - voiceEndAt;
                render();
            },
            onEnd: () => {
                talk.listening = false;
                // Like his input: the same instance, restarted at once - unless
                // it was put down, or his ES/EN button changed the language.
                if (rec === me && recWanted && talk.on && !talk.thinking && !playing() && recLang === inputLang()) {
                    try { me.start(); return; } catch (e) { /* fall through to a fresh one */ }
                }
                if (rec === me) rec = null;
                render();
                if (recWanted && talk.on && !talk.thinking && !playing()) setTimeout(listen, 100);
            },
            onError: (e) => {
                talk.listening = false;
                if (e && e.error && e.error !== 'no-speech' && e.error !== 'aborted') {
                    logEvent('mic-error', e.error);
                    setWhy(e.error === 'not-allowed' ? 'the browser blocked the microphone - allow it for this site'
                        : e.error === 'network' ? 'voice needs an internet connection' : `microphone: ${e.error}`);
                    if (e.error === 'not-allowed') recWanted = false;
                }
                render();
            },
            onResult: (ev) => {
                // Anything heard while it was talking is its own voice - or him
                // talking over it, which is why it is logged before being dropped.
                const result = ev.results[ev.results.length - 1];
                // The other voice on the page (a kilometre call) heard back is not
                // him; his own words over it are (Tesla review #8: a whole sentence
                // said over a kilometre call was thrown away).
                const heardNow = result && result.isFinal ? result[0].transcript.trim() : '';
                let otherEcho = false;
                if (heardNow && otherSpeaking()) {
                    try { otherEcho = !CFG.otherVoice.isEcho || !!CFG.otherVoice.isEcho(heardNow); } catch (e) { otherEcho = true; }
                }
                if (playing() || otherEcho) {
                    if (heardNow) logEvent('dropped', heardNow, { why: playing() ? 'heard while it was speaking' : 'the other voice heard back' });
                    return;
                }
                if (!result || !result.isFinal) return;
                const text = result[0].transcript.toLowerCase().trim();
                if (!text) return;
                const now = Date.now();
                voiceAt = now;
                speechAt = now;              // still talking: in continuous mode Chrome sends speechstart only once
                if (!tm.first) tm.first = now;
                tm.last = now;
                tm.phrases++;
                logEvent('phrase', text, { n: tm.phrases, msSinceFirst: now - tm.first, confidence: Math.round((result[0].confidence || 0) * 100) });
                clearWalkie();
                if (heard && !heard.endsWith(' ')) heard += ' ';
                heard += text;
                showHeard();
                // Every phrase restarts the wait; he is done after a real pause.
                if (pauseTimer) clearTimeout(pauseTimer);
                pauseTimer = setTimeout(() => {
                    pauseTimer = null;
                    const said = heard.trim();
                    heard = '';
                    if (!said) return;
                    talk.draft = '';
                    // Something is speaking after all (an answer it owed him):
                    // KEEP his words and send them the moment it finishes.
                    if (playing()) { held = held ? `${held} ${said}` : said; logEvent('held', said, { why: 'it was speaking when he paused' }); return; }
                    ask(said, 'voice');
                }, pauseFor(heard));
            },
        });
        rec = me;
        if (!rec) return;
        // Walkie: a tap and then nothing is not a reason to hold his music down.
        clearWalkie();
        if (CFG.walkie) walkieTimer = setTimeout(() => {
            walkieTimer = null;
            if (rec === me && !heard && !pauseTimer && !talk.thinking) closeMic('nothing said');
        }, WALKIE_IDLE_MS);
        // "He is mid-phrase", without interim results: Chrome's own speech
        // start/end events. Text is untouched; these only hold narrations.
        me.onspeechstart = () => { if (!playing()) { speechOn = true; speechAt = Date.now(); } };
        me.onspeechend = () => { speechOn = false; voiceAt = Date.now(); };
        try { rec.start(); } catch (e) { rec = null; }
    }

    async function ask(text, via) {
        if (!text) return;
        // Still working on the last one: keep it and send it right after,
        // instead of losing it (it used to be dropped here).
        if (talk.thinking) { held = held ? `${held} ${text}` : text; logEvent('held', text, { why: 'still answering the last one' }); return; }
        awaitUntil = 0;          // he answered: its own lines may speak again
        // Walkie: this sentence was the one the tap was for; the mic stays down
        // after the answer, and his music comes back up.
        if (CFG.walkie) { recWanted = false; clearWalkie(); }
        // His half of the clock, taken now and reset for the next sentence.
        const sentAt = Date.now();
        const heardAt = { ...tm, herLast: voiceEndAt, micBack: micBackMs };
        tm.first = tm.last = tm.phrases = 0;
        let replyAt = 0, turnId = '', serverMs = null, okTurn = false;
        const timing = () => {
            const spoke = via === 'voice' && heardAt.first;
            const v = lastVoice && lastVoice.started >= sentAt ? lastVoice : null;
            logEvent('timing', text.slice(0, 120), {
                turnId, via: via || 'voice', ok: okTurn, phrases: heardAt.phrases,
                speakMs: spoke ? heardAt.last - heardAt.first : undefined,
                pauseMs: spoke ? sentAt - heardAt.last : undefined,
                sinceItsLastWordMs: spoke && heardAt.herLast ? heardAt.first - heardAt.herLast : undefined,
                micBackMs: heardAt.micBack === null ? undefined : heardAt.micBack,
                roundTripMs: replyAt ? replyAt - sentAt : Date.now() - sentAt,
                serverMs: serverMs === null ? undefined : serverMs,
                ttsMs: v && v.ttsMs !== null ? v.ttsMs : undefined,
                audioMs: v && v.audioMs !== null ? v.audioMs : undefined,
                voiceFallback: v ? v.fallback : undefined,
                // The wait he actually sits through: last word out of his mouth -> first word of the answer.
                feltWaitMs: spoke && v && v.ttsMs !== null ? (replyAt - heardAt.last) + v.ttsMs : undefined,
            });
        };
        try { if (rec) rec.abort(); } catch (e) {}
        rec = null;
        talk.listening = false;
        talk.thinking = true;
        setWhy('');
        push('you', text);
        render();
        try {
            const r = await fetch(api('/talk/ask'), {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                // `where`: a view he is inside can say so (the VR headset sets
                // body[data-tesla-where="vr"], src/js/remote-desktop.js), and the
                // brain reads "abri..." as his PC there (lib/haikuBrain.js).
                body: JSON.stringify({ text, via: via || 'voice', session: talk.session, toClaude: talk.toClaude, files: talk.files.map(f => f.path),
                    where: (document.body && document.body.dataset.teslaWhere) || '' }),
            });
            if (refused(r)) return;
            // They went with this sentence; the next one starts clean.
            if (r.ok && talk.files.length) talk.files = [];
            const d = await r.json().catch(() => ({}));
            replyAt = Date.now(); turnId = d.turnId || ''; serverMs = typeof d.ms === 'number' ? d.ms : null; okTurn = !!(d.ok && d.reply);
            // A button rides back on the answer, so it is pressed before the
            // sentence about it has finished being spoken.
            press(d.do);
            // That line was for someone else (Tesla review #6): nothing is said.
            if (d.ok && d.silent) { push('it', '(not for me - kept quiet)'); timing(); return; }
            if (!d.ok || !d.reply) {
                setWhy(shortWhy(d.why) || `HTTP ${r.status}`);
                push('it', `(${talk.why})`);
                typeCaption(talk.name.toLowerCase(), talk.why, null); holdCaption();
                timing();
                return;
            }
            talk.warm = true;
            // The one thing here with a side effect on his machine gets its own
            // line and its own colour. It went in silently once; that was once.
            if (d.sent) { push('sent', `typed into ${talk.session}`); toast(`sent to ${talk.session}`); }
            push('it', d.reply);
            talk.thinking = false;
            render();
            await sayWithCaption(talk.name.toLowerCase(), d.reply, d.voice);
            // It asked him something ("si o no?", "cual?"): the session's news
            // waits until he answers, or the question is buried under it.
            if (d.asking) awaitUntil = Date.now() + ASK_HOLD_MS;
            timing();
            // He said goodbye: the server already closed it and freed the card.
            if (d.ended) { recWanted = false; await stop('he said goodbye'); setWhy('conversation ended'); render(); return; }
        } catch (e) {
            setWhy(shortWhy(e.message));
            timing();
        } finally {
            talk.thinking = false;
            render();
            resume();
        }
    }

    // A choice in the panel takes effect NOW, and says so. It used to be unclear
    // when it did: the picker kept the focus, which froze the panel's redraw; a
    // status poll already in flight could put the old session back; and a
    // refusal from the server was never read, so the panel showed a session the
    // server had not taken.
    let attachAt = 0;
    async function attach(patch) {
        logEvent('switch', JSON.stringify(patch).slice(0, 200));
        const before = { session: talk.session, watch: talk.watch, toClaude: talk.toClaude, live: talk.live };
        Object.assign(talk, patch);
        attachAt = Date.now();
        render();
        if (!talk.on) return;           // off: it is sent when he starts it
        try {
            const r = await fetch(api('/talk/attach'), {
                method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ session: talk.session, watch: talk.watch, toClaude: talk.toClaude, live: talk.live }),
            });
            if (refused(r)) return;
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) {
                Object.assign(talk, before);
                setWhy(shortWhy(d.why || d.error) || 'that change was not taken');
            } else {
                // The server's answer is the truth, not what was asked for.
                talk.session = d.session || '';
                talk.watch = !!d.watch; talk.toClaude = !!d.toClaude; talk.live = !!d.live;
                setWhy('');
            }
        } catch (e) { Object.assign(talk, before); setWhy(shortWhy(e.message)); }
        attachAt = Date.now();
        render();
    }

    function sendDraft() {
        const box = document.querySelector('#asst-panel [data-act="asst-input"]');
        const text = ((box && box.value) || talk.draft || '').trim();
        if (!text) return;
        talk.draft = '';
        if (box) box.value = '';
        ask(text, 'typed');
    }

    // ── attachments ─────────────────────────────────────────────────────────
    // The same two upload routes his prompt input uses; the paths ride on the
    // next /api/talk/ask and the server keeps only files it stored itself.
    function b64(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(',')[1] || '');
            r.onerror = reject;
            r.readAsDataURL(file);
        });
    }
    function pickFiles() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = async () => {
            for (const file of Array.from(input.files || [])) {
                try {
                    const data = await b64(file);
                    const img = /^image\/(png|jpe?g|gif|webp)$/i.test(file.type);
                    const res = await fetch(api(img ? '/upload-image' : '/upload-file'), {
                        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify(img ? { image: data, format: file.type.split('/')[1] } : { data, filename: file.name }),
                    });
                    const d = await res.json().catch(() => ({}));
                    if (d.success && d.path) talk.files.push({ path: d.path, name: file.name || d.filename });
                    else toast(`could not attach ${file.name}`, 'error');
                } catch (e) { toast(`could not attach ${file.name}`, 'error'); }
            }
            if (talk.files.length > 10) talk.files = talk.files.slice(-10);
            render();
        };
        input.click();
    }

    // His tap on a waiting plan: [open] is the yes, [x] drops it.
    async function jobOp(key, op) {
        try {
            const r = await fetch(api('/talk/job'), {
                method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ key, op }),
            });
            const d = await r.json().catch(() => ({}));
            if (op === 'start') {
                if (d.ok) toast(`${d.session} is working in ${d.project}`, 'success');
                else { setWhy(shortWhy(d.error) || 'could not open it'); toast(`could not open it: ${d.error || r.status}`, 'error'); }
            }
        } catch (e) { setWhy(shortWhy(e.message)); }
        if (talk.on) tick().catch(() => {}); else bgTick().catch(() => {});
    }

    // ── events ───────────────────────────────────────────────────────────────
    function onClick(e) {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const act = el.dataset.act;
        if (CFG.onAct && CFG.onAct(act, el)) return;
        if (act === 'asst-toggle') {
            // Tapping the orb starts or ends the conversation; the panel is a
            // separate, smaller decision.
            // While it is talking the orb is the mute button — the one control
            // a thumb can find without reading anything.
            if (talk.on && (playing() || talk.queue.length)) { hush(); return; }
            // Walkie: the orb is the talk button. Tap = open the mic for one
            // sentence; tap again while it listens = never mind. The panel stays
            // shut so the run screen stays his.
            if (CFG.walkie) {
                if (!talk.on) { talk.expanded = false; start(); return; }
                if (talk.thinking) return;
                if (talk.listening || recWanted) closeMic('tapped off');
                else { recWanted = true; listen(); render(); }
                return;
            }
            if (talk.on) { talk.expanded = !talk.expanded; render(); }
            else { talk.expanded = true; start(); }
            return;
        }
        if (act === 'asst-expand') { talk.expanded = true; render(); return; }
        if (act === 'asst-pick') {
            talk.picking = !talk.picking;
            render();
            // The list is refreshed every 20s in the background; opening it must
            // not show a session that died or miss one that was just opened.
            if (talk.picking) loadSessions().then(() => { if (talk.picking) render(); }).catch(() => {});
            return;
        }
        if (act === 'asst-choose') {
            const next = el.dataset.session || '';
            talk.picking = false;
            // Changing session disarms the relay: what he armed for one session
            // is not permission for the next one.
            if (next !== talk.session) attach({ session: next, toClaude: false });
            else render();
            return;
        }
        if (act === 'asst-collapse') { talk.expanded = false; render(); return; }
        if (act === 'asst-attach') { pickFiles(); return; }
        if (act === 'asst-unfile') { talk.files.splice(Number(el.dataset.i), 1); render(); return; }
        if (act === 'asst-job-start' || act === 'asst-job-drop') { jobOp(el.dataset.key, act === 'asst-job-start' ? 'start' : 'drop'); return; }
        if (act === 'asst-hush') { hush(); return; }
        if (act === 'asst-end') { stop('end button'); talk.expanded = false; return; }
        if (act === 'asst-send') { sendDraft(); return; }
        if (act === 'asst-mic') {
            if (talk.listening || recWanted) {
                recWanted = false;
                try { if (rec) rec.abort(); } catch (err) {}
                rec = null; talk.listening = false; render();
            } else listen();
            return;
        }
        if (act === 'asst-relay') {
            // Arming this types what he says into a live session, so it asks —
            // once, per conversation. The pair moves together: side by side
            // without live is a conversation about a session that never speaks.
            const on = !talk.toClaude;
            if (on && !window.confirm(`Everything you say will be TYPED INTO ${talk.session || 'the selected session'} as a prompt.\n\nArm it?`)) return;
            attach({ toClaude: on, live: !on ? true : talk.live });
            return;
        }
        if (act === 'asst-watch') { attach({ watch: !talk.watch }); return; }
        if (act === 'asst-live') { attach({ live: !talk.live }); return; }
    }

    function onChange() { /* nothing changes without a click any more */ }

    function onInput(e) {
        const el = e.target.closest && e.target.closest('[data-act="asst-input"]');
        if (el) talk.draft = el.value;
    }

    function onKeydown(e) {
        const el = e.target.closest && e.target.closest('[data-act="asst-input"]');
        if (!el) return;
        e.stopPropagation();                       // never reach the terminal's keymap
        if (e.key === 'Escape') { el.blur(); return; }
        if (e.key === 'Enter') { e.preventDefault(); sendDraft(); }
    }

    // The lock screen came up (relock, logout): the conversation ends and the
    // microphone goes down. It kept listening under the lock before (2026-09-24).
    (function endOnLock() {
        const lock = document.getElementById('auth');
        if (!lock || typeof MutationObserver !== 'function') return;
        new MutationObserver(() => {
            if (!lock.classList.contains('hidden') && talk.on) stop('lock screen');
        }).observe(lock, { attributes: true, attributeFilter: ['class'] });
    })();

    // A tab that goes away without saying goodbye would pin the model.
    window.addEventListener('pagehide', () => {
        if (!talk.on) return;
        stopPoll();
        try {
            fetch(api('/talk/close'), {
                method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ reason: 'pagehide' }), keepalive: true,
            });
        } catch (e) {}
    });

    // If the server is already in a conversation (another window, or this one
    // reloaded), the orb joins it rather than starting a second one.
    async function adopt() {
        if (CFG.canPoll && !CFG.canPoll()) { render(); return; }
        try {
            const r = await fetch(api('/talk/status?since=0'), { headers: authHeaders() });
            if (refused(r)) return;
            const d = await r.json().catch(() => ({}));
            if (d && d.name) talk.name = d.name;
            if (d && d.open) {
                talk.on = true;
                talk.session = d.session || '';
                talk.watch = !!d.watch;
                talk.toClaude = !!d.toClaude;
                talk.live = !!d.live;
                talk.warm = !!d.warm;
                talk.since = d.seq || 0;
                await loadSessions();
                startPoll();
            }
        } catch (e) { /* offline: the orb still works, it just starts cold */ }
        render();
    }

    function boot() { dock(); render(); adopt(); startBgPoll(); bgTick().catch(() => {}); }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    // The other voice on the page waits for this one (Ghost Runner lib/voice.js).
    window.TeslaVoice = { speaking: () => playing(), repeat: repeatLast, hush };

    // Everything stops on THIS page, without telling the server (a refused
    // re-pair: the server would refuse the close too).
    function halt(why) {
        recWanted = false;
        if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
        heard = '';
        try { if (rec) rec.abort(); } catch (e) {}
        rec = null;
        talk.on = false; talk.listening = false; talk.thinking = false; talk.queue = [];
        talk.caption = null;
        stopPoll(); stopSpeaking(); dropScreen(); letSleep();
        if (why) setWhy(why);
        talk.expanded = true;
        render();
    }

    window.Assistant = {
        start, stop, ask, attach, render, adopt, halt, setWhy,
        toggle: () => (talk.on ? stop('toggle') : start()),
        open: () => { talk.expanded = true; render(); },
        state: () => ({ ...talk }),
    };
})();
