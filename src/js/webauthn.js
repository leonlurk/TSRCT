// ==============================================
// TSRCT - WebAuthn / Windows Hello
// Primary login path. Your face (or fingerprint/PIN) is both factors at once:
// possession of the TPM-bound key + user verification. The master-token + TOTP
// form stays as the fallback, so a covered camera or a new machine can never
// lock the owner out of his own box.
//
// Credentials are ORIGIN-BOUND. A key enrolled at the ts.net hostname will not
// answer a challenge at localhost -- so each origin needs its own enrolment,
// and the launcher should always open the same URL.
// ==============================================
(function () {

    // ── base64url <-> ArrayBuffer (what WebAuthn speaks vs what JSON does) ──
    function b2b(b64) {
        const s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out.buffer;
    }
    function b2s(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function post(path, body) {
        return fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ origin: location.origin }, body || {})),
        }).then(r => r.json().then(d => ({ ok: r.ok, d })));
    }

    function say(msg, kind) { if (typeof toast === 'function') toast(msg, kind || 'info'); }

    // Windows says "Hello", Android says fingerprint. Same WebAuthn platform
    // authenticator underneath; only the wording changes.
    function unlockLabel() {
        const ua = navigator.userAgent || '';
        if (/Android/i.test(ua)) return '> UNLOCK WITH FINGERPRINT';
        if (/iPhone|iPad|iPod/i.test(ua)) return '> UNLOCK WITH FACE ID';
        return '> UNLOCK WITH WINDOWS HELLO';
    }
    function isHandheld() {
        return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 900;
    }

    function whSupported() {
        return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
    }

    // Is there a real platform authenticator (Windows Hello) on this machine?
    async function platformAvailable() {
        if (!whSupported()) return false;
        try {
            return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        } catch (e) { return false; }
    }

    let whFailures = 0;

    // ── Login ───────────────────────────────────────────────────────────
    async function whLogin() {
        const btn = document.getElementById('auth-hello-btn');
        if (btn) { btn.disabled = true; btn.textContent = '> WAITING...'; }
        try {
            const { d: opts } = await post('/api/auth/webauthn/login/options');
            if (!opts.allowCredentials || !opts.allowCredentials.length) {
                say('No fingerprint or face is registered for this address', 'warn');
                whShowFallback();
                return false;
            }
            const assertion = await navigator.credentials.get({
                publicKey: {
                    challenge: b2b(opts.challenge),
                    rpId: opts.rpId,
                    timeout: opts.timeout,
                    userVerification: 'required',
                    allowCredentials: opts.allowCredentials.map(c => ({ id: b2b(c.id), type: 'public-key' })),
                },
            });
            const r = assertion.response;
            const { ok, d } = await post('/api/auth/webauthn/login/verify', {
                challenge: opts.challenge,
                id: b2s(assertion.rawId),
                clientDataJSON: b2s(r.clientDataJSON),
                authenticatorData: b2s(r.authenticatorData),
                signature: b2s(r.signature),
                // No trusted-device token on purpose. A device token would let
                // the next session start WITHOUT the face, which defeats the
                // point: the face is the gate between TSRCT sessions. Losing a
                // session (server restart) must cost exactly one look at the
                // camera. The 2FA form keeps its own "trust this device" box
                // for the phone, which has no Hello.
                remember: false,
            });
            if (!ok || !d.session) {
                say(d.error === 'locked' ? 'Demasiados intentos - bloqueado' : 'Biometria rechazada', 'error');
                whShowFallback();
                return false;
            }
            token = d.session;
            localStorage.setItem('cbt', token);
            if (d.device) localStorage.setItem('cbt_device', d.device);
            if (typeof playSound === 'function') { window.__authChimeDone = true; playSound('unlock'); }
            if (typeof connect === 'function') connect();
            return true;
        } catch (e) {
            // NotAllowedError = cancelled or timed out. Not an error worth shouting about.
            if (e && e.name !== 'NotAllowedError') say('Biometria fallo: ' + (e.name || 'error'), 'error');
            // Safety valve: if the biometric cannot complete, disarm the boot
            // gate so the next open is not stuck behind a lock that never opens.
            whFailures++;
            if (whFailures >= 2) {
                try { localStorage.removeItem('tsrct_biometric_lock'); } catch (e2) {}
                say('candado biometrico desactivado - usa token + 2FA', 'warn');
            }
            whShowFallback();
            return false;
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = unlockLabel(); }
        }
    }

    // ── Enrolment (requires an already-authenticated session) ────────────
    async function whEnroll() {
        if (!await platformAvailable()) { say('This device has no fingerprint or face unlock', 'warn'); return false; }
        try {
            const { ok: optOk, d: opts } = await post('/api/auth/webauthn/register/options');
            if (!optOk) { say('Enrol failed: ' + (opts.error || 'server'), 'error'); return false; }
            const cred = await navigator.credentials.create({
                publicKey: {
                    challenge: b2b(opts.challenge),
                    rp: opts.rp,
                    user: {
                        id: b2b(opts.user.id),
                        name: opts.user.name,
                        displayName: opts.user.displayName,
                    },
                    pubKeyCredParams: opts.pubKeyCredParams,
                    authenticatorSelection: opts.authenticatorSelection,
                    attestation: opts.attestation,
                    timeout: opts.timeout,
                    excludeCredentials: (opts.excludeCredentials || []).map(c => ({ id: b2b(c.id), type: 'public-key' })),
                },
            });
            const r = cred.response;
            const { ok, d } = await post('/api/auth/webauthn/register/verify', {
                challenge: opts.challenge,
                clientDataJSON: b2s(r.clientDataJSON),
                attestationObject: b2s(r.attestationObject),
                label: (navigator.userAgent || '').slice(0, 60),
            });
            if (!ok) { say('Enrol failed: ' + (d.error || 'rejected'), 'error'); return false; }
            if (isHandheld()) {
                try { localStorage.setItem('tsrct_biometric_lock', '1'); } catch (e) {}
            }
            say(isHandheld() ? 'FINGERPRINT ENABLED' : 'WINDOWS HELLO ENABLED', 'success');
            return true;
        } catch (e) {
            if (e && e.name === 'InvalidStateError') { say('Already enrolled on this device', 'info'); return true; }
            if (e && e.name !== 'NotAllowedError') say('Enrol failed: ' + (e.name || 'error'), 'error');
            return false;
        }
    }

    // ── Auth-screen wiring ──────────────────────────────────────────────
    function whShowFallback() {
        const f = document.getElementById('auth-form');
        const alt = document.getElementById('auth-fallback-link');
        if (f) f.classList.remove('hidden');
        if (alt) alt.classList.add('hidden');
    }

    // Decide which login surface the auth card shows. The 2FA form is what the
    // page ships with, so a JS failure here degrades to the old behaviour
    // instead of locking the door.
    async function whInit() {
        if (!whSupported()) return;
        const block = document.getElementById('auth-hello-block');
        if (!block) return;
        if (!await platformAvailable()) return;

        // Show the unlock button as soon as the DEVICE can do biometrics. It
        // used to appear only after the server confirmed an enrolled key, so a
        // single failed/slow request left a phone with no way in but a master
        // token it does not have. The tap itself re-checks with the server.
        block.classList.remove('hidden');
        const btn = document.getElementById('auth-hello-btn');
        if (btn) btn.textContent = unlockLabel();

        try {
            const { d: opts } = await post('/api/auth/webauthn/login/options');
            if (!opts.allowCredentials || !opts.allowCredentials.length) {
                // No passkey here: make sure the boot gate is OFF, or a deleted
                // credential would lock the phone out of its own app. The 2FA
                // form stays visible so there is always a way in.
                try { localStorage.removeItem('tsrct_biometric_lock'); } catch (e) {}
                return;
            }
            if (isHandheld()) {
                // Arm the synchronous boot gate in app.js for every future open.
                let wasArmed = false;
                try {
                    wasArmed = localStorage.getItem('tsrct_biometric_lock') === '1';
                    localStorage.setItem('tsrct_biometric_lock', '1');
                } catch (e) {}
                // First load after arming: the gate had nothing to act on yet,
                // so this window is still logged in. Lock it now rather than
                // granting one last free pass. Only THEN: once armed, a token
                // that survived the boot gate is inside its grace window (a
                // reload from the logo), and relocking here undid that grace
                // on every refresh (2026-10-07).
                if (token && !wasArmed) { relock(); return; }
            }
            const form = document.getElementById('auth-form');
            const alt = document.getElementById('auth-fallback-link');
            if (form) form.classList.add('hidden');
            if (alt) alt.classList.remove('hidden');
            // A passkey exists for this origin, so the 30-day "trust this device"
            // token must not be minted behind its back -- it is precisely what
            // lets the app open WITHOUT the biometric.
            const rem = document.getElementById('auth-remember');
            if (rem) { rem.checked = false; rem.parentElement.classList.add('hidden'); }
        } catch (e) {
            // On a phone there is no console to read, so surface it.
            say('biometria: fallo al consultar (' + (e && e.name || 'error') + ')', 'warn');
        }
    }

    // Offered once after a successful token+TOTP login, so enrolment is a
    // prompt you accept rather than a settings page you have to find.
    async function whMaybeOfferEnroll() {
        if (!await platformAvailable()) return;
        if (localStorage.getItem('wh_declined') === '1') return;
        try {
            const r = await fetch('/api/auth/webauthn/credentials');
            const d = await r.json();
            const here = (d.credentials || []).some(c => c.origin === location.origin);
            if (here) return;
        } catch (e) { return; }
        const ask = isHandheld()
            ? 'Enable fingerprint unlock for TSRCT?\n\nEvery time you open the app you unlock it with your thumb instead of the token + 2FA code.'
            : 'Enable Windows Hello for TSRCT?\n\nNext time you can unlock with your face instead of the token + 2FA code.';
        if (!confirm(ask)) {
            localStorage.setItem('wh_declined', '1');
            return;
        }
        whEnroll();
    }

    // ── Re-lock: biometric on every real open ───────────────────────────
    // A session slides forward while the app is in use and survives being
    // backgrounded, so reopening TSRCT would let you straight back in. On a
    // handheld with a passkey enrolled, coming back after a real absence ends
    // the session for good (server-side, not just visually) and asks for the
    // fingerprint. A quick glance away (under the grace period) does not.
    const RELOCK_AFTER_MS = 30000;
    let hiddenAt = 0;
    let relocking = false;

    async function relock() {
        if (relocking || !token) return;
        relocking = true;
        try {
            const dev = localStorage.getItem('cbt_device');
            // Revoke the session AND any lingering 30-day device token, or the
            // next open would silently restore instead of asking for the thumb.
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: token || '' },
                body: JSON.stringify({ device: dev || undefined }),
            });
        } catch (e) {}
        token = '';
        localStorage.removeItem('cbt');
        localStorage.removeItem('cbt_device');
        const auth = document.getElementById('auth');
        const app = document.getElementById('app');
        const qb = document.getElementById('quick-bar');
        if (auth) auth.classList.remove('hidden');
        if (app) app.classList.add('hidden');
        if (qb) qb.classList.add('hidden');
        await whInit();
        relocking = false;
    }

    async function shouldRelock() {
        if (!isHandheld() || !whSupported()) return false;
        try {
            const r = await fetch('/api/auth/webauthn/login/options', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ origin: location.origin }),
            });
            const d = await r.json();
            // Only lock if there is a passkey to unlock WITH -- otherwise this
            // would force a token + 2FA code every time, which is worse.
            return !!(d.allowCredentials && d.allowCredentials.length);
        } catch (e) { return false; }
    }

    // The same grace has to survive a PAGE LOAD, because backgrounding a PWA on
    // Android frequently kills it -- the return trip is then a cold start that
    // never reaches the visibilitychange handler and lands on app.js's boot gate.
    // So stamp "last seen" on a heartbeat while visible and on the way out; the
    // boot gate reads it and skips the lock inside RELOCK_AFTER_MS. The heartbeat
    // (not just the hide stamp) is what keeps a manual refresh from costing a thumb.
    function markSeen() { try { localStorage.setItem('tsrct_last_seen', String(Date.now())); } catch (e) {} }
    markSeen();
    setInterval(() => { if (!document.hidden) markSeen(); }, 10000);
    window.addEventListener('pagehide', markSeen);

    document.addEventListener('visibilitychange', async () => {
        if (document.hidden) { hiddenAt = Date.now(); markSeen(); return; }
        if (!hiddenAt || Date.now() - hiddenAt < RELOCK_AFTER_MS) return;
        hiddenAt = 0;
        if (await shouldRelock()) relock();
    });

    document.addEventListener('DOMContentLoaded', whInit);

    window.whInit = whInit;
    window.whLogin = whLogin;
    window.whEnroll = whEnroll;
    window.whShowFallback = whShowFallback;
    window.whMaybeOfferEnroll = whMaybeOfferEnroll;
    window.whSupported = whSupported;
    window.whRelock = relock;

})();
