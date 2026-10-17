'use strict';
// 2FA login, WebAuthn / Windows Hello, logout, enrolment.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (authState) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    // ── 2FA auth endpoints ──────────────────────────────────────────────
    function postAuthLogin(req, res, pathname, auth) {
        const { AUTH_TOKEN, LOGIN_LOCK_MS, NOT_MINE, SESSION_TTL_MS, clearLoginFails, clientIp, createDevice, createSession, loginLocked, recordLoginFail, tokensMatch, verifyTOTP } = S;
        if (!(pathname === '/api/auth/login' && req.method === 'POST')) return NOT_MINE;
        const ip = clientIp(req);
        if (loginLocked(ip)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'locked', retryAfterMs: LOGIN_LOCK_MS }));
            return;
        }
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            let data = {}; try { data = JSON.parse(body); } catch (e) {}
            const okToken = tokensMatch(data.token, AUTH_TOKEN);
            const okTotp = verifyTOTP(data.totp);
            if (!okToken || !okTotp) {
                recordLoginFail(ip);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid', need: okToken ? 'totp' : 'credentials' }));
                return;
            }
            clearLoginFails(ip);
            const session = createSession();
            const device = data.remember ? createDevice(data.deviceLabel) : null;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ session, device, expiresInMs: SESSION_TTL_MS }));
        });
        return;
    }

    function postAuthRefresh(req, res, pathname, auth) {
        const { NOT_MINE, SESSION_TTL_MS, createSession, validDevice } = S;
        if (!(pathname === '/api/auth/refresh' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            let data = {}; try { data = JSON.parse(body); } catch (e) {}
            if (!validDevice(data.device)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid_device' }));
                return;
            }
            const session = createSession();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ session, expiresInMs: SESSION_TTL_MS }));
        });
        return;
    }


    // ── WebAuthn / Windows Hello ─────────────────────────────────────────
    function postAuthWebauthn(req, res, pathname, auth) {
        const { LOGIN_LOCK_MS, NOT_MINE, SESSION_TTL_MS, b64url, cborDecode, checkClientData, clearLoginFails, clientIp, coseToJwk, createDevice, createSession, jsonResp, loginLocked, newChallenge, parseAuthData, parseOrigin, readBody, recordLoginFail, saveAuthState, sha256, takeChallenge, verifyWebauthnSig, webauthnCreds } = S;
        if (!(pathname.startsWith('/api/auth/webauthn/') && req.method === 'POST')) return NOT_MINE;
        readBody(req).then(raw => {
            let data = {}; try { data = JSON.parse(raw || '{}'); } catch (e) {}
            const o = parseOrigin(data.origin);
            if (!o) { jsonResp(res, 400, { error: 'bad_origin' }); return; }

            // Enrol: mint a challenge for navigator.credentials.create().
            if (pathname === '/api/auth/webauthn/register/options') {
                const challenge = newChallenge('create', o.rpId, o.origin);
                // Excluding what is already enrolled makes Windows Hello say
                // "already registered" instead of silently making a second key.
                const existing = Object.values(webauthnCreds())
                    .filter(c => c.rpId === o.rpId)
                    .map(c => ({ id: c.id, type: 'public-key' }));
                jsonResp(res, 200, {
                    challenge,
                    rp: { id: o.rpId, name: 'TSRCT' },
                    user: { id: b64url(Buffer.from('tsrct-owner')), name: 'tsrct', displayName: 'TSRCT' },
                    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
                    authenticatorSelection: {
                        authenticatorAttachment: 'platform',
                        userVerification: 'required',
                        residentKey: 'preferred',
                    },
                    attestation: 'none',
                    timeout: 60000,
                    excludeCredentials: existing,
                });
                return;
            }

            if (pathname === '/api/auth/webauthn/register/verify') {
                const rec = takeChallenge(data.challenge, 'create');
                if (!rec) { jsonResp(res, 400, { error: 'bad_challenge' }); return; }
                const clientDataRaw = Buffer.from(String(data.clientDataJSON || ''), 'base64url');
                if (!checkClientData(clientDataRaw, 'webauthn.create', data.challenge, rec.origin)) {
                    jsonResp(res, 400, { error: 'bad_client_data' }); return;
                }
                let att, ad;
                try {
                    att = cborDecode(Buffer.from(String(data.attestationObject || ''), 'base64url'), 0).v;
                    ad = parseAuthData(att.get('authData'));
                } catch (e) { ad = null; }
                if (!ad || !ad.credId) { jsonResp(res, 400, { error: 'bad_attestation' }); return; }
                if (!ad.up || !ad.uv) { jsonResp(res, 400, { error: 'user_not_verified' }); return; }
                if (!ad.rpIdHash.equals(sha256(rec.rpId))) { jsonResp(res, 400, { error: 'rpid_mismatch' }); return; }
                const key = coseToJwk(ad.coseKey);
                if (!key) { jsonResp(res, 400, { error: 'unsupported_key' }); return; }
                const id = b64url(ad.credId);
                webauthnCreds()[id] = {
                    id, jwk: key.jwk, alg: key.alg, signCount: ad.signCount,
                    rpId: rec.rpId, origin: rec.origin,
                    label: String(data.label || 'windows hello').slice(0, 60),
                    createdAt: Date.now(),
                };
                saveAuthState();
                console.log(`  [AUTH] WebAuthn credential enrolled for ${rec.origin} (alg ${key.alg}).`);
                jsonResp(res, 200, { ok: true, id });
                return;
            }

            // Login: only offer the credentials that belong to THIS origin --
            // a key enrolled on ts.net cannot answer a localhost challenge.
            if (pathname === '/api/auth/webauthn/login/options') {
                const creds = Object.values(webauthnCreds()).filter(c => c.rpId === o.rpId);
                const challenge = newChallenge('get', o.rpId, o.origin);
                jsonResp(res, 200, {
                    challenge, rpId: o.rpId, timeout: 60000, userVerification: 'required',
                    allowCredentials: creds.map(c => ({ id: c.id, type: 'public-key' })),
                });
                return;
            }

            if (pathname === '/api/auth/webauthn/login/verify') {
                const ip = clientIp(req);
                if (loginLocked(ip)) { jsonResp(res, 429, { error: 'locked', retryAfterMs: LOGIN_LOCK_MS }); return; }
                const rec = takeChallenge(data.challenge, 'get');
                if (!rec) { jsonResp(res, 400, { error: 'bad_challenge' }); return; }
                const cred = webauthnCreds()[String(data.id || '')];
                // Expectations come from the STORED credential, never from the
                // caller -- the whole point of the binding is that the client
                // does not get to say which origin it is.
                if (!cred) { recordLoginFail(ip); jsonResp(res, 401, { error: 'unknown_credential' }); return; }
                const clientDataRaw = Buffer.from(String(data.clientDataJSON || ''), 'base64url');
                if (!checkClientData(clientDataRaw, 'webauthn.get', data.challenge, cred.origin)) {
                    recordLoginFail(ip); jsonResp(res, 401, { error: 'bad_client_data' }); return;
                }
                const authDataBuf = Buffer.from(String(data.authenticatorData || ''), 'base64url');
                const ad = parseAuthData(authDataBuf);
                if (!ad || !ad.up || !ad.uv) { recordLoginFail(ip); jsonResp(res, 401, { error: 'user_not_verified' }); return; }
                if (!ad.rpIdHash.equals(sha256(cred.rpId))) { recordLoginFail(ip); jsonResp(res, 401, { error: 'rpid_mismatch' }); return; }
                const sig = Buffer.from(String(data.signature || ''), 'base64url');
                if (!verifyWebauthnSig(cred, authDataBuf, clientDataRaw, sig)) {
                    recordLoginFail(ip); jsonResp(res, 401, { error: 'bad_signature' }); return;
                }
                // Clone detection. Windows Hello reports 0 forever, so a zero
                // counter is not evidence of anything and must not be treated
                // as a regression -- only a real counter going backwards is.
                if (cred.signCount > 0 && ad.signCount > 0 && ad.signCount <= cred.signCount) {
                    recordLoginFail(ip);
                    console.warn('  [AUTH] WebAuthn signCount did not advance -- possible cloned credential.');
                    jsonResp(res, 401, { error: 'bad_sign_count' });
                    return;
                }
                cred.signCount = ad.signCount;
                cred.lastUsed = Date.now();
                saveAuthState();
                clearLoginFails(ip);
                const session = createSession();
                const device = data.remember ? createDevice(data.deviceLabel) : null;
                jsonResp(res, 200, { session, device, expiresInMs: SESSION_TTL_MS });
                return;
            }

            jsonResp(res, 404, { error: 'not_found' });
        }).catch(() => jsonResp(res, 400, { error: 'bad_request' }));
        return;
    }

    function getAuthWebauthnCredentials(req, res, pathname, auth) {
        const { NOT_MINE, jsonResp, webauthnCreds } = S;
        if (!(pathname === '/api/auth/webauthn/credentials' && req.method === 'GET')) return NOT_MINE;
        jsonResp(res, 200, {
            credentials: Object.values(webauthnCreds()).map(c => ({
                id: c.id, label: c.label, origin: c.origin, createdAt: c.createdAt, lastUsed: c.lastUsed || null,
            })),
        });
        return;
    }

    function deleteAuthWebauthnCredentials(req, res, pathname, auth) {
        const { NOT_MINE, jsonResp, readBody, saveAuthState, webauthnCreds } = S;
        if (!(pathname === '/api/auth/webauthn/credentials' && req.method === 'DELETE')) return NOT_MINE;
        readBody(req).then(raw => {
            let data = {}; try { data = JSON.parse(raw || '{}'); } catch (e) {}
            const creds = webauthnCreds();
            if (data.id && creds[data.id]) { delete creds[data.id]; saveAuthState(); }
            jsonResp(res, 200, { ok: true, remaining: Object.keys(creds).length });
        }).catch(() => jsonResp(res, 400, { error: 'bad_request' }));
        return;
    }

    function postAuthLogout(req, res, pathname, auth) {
        const { NOT_MINE, saveAuthState, sessions } = S;
        if (!(pathname === '/api/auth/logout' && req.method === 'POST')) return NOT_MINE;
        sessions.delete(auth);
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            let data = {}; try { data = JSON.parse(body); } catch (e) {}
            if (data.device && S.authState.devices[data.device]) {
                delete S.authState.devices[data.device];
                saveAuthState();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        return;
    }


    // Enrollment / device management — LOCAL only (returns the raw TOTP secret,
    // so it must never be reachable through any ingress)
    function getAuthEnroll(req, res, pathname, auth) {
        const { NOT_MINE, isRemoteRequest } = S;
        if (!(pathname === '/api/auth/enroll' && req.method === 'GET')) return NOT_MINE;
        if (isRemoteRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'local_only' }));
            return;
        }
        const uri = `otpauth://totp/TSRCT:bridge?secret=${S.authState.totpSecret}&issuer=TSRCT&digits=6&period=30`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secret: S.authState.totpSecret, uri, devices: Object.keys(S.authState.devices).length }));
        return;
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        postAuthLogin,
        postAuthRefresh,
        postAuthWebauthn,
        getAuthWebauthnCredentials,
        deleteAuthWebauthnCredentials,
        postAuthLogout,
        getAuthEnroll,
    ];

    return function apiAuth(req, res, pathname, auth) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname, auth);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
