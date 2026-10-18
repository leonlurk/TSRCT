#!/usr/bin/env node
'use strict';
// check-push.js — prove the Web Push crypto is right BEFORE a phone depends on it.
//
// The encryption in lib/push.js is hand-written against RFC 8291, and it is the
// kind of code that fails silently: a wrong byte gives a body the push service
// accepts with a 201 and the phone quietly discards. There is no error to read.
//
// So it is checked against the RFC's OWN worked example (RFC 8291 section 5):
// same keys, same salt, same plaintext, and the output must equal the published
// body byte for byte. A positive control follows it — flip one byte of the
// input and the comparison must fail — because a test that cannot fail is not
// a test (the jq `//` lesson, invariant 49).

const path = require('path');
process.env.PUSH_STORE = process.env.PUSH_STORE
    || path.join(require('os').tmpdir(), `tsrct-push-check-${process.pid}.json`);
const fs = require('fs');
const push = require('../lib/push');

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ── RFC 8291 §5 ──────────────────────────────────────────────────────────────
const V = {
    plaintext: 'When I grow up, I want to be a watermelon',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
        + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
        + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
    if (cond) { pass++; } else { fail++; console.log(`[check-push] FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

const got = push.encrypt(V.plaintext, V.uaPublic, V.auth, unb64u(V.salt), unb64u(V.asPrivate));
ok('RFC 8291 §5 body matches byte for byte', b64u(got) === V.body,
    `got ${b64u(got).slice(0, 48)}... want ${V.body.slice(0, 48)}...`);
ok('body length is header(86) + plaintext + delimiter + tag', got.length === 86 + V.plaintext.length + 1 + 16);
ok('the header carries the salt', got.subarray(0, 16).equals(unb64u(V.salt)));
ok('the header carries the 65-byte server key', got[20] === 65);

// Positive control: one different character in the plaintext must change it.
const other = push.encrypt(V.plaintext + '!', V.uaPublic, V.auth, unb64u(V.salt), unb64u(V.asPrivate));
ok('CONTROL: a changed plaintext does NOT match the vector', b64u(other) !== V.body);

// A fresh salt and key on every call, or two identical notifications would be
// byte-identical on the wire.
const a = push.encrypt('same', V.uaPublic, V.auth);
const b = push.encrypt('same', V.uaPublic, V.auth);
ok('every message gets its own salt and key', !a.equals(b));

// VAPID: the header must be a real ES256 JWS over the right audience.
const hdr = push.vapidHeader('https://fcm.googleapis.com/fcm/send/abc123');
const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(hdr);
ok('the VAPID header has the t= and k= parts', !!m);
if (m) {
    const head = JSON.parse(unb64u(m[1]).toString());
    const claims = JSON.parse(unb64u(m[2]).toString());
    ok('JWT says ES256', head.alg === 'ES256' && head.typ === 'JWT');
    ok('the audience is the push service ORIGIN, not the full URL', claims.aud === 'https://fcm.googleapis.com');
    ok('it expires within 24h (services reject longer)', claims.exp - Math.floor(Date.now() / 1000) <= 24 * 3600);
    ok('the signature is raw r||s, 64 bytes (not DER)', unb64u(m[3]).length === 64);
    ok('k= is the uncompressed public point', unb64u(m[4]).length === 65 && unb64u(m[4])[0] === 4);

    const crypto = require('crypto');
    const raw = unb64u(m[4]);
    const key = crypto.createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) },
        format: 'jwk',
    });
    const signed = crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`),
        { key, dsaEncoding: 'ieee-p1363' }, unb64u(m[3]));
    ok('the JWT verifies against the key it advertises', signed);
    ok('CONTROL: it does NOT verify over tampered claims', !crypto.verify('sha256',
        Buffer.from(`${m[1]}.${m[2]}x`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(m[3])));
}

// ── the SecretCo boundary ───────────────────────────────────────────────────────
// A notification now carries real detail, so the push IS content egress. These
// exercise the refusal rather than reading the source for a guard's name — the
// 2026-08-15 lesson is that a comment describing a guard is not a guard.
ok('a plain notification is not flagged',
    !push.payloadIsRestricted({ title: 'TSRCT', body: 'Meeting with Sam in 15 minutes' }));
for (const [where, payload] of [
    ['the body', { title: 'TSRCT', body: 'SecretCo invoice run failed' }],
    ['the title', { title: 'SecretCoSandbox', body: 'something' }],
    ['a path in the url', { title: 'x', body: 'y', url: '/?cwd=/mnt/c/Users/you/PROJECTS/SecretCoSandbox' }],
    ['the tag', { title: 'x', body: 'y', tag: 'secretco-deploy' }],
    ['a field nobody thought of', { title: 'x', body: 'y', extra: { note: 'for secretco' } }],
    ['a nested list', { title: 'x', body: 'y', items: ['fine', 'SecretCoSandbox cutover'] }],
]) {
    ok(`SecretCo is caught in ${where}`, push.payloadIsRestricted(payload));
}

// send() must REFUSE, not merely log, and must not fall back to a redacted one.
(async () => {
    const r = await push.send({ title: 'TSRCT', body: 'SecretCo: the migration finished' });
    ok('send() refuses an SecretCo notification', r && r.refused === true && r.sent === 0);
    ok('the refusal is recorded where it can be seen', (push.status().lastRefusedReason || '').includes('SecretCo'));

    // dropRestricted keeps the notification alive minus the offending line — the
    // difference between "your 9am moved" and total silence.
    const kept = push.dropRestricted([
        'Daily Front at 9:30',
        { title: 'SecretCoSandbox cutover', at: '11:00' },
        { title: 'HARBOR review', at: '14:00' },
    ]);
    ok('dropRestricted removes only the SecretCo item', kept.length === 2);
    ok('dropRestricted keeps the rest intact', JSON.stringify(kept).includes('HARBOR'));
    ok('CONTROL: dropRestricted does not drop a clean list',
        push.dropRestricted(['one', 'two', 'three']).length === 3);

    // ntfy topics are public names: a default topic would send every install's
    // alerts to the same channel. With no NTFY_TOPIC, nothing is sent at all.
    const http = require('http'), https = require('https');
    const realHttp = http.request, realHttps = https.request;
    let calls = 0;
    http.request = https.request = () => { calls++; throw new Error('no network in a check'); };
    const savedTopic = process.env.NTFY_TOPIC;
    delete process.env.NTFY_TOPIC;
    try {
        const ntfy = require('../lib/dispatcher/ntfyPush');
        const r = await ntfy.send({ title: 'TSRCT', body: 'a session needs you' });
        ok('ntfy sends nothing when NTFY_TOPIC is not set', calls === 0, `${calls} request(s)`);
        ok('ntfy says why it sent nothing', r && r.skipped === 'no NTFY_TOPIC');
    } catch (e) { ok('ntfy without NTFY_TOPIC does not throw', false, e.message); }
    http.request = realHttp; https.request = realHttps;
    if (savedTopic !== undefined) process.env.NTFY_TOPIC = savedTopic;
    finish();
})();

// Reporting happens after the async half, or a failure there would be counted
// into a summary that had already been printed.
function finish() {
    // The store holds a private key: it must not be world-readable.
    try {
        const mode = fs.statSync(process.env.PUSH_STORE).mode & 0o777;
        ok('the key file is 0600', mode === 0o600, `mode ${mode.toString(8)}`);
    } catch (e) { ok('the key file exists', false, e.message); }

    try { fs.unlinkSync(process.env.PUSH_STORE); } catch {}

    console.log(`[check-push] ${pass}/${pass + fail} checks passed`);
    if (fail) {
        console.error('[check-push] FAILED — a notification path that has not matched the RFC vector, or an SecretCo refusal that does not refuse, does not ship');
        process.exit(1);
    }
    console.log('[check-push] OK — RFC 8291 vector reproduced, VAPID verifies, SecretCo refused at the choke point');
}
