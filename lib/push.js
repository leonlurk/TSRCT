'use strict';
// ── push.js — wake the phone when TSRCT is closed ────────────────────────────
//
// Web Push, implemented against the RFCs with node's own crypto and NO new npm
// dependency (this repo has exactly one, and a notification is not a reason to
// take a second).
//
//   RFC 8292 — VAPID: a signed JWT that says "this push really is from TSRCT".
//   RFC 8291 — the payload encryption (aes128gcm), so the push service that
//              relays the message cannot read it.
//   RFC 8188 — the content-encoding the above is built on.
//
// WHAT THIS DOES AND DOES NOT CHANGE ABOUT THE MACHINE'S EXPOSURE, because
// that was the first question asked and it deserves to be written down:
//   - it is OUTBOUND ONLY. The server POSTs to the push service the browser
//     gave us; the phone gets the message from that service. Nothing new
//     listens here, no port opens, Tailscale Funnel stays off.
//   - the message is END-TO-END ENCRYPTED to the subscription's own key, so
//     Google (or whoever the browser picked) relays bytes it cannot read.
//   - the VAPID private key is a new secret on disk (data/, gitignored). Its
//     worst case if stolen is that somebody can send THIS phone a
//     notification. It is not a way in.
//
// THE NOTIFICATION CARRIES THE REAL DETAIL (Leon, 2026-09-19: "no siempre va a
// ser your brief is ready ... que me muestre el detalle en el texto"). A
// notification that says only "something happened" makes you open the phone to
// learn whether it mattered, which is the thing it was supposed to save you.
// The encryption above is what makes that safe: the push service moves bytes it
// cannot read.
//
// ── SECRETCO, AND WHY THE GUARD LIVES *HERE* ───────────────────────────────────
// A push is an egress, and now it is an egress that carries content. So the
// check sits at the CHOKE POINT — inside send(), the single door every caller
// goes through — and not in each route. That is the whole lesson of 2026-08-14:
// the guards that existed were applied per call site, and the newest one was
// always exemplary while its older twin had nothing.
//   - EVERY field is scanned, not just the body: the whole payload is
//     serialized and matched, so a field added next month is covered the day
//     it is added and nobody has to remember;
//   - it FAILS CLOSED: nothing is sent, the refusal is logged and recorded in
//     the store, and no "redacted" version goes out either. Not being told is
//     the correct outcome — SecretCo is handled in its own Bedrock session;
//   - composers that build a list (meetings, tasks, sessions) should call
//     dropRestricted() FIRST, so one SecretCo meeting removes that line instead of
//     silencing the whole notification;
//   - restrictedGuard is required STANDALONE, never through the dispatcher: a
//     boundary must not depend on an optional subsystem having loaded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
// Standalone on purpose (see the header): the SecretCo boundary cannot hang off
// the dispatcher, which is optional and may never have been required.
const restrictedGuard = require('./dispatcher/restrictedGuard');

const STORE = process.env.PUSH_STORE || path.join(__dirname, '..', 'data', 'push.json');
const SUBJECT = process.env.PUSH_SUBJECT || 'mailto:tsrct@localhost';
const TTL = Number(process.env.PUSH_TTL || 12 * 3600);

// ── base64url ────────────────────────────────────────────────────────────────
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// ── the store: our key pair + every device that asked to be woken ────────────
function load() {
    try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return null; }
}

function save(s) {
    try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); } catch {}
    fs.writeFileSync(STORE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

// The key pair is generated once and never rotated on its own: every existing
// subscription is bound to it, so a new pair silently orphans the phone.
function keys() {
    const s = load();
    if (s && s.publicKey && s.privateKey) return s;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
    const next = {
        publicKey: b64u(raw),
        privateKey: privateKey.export({ format: 'jwk' }).d,
        createdAt: Date.now(),
        subs: (s && s.subs) || [],
    };
    save(next);
    console.log('[push] generated a new VAPID key pair');
    return next;
}

function privateKeyObject(dB64) {
    const pub = unb64u(keys().publicKey);            // 0x04 || x || y
    return crypto.createPrivateKey({
        key: {
            kty: 'EC', crv: 'P-256',
            x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: dB64,
        },
        format: 'jwk',
    });
}

// ── RFC 8292: the "this is really TSRCT" header ──────────────────────────────
function vapidHeader(endpoint) {
    const k = keys();
    const aud = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64u(JSON.stringify({
        aud, sub: SUBJECT, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    }));
    // ieee-p1363 gives the raw r||s the JWS spec wants; node's default is DER,
    // and a DER signature here is rejected with a 401 that says nothing useful.
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`),
        { key: privateKeyObject(k.privateKey), dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${k.publicKey}`;
}

// ── RFC 8291: encrypt the payload to the subscription's own key ──────────────
// salt and asKeys are injectable ONLY so the RFC's worked example can be
// reproduced byte for byte in the harness; nothing in production passes them.
function encrypt(plaintext, p256dh, auth, salt, asPrivate) {
    const uaPublic = unb64u(p256dh);
    const authSecret = unb64u(auth);
    const useSalt = salt ? Buffer.from(salt) : crypto.randomBytes(16);

    const ecdh = crypto.createECDH('prime256v1');
    if (asPrivate) ecdh.setPrivateKey(Buffer.from(asPrivate));
    else ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey();
    const shared = ecdh.computeSecret(uaPublic);

    const prkKey = hmac(authSecret, shared);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic, Buffer.from([1])]);
    const ikm = hmac(prkKey, keyInfo);

    const prk = hmac(useSalt, ikm);
    const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), Buffer.from([1])])).subarray(0, 16);
    const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0', 'utf8'), Buffer.from([1])])).subarray(0, 12);

    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(4096, 0);
    const header = Buffer.concat([useSalt, rs, Buffer.from([asPublic.length]), asPublic]);

    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    // 0x02 is the record delimiter for the LAST record (RFC 8188 §2).
    const sealed = Buffer.concat([
        cipher.update(Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])])),
        cipher.final(), cipher.getAuthTag(),
    ]);
    return Buffer.concat([header, sealed]);
}

// ── subscriptions ────────────────────────────────────────────────────────────
function publicKey() { return keys().publicKey; }

function list() { return (load() || {}).subs || []; }

function subscribe(sub, label) {
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return { ok: false, error: 'that is not a push subscription' };
    }
    const s = keys();
    s.subs = (s.subs || []).filter(x => x.endpoint !== sub.endpoint);
    s.subs.push({
        endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
        label: String(label || '').slice(0, 60), addedAt: Date.now(), lastOk: 0, fails: 0,
    });
    save(s);
    return { ok: true, count: s.subs.length };
}

function unsubscribe(endpoint) {
    const s = keys();
    const before = (s.subs || []).length;
    s.subs = (s.subs || []).filter(x => x.endpoint !== endpoint);
    save(s);
    return { ok: true, removed: before - s.subs.length };
}

function sendOne(sub, payloadObj) {
    return new Promise((resolve) => {
        let body;
        try {
            body = encrypt(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
        } catch (e) { return resolve({ ok: false, error: `encrypt failed: ${e.message}` }); }
        let url;
        try { url = new URL(sub.endpoint); } catch { return resolve({ ok: false, error: 'bad endpoint' }); }
        const req = https.request({
            method: 'POST', hostname: url.hostname, path: url.pathname + url.search,
            port: url.port || 443,
            headers: {
                'Authorization': vapidHeader(sub.endpoint),
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
                'Content-Length': body.length,
                'TTL': String(TTL),
                'Urgency': 'high',
            },
            timeout: 15000,
        }, (res) => {
            let text = '';
            res.on('data', c => { if (text.length < 500) text += c.toString(); });
            res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300
                ? { ok: true, status: res.statusCode }
                // 404/410 mean the browser threw the subscription away: that is
                // not an error to retry, it is a row to delete.
                : { ok: false, status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410, error: text.trim().slice(0, 200) }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'the push service timed out' }); });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.end(body);
    });
}

// Drop anything SecretCo from a list a notification is being built from, so one
// SecretCo meeting costs that LINE and not the whole notification. Composers call
// this; send() below is still the thing that actually refuses.
// Objects are matched whole (every value, at any depth), not field by field.
function dropRestricted(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(it => {
        try { return !restrictedGuard.mentionsRestricted(typeof it === 'string' ? it : JSON.stringify(it)); }
        catch { return false; }        // unserializable: drop it, fail closed
    });
}

// True if any value anywhere in the payload mentions SecretCo. Serializing the
// whole object is deliberate: scanning a list of known fields is how a new
// field ships unguarded.
function payloadIsRestricted(payload) {
    try { return restrictedGuard.mentionsRestricted(JSON.stringify(payload == null ? '' : payload)); }
    catch { return true; }             // cannot be inspected => cannot be sent
}

// send({title, body, url, tag, kind}) -> {sent, failed, removed}
async function send(payload) {
    // THE CHOKE POINT. Every caller — scheduler, morning routine, a route, and
    // whatever is written next — reaches the push service through here.
    if (payloadIsRestricted(payload)) {
        const s = keys();
        s.lastRefusedAt = Date.now();
        s.lastRefusedReason = 'SecretCo content';
        save(s);
        console.warn('[push] REFUSED: the notification mentions SecretCo — not sent (Bedrock-only contract)');
        return { ok: false, refused: true, sent: 0, error: 'SecretCo contract: that notification is not allowed to leave this machine' };
    }
    const s = keys();
    const subs = s.subs || [];
    if (!subs.length) return { ok: false, error: 'no device has asked to be woken yet', sent: 0 };
    const keep = [];
    let sent = 0, failed = 0, removed = 0;
    for (const sub of subs) {
        const r = await sendOne(sub, payload);
        if (r.ok) { sub.lastOk = Date.now(); sub.fails = 0; sent++; keep.push(sub); continue; }
        failed++;
        if (r.gone) { removed++; console.warn(`[push] dropping a dead subscription (${r.status})`); continue; }
        sub.fails = (sub.fails || 0) + 1;
        sub.lastError = r.error || String(r.status || '');
        console.warn(`[push] send failed: ${sub.lastError}`);
        keep.push(sub);
    }
    s.subs = keep;
    save(s);
    return { ok: sent > 0, sent, failed, removed };
}

function status() {
    const s = keys();
    return {
        ok: true,
        publicKey: s.publicKey,
        // Visible on purpose: a guard that refuses in silence looks identical
        // to a guard that never fired.
        lastRefusedAt: s.lastRefusedAt || 0,
        lastRefusedReason: s.lastRefusedReason || '',
        devices: (s.subs || []).map(x => ({
            label: x.label, addedAt: x.addedAt, lastOk: x.lastOk,
            fails: x.fails || 0, lastError: x.lastError || '',
            host: (() => { try { return new URL(x.endpoint).host; } catch { return '?'; } })(),
        })),
    };
}

module.exports = {
    publicKey, subscribe, unsubscribe, send, status, list,
    dropRestricted, payloadIsRestricted, encrypt, vapidHeader, STORE,
};
