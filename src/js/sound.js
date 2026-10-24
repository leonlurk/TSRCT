// ==============================================
// TSRCT - Sound and haptics
// The synthesized sound bus (playSound) and vibration patterns (vibe) every module
// uses. Cut out of main.js verbatim (cleanup round 4, 2026-10-24); it loads just
// before main.js, so playSound exists before any module can call it.
// ==============================================
(function () {
        // ═══════════════════════════════════════════════════════════
        // SOUND & HAPTICS SYSTEM
        // ═══════════════════════════════════════════════════════════
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // ═══════════════════════════════════════════════════════════
        // SOUND ENGINE
        // Every sound is synthesised -- no asset files, no network, no deps.
        //
        // Why the old set sounded cheap, and what replaced it:
        //  - Gain jumped 0 -> peak instantly, which is a CLICK on every sound.
        //    Everything now opens over a few ms and closes exponentially.
        //  - Raw un-filtered oscillators (a sawtooth for 'error') are buzzy.
        //    Every voice is lowpassed, most with a moving cutoff.
        //  - No shared bus: levels drifted 0.05..0.15 and nothing was tamed.
        //    All voices now land on one bus -> limiter -> out.
        //  - No space. A short synthesised reverb gives the set a body that
        //    dry beeps cannot have.
        //  - Frequencies were arbitrary. They now come from ONE tuning (A minor,
        //    root A=220), so the whole system sounds like one instrument.
        // ═══════════════════════════════════════════════════════════

        // Pitch table -- everything below is built from these, so the sounds
        // are consonant with each other by construction.
        const NOTE = {
            A2: 110.00, E3: 164.81, A3: 220.00, C4: 261.63, D4: 293.66,
            E4: 329.63, G4: 392.00, A4: 440.00, B4: 493.88, C5: 523.25,
            D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.00, C6: 1046.50,
            E6: 1318.51,
        };

        let bus = null;      // { dry, verb } -- built on first use
        let noiseBuf = null;

        function buildBus() {
            if (bus) return bus;
            const master = audioCtx.createGain();
            master.gain.value = 0.9;
            // Soft limiter: keeps a layered sound from clipping and holds the
            // whole set at a consistent perceived level.
            const limiter = audioCtx.createDynamicsCompressor();
            limiter.threshold.value = -12;
            limiter.knee.value = 12;
            limiter.ratio.value = 4;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.15;
            master.connect(limiter).connect(audioCtx.destination);

            // Small synthesised room. Decaying noise as an impulse response --
            // no .wav to ship, and it is what stops the set sounding like a toy.
            const len = Math.floor(audioCtx.sampleRate * 1.1);
            const ir = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
            for (let ch = 0; ch < 2; ch++) {
                const d = ir.getChannelData(ch);
                for (let i = 0; i < len; i++) {
                    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
                }
            }
            const conv = audioCtx.createConvolver();
            conv.buffer = ir;
            // Darken the tail; a bright reverb on UI sounds reads as hiss.
            const tone = audioCtx.createBiquadFilter();
            tone.type = 'lowpass';
            tone.frequency.value = 3200;
            const verbGain = audioCtx.createGain();
            verbGain.gain.value = 0.9;
            conv.connect(tone).connect(verbGain).connect(master);

            bus = { dry: master, verb: conv };
            return bus;
        }

        function getNoise() {
            if (noiseBuf) return noiseBuf;
            const len = Math.floor(audioCtx.sampleRate * 0.5);
            noiseBuf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
            const d = noiseBuf.getChannelData(0);
            for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
            return noiseBuf;
        }

        // One tuned voice. attack is never 0 -- that is the anti-click rule.
        function voice(o) {
            const b = buildBus();
            const t0 = o.t0, dur = o.dur;
            const osc = audioCtx.createOscillator();
            osc.type = o.type || 'sine';
            osc.frequency.setValueAtTime(o.f0, t0);
            if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + (o.glide || dur));
            if (o.detune) osc.detune.setValueAtTime(o.detune, t0);

            let node = osc;
            if (o.lp) {
                const f = audioCtx.createBiquadFilter();
                f.type = 'lowpass';
                f.frequency.setValueAtTime(o.lp, t0);
                if (o.lp1) f.frequency.exponentialRampToValueAtTime(o.lp1, t0 + dur);
                f.Q.value = o.q || 0.7;
                node.connect(f);
                node = f;
            }
            const g = audioCtx.createGain();
            const atk = o.attack != null ? o.attack : 0.006;
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.linearRampToValueAtTime(o.gain, t0 + atk);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            node.connect(g);
            g.connect(b.dry);
            if (o.send) {
                const s = audioCtx.createGain();
                s.gain.value = o.send;
                g.connect(s).connect(b.verb);
            }
            osc.start(t0);
            osc.stop(t0 + dur + 0.03);
        }

        // Filtered noise -- the transient that makes a click read as a physical
        // event rather than a beep.
        function nvoice(o) {
            const b = buildBus();
            const t0 = o.t0, dur = o.dur;
            const src = audioCtx.createBufferSource();
            src.buffer = getNoise();
            const f = audioCtx.createBiquadFilter();
            f.type = o.filter || 'bandpass';
            f.frequency.setValueAtTime(o.f0, t0);
            if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + dur);
            f.Q.value = o.q || 1.2;
            const g = audioCtx.createGain();
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.linearRampToValueAtTime(o.gain, t0 + (o.attack != null ? o.attack : 0.003));
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            src.connect(f).connect(g);
            g.connect(b.dry);
            if (o.send) {
                const s = audioCtx.createGain();
                s.gain.value = o.send;
                g.connect(s).connect(b.verb);
            }
            src.start(t0);
            src.stop(t0 + dur + 0.03);
        }

        // ── The set ─────────────────────────────────────────────────────────
        const SOUNDS = {
            // Ambient interaction: quiet, fast, never in the way.
            tap(t) {
                // A tick, not a knock. The old recipe was an 18ms BANDPASSED noise
                // burst at 2.6kHz -- straight into a phone speaker's resonant band,
                // where it reads as a woodblock (fine through laptop speakers, which
                // is why it passed). Now the transient is HIGHPASSED air with no mid
                // content at all, under a short glassy pip an octave up.
                nvoice({ t0: t, dur: 0.012, f0: 6500, f1: 11000, gain: 0.055, filter: 'highpass', q: 0.4 });
                voice({ t0: t, dur: 0.045, f0: NOTE.E6, gain: 0.045, lp: 9000, send: 0.16 });
            },
            press(t) {
                // Every button press on a handheld. Deliberately the quietest voice
                // in the set: it sits UNDER whatever outcome sound follows (send,
                // approve, error) rather than competing with it.
                nvoice({ t0: t, dur: 0.008, f0: 6000, f1: 9500, gain: 0.032, filter: 'highpass', q: 0.4 });
                voice({ t0: t, dur: 0.028, f0: NOTE.A5, gain: 0.028, lp: 8500, send: 0.10 });
            },
            swipe(t) {
                nvoice({ t0: t, dur: 0.10, f0: 700, f1: 3200, gain: 0.20, filter: 'bandpass', q: 0.8 });
            },
            mode(t) {   // was CALLED but never defined -- silent until now
                nvoice({ t0: t, dur: 0.02, f0: 1800, gain: 0.14 });
                voice({ t0: t, dur: 0.09, f0: NOTE.D5, gain: 0.075, lp: 3000, send: 0.1 });
            },
            send(t) {
                // A bandpassed noise sweep through the low-mids is exactly the
                // shape of a raspberry -- that was the "fart". Replaced with
                // HIGHpassed air (no low-mid content at all) over a short
                // upward tick, so it reads as dispatch, not flatulence.
                nvoice({ t0: t, dur: 0.055, f0: 4200, f1: 9000, gain: 0.10, filter: 'highpass', q: 0.5 });
                voice({ t0: t, dur: 0.085, f0: NOTE.E5, f1: NOTE.A5, glide: 0.06, gain: 0.055, lp: 6500, send: 0.12 });
                voice({ t0: t + 0.02, dur: 0.10, f0: NOTE.A5, gain: 0.03, lp: 7500, send: 0.18 });
            },

            // Decisions: approve/accept read as one family, deny as its answer.
            approve(t) {
                voice({ t0: t, dur: 0.09, f0: NOTE.E5, gain: 0.07, lp: 5200, send: 0.15 });
                voice({ t0: t + 0.055, dur: 0.13, f0: NOTE.A5, gain: 0.06, lp: 6000, send: 0.2 });
            },
            accept(t) { // was CALLED but never defined -- silent until now
                voice({ t0: t, dur: 0.16, f0: NOTE.A4, gain: 0.085, lp: 4000, send: 0.18 });
                voice({ t0: t, dur: 0.16, f0: NOTE.E5, gain: 0.04, detune: 4, lp: 4000, send: 0.18 });
            },
            deny(t) {
                // A decision, not a fault: muted and low, with no buzz.
                voice({ t0: t, dur: 0.22, f0: NOTE.E3, f1: NOTE.A2, gain: 0.10, type: 'triangle', lp: 900, lp1: 400, send: 0.12 });
                voice({ t0: t, dur: 0.14, f0: NOTE.A2, gain: 0.07, lp: 500 });
            },

            // The one Leon called cheap. Rebuilt as a weighted, damped fall:
            // a low body thump, a soft transient, and a descending minor third
            // under a closing filter. Dark and short -- never a sawtooth buzz.
            error(t) {
                nvoice({ t0: t, dur: 0.05, f0: 320, gain: 0.05, filter: 'lowpass', q: 0.7 });
                voice({ t0: t, dur: 0.30, f0: NOTE.A2, gain: 0.11, type: 'sine', lp: 600 });
                voice({ t0: t, dur: 0.55, f0: NOTE.E4, f1: NOTE.C4, glide: 0.20, gain: 0.085,
                        type: 'triangle', lp: 1500, lp1: 600, attack: 0.008, send: 0.3 });
                voice({ t0: t + 0.008, dur: 0.50, f0: NOTE.A3, gain: 0.045, type: 'sine', lp: 1200, send: 0.25 });
            },
            warning(t) {
                voice({ t0: t, dur: 0.13, f0: NOTE.D5, gain: 0.06, type: 'triangle', lp: 2400, send: 0.18 });
                voice({ t0: t + 0.16, dur: 0.20, f0: NOTE.D5, gain: 0.055, type: 'triangle', lp: 2000, send: 0.22 });
            },

            // Confirmations: root -> fifth -> octave. Resolved, not cheesy.
            success(t) {
                [NOTE.A4, NOTE.E5, NOTE.A5].forEach((f, i) => {
                    const at = t + i * 0.07;
                    voice({ t0: at, dur: 0.30, f0: f, gain: 0.06, lp: 3600, lp1: 6000, send: 0.25 });
                    voice({ t0: at, dur: 0.30, f0: f, gain: 0.025, detune: 6, lp: 5000, send: 0.25 });
                });
            },
            complete(t) {
                // A long task landing: a slow swell, not a click.
                [NOTE.A3, NOTE.E4, NOTE.A4, NOTE.C5].forEach((f, i) => {
                    voice({ t0: t + i * 0.045, dur: 0.75, f0: f, gain: 0.05,
                            attack: 0.035, lp: 2600, lp1: 4200, send: 0.4 });
                });
            },
            unlock(t) {
                // Access granted -- what Windows Hello should feel like.
                voice({ t0: t, dur: 0.20, f0: NOTE.A3, gain: 0.06, lp: 1600 });
                voice({ t0: t + 0.03, dur: 0.45, f0: NOTE.A5, gain: 0.05, lp: 7000, send: 0.35 });
                voice({ t0: t + 0.10, dur: 0.50, f0: NOTE.E6, gain: 0.035, lp: 8000, send: 0.4 });
            },

            // Attention. 'permission' is TSRCT's signature event, so it is the
            // only sound that repeats -- it has to carry from another room.
            notify(t) {
                voice({ t0: t, dur: 0.45, f0: NOTE.C6, gain: 0.08, lp: 7000, send: 0.35 });
                voice({ t0: t, dur: 0.30, f0: NOTE.E6, gain: 0.02, lp: 8000, send: 0.3 });
            },
            permission(t) {
                for (let r = 0; r < 2; r++) {
                    const at = t + r * 0.19;
                    nvoice({ t0: at, dur: 0.02, f0: 3000, gain: 0.03 });
                    voice({ t0: at, dur: 0.13, f0: NOTE.D5, gain: 0.065, lp: 5000, send: 0.2 });
                    voice({ t0: at + 0.075, dur: 0.26, f0: NOTE.A5, gain: 0.06, lp: 6500, send: 0.3 });
                }
            },

            // Session lifecycle.
            connect(t) {
                [NOTE.A3, NOTE.E4, NOTE.A4].forEach((f, i) => {
                    voice({ t0: t + i * 0.05, dur: 0.26, f0: f, gain: 0.05, lp: 2200, lp1: 4500, send: 0.22 });
                });
            },
            disconnect(t) {
                [NOTE.A4, NOTE.E4, NOTE.A3].forEach((f, i) => {
                    voice({ t0: t + i * 0.06, dur: 0.30, f0: f, gain: 0.05, type: 'triangle',
                            lp: 1800, lp1: 700, send: 0.2 });
                });
            },
        };

        // Vibration patterns (ms) -- one per sound, tap as the fallback.
        const vibePatterns = {
            tap: [6], press: [4], swipe: [4], mode: [6], send: [5, 25, 8],
            approve: [6], accept: [8], deny: [25],
            error: [18, 50, 30], warning: [12, 40, 12],
            success: [8, 40, 12], complete: [10, 60, 10, 60, 16], unlock: [6, 30, 14],
            notify: [10, 50, 6], permission: [12, 60, 12, 60, 12],
            connect: [6, 30, 10], disconnect: [16, 40, 8],
        };

        // Play haptic feedback
        function vibe(pattern = 'tap') {
            if (navigator.vibrate && soundEnabled) {
                navigator.vibrate(vibePatterns[pattern] || vibePatterns.tap);
            }
        }

        // Synth sound generator
        function playSound(type = 'tap') {
            if (!soundEnabled) return;

            // Resume audio context if suspended (mobile requirement)
            if (audioCtx.state === 'suspended') audioCtx.resume();

            // Unknown names fall back to 'tap' rather than going silent -- that
            // is how 'accept' and 'mode' were dead for as long as they were.
            const make = SOUNDS[type] || SOUNDS.tap;
            try { make(audioCtx.currentTime + 0.005); } catch (e) {}

            // Vibrate too
            vibe(type);
        }

        // Toggle sounds
        function toggleSound() {
            soundEnabled = !soundEnabled;
            localStorage.setItem('soundEnabled', soundEnabled);
            updateSoundButton();
            if (soundEnabled) playSound('success');
            toast(soundEnabled ? 'SOUNDS ON' : 'SOUNDS OFF', 'success', false);
        }

        function updateSoundButton() {
            const btn = $('sound-toggle');
            if (btn) btn.classList.toggle('muted', !soundEnabled);
        }

        Object.assign(window, {
            playSound, toggleSound, updateSoundButton, vibe,
        });

})();
