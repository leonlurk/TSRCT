// ─────────────────────────────────────────────────────────────────────────
// playlist.js — LURK LABS (was "Catalog"). Internal ids keep the `playlist`
// name on purpose (tab key, SURFACES entry, room id, window exports): renaming
// them is churn with no user-visible gain. Everything the user SEES says LABS.
//
// What it is (2026-09-17): an instrument you play on camera. Each track that has
// pre-cut stems (personal/lurk/tracks/stems/<track>/<section>_<stem>.wav, cut
// sample-exact on the track's measured grid) loads into a Web Audio rack:
// per stem FILTER (bipolar DJ filter) · VOL · ECHO send · MUTE · SOLO, plus a
// master strip SWEEP · SPACE · FEEDBACK · DRIVE, loop length, sections (BUILD /
// DROP) switched on the next bar, and a hold-to-CHOP gate. Nothing touches the
// GPU while playing: the stems were split once with Demucs, here they only mix.
//
// THE STRAND stays: the first-person WebGL flight through the DNA/neural strand.
// It now answers to GESTURES, never to the audio signal — canon (lurk DOC,
// 2026-07-25 / 09-07): nothing modulates with the kick. Closing a lowpass thickens
// the fog and cools the colour, a highpass thins it, muting stems dims the
// strands, echo stretches the dust, drive agitates the branches, a short loop
// holds the camera. Starting a freshly loaded track still triggers the dive.
//
// Every gesture is also broadcast on BroadcastChannel('tsrct-lurk-labs') as a
// plain-Spanish sentence, so the NULL tab (other monitor, other window) can react
// with the live brain. M here = mute NULL over there.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const CYAN = '#46e0ff', CYAN_HEX = 0x46e0ff;
    const ACCENT_HEX = 0x22a7ff;
    const COLD_HEX = 0x1b3f8f;     // where the strand cools to when the lowpass closes
    const WHITE = '#dff4ff';
    const BG_HEX = 0x05070d;
    const AUTH = () => (typeof token !== 'undefined' ? token : '') || '';
    const thead = () => ({ Authorization: AUTH() });
    const note = (m, t) => { if (typeof toast === 'function') toast(m, t || 'success'); };
    const $ = (sel) => (S.mounted ? S.mounted.querySelector(sel) : document.querySelector(sel));
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const easeIn = (x) => { x = clamp(x, 0, 1); return x * x * x; };

    // ── stems catalogue: which tracks are playable and on which grid ────────
    // bar = measured bar length (s). Sections = files <section>_<stem>.wav.
    const STEM_SETS = {
        jano:       { bar: 1.950439, bpm: 123.05, sections: { build: 16, drop: 32 }, first: 'drop' },
        deployment: { bar: 1.950476, bpm: 123.05, sections: { drop: 32 }, first: 'drop' },
    };
    const STEMS = [
        { id: 'drums',  label: 'DRUMS',  es: 'la batería', mute: '1', solo: 'q' },
        { id: 'bass',   label: 'BASS',   es: 'el bajo',    mute: '2', solo: 'w' },
        { id: 'other',  label: 'SYNTHS', es: 'los sintes', mute: '3', solo: 'e' },
        { id: 'vocals', label: 'VOX',    es: 'las voces',  mute: '4', solo: 'r' },
    ];
    const LOOPS = { z: 1, x: 2, c: 4, v: 8, b: 0 };   // 0 = whole section
    const SECTION_ES = { build: 'la subida antes del drop', drop: 'el drop' };
    const setKey = (name) => { const b = name.toLowerCase(); return Object.keys(STEM_SETS).find(k => b.includes(k)) || null; };

    // ── geometry constants (THE STRAND) ─────────────────────────────────────
    const R_HELIX = 2.15, SP = 7.0, STOP = 3.6, TURN_Z = 5.6, LMAX = 40;

    // ── state ──────────────────────────────────────────────────────────────
    const S = {
        mounted: null, tracks: [], dir: '',
        current: -1, playing: false, sceneStart: 0, energy: 0, diveArmed: false,
        canvas: null, ctx: null, glCanvas: null, cw: 0, ch: 0,
        terms: [], raf: 0, last: 0, hoverIdx: -1, _resize: null, _fs: null, _key: null, _keyup: null,
        vis: { cut: 0, hp: 0, dim: 0, echo: 0, space: 0, drive: 0, hold: 0 },
    };
    const A = {   // audio engine
        ctx: null, set: null, setName: '', section: '', buffers: {}, ch: {}, loading: false,
        startedAt: 0, loopBars: 0, solo: null, chopping: false, chopTimer: 0,
        master: { sweep: 0, space: 0, feedback: 0.35, drive: 0 },
    };
    const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('tsrct-lurk-labs') : null;

    // ── helpers ──────────────────────────────────────────────────────────────
    const parseName = (name, idx) => {
        const base = name.replace(/\.[^.]+$/, '');
        const m = base.match(/^\s*(\d{1,3})[\s._-]+(.*)$/);
        const num = m ? m[1].padStart(2, '0') : String(idx + 1).padStart(2, '0');
        let title = (m ? m[2] : base).replace(/[_-]+/g, ' ').trim();
        title = title.replace(/\b\w/g, (c) => c.toUpperCase());
        return { num, title: title || base };
    };
    const handle = (p) => p.num + '.' + p.title.toLowerCase().replace(/\s+/g, '_');
    const pct = (v) => Math.round(v * 100);

    // ═══════════════════════════════════════════════════════════════════════
    //  GL — the strand corridor (Three.js). Fails soft without THREE.
    // ═══════════════════════════════════════════════════════════════════════
    const GL = {
        ok: false, r: null, scene: null, cam: null,
        rungs: null, beads: null, branches: null, branchTips: null, innerGroup: null,
        motes: null, moteData: null, nodes: [], glowTex: null, strands: [],
        fov: 66, p: 0, _v: null, innerRot: 0, cA: null, cB: null, cTmp: null,

        zOf(i) { return -i * SP; },
        thetaOf(z) { return z * (2 * Math.PI / TURN_Z); },
        nodePos(i) { const z = this.zOf(i), th = this.thetaOf(z); return { x: Math.cos(th) * R_HELIX, y: Math.sin(th) * R_HELIX, z }; },

        makeGlowTexture() {
            const c = document.createElement('canvas'); c.width = c.height = 128;
            const g = c.getContext('2d');
            const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
            grd.addColorStop(0, 'rgba(255,255,255,1)');
            grd.addColorStop(0.25, 'rgba(220,244,255,0.85)');
            grd.addColorStop(0.55, 'rgba(70,224,255,0.28)');
            grd.addColorStop(1, 'rgba(70,224,255,0)');
            g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
            const tex = new THREE.CanvasTexture(c); tex.needsUpdate = true; return tex;
        },
        lineMat(op, col) { return new THREE.LineBasicMaterial({ color: col || CYAN_HEX, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }); },
        pointsMat(size, op, col) { return new THREE.PointsMaterial({ color: col || CYAN_HEX, size: size, map: this.glowTex, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }); },

        init(canvas) {
            if (typeof THREE === 'undefined') { this.ok = false; return; }
            try {
                this.r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
                this.r.setClearColor(0x000000, 0);
            } catch (e) { this.ok = false; return; }
            this.scene = new THREE.Scene();
            this.scene.fog = new THREE.FogExp2(BG_HEX, 0.05);
            this.cam = new THREE.PerspectiveCamera(this.fov, 1, 0.1, 120);
            this._v = new THREE.Vector3();
            this.glowTex = this.makeGlowTexture();
            this.cA = new THREE.Color(CYAN_HEX); this.cB = new THREE.Color(COLD_HEX); this.cTmp = new THREE.Color();
            this.p = 0; this.innerRot = 0;

            const zStart = 12, zEnd = -(LMAX * SP + 12), dz = 0.30;
            const NS_OUT = 6, NS_IN = 4, R = R_HELIX, RIN = 1.05, ITWIST = 1.35;
            const outArrs = []; for (let s = 0; s < NS_OUT; s++) outArrs.push([]);
            const inArrs = []; for (let s = 0; s < NS_IN; s++) inArrs.push([]);
            const beadPos = [], rungPos = [], branchPos = [], branchTip = [];
            for (let z = zStart; z >= zEnd; z -= dz) {
                const th = this.thetaOf(z);
                for (let s = 0; s < NS_OUT; s++) { const a = th + s / NS_OUT * 6.283; outArrs[s].push(Math.cos(a) * R, Math.sin(a) * R, z); }
                for (let s = 0; s < NS_IN; s++) { const a = -th * ITWIST + s / NS_IN * 6.283; inArrs[s].push(Math.cos(a) * RIN, Math.sin(a) * RIN, z); }
            }
            let ri = 0;
            for (let z = zStart; z >= zEnd; z -= dz * 2.4, ri++) {
                const th = this.thetaOf(z);
                for (let s = 0; s < NS_OUT; s++) {
                    const a = th + s / NS_OUT * 6.283, b = th + ((s + 1) % NS_OUT) / NS_OUT * 6.283;
                    const ax = Math.cos(a) * R, ay = Math.sin(a) * R, bx = Math.cos(b) * R, by = Math.sin(b) * R;
                    rungPos.push(ax, ay, z, bx, by, z);
                    beadPos.push(ax, ay, z);
                    if (s % 2 === 0) {
                        const ia = -th * ITWIST + (s % NS_IN) / NS_IN * 6.283;
                        rungPos.push(ax, ay, z, Math.cos(ia) * RIN, Math.sin(ia) * RIN, z);
                    }
                }
                if (ri % 2 === 0) {
                    const s = ri % NS_OUT, a = th + s / NS_OUT * 6.283;
                    const ox = Math.cos(a) * R, oy = Math.sin(a) * R;
                    const ext = 1.5 + (ri % 4) * 0.32, tx = ox * ext, ty = oy * ext, tz = z + ((ri % 2) ? 0.7 : -0.7);
                    branchPos.push(ox, oy, z, tx, ty, tz); branchTip.push(tx, ty, tz);
                    const fx = tx * 1.14, fy = ty * 1.14, fz = tz + 0.6;
                    branchPos.push(tx, ty, tz, fx, fy, fz); branchTip.push(fx, fy, fz);
                }
            }
            const geo = (arr) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); return g; };
            this.strands = [];
            const mkLine = (arr, op, col, parent, outer) => { const l = new THREE.Line(geo(arr), this.lineMat(op, col)); l.userData.base = op; l.userData.outer = outer; (parent || this.scene).add(l); this.strands.push(l); return l; };
            this.innerGroup = new THREE.Group(); this.scene.add(this.innerGroup);
            outArrs.forEach(a => mkLine(a, 0.5, CYAN_HEX, this.scene, true));
            inArrs.forEach(a => mkLine(a, 0.34, ACCENT_HEX, this.innerGroup, false));
            this.rungs = new THREE.LineSegments(geo(rungPos), this.lineMat(0.16)); this.scene.add(this.rungs);
            this.beads = new THREE.Points(geo(beadPos), this.pointsMat(0.12, 0.85, 0xbfe9ff)); this.scene.add(this.beads);
            this.branches = new THREE.LineSegments(geo(branchPos), this.lineMat(0.16)); this.scene.add(this.branches);
            this.branchTips = new THREE.Points(geo(branchTip), this.pointsMat(0.18, 0.8, 0xdff4ff)); this.scene.add(this.branchTips);

            this.nodes = [];
            for (let i = 0; i < LMAX; i++) {
                const np = this.nodePos(i);
                const g = new THREE.Group(); g.position.set(np.x, np.y, np.z);
                const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: CYAN_HEX, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }));
                glow.scale.set(1.5, 1.5, 1);
                const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }));
                const halo = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.012, 8, 40), new THREE.MeshBasicMaterial({ color: CYAN_HEX, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
                g.add(glow); g.add(core); g.add(halo);
                g.visible = false; g._glow = glow; g._core = core; g._halo = halo;
                this.scene.add(g); this.nodes.push(g);
            }

            const MN = 700; const mpos = new Float32Array(MN * 3); this.moteData = [];
            for (let i = 0; i < MN; i++) {
                const a = Math.random() * 6.283, rad = 0.5 + Math.random() * 4.5, z = 12 - Math.random() * (LMAX * SP + 24);
                mpos[i * 3] = Math.cos(a) * rad; mpos[i * 3 + 1] = Math.sin(a) * rad; mpos[i * 3 + 2] = z;
                this.moteData.push({ sp: 2 + Math.random() * 4 });
            }
            const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.BufferAttribute(mpos, 3));
            this.motes = new THREE.Points(mg, this.pointsMat(0.07, 0.5, CYAN_HEX)); this.scene.add(this.motes);
            this.ok = true;
        },

        resize(w, h) {
            if (!this.ok) return;
            this.r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
            this.r.setSize(w, h, false);
            this.cam.aspect = w / Math.max(1, h); this.cam.updateProjectionMatrix();
        },
        camZ() { return -this.p * SP + STOP; },
        projectNode(i, w, h) {
            if (!this.ok) return { x: -999, y: -999, ahead: false, near: 0 };
            const np = this.nodePos(i);
            this._v.set(np.x, np.y, np.z).project(this.cam);
            const cz = this.cam.position.z;
            const ahead = np.z < cz - 0.4 && this._v.z < 1;
            const dist = cz - np.z;
            return { x: (this._v.x * 0.5 + 0.5) * w, y: (-this._v.y * 0.5 + 0.5) * h, ahead, near: clamp(1 - dist / (SP * 4), 0, 1) };
        },

        frame(st) {
            if (!this.ok) return;
            const { t, dt, energy, surge, ignite, glow, n, vis } = st;

            // travel: toward the loaded track; a short loop HOLDS the camera still-ish
            let pTarget;
            if (n > 0 && S.current >= 0) pTarget = S.current;
            else if (n > 1) pTarget = 0.5 * (n - 1) * (1 - Math.cos(t * 0.09));
            else pTarget = 0;
            const rate = ((S.current >= 0 ? 2.0 : 1.1) + surge * 2.2) * (1 - vis.hold * 0.8);
            this.p += (pTarget - this.p) * Math.min(1, dt * rate);
            const cz = this.camZ() - surge * 3.4;
            const fov = 66 + surge * 24 + vis.hp * 6 - vis.cut * 4;
            if (Math.abs(this.cam.fov - fov) > 0.05) { this.cam.fov = fov; this.cam.updateProjectionMatrix(); }

            const sway = 1 - vis.hold * 0.7;
            this.cam.position.set(Math.sin(t * 0.3) * 0.18 * sway, Math.cos(t * 0.23) * 0.14 * sway, cz);
            const roll = this.thetaOf(cz) * 0.5 + surge * 0.4;
            this.cam.up.set(Math.sin(roll), Math.cos(roll), 0);
            this.cam.lookAt(Math.sin(t * 0.5) * 0.12 * sway, Math.cos(t * 0.4) * 0.12 * sway, cz - 6);

            // gestures → the world. cut = lowpass closing (colder, foggier, dimmer);
            // hp = highpass (thinner fog, brighter lines); dim = muted stems.
            this.scene.fog.density = 0.05 + vis.cut * 0.085 - vis.hp * 0.022;
            const lineK = (0.8 + 0.5 * glow) * (1 - vis.dim * 0.62) * (1 + vis.hp * 0.55) * (1 - vis.cut * 0.3);
            this.cTmp.copy(this.cA).lerp(this.cB, clamp(vis.cut * 1.1, 0, 1));
            for (let i = 0; i < this.strands.length; i++) {
                const l = this.strands[i];
                l.material.opacity = l.userData.base * lineK;
                if (l.userData.outer) l.material.color.copy(this.cTmp);
            }
            this.innerRot += dt * (0.06 + vis.drive * 0.55);
            this.innerGroup.rotation.z = this.innerRot;
            this.rungs.material.opacity = (0.14 + 0.16 * glow) * (0.7 + 0.3 * Math.sin(t * 1.4)) * (1 - vis.dim * 0.5);
            this.beads.material.opacity = (0.7 + 0.25 * glow) * (1 - vis.dim * 0.4);
            this.beads.material.size = 0.12 * (1 + vis.space * 1.6);
            this.branches.material.opacity = 0.14 + 0.16 * glow + vis.drive * 0.45;
            const jit = vis.drive * 0.05;
            this.branches.position.set((Math.random() - 0.5) * jit, (Math.random() - 0.5) * jit, 0);
            this.branchTips.material.opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(t * 3 + 1));
            this.branchTips.material.size = 0.18 * (1 + vis.space * 0.9);

            for (let i = 0; i < this.nodes.length; i++) {
                const nd = this.nodes[i], on = i < n; nd.visible = on;
                if (!on) continue;
                const active = i === S.current;
                const playable = !!(S.tracks[i] && setKey(S.tracks[i].name));
                const near = clamp(1 - Math.abs(this.p - i) / 1.2, 0, 1);
                const pulse = active ? (0.6 + 0.6 * ignite) : (0.45 + 0.15 * Math.sin(t * 1.6 + i));
                const pk = playable ? 1 : 0.35;
                nd._glow.scale.setScalar((active ? 2.0 : 1.3) + near * 1.1 + (active ? ignite * 2.2 : 0));
                nd._glow.material.opacity = ((active ? 0.9 : 0.5) * (0.5 + 0.5 * near) + (active ? ignite * 0.35 : 0)) * pk;
                nd._core.scale.setScalar(0.7 + pulse * (active ? 1.3 : 0.5));
                nd._halo.rotation.z += dt * (active ? (1.2 + ignite * 3) : 0.4);
                nd._halo.rotation.x = t * 0.3 + i;
                nd._halo.material.opacity = (active ? 0.75 : 0.35) * (0.4 + 0.6 * near) * pk;
                nd._halo.scale.setScalar(1 + (active ? ignite * 0.7 : 0));
            }

            const mp = this.motes.geometry.getAttribute('position'); const ma = mp.array;
            const behind = cz + 8, ahead = cz - (LMAX * SP);
            const moteK = (0.6 + energy + surge * 6) * (1 + vis.echo * 2.6) * (1 - vis.hold * 0.6);
            for (let i = 0; i < this.moteData.length; i++) {
                let z = ma[i * 3 + 2] + this.moteData[i].sp * dt * moteK;
                if (z > behind) { z = ahead + Math.random() * 6; const a = Math.random() * 6.283, rad = 0.5 + Math.random() * 4.5; ma[i * 3] = Math.cos(a) * rad; ma[i * 3 + 1] = Math.sin(a) * rad; }
                ma[i * 3 + 2] = z;
            }
            mp.needsUpdate = true;
            this.motes.material.opacity = 0.4 + 0.35 * glow + surge * 0.4 + vis.echo * 0.25;
            this.motes.material.size = 0.07 * (1 + vis.echo * 1.2);

            this.r.render(this.scene, this.cam);
        },

        dispose() {
            if (!this.r) { this.ok = false; return; }
            try {
                this.scene && this.scene.traverse(o => {
                    if (o.geometry) o.geometry.dispose();
                    if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); }); }
                });
                this.glowTex && this.glowTex.dispose();
                this.r.dispose(); this.r.forceContextLoss && this.r.forceContextLoss();
            } catch (e) { /* best-effort teardown */ }
            this.r = this.scene = this.cam = this.motes = null;
            this.nodes = []; this.strands = []; this.moteData = null; this.ok = false;
        },
    };

    // ═══════════════════════════════════════════════════════════════════════
    //  AUDIO — the rack. Graph per stem:
    //    src → filter → gain(vol·mute·solo) ─┬→ bus
    //                                        └→ echoSend → delay ⟲ feedback → echoTone → bus
    //    bus ─┬→ dry ──────────┐
    //         └→ convolver→wet ┴→ sweep filter → drive(dry/shaped) → chop → limiter → analyser → out
    // ═══════════════════════════════════════════════════════════════════════
    function actx() {
        if (!A.ctx) {
            const C = window.AudioContext || window.webkitAudioContext;
            A.ctx = new C({ latencyHint: 'interactive' });
            buildMaster();
        }
        if (A.ctx.state === 'suspended') A.ctx.resume();
        return A.ctx;
    }
    function impulse(ctx, secs, decay) {
        const len = Math.floor(ctx.sampleRate * secs), buf = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
        return buf;
    }
    function driveCurve(k) {
        const n = 2048, c = new Float32Array(n), a = 1 + k * 18;
        for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(a * x) / Math.tanh(a); }
        return c;
    }
    function buildMaster() {
        const ctx = A.ctx, M = A.m = {};
        M.bus = ctx.createGain();
        M.dry = ctx.createGain(); M.wet = ctx.createGain(); M.wet.gain.value = 0;
        M.verb = ctx.createConvolver(); M.verb.buffer = impulse(ctx, 3.2, 2.6);
        M.sweep = ctx.createBiquadFilter(); M.sweep.type = 'allpass';
        M.driveDry = ctx.createGain(); M.driveWet = ctx.createGain(); M.driveWet.gain.value = 0;
        M.shaper = ctx.createWaveShaper(); M.shaper.curve = driveCurve(0); M.shaper.oversample = '2x';
        M.chop = ctx.createGain();
        M.limit = ctx.createDynamicsCompressor();
        M.limit.threshold.value = -4; M.limit.knee.value = 4; M.limit.ratio.value = 12; M.limit.attack.value = 0.003; M.limit.release.value = 0.12;
        M.an = ctx.createAnalyser(); M.an.fftSize = 512; M.data = new Uint8Array(512);
        M.delay = ctx.createDelay(4); M.fb = ctx.createGain(); M.tone = ctx.createBiquadFilter();
        M.tone.type = 'lowpass'; M.tone.frequency.value = 3800; M.fb.gain.value = A.master.feedback;

        M.delay.connect(M.fb); M.fb.connect(M.delay); M.delay.connect(M.tone); M.tone.connect(M.bus);
        M.bus.connect(M.dry); M.bus.connect(M.verb); M.verb.connect(M.wet);
        M.dry.connect(M.sweep); M.wet.connect(M.sweep);
        M.sweep.connect(M.driveDry); M.sweep.connect(M.shaper); M.shaper.connect(M.driveWet);
        M.driveDry.connect(M.chop); M.driveWet.connect(M.chop);
        M.chop.connect(M.limit); M.limit.connect(M.an); M.an.connect(ctx.destination);
    }
    function applyDelayTime() {
        if (!A.m || !A.set) return;
        A.m.delay.delayTime.setTargetAtTime(A.set.bar / 4 * 0.75, A.ctx.currentTime, 0.02);   // dotted eighth
    }
    // bipolar DJ filter: -1 closed lowpass · 0 bypass · +1 open highpass (same curve as INSTRUMENT v0)
    function setFilterNode(f, v, t) {
        if (Math.abs(v) < 0.04) { f.type = 'allpass'; return; }
        if (v < 0) { f.type = 'lowpass'; f.frequency.setTargetAtTime(18000 * Math.pow(1 - (-v) * 0.985, 3.2) + 90, t, 0.015); f.Q.value = 0.9 + (-v) * 5; }
        else { f.type = 'highpass'; f.frequency.setTargetAtTime(28 * Math.pow(1 + v * 20, 2.05), t, 0.015); f.Q.value = 0.9 + v * 4; }
    }
    function ensureChannels() {
        const ctx = A.ctx;
        STEMS.forEach(s => {
            if (A.ch[s.id]) return;
            const c = { filt: ctx.createBiquadFilter(), gain: ctx.createGain(), send: ctx.createGain(), an: ctx.createAnalyser(),
                src: null, vol: 1, filter: 0, echo: 0, muted: false, data: new Uint8Array(128) };
            c.filt.type = 'allpass'; c.send.gain.value = 0; c.an.fftSize = 256;
            c.filt.connect(c.gain); c.gain.connect(A.m.bus); c.gain.connect(c.send); c.send.connect(A.m.delay); c.gain.connect(c.an);
            A.ch[s.id] = c;
        });
    }
    function applyGains() {
        if (!A.ctx) return;
        const t = A.ctx.currentTime;
        STEMS.forEach(s => {
            const c = A.ch[s.id]; if (!c) return;
            const off = c.muted || (A.solo && A.solo !== s.id);
            c.gain.gain.setTargetAtTime(off ? 0 : c.vol, t, 0.012);
            const strip = $('#lb-ch-' + s.id); if (strip) strip.classList.toggle('off', !!off);
        });
        paintButtons(); updateVis();
    }
    function applyMaster() {
        if (!A.m) return;
        const t = A.ctx.currentTime, M = A.m, m = A.master;
        setFilterNode(M.sweep, m.sweep, t);
        M.wet.gain.setTargetAtTime(m.space * 0.85, t, 0.05);
        M.dry.gain.setTargetAtTime(1 - m.space * 0.35, t, 0.05);
        M.fb.gain.setTargetAtTime(Math.min(0.88, m.feedback), t, 0.05);
        M.shaper.curve = driveCurve(m.drive);
        M.driveWet.gain.setTargetAtTime(m.drive * 0.55, t, 0.03);
        M.driveDry.gain.setTargetAtTime(1 - m.drive * 0.6, t, 0.03);
        updateVis();
    }

    async function loadTrack(idx) {
        const tr = S.tracks[idx]; if (!tr) return;
        const key = setKey(tr.name);
        if (!key) { note('No stems for ' + tr.name + ' — run Demucs and cut the loops', 'info'); return; }
        if (A.loading) return;
        const wasPlaying = S.playing;
        stopAll(true);
        A.loading = true; S.current = idx; paintChrome('LOADING…');
        try {
            const ctx = actx(); ensureChannels();
            const set = STEM_SETS[key], base = S.dir.replace(/\/+$/, '') + '/stems/' + key + '/';
            const buffers = {};
            await Promise.all(Object.keys(set.sections).flatMap(sec => STEMS.map(async s => {
                const r = await fetch('/api/playlist/file?path=' + encodeURIComponent(base + sec + '_' + s.id + '.wav'), { headers: thead() });
                if (!r.ok) throw new Error(sec + '_' + s.id + ' ' + r.status);
                buffers[sec + '_' + s.id] = await ctx.decodeAudioData(await r.arrayBuffer());
            })));
            A.buffers = buffers; A.set = set; A.setName = key; A.section = set.first; A.loopBars = 0;
            applyDelayTime(); S.diveArmed = true;
            emit('cargó ' + key + ' en LABS');
            if (wasPlaying || A.pendingPlay) { startAll(); if (A.pendingPlay) emit('arrancó ' + SECTION_ES[A.section] + ' de ' + A.setName); }
        } catch (e) {
            note('LABS: could not load the stems (' + e.message + ')', 'error');
            A.set = null;
        }
        A.loading = false; A.pendingPlay = false; paintChrome();
    }

    const sectionBars = () => (A.set ? A.set.sections[A.section] : 0);
    const loopLen = () => (A.loopBars || sectionBars()) * (A.set ? A.set.bar : 1);
    function startAll(at, offset) {
        if (!A.set) return;
        const ctx = actx();
        STEMS.forEach(s => { const c = A.ch[s.id]; try { c.src && c.src.stop(at || 0); } catch (e) { } c.src = null; });
        const t0 = at || (ctx.currentTime + 0.06);   // one shared start time = sample-exact sync
        const off = offset || 0;
        STEMS.forEach(s => {
            const src = ctx.createBufferSource();
            src.buffer = A.buffers[A.section + '_' + s.id];
            src.loop = true; src.loopStart = 0; src.loopEnd = loopLen();
            src.connect(A.ch[s.id].filt);
            src.start(t0, off % loopLen());
            A.ch[s.id].src = src;
        });
        A.startedAt = t0 - off;
        if (!S.playing && S.diveArmed) { S.sceneStart = performance.now(); S.diveArmed = false; }
        S.playing = true; paintChrome();
    }
    function stopAll(silent) {
        STEMS.forEach(s => { const c = A.ch[s.id]; if (!c) return; try { c.src && c.src.stop(); } catch (e) { } c.src = null; });
        if (S.playing && !silent) emit('paró todo');
        S.playing = false; chop(false); paintChrome();
    }
    function togglePlay() {
        if (A.loading) { A.pendingPlay = !A.pendingPlay; paintChrome(A.pendingPlay ? 'LOADING ▶' : 'LOADING…'); return; }   // a play pressed mid-load is kept, not lost
        if (!A.set) { const i = S.tracks.findIndex(t => setKey(t.name) === 'jano'); if (i >= 0) loadTrack(i).then(() => { if (A.set) { startAll(); emit('arrancó ' + SECTION_ES[A.section] + ' de ' + A.setName); } }); return; }
        if (S.playing) stopAll();
        else { startAll(); emit('arrancó ' + SECTION_ES[A.section] + ' de ' + A.setName); }
    }
    // position inside the current loop, and the next bar boundary (for quantized switches)
    function nextBarTime() {
        const ctx = A.ctx, bar = A.set.bar;
        const el = ctx.currentTime - A.startedAt;
        return A.startedAt + (Math.floor(el / bar) + 1) * bar;
    }
    function setSection(sec) {
        if (!A.set || !A.set.sections[sec] || sec === A.section) return;
        A.section = sec; A.loopBars = 0;
        if (S.playing) startAll(Math.max(A.ctx.currentTime + 0.02, nextBarTime()), 0);
        emit('pasó a ' + SECTION_ES[sec]); paintChrome();
    }
    function setLoop(bars) {
        if (!A.set) return;
        const secBars = sectionBars();
        const newBars = (bars && bars < secBars) ? bars : 0;
        if (newBars === A.loopBars) { paintChrome(); return; }
        if (S.playing) {
            // Restart on the next bar. The playhead's REAL position in the material is
            // (elapsed mod the OLD loop length); shrinking keeps the chunk that
            // contains it, growing continues from it — so the groove never jumps.
            const t = Math.max(A.ctx.currentTime + 0.02, nextBarTime());
            const oldL = loopLen();
            const posBars = Math.round((((t - A.startedAt) % oldL) + oldL) % oldL / A.set.bar) % secBars;
            A.loopBars = newBars;
            const L = A.loopBars || secBars;
            startAll(t, (A.loopBars ? Math.floor(posBars / L) * L : posBars) * A.set.bar);
        } else A.loopBars = newBars;
        emit(A.loopBars ? ('achicó el loop a ' + A.loopBars + (A.loopBars === 1 ? ' compás' : ' compases')) : 'volvió al loop entero');
        paintChrome(); updateVis();
    }
    function toggleMute(id) {
        const c = A.ch[id]; if (!c) return;
        c.muted = !c.muted; applyGains();
        const s = STEMS.find(x => x.id === id);
        emit(c.muted ? ('silenció ' + s.es) : ('volvió a poner ' + s.es));
    }
    function toggleSolo(id) {
        if (!A.ch[id]) return;
        A.solo = (A.solo === id) ? null : id; applyGains();
        const s = STEMS.find(x => x.id === id);
        emit(A.solo ? ('dejó sonando solo ' + s.es) : 'sacó el solo, suena todo');
    }
    // CHOP: hold = a 1/16 gate locked to the grid (a gesture effect, scheduled ahead)
    function chop(on) {
        if (!A.m) return;
        const g = A.m.chop.gain, ctx = A.ctx;
        if (on === A.chopping) return;
        A.chopping = on;
        clearInterval(A.chopTimer);
        g.cancelScheduledValues(ctx.currentTime);
        if (!on) { g.setTargetAtTime(1, ctx.currentTime, 0.004); paintButtons(); updateVis(); return; }
        const step = A.set ? A.set.bar / 16 : 0.122;
        let next = A.set && S.playing ? A.startedAt + Math.ceil((ctx.currentTime - A.startedAt) / step) * step : ctx.currentTime;
        const schedule = () => {
            const horizon = ctx.currentTime + 0.2;
            while (next < horizon) {
                const k = Math.round((next - A.startedAt) / step);
                g.setTargetAtTime(k % 2 === 0 ? 1 : 0.0001, next, 0.003);   // 3 ms ramp: a gate, not a click
                next += step;
            }
        };
        schedule(); A.chopTimer = setInterval(schedule, 50);
        emit('cortó el sonido en ráfagas'); paintButtons(); updateVis();
    }

    // ── NULL bridge ──────────────────────────────────────────────────────────
    function stateLine() {
        if (!A.set) return 'nada cargado';
        const parts = STEMS.map(s => {
            const c = A.ch[s.id]; if (!c) return '';
            if (c.muted || (A.solo && A.solo !== s.id)) return s.es + ' silenciado';
            let d = s.es + ' ' + pct(c.vol) + '%';
            if (Math.abs(c.filter) >= 0.04) d += (c.filter < 0 ? ' con pasa-bajos ' : ' con pasa-altos ') + pct(Math.abs(c.filter)) + '%';
            if (c.echo > 0.05) d += ' con eco';
            return d;
        }).filter(Boolean);
        const m = A.master, fx = [];
        if (Math.abs(m.sweep) >= 0.04) fx.push('filtro general ' + (m.sweep < 0 ? 'pasa-bajos ' : 'pasa-altos ') + pct(Math.abs(m.sweep)) + '%');
        if (m.space > 0.05) fx.push('reverb ' + pct(m.space) + '%');
        if (m.drive > 0.05) fx.push('distorsión ' + pct(m.drive) + '%');
        return A.setName + ', ' + SECTION_ES[A.section] + (A.loopBars ? ', loop de ' + A.loopBars + ' compás' + (A.loopBars > 1 ? 'es' : '') : '') +
            (S.playing ? ', sonando' : ', parado') + '. ' + parts.join('; ') + (fx.length ? '. ' + fx.join(', ') : '');
    }
    function emit(text) {
        if (!bc) return;
        try { bc.postMessage({ type: 'labs-event', text, state: stateLine(), at: Date.now() }); } catch (e) { }
    }

    // ── gestures → visual state (eased in the render loop) ───────────────────
    const visTarget = { cut: 0, hp: 0, dim: 0, echo: 0, space: 0, drive: 0, hold: 0 };
    function updateVis() {
        const live = STEMS.map(s => A.ch[s.id]).filter(Boolean);
        let cut = Math.max(0, -A.master.sweep), hp = Math.max(0, A.master.sweep), echo = 0, dim = 0;
        live.forEach(c => {
            cut = Math.max(cut, Math.max(0, -c.filter) * 0.8);
            hp = Math.max(hp, Math.max(0, c.filter) * 0.8);
            echo = Math.max(echo, c.echo);
        });
        STEMS.forEach(s => { const c = A.ch[s.id]; if (c && (c.muted || (A.solo && A.solo !== s.id))) dim += 0.25; });
        visTarget.cut = cut; visTarget.hp = hp; visTarget.dim = dim;
        visTarget.echo = echo * (0.4 + A.master.feedback);
        visTarget.space = A.master.space; visTarget.drive = A.master.drive + (A.chopping ? 0.35 : 0);
        const L = A.loopBars || 0;
        visTarget.hold = L === 1 ? 1 : L === 2 ? 0.7 : L === 4 ? 0.4 : L === 8 ? 0.15 : 0;
    }

    // ── data ──────────────────────────────────────────────────────────────────
    async function loadList() {
        try {
            const r = await fetch('/api/playlist/list', { headers: thead() });
            if (!r.ok) throw new Error('list ' + r.status);
            const j = await r.json();
            S.tracks = j.tracks || []; S.dir = j.dir || '';
        } catch (e) { S.tracks = []; note('LABS: could not read the tracks (' + e.message + ')', 'error'); }
        if (S.current >= S.tracks.length) { S.current = -1; S.playing = false; }
        paintChrome();
        // land on Jano, ready to play (decoding needs no user gesture; playback does)
        if (S.current < 0 && !A.set) { const i = S.tracks.findIndex(t => setKey(t.name) === 'jano'); if (i >= 0) loadTrack(i); }
    }

    // ── layout / render ──────────────────────────────────────────────────────
    function layout() {
        const w = S.cw, h = S.ch, n = S.tracks.length;
        S.terms.length = 0;
        for (let i = 0; i < n; i++) {
            const pr = GL.projectNode(i, w, h);
            const onscreen = pr.ahead && pr.x > -40 && pr.x < w + 40 && pr.y > -40 && pr.y < h + 40;
            S.terms.push({ x: pr.x, y: pr.y, vis: onscreen, near: pr.near });
        }
    }
    function resizeCanvas() {
        const cv = S.canvas; if (!cv) return;
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth || 400, h = cv.clientHeight || 300;
        cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
        S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        S.cw = w; S.ch = h;
        GL.resize(w, h);
    }

    function frame(ts) {
        S.raf = requestAnimationFrame(frame);
        const g = S.ctx, w = S.cw, h = S.ch; if (!g || !w) return;
        const dt = S.last ? Math.min(0.05, (ts - S.last) / 1000) : 0.016; S.last = ts;
        const t = ts / 1000, n = S.tracks.length;

        for (const k in S.vis) S.vis[k] += (visTarget[k] - S.vis[k]) * Math.min(1, dt * 4);
        S.energy += ((S.playing ? 1 : 0) - S.energy) * Math.min(1, dt * 3.2);
        const el = ts - S.sceneStart;
        const dive = S.sceneStart > 0 && el < 6000;
        const E = dive ? el : 1e9;
        const charge = clamp(E / 500, 0, 1) * (1 - clamp((E - 1200) / 800, 0, 1));
        const warp = easeIn(clamp((E - 400) / 2600, 0, 1));
        const brk = clamp((E - 2700) / 700, 0, 1);
        const settle = clamp((E - 4300) / 1500, 0, 1);
        const surge = dive ? clamp((warp + brk * 0.7) * (1 - settle), 0, 1.5) : 0;
        const bloom = dive ? clamp(Math.min((E - 2700) / 550, 1, (4600 - E) / 700), 0, 1) : 0;
        const diveHit = dive ? (warp + brk * 1.3) * (1 - settle) : 0;
        const ignite = clamp((dive ? charge * 0.7 : 0) + diveHit + S.energy * 0.45, 0, 1.8);
        const titleAmt = dive ? clamp((E - 4500) / 900, 0, 1) : 1;

        GL.frame({ t, dt, energy: S.energy, surge, ignite, glow: S.energy, n, vis: S.vis });

        layout();
        g.clearRect(0, 0, w, h);
        g.lineJoin = 'round'; g.lineCap = 'round';
        g.globalCompositeOperation = 'lighter';
        for (let i = 0; i < n; i++) {
            const tm = S.terms[i]; if (!tm.vis) continue;
            const active = i === S.current, hover = i === S.hoverIdx;
            if (!active && !hover && tm.near < 0.17) continue;
            const p = parseName(S.tracks[i].name, i);
            const playable = !!setKey(S.tracks[i].name);
            const near = tm.near, rr = 11 + near * 9 + (active ? 3 : 0);
            const baseA = (active ? 1 : (hover ? 0.9 : (0.28 + 0.6 * near))) * (playable ? 1 : 0.4);
            g.beginPath();
            for (let a = 0; a < 6; a++) { const ang = Math.PI / 6 + a * Math.PI / 3; const px = tm.x + Math.cos(ang) * rr, py = tm.y + Math.sin(ang) * rr; if (a === 0) g.moveTo(px, py); else g.lineTo(px, py); }
            g.closePath();
            g.fillStyle = active ? 'rgba(70,224,255,0.16)' : 'rgba(20,60,110,0.14)';
            g.globalAlpha = baseA; g.fill();
            g.lineWidth = active ? 2 : 1.2; g.strokeStyle = CYAN;
            g.shadowColor = CYAN; g.shadowBlur = active ? (10 + ignite * 16) : (hover ? 8 : 0);
            g.globalAlpha = baseA; g.stroke(); g.shadowBlur = 0;
            if (active && ignite > 0.05) anamorphic(g, tm.x, tm.y, 300, clamp(ignite, 0, 1) * 0.6);
            if (active || hover || near > 0.3) {
                g.globalCompositeOperation = 'source-over';
                g.textAlign = 'left'; g.textBaseline = 'middle';
                g.globalAlpha = (active ? 1 : (hover ? 0.9 : 0.55 * near)) * (playable ? 1 : 0.6);
                g.fillStyle = active ? CYAN : 'rgba(191,224,255,0.72)';
                g.font = (active ? '700 ' : '500 ') + Math.round(12 + near * 3) + 'px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
                let hd = handle(p) + (playable ? '' : '  // sin stems'); if (hd.length > 30) hd = hd.slice(0, 29) + '…';
                g.fillText(hd, tm.x + rr + 9, tm.y + 1);
            }
            g.globalCompositeOperation = 'lighter';
        }
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;

        if (S.current >= 0 && A.set) drawTitle(g, titleAmt);

        if (surge > 0.03) {
            const cx = w * 0.5, cy = h * 0.4, M = 120, maxR = Math.hypot(w, h) * 0.62;
            g.globalCompositeOperation = 'lighter';
            for (let k = 0; k < M; k++) {
                const ang = k * 2.39996 + t * 0.5;
                const rr = ((k * 0.1373 + t * (0.6 + surge * 1.6)) % 1);
                const r0 = rr * maxR, len = (30 + 300 * surge) * (0.25 + rr);
                const a0 = surge * (1 - rr) * 0.85;
                if (a0 < 0.012) continue;
                const dx = Math.cos(ang), dy = Math.sin(ang);
                g.strokeStyle = rr > 0.5 ? WHITE : CYAN;
                g.globalAlpha = a0; g.lineWidth = 1 + rr * 2.4;
                g.beginPath(); g.moveTo(cx + dx * r0, cy + dy * r0); g.lineTo(cx + dx * (r0 + len), cy + dy * (r0 + len)); g.stroke();
            }
            g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
        }
        if (bloom > 0.001) {
            const cx = w * 0.5, cy = h * 0.4;
            g.globalCompositeOperation = 'lighter';
            g.globalAlpha = clamp(bloom, 0, 1) * 0.8;
            const grd = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * (0.4 + bloom * 0.6));
            grd.addColorStop(0, 'rgba(235,250,255,1)'); grd.addColorStop(0.5, 'rgba(120,220,255,0.75)'); grd.addColorStop(1, 'transparent');
            g.fillStyle = grd; g.fillRect(0, 0, w, h);
            anamorphic(g, cx, cy, w, bloom * 0.9);
            g.globalCompositeOperation = 'source-over';
        }
        g.globalAlpha = 1;
        drawCinematic(g, w, h);
        paintMeters();
    }

    function anamorphic(g, cx, cy, halfW, amt) {
        if (amt <= 0.001) return;
        g.globalCompositeOperation = 'lighter';
        const lg = g.createLinearGradient(cx - halfW, cy, cx + halfW, cy);
        lg.addColorStop(0, 'transparent'); lg.addColorStop(0.5, 'rgba(150,232,255,0.95)'); lg.addColorStop(1, 'transparent');
        g.globalAlpha = clamp(amt, 0, 1) * 0.6; g.fillStyle = lg; g.fillRect(cx - halfW, cy - 1.5, halfW * 2, 3);
        g.globalAlpha = clamp(amt, 0, 1) * 0.22; g.fillRect(cx - halfW, cy - 10, halfW * 2, 20);
    }
    function drawCinematic(g, w, h) {
        g.globalCompositeOperation = 'source-over';
        const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.34, w / 2, h / 2, Math.hypot(w, h) * 0.62);
        vg.addColorStop(0, 'transparent'); vg.addColorStop(1, 'rgba(0,2,7,0.6)');
        g.globalAlpha = 1; g.fillStyle = vg; g.fillRect(0, 0, w, h);
        g.globalAlpha = 0.045; g.fillStyle = '#000';
        for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
        const N = Math.min(1100, Math.floor(w * h / 1100));
        for (let i = 0; i < N; i++) {
            g.globalAlpha = 0.03 + Math.random() * 0.05;
            g.fillStyle = Math.random() < 0.5 ? '#000' : '#fff';
            g.fillRect(Math.random() * w, Math.random() * h, 1.3, 1.3);
        }
        g.globalAlpha = 1;
    }
    // top-left title block: 02.jano // drop · loop 2
    function drawTitle(g, titleAmt) {
        const t = S.tracks[S.current]; if (!t) return;
        const shown = handle(parseName(t.name, S.current));
        const typed = shown.slice(0, Math.floor(shown.length * titleAmt)) + (titleAmt < 1 && (Math.floor(performance.now() / 90) % 2) ? '_' : '');
        const x = 18, y = 84;   // below the LURK // LABS top bar
        g.textAlign = 'left'; g.textBaseline = 'alphabetic';
        g.globalAlpha = clamp(titleAmt * 2, 0, 1);
        g.fillStyle = CYAN; g.font = '700 11px ui-monospace, Menlo, Consolas, monospace';
        g.fillText((S.playing ? '// playing · ' : '// cued · ') + A.section + (A.loopBars ? ' · loop ' + A.loopBars : ''), x, y);
        g.fillStyle = WHITE; g.font = '700 24px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
        g.globalAlpha = 1;
        g.fillText(typed, x, y + 28);
        g.globalAlpha = 1;
    }

    // ── knobs (SVG, drag vertical · wheel · double-click resets) ─────────────
    function makeKnob(el, { min, max, value, label, fmt, onchange, onend }) {
        let v = value;
        const NS = 'http://www.w3.org/2000/svg';
        el.classList.add('lb-knob');
        el.innerHTML = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="38" class="lb-k-track"/><path class="lb-k-arc"/><line class="lb-k-ptr" x1="50" y1="50" x2="50" y2="20"/><circle cx="50" cy="50" r="5" class="lb-k-dot"/></svg><div class="lb-k-lab">${label} <b></b></div>`;
        const arc = el.querySelector('.lb-k-arc'), ptr = el.querySelector('.lb-k-ptr'), val = el.querySelector('b');
        const A0 = 135, A1 = 405, bip = min < 0;
        const pt = (a, r) => [50 + r * Math.cos(a * Math.PI / 180), 50 + r * Math.sin(a * Math.PI / 180)];
        function draw() {
            const t = (v - min) / (max - min), a = A0 + t * (A1 - A0);
            const aFrom = bip ? 270 : A0;
            const [x0, y0] = pt(Math.min(aFrom, a), 38), [x1, y1] = pt(Math.max(aFrom, a), 38);
            const sweep = Math.abs(a - aFrom);
            arc.setAttribute('d', sweep < 0.5 ? '' : `M ${x0} ${y0} A 38 38 0 ${sweep > 180 ? 1 : 0} 1 ${x1} ${y1}`);
            const [px, py] = pt(a, 30); ptr.setAttribute('x2', px); ptr.setAttribute('y2', py);
            val.textContent = fmt(v);
            el.classList.toggle('lb-k-hot', bip ? Math.abs(v) >= 0.04 : Math.abs(v - value) > 0.02);
        }
        let drag = null;
        el.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, id: e.pointerId }; try { el.setPointerCapture(e.pointerId); } catch (_) { } el.classList.add('lb-k-drag'); e.preventDefault(); });
        el.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const dy = drag.y - e.clientY; drag.y = e.clientY;
            v = clamp(v + dy * (max - min) / (e.shiftKey ? 600 : 180), min, max);
            draw(); onchange(v);
        });
        const end = (e) => { if (!drag) return; drag = null; el.classList.remove('lb-k-drag'); onend && onend(v); };
        el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
        let wheelT = 0;
        el.addEventListener('wheel', (e) => {
            e.preventDefault();
            v = clamp(v - Math.sign(e.deltaY) * (max - min) / 40, min, max); draw(); onchange(v);
            clearTimeout(wheelT); wheelT = setTimeout(() => onend && onend(v), 500);
        }, { passive: false });
        el.addEventListener('dblclick', () => { v = value; draw(); onchange(v); onend && onend(v); });
        draw();
        return { get: () => v, set(nv) { v = clamp(nv, min, max); draw(); onchange(v); } };
    }
    const fmtFilt = (v) => Math.abs(v) < 0.04 ? '—' : (v < 0 ? 'LP' + pct(-v) : 'HP' + pct(v));

    // ── DOM chrome ─────────────────────────────────────────────────────────────
    function render(container) {
        container.innerHTML = `
        <div class="pl lb">
            <div class="pl-stage" id="pl-stage">
                <canvas class="pl-gl" id="pl-gl"></canvas>
                <canvas class="pl-canvas" id="pl-canvas"></canvas>
                <div class="lb-top">
                    <div class="pl-brand">LURK <span class="pl-brand-sub">// LABS</span></div>
                    <div class="lb-top-r">
                        <span class="lb-pos" id="lb-pos">— · —</span>
                        <button class="pl-full" id="pl-full" title="Full screen for filming (Esc exits)"><svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1 5V1h4M14 5V1h-4M1 10v4h4M14 10v4h-4"/></svg></button>
                    </div>
                </div>
                <div class="pl-empty" id="pl-empty" hidden>
                    <div class="pl-empty-h">LABS EMPTY</div>
                    <div class="pl-empty-p">No hay pistas en<br><code id="pl-empty-dir">personal/lurk/tracks</code></div>
                </div>
                <div class="lb-rack" id="lb-rack">
                    <div class="lb-bar">
                        <button class="lb-btn lb-play" id="lb-play" title="Espacio">▶ PLAY</button>
                        <div class="lb-group" id="lb-sections"></div>
                        <div class="lb-group"><span class="lb-cap">LOOP</span>
                            <button class="lb-btn lb-loop" data-bars="1" title="Z">1</button><button class="lb-btn lb-loop" data-bars="2" title="X">2</button><button class="lb-btn lb-loop" data-bars="4" title="C">4</button><button class="lb-btn lb-loop" data-bars="8" title="V">8</button><button class="lb-btn lb-loop" data-bars="0" title="B">ALL</button>
                        </div>
                        <button class="lb-btn lb-chop" id="lb-chop" title="Mantener T">CHOP</button>
                        <div class="lb-phase" id="lb-phase"></div>
                        <button class="lb-btn lb-nullmute" id="lb-nullmute" title="M — mutes NULL in its tab">MUTE NULL</button>
                    </div>
                    <div class="lb-strips" id="lb-strips"></div>
                </div>
            </div>
        </div>`;
        S.canvas = $('#pl-canvas');
        S.ctx = S.canvas.getContext('2d');
        S.glCanvas = $('#pl-gl');
        GL.init(S.glCanvas);
        buildRack();
        setupInteraction();
        S._resize = () => resizeCanvas();
        window.addEventListener('resize', S._resize);
        S._fs = () => setTimeout(resizeCanvas, 60);
        document.addEventListener('fullscreenchange', S._fs);
        // The room CSS is lazy-loaded and can land AFTER this render, so the first
        // measure may see a 400x300 box and stretch it (huge blurry labels). Observe.
        if (typeof ResizeObserver !== 'undefined') { S._ro = new ResizeObserver(() => resizeCanvas()); S._ro.observe($('#pl-stage')); }
        resizeCanvas(); S.last = 0;
        S.raf = requestAnimationFrame(frame);
        loadList();
    }

    const KNOBS = {};
    function buildRack() {
        const strips = $('#lb-strips');
        STEMS.forEach(s => {
            const d = document.createElement('div');
            d.className = 'lb-strip'; d.id = 'lb-ch-' + s.id;
            d.innerHTML = `<div class="lb-meter"><i></i></div><div class="lb-name">${s.label}</div>
                <div class="lb-knobs"><div data-k="filter"></div><div data-k="vol"></div><div data-k="echo"></div></div>
                <div class="lb-sw"><button class="lb-btn lb-mute" data-mute="${s.id}">MUTE <kbd>${s.mute}</kbd></button><button class="lb-btn lb-solo" data-solo="${s.id}">SOLO <kbd>${s.solo.toUpperCase()}</kbd></button></div>`;
            strips.appendChild(d);
            const q = (k) => d.querySelector(`[data-k="${k}"]`);
            const ch = () => { if (!A.ctx) actx(); ensureChannels(); return A.ch[s.id]; };
            KNOBS[s.id + '_filter'] = makeKnob(q('filter'), { min: -1, max: 1, value: 0, label: 'FILTER', fmt: fmtFilt,
                onchange: (v) => { const c = ch(); c.filter = v; setFilterNode(c.filt, v, A.ctx.currentTime); updateVis(); },
                onend: (v) => emit(Math.abs(v) < 0.04 ? ('sacó el filtro de ' + s.es) : (s.es + ': ' + (v < 0 ? 'cerró el pasa-bajos al ' : 'abrió el pasa-altos al ') + pct(Math.abs(v)) + '%')) });
            KNOBS[s.id + '_vol'] = makeKnob(q('vol'), { min: 0, max: 1, value: 1, label: 'VOL', fmt: (v) => pct(v),
                onchange: (v) => { const c = ch(); c.vol = v; applyGains(); },
                onend: (v) => emit((v < 0.98 ? 'bajó ' : 'subió ') + s.es + ' a ' + pct(v) + '%') });
            KNOBS[s.id + '_echo'] = makeKnob(q('echo'), { min: 0, max: 1, value: 0, label: 'ECHO', fmt: (v) => pct(v),
                onchange: (v) => { const c = ch(); c.echo = v; c.send.gain.setTargetAtTime(v * 0.9, A.ctx.currentTime, 0.03); updateVis(); },
                onend: (v) => emit(v > 0.05 ? ('le puso eco a ' + s.es + ' (' + pct(v) + '%)') : ('le sacó el eco a ' + s.es)) });
        });
        const m = document.createElement('div');
        m.className = 'lb-strip lb-master';
        m.innerHTML = `<div class="lb-meter"><i></i></div><div class="lb-name">MASTER</div>
            <div class="lb-knobs lb-knobs4"><div data-k="sweep"></div><div data-k="space"></div><div data-k="feedback"></div><div data-k="drive"></div></div>`;
        strips.appendChild(m);
        const mq = (k) => m.querySelector(`[data-k="${k}"]`);
        const mk = (k, opts, say) => { KNOBS['m_' + k] = makeKnob(mq(k), Object.assign(opts, { onchange: (v) => { if (!A.ctx) actx(); A.master[k] = v; applyMaster(); }, onend: (v) => emit(say(v)) })); };
        mk('sweep', { min: -1, max: 1, value: 0, label: 'SWEEP', fmt: fmtFilt }, (v) => Math.abs(v) < 0.04 ? 'abrió el filtro general' : ((v < 0 ? 'cerró todo con pasa-bajos al ' : 'barrió todo con pasa-altos al ') + pct(Math.abs(v)) + '%'));
        mk('space', { min: 0, max: 1, value: 0, label: 'SPACE', fmt: (v) => pct(v) }, (v) => v > 0.05 ? ('le puso reverb al ' + pct(v) + '%') : 'sacó la reverb');
        mk('feedback', { min: 0, max: 0.88, value: 0.35, label: 'FDBK', fmt: (v) => pct(v / 0.88) }, (v) => 'dejó el eco repitiendo al ' + pct(v / 0.88) + '%');
        mk('drive', { min: 0, max: 1, value: 0, label: 'DRIVE', fmt: (v) => pct(v) }, (v) => v > 0.05 ? ('distorsionó todo al ' + pct(v) + '%') : 'sacó la distorsión');

        const ph = $('#lb-phase');
        for (let i = 0; i < 16; i++) { const e = document.createElement('i'); if (i % 4 === 0) e.className = 'b'; ph.appendChild(e); }
    }

    function paintChrome(status) {
        const empty = $('#pl-empty'); if (empty) empty.hidden = S.tracks.length > 0;
        const ed = $('#pl-empty-dir'); if (ed) ed.textContent = S.dir || 'personal/lurk/tracks';
        const play = $('#lb-play');
        if (play) { play.textContent = status || (A.loading ? 'LOADING…' : (S.playing ? '■ STOP' : '▶ PLAY')); play.classList.toggle('on', S.playing); }
        const secs = $('#lb-sections');
        if (secs) {
            const keys = A.set ? Object.keys(A.set.sections) : [];
            const want = keys.map(k => k).join(',');
            if (secs.dataset.k !== want) {
                secs.dataset.k = want;
                secs.innerHTML = keys.length > 1 ? '<span class="lb-cap">SECTION</span>' + keys.map(k => `<button class="lb-btn lb-sec" data-sec="${k}" title="${k === 'build' ? 'A' : 'S'}">${k.toUpperCase()}</button>`).join('') : '';
            }
        }
        paintButtons();
    }
    function paintButtons() {
        const root = S.mounted; if (!root) return;
        root.querySelectorAll('.lb-sec').forEach(b => b.classList.toggle('on', b.dataset.sec === A.section));
        root.querySelectorAll('.lb-loop').forEach(b => b.classList.toggle('on', +b.dataset.bars === (A.loopBars || 0)));
        root.querySelectorAll('[data-mute]').forEach(b => b.classList.toggle('on', !!(A.ch[b.dataset.mute] && A.ch[b.dataset.mute].muted)));
        root.querySelectorAll('[data-solo]').forEach(b => b.classList.toggle('on', A.solo === b.dataset.solo));
        const c = $('#lb-chop'); if (c) c.classList.toggle('on', A.chopping);
    }
    function paintMeters() {
        const root = S.mounted; if (!root || !A.ctx) return;
        const pos = $('#lb-pos');
        if (A.set && S.playing) {
            const el = (A.ctx.currentTime - A.startedAt); const L = loopLen();
            const inLoop = ((el % L) + L) % L;
            const beat = Math.floor(inLoop / (A.set.bar / 4));
            if (pos) pos.textContent = 'BAR ' + (Math.floor(inLoop / A.set.bar) + 1) + ' · BEAT ' + (beat % 4 + 1) + ' · ' + A.set.bpm.toFixed(2) + ' BPM';
            const cells = root.querySelectorAll('#lb-phase i'), nCells = Math.min(Math.round(L / (A.set.bar / 4)), 16);
            cells.forEach((c, i) => { c.classList.toggle('now', i < nCells && i === beat % nCells); c.style.opacity = i < nCells ? 1 : 0.18; });
        } else if (pos) pos.textContent = A.set ? (A.setName.toUpperCase() + ' · ' + A.section.toUpperCase() + ' · ' + A.set.bpm.toFixed(2) + ' BPM') : '— · —';
        const meter = (an, data, sel) => {
            an.getByteTimeDomainData(data); let peak = 0;
            for (let i = 0; i < data.length; i++) { const d = Math.abs(data[i] - 128); if (d > peak) peak = d; }
            const bar = root.querySelector(sel); if (bar) bar.style.transform = 'scaleX(' + Math.min(1, peak / 128).toFixed(3) + ')';
        };
        STEMS.forEach(s => { const c = A.ch[s.id]; if (c) meter(c.an, c.data, '#lb-ch-' + s.id + ' .lb-meter i'); });
        if (A.m) meter(A.m.an, A.m.data, '.lb-master .lb-meter i');
    }

    // ── interaction ─────────────────────────────────────────────────────────
    function termAt(px, py) {
        let best = -1, bd = 34 * 34;
        for (let i = 0; i < S.terms.length; i++) {
            const tm = S.terms[i]; if (!tm.vis) continue;
            const dx = tm.x - px, dy = tm.y - py, dd = dx * dx + dy * dy;
            if (dd < bd) { bd = dd; best = i; }
        }
        return best;
    }
    // TSRCT parks focus in the global command bar (#pc-input) on every tab. An EMPTY
    // command bar is not "typing": the rack keys must still work. A non-empty one is.
    const typing = (e) => {
        const t = e.target; if (!t) return false;
        if (t.id === 'pc-input' && !t.value) return false;
        return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    };
    function setupInteraction() {
        const cv = S.canvas;
        cv.style.touchAction = 'manipulation';
        const rel = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        cv.addEventListener('pointermove', (e) => { const [x, y] = rel(e); S.hoverIdx = termAt(x, y); cv.style.cursor = S.hoverIdx >= 0 ? 'pointer' : 'default'; });
        cv.addEventListener('pointerleave', () => { S.hoverIdx = -1; });
        cv.addEventListener('click', (e) => { const [x, y] = rel(e); const i = termAt(x, y); if (i >= 0 && i !== S.current) loadTrack(i); });

        const root = S.mounted;
        root.querySelector('#pl-full').addEventListener('click', toggleFullscreen);
        root.querySelector('#lb-play').addEventListener('click', () => { actx(); togglePlay(); });
        root.querySelector('#lb-nullmute').addEventListener('click', muteNull);
        const chopBtn = root.querySelector('#lb-chop');
        chopBtn.addEventListener('pointerdown', () => { actx(); chop(true); });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => chopBtn.addEventListener(ev, () => chop(false)));
        root.querySelector('#lb-rack').addEventListener('click', (e) => {
            const b = e.target.closest('button'); if (!b) return;
            if (b.dataset.mute) toggleMute(b.dataset.mute);
            else if (b.dataset.solo) toggleSolo(b.dataset.solo);
            else if (b.dataset.bars != null && b.classList.contains('lb-loop')) setLoop(+b.dataset.bars);
            else if (b.dataset.sec) setSection(b.dataset.sec);
        });

        // Keys live only while LABS is mounted, in the capture phase so the global
        // terminal shortcuts (j/k/g scroll, / and i focus) never see them.
        S._key = (e) => {
            if (!S.mounted || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
            if (!S.mounted.offsetParent && !document.fullscreenElement) return;   // tab hidden
            const k = e.key.toLowerCase();
            let hit = true;
            if (e.code === 'Space') { if (!e.repeat) { actx(); togglePlay(); } }
            else if (k === 't') { if (!e.repeat) { actx(); chop(true); } }
            else if (k === 'm') { if (!e.repeat) muteNull(); }
            else if (k === 'a') { if (!e.repeat) setSection('build'); }
            else if (k === 's') { if (!e.repeat) setSection('drop'); }
            else if (LOOPS[k] != null) { if (!e.repeat) setLoop(LOOPS[k]); }
            else {
                const bm = STEMS.find(s => s.mute === k), bs = STEMS.find(s => s.solo === k);
                if (bm) { if (!e.repeat) toggleMute(bm.id); }
                else if (bs) { if (!e.repeat) toggleSolo(bs.id); }
                else hit = false;
            }
            if (hit) { e.preventDefault(); e.stopPropagation(); }
        };
        S._keyup = (e) => { if (e.key && e.key.toLowerCase() === 't') chop(false); };
        window.addEventListener('keydown', S._key, true);
        window.addEventListener('keyup', S._keyup, true);
    }
    function muteNull() {
        if (bc) { try { bc.postMessage({ type: 'null-mute-toggle', at: Date.now() }); } catch (e) { } }
        const b = $('#lb-nullmute'); if (b) { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 350); }
    }
    function toggleFullscreen() {
        const st = $('#pl-stage'); if (!st) return;
        if (document.fullscreenElement) { document.exitFullscreen && document.exitFullscreen(); }
        else { (st.requestFullscreen || st.webkitRequestFullscreen || (() => { })).call(st); }
    }

    // ── mount / unmount ───────────────────────────────────────────────────────
    function mount(el) { if (!el) return; if (S.mounted) unmount(); S.mounted = el; render(el); }
    function unmount() {
        if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
        if (S._resize) { window.removeEventListener('resize', S._resize); S._resize = null; }
        if (S._fs) { document.removeEventListener('fullscreenchange', S._fs); S._fs = null; }
        if (S._ro) { S._ro.disconnect(); S._ro = null; }
        if (S._key) { window.removeEventListener('keydown', S._key, true); S._key = null; }
        if (S._keyup) { window.removeEventListener('keyup', S._keyup, true); S._keyup = null; }
        stopAll(true);
        clearInterval(A.chopTimer);
        try { A.ctx && A.ctx.close(); } catch (e) { }
        A.ctx = null; A.m = null; A.ch = {}; A.buffers = {}; A.set = null; A.solo = null; A.chopping = false; A.loopBars = 0;
        A.master = { sweep: 0, space: 0, feedback: 0.35, drive: 0 };
        for (const k in visTarget) visTarget[k] = 0;
        GL.dispose();
        S.playing = false; S.hoverIdx = -1; S.mounted = null; S.current = -1; S.sceneStart = 0;
    }
    function playlistInit() { const el = document.getElementById('pc-playlist-body'); if (el) mount(el); }
    function playlistTeardown() { unmount(); }

    if (typeof WorldManager !== 'undefined') {
        WorldManager.rooms = WorldManager.rooms || {};
        WorldManager.rooms.playlist = {
            id: 'playlist-room', theme: 'navy', title: 'Labs',
            onOpen: () => { const el = document.querySelector('#playlist-room .playlist-mount'); if (el) mount(el); },
            onClose: () => unmount(),
        };
    }

    Object.assign(window, {
        playlistInit, playlistTeardown,
        playlistToggle: () => { actx(); togglePlay(); },
        playlistRefresh: loadList,
        playlistFullscreen: toggleFullscreen,
    });
})();
