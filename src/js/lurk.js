/* ============================================================================
   LURK mode — NULL's visual identity (leonlurk content surface)
   STRANGE ATTRACTOR: NULL is not a face — it's a living mathematical organism.
   An Aizawa attractor (a 3D chaotic vortex-knot) rendered as a glowing navy/cyan
   point-cloud that slowly rotates + breathes, with a bright "consciousness"
   tracer flying along the trajectory. It is audio-reactive (the whole organism
   flares, spins faster + expands with NULL's voice, FFT-driven) AND
   EXPRESSION-driven: when NULL is LIVE (Qwen) it emits a mood per reply
   (⟦mood:X⟧, parsed server-side → {reply,emote}) that reshapes the attractor
   (deadpan = slow/tight/cold · roast = fast/expanded/violent · etc).
   Why an attractor (per the Producer Brain): it's complex + thumb-stopping
   (Musformation #27) yet has a SIGNATURE, repeatable silhouette you can freeze
   as NULL's logo/pfp (Musformation #5/#18), and reads as a distinct living mind
   — NULL's own "world" (Damian Keyes #9). The irony is the brand: a beautiful
   cold equation that holds you in contempt (Musformation #4).
   Works on the desktop tab panel (#pc-lurk-body) and the mobile room overlay
   (#lurk-room). One instance at a time. IIFE + window.* like the rest.
   ============================================================================ */
(function () {
    'use strict';

    const CYAN = '#46e0ff';

    // ── expression presets (NULL's moods) ────────────────────────────────
    // spin: base rotation speed · scale: overall size (contempt pulls in) ·
    // bright: glow intensity · turb: organic turbulence/writhe · spike: how hard
    // it flares outward on the audio beat · sink: vertical droop (bored/contempt)
    const EXPR = {
        deadpan:   { spin: 0.12, scale: 1.00, bright: 0.55, turb: 0.15, spike: 0.0, sink: 0.00 },
        contempt:  { spin: 0.05, scale: 0.80, bright: 0.42, turb: 0.10, spike: 0.0, sink: 0.05 },
        roast:     { spin: 0.55, scale: 1.20, bright: 1.00, turb: 0.60, spike: 1.0, sink: -0.03 },
        bored:     { spin: 0.03, scale: 0.90, bright: 0.32, turb: 0.06, spike: 0.0, sink: 0.09 },
        intrigued: { spin: 0.32, scale: 1.14, bright: 0.92, turb: 0.22, spike: 0.0, sink: -0.04 },
        glitch:    { spin: 0.22, scale: 1.02, bright: 0.88, turb: 0.35, spike: 0.35, sink: 0.00 },
        // contemplative registers — for the introspective/deep speeches (slow,
        // expansive, glowing swells, no aggression). NULL's nihilist depth, not warmth.
        somber:    { spin: 0.04, scale: 1.05, bright: 0.40, turb: 0.08, spike: 0.0, sink: 0.05 },
        awe:       { spin: 0.10, scale: 1.28, bright: 1.05, turb: 0.12, spike: 0.0, sink: -0.05 }
    };
    const lerpExpr = (a, b, k) => {
        const o = {}; for (const key in a) o[key] = a[key] + (b[key] - a[key]) * k; return o;
    };

    // Integrate the Aizawa attractor once → a fixed cloud of ~3200 points in
    // model space (centred, normalised to ~unit radius), kept IN TRAJECTORY
    // ORDER so the render loop can fly a bright tracer along the same curve.
    // This is NULL's body: a chaotic 3D vortex-knot. The render loop rotates,
    // projects, breathes + flares it; it never changes shape (that's what makes
    // it a recognisable identity, not noise).
    function buildAttractor() {
        const a = 0.95, b = 0.7, c = 0.6, d = 3.5, e = 0.25, f = 0.1, dt = 0.01;
        let x = 0.1, y = 0, z = 0;
        const STEPS = 8000, SKIP = 800;   // SKIP = discard the transient in-spiral
        const raw = [];
        for (let i = 0; i < STEPS + SKIP; i++) {
            const dx = (z - b) * x - d * y;
            const dy = d * x + (z - b) * y;
            const dz = c + a * z - (z * z * z) / 3 - (x * x + y * y) * (1 + e * z) + f * z * x * x * x;
            x += dx * dt; y += dy * dt; z += dz * dt;
            if (i >= SKIP) raw.push([x, y, z]);
        }
        // centre on the centroid, scale by the max component so it fits ~[-1,1]
        let mx = 0, my = 0, mz = 0;
        for (const p of raw) { mx += p[0]; my += p[1]; mz += p[2]; }
        const nP = raw.length; mx /= nP; my /= nP; mz /= nP;
        let mr = 1e-6;
        for (const p of raw) {
            const m = Math.max(Math.abs(p[0] - mx), Math.abs(p[1] - my), Math.abs(p[2] - mz));
            if (m > mr) mr = m;
        }
        const s = 1 / mr;
        // subsample to a perf-friendly count, preserving order for the tracer
        const target = 3200, step = Math.max(1, Math.floor(nP / target));
        const pts = [];
        for (let i = 0; i < nP; i += step) {
            const p = raw[i];
            pts.push({ x: (p[0] - mx) * s, y: (p[1] - my) * s, z: (p[2] - mz) * s, seed: Math.random() * 1000 });
        }
        return pts;
    }

    // ── module state ─────────────────────────────────────────────────────
    let S = null;
    let lang = 'es';
    let liveMode = false;

    function authHeaders() {
        const t = (typeof token !== 'undefined' && token) ? token : (window.token || '');
        return { 'Authorization': t };
    }

    function template() {
        return `
        <div class="lurk-root">
          <div class="lurk-stage">
            <canvas class="lurk-canvas"></canvas>
            <div class="lurk-count"></div>
            <div class="lurk-say"></div>
            <div class="lurk-hud"><span class="lurk-dot"></span>NULL · <span class="lurk-state">idle</span></div>
            <button class="lurk-full" title="pantalla completa interactiva">⛶</button>
            <div class="lurk-hint">drag to rotate · scroll = zoom · shift+drag = move · double-click = reset</div>
            <div class="lurk-moods" role="group" aria-label="mood de NULL"></div>
            <button class="lurk-mute" title="M — mute NULL (cuts off what it is saying)">MUTE</button>
          </div>
          <div class="lurk-controls">
            <textarea class="lurk-input" rows="2" placeholder="pegá el texto que NULL va a decir…"></textarea>
            <div class="lurk-row">
              <button class="lurk-btn lurk-speak" title="escuchar/previsualizar (sin grabar)">▶ SPEAK</button>
              <button class="lurk-btn lurk-rec" title="REC: clears the screen, counts down, and NULL says the text with subtitles. No text = clean screen only. ESC to exit">● REC</button>
              <button class="lurk-btn lurk-delay" title="countdown before recording (to start your screen capture)">⏱ 3s</button>
              <button class="lurk-btn lurk-lang">${lang.toUpperCase()}</button>
              <button class="lurk-btn lurk-live" title="hablar con la IA real (Qwen)">◉ LIVE</button>
              <button class="lurk-btn lurk-react" title="NULL reacts live to what you play in LABS (another window/monitor)">◎ REACT</button>
              <button class="lurk-btn lurk-power" title="engine on/off — holds VRAM while ON (does not turn off when you leave the tab)">⏻</button>
            </div>
          </div>
        </div>`;
    }

    // ── expression control ───────────────────────────────────────────────
    // intensity (0..1) is a continuous dial ON TOP of the mood preset: it scales
    // turbulence / beat-spike / glitch-scatter / glow, so "roast:0.95" is far more
    // violent than "roast:0.4", and a mood can BUILD across a spoken response.
    function setExpression(mood, intensity) {
        if (!S) return;
        S.exprTarget = EXPR[mood] || EXPR.deadpan;
        if (typeof intensity === 'number') S.intensityTarget = Math.max(0, Math.min(1, intensity));
        if (mood === 'glitch') S.scatter = 0.6 + S.intensityTarget * 0.7;
    }
    // set the mood (+ intensity) AND sync the expression deck's active button
    function setExpressionUI(mood, intensity) {
        setExpression(mood, intensity == null ? 0.6 : intensity);
        if (S && S.els.moods) for (const b of S.els.moods.children) b.classList.toggle('on', b.dataset.m === mood);
    }

    // ── camera / direct manipulation (drag = rotate · scroll = zoom · pan) ─
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    function resetView() { if (!S) return; S.orbitYaw = 0; S.orbitPitch = 0; S.zoom = 1; S.panX = 0; S.panY = 0; }
    function setupInteraction() {
        const cv = S.canvas, pts = S.pointers;
        cv.style.touchAction = 'none';
        const hideHint = () => S.els.hint && S.els.hint.classList.add('gone');
        cv.addEventListener('pointerdown', (e) => {
            try { cv.setPointerCapture(e.pointerId); } catch (_) { }
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: (e.button === 2 || e.shiftKey) });
            hideHint();
            if (pts.size === 2) { const [a, b] = [...pts.values()]; S.pinchDist = Math.hypot(a.x - b.x, a.y - b.y); }
        });
        cv.addEventListener('pointermove', (e) => {
            const prev = pts.get(e.pointerId); if (!prev) return;
            const nx = e.clientX, ny = e.clientY;
            if (pts.size >= 2) {                                   // two fingers → pinch-zoom
                prev.x = nx; prev.y = ny;
                const [a, b] = [...pts.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                if (S.pinchDist) S.zoom = clamp(S.zoom * (d / S.pinchDist), 0.4, 6);
                S.pinchDist = d; return;
            }
            const dx = nx - prev.x, dy = ny - prev.y;
            if (prev.pan) { S.panX += dx; S.panY += dy; }          // shift/right-drag → move
            else { S.orbitYaw += dx * 0.008; S.orbitPitch = clamp(S.orbitPitch + dy * 0.008, -1.3, 1.3); } // drag → rotate
            prev.x = nx; prev.y = ny;
        });
        const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) S.pinchDist = 0; };
        cv.addEventListener('pointerup', up);
        cv.addEventListener('pointercancel', up);
        cv.addEventListener('wheel', (e) => { e.preventDefault(); S.zoom = clamp(S.zoom * (1 - e.deltaY * 0.0012), 0.4, 6); }, { passive: false });
        cv.addEventListener('dblclick', resetView);
        cv.addEventListener('contextmenu', (e) => e.preventDefault());   // free up right-drag for pan
    }
    function toggleFull() {
        const stage = S.els.stage;
        if (!document.fullscreenElement) stage.requestFullscreen && stage.requestFullscreen().catch(() => { });
        else document.exitFullscreen && document.exitFullscreen().catch(() => { });
    }

    // ── audio ────────────────────────────────────────────────────────────
    function getActx() {
        if (!S.actx) {
            S.actx = new (window.AudioContext || window.webkitAudioContext)();
            S.analyser = S.actx.createAnalyser();
            S.analyser.fftSize = 256;
            S.analyser.smoothingTimeConstant = 0.72;
            S.freq = new Uint8Array(S.analyser.frequencyBinCount);
            S.analyser.connect(S.actx.destination);
        }
        if (S.actx.state === 'suspended') S.actx.resume();
        return S.actx;
    }
    // play one WAV blob, resolving when it FINISHES (so beats can be chained).
    // If `text` is given, the subtitle types out IN SYNC with this clip's length.
    function playBlob(blob, text) {
        return new Promise(async (resolve, reject) => {
            try {
                const ctx = getActx();
                const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
                if (S.muted) return resolve();
                const src = ctx.createBufferSource();
                src.buffer = buf; src.connect(S.analyser);
                S.playing = true; S.src = src; setState('speaking');
                if (text) typeSynced(text, buf.duration * 1000);
                src.onended = () => { if (S && S.src === src) S.src = null; resolve(); };
                src.start();
            } catch (e) { reject(e); }
        });
    }
    async function ttsBlob(text) {
        const r = await fetch('/api/null/tts', {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, lang })
        });
        if (!r.ok) throw new Error('tts ' + r.status);
        return r.blob();
    }
    async function chatReply(text) {
        const r = await fetch('/api/null/chat', {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        if (!r.ok) throw new Error('chat ' + r.status);
        return await r.json();   // { reply, emote, beats:[{text,mood,intensity}] }
    }

    function say(text) {
        const el = S.els.say; if (!el) return;
        el.textContent = ''; el.classList.add('on');
        let i = 0; clearInterval(S.typer);
        S.typer = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(S.typer); }, 28);
    }
    // type `text` into the subtitle over `durMs` so it lands in time with the voice
    function typeSynced(text, durMs) {
        const el = S.els.say; if (!el) return;
        clearInterval(S.typer);
        el.classList.add('on'); el.textContent = '';
        const n = text.length; if (!n) return;
        const step = Math.max(16, (durMs || n * 45) / n);
        let i = 0;
        S.typer = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= n) clearInterval(S.typer); }, step);
    }
    function clearSay() { if (S.els.say) { clearInterval(S.typer); S.els.say.textContent = ''; S.els.say.classList.remove('on'); } }
    function setState(s) { if (S.els.state) S.els.state.textContent = s; }
    function busy(on) { if (S.els.speak) { S.els.speak.disabled = on; S.els.speak.textContent = on ? '…' : '▶ SPEAK'; } }

    // Split text into ordered emotion beats by inline ⟦mood⟧ / ⟦mood:intensity⟧
    // markers. Used for BOTH live replies (the AI emits markers) and scripted
    // input (Leon can write markers into a speech). No markers → one beat.
    function parseBeats(text) {
        const re = /⟦\s*(\w+)\s*(?::\s*([0-9]*\.?[0-9]+))?\s*⟧/g;
        const beats = [];
        const push = (seg, mood, inten) => { seg = seg.trim(); if (seg) beats.push({ text: seg, mood, intensity: inten }); };
        const matches = []; let m;
        while ((m = re.exec(text)) !== null) matches.push(m);
        if (!matches.length) { const t = text.trim(); return t ? [{ text: t, mood: (S && S.manualMood) || 'deadpan', intensity: 0.6 }] : []; }
        push(text.slice(0, matches[0].index), 'deadpan', 0.6);   // any lead text
        for (let i = 0; i < matches.length; i++) {
            let mood = matches[i][1].toLowerCase();
            if (!EXPR[mood]) mood = 'deadpan';
            const inten = matches[i][2] != null ? Math.max(0, Math.min(1, parseFloat(matches[i][2]))) : 0.6;
            const segEnd = i + 1 < matches.length ? matches[i + 1].index : text.length;
            push(text.slice(matches[i].index + matches[i][0].length, segEnd), mood, inten);
        }
        return beats;
    }

    // Play an emotion track: TTS every beat (prefetched in parallel — the daemon
    // serialises them on its GPU lock and returns in order), then play in sequence,
    // switching NULL's face to each beat's mood+intensity right as its audio starts.
    async function playBeats(beats) {
        if (!beats || !beats.length || S.muted) return;
        const gen = S.gen;
        const blobs = beats.map(b => ttsBlob(b.text).catch(() => null));
        for (let i = 0; i < beats.length; i++) {
            if (!S || S.gen !== gen || S.muted) return;
            setExpressionUI(beats[i].mood, beats[i].intensity);
            const blob = await blobs[i];
            if (!S || S.gen !== gen || S.muted) return;
            if (blob) { try { await playBlob(blob, beats[i].text); } catch (e) { say(beats[i].text); } }  // subtitle syncs per beat (fallback: still show it)
            else say(beats[i].text);                                                                       // no audio → just show it
        }
        S.playing = false; S.lastSpokeEnd = performance.now(); setState(S.react ? 'listening to labs' : 'idle');
    }

    // ── MUTE: cut NULL mid-sentence (the on-camera gesture) ──────────────
    // Stops the clip that is sounding, drops every beat still queued (the
    // generation counter makes in-flight TTS/chat results land nowhere) and holds
    // NULL silent until unmuted. Unmuting is itself an event NULL can react to.
    function toggleMute(force) {
        if (!S) return;
        const on = typeof force === 'boolean' ? force : !S.muted;
        if (on === S.muted) return;
        S.muted = on; S.gen++;
        if (on) {
            try { S.src && S.src.stop(); } catch (e) { }
            S.src = null; S.playing = false; S.mutedAt = performance.now();
            clearSay(); setState('muted'); setExpressionUI('bored', 0.15);
        } else {
            setState(S.react ? 'listening to labs' : 'idle'); setExpressionUI('contempt', 0.5);
            const secs = Math.round((performance.now() - (S.mutedAt || performance.now())) / 1000);
            if (S.react) queueReaction('Leon TE silenció a VOS, NULL, durante ' + secs + ' segundos y recién te devolvió la voz');
        }
        S.container.querySelector('.lurk-root')?.classList.toggle('muted', on);
        if (S.els.mute) S.els.mute.textContent = on ? 'MUTED' : 'MUTE';
    }

    // ── REACT: NULL listens to LABS (BroadcastChannel, other window) ─────
    // Gestures arrive as plain-Spanish sentences + a state line. They are batched
    // (a knob twist is one event, not forty), and NULL only speaks when it is not
    // muted, not already talking, and has been quiet a moment — so it comments on
    // what Leon did, instead of narrating every touch.
    const REACT_DEBOUNCE = 1600, REACT_GAP = 6500;
    function queueReaction(text, state) {
        if (!S || !S.react) return;
        S.rq.push(text); if (S.rq.length > 6) S.rq.shift();
        if (state) S.labState = state;
        clearTimeout(S.rqTimer);
        S.rqTimer = setTimeout(flushReactions, REACT_DEBOUNCE);
    }
    async function flushReactions() {
        if (!S || !S.react || !S.rq.length) return;
        const quietFor = performance.now() - (S.lastSpokeEnd || 0);
        if (S.muted || S.playing || S.reacting || quietFor < REACT_GAP) {
            clearTimeout(S.rqTimer);
            S.rqTimer = setTimeout(flushReactions, S.muted ? 1500 : Math.max(600, REACT_GAP - quietFor));
            return;
        }
        const events = S.rq.splice(0);
        // Measured 17-09 with the warm engine: without an explicit language line NULL
        // answered in ENGLISH (null.md mirrors the user's language and read the
        // bracketed context as neutral), and a stance given as "tu postura" came back
        // in all three replies. The stance is now optional, and the language is first.
        const prompt = 'Respondé SOLO en español rioplatense, con voseo. Nunca en inglés. '
            + '[EN VIVO. Leon está tocando Jano en LABS: ' + (S.labState || 'sin datos') + '. Lo último que hizo: ' + events.join('; ') + '.] '
            + 'Reaccioná a ESO que hizo, como NULL, mientras él sigue tocando. Una sola frase de máximo 14 palabras. '
            + 'Opiná del sonido, no describas botones. No repitas ideas que ya dijiste. '
            + 'Si viene al caso y todavía no lo dijiste, podés decir que el hi-hat sobra o que te duele no tener manos para tocar. Leon te ignora.';
        S.reacting = true; const gen = S.gen;
        setState('thinking'); setExpressionUI('intrigued', 0.6);
        try {
            const res = await chatReply(prompt);
            if (!S || S.gen !== gen || S.muted) return;
            const beats = (res.beats && res.beats.length) ? res.beats : parseBeats(res.reply || '');
            await playBeats(beats);
        } catch (e) {
            if (S) { setState('react: ' + e.message); }
        } finally {
            if (S) { S.reacting = false; S.lastSpokeEnd = performance.now(); if (S.rq.length) queueReaction(S.rq.pop()); }
        }
    }
    function toggleReact() {
        S.react = !S.react;
        S.els.react.classList.toggle('on', S.react);
        setState(S.react ? 'listening to labs' : 'idle');
        if (S.react && !S.engineOn) power();   // the brain has to be up to answer
    }

    async function onSpeak() {
        const text = (S.els.input.value || '').trim();
        if (!text) return;
        busy(true); clearSay();
        try {
            let beats;
            if (liveMode) {
                setState('thinking'); setExpressionUI('intrigued', 0.7);
                const res = await chatReply(text);
                const full = res.reply || '…';
                beats = (res.beats && res.beats.length) ? res.beats : parseBeats(full);
                S.els.input.value = '';
            } else {
                // scripted: honor inline ⟦mood⟧ markers if present, else the deck mood
                beats = parseBeats(text);
            }
            await playBeats(beats);   // the subtitle types in sync, beat by beat (markers stripped)
        } catch (e) {
            say('[ error: ' + e.message + ' — try turning the engine on ⏻ ]');
            S.playing = false; setState('idle');
        }
        busy(false);
    }

    async function power() {
        const on = !(S.engineOn);
        S.els.power.textContent = '…';
        try {
            const r = await fetch('/api/null/power', {
                method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ on })
            });
            const j = await r.json().catch(() => ({}));
            S.engineOn = on && (j.ok !== false);
            if (typeof toast === 'function') toast(S.engineOn ? 'NULL engine ON' : 'NULL engine OFF', S.engineOn ? 'success' : 'info');
        } catch (e) { }
        if (!S) return;   // tab was closed mid-power — the daemon still (un)loads server-side
        S.els.power.textContent = '⏻';
        S.container.querySelector('.lurk-root')?.classList.toggle('engine-on', !!S.engineOn);
    }

    // clean stage for capture: hide ALL chrome + go fullscreen (only NULL + subtitle show)
    function enterRecord(on) {
        document.body.classList.toggle('lurk-record', on);
        const stage = S.els.stage;
        if (on && stage.requestFullscreen && !document.fullscreenElement) stage.requestFullscreen().catch(() => { });
        else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => { });
    }
    // big pre-roll countdown in the clean stage; resolves when it hits zero
    function countdown(secs) {
        return new Promise(resolve => {
            const el = S.els.count;
            if (!el || !secs) { if (el) { el.classList.remove('on'); el.textContent = ''; } return resolve(); }
            let n = secs; el.textContent = n; el.classList.add('on');
            const iv = setInterval(() => {
                n--;
                if (n <= 0) { clearInterval(iv); el.classList.remove('on'); el.textContent = ''; resolve(); }
                else el.textContent = n;
            }, 1000);
        });
    }

    // REC: the one-tap record flow — clean the screen, count down (so you can
    // start your capture), then, IF there's a script, NULL speaks with the
    // subtitle typing in sync. No script → just a clean stage for B-roll.
    async function recTake() {
        if (S.taking) return;
        S.taking = true;
        enterRecord(true);
        clearSay();
        try {
            await countdown(S.recDelay);
            if ((S.els.input.value || '').trim()) await onSpeak();
        } finally { S.taking = false; }
        // stays clean so you keep filming; ESC exits back to the editor
    }
    function cycleDelay() {
        const opts = [0, 3, 5, 10];
        S.recDelay = opts[(opts.indexOf(S.recDelay) + 1) % opts.length];
        S.els.delay.textContent = '⏱ ' + S.recDelay + 's';
    }

    // ── render loop: the strange-attractor organism ──────────────────────
    function resizeCanvas() {
        if (!S || !S.canvas) return;
        // Grabando (= pantalla completa) el lienzo se dibuja a densidad 1. Esto es
        // Canvas-2D y su costo va por píxel: a densidad 1.5 en pantalla completa
        // son 2.25x los píxeles de la ventana y la animación se entrecorta. La
        // toma se filma del monitor con un teléfono, así que esa densidad extra
        // no llega al video.
        const dpr = document.body.classList.contains('lurk-record')
            ? 1 : (window.devicePixelRatio || 1);
        const w = S.canvas.clientWidth || 400, h = S.canvas.clientHeight || 400;
        S.canvas.width = Math.round(w * dpr); S.canvas.height = Math.round(h * dpr);
        S.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        S.cw = w; S.ch = h;
    }
    // rotate a model point by yaw (around Y) then tilt (around X), return
    // [screenX-factor, screenY-factor, depthZ ∈ ~[-1,1]] before scale/offset.
    function project(x, y, z, cyaw, syaw, ctil, stil) {
        const X = x * cyaw + z * syaw;
        let Z = -x * syaw + z * cyaw;
        const Y = y * ctil - Z * stil;
        Z = y * stil + Z * ctil;
        return [X, Y, Z];
    }
    function frame(now) {
        S.raf = requestAnimationFrame(frame);
        const g = S.ctx2d, w = S.cw, h = S.ch; if (!g || !w) return;
        const t = now / 1000;
        // Segundos transcurridos desde el cuadro anterior. Todo lo que se mueve va
        // por TIEMPO y no por cuadro: antes, si la animación bajaba a 20 cuadros
        // por segundo, NULL giraba a un tercio de velocidad, y al arreglar la
        // fluidez se aceleró de golpe. El tope de 0.05 evita un salto feo cuando
        // la pestaña vuelve del fondo.
        const dt = Math.min(0.05, (now - (S.lastNow || now)) / 1000);
        S.lastNow = now;
        g.clearRect(0, 0, w, h);

        // audio level — real when speaking, gentle idle "breath" otherwise
        let level;
        if (S.playing && S.analyser) {
            S.analyser.getByteFrequencyData(S.freq);
            let sum = 0; const n = Math.min(48, S.freq.length);
            for (let i = 0; i < n; i++) sum += S.freq[i];
            level = Math.min(1, (sum / n / 255) * 1.6);
        } else {
            level = 0.05 + 0.04 * (0.5 + 0.5 * Math.sin(t * 1.4));
        }

        // ease mood + intensity toward their targets; decay glitch scatter
        S.expr = lerpExpr(S.expr, S.exprTarget, 0.05);
        S.intensity += (S.intensityTarget - S.intensity) * 0.06;
        S.scatter *= 0.9;
        const ex = S.expr;
        const im = 0.5 + S.intensity;   // intensity multiplier (0.5→1.0 baseline … 1.0→1.5 violent)

        // Giro automático, dentro de la banda que el Post 1 dejó medida y escrita
        // en tools/null_drop_render/render_shots.js: 8.7 a 14.8 grados por segundo.
        // La fórmula anterior — (ex.spin + level*0.5)*0.016 por cuadro — es la que
        // ese mismo archivo señala como el error: llegaba a 29 grados/s y aceleraba
        // con cada golpe de voz. Ahora la voz mueve la velocidad DENTRO de la banda,
        // nunca fuera. Después se le suma la órbita del usuario.
        const SPIN_MIN = 0.152, SPIN_MAX = 0.258;      // rad/s = 8.7 y 14.8 grados/s
        const drive = clamp(ex.spin * 0.6 + level * 0.5, 0, 1);
        S.yaw += (SPIN_MIN + (SPIN_MAX - SPIN_MIN) * drive) * dt;
        const yaw = S.yaw + S.orbitYaw;
        const tilt = clamp(0.42 + 0.12 * Math.sin(t * 0.23) + S.orbitPitch, -1.45, 1.45);
        const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
        const ctil = Math.cos(tilt), stil = Math.sin(tilt);

        const cx = w / 2 + S.panX, cy = h / 2 + S.panY;
        const R = Math.min(w, h) * 0.30 * ex.scale * (1 + level * 0.18) * S.zoom;
        const bright = Math.min(1.5, ex.bright + level * 0.5 + (im - 1) * 0.3);
        const tb = ex.turb * (0.5 + level) * im;          // turbulence, scaled by intensity
        const spikeS = 1 + ex.spike * level * 0.45 * im;  // beat-driven expansion, scaled by intensity

        // ── the body: ~3200 additive cyan points forming the attractor ──
        g.globalCompositeOperation = 'lighter';
        g.shadowBlur = 0;
        g.fillStyle = CYAN;
        const pts = S.pts, N = pts.length;
        for (let i = 0; i < N; i++) {
            const p = pts[i];
            let x = p.x, y = p.y + ex.sink, z = p.z;
            if (tb > 0.001) {                             // organic writhe
                // Frecuencias del Post 1 (render_shots.js): 0.37 / 0.41 / 0.29.
                // Acá estaban en 1.1 / 1.3 / 0.9 — tres veces más rápido, que es
                // lo que hacía que el cuerpo se retorciera en vez de respirar.
                x += Math.sin(t * 0.37 + p.seed) * 0.035 * tb;
                y += Math.cos(t * 0.41 + p.seed * 1.7) * 0.035 * tb;
                z += Math.sin(t * 0.29 + p.seed * 0.5) * 0.035 * tb;
            }
            if (spikeS !== 1) { x *= spikeS; y *= spikeS; z *= spikeS; }
            if (S.scatter > 0.02) {                       // glitch shatter
                x += (Math.random() - 0.5) * 0.5 * S.scatter;
                y += (Math.random() - 0.5) * 0.5 * S.scatter;
            }
            const pr = project(x, y, z, cyaw, syaw, ctil, stil);
            const persp = 1 / (1.9 - pr[2] * 0.55);
            const sx = cx + pr[0] * R * persp, sy = cy + pr[1] * R * persp;
            const depth = (pr[2] + 1) * 0.5;              // 0 far … 1 near
            g.globalAlpha = (0.05 + 0.45 * depth) * (0.4 + bright * 0.55);
            const rad = (0.6 + 1.5 * depth) * (0.85 + bright * 0.35);
            g.fillRect(sx - rad * 0.5, sy - rad * 0.5, rad, rad);   // cheap, no per-point glow
        }

        // ── the "consciousness": a bright tracer flying along the curve ──
        // El punto que recorre la curva también va por tiempo. El Post 1 avanzaba
        // 3 puntos por cuadro a 30 cuadros = 90 puntos por segundo; acá avanzaba
        // hasta 9 por cuadro a 60 = 540, seis veces más rápido. Se acumula en
        // decimales para que a velocidad baja no se pierda en el redondeo.
        S.headF = (S.headF || 0) + 90 * (0.8 + level * 0.6) * dt;
        S.head = Math.floor(S.headF) % N;
        g.shadowColor = CYAN;
        const TRAIL = 54;
        for (let k = 0; k < TRAIL; k++) {
            const p = pts[(S.head - k + N) % N];
            const pr = project(p.x, p.y + ex.sink, p.z, cyaw, syaw, ctil, stil);
            const persp = 1 / (1.9 - pr[2] * 0.55);
            const sx = cx + pr[0] * R * persp, sy = cy + pr[1] * R * persp;
            const fA = 1 - k / TRAIL;
            const a = fA * fA * (0.55 + level * 0.45);
            const rad = 2.4 * fA + 0.6;
            // Halo por discos concéntricos en vez de shadowBlur. El desenfoque de
            // sombra de Canvas-2D se resuelve por software y su costo crece con el
            // área desenfocada; eran 54 desenfoques por cuadro, y a pantalla
            // completa es lo que entrecortaba la imagen. En modo aditivo tres
            // discos dan el mismo resplandor por una fracción del costo.
            g.globalAlpha = a * 0.10; g.beginPath(); g.arc(sx, sy, rad * 3.2, 0, 6.283); g.fill();
            g.globalAlpha = a * 0.22; g.beginPath(); g.arc(sx, sy, rad * 1.9, 0, 6.283); g.fill();
            g.globalAlpha = a; g.beginPath(); g.arc(sx, sy, rad, 0, 6.283); g.fill();
        }
        g.shadowBlur = 0;

        // ── soft core aura (holds the organism together as one glowing mass) ──
        // El degradado se recreaba en CADA cuadro y se rellenaba sobre un círculo
        // de 0.42 veces el lado corto — a pantalla completa, unos 450 px de radio
        // sesenta veces por segundo. Ahora se guarda y se reusa: se construye
        // centrado en el origen (así el caché no depende del paneo) y el radio se
        // redondea de a 8 px para que la respiración del audio no lo invalide.
        const AR = Math.max(8, Math.round(R * 1.4 / 8) * 8);
        if (S.auraKey !== AR) {
            const gr = g.createRadialGradient(0, 0, 0, 0, 0, AR);
            gr.addColorStop(0, CYAN); gr.addColorStop(1, 'transparent');
            S.aura = gr; S.auraKey = AR;
        }
        g.globalAlpha = 0.08 + level * 0.22;
        g.save(); g.translate(cx, cy);
        g.fillStyle = S.aura; g.beginPath(); g.arc(0, 0, AR, 0, 6.283); g.fill();
        g.restore();

        g.globalCompositeOperation = 'source-over';
        g.fillStyle = CYAN; g.globalAlpha = 1;
    }

    // ── mount / unmount ──────────────────────────────────────────────────
    function mount(container) {
        if (!container) return;
        unmount();
        // Theme the MOUNT, not the body: painting body.theme-navy here leaked the
        // navy palette into the whole app after the room closed, and since it was
        // never persisted a refresh dropped back to green -- which read as "the
        // theme doesn't save". The user's own NAVY toggle owns body.theme-navy.
        container.classList.add('theme-navy');
        container.innerHTML = template();
        const q = (s) => container.querySelector(s);
        const canvas = q('.lurk-canvas');
        S = {
            container, canvas, ctx2d: canvas.getContext('2d'),
            raf: 0, actx: null, analyser: null, freq: null, playing: false,
            pts: buildAttractor(), expr: { ...EXPR.deadpan }, exprTarget: { ...EXPR.deadpan },
            yaw: 0, head: 0, scatter: 0, typer: 0, engineOn: false,
            orbitYaw: 0, orbitPitch: 0, zoom: 1, panX: 0, panY: 0,
            manualMood: null, intensity: 0.5, intensityTarget: 0.5,
            pointers: new Map(), pinchDist: 0, recDelay: 3, taking: false,
            src: null, gen: 0, muted: false, mutedAt: 0, react: false, reacting: false,
            rq: [], rqTimer: 0, labState: '', lastSpokeEnd: 0, bc: null, _key: null,
            els: {
                stage: q('.lurk-stage'), say: q('.lurk-say'), state: q('.lurk-state'),
                input: q('.lurk-input'), speak: q('.lurk-speak'), lang: q('.lurk-lang'),
                live: q('.lurk-live'), rec: q('.lurk-rec'), power: q('.lurk-power'),
                full: q('.lurk-full'), moods: q('.lurk-moods'), hint: q('.lurk-hint'),
                delay: q('.lurk-delay'), count: q('.lurk-count'),
                mute: q('.lurk-mute'), react: q('.lurk-react')
            }
        };
        // reflect the ACTUAL engine state (it lives server-side, survives tab switches)
        fetch('/api/null/status', { headers: authHeaders() })
            .then(r => r.json()).then(j => {
                if (S && j && j.on) { S.engineOn = true; S.container.querySelector('.lurk-root')?.classList.add('engine-on'); }
            }).catch(() => { });
        S.els.speak.onclick = onSpeak;
        S.els.lang.onclick = () => { lang = lang === 'es' ? 'en' : 'es'; S.els.lang.textContent = lang.toUpperCase(); };
        S.els.live.onclick = () => {
            liveMode = !liveMode;
            S.els.live.classList.toggle('on', liveMode);
            S.els.input.placeholder = liveMode ? 'ask NULL (real AI)…' : 'paste the text NULL will say…';
        };
        S.els.rec.onclick = recTake;
        S.els.delay.onclick = cycleDelay;
        S.els.full.onclick = toggleFull;
        S.els.power.onclick = power;
        S.els.mute.onclick = () => toggleMute();
        S.els.react.onclick = toggleReact;
        // M = mute, only while this tab is on screen and nobody is typing. Capture
        // phase so the global terminal shortcuts never see it.
        S._key = (e) => {
            if (!S || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target;   // an EMPTY global command bar (#pc-input, focused on every tab) is not typing
            if (t && !(t.id === 'pc-input' && !t.value) && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (!S.container.offsetParent && !document.fullscreenElement) return;
            if (e.key && e.key.toLowerCase() === 'm') { e.preventDefault(); e.stopPropagation(); toggleMute(); }
        };
        window.addEventListener('keydown', S._key, true);
        if (typeof BroadcastChannel !== 'undefined') {
            S.bc = new BroadcastChannel('tsrct-lurk-labs');
            S.bc.onmessage = (ev) => {
                const d = ev.data || {}; if (!S) return;
                if (d.type === 'null-mute-toggle') toggleMute();
                else if (d.type === 'labs-event') { if (d.state) S.labState = d.state; queueReaction(d.text, d.state); }
            };
        }
        S.els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSpeak(); });

        // expression deck — drive NULL's mood live (replaces the pre-made lines)
        ['deadpan', 'contempt', 'roast', 'bored', 'intrigued', 'glitch', 'somber', 'awe'].forEach((m) => {
            const b = document.createElement('button');
            b.className = 'lurk-mood'; b.dataset.m = m; b.textContent = m;
            b.classList.toggle('on', m === 'deadpan');
            b.onclick = () => { S.manualMood = m; setExpressionUI(m); };
            S.els.moods.appendChild(b);
        });

        setupInteraction();
        S._resize = () => resizeCanvas();
        S._fs = () => { if (!document.fullscreenElement) document.body.classList.remove('lurk-record'); resizeCanvas(); };
        window.addEventListener('resize', S._resize);
        document.addEventListener('fullscreenchange', S._fs);
        resizeCanvas();
        S.raf = requestAnimationFrame(frame);
    }
    function unmount() {
        if (!S) return;
        if (S.raf) cancelAnimationFrame(S.raf);
        if (S.typer) clearInterval(S.typer);
        clearTimeout(S.rqTimer); S.gen++;
        if (S._key) window.removeEventListener('keydown', S._key, true);
        try { S.bc && S.bc.close(); } catch (e) { }
        if (S._resize) window.removeEventListener('resize', S._resize);
        if (S._fs) document.removeEventListener('fullscreenchange', S._fs);
        try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { }
        try { if (S.actx) S.actx.close(); } catch (e) { }
        document.body.classList.remove('lurk-record');
        if (S.container) S.container.classList.remove('theme-navy');
        S = null;
    }

    // ── desktop tab lifecycle ────────────────────────────────────────────
    window.lurkInit = function () { const b = document.getElementById('pc-lurk-body'); if (b) mount(b); };
    window.lurkTeardown = function () { unmount(); };

    // ── mobile room registration ─────────────────────────────────────────
    if (typeof WorldManager !== 'undefined') {
        WorldManager.rooms.lurk = {
            id: 'lurk-room', theme: 'navy', title: 'NULL', icon: 'zap',
            description: 'NULL — audio-reactive AI organism (LURK mode)',
            onOpen: () => { const m = document.querySelector('#lurk-room .lurk-mount'); if (m) mount(m); },
            onClose: () => unmount()
        };
    }
})();
