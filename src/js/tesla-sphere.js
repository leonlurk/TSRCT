// ─────────────────────────────────────────────────────────────────────────
// tesla-sphere.js — Tesla, drawn: the "plasma core" (2026-10-24). A living ball
// of light: currents of energy move under a glowing rim, a halo around it, and
// her voice pushes out from the middle. He picked it ("B") from four looks built
// in Three.js, additive light.
//
// Her STATE drives it, every change eased, never cut:
//   idle    breathes slowly, the currents drift
//   listen  the surface ripples, the core opens (cyan): she is waiting on HIM
//   think   the currents swirl around the axis (amber)
//   speak   the ball swells in syllables and the veins brighten (neon)
//
// COST (measured): the motion is in
// the shaders, so the CPU does three draw calls a frame. 30 frames a second at
// most; nothing at all while it is not shown or the tab is hidden; one still
// frame per state with prefers-reduced-motion. It re-renders at its box's real
// size whenever that box changes (full screen, rotation), not only on a window
// resize: a full screen drawn at the panel's size was blurry. Colours come from
// the theme tokens (--cyan, --neon, --amber), so the navy theme recolours her
// too. Fails soft without THREE or WebGL: there is simply no sphere (this copy
// ships no three.js, so the box hides itself unless a page loads THREE).
//
//   const s = TeslaSphere.mount(el);   s.state('think');   s.run(true|false);
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const FPS = 30;
    const MODES = { idle: 0, listen: 1, think: 2, speak: 3 };

    // Simplex noise (Ashima Arts / Stefan Gustavson, MIT licence).
    const NOISE = `
        vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
        vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
        vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
        vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
        float snoise(vec3 v){
            const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
            vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
            vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
            vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
            i=mod289(i);
            vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
            float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
            vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
            vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
            vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
            vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
            vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
            vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
            vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
            p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
            vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
            return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
        }`;

    // The surface moves a little with the noise, ripples when she listens, and
    // swells in waves when she speaks.
    const VERT = NOISE + `
        uniform float uTime, uRipple, uPulse;
        varying vec3 vN; varying vec3 vP; varying float vD;
        void main() {
            vec3 p = position;
            float d = snoise(p * 2.2 + vec3(0.0, uTime * 0.35, 0.0));
            float w = sin(uTime * 9.0 - p.y * 6.0) * 0.5 + 0.5;
            p *= 1.0 + d * (0.03 + uRipple * 0.07) + uPulse * w * 0.06;
            vD = d; vP = position; vN = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`;
    // Light: a rim where the ball turns away, veins of energy that drift (and
    // swirl when she thinks), brighter while she speaks.
    const FRAG = NOISE + `
        uniform float uTime, uSwirl, uPulse;
        uniform vec3 uColor;
        varying vec3 vN; varying vec3 vP; varying float vD;
        void main() {
            float rim = pow(1.0 - abs(vN.z), 2.4);
            float a = uSwirl * uTime * 1.4 + vP.y * 2.0 * uSwirl;
            vec3 q = vP;
            q.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * q.xz;
            float n = snoise(q * 3.0 + vec3(uTime * 0.25));
            float veins = smoothstep(0.55, 1.0, 1.0 - abs(n)) * 0.9;
            float inner = 0.18 + 0.25 * (vD * 0.5 + 0.5);
            vec3 c = uColor * (inner * 0.55 + veins * (0.45 + uPulse * 0.55)) + uColor * rim * 1.1 + vec3(1.0) * pow(rim, 6.0) * 0.3;
            gl_FragColor = vec4(c, 0.75);
        }`;

    function token(name, fallback) {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return v || fallback;
        } catch (e) { return fallback; }
    }
    function glowTexture() {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const g = c.getContext('2d');
        const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grd.addColorStop(0, 'rgba(255,255,255,1)');
        grd.addColorStop(0.3, 'rgba(255,255,255,0.45)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
        return new THREE.CanvasTexture(c);
    }

    function mount(el) {
        const none = { state() {}, run() {}, ok: false };
        if (!el || typeof THREE === 'undefined') { if (el) el.classList.add('lost'); return none; }
        const canvas = document.createElement('canvas');
        canvas.className = 'asst-sphere-c';
        let r;
        try {
            r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
        } catch (e) { return none; }
        r.setClearColor(0x000000, 0);
        el.appendChild(canvas);

        const scene = new THREE.Scene();
        const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 20);
        cam.position.set(0, 0, 5.2);

        const colors = {
            idle: new THREE.Color(token('--cyan', '#00d4ff')),
            listen: new THREE.Color(token('--cyan', '#00d4ff')),
            think: new THREE.Color(token('--amber', '#ffb000')),
            speak: new THREE.Color(token('--neon', '#00ff41')),
        };
        const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
        const u = {
            uTime: { value: 0 }, uRipple: { value: 0 }, uSwirl: { value: 0 }, uPulse: { value: 0 },
            uColor: { value: colors.idle.clone() },
        };
        const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 48),
            new THREE.ShaderMaterial(Object.assign({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG }, add)));
        const tex = glowTexture();
        const glow = (scale, op) => {
            const s = new THREE.Sprite(new THREE.SpriteMaterial(Object.assign({ map: tex, color: u.uColor.value, opacity: op }, add)));
            s.scale.set(scale, scale, 1);
            return s;
        };
        const halo = glow(3.4, 0.22), core = glow(1.2, 0.45);
        scene.add(halo, ball, core);

        // What the uniforms ease toward, per state.
        const TARGET = {
            idle:   { breath: 1, ripple: 0.15, swirl: 0, pulse: 0, core: 0.38 },
            listen: { breath: 0.6, ripple: 1, swirl: 0, pulse: 0, core: 0.75 },
            think:  { breath: 0.3, ripple: 0.35, swirl: 1, pulse: 0, core: 0.55 },
            speak:  { breath: 0.4, ripple: 0.25, swirl: 0, pulse: 1, core: 0.7 },
        };
        let mode = 'idle', cur = Object.assign({}, TARGET.idle), running = false, raf = 0, last = 0, t = 0;
        const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let w0 = 0, h0 = 0;
        function size() {
            const w = el.clientWidth, h = el.clientHeight;
            if (!w || !h || (w === w0 && h === h0)) return;
            w0 = w; h0 = h;
            r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
            r.setSize(w, h, false);
            cam.aspect = w / h; cam.updateProjectionMatrix();
            if (still && running) step(1);
        }
        function step(dt) {
            const tg = TARGET[mode], k = Math.min(1, dt * 3);
            for (const key in tg) cur[key] += (tg[key] - cur[key]) * k;
            t += dt;
            // speaking: the waves come in syllables, not as a steady hum
            const syll = 0.55 + 0.45 * Math.abs(Math.sin(t * 5.3) * Math.sin(t * 2.1 + 1));
            u.uTime.value = t;
            u.uRipple.value = cur.ripple; u.uSwirl.value = cur.swirl; u.uPulse.value = cur.pulse * syll;
            u.uColor.value.lerp(colors[mode], k);
            halo.material.color.copy(u.uColor.value); core.material.color.copy(u.uColor.value);
            core.material.opacity = cur.core * 0.9;
            ball.scale.setScalar(1 + cur.breath * Math.sin(t * 1.1) * 0.02 + cur.pulse * syll * 0.04);
            halo.scale.setScalar(3.2 + cur.pulse * syll * 0.6);
            ball.rotation.y += dt * 0.15;
            r.render(scene, cam);
        }
        function frame(now) {
            raf = 0;
            if (!running || document.hidden) return;
            raf = requestAnimationFrame(frame);
            if (now - last < 1000 / FPS - 2) return;
            const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / FPS;
            last = now;
            step(dt);
        }
        function kick() { if (running && !raf && !still) { last = 0; raf = requestAnimationFrame(frame); } }
        document.addEventListener('visibilitychange', kick);
        if (window.ResizeObserver) new ResizeObserver(size).observe(el);
        else window.addEventListener('resize', size);
        canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); running = false; el.classList.add('lost'); });

        return {
            ok: true,
            state(m) {
                const next = MODES[m] !== undefined ? m : 'idle';
                if (next === mode) return;
                mode = next;
                if (still && running) { cur = Object.assign({}, TARGET[mode]); u.uColor.value.copy(colors[mode]); step(1); }
            },
            run(on) {
                on = !!on;
                if (on === running) return;
                running = on;
                if (!on) { if (raf) cancelAnimationFrame(raf); raf = 0; return; }
                w0 = h0 = 0;
                size();
                if (still) { cur = Object.assign({}, TARGET[mode]); u.uColor.value.copy(colors[mode]); step(1); return; }
                kick();
            },
        };
    }

    window.TeslaSphere = { mount };
})();
