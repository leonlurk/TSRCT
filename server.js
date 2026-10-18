/**
 * Claude Remote Bridge Server v2.0
 *
 * Universal remote control for Claude Code:
 * - Mobile-friendly interface with Material Design 3
 * - Real-time event feed from Claude hooks
 * - Quick actions for common operations
 * - Push notifications via ntfy.sh
 */

const http = require('http');
// Before the destructure below: it wraps the sync child_process calls so a
// freeze can be traced to the call that caused it (logs/stalls.jsonl).
const stallWatch = require('./lib/stallWatch');
const { execSync, execFileSync, execFile, spawn, spawnSync } = require('child_process');
// Cap on every synchronous tmux call (see tmux() below). Defined up here because
// pickInitialSession() runs during startup, long before tmux() is declared.
const TMUX_TIMEOUT_MS = Number(process.env.TMUX_TIMEOUT_MS || 10000);
const url = require('url');
const crypto = require('crypto');

// WHATWG-URL replacement for the deprecated `parseReqUrl(req.url)` (Node DEP0169).
// Returns { pathname, query } where query is a plain single-valued object, matching how
// this server reads params (token/path/project/id/lines/...). Never throws.
function parseReqUrl(reqUrl) {
    try {
        const u = new URL(reqUrl, 'http://localhost');
        return { pathname: u.pathname, query: Object.fromEntries(u.searchParams) };
    } catch {
        return { pathname: reqUrl ? String(reqUrl).split('?')[0] : '/', query: {} };
    }
}
const net = require('net');
const zlib = require('zlib');
// What a Claude Code pane looks like (mid-turn vs sitting at its input box). The
// single source of those shapes — server.js, sessionWeight.js and outputParser.js
// each used to carry their own copy, and one TUI release blinded all three.
const paneShape = require('./lib/paneShape');
// Session weight tracker (context-size warnings + one-click handoff). Required
// standalone, never through `dispatcher.*`, so the warning does not silently
// depend on an optional subsystem having loaded.
const sessionWeight = require('./lib/sessionWeight');
// HANDS ON plan store. Standalone for the same reason, and durable on disk
// because a half-typed lesson must survive a server restart.
const handson = require('./lib/handson');
// The clock (2026-09-18): named jobs that run at a time of day, on a laptop that
// sleeps. Standalone, and every job it runs is registered below.
const scheduler = require('./lib/scheduler');
// The Automations tab (2026-09-24): every job, loop, service, Windows task and
// hook in one list with one switch each. The old cron jobs are scheduler jobs now.
const automations = require('./lib/automations');
// Opening a session, booting Claude in it and pasting the priming text — shared
// by the handoff and the morning routine so the TUI contract lives in one file.
const sessionSpawn = require('./lib/sessionSpawn');
// "Which folder is this project in?" Fail-closed: allowlisted roots, SecretCo refused.
const projectRegistry = require('./lib/projectRegistry');
// The desktop layout, kept across TSRCT restarts and dropped on a Linux restart.
const uiLayout = require('./lib/uiLayout');
// Ask headless Claude and get JSON back that has been checked, with one retry.
const jsonJob = require('./lib/jsonJob');
// The 6am routine itself: ask once, then open what it named.
const morningRoutine = require('./lib/morningRoutine');
// [PB] plain-brief: which sessions are under the brevity rules. Standalone and
// durable on disk because the two Claude Code hooks that ENFORCE it read the
// file directly -- the gate has to keep gating while this server is restarting.
const plainBrief = require('./lib/plainBrief');
// Token usage read out of the Claude Code transcripts. Standalone, and it runs
// ONLY when the panel asks: a day is ~150 MB of JSON and this laptop has 11 GB.
const usage = require('./lib/usage');
const permissionDesk = require('./lib/permissionDesk');
const paneKeys = require('./lib/paneKeys');
const promptWriter = require('./lib/promptWriter');
const teslaHands = require('./lib/teslaHands');
const desk = require('./lib/desk');
const pcDirect = require('./lib/pcDirect');
// Reading text out loud on the CPU (Piper). Standalone and optional: if the
// runtime or the voice file is missing it says so and the browser's own voice
// takes over -- nothing else in the server depends on it.
const tts = require('./lib/tts');
// Waking the phone when TSRCT is closed. OUTBOUND ONLY -- it opens no port and
// needs no tunnel; see the header of lib/push.js for what it does and does not
// change about this machine's exposure.
const push = require('./lib/push');
// TALK: the microphone half. Loads the local model only while a conversation is
// actually open and gives the memory back on close -- see the header of
// lib/talk.js for the policy, which is the reason that file exists.
const talk = require('./lib/talk');
const teslaLog = require('./lib/teslaLog');
// Tesla from another of his apps (Ghost Runner): a key that opens the talk
// routes and nothing else, local requests only. See lib/appKey.js.
const appKey = require('./lib/appKey');
try { appKey.ensure(); } catch (e) { console.warn('[app-key] could not create', appKey.KEY_FILE, e.message); }
// The phone RINGING instead of buzzing once: ntfy at urgent priority, repeated
// until it is answered. See the header of lib/ring.js.
const ring = require('./lib/ring');
// What a project has been up to (its note, its last decisions, where the last
// session left it), so a spoken narration can be about the WORK and not only
// about the last screen. Caches against mtime; the Decisions Log is ~3MB.
const projectMemory = require('./lib/projectMemory');
const { stateFile } = require('./lib/stateFile');
// The declared buttons a model is allowed to ask for (lib/actions.js). The
// catalogue is validated against this code by scripts/check-actions.js.
const actions = require('./lib/actions');
// The browser half of the catalogue: the page reports each press back here.
const uiActions = require('./lib/uiActions');
// Named boards he can ask for in one sentence.
const setups = require('./lib/setups');
// How a spoken line is shaped and how it is read out loud.
const speech = require('./lib/speech');
const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const https = require('https');

// Slack socket-mode (via finity state machine) throws
// "Unhandled event 'server explicit disconnect' in state 'connecting'"
// when Slack drops the WS mid-handshake. The error escapes the WS message
// handler and would crash the whole bridge. Bolt reconnects on its own, so
// swallow this specific case; everything else still crashes the process.
process.on('uncaughtException', (err) => {
    const msg = (err && err.message) || '';
    if (/Unhandled event '(server explicit disconnect|server disconnect warning|server pings not received|websocket close)' in state/.test(msg)) {
        console.warn('[slack] swallowed socket-mode finity bug:', msg);
        return;
    }
    console.error('[fatal] uncaughtException:', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    const msg = (reason && reason.message) || String(reason);
    if (/Unhandled event '.*' in state '(connecting|connected|disconnecting|disconnected)'/.test(msg)) {
        console.warn('[slack] swallowed socket-mode finity rejection:', msg);
        return;
    }
    console.error('[unhandledRejection]', reason);
});

// SECRETCO CONTRACT GUARD — required on its own, NOT through the dispatcher.
// It used to be reachable only as `dispatcher.restrictedGuard`, so every guarded route
// silently depended on the whole dispatcher (36 modules, @slack/bolt) having
// loaded. A security boundary must not be a side effect of an optional subsystem;
// if this require ever fails the server should not start. (Audit 2026-08-15.)
const restrictedGuard = require('./lib/dispatcher/restrictedGuard');
// The PROJECTOR (2026-10-12): live view of a separate browser a session drives.
const projector = require('./lib/projector');

// Dispatcher: session monitor, codemap, the job runner and the local model.
// Loaded lazily so a missing module doesn't break the rest of the server.
let dispatcher = null;
try {
    dispatcher = {
        db: require('./lib/dispatcher/db'),
        restrictedGuard: require('./lib/dispatcher/restrictedGuard'),
        hermes: require('./lib/dispatcher/hermes'),
        projects: require('./lib/dispatcher/projectContext'),
        tmux: require('./lib/dispatcher/tmuxAdapter'),
        // The background `claude -p` job runner (every headless job goes through it).
        clickupAnalyst: require('./lib/dispatcher/clickupAnalyst'),
        // Codemap: repo-map MAP.md freshness + session priming (SecretCo fail-closed).
        codemapEngine: require('./lib/dispatcher/codemapEngine'),
        // Phase 2:
        contextBuilder: require('./lib/dispatcher/contextBuilder'),
        outputParser: require('./lib/dispatcher/outputParser'),
        eventConsumer: require('./lib/dispatcher/eventConsumer'),
        // Phase 3:
        priorityScorer: require('./lib/dispatcher/priorityScorer'),
        // Phase 4:
        ntfyPush: require('./lib/dispatcher/ntfyPush'),
        sessionMonitor: require('./lib/dispatcher/sessionMonitor'),
        // Phase 5:
        // Quality levers:
        promptTemplates: require('./lib/dispatcher/promptTemplates'),
        claudePolish: require('./lib/dispatcher/claudePolish'),
        activityLog: require('./lib/dispatcher/activityLog'),
    };
} catch (e) {
    console.warn('[dispatcher] modules failed to load:', e.message);
}


// Load .env file. BRIDGE_TOKEN is forced from .env (it is the single source of
// truth for auth) so a stale exported BRIDGE_TOKEN in the launching shell can't
// desync the server from the hooks. Other keys keep env-var-wins precedence.
try {
    const envPath = require('path').join(__dirname, '.env');
    const settings = require('./lib/envFile').parse(require('fs').readFileSync(envPath, 'utf8'));
    for (const [key, value] of Object.entries(settings)) {
        if (!process.env[key] || key === 'BRIDGE_TOKEN') process.env[key] = value;
    }
} catch (e) {}

// Configuration
const PORT = process.env.BRIDGE_PORT || 3847;
// Bind to loopback by default so the server is NOT reachable directly over the LAN.
// The only remote path is `tailscale serve` on the Windows side, which reaches this
// loopback bind because WSL2 runs in mirrored networking mode. Override with BIND_HOST.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
// The permanent remote hostname (Tailscale). Replaces the rotating quick-tunnel URL as
// the thing the PC sidebar shows and copies. Cosmetic/reporting only — it grants no
// access by itself; `tailscale serve` is what actually routes to this process.
const REMOTE_URL = process.env.REMOTE_URL || null;
// Mutable for session switching. Defaults to EMPTY ('' = no session targeted yet)
// instead of a hardcoded 'claude': TSRCT must open with zero tmux sessions and let
// the user create whatever sessions they want, on demand (like the runners). At
// startup we adopt the first real existing session if there is one (pickInitialSession).
let TMUX_SESSION = process.env.TMUX_SESSION || '';
const AUTH_TOKEN = process.env.BRIDGE_TOKEN || generateToken();

// Constant-time token comparison (avoids leaking the token via response timing).
function tokensMatch(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────
// TWO-FACTOR AUTH (TOTP) + SESSIONS
// Remote (tunnel) traffic must present a session token obtained via 2FA login
// (master token + TOTP). The master BRIDGE_TOKEN alone is only honored for
// LOCAL requests (hooks) — detected by the absence of Cloudflare headers, and
// reachable only because the server binds to 127.0.0.1.
// ─────────────────────────────────────────────────────────────────────────
const AUTH_STATE_PATH = path.join(__dirname, '.tsrct', 'auth.json');
// IDLE timeout, not an absolute lifetime: every authorized request slides the
// expiry forward (see validSession), so a session in active use never dies
// under the user. Only genuine inactivity for this long expires it. It was an
// absolute 12h from login, which kicked an actively-used desktop out mid-work
// at exactly the 12h mark. Override with SESSION_IDLE_HOURS.
const SESSION_TTL_MS = (Number(process.env.SESSION_IDLE_HOURS) || 12) * 60 * 60 * 1000;
const DEVICE_TTL_MS  = 30 * 24 * 60 * 60 * 1000;  // 30d trusted-device fast path
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;             // lockout window per IP

let authState = { totpSecret: null, devices: {} };

function saveAuthState() {
    const dir = path.dirname(AUTH_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(authState, null, 2));
}
function pruneDevices() {
    const now = Date.now();
    for (const t of Object.keys(authState.devices)) {
        const d = authState.devices[t];
        if (!d || !d.expiresAt || d.expiresAt < now) delete authState.devices[t];
    }
}
function loadAuthState() {
    try { authState = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf8')); } catch (e) {}
    if (!authState.devices) authState.devices = {};
    if (!authState.credentials) authState.credentials = {};
    let fresh = false;
    if (!authState.totpSecret) {
        authState.totpSecret = base32Encode(crypto.randomBytes(20));
        fresh = true;
    }
    pruneDevices();
    saveAuthState();
    if (fresh) {
        const uri = `otpauth://totp/TSRCT:bridge?secret=${authState.totpSecret}&issuer=TSRCT&digits=6&period=30`;
        console.log('\n  [AUTH] New TOTP secret generated. Add it to your authenticator app:');
        console.log('  [AUTH] Setup key (base32): ' + authState.totpSecret);
        console.log('  [AUTH] otpauth URI:        ' + uri + '\n');
    } else {
        console.log(`  [AUTH] TOTP configured; ${Object.keys(authState.devices).length} trusted device(s).`);
    }
}

// base32 (RFC 4648) — used for the TOTP shared secret
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}
function base32Decode(str) {
    let bits = 0, value = 0; const out = [];
    for (const c of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
        value = (value << 5) | B32_ALPHABET.indexOf(c); bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return Buffer.from(out);
}

// RFC 6238 TOTP — verify with ±1 step tolerance for clock skew
function totpAt(secretBuf, counter) {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
                (hmac[offset + 2] << 8) | hmac[offset + 3];
    return (bin % 1000000).toString().padStart(6, '0');
}
function verifyTOTP(code) {
    const c = String(code || '').trim();
    if (!/^\d{6}$/.test(c) || !authState.totpSecret) return false;
    const secret = base32Decode(authState.totpSecret);
    const step = Math.floor(Date.now() / 30000);
    for (let w = -1; w <= 1; w++) {
        if (tokensMatch(totpAt(secret, step + w), c)) return true;
    }
    return false;
}

// Session + trusted-device stores
const sessions = new Map(); // sessionToken -> expiresAt (in-memory; cleared on restart)
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function createSession() {
    const t = newToken();
    sessions.set(t, Date.now() + SESSION_TTL_MS);
    return t;
}
function validSession(t) {
    if (!t) return false;
    const exp = sessions.get(t);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(t); return false; }
    // Slide the window on every authorized request. The desktop polls every
    // 5s while it is open, so an open tab stays logged in indefinitely; a tab
    // that is closed/abandoned still expires SESSION_TTL_MS later.
    sessions.set(t, Date.now() + SESSION_TTL_MS);
    return true;
}
function createDevice(label) {
    const t = newToken();
    authState.devices[t] = { label: label || 'device', expiresAt: Date.now() + DEVICE_TTL_MS };
    saveAuthState();
    return t;
}
function validDevice(t) {
    if (!t) return false;
    const d = authState.devices[t];
    if (!d || !d.expiresAt || d.expiresAt < Date.now()) {
        if (d) { delete authState.devices[t]; saveAuthState(); }
        return false;
    }
    return true;
}

// ─────────────────────────────────────────────────────────────────────────
// WEBAUTHN — Windows Hello / platform authenticator, the PRIMARY login path.
// A passkey is possession (a TPM-bound key) + user verification (your face),
// i.e. both factors in one gesture, so it replaces master-token + TOTP rather
// than adding to it. TOTP stays as the fallback so a broken camera can never
// lock the machine's owner out.
//
// Zero-dependency by design: authData is a fixed-layout buffer we slice by
// hand, and node's crypto.createPublicKey accepts a JWK directly, which
// removes the usual hand-rolled DER/SPKI encoding of the raw EC coordinates.
// ─────────────────────────────────────────────────────────────────────────
const WEBAUTHN_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const webauthnChallenges = new Map(); // challenge -> { exp, rpId, origin, type }

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }

function newChallenge(type, rpId, origin) {
    for (const [k, v] of webauthnChallenges) if (v.exp < Date.now()) webauthnChallenges.delete(k);
    const c = b64url(crypto.randomBytes(32));
    webauthnChallenges.set(c, { exp: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS, rpId, origin, type });
    return c;
}
// One-shot: a challenge is consumed by the first attempt that presents it,
// success or failure, so a captured assertion can never be replayed.
function takeChallenge(c, type) {
    const rec = webauthnChallenges.get(c);
    if (!rec) return null;
    webauthnChallenges.delete(c);
    if (rec.exp < Date.now() || rec.type !== type) return null;
    return rec;
}

// WebAuthn only runs in a secure context, so the origin is https:// or a
// localhost http://. The RP ID is the bare hostname and a credential is bound
// to it -- a key enrolled on the ts.net hostname will not work on localhost,
// which is why each credential records the origin it was created for.
function parseOrigin(o) {
    try {
        const u = new URL(String(o));
        const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
        return { origin: u.origin, rpId: u.hostname };
    } catch (e) { return null; }
}

// Minimal CBOR reader -- enough for an attestation object and a COSE key.
function cborDecode(buf, i) {
    const b = buf[i++];
    const major = b >> 5, info = b & 31;
    let len = info;
    if (info === 24) { len = buf[i]; i += 1; }
    else if (info === 25) { len = buf.readUInt16BE(i); i += 2; }
    else if (info === 26) { len = buf.readUInt32BE(i); i += 4; }
    else if (info === 27) { len = Number(buf.readBigUInt64BE(i)); i += 8; }
    switch (major) {
        case 0: return { v: len, i };
        case 1: return { v: -1 - len, i };
        case 2: return { v: buf.subarray(i, i + len), i: i + len };
        case 3: return { v: buf.subarray(i, i + len).toString('utf8'), i: i + len };
        case 4: {
            const a = [];
            for (let n = 0; n < len; n++) { const r = cborDecode(buf, i); a.push(r.v); i = r.i; }
            return { v: a, i };
        }
        case 5: {
            const m = new Map();
            for (let n = 0; n < len; n++) {
                const k = cborDecode(buf, i);
                const val = cborDecode(buf, k.i);
                m.set(k.v, val.v); i = val.i;
            }
            return { v: m, i };
        }
        case 6: return cborDecode(buf, i); // tag -- decode the tagged value
        case 7:
            if (info === 20) return { v: false, i };
            if (info === 21) return { v: true, i };
            return { v: null, i };
    }
    throw new Error('cbor: unsupported major type ' + major);
}

// authData layout: rpIdHash[32] flags[1] signCount[4] then, when the AT flag
// is set, aaguid[16] credIdLen[2] credId[] and the COSE public key.
function parseAuthData(ad) {
    if (!Buffer.isBuffer(ad) || ad.length < 37) return null;
    const out = {
        rpIdHash: ad.subarray(0, 32),
        flags: ad[32],
        signCount: ad.readUInt32BE(33),
    };
    out.up = !!(out.flags & 0x01);   // user present
    out.uv = !!(out.flags & 0x04);   // user VERIFIED -- the face/PIN check
    if (out.flags & 0x40) {
        if (ad.length < 55) return null;
        const credIdLen = ad.readUInt16BE(53);
        out.credId = ad.subarray(55, 55 + credIdLen);
        try { out.coseKey = cborDecode(ad.subarray(55 + credIdLen), 0).v; } catch (e) { return null; }
    }
    return out;
}

// COSE key -> JWK. Windows Hello's TPM commonly issues RS256, not ES256, so
// both have to be supported or enrolment silently fails on exactly this box.
function coseToJwk(cose) {
    if (!(cose instanceof Map)) return null;
    const kty = cose.get(1), alg = cose.get(3);
    if (kty === 2) {
        if (cose.get(-1) !== 1) return null; // P-256 only
        return { jwk: { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) }, alg };
    }
    if (kty === 3) {
        return { jwk: { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)) }, alg };
    }
    return null;
}

function webauthnCreds() {
    if (!authState.credentials) authState.credentials = {};
    return authState.credentials;
}

function checkClientData(raw, expectType, expectChallenge, expectOrigin) {
    let cd;
    try { cd = JSON.parse(raw.toString('utf8')); } catch (e) { return false; }
    return cd.type === expectType && cd.challenge === expectChallenge && cd.origin === expectOrigin;
}

// ES256 assertions arrive DER-encoded and RS256 as PKCS#1 v1.5, which are
// node's defaults for each key type -- so one verify call covers both.
function verifyWebauthnSig(cred, authDataBuf, clientDataRaw, sig) {
    const data = Buffer.concat([authDataBuf, sha256(clientDataRaw)]);
    try {
        const key = crypto.createPublicKey({ key: cred.jwk, format: 'jwk' });
        return crypto.verify('sha256', data, key, sig);
    } catch (e) { return false; }
}

// Per-IP login rate limiting / lockout
const loginFails = new Map(); // ip -> { count, lockUntil }
// Per-device identity for login rate-limiting. The server binds 127.0.0.1, so
// socket.remoteAddress is ALWAYS loopback -- without an ingress header every
// remote device would share one bucket and any failed-login lockout would lock
// every device at once. cf-connecting-ip covers Cloudflare; the first hop of
// x-forwarded-for covers `tailscale serve` (the peer's stable 100.x tailnet IP).
function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    const firstHop = typeof xff === 'string' ? xff.split(',')[0].trim() : '';
    return req.headers['cf-connecting-ip'] || firstHop || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function loginLocked(ip) {
    const f = loginFails.get(ip);
    return !!(f && f.lockUntil && f.lockUntil > Date.now());
}
function recordLoginFail(ip) {
    const f = loginFails.get(ip) || { count: 0, lockUntil: 0 };
    f.count++;
    if (f.count >= LOGIN_MAX_FAILS) { f.lockUntil = Date.now() + LOGIN_LOCK_MS; f.count = 0; }
    loginFails.set(ip, f);
}
function clearLoginFails(ip) { loginFails.delete(ip); }

// Headers that only ever appear when a request came through a reverse proxy or
// tunnel ingress. A hook curling 127.0.0.1 directly sets none of them.
//   - cf-*            : Cloudflare tunnel
//   - tailscale-user-*: `tailscale serve`, set by tailscaled and NOT forgeable by
//                       the client (it strips any client-supplied Tailscale-*)
//   - x-forwarded-*   : every reverse proxy in existence, including both of the above
// Measured 2026-08-11 against a live `tailscale serve` -- see DOCUMENTATION.md #13.
const PROXY_HEADERS = [
    'cf-ray', 'cf-connecting-ip',
    'tailscale-user-login', 'tailscale-headers-info',
    'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded',
];
// True unless the request is provably a direct localhost connection.
// DEFAULT-DENY, and that is the whole point: the old isTunnelRequest() asked
// "is this Cloudflare?", so ANY new ingress silently answered "no" and got
// treated as local, weakening three guards at once. This asks "did this pass
// through anything at all?" -- an ingress we have never met still classifies as
// remote, because they all set at least one x-forwarded-*.
// Do not narrow this to a single vendor's headers again.
function isRemoteRequest(req) {
    for (const h of PROXY_HEADERS) if (req.headers[h]) return true;
    return false;
}
// Authorize a provided token (Authorization header or ?token=) for a request.
function isAuthorized(provided, req) {
    if (validSession(provided)) return true;                 // post-2FA session: works anywhere
    if (!isRemoteRequest(req) && tokensMatch(provided, AUTH_TOKEN)) return true; // local master (hooks)
    return false;
}
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';

// Detect if server is running inside a tmux session (to protect it from being killed)
function getServerTmuxSession() {
    if (!process.env.TMUX) return null;
    try {
        return execSync('tmux display-message -p "#S"', { encoding: 'utf8', timeout: 10000 }).trim();
    } catch { return null; }
}
const SERVER_SESSION = getServerTmuxSession();

// Rocío's ATELIER sessions. They are hers, not a session of this machine's owner:
// ATELIER opens up to 3 at a time and parks them after 20 idle minutes, so they
// appear and vanish on their own. Without this they show up in the session list,
// count toward the weight badge, and pickInitialSession can adopt one on boot.
// The `ro-` prefix is a contract, enforced on the other side by
// personal/ro/ATELIER/server/lib/guard.js (assertOurs).
const isRoSession = (name) => String(name || '').startsWith('ro-');
// Tesla's hidden Haiku brains (lib/haikuBrain.js): real tmux sessions, never his.
const isHiddenSession = (name) => isRoSession(name) || String(name || '').startsWith('tesla-');

// Pick the first "real" tmux session to control: a user session, NOT the server's
// own session and NOT a runner (run-*). Returns '' when there is none — TSRCT then
// runs session-less (no zombie 'claude' is ever required or created).
function pickInitialSession() {
    try {
        const out = execSync('tmux list-sessions -F "#{session_name}"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: TMUX_TIMEOUT_MS }).trim();
        const names = out.split('\n').filter(Boolean)
            .filter(n => !n.startsWith('run-') && !isHiddenSession(n) && n !== SERVER_SESSION);
        return names[0] || '';
    } catch { return ''; }
}

// Event queue for real-time updates
const eventQueue = [];
const MAX_EVENTS = 50;

// Permission queue for remote approval
const permissionQueue = new Map();

// Auto-accept lives HERE, not in a browser. It used to be a localStorage Set per
// browser: nothing was approved unless a TSRCT tab was open, and the phone kept
// asking for sessions the desktop had already set to auto. The server approves
// on arrival (POST /api/permission) and every client reads the same list off
// the /api/permissions poll.
const AUTO_ACCEPT_PATH = path.join(__dirname, '.tsrct', 'auto-accept.json');
const autoAccept = new Set((() => {
    try { return JSON.parse(fs.readFileSync(AUTO_ACCEPT_PATH, 'utf8')).sessions || []; } catch { return []; }
})());
function saveAutoAccept() {
    try {
        fs.mkdirSync(path.dirname(AUTO_ACCEPT_PATH), { recursive: true });
        fs.writeFileSync(AUTO_ACCEPT_PATH, JSON.stringify({ sessions: [...autoAccept] }, null, 2));
    } catch (e) { console.error('[auto-accept] save failed:', e.message); }
}
// The last few it approved by itself, so an open page can still show the HUD.
const autoApprovedRecent = [];

function generateToken() {
    // Cryptographically strong (was Math.random, which is predictable).
    const token = crypto.randomBytes(24).toString('hex');
    console.log(`\n  Access Key: ${token}\n`);
    return token;
}

// ═══════════════════════════════════════════════════════════════════
// SF CLI - Workspace Config Persistence
// ═══════════════════════════════════════════════════════════════════
const SF_WORKSPACES_PATH = require('path').join(__dirname, 'data', 'sf-workspaces.json');

function sfLoadWorkspaces() {
    const fs = require('fs');
    try {
        return JSON.parse(fs.readFileSync(SF_WORKSPACES_PATH, 'utf8'));
    } catch (e) {
        return { workspaces: [] };
    }
}

function sfSaveWorkspaces(config) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(SF_WORKSPACES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SF_WORKSPACES_PATH, JSON.stringify(config, null, 2));
}

// ═══════════════════════════════════════════════════════════════════
// VAULT-AWARE PROMPT AUGMENTATION
// Detects project from CWD and prepends vault context to prompts
// ═══════════════════════════════════════════════════════════════════

const VAULT_PATH = paths.VAULT_ROOT;
const PROJECTS_ROOT = paths.PROJECTS_ROOT;
const UPLOADS_IMAGES = PROJECTS_ROOT + '/images';
const UPLOADS_FILES = PROJECTS_ROOT + '/files';

// ── Omni file-finder helpers (desktop universal search bar) ────────────────
// Every filesystem op the finder performs is confined to PROJECTS_ROOT and
// argv-exec'd (no shell). See handleAPI() /api/fs/* routes.
const FS_EXCLUDE_DIRS = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.cache',
    '.venv', 'venv', 'vendor', '.turbo', 'coverage', '.pytest_cache', '.mypy_cache',
    'target', 'out', '.gradle', '.idea', '.vscode-server',
]);

// Resolve a path and confine it to PROJECTS_ROOT. Returns the resolved absolute
// path, or null if it escapes the root. `root+sep` prefix check blocks the
// classic "<PROJECTS_ROOT>-evil" sibling-prefix bypass.
function resolveWithinProjects(p) {
    if (!p) return null;
    const resolved = path.resolve(String(p));
    if (resolved === PROJECTS_ROOT) return resolved;
    if (resolved.startsWith(PROJECTS_ROOT + path.sep)) return resolved;
    return null;
}

// ── Uploaded-images helpers (mobile GALLERY: list / delete / empty) ─────────
// The gallery can now DELETE, so every name arriving from the client is treated
// as hostile. Containment is by CONSTRUCTION, not by inspection: the client
// sends a BARE FILENAME (never a path), it must look like an image, and the
// resolved file must sit DIRECTLY inside UPLOADS_IMAGES. Comparing
// `path.dirname(resolved)` to the resolved dir (instead of a startsWith on the
// dir string) also closes the sibling-prefix bypass the 2026-08-14 audit found
// three times elsewhere -- `.../images-evil/x.png` has a different dirname.
// Fail closed: a name that does not pass is skipped and REPORTED to the caller,
// never repaired, normalized or partially matched into something deletable.
const UPLOAD_IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i;

function resolveUploadedImage(name) {
    const filename = String(name == null ? '' : name).trim();
    if (!filename || !UPLOAD_IMAGE_EXT_RE.test(filename)) return null;
    // A backslash is NOT a separator on this platform, so `..\x.png` survives
    // path.basename() and resolves to a real (absurdly named) file inside the
    // dir. Contained, but rejecting it outright keeps the guard true on any
    // platform instead of true-by-accident on this one.
    if (filename.includes('\\')) return null;
    if (filename !== path.basename(filename)) return null; // separators / traversal
    const resolved = path.resolve(UPLOADS_IMAGES, filename);
    if (path.dirname(resolved) !== path.resolve(UPLOADS_IMAGES)) return null;
    return resolved;
}

// Unlink one uploaded image, reporting the outcome instead of throwing: a bulk
// delete must not lose the whole batch because one file vanished underneath it.
function deleteUploadedImage(name, deleted, failed) {
    const filepath = resolveUploadedImage(name);
    if (!filepath) { failed.push({ filename: String(name).slice(0, 120), error: 'rejected' }); return 0; }
    try {
        const size = fs.statSync(filepath).size;
        fs.unlinkSync(filepath);
        deleted.push(path.basename(filepath));
        return size;
    } catch (e) {
        failed.push({ filename: path.basename(filepath), error: e.code || e.message });
        return 0;
    }
}

// A git remote URL can carry an embedded credential (POST /api/git/credentials
// stores a PAT as https://user:token@host/...), so it must NEVER be echoed back
// verbatim. /api/git/info already redacted; its sibling /api/git/remote/info did
// not and returned the token to the browser -- the same forward-only asymmetry
// the 2026-08-14 audit found everywhere. One helper, both call sites.
function redactRemoteUrl(url) {
    return String(url || '').replace(/(https?:\/\/)[^@\/]+@/, '$1');
}

// /mnt/<drive>/rest  ->  <DRIVE>:\rest  (for explorer.exe). Only WSL /mnt paths
// are convertible; anything else returns null (we never hand explorer a path we
// can't express as a Windows path).
function toWindowsPath(unixPath) {
    const m = String(unixPath).match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (!m) return null;
    return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

// Absolute path to Windows PowerShell, or null outside WSL.
// Do NOT rely on bare 'powershell.exe' resolving: WSL only appends the Windows
// PATH for interactive/login shells, and this server is started detached by
// boot-server.sh, so its PATH has no System32 and spawn() fails ENOENT. That
// matters because /api/restart exits this process right after handing off --
// an unresolvable launcher means the server dies and nothing brings it back.
const PS_CANDIDATES = [
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',
];
function findPowershell() {
    for (const p of PS_CANDIDATES) {
        try { if (fs.existsSync(p)) return p; } catch (e) {}
    }
    return null;
}

// Send a JSON body with conditional-GET + compression.
//
// Why this exists (measured 2026-08-11): the mobile poll hits /api/output AND
// /api/status every 5s, each ~71 KB of raw terminal snapshot, uncompressed and
// resent whether or not a single byte changed -- 98 MB/hour of mobile data with
// the app merely OPEN, plus a phone radio that never idles.
//
// Two independent wins, neither of which changes the poll cadence or what the
// user sees:
//   - ETag: an unchanged terminal answers 304 with NO body. `fetch()` revalidates
//     automatically because of Cache-Control: no-cache, and transparently returns
//     the cached body on 304 -- so this needs ZERO frontend changes.
//   - gzip: terminal text compresses ~2.6x.
// Idle polling therefore costs a few hundred bytes instead of 143 KB.
function sendJson(req, res, obj, statusCode) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const etag = '"' + crypto.createHash('sha1').update(body).digest('base64') + '"';
    const headers = {
        'Content-Type': 'application/json',
        'ETag': etag,
        'Cache-Control': 'no-cache',   // do cache, but always revalidate -> lets us answer 304
        'Vary': 'Accept-Encoding',
    };
    // Only 200s are conditional; an error body must always be delivered.
    if (!statusCode && req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
    }
    const code = statusCode || 200;
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    if (acceptsGzip && body.length > 1024) {
        zlib.gzip(body, (err, gz) => {
            if (err) {   // fall back to identity rather than fail the request
                headers['Content-Length'] = body.length;
                res.writeHead(code, headers);
                return res.end(body);
            }
            headers['Content-Encoding'] = 'gzip';
            headers['Content-Length'] = gz.length;
            res.writeHead(code, headers);
            res.end(gz);
        });
        return;
    }
    headers['Content-Length'] = body.length;
    res.writeHead(code, headers);
    res.end(body);
}

function detectProject(cwd) {
    // Same sibling-prefix flaw as /api/files/browse had: `startsWith(PROJECTS_ROOT)`
    // matches /…/PROJECTSEVIL, which would then be reported as a project and drive
    // vault augmentation for it. Not reachable as an exploit, but it is the same
    // defect and the same one-line fix. (Audit 2026-08-14.)
    if (!cwd || !resolveWithinProjects(cwd)) return null;
    // Extract project folder name from CWD
    const relative = cwd.substring(PROJECTS_ROOT.length + 1);
    const projectDir = relative.split('/')[0] || relative.split('\\')[0];
    return projectDir || null;
}

function findVaultProjectFile(projectName) {
    // Try exact match first, then case-insensitive
    const projectsDir = path.join(VAULT_PATH, 'projects');
    try {
        const files = fs.readdirSync(projectsDir);
        const exact = files.find(f => f.replace('.md', '') === projectName);
        if (exact) return path.join(projectsDir, exact);
        const lower = files.find(f => f.replace('.md', '').toLowerCase() === projectName.toLowerCase());
        if (lower) return path.join(projectsDir, lower);
    } catch (e) {}
    return null;
}

// ═══════════════════════════════════════════════════════════════════
// VAULT AUGMENTATION - Progressive narrative system
// Evolves with session length. Spends tokens only when needed.
//
// Phase 1 (msg 1):    Full setup - read all vault files, create missing ones
// Phase 2 (msg 2-5):  Silent - Claude has fresh context, zero tokens spent
// Phase 3 (msg 6):    Nudge - remind to write back to vault (short)
// Phase 4 (msg 12):   Re-anchor - re-read decisions log (may have changed)
// Phase 5 (msg 20+):  Refresh - full re-read (context may be degraded)
// Then cycles Phase 2-5 from there
// ═══════════════════════════════════════════════════════════════════

// The Decisions Log was split per project on 2026-09-24: wiki/decisions/<project>.md,
// newest entry at the TOP; `wiki/Decisions Log.md` is only the index now. Match the
// file case-insensitively; with none yet, name the one to create.
function decisionsFileFor(projectName) {
    const dir = path.join(VAULT_PATH, 'wiki', 'decisions');
    try {
        const hit = fs.readdirSync(dir).find(f => f.toLowerCase() === `${projectName.toLowerCase()}.md`);
        if (hit) return path.join(dir, hit);
    } catch {}
    return path.join(dir, projectName + '.md');
}

function buildVaultSetup(projectName, cwd) {
    const vaultFile = findVaultProjectFile(projectName);
    const docPath = path.join(cwd, 'DOCUMENTATION.md');
    const docExists = fs.existsSync(docPath);

    let h = `[VAULT:${projectName}] `;

    if (docExists) {
        h += `Read ${docPath} for codebase knowledge. `;
    } else {
        h += `No DOCUMENTATION.md found -- deep-scan this project and create ${docPath} before starting work. `;
    }

    if (vaultFile) {
        h += `Read ${vaultFile} for project rules. `;
    } else {
        h += `Create ${path.join(VAULT_PATH, 'projects', projectName + '.md')} with project overview. `;
    }

    h += `Read the top of ${decisionsFileFor(projectName)} for architecture decisions (newest first). `;
    h += `Read ${VAULT_PATH}/wiki/Patterns I Use.md for code patterns. `;
    h += `As you work: add decisions at the TOP of that decisions file, update DOCUMENTATION.md with findings.`;
    return h;
}

// Cache
let lastAugmentedCwd = '';
let lastAugmentedProject = '';
let lastAugmentedDocExists = null;
let cachedSetup = '';
const vaultHeaderSentTo = new Map(); // session -> { project, count }

function augmentPrompt(prompt, session) {
    const cwd = getSessionPwd(session);
    const projectName = detectProject(cwd);

    if (!projectName) {
        lastAugmentedProject = '';
        return prompt;
    }

    lastAugmentedProject = projectName;

    // Rebuild setup if project/cwd changed, or if DOCUMENTATION.md appeared/disappeared
    const docExists = fs.existsSync(path.join(cwd, 'DOCUMENTATION.md'));
    if (cwd !== lastAugmentedCwd || docExists !== lastAugmentedDocExists) {
        lastAugmentedCwd = cwd;
        lastAugmentedDocExists = docExists;
        cachedSetup = buildVaultSetup(projectName, cwd);
        console.log(`[VAULT] Project: ${projectName} (${cwd})`);
    }

    const sentInfo = vaultHeaderSentTo.get(session);
    const alreadySent = sentInfo && sentInfo.project === projectName;

    if (!alreadySent) {
        // Phase 1: Full setup (first message)
        vaultHeaderSentTo.set(session, { project: projectName, count: 1 });
        console.log(`[VAULT] Phase 1 SETUP -> ${session}`);
        return cachedSetup + ' ' + prompt;
    }

    sentInfo.count++;
    const n = sentInfo.count;

    // Phase 2: Silent (msgs 2-5, and between nudge points)
    // Only inject at specific milestones
    const decLog = decisionsFileFor(projectName);

    if (n === 6) {
        // Phase 3: Nudge - remind to write back
        console.log(`[VAULT] Phase 3 NUDGE -> ${session} (msg #${n})`);
        return `[${projectName}] If you've made architecture decisions, add them at the TOP of ${decLog} now. Update DOCUMENTATION.md with findings. ` + prompt;
    }

    if (n === 12) {
        // Phase 4: Re-anchor - re-read decisions (they may have been updated)
        console.log(`[VAULT] Phase 4 RE-ANCHOR -> ${session} (msg #${n})`);
        return `[${projectName}] Re-read the top of ${decLog} -- it may have been updated. Keep adding your decisions at its top. ` + prompt;
    }

    if (n >= 20 && n % 15 === 0) {
        // Phase 5: Refresh - full re-read (long session, context degraded)
        console.log(`[VAULT] Phase 5 REFRESH -> ${session} (msg #${n})`);
        return cachedSetup + ' ' + prompt;
    }

    // Silent - no augmentation, save tokens
    return prompt;
}

// ── Safe tmux invocation ─────────────────────────────────────────────────
// Every tmux call goes through here: args are passed as an argv ARRAY to
// execFileSync (NO shell), so session names, keys and message text can never be
// interpreted by a shell -- command injection is structurally impossible.
// opts.soft -> return '' instead of throwing on non-zero exit (replaces the old
// "2>/dev/null || echo ''" shell pattern).
// opts.timeout (default TMUX_TIMEOUT_MS): this call is SYNCHRONOUS, so a tmux
// that hangs used to freeze the whole server with no limit at all (a 2-minute
// freeze measured 2026-10-08 with the server idle on CPU, i.e. waiting).
function tmux(args, opts = {}) {
    try {
        return execFileSync('tmux', args, {
            encoding: 'utf8',
            maxBuffer: opts.maxBuffer || 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: opts.timeout || TMUX_TIMEOUT_MS,
        });
    } catch (e) {
        if (opts.soft) return '';
        throw e;
    }
}

// ── Session list change signal ───────────────────────────────────────────────
// tmux tells us when a session opens, closes or is renamed: three global hooks
// curl POST /api/sessions/changed, which bumps a counter. The PC sidebar asks
// for that counter every second (/api/sessions/version, a 304 when unchanged,
// zero tmux calls) and fetches the real list only when it moved. Before
// 2026-10-05 the sidebar re-listed every 3 s, so a session opened from a plain
// terminal took up to 3 s to appear.
// Hooks live in the tmux SERVER, which exits with its last session and comes
// back without them, so they are re-installed whenever its pid changes
// (checked on every /api/sessions, i.e. at least every 6 s while a PC window is
// open). Index [73] keeps them from overwriting a hook of his own.
const SESSION_HOOKS = ['session-created', 'session-closed', 'session-renamed'];
let sessionsVersion = 1;
let sessionHooksPid = null;
function bumpSessionsVersion() { sessionsVersion++; }
function ensureSessionHooks() {
    const pid = tmux(['display-message', '-p', '#{pid}'], { soft: true }).trim();
    if (!pid || pid === sessionHooksPid) return;
    const port = parseInt(PORT, 10);
    let host = /^[0-9a-zA-Z.:-]+$/.test(BIND_HOST) && BIND_HOST !== '0.0.0.0' && BIND_HOST !== '::' ? BIND_HOST : '127.0.0.1';
    if (host.includes(':')) host = `[${host}]`;
    const cmd = `run-shell -b "curl -s -m 2 -X POST http://${host}:${port}/api/sessions/changed >/dev/null 2>&1"`;
    for (const hook of SESSION_HOOKS) tmux(['set-hook', '-g', `${hook}[73]`, cmd], { soft: true });
    sessionHooksPid = pid;
    bumpSessionsVersion();
}

// ── Orchestrator self-refresh wiring (env-var half) ──────────────────────────
// Env vars injected into every tmux session TSRCT spawns. An `orchestrate` LEAD
// running inside a session uses these to reset its OWN context at a clean task
// boundary via POST /session/{id}/refresh (route below). The skill activates the
// feature ONLY when BOTH vars are present, so a session created before this
// change (or by another tool) is a silent no-op — exactly as intended.
//   TSRCT_SESSION_ID  = the tmux session name (== the {id} the refresh route uses)
//   TSRCT_REFRESH_URL = this server's local base URL (the skill curls it directly)
function sessionEnvArgs(sessionId) {
    return [
        '-e', `TSRCT_SESSION_ID=${sessionId}`,
        '-e', `TSRCT_REFRESH_URL=http://127.0.0.1:${PORT}`,
    ];
}

// Get the working directory of a tmux session
function getSessionPwd(session = TMUX_SESSION) {
    try {
        // Get the pane's current path
        const pwd = tmux(['display-message', '-t', session, '-p', '#{pane_current_path}']).trim();
        return pwd || process.cwd();
    } catch {
        return process.cwd();
    }
}

function sessionExists(session) {
    // Honor the caller's target session; fall back to the server default.
    // (The /api/status connection indicator passes the actually-active session,
    // which may differ from TMUX_SESSION -- checking only TMUX_SESSION made the
    // UI read OFFLINE while a differently-named live session worked fine.)
    const target = session || TMUX_SESSION;
    if (!target) return false;
    try {
        tmux(['has-session', '-t', target]);
        return true;
    } catch {
        return false;
    }
}

// ── /api/git/* target resolution + the SecretCo contract, in ONE place ──────────
//
// The 17 git routes split two ways: nine derive their directory from a tmux
// session (`getSessionPwd(session)`), eight take a `cwd` straight from the
// client. Both were unguarded, so `git/diff` and `git/changed-files` would
// stream SecretCo SOURCE into an HTTP response and `git/push` would send it to a
// remote. Seventeen hand-placed checks is how the gap appears in the first
// place, so resolution and the guard live together here and every route calls
// this instead of computing its own cwd.
//
// It RESPONDS 403 and returns null rather than throwing. Throwing was the first
// shape and it was wrong twice over: two routes had no enclosing try (an uncaught
// exception in a request handler), and several of the catches that would have
// caught it answer `{success:true, url:''}` or "Not a git repository" with a 200 —
// so a refusal would have been reported as an ordinary empty result. The contract
// says a blocked feature must FAIL, never silently downgrade, so the caller does:
//
//     const gitPwd = gitCwd(res, { session, op: 'log' }); if (!gitPwd) return;
//     if (!gitCwd(res, { cwd, op: 'info' })) return;
function gitCwd(res, { session, cwd, op }) {
    const resolved = cwd || getSessionPwd(session || TMUX_SESSION);
    if (restrictedGuard.mentionsRestricted(resolved, session)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: new restrictedGuard.RestrictedProjectError(`git ${op || ''}`.trim()).message,
            code: 'RESTRICTED_PROJECT',
        }));
        return null;
    }
    return resolved;
}

// ── Salesforce org alias: sanitize + the SecretCo contract, in ONE place ────────
//
// SecretCo is the sharpest case in the whole repo, and it is an OS-level problem the
// app cannot otherwise fix: the `sf` CLI hardcodes its auth store to $HOME
// (@salesforce/core global.js, no env override), so every process under
// your home folder shares all logged-in orgs. Authenticating or querying an SecretCo org
// through TSRCT drops its token into the store that every NON-Bedrock session can
// read — a contract breach by construction. The sanctioned path is
// (removed), which isolates $HOME and revokes on exit.
//
// Returns the sanitized alias, or null after responding 403.
function sfAlias(res, raw, op) {
    const alias = String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (restrictedGuard.mentionsRestricted(alias, raw)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: new restrictedGuard.RestrictedProjectError(`sf ${op || ''}`.trim()).message +
                ' Use (removed) (isolated $HOME) instead.',
            code: 'RESTRICTED_PROJECT',
        }));
        return null;
    }
    return alias;
}

function getRecentOutput(lines = 1000) {
    if (!TMUX_SESSION) return ''; // no session targeted — UI shows its empty state
    try {
        const output = tmux(['capture-pane', '-t', TMUX_SESSION, '-p', '-S', `-${lines}`]);
        return output;
    } catch {
        return 'Unable to capture output';
    }
}

function sendToTmux(text) {
    return sendToTmuxSession(text, TMUX_SESSION);
}

function sendToTmuxSession(text, session) {
    if (!session) return { success: false, error: 'No active session — create one first.' };
    try {
        // For long messages (>500 chars), use buffer method which is more reliable
        if (text.length > 500) {
            // Write to temp file, load into tmux buffer, paste, then delete
            const tempFile = `/tmp/tmux_send_${Date.now()}.txt`;
            fs.writeFileSync(tempFile, text, 'utf8');
            tmux(['load-buffer', tempFile]);
            tmux(['paste-buffer', '-t', session]);
            // Small delay to let terminal process the pasted text before Enter
            execSync('sleep 0.3', { stdio: 'pipe' });
            tmux(['send-keys', '-t', session, 'Enter']);
            // Clean up temp file
            try { fs.unlinkSync(tempFile); } catch (e) {}
            return { success: true, session, method: 'buffer' };
        } else {
            // For short messages, use send-keys (faster)
            tmux(['send-keys', '-t', session, text]);
            tmux(['send-keys', '-t', session, 'Enter']);
            return { success: true, session, method: 'keys' };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function sendRawToTmux(text) {
    try {
        tmux(['send-keys', '-t', TMUX_SESSION, text]);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function sendRawToTmuxSession(text, session) {
    try {
        tmux(['send-keys', '-t', session, text]);
        return { success: true, session };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function getSessionOutput(session, lines = 50) {
    try {
        const output = tmux(['capture-pane', '-t', session, '-p', '-S', `-${lines}`]);
        return { success: true, output: output.trim(), session };
    } catch (error) {
        return { success: false, error: error.message, output: '' };
    }
}

function sendKeyToTmux(key) {
    try {
        tmux(['send-keys', '-t', TMUX_SESSION, ...String(key).trim().split(/\s+/)]);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function sendKeyToTmuxSession(key, session) {
    try {
        tmux(['send-keys', '-t', session, ...String(key).trim().split(/\s+/)]);
        return { success: true, session };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ── Orchestrator self-refresh: idle detection + refresh sequence ─────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strip ANSI so the idle heuristics match on clean text.
const stripAnsiForIdle = paneShape.stripAnsi;

// Is the pane mid-turn? The shapes live in lib/paneShape.js, which is the ONLY
// place that knows what Claude Code's TUI looks like — this used to be a private
// copy of the regexes, and when the TUI changed on 2026-08-25 this copy read two
// actively-working panes as idle. paneShape.tailOf() also owns the .trim()-before-
// slice rule: tmux pads a capture with blank lines up to the pane height, and
// slicing the tail without trimming hides the live status line.
function paneWorkState(session) {
    let raw;
    try {
        raw = tmux(['capture-pane', '-t', session, '-p', '-S', '-40']);
    } catch {
        return { gone: true };
    }
    return { working: paneShape.looksLikeWorking(paneShape.tailOf(raw)), capture: raw };
}

// Poll until the pane is genuinely idle: NOT working AND the screen has been
// byte-stable across `stableNeeded` consecutive reads. A false "idle" mid-turn is
// the worst failure (a /clear or paste mid-turn corrupts the session), so we
// demand BOTH signals and several stable samples before declaring idle.
async function waitPaneIdle(session, opts = {}) {
    const { pollMs = 700, stableNeeded = 3, timeoutMs = 120000, initialDelayMs = 800 } = opts;
    const start = Date.now();
    await sleep(initialDelayMs);
    let prev = null, stable = 0;
    while (Date.now() - start < timeoutMs) {
        const s = paneWorkState(session);
        if (s.gone) return { ok: false, reason: 'session gone' };
        if (!s.working && prev !== null && s.capture === prev) {
            if (++stable >= stableNeeded) return { ok: true };
        } else {
            stable = 0;
        }
        prev = s.capture;
        await sleep(pollMs);
    }
    return { ok: false, reason: 'timeout waiting for idle' };
}

// Sessions with a self-refresh in flight — belt-and-suspenders against a stray
// double-call injecting twice (the skill already self-limits to 1/round).
const refreshInFlight = new Set();

// The full self-refresh sequence, run in the BACKGROUND after the HTTP ack. It
// MUST run after the caller's turn ends: the LEAD calls this as its last action,
// so while the curl is in flight the pane is still "working" (running the curl) —
// the pane only goes idle AFTER the caller ends its turn. Then we compact/clear
// and paste the resume prompt so the fresh lead re-enters its loop from WORKLOG.md.
async function runSelfRefresh(session, mode, resumePrompt) {
    const cmd = mode === 'clear' ? '/clear' : '/compact';
    try {
        // (a) Wait for the turn that issued this request to finish.
        let r = await waitPaneIdle(session, { timeoutMs: 120000 });
        if (!r.ok) { console.warn(`[refresh] ${session}: never idle before ${cmd} (${r.reason}) — aborting`); return; }

        // (b) Send /compact or /clear + Enter. Brief gap so the TUI's slash-command
        //     autocomplete settles before Enter submits it.
        tmux(['send-keys', '-t', session, cmd]);
        await sleep(450);
        tmux(['send-keys', '-t', session, 'Enter']);

        // (c) Let the command register (compact can take a while to summarize),
        //     then wait until the pane settles back to idle.
        await sleep(1500);
        r = await waitPaneIdle(session, { timeoutMs: mode === 'clear' ? 30000 : 180000 });
        if (!r.ok) { console.warn(`[refresh] ${session}: ${cmd} did not complete (${r.reason}) — aborting before resume paste`); return; }

        // (d) Paste the resume prompt + Enter. sendToTmuxSession uses the tmux
        //     buffer for long text (load-buffer -> paste-buffer -> Enter).
        const res = sendToTmuxSession(resumePrompt, session);
        if (!res || !res.success) { console.warn(`[refresh] ${session}: resume paste failed: ${res && res.error}`); return; }
        console.log(`[refresh] ${session}: ${cmd} done + resume prompt re-injected`);
    } catch (e) {
        console.warn(`[refresh] ${session}: sequence error: ${e.message}`);
    } finally {
        refreshInFlight.delete(session);
    }
}

// ── HANDS ON: the side Claude talks to ───────────────────────────────────────
// POST /handson/plan     { cwd, title, steps:[{file, action, anchor, note, lines:[{text, why}]}] }
// GET  /handson/events?cwd=&since=
// POST /handson/clear    { cwd }
//
// Local-only, no auth header, matched BEFORE the /api/ gate — the same contract
// as /session/{id}/refresh, and for the same reason: the caller is a `curl` from
// inside a tmux pane, which has no session token and should not be handed one.
// isRemoteRequest() is the only thing in front of these, so keep what they can
// do small: they read and write ONE json file of lesson text. They must never
// grow the ability to run, read or write anything in a project.
function handleHandsOn(req, res, action) {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (isRemoteRequest(req)) return json(403, { error: 'local only' });

    const finish = (body) => {
        let p = {};
        if (body !== null) {
            try { p = JSON.parse(body || '{}'); } catch { return json(400, { error: 'invalid JSON body' }); }
        }
        const cwd = String((p.cwd != null ? p.cwd : (parseReqUrl(req.url).query.cwd || ''))).trim();
        if (!cwd) return json(400, { error: 'cwd is required — it is the project key, and it is the cwd of the tmux session you are in' });
        // SecretCo: a plan is lesson text about a repo, and the key is a real path.
        // Fail closed here rather than at three call sites below.
        if (restrictedGuard.mentionsRestricted(cwd)) return json(403, { error: 'Access denied (SecretCo)' });

        if (action === 'plan') {
            const r = handson.putPlan(cwd, p, new Date().toISOString());
            if (!r.ok) return json(400, { error: r.error });
            console.log(`[handson] plan published for ${cwd}: ${r.steps} step(s), ${r.lines} line(s)`);
            return json(200, { ok: true, ...r });
        }
        if (action === 'events') {
            return json(200, handson.getEvents(cwd, parseReqUrl(req.url).query.since));
        }
        if (action === 'clear') {
            const r = handson.clearPlan(cwd);
            return json(r.ok ? 200 : 404, r);
        }
        return json(404, { error: 'unknown handson action' });
    };

    if (req.method === 'GET') return finish(null);
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
    req.on('end', () => finish(body));
}

// POST /session/{id}/refresh  { mode: "compact"|"clear", resume_prompt: "..." }
// Local-only, no auth header (the client contract curls localhost from inside the
// pane). It can inject keystrokes into any pane, so it must never be reachable
// through ANY ingress -- this route is matched before the /api/ auth gate, so
// isRemoteRequest() is the only thing standing in front of it.
function handleSessionRefresh(req, res, sessionId) {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (isRemoteRequest(req)) return json(403, { error: 'local only' });
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) return json(400, { error: 'invalid session id' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
        let mode, resumePrompt;
        try {
            const p = JSON.parse(body || '{}');
            mode = p.mode;
            resumePrompt = p.resume_prompt;
        } catch { return json(400, { error: 'invalid JSON body' }); }
        if (mode !== 'compact' && mode !== 'clear') return json(400, { error: "mode must be 'compact' or 'clear'" });
        if (typeof resumePrompt !== 'string' || !resumePrompt.trim()) return json(400, { error: 'resume_prompt (non-empty string) required' });
        // Defense-in-depth: strip control/ANSI so a stray sequence can't corrupt
        // the pane on paste (the caller is the trusted local skill, but cheap).
        resumePrompt = resumePrompt
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
            .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
            .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '');
        if (resumePrompt.length > 8000) resumePrompt = resumePrompt.slice(0, 8000);
        try { tmux(['has-session', '-t', sessionId]); }
        catch { return json(404, { error: `no such session: ${sessionId}` }); }
        if (refreshInFlight.has(sessionId)) return json(200, { status: 'already_refreshing', session: sessionId });
        refreshInFlight.add(sessionId);
        // ACK immediately, then run in the BACKGROUND. It cannot run synchronously:
        // while this curl is in flight the pane is "working" (running the curl), so
        // the pane only goes idle AFTER the caller ends its turn — at which point
        // runSelfRefresh's poll-idle succeeds and it compacts/clears + resumes.
        json(200, { status: 'scheduled', session: sessionId, mode });
        setImmediate(() => runSelfRefresh(sessionId, mode, resumePrompt));
    });
}

// ── Session weight: wire the module to this server's tmux primitives ─────────
// Injected rather than required back the other way, so lib/sessionWeight.js
// never reaches into server.js. It reuses the SAME idle contract as the refresh
// sequence above: never inject into a pane mid-turn.
sessionWeight.configure({
    tmux,
    sleep,
    waitPaneIdle,
    getSessionPwd,
    sessionExists: (name) => sessionExists(name),
    sendToTmuxSession,
    sessionEnvArgs,
    getConfig: (k) => (dispatcher && dispatcher.db ? dispatcher.db.getConfig(k) : null),
    setConfig: (k, v) => { if (dispatcher && dispatcher.db) dispatcher.db.setConfig(k, v); },
});

// The project registry reads the vault for `path:` frontmatter and remembers
// overrides in the config table. projectContext is handed in rather than
// required inside it, so the registry keeps working when the dispatcher is off.
projectRegistry.configure({
    projectContext: dispatcher ? dispatcher.projects : null,
    getConfig: (k) => (dispatcher && dispatcher.db ? dispatcher.db.getConfig(k) : null),
    setConfig: (k, v) => { if (dispatcher && dispatcher.db) dispatcher.db.setConfig(k, v); },
});

// The morning routine: headless Claude decides, sessionSpawn opens. The analyst
// is the ONLY `claude -p` runner it may use, because that is where the SecretCo
// choke point lives.
morningRoutine.configure({
    analyst: dispatcher ? dispatcher.clickupAnalyst : null,
    jsonJob,
    registry: projectRegistry,
    sessionSpawn,
    listSessions: () => {
        try {
            return tmux(['list-sessions', '-F', '#{session_name}']).trim().split('\n').filter(Boolean).filter(n => !isHiddenSession(n));
        } catch { return []; }
    },
    sessionExists: (name) => sessionExists(name),
    addEvent,
    push,
    ring,
    hermes: dispatcher ? dispatcher.hermes : null,
});

// TALK gets the same model the rest of the server uses, plus the two things
// worth knowing when he asks a question out loud: what the brief said this
// morning, and which sessions are open right now.
// The ring needs both channels and the public address of this machine, because
// the "ANSWER" button in the ntfy app is a plain link and has to reach TSRCT
// from outside the browser that made it.
ring.configure({
    push,
    // Standalone, not `dispatcher.ntfyPush`: the phone must still ring on a boot
    // where the dispatcher failed to load — that is exactly a moment worth being
    // told about.
    ntfy: require('./lib/dispatcher/ntfyPush'),
    url: (process.env.REMOTE_URL || '').replace(/\/$/, ''),
});

// Every action points at the function the BUTTON already calls — no second copy
// of any behaviour, which is what keeps the catalogue honest as the code moves.
actions.configure({
    tmux: dispatcher ? dispatcher.tmux : null,
    sessionSpawn,
    // Closing a session goes through the argv choke point, and through the same
    // two refusals the [x] button in the UI has: never this server's own session,
    // never an SecretCo one. The name it is given has already been matched against
    // the live list by lib/actions.js, so this is the second check, not the first.
    killSession: (name) => {
        const safe = String(name || '').replace(/[^a-zA-Z0-9_.@-]/g, '');
        if (!safe) return { ok: false, error: 'no session name' };
        restrictedGuard.assertNotRestricted('close session (assistant)', safe);
        if (SERVER_SESSION && safe === SERVER_SESSION) {
            return { ok: false, error: 'esa es la sesion donde corre TSRCT, no la puedo cerrar' };
        }
        tmux(['kill-session', '-t', safe]);
        if (TMUX_SESSION === safe) TMUX_SESSION = pickInitialSession();
        return { ok: true, killed: safe };
    },
    projectRegistry,
    // What a project has been up to (its note, the last decisions, where the
    // previous session left off) — the same reader the narrator uses, with the
    // same caching and the same SecretCo refusal by name.
    projectMemory,
    // The saved boards: a setup is a list of the actions above, said once.
    setups,
    morningRoutine,
    gpu: require('./lib/gpu'),
    // BULK (2026-09-24): the permission cards, the weight badge and handoff,
    // today's usage, the Clients tab, keys to many panes, and git per folder.
    permissionDesk,
    sessionWeight,
    usage,
    paneKeys,
    promptWriter,
    teslaHands,
    pcDirect,
    deskWindows: require('./lib/deskWindows'),
    deskShortcuts: require('./lib/deskShortcuts'),
    serverSession: () => SERVER_SESSION,
    // Read-only, argv, and under the same two rules as gitCwd(): an allowed
    // root and never SecretCo.
    gitSummary: (cwd) => {
        const dir = String(cwd || '');
        if (!require('./lib/dispatcher/tmuxAdapter').isCwdAllowed(dir)) throw new Error('folder not allowed');
        restrictedGuard.assertNotRestricted('git summary (assistant)', dir);
        const git = (args) => execFileSync('git', args, { encoding: 'utf8', cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], timeout: 8000 }).trim();
        const changed = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
        let ahead = 0;
        try { ahead = Number(git(['rev-list', '--count', '@{u}..HEAD'])) || 0; } catch { ahead = 0; }
        return { branch: git(['branch', '--show-current']), changed, ahead, last: git(['log', '-1', '--format=%s']).slice(0, 80) };
    },
});
permissionDesk.configure({ queue: () => permissionQueue });
// His musical taste: the pool of picks is refilled by a background job through
// the same choke point as every other `claude -p` job.
require('./lib/tasteBrain').configure({ analyst: dispatcher ? dispatcher.clickupAnalyst : null, jsonJob });
// Opus writes the prompt in the background; the same job runner, the same
// paste into a session, the same page button that fills his box.
promptWriter.configure({
    analyst: dispatcher ? dispatcher.clickupAnalyst : null,
    jsonJob,
    cwdOf: (session) => getSessionPwd(session),
    // -e keeps the colours, so readableTail can drop Claude's dim suggested prompt.
    screenOf: (session) => paneShape.readableTail(tmux(['capture-pane', '-t', session, '-p', '-e', '-S', '-80']), { lines: 40, chars: 2500 }),
    send: (text, session) => sendToTmuxSession(text, session),
    draft: (text, session) => uiActions.CATALOG.find(a => a.name === 'draft_prompt').run({ text, session: session || '' }),
    // Told to him whether or not he is talking: the orb shows it (and speaks it
    // in a conversation), and with no TSRCT window watching it goes to his phone.
    say: (line) => {
        talk.announce(line);
        if (!talk.someoneWatching()) {
            require('./lib/dispatcher/ntfyPush').send({ title: 'Tesla', body: String(line).slice(0, 300), tags: ['memo'] })
                .catch(e => console.warn('[promptWriter] ntfy:', e.message));
        }
    },
    journal: stateFile('prompt-jobs.jsonl', '.tsrct-prompt-jobs.jsonl'),
    // The "Sam me pidio esto" flow: where the work could go, where to put a new
    // folder, and how to open the session once he says yes.
    projects: () => projectRegistry.list().filter(p => p.known).map(p => ({ name: p.project, cwd: p.cwd })),
    // Never an SecretCo session's name (review #15): it would make the job's SecretCo guard refuse the whole job.
    sessions: () => { try { return tmux(['list-sessions', '-F', '#{session_name}']).trim().split('\n').filter(Boolean).filter(n => !isHiddenSession(n) && !n.startsWith('run-') && !restrictedGuard.mentionsRestricted(n)); } catch { return []; } },
    resolveProject: (name) => projectRegistry.resolve(name),
    projectsRoot: projectRegistry.PROJECTS_ROOT,
    uploadRoots: [UPLOADS_IMAGES, UPLOADS_FILES],
    sessionExists: (n) => { try { tmux(['has-session', '-t', `=${n}`]); return true; } catch { return false; } },
    nextSessionName: (n, exists) => sessionSpawn.nextSessionName(n, exists),
    spawn: (o) => sessionSpawn.createPrimedSession(o),
    // A plan that lands is OFFERED: the question is asked out loud (or pushed to
    // his phone), and it also waits in the panel with its own buttons.
    // Only into a conversation that is live: propose() would otherwise open one.
    offer: (key) => (talk.inConversation() ? talk.propose('start_task', { job: key }) : null),
});
// Tesla's hands: what it does when no action fits (lib/teslaHands.js).
teslaHands.configure({
    tmux: (args) => tmux(args),
    spawn: (o) => sessionSpawn.createPrimedSession(o),
    paste: (s, text) => sessionSpawn.pasteIntoPane(s, text),
    readAnswer: (entry) => require('./lib/haikuBrain')._readAnswer(entry),
    denyRules: () => (dispatcher ? dispatcher.clickupAnalyst.restrictedDenyRules() : []),
    cwdOf: (session) => getSessionPwd(session),
    projectsRoot: projectRegistry.PROJECTS_ROOT,
    dataDir: path.join(__dirname, 'data'),
    logFile: path.join(__dirname, 'logs', 'tesla-workarounds.md'),
    // draft_reply's text: into his input box, UNSENT - the same door promptWriter uses.
    draft: (text) => uiActions.CATALOG.find(a => a.name === 'draft_prompt').run({ text, session: '' }),
    // A permission it stops on is ASKED about (Tesla review #10), so his "si" approves it.
    permission: (session) => actions.permissionWaiting(session),
    offer: (name, args) => talk.propose(name, args),
    say: (line, opts) => {
        talk.announce(line, opts);
        if (!talk.someoneWatching()) {
            require('./lib/dispatcher/ntfyPush').send({ title: 'Tesla', body: String(line).slice(0, 300), tags: ['memo'] })
                .catch(e => console.warn('[hands] ntfy:', e.message));
        }
    },
});
talk.configure({
    background: () => [...teslaHands.list(), ...promptWriter.list()],
    backgroundText: () => [teslaHands.describe(), promptWriter.describe()].filter(Boolean).join('; '),
    cleanFiles: (f) => promptWriter.cleanFiles(f),
    // The files the watched session just wrote, so "abrilo" has a path (lib/pcDirect.js).
    sessionFiles: (session) => pcDirect.filesLine(session),
});
// The PC without the mouse (2026-10-10): open, reveal, launch, move; and since
// 2026-10-11 windows, layouts, workspaces, zones and named shortcuts
// (lib/deskWire.js connects them the same way for the CLI).
require('./lib/deskWire').wire({ direct: true, pcDirect: {
    transcriptFor: (session) => require('./lib/pastSessions').transcriptFor(session,
        (s) => tmux(['display-message', '-t', s, '-p', '#{pane_current_path}']).trim()),
    resolveProject: (spoken) => { try { return projectRegistry.resolve(spoken); } catch { return null; } },
} });
paneKeys.configure({ tmux: (args) => tmux(args), serverSession: () => SERVER_SESSION });

talk.configure({
    hermes: dispatcher ? dispatcher.hermes : null,
    brief: () => {
        const s = morningRoutine.loadState();
        return (s && s.brief) ? s.brief : '';
    },
    sessions: () => {
        try {
            // Runners (run-*) are a server or a script, not a session he talks to.
            // An SecretCo session's name goes nowhere near Tesla's brain (review #15:
            // `secretco-doc` open = every question refused, "hola" included).
            return tmux(['list-sessions', '-F', '#{session_name}']).trim().split('\n').filter(Boolean).filter(n => !isHiddenSession(n) && !n.startsWith('run-') && !restrictedGuard.mentionsRestricted(n));
        } catch { return []; }
    },
    // The two halves of "talk to my session": read its screen, and type into it.
    // Both are the same argv choke point everything else here uses — TALK never
    // builds a shell string, and the session name it passes has already been
    // through talk.js's own guard (shape + SecretCo).
    // -e: colours kept so the dim suggested prompt can be told from his typing
    // (every reader of this capture strips ANSI first).
    capture: (session, lines) => tmux(['capture-pane', '-t', session, '-p', '-e', '-S', `-${lines || 140}`]),
    send: (text, session) => sendToTmuxSession(text, session),
    // Tesla's hidden Haiku brains (lib/haikuBrain.js): the same argv choke point,
    // plus where a session sits so its brain opens in the same project.
    brain: { tmux: (args) => tmux(args), cwdOf: (session) => getSessionPwd(session) },
    // What the session IS, so the narration can be about the work rather than
    // about the last screen: the folder it sits in, and that project's vault
    // note if there is one. Bounded on purpose (the note's head, not the note) —
    // context is latency on an 8GB card, and the top of those notes is where the
    // current state lives.
    // The session's folder decides WHICH project; lib/projectMemory.js decides
    // what is worth knowing about it (the note, the last decisions, where the
    // last session left off) and owns the caching and the caps, because the
    // Decisions Log is ~3MB and the narrator asks for this every time it speaks.
    project: (session) => {
        try {
            const cwd = getSessionPwd(session);
            const name = cwd ? path.basename(cwd) : '';
            if (!name) return null;
            return projectMemory.forProject(name, cwd);
        } catch {
            return null;
        }
    },
});

// The usage reader gets the SecretCo guard the same way every other subsystem does:
// standalone, never through `dispatcher.restrictedGuard`. It enumerates transcript
// directories, so it is exactly the kind of place the contract has to hold.
usage.configure({ restrictedGuard });

function tmuxNextPane(session) {
    try {
        tmux(['select-pane', '-t', session, '-t', ':.+']);
        return { success: true, session };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function addEvent(event) {
    event.id = Date.now();
    event.timestamp = event.timestamp || Date.now();
    eventQueue.unshift(event);
    if (eventQueue.length > MAX_EVENTS) {
        eventQueue.pop();
    }
}

function getEvents(since = 0) {
    return eventQueue.filter(e => e.timestamp > since);
}

function getLatestActivity() {
    return eventQueue[0] || null;
}

// ntfy push notifications are DISABLED (user doesn't use them). Kept as a no-op
// so existing call sites stay valid. Re-enable by restoring the https.request body.
function sendNtfy(/* title, body, tags, priority */) {
    return;
}

// ═══════════════════════════════════════════════════════════════════
// VNC REMOTE DESKTOP - Configuration Helpers
// ═══════════════════════════════════════════════════════════════════

const VNC_CONFIG_PATH = path.join(__dirname, '.tsrct', 'vnc-config.json');

function getWSLWindowsHost() {
    // WSL2 NAT mode: Windows isn't reachable via localhost, resolve the host IP
    try {
        const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8');
        const match = resolv.match(/nameserver\s+(\d+\.\d+\.\d+\.\d+)/);
        if (match) return match[1];
    } catch (e) {}
    return null;
}

function isWSLMirroredMode() {
    // In mirrored networking mode (.wslconfig networkingMode=mirrored) WSL shares
    // the Windows network stack, so Windows services are reachable via localhost
    // and the resolv.conf nameserver IP is NOT routable. In NAT mode the default
    // gateway lives in the WSL virtual switch range (172.16.0.0/12) and Windows is
    // only reachable via the nameserver IP. Detect by inspecting the default route.
    try {
        const lines = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
        for (const line of lines) {
            const cols = line.split(/\s+/);
            const dest = cols[1], gwHex = cols[2];
            if (dest === '00000000' && gwHex && gwHex !== '00000000') {
                // Gateway is stored as little-endian hex (e.g. 0101A8C0 -> 192.168.1.1)
                const octets = gwHex.match(/../g).reverse().map(h => parseInt(h, 16));
                const isNatSwitch = octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
                return !isNatSwitch;
            }
        }
    } catch (e) {}
    return false; // assume NAT (preserves legacy resolv.conf resolution)
}

function resolveVNCHost(host) {
    // Only localhost needs WSL->Windows translation; explicit IPs pass through.
    if (host !== 'localhost' && host !== '127.0.0.1') return host;
    if (isWSLMirroredMode()) return '127.0.0.1';
    return getWSLWindowsHost() || host;
}

function readVNCConfig() {
    const config = readVNCConfigRaw();
    config.host = resolveVNCHost(config.host);
    return config;
}

// As stored on disk, with 'localhost' left alone. Read-modify-write callers MUST
// use this: readVNCConfig() resolves the host for the current WSL networking
// mode, so writing its result back bakes today's IP into the file and the entry
// stops adapting if that mode ever changes.
function readVNCConfigRaw() {
    try {
        return JSON.parse(fs.readFileSync(VNC_CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { host: 'localhost', port: 5900, password: '' };
    }
}

function writeVNCConfig(config) {
    const dir = path.join(__dirname, '.tsrct');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(VNC_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Enumerate the Windows monitors and the virtual-desktop bounding box they
// span. The VNC framebuffer IS that bounding box, so a screen's position
// inside it is (bounds - virtual.origin), which is what lets the client crop
// to one monitor without knowing the framebuffer size up front.
//
// Pipe-delimited output, not ConvertTo-Json: PS 5.1 serializes a single-element
// pipeline as an object rather than a one-element array, so the JSON shape
// changes when only one monitor is attached.
let vncScreenCache = null;
let vncScreenCacheAt = 0;
const VNC_SCREEN_CACHE_MS = 10000;

// `force` skips the cache — required after changing the display topology, or the
// crop would be computed against the layout that existed 10 seconds ago.
function readWindowsScreens(force) {
    const now = Date.now();
    if (!force && vncScreenCache && now - vncScreenCacheAt < VNC_SCREEN_CACHE_MS) return vncScreenCache;

    const ps = findPowershell();
    if (!ps) return { screens: [], virtual: null, error: 'PowerShell not found (not WSL?)' };

    const script = 'Add-Type -AssemblyName System.Windows.Forms; ' +
        '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { ' +
        '"{0}|{1}|{2}|{3}|{4}|{5}" -f $_.DeviceName, $_.Primary, ' +
        '$_.Bounds.X, $_.Bounds.Y, $_.Bounds.Width, $_.Bounds.Height }';

    const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 10000 });

    const screens = [];
    for (const line of out.split('\n')) {
        const m = line.trim().match(/^(.+)\|(True|False)\|(-?\d+)\|(-?\d+)\|(\d+)\|(\d+)$/);
        if (!m) continue;
        const name = m[1];
        const num = name.match(/(\d+)\s*$/);
        screens.push({
            name,
            order: num ? parseInt(num[1]) : 99,
            primary: m[2] === 'True',
            x: parseInt(m[3]), y: parseInt(m[4]),
            w: parseInt(m[5]), h: parseInt(m[6])
        });
    }

    // Order by the adapter's DISPLAY number (AllScreens' own order is
    // unspecified), then label 1..N. The label must be the ORDINAL, not the
    // device number: Windows names these DISPLAY1/DISPLAY5 internally but
    // Display Settings shows the user "1" and "2", and the user's "monitor 1"
    // means the one on that screen.
    screens.sort((a, b) => a.order - b.order);
    screens.forEach((s, i) => { s.label = String(i + 1); delete s.order; });

    let virtual = null;
    if (screens.length) {
        const x = Math.min(...screens.map(s => s.x));
        const y = Math.min(...screens.map(s => s.y));
        const r = Math.max(...screens.map(s => s.x + s.w));
        const b = Math.max(...screens.map(s => s.y + s.h));
        virtual = { x, y, w: r - x, h: b - y };
    }

    vncScreenCache = { screens, virtual };
    vncScreenCacheAt = now;
    return vncScreenCache;
}

// ── SOLO — collapse the desktop to the one screen actually being watched ─────
//
// Why this exists: with two monitors the VNC framebuffer is the WHOLE virtual
// desktop (5440x2172 here). The client-side crop is COSMETIC — the phone still
// allocates and paints a canvas the full size of that framebuffer, which is what
// makes an older handset stutter. Turning the other screen off is the only lever
// that shrinks the framebuffer itself, and it drags every window onto the screen
// you can actually see.
//
// The hard part: DisplaySwitch.exe takes a MODE, not a monitor id, so it CANNOT
// be told "keep the one being watched". /internal and /external describe which
// port a display hangs off, which is not the same question as which one is
// primary or which one you are looking at. So the mode is TRIED and the result
// VERIFIED against the screen we meant to keep, the other mode is the second
// attempt, and /extend is the auto-revert. Pressing this from a phone in a
// bathroom must never be able to leave the machine showing the screen you cannot
// see, with no way back.
const DISPLAYSWITCH_CANDIDATES = [
    '/mnt/c/Windows/System32/DisplaySwitch.exe',
    '/mnt/c/Windows/Sysnative/DisplaySwitch.exe',
];
function findDisplaySwitch() {
    for (const p of DISPLAYSWITCH_CANDIDATES) {
        try { if (fs.existsSync(p)) return p; } catch (e) {}
    }
    return null;
}

const sleepAsync = (ms) => new Promise(r => setTimeout(r, ms));

// Async on purpose: this blocks for seconds, and a sync spawn here would freeze
// the terminal poll, the permission queue and every other session with it.
function execFileAsync(bin, args, timeout) {
    return new Promise(resolve => {
        execFile(bin, args, { timeout }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
}

// The sf CLI takes 2-10s per call (measured 7.4s for `sf org list`, 2026-10-08)
// and up to 120s for a query or Apex. Run synchronously, every one of those
// seconds froze the WHOLE server: every window, every poll. Always async.
function sfRun(args, timeout) {
    return new Promise(resolve => {
        execFile('sf', args, {
            timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
            cwd: process.env.HOME || '/tmp',
        }, (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
    });
}

// Same reason for git on /mnt/c: ~0.1-0.7s per command through the Windows
// filesystem. Resolves to trimmed stdout, or null when the command failed.
function gitOut(cwd, args, timeout = 15000) {
    return new Promise(resolve => {
        execFile('git', args, { cwd, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
            (err, stdout) => resolve(err ? null : String(stdout || '')));
    });
}

// The three decisions SOLO makes, kept pure so they can be tested against real
// monitor layouts without switching anybody's displays.
//
// soloModeOrder  — which mode to try first. /internal is the internal panel,
//                  which is USUALLY but not always the primary, hence an order
//                  rather than a choice.
// soloAmbiguous  — two identical panels cannot be told apart by geometry, so the
//                  verification below cannot be trusted and must say so.
// soloKept       — did we land on exactly the screen we meant to keep?
function soloModeOrder(keep) {
    return keep && keep.primary ? ['/internal', '/external'] : ['/external', '/internal'];
}
function soloAmbiguous(screens, keep) {
    if (!keep || !Array.isArray(screens)) return false;
    return screens.filter(s => s.w === keep.w && s.h === keep.h).length > 1;
}
function soloKept(after, keep, ambiguous) {
    if (!Array.isArray(after) || after.length !== 1 || !keep) return false;
    const got = after[0];
    if (!got) return false;
    return ambiguous ? true : (got.w === keep.w && got.h === keep.h);
}

async function setDisplayTopology(mode) {
    const bin = findDisplaySwitch();
    if (!bin) return { ok: false, error: 'DisplaySwitch.exe not found (not WSL?)' };
    const r = await execFileAsync(bin, [mode], 15000);
    if (r.err) return { ok: false, error: r.err.message };
    // Windows applies the change AFTER the call returns; AllScreens lies until
    // it settles, so a read taken immediately would verify the old layout.
    await sleepAsync(1800);
    return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════
// VNC REMOTE DESKTOP - WebSocket Frame Helpers (RFC 6455)
// ═══════════════════════════════════════════════════════════════════

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_OP_TEXT = 0x01;
const WS_OP_BINARY = 0x02;
const WS_OP_CLOSE = 0x08;
const WS_OP_PING = 0x09;
const WS_OP_PONG = 0x0A;

function wsAcceptKey(clientKey) {
    return crypto.createHash('sha1')
        .update(clientKey + WS_GUID)
        .digest('base64');
}

function parseWSFrame(buffer) {
    if (buffer.length < 2) return null;

    const byte0 = buffer[0];
    const byte1 = buffer[1];
    const opcode = byte0 & 0x0F;
    const masked = (byte1 & 0x80) !== 0;
    let payloadLen = byte1 & 0x7F;
    let offset = 2;

    if (payloadLen === 126) {
        if (buffer.length < 4) return null;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
    } else if (payloadLen === 127) {
        if (buffer.length < 10) return null;
        const hi = buffer.readUInt32BE(2);
        const lo = buffer.readUInt32BE(6);
        payloadLen = hi * 0x100000000 + lo;
        offset = 10;
    }

    const maskSize = masked ? 4 : 0;
    const totalLen = offset + maskSize + payloadLen;
    if (buffer.length < totalLen) return null;

    let payload;
    if (masked) {
        const maskKey = buffer.slice(offset, offset + 4);
        payload = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
            payload[i] = buffer[offset + 4 + i] ^ maskKey[i & 3];
        }
    } else {
        payload = buffer.slice(offset, offset + payloadLen);
    }

    return { opcode, payload, bytesConsumed: totalLen };
}

function buildWSFrame(opcode, payload) {
    const len = payload.length;
    let header;

    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
        header.writeUInt32BE(len % 0x100000000, 6);
    }

    return Buffer.concat([header, payload]);
}

// Active VNC proxy connections for cleanup
let activeVNCProxy = null;
let activeAudioProxy = null;

// ── Remote-desktop data meter ──────────────────────────────────────────
// Both proxies are the only place that sees every byte, so they count here
// and /api/vnc/status reports it. This exists because the cost of the RD
// room was invisible: nothing in the UI ever said that leaving audio on
// spends a phone's monthly allowance in an afternoon. `silent` is what the
// silence gate did NOT send, so the saving is visible too.
const rdMeter = { vncDown: 0, vncUp: 0, audio: 0, audioSilent: 0, since: Date.now() };
function rdMeterReset() {
    rdMeter.vncDown = 0; rdMeter.vncUp = 0;
    rdMeter.audio = 0; rdMeter.audioSilent = 0;
    rdMeter.since = Date.now();
}

// Load UI from file - tries modular version first, falls back to monolithic
function getMobileHTML() {
    try {
        // Try modular version first
        const modularPath = path.join(__dirname, 'src', 'index.html');
        if (fs.existsSync(modularPath)) {
            // PROJECTS_ROOT goes into the page for the browser code (app.js reads it)
            const root = String(PROJECTS_ROOT).replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
            // ...and the owner's language (OWNER_LANG), so the voice starts in it.
            const lang = require('./lib/owner').LANG;
            return fs.readFileSync(modularPath, 'utf8').replace('</head>',
                `    <meta name="tsrct-projects-root" content="${root}">\n    <meta name="tsrct-lang" content="${lang}">\n</head>`);
        }
        // Fallback to monolithic ui.html
        return fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
    } catch (e) {
        return '<h1>UI not found</h1>';
    }
}

// ═══════════════════════════════════════════════════════════════════
// HANDS-FREE IMMERSIVE MODE v2 - Using Claude CLI properly
// ═══════════════════════════════════════════════════════════════════

const hfSessions = new Map();
const MAX_HF_SESSIONS = 5;
const HF_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 min inactivity

// SSE clients for each HF session
const hfSSEClients = new Map(); // sessionId -> Set of response objects

// Find Claude CLI binary path (cached)
let claudeBinaryPath = null;
function findClaudeBinary() {
    if (claudeBinaryPath) return claudeBinaryPath;

    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const home = process.env.HOME || process.env.USERPROFILE;

    // Common paths to check
    const possiblePaths = [
        // Try which/where first
        null, // placeholder for which result
        // npm global installations
        path.join(home, '.npm-global', 'bin', 'claude'),
        path.join(home, '.nvm', 'versions', 'node', process.version, 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        // Bun
        path.join(home, '.bun', 'bin', 'claude'),
        // Direct npm bin
        path.join(home, 'node_modules', '.bin', 'claude'),
    ];

    // Try which/where command first
    try {
        const whichCmd = process.platform === 'win32' ? 'where claude' : 'which claude';
        const result = execSync(whichCmd, { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
        if (result && fs.existsSync(result)) {
            claudeBinaryPath = result;
            return claudeBinaryPath;
        }
    } catch (e) {
        // which failed, try paths
    }

    // Check each path
    for (const p of possiblePaths) {
        if (p && fs.existsSync(p)) {
            claudeBinaryPath = p;
            return claudeBinaryPath;
        }
    }

    // Fallback to just 'claude' and hope it's in PATH
    claudeBinaryPath = 'claude';
    return claudeBinaryPath;
}

class HFSession {
    constructor(id, cwd = process.cwd(), resumeId = null, opts = {}) {
        this.id = id;
        this.cwd = cwd;
        this.conversationId = resumeId; // Can be set from resume parameter
        this.currentProcess = null;
        this.messages = [];
        this.state = 'idle'; // idle, processing, speaking, permission, error
        this.lastActivity = Date.now();
        this.pendingPermission = null;
        this.stats = { cost: 0, messages: 0, startTime: Date.now() };
        this.lastResponse = '';
        this.lastAssistantDone = null; // Buffer for reconnecting clients
        // Optional priming: a system primer appended to
        // every turn, and a read-only tool allowlist. When both are null the
        // session behaves EXACTLY as before (--dangerously-skip-permissions).
        this.systemPrompt = opts.systemPrompt || null;
        this.allowedTools = opts.allowedTools || null; // e.g. "Read Grep Glob WebSearch WebFetch"
    }

    emitSSE(data) {
        const clients = hfSSEClients.get(this.id);
        const clientCount = clients?.size || 0;

        // Buffer assistant_done for reconnecting clients
        if (data.type === 'assistant_done') {
            this.lastAssistantDone = { data, timestamp: Date.now() };
        }

        // Clear buffer when new message is being processed
        if (data.type === 'state' && data.state === 'processing') {
            this.lastAssistantDone = null;
        }

        if (!clients || clientCount === 0) {
            return;
        }

        const message = `data: ${JSON.stringify(data)}\n\n`;
        let sentCount = 0;
        for (const client of clients) {
            try {
                client.write(message);
                sentCount++;
            } catch (e) {
                clients.delete(client);
            }
        }
    }

    setState(state, extra = {}) {
        this.state = state;
        this.emitSSE({ type: 'state', state, ...extra });
    }

    async send(message) {
        if (this.currentProcess && !this.currentProcess.killed) {
            // Kill any existing process
            this.currentProcess.kill('SIGTERM');
        }

        this.lastActivity = Date.now();
        this.setState('processing');
        this.messages.push({ role: 'user', content: message, timestamp: Date.now() });
        this.stats.messages++;
        this.emitSSE({ type: 'user_message', message });

        return new Promise((resolve, reject) => {
            // Build Claude command args
            // Note: -p with --output-format=stream-json requires --verbose
            const args = ['-p', message, '--output-format', 'stream-json', '--verbose'];
            // Permission model: a primed/read-only session restricts
            // tools to an allowlist; the default HF session keeps the original
            // execute-everything behavior via --dangerously-skip-permissions.
            if (this.allowedTools) {
                args.push('--allowedTools', this.allowedTools);
            } else {
                args.push('--dangerously-skip-permissions');
            }
            // A system primer teaches the session its role/context up front.
            if (this.systemPrompt) {
                args.push('--append-system-prompt', this.systemPrompt);
            }

            // Add --resume if we have a conversation
            if (this.conversationId) {
                args.push('--resume', this.conversationId);
            }

            const claudePath = findClaudeBinary();

            // Don't use shell: true - it breaks argument escaping for messages with spaces
            this.currentProcess = spawn(claudePath, args, {
                cwd: this.cwd,
                env: { ...process.env, FORCE_COLOR: '0', PATH: process.env.PATH },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Close stdin immediately - Claude -p doesn't need input
            this.currentProcess.stdin.end();

            let buffer = '';
            let fullResponse = '';
            let gotConversationId = false;
            let hasStreamedDeltas = false;  // Track if we received streaming deltas


            this.currentProcess.stdout.on('data', (data) => {
                const chunk = data.toString();
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);
                        this.handleJSON(json);

                        // Capture conversation ID from init or result message
                        if ((json.type === 'init' || json.type === 'result') && json.session_id && !gotConversationId) {
                            this.conversationId = json.session_id;
                            gotConversationId = true;
                        }

                        // Capture assistant text - handle both object and string formats
                        if (json.type === 'assistant') {
                            let text = '';
                            if (typeof json.message === 'string') {
                                text = json.message;
                            } else if (json.message?.content) {
                                // Extract text from content array
                                text = json.message.content
                                    .filter(c => c.type === 'text')
                                    .map(c => c.text)
                                    .join('');
                            }
                            if (text && !hasStreamedDeltas) {
                                fullResponse = text;
                            }
                        }

                        // Capture result text (final response)
                        if (json.type === 'result') {
                            if (json.is_error) {
                                // Claude returned an error
                                const errorMsg = json.error_message || json.subtype || 'Unknown error';
                                const errorStr = typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg);
                                console.error(`[HF:${this.id}] Claude error in result: ${errorStr}`);
                                this.emitSSE({ type: 'error', message: `Claude error: ${errorMsg}` });
                                // Still capture any result text for debugging
                                if (json.result) fullResponse = json.result;
                            } else if (json.result) {
                                fullResponse = json.result;
                            }
                        }

                        // Handle streaming deltas
                        if (json.type === 'content_block_delta' && json.delta?.text) {
                            hasStreamedDeltas = true;
                            fullResponse += json.delta.text;
                            this.emitSSE({ type: 'assistant_delta', text: json.delta.text, partial: true });
                        }

                        // Also handle text type messages (some Claude outputs use this)
                        if (json.type === 'text' && json.text) {
                            fullResponse += json.text;
                            this.emitSSE({ type: 'assistant_delta', text: json.text, partial: true });
                        }

                    } catch (e) {
                        // Raw output - might be useful info
                    }
                }
            });

            this.currentProcess.stderr.on('data', (data) => {
                const msg = data.toString();
                // Some stderr is just info (model selection, etc)
            });

            // Timeout after 2 minutes
            const timeout = setTimeout(() => {
                if (this.currentProcess && !this.currentProcess.killed) {
                    console.error(`[HF:${this.id}] Timeout - killing process`);
                    this.currentProcess.kill('SIGTERM');
                    this.emitSSE({ type: 'error', message: 'Timeout esperando respuesta de Claude' });
                }
            }, 120000);

            this.currentProcess.on('close', (code) => {
                clearTimeout(timeout);

                // Process any remaining buffer
                if (buffer.trim()) {
                    try {
                        const json = JSON.parse(buffer);
                        this.handleJSON(json);
                        if (json.type === 'assistant' && json.message) {
                            fullResponse = json.message;
                        }
                    } catch (e) {}
                }

                this.currentProcess = null;

                if (code === 0) {
                    this.lastResponse = fullResponse;
                    this.messages.push({ role: 'assistant', content: fullResponse, timestamp: Date.now() });
                    this.stats.messages++;

                    // Send final response
                    this.emitSSE({ type: 'assistant_done', message: fullResponse, stats: this.stats });
                    this.setState('idle');
                    resolve(fullResponse);
                } else {
                    this.setState('error', { message: `Process exited with code ${code}` });
                    reject(new Error(`Claude exited with code ${code}`));
                }
            });

            this.currentProcess.on('error', (err) => {
                console.error(`[HF:${this.id}] Process error: ${err.message || err}`);
                this.setState('error', { message: err.message });
                reject(err);
            });
        });
    }

    handleJSON(json) {
        // Handle different JSON message types from Claude
        switch (json.type) {
            case 'init':
                this.emitSSE({ type: 'system', data: json });
                break;

            case 'system':
                const sysMsg = json.message || json.subtype || JSON.stringify(json).substring(0, 100);
                this.emitSSE({ type: 'system', data: json });
                break;

            case 'assistant':
                this.emitSSE({ type: 'assistant', message: json.message });
                break;

            case 'result':
                if (json.cost_usd) this.stats.cost += parseFloat(json.cost_usd) || 0;
                if (json.session_id) this.conversationId = json.session_id;
                this.emitSSE({ type: 'result', data: json, stats: this.stats });
                break;

            case 'content_block_start':
            case 'content_block_stop':
            case 'message_start':
            case 'message_stop':
                // These are structural markers - minimal logging
//                // //console.log(`[HF:${this.id}] ${json.type}`);
                this.emitSSE({ type: 'system', data: json });
                break;

            case 'tool_use':
                // Claude is using a tool
                const toolInput = json.input ? JSON.stringify(json.input).substring(0, 150) : '';
                this.emitSSE({ type: 'tool_use', data: json });
                break;

            case 'tool_result':
                // Tool returned a result
                const resultPreview = typeof json.content === 'string'
                    ? json.content.substring(0, 100)
                    : JSON.stringify(json.content || json).substring(0, 100);
                this.emitSSE({ type: 'tool_result', data: json });
                break;

            case 'error':
                const errorDetail = typeof json.error === 'string' ? json.error : JSON.stringify(json.error || json);
                console.error(`[HF:${this.id}] Claude error: ${errorDetail}`);
                this.emitSSE({ type: 'error', message: json.error?.message || errorDetail });
                break;

            default:
                // Pass through unknown types with logging
                this.emitSSE({ type: 'raw', data: json });
        }
    }

    // Respond to a pending permission request
    respondPermission(decision) {
        if (!this.pendingPermission) {
            return false;
        }

        const permId = this.pendingPermission.id;

        // Update the permission in the global queue
        const perm = permissionQueue.get(permId);
        if (perm) {
            perm.decision = decision;
            perm.decidedAt = Date.now();
        }

        // Clear pending permission and update state
        this.pendingPermission = null;
        this.setState('idle');

        // Emit SSE to notify UI
        this.emitSSE({ type: 'permission_response', decision, permissionId: permId });

        return true;
    }

    stop() {
        if (this.currentProcess && !this.currentProcess.killed) {
            this.currentProcess.kill('SIGTERM');
            setTimeout(() => {
                if (this.currentProcess && !this.currentProcess.killed) {
                    this.currentProcess.kill('SIGKILL');
                }
            }, 2000);
        }
        this.state = 'stopped';

        // Close all SSE clients
        const clients = hfSSEClients.get(this.id);
        if (clients) {
            for (const client of clients) {
                try { client.end(); } catch (e) {}
            }
            hfSSEClients.delete(this.id);
        }

        hfSessions.delete(this.id);
    }

    getInfo() {
        return {
            id: this.id,
            cwd: this.cwd,
            state: this.state,
            conversationId: this.conversationId,
            messageCount: this.messages.length,
            lastActivity: this.lastActivity,
            stats: this.stats,
            lastResponse: this.lastResponse?.substring(0, 200),
            uptime: Date.now() - this.stats.startTime
        };
    }
}

// Generate unique session ID
function generateHFSessionId() {
    return 'hf-' + crypto.randomBytes(4).toString('hex');
}

// Cleanup idle sessions
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of hfSessions) {
        if (now - session.lastActivity > HF_IDLE_TIMEOUT) {
            session.stop();
        }
    }
}, 60000);

// Dispatcher route handler (Phase 1). Auth has already been enforced by handleAPI.
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => data += c);
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function jsonResp(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

// Returned by a route group that does not own the request (see handleAPI).
const NOT_MINE = Symbol('not this route group');

function handleAPI(req, res, pathname) {
    // Auth gate: EVERY API route requires authorization. Remote (tunnel) callers
    // must present a session token from a 2FA login; local callers (hooks) may use
    // the master BRIDGE_TOKEN. Runs first so nothing is reachable unauthenticated.
    // Exceptions:
    //   - /images/         : served to <img> tags, which cannot send headers
    //   - HF SSE           : EventSource can't send headers; validates ?token= in handler
    //   - /api/auth/login  : 2FA bootstrap (validates master token + TOTP itself)
    //   - /api/auth/refresh: trusted-device fast path (validates the device token itself)
    const auth = req.headers.authorization;
    // SSE endpoints self-validate ?token= (EventSource can't send headers):
    // HF output and the projector's frames.
    const isSSERequest = pathname.match(/^\/api\/hf\/output\//)
        || pathname === '/api/projector/stream';
    const isPublicImage = pathname.startsWith('/images/');
    // Logout is a bootstrap route on purpose: it is self-authorizing (it only
    // deletes the session/device token the caller already presents) and it must
    // work when the session has ALREADY expired -- otherwise the revoke 401s,
    // the client forgets its device token anyway, and the server keeps an
    // orphan row for 30 days. That is where the 58 stale devices came from.
    // The webauthn LOGIN pair is unauthenticated by necessity -- it is the login.
    // It is safe because it hands out nothing but a random challenge, and the
    // verify step only succeeds against a signature from an already-enrolled
    // key. Enrolment (/register/*) deliberately stays behind the auth gate: you
    // must already be logged in to add a face to the box.
    const isAuthBootstrap = pathname === '/api/auth/login' || pathname === '/api/auth/refresh' ||
                            pathname === '/api/auth/logout' ||
                            pathname === '/api/auth/webauthn/login/options' ||
                            pathname === '/api/auth/webauthn/login/verify';
    // "Is TSRCT up?" for boot-server.sh and scripts/tsrct-up.sh. No token, says
    // nothing but "up", and a 404 to anything remote. CLAUDE.md described this
    // route for weeks while it did not exist, so the second-server guard in
    // boot-server.sh always read "down" (found 2026-09-22).
    if (pathname === '/api/health' && req.method === 'GET') {
        if (isRemoteRequest(req)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"up":true}');
        return;
    }
    // The tmux hooks' ping (see ensureSessionHooks). No token, because the hook
    // has none; local only, takes no input and can only make the sidebar re-list.
    if (pathname === '/api/sessions/changed' && req.method === 'POST') {
        if (isRemoteRequest(req)) { res.writeHead(404); res.end(); return; }
        bumpSessionsVersion();
        res.writeHead(204);
        res.end();
        return;
    }
    // Ghost Runner passing Tesla along from his phone: the talk routes only,
    // and only from this machine (lib/appKey.js).
    const isAppCall = !!req.headers['x-tsrct-app'] && appKey.authorizes({
        method: req.method, pathname, key: req.headers['x-tsrct-app'], remote: isRemoteRequest(req),
    });
    if (!isSSERequest && !isPublicImage && !isAuthBootstrap && !isAppCall && !isAuthorized(auth, req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
    }
    // Tesla's eyes (lib/desk.js) stay shut for a while after ANY request that
    // names SecretCo - that is how the browser asks for the secretco pane, and the
    // pane's own text need not say the word. Broad on purpose: fail closed.
    try { if (restrictedGuard.mentionsRestricted(decodeURIComponent(req.url))) desk.sawRestrictedPane(); } catch { desk.sawRestrictedPane(); }

    // The routes, in the order they were always matched: each group answers
    // and returns anything but NOT_MINE, or passes the request on.
    if (apiAuth(req, res, pathname, auth) !== NOT_MINE) return;
    if (apiPermissions(req, res, pathname) !== NOT_MINE) return;
    if (apiDelegated(req, res, pathname) !== NOT_MINE) return;
    if (apiMedia(req, res, pathname) !== NOT_MINE) return;
    if (apiHandsFree(req, res, pathname, auth) !== NOT_MINE) return;
    if (apiServerAdmin(req, res, pathname) !== NOT_MINE) return;
    if (apiStatusFeeds(req, res, pathname) !== NOT_MINE) return;
    if (apiTerminalFiles(req, res, pathname) !== NOT_MINE) return;
    if (apiProjectsGit(req, res, pathname) !== NOT_MINE) return;
    if (apiSessionsJobs(req, res, pathname) !== NOT_MINE) return;
    if (apiTesla(req, res, pathname, isAppCall) !== NOT_MINE) return;
    if (apiSessionsProjector(req, res, pathname) !== NOT_MINE) return;
    if (apiRunners(req, res, pathname) !== NOT_MINE) return;
    if (apiRemoteDesktop(req, res, pathname) !== NOT_MINE) return;
    if (apiSalesforce(req, res, pathname) !== NOT_MINE) return;
    res.writeHead(404);
    res.end('Not found');
}

// The server's shared state for the route groups in lib/routes/. Getters, so a route
// always reads the CURRENT value of what the server changes over time; the one value a
// route writes (TMUX_SESSION) has a setter.
const S = {
    get AUTH_TOKEN() { return AUTH_TOKEN; },
    get FS_EXCLUDE_DIRS() { return FS_EXCLUDE_DIRS; },
    get HFSession() { return HFSession; },
    get LOGIN_LOCK_MS() { return LOGIN_LOCK_MS; },
    get MAX_HF_SESSIONS() { return MAX_HF_SESSIONS; },
    get NOT_MINE() { return NOT_MINE; },
    get PROJECTS_ROOT() { return PROJECTS_ROOT; },
    get REMOTE_URL() { return REMOTE_URL; },
    get SERVER_SESSION() { return SERVER_SESSION; },
    get SESSION_TTL_MS() { return SESSION_TTL_MS; },
    get TMUX_SESSION() { return TMUX_SESSION; },
    set TMUX_SESSION(v) { TMUX_SESSION = v; },
    get TMUX_TIMEOUT_MS() { return TMUX_TIMEOUT_MS; },
    get UPLOADS_FILES() { return UPLOADS_FILES; },
    get UPLOADS_IMAGES() { return UPLOADS_IMAGES; },
    get UPLOAD_IMAGE_EXT_RE() { return UPLOAD_IMAGE_EXT_RE; },
    get actions() { return actions; },
    get activeAudioProxy() { return activeAudioProxy; },
    get activeVNCProxy() { return activeVNCProxy; },
    get addEvent() { return addEvent; },
    get restrictedGuard() { return restrictedGuard; },
    get augmentPrompt() { return augmentPrompt; },
    get authState() { return authState; },
    get autoAccept() { return autoAccept; },
    get autoApprovedRecent() { return autoApprovedRecent; },
    get automations() { return automations; },
    get b64url() { return b64url; },
    get cborDecode() { return cborDecode; },
    get checkClientData() { return checkClientData; },
    get clearLoginFails() { return clearLoginFails; },
    get clientIp() { return clientIp; },
    get coseToJwk() { return coseToJwk; },
    get createDevice() { return createDevice; },
    get createSession() { return createSession; },
    get crypto() { return crypto; },
    get deleteUploadedImage() { return deleteUploadedImage; },
    get detectProject() { return detectProject; },
    get dispatcher() { return dispatcher; },
    get ensureSessionHooks() { return ensureSessionHooks; },
    get execFileSync() { return execFileSync; },
    get execSync() { return execSync; },
    get findPowershell() { return findPowershell; },
    get fs() { return fs; },
    get generateHFSessionId() { return generateHFSessionId; },
    get getEvents() { return getEvents; },
    get getLatestActivity() { return getLatestActivity; },
    get getRecentOutput() { return getRecentOutput; },
    get getSessionOutput() { return getSessionOutput; },
    get getSessionPwd() { return getSessionPwd; },
    get gitCwd() { return gitCwd; },
    get gitOut() { return gitOut; },
    get handleDispatcherRoute() { return handleDispatcherRoute; },
    get handson() { return handson; },
    get hfSSEClients() { return hfSSEClients; },
    get hfSessions() { return hfSessions; },
    get isAuthorized() { return isAuthorized; },
    get isHiddenSession() { return isHiddenSession; },
    get isRemoteRequest() { return isRemoteRequest; },
    get jsonResp() { return jsonResp; },
    get loginLocked() { return loginLocked; },
    get morningRoutine() { return morningRoutine; },
    get newChallenge() { return newChallenge; },
    get parseAuthData() { return parseAuthData; },
    get parseOrigin() { return parseOrigin; },
    get parseReqUrl() { return parseReqUrl; },
    get path() { return path; },
    get permissionQueue() { return permissionQueue; },
    get pickInitialSession() { return pickInitialSession; },
    get plainBrief() { return plainBrief; },
    get projectRegistry() { return projectRegistry; },
    get projector() { return projector; },
    get promptWriter() { return promptWriter; },
    get push() { return push; },
    get rdMeter() { return rdMeter; },
    get readBody() { return readBody; },
    get readVNCConfig() { return readVNCConfig; },
    get readVNCConfigRaw() { return readVNCConfigRaw; },
    get readWindowsScreens() { return readWindowsScreens; },
    get recordLoginFail() { return recordLoginFail; },
    get redactRemoteUrl() { return redactRemoteUrl; },
    get resolveWithinProjects() { return resolveWithinProjects; },
    get ring() { return ring; },
    get saveAuthState() { return saveAuthState; },
    get saveAutoAccept() { return saveAutoAccept; },
    get scheduler() { return scheduler; },
    get sendJson() { return sendJson; },
    get sendKeyToTmuxSession() { return sendKeyToTmuxSession; },
    get sendNtfy() { return sendNtfy; },
    get sendRawToTmuxSession() { return sendRawToTmuxSession; },
    get sendToTmuxSession() { return sendToTmuxSession; },
    get sessionEnvArgs() { return sessionEnvArgs; },
    get sessionExists() { return sessionExists; },
    get sessionWeight() { return sessionWeight; },
    get sessions() { return sessions; },
    get sessionsVersion() { return sessionsVersion; },
    get setDisplayTopology() { return setDisplayTopology; },
    get sfAlias() { return sfAlias; },
    get sfLoadWorkspaces() { return sfLoadWorkspaces; },
    get sfRun() { return sfRun; },
    get sfSaveWorkspaces() { return sfSaveWorkspaces; },
    get sha256() { return sha256; },
    get soloAmbiguous() { return soloAmbiguous; },
    get soloKept() { return soloKept; },
    get soloModeOrder() { return soloModeOrder; },
    get spawn() { return spawn; },
    get spawnSync() { return spawnSync; },
    get speech() { return speech; },
    get takeChallenge() { return takeChallenge; },
    get talk() { return talk; },
    get teslaLog() { return teslaLog; },
    get tmux() { return tmux; },
    get tmuxNextPane() { return tmuxNextPane; },
    get toWindowsPath() { return toWindowsPath; },
    get tokensMatch() { return tokensMatch; },
    get tts() { return tts; },
    get uiActions() { return uiActions; },
    get uiLayout() { return uiLayout; },
    get usage() { return usage; },
    get validDevice() { return validDevice; },
    get vaultHeaderSentTo() { return vaultHeaderSentTo; },
    get verifyTOTP() { return verifyTOTP; },
    get verifyWebauthnSig() { return verifyWebauthnSig; },
    get webauthnCreds() { return webauthnCreds; },
    get writeVNCConfig() { return writeVNCConfig; },
};
const apiAuth = require('./lib/routes/auth')(S);
const apiPermissions = require('./lib/routes/permissions')(S);
const apiDelegated = require('./lib/routes/delegated')(S);
const apiMedia = require('./lib/routes/media')(S);
const apiHandsFree = require('./lib/routes/hands-free')(S);
const apiServerAdmin = require('./lib/routes/server-admin')(S);
const apiStatusFeeds = require('./lib/routes/status-feeds')(S);
const apiTerminalFiles = require('./lib/routes/terminal-files')(S);
const apiProjectsGit = require('./lib/routes/projects-git')(S);
const apiSessionsJobs = require('./lib/routes/sessions-jobs')(S);
const apiTesla = require('./lib/routes/tesla')(S);
const apiSessionsProjector = require('./lib/routes/sessions-projector')(S);
const apiRunners = require('./lib/routes/runners')(S);
const apiRemoteDesktop = require('./lib/routes/remote-desktop')(S);
const apiSalesforce = require('./lib/routes/salesforce')(S);
// The dispatcher's own routes; reached through the delegated group after the gate.
const handleDispatcherRoute = require('./lib/routes/dispatcher')(S);


const server = http.createServer((req, res) => {
    const pathname = parseReqUrl(req.url).pathname;
    stallWatch.noteRequest(req.method, pathname);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Orchestrator self-refresh (local-only, no auth by contract). Matched before
    // the /api/ gate since the skill calls the bare /session/{id}/refresh path.
    const refreshMatch = pathname.match(/^\/session\/([^/]+)\/refresh$/);
    if (refreshMatch && req.method === 'POST') {
        handleSessionRefresh(req, res, decodeURIComponent(refreshMatch[1]));
        return;
    }

    // HANDS ON, Claude's side. Local-only, no auth, matched before the /api/
    // gate for the same reason as the route above: the caller is a curl from
    // inside a pane. See handleHandsOn().
    const hoMatch = pathname.match(/^\/handson\/(plan|events|clear)$/);
    if (hoMatch && (req.method === 'POST' || req.method === 'GET')) {
        handleHandsOn(req, res, hoMatch[1]);
        return;
    }

    if (pathname.startsWith('/api/') || pathname.startsWith('/images/')) {
        handleAPI(req, res, pathname);
    } else if (pathname === '/manifest.json') {
        // Serve PWA manifest
        const fs = require('fs');
        const path = require('path');
        const manifestPath = path.join(__dirname, 'manifest.json');
        try {
            const manifest = fs.readFileSync(manifestPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
            res.end(manifest);
        } catch (e) {
            res.writeHead(404);
            res.end('Manifest not found');
        }
    } else if (pathname === '/sw.js') {
        // Serve Service Worker
        const swPath = path.join(__dirname, 'sw.js');
        try {
            const sw = fs.readFileSync(swPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
            res.end(sw);
        } catch (e) {
            res.writeHead(404);
            res.end('Service worker not found');
        }
    } else if (pathname.startsWith('/src/css/')) {
        // Serve CSS files from src/css/ (guarded against ../ path traversal)
        const cssBase = path.join(__dirname, 'src', 'css');
        const cssPath = path.resolve(__dirname, '.' + pathname);
        if (cssPath !== cssBase && !cssPath.startsWith(cssBase + path.sep)) {
            res.writeHead(403); res.end('Forbidden');
        } else {
            try {
                const css = fs.readFileSync(cssPath, 'utf8');
                // no-cache = the browser MUST revalidate before reusing, so edited
                // CSS lands on a normal reload (no hard-refresh dance during dev).
                res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
                res.end(css);
            } catch (e) {
                res.writeHead(404);
                res.end('CSS file not found');
            }
        }
    } else if (pathname.startsWith('/src/js/')) {
        // Serve JS files from src/js/ (guarded against ../ path traversal)
        const jsBase = path.join(__dirname, 'src', 'js');
        const jsPath = path.resolve(__dirname, '.' + pathname);
        if (jsPath !== jsBase && !jsPath.startsWith(jsBase + path.sep)) {
            res.writeHead(403); res.end('Forbidden');
        } else {
            try {
                const js = fs.readFileSync(jsPath, 'utf8');
                // no-cache = revalidate every load, so edited JS (e.g. desktop.js) lands
                // on a normal reload instead of being served stale from the HTTP cache.
                res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
                res.end(js);
            } catch (e) {
                res.writeHead(404);
                res.end('JS file not found');
            }
        }
    } else if (pathname === '/logo.png' || pathname === '/icon-192.png' || pathname === '/icon-512.png') {
        // Serve PNG assets
        const imgPath = path.join(__dirname, pathname.substring(1));
        try {
            const img = fs.readFileSync(imgPath);
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(img);
        } catch (e) {
            res.writeHead(404);
            res.end('Image not found');
        }
    } else if (pathname === '/favicon.ico' || pathname === '/logo.ico') {
        // Serve the .ico favicon (browsers auto-request /favicon.ico for the
        // tab/window/taskbar icon; without this it fell through to the SPA HTML).
        try {
            const ico = fs.readFileSync(path.join(__dirname, 'logo.ico'));
            res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
            res.end(ico);
        } catch (e) {
            res.writeHead(404);
            res.end('Icon not found');
        }
    } else {
        // Content-Security-Policy + hardening headers on the HTML document.
        // NOTE: script-src needs 'unsafe-inline' because the UI uses inline onclick=
        // handlers (the addEventListener migration is deferred). CSP still blocks the
        // dangerous parts: connect-src locks where data can be sent (kills XSS->token
        // exfiltration to attacker domains), object-src/base-uri/frame-ancestors close
        // other vectors. External allows: cdn.jsdelivr.net (tesseract OCR), Google Fonts.
        const csp = [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: blob:",
            "connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com",
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
            "frame-ancestors 'none'",
            "form-action 'self'",
        ].join('; ');
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': csp,
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
        });
        res.end(getMobileHTML());
    }
});

// Session memory (2026-10-14): name -> folder -> conversation for every live
// session, plus an audit line per change, so a crash or a reboot can be undone.
function startSessionLog(loops) {
    try {
        const sessionFolders = require('./lib/sessionFolders');
        let sfTimer = null;
        loops['session-log'] = {
            start: () => { sessionFolders.snapshot({ force: true }); sfTimer = setInterval(() => { try { sessionFolders.snapshot(); } catch (e) { console.warn('[session-log]', e.message); } }, 60 * 1000); },
            stop: () => { clearInterval(sfTimer); sfTimer = null; },
            runNow: () => sessionFolders.snapshot({ force: true }),
            status: () => ({ running: !!sfTimer }),
        };
        if (automations.bootLoop('session-log', loops['session-log'].start)) console.log('[session-log] remembering session folders and conversations');
    } catch (e) {
        console.log('[session-log] failed to start: ' + e.message);
    }
}


// ── The clock: named jobs that fire at a time of day ────────────────────
// Registration is here, in the listen callback, so a job can never fire
// before the server is actually serving. The scheduler itself only decides
// WHEN; what a job does lives in its own module.
function startScheduler(loops) {
    try {
        scheduler.register({
            name: 'morning-routine',
            at: process.env.MORNING_AT || '06:00',
            window: 5,          // owed until 11:00; past that it waits for tomorrow
            description: 'Ask headless Claude what is pending across your connected tools, '
                + 'the vault and past sessions, then open the sessions it names.',
            enabled: process.env.MORNING_ENABLED !== '0',
            run: (ctx) => morningRoutine.run({ manual: ctx.manual }),
        });
        // The four jobs that were WSL cron lines until 2026-09-24, and the tab's
        // alerts (second failure in a row, or a missed run -> Notifs + phone).
        automations.registerJobs(scheduler);
        automations.configure({
            scheduler,
            notify: ({ title, body }) => {
                addEvent({ type: 'automation_alert', title: `[automations] ${title}`, body });
                try {
                    require('./lib/dispatcher/ntfyPush').send({ title: `TSRCT: ${title}`, body, priority: 'high', tags: ['warning'] })
                        .catch(e => console.warn('[automations] phone alert failed:', e.message));
                } catch (e) { console.warn('[automations] phone alert failed:', e.message); }
            },
        });
        const s = scheduler.start();
        const m = scheduler.view('morning-routine');
        console.log(`[scheduler] ${s.jobs} job(s); morning-routine ${m.enabled ? 'ON' : 'OFF'} at ${m.at}`
            + ` (next ${m.nextDue ? new Date(m.nextDue).toLocaleString() : 'never'})`);
    } catch (e) {
        console.error('[scheduler] start failed:', e.message);
    }
}


// Dispatcher startup.
function startDispatcher(loops) {
    if (dispatcher) {
        try {
            dispatcher.db.init();
            const projs = dispatcher.projects.refresh();
            console.log(`[dispatcher] db + project context ready (${projs.length} projects)`);
        } catch (e) {
            console.error('[dispatcher] db/projects init failed:', e.message);
        }
        // The local model is NOT started with TSRCT (2026-09-18, Leon's call: he
        // turns Ollama on separately). Booting the server used to fire a warmup
        // chat here, which makes Ollama pull hermes3:8b into the 8 GB card and
        // hold it there — on a machine where the GPU is also ComfyUI's. Nothing
        // else in TSRCT needs the model until something asks for it: the
        // dispatcher, TOWER and the polisher all call it on demand and already
        // degrade when it is unreachable (circuit breaker in lib/dispatcher/hermes.js).
        // HERMES_AUTOSTART=1 brings the old warmup back for a boot.
        if (process.env.HERMES_AUTOSTART === '1') {
            dispatcher.hermes.warmup().then(ok => {
                console.log(`[dispatcher] hermes warmup: ${ok ? 'ok' : 'failed'}`);
            });
        } else {
            console.log('[dispatcher] local model left alone at boot (HERMES_AUTOSTART=1 to warm it)');
        }
        // Phase 4: sessionMonitor replaces the simple poll — it both refreshes states AND triggers reconciliation.
        loops['session-monitor'] = {
            start: () => dispatcher.sessionMonitor.start(),
            stop: () => dispatcher.sessionMonitor.stop(),
            runNow: () => dispatcher.sessionMonitor.tick(),
            status: () => {
                const hb = dispatcher.sessionMonitor.getHeartbeat();
                const late = hb.running && hb.last_tick_at && Date.now() - hb.last_tick_at > 6 * hb.poll_ms;
                return { lastRun: hb.last_tick_at || 0, error: late ? 'Stopped checking (no tick for a minute)' : '' };
            },
        };
        try {
            automations.bootLoop('session-monitor', loops['session-monitor'].start);
        } catch (e) {
            console.error('[dispatcher] sessionMonitor start failed:', e.message);
        }
        // Phase 5 (voice corpus / voice embeddings / draft engine / live DM poller
        // / relationships): DELETED 2026-09-19. Five modules, eight routes, two
        // tables and eleven db helpers that drafted Slack replies in Leon's
        // writing style. NOTHING IN THE FRONTEND EVER CALLED THEM — the drafts
        // were written by the local model, stored, and read by nobody. What made
        // it visible was the fans: the DM poller back-fills everything that
        // arrived while the server was down, so every restart paid a 4.7GB model
        // load to produce drafts no one would see. Same shape as TOWER, through a
        // different door. History is in git.
        // Phase 6 (decomposer / swarmCoordinator / patternDetector / anticipator):
        // DELETED 2026-08-15. Four abandoned experiment modules, their four routes,
        // their five db helpers, their two tables and the two hermes prompts that
        // only they used. Two of them ran on every boot and would have pasted a
        // multi-line markdown prompt into a bare bash shell had their preconditions
        // ever held. Nothing referenced them from the frontend. History is in git;
        // see vault wiki/TSRCT Invariants.md.
        // The background job runner's poll loop.
        loops.analyst = {
            start: () => dispatcher.clickupAnalyst.start(),
            stop: () => dispatcher.clickupAnalyst.stop(),
            status: () => ({ summary: 'Waits for jobs' }),
        };
        try {
            automations.bootLoop('analyst', loops.analyst.start);
        } catch (e) {
            console.error('[dispatcher] job runner start failed:', e.message);
        }
        // TOWER: RETIRED 2026-09-19 (Leon: "kill the tower completely"), and
        // DELETED with the Slack pipeline the same day. It was the first of three
        // background loops that woke the local model on their own: a 25-second
        // pane-summary cycle for a panel nobody read, which with the card busy
        // pulled 4.7GB in, was killed before it finished, and started again --
        // one core at 100% for a view nobody was looking at. /api/tower/state is
        // deliberately left so a stale cached PWA gets an empty answer, not 404 spam.

        // Codemap: keep each session's MAP.md fresh; arm sessions to read it.
        // init() is what gives it tmux and the config table. The Slack-pipeline
        // deletion (8412ad9, 2026-09-19) removed it with the code around it, and
        // the Codemap tab listed zero sessions from then on (found 2026-09-22).
        try {
            dispatcher.codemapEngine.init({
                db: dispatcher.db,
                tmux: dispatcher.tmux,
                send: sendToTmuxSession,
                serverSession: SERVER_SESSION,
            });
            dispatcher.codemapEngine.start();
        } catch (e) {
            console.error('[dispatcher] codemap start failed:', e.message);
        }
        // Its switch is the autopilot flag the Codemap tab already had (kept in
        // the config table); the 5-minute loop itself is free when it is off.
        loops.codemap = {
            isOn: () => dispatcher.codemapEngine.getAutopilot(),
            setOn: (on) => { dispatcher.codemapEngine.setAutopilot(!!on); return { ok: true }; },
            runNow: () => dispatcher.codemapEngine.tick(),
            status: () => ({ summary: dispatcher.codemapEngine.getAutopilot() ? 'Keeping maps fresh' : 'Autopilot off' }),
        };
    }
}

server.listen(PORT, BIND_HOST, () => {
    // Load/generate 2FA state (TOTP secret + trusted devices)
    loadAuthState();

    // Adopt the first existing real session as the target (if any). Never forces a
    // 'claude' session — if none exist, TSRCT runs session-less until you create one.
    if (!TMUX_SESSION) {
        TMUX_SESSION = pickInitialSession();
        console.log(`[session] initial target: ${TMUX_SESSION || '(none — create one in the UI)'}`);
    }
    ensureSessionHooks();

    // Find claude binary at startup
    findClaudeBinary();

    // Each loop below starts through automations.bootLoop(), so one paused from
    // the Automations tab stays paused across restarts; `loops` is how the tab
    // switches and reads them.
    const loops = {};
    startSessionLog(loops);
    startScheduler(loops);
    startDispatcher(loops);
    automations.configure({ loops });

    // Readiness marker. launch-tsrct.ps1 watches the boot log for this to finish the
    // splash. It USED to watch for the cloudflared URL, which meant retiring the tunnel
    // would have left the splash creeping for its full 45s fallback on every launch.
    // Print it LAST, but note the dispatcher warmups above are async and may still be
    // running -- the port is open and the app is usable, which is what the splash means.
    console.log(`[READY] TSRCT listening on http://${BIND_HOST}:${PORT}`
        + (REMOTE_URL ? ` | remote: ${REMOTE_URL}` : ' | remote: (none)'));
});

// ═══════════════════════════════════════════════════════════════════
// VNC REMOTE DESKTOP - WebSocket Upgrade Handler
// Proxies WebSocket binary frames to/from VNC server via TCP
// ═══════════════════════════════════════════════════════════════════

server.on('upgrade', (req, socket, head) => {
    const parsedUrl = parseReqUrl(req.url);
    const pathname = parsedUrl.pathname;

    console.log('[VNC] Upgrade request:', pathname);

    // Handle VNC and Audio WebSocket paths
    if (pathname !== '/api/vnc/ws' && pathname !== '/api/vnc/audio') {
        console.log('[VNC] Wrong path, destroying');
        socket.destroy();
        return;
    }

    const isAudio = pathname === '/api/vnc/audio';

    // Auth check via query param (WebSocket API can't set custom headers)
    const queryToken = parsedUrl.query.token;
    if (!isAuthorized(queryToken, req)) {
        console.log('[VNC] Auth failed (bad or missing token)');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    console.log('[VNC] Auth OK, performing handshake');

    // WebSocket handshake (RFC 6455)
    const clientKey = req.headers['sec-websocket-key'];
    if (!clientKey) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    const acceptKey = wsAcceptKey(clientKey);
    const requestedProtocol = req.headers['sec-websocket-protocol'] || '';
    console.log('[VNC] Requested subprotocol:', requestedProtocol);

    let handshakeResponse =
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + acceptKey + '\r\n';

    // noVNC requests 'binary' subprotocol - must echo it back or browser rejects
    if (requestedProtocol) {
        // Pick the first protocol noVNC requests (typically 'binary')
        const proto = requestedProtocol.split(',')[0].trim();
        handshakeResponse += 'Sec-WebSocket-Protocol: ' + proto + '\r\n';
    }

    handshakeResponse += '\r\n';
    socket.write(handshakeResponse);

    console.log('[VNC] Handshake complete');

    // ── AUDIO STREAM PATH ──────────────────────────────────────────
    if (isAudio) {
        console.log('[AUDIO] Starting audio stream');

        // Close any existing audio proxy
        if (activeAudioProxy) {
            try { activeAudioProxy.process.kill(); } catch (e) {}
            try { activeAudioProxy.ws.destroy(); } catch (e) {}
            activeAudioProxy = null;
        }

        let audioCleaned = false;

        // Read configured audio device from VNC config
        const audioConfig = readVNCConfig();
        const audioDevice = audioConfig.audioDevice || 'Stereo Mix';

        // ── Stream shape is now the CLIENT's choice ────────────────────
        // This is raw uncompressed PCM, so the cost is pure arithmetic:
        // rate * 2 bytes * channels, every second, forever. The old
        // hardcoded 48 kHz stereo is 192 KB/s = 691 MB/HOUR of mobile
        // data, and it costs exactly that whether music is playing or the
        // machine is silent. Rate and channels are whitelisted (never
        // interpolated raw into an ffmpeg arg).
        const AUDIO_RATES = [48000, 24000, 16000, 8000];
        const reqRate = parseInt(parsedUrl.query.rate, 10);
        const reqCh = parseInt(parsedUrl.query.ch, 10);
        const audioRate = AUDIO_RATES.includes(reqRate) ? reqRate : 24000;
        const audioCh = (reqCh === 1 || reqCh === 2) ? reqCh : 1;
        console.log(`[AUDIO] shape: ${audioRate} Hz, ${audioCh}ch =`,
                    ((audioRate * 2 * audioCh * 3600) / 1e6).toFixed(0) + ' MB/hour');

        // Spawn ffmpeg.exe to capture Windows audio via DirectShow
        // Output: raw PCM s16le via stdout, at the shape the client asked for
        const ffArgs = [
            '-f', 'dshow',
            '-audio_buffer_size', '50',
            '-i', `audio=${audioDevice}`,
            '-f', 's16le',
            '-acodec', 'pcm_s16le',
            '-ar', String(audioRate),
            '-ac', String(audioCh),
            '-'
        ];

        console.log('[AUDIO] ffmpeg args:', ffArgs.join(' '));

        // Use ffmpeg.exe (Windows binary accessible from WSL2)
        let ffmpeg;
        try {
            ffmpeg = spawn('ffmpeg.exe', ffArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: process.env.HOME || '/tmp'
            });
        } catch (e) {
            console.log('[AUDIO] ffmpeg.exe spawn failed:', e.message);
            try {
                socket.write(buildWSFrame(WS_OP_CLOSE, Buffer.alloc(0)));
                socket.destroy();
            } catch (_) {}
            return;
        }

        activeAudioProxy = { ws: socket, process: ffmpeg };

        // Declared here, assigned below once the gate exists: audioCleanup can
        // fire from an ffmpeg 'error' before that, and a `const` in the dead
        // zone would throw out of the cleanup path instead of cleaning up.
        let audioKeepalive = null;

        function audioCleanup(reason) {
            if (audioCleaned) return;
            audioCleaned = true;
            if (audioKeepalive) { clearInterval(audioKeepalive); audioKeepalive = null; }
            console.log('[AUDIO] Cleanup:', reason || 'unknown');
            activeAudioProxy = null;
            try { ffmpeg.kill('SIGTERM'); } catch (e) {}
            try {
                socket.write(buildWSFrame(WS_OP_CLOSE, Buffer.alloc(0)));
                socket.destroy();
            } catch (e) {}
        }

        // ffmpeg stderr (logs/errors)
        let ffStderr = '';
        ffmpeg.stderr.on('data', (data) => {
            ffStderr += data.toString();
            // Log only the first few lines of ffmpeg output
            if (ffStderr.split('\n').length <= 5) {
                console.log('[AUDIO] ffmpeg:', data.toString().trim());
            }
        });

        // ── Silence gate ───────────────────────────────────────────────
        // Raw PCM spends the same bytes on silence as on music, so leaving
        // audio ON with nothing playing cost exactly as much as streaming a
        // film. A chunk whose every sample sits under the noise floor is
        // simply not sent.
        //
        // No client change is needed: rdAudioScheduleBuffer already resets
        // its play head whenever it has fallen behind wall-clock, so a gap
        // resumes cleanly and cannot accumulate drift.
        //
        // HANGOVER keeps the gate open briefly after the last sound, so the
        // rests between words or notes are not clipped and it cannot flap.
        const SILENCE_FLOOR = 8;      // |s16| <= 8 is about -72 dBFS -- inaudible
        const HANGOVER_MS = 400;
        let lastSoundAt = 0;
        let gateOpen = false;

        function hasSound(buf) {
            // Every other sample is enough: a real transient never lives in a
            // single sample, and this halves the scan on Leon's CPU.
            for (let i = 0; i + 1 < buf.length; i += 4) {
                const v = buf.readInt16LE(i);
                if (v > SILENCE_FLOOR || v < -SILENCE_FLOOR) return true;
            }
            return false;
        }

        // A gate that stays shut for minutes leaves the socket idle, and an
        // idle socket is what proxies reap. A zero-length ping costs ~6 bytes.
        audioKeepalive = setInterval(() => {
            if (audioCleaned || Date.now() - lastSoundAt < 5000) return;
            try { socket.write(buildWSFrame(WS_OP_PING, Buffer.alloc(0))); } catch (e) {}
        }, 15000);

        // ffmpeg stdout (raw PCM) -> WebSocket binary frames
        ffmpeg.stdout.on('data', (data) => {
            const now = Date.now();
            if (hasSound(data)) { lastSoundAt = now; gateOpen = true; }
            else if (gateOpen && now - lastSoundAt > HANGOVER_MS) { gateOpen = false; }

            if (!gateOpen) { rdMeter.audioSilent += data.length; return; }

            try {
                rdMeter.audio += data.length;
                socket.write(buildWSFrame(WS_OP_BINARY, data));
            } catch (e) {
                audioCleanup('ws write error');
            }
        });

        ffmpeg.on('error', (e) => {
            console.log('[AUDIO] ffmpeg error:', e.message);
            // Send error info to client before closing
            const errMsg = JSON.stringify({ error: 'ffmpeg_error', message: e.message, stderr: ffStderr.slice(-500) });
            try { socket.write(buildWSFrame(WS_OP_TEXT, Buffer.from(errMsg))); } catch (_) {}
            audioCleanup('ffmpeg error');
        });

        ffmpeg.on('close', (code) => {
            console.log('[AUDIO] ffmpeg exited with code', code);
            if (!audioCleaned) {
                const errMsg = JSON.stringify({ error: 'ffmpeg_exit', code, stderr: ffStderr.slice(-500) });
                try { socket.write(buildWSFrame(WS_OP_TEXT, Buffer.from(errMsg))); } catch (_) {}
            }
            audioCleanup('ffmpeg exit: ' + code);
        });

        // Handle WebSocket frames from client (control messages)
        let audioWsBuffer = Buffer.alloc(0);
        socket.on('data', (data) => {
            audioWsBuffer = Buffer.concat([audioWsBuffer, data]);
            while (audioWsBuffer.length > 0) {
                const frame = parseWSFrame(audioWsBuffer);
                if (!frame) break;
                audioWsBuffer = audioWsBuffer.slice(frame.bytesConsumed);
                if (frame.opcode === WS_OP_CLOSE) { audioCleanup('client close'); return; }
                if (frame.opcode === WS_OP_PING) { try { socket.write(buildWSFrame(WS_OP_PONG, frame.payload)); } catch (e) {} }
            }
        });

        socket.on('end', () => audioCleanup('ws end'));
        socket.on('error', (e) => audioCleanup('ws error: ' + e.message));
        socket.on('close', () => audioCleanup('ws close'));

        if (head && head.length > 0) socket.emit('data', head);
        return;
    }

    // ── VNC PROXY PATH ─────────────────────────────────────────────

    // Close any existing VNC proxy
    if (activeVNCProxy) {
        try { activeVNCProxy.vnc.destroy(); } catch (e) {}
        try { activeVNCProxy.ws.destroy(); } catch (e) {}
        activeVNCProxy = null;
    }

    // Connect to VNC server
    const config = readVNCConfig();
    console.log('[VNC] Connecting to', config.host + ':' + config.port);
    const vnc = net.createConnection({ host: config.host, port: config.port });
    let cleaned = false;
    let wsBuffer = Buffer.alloc(0);
    rdMeterReset();   // a fresh session starts a fresh bill

    activeVNCProxy = { ws: socket, vnc: vnc };

    vnc.on('connect', () => {
        console.log('[VNC] TCP connection to VNC server established');
    });

    function cleanup(reason) {
        if (cleaned) return;
        cleaned = true;
        console.log('[VNC] Cleanup:', reason || 'unknown');
        activeVNCProxy = null;
        try { vnc.destroy(); } catch (e) {}
        try {
            socket.write(buildWSFrame(WS_OP_CLOSE, Buffer.alloc(0)));
            socket.destroy();
        } catch (e) {}
    }

    // VNC server -> WebSocket client
    vnc.on('data', (data) => {
        try {
            rdMeter.vncDown += data.length;
            socket.write(buildWSFrame(WS_OP_BINARY, data));
        } catch (e) {
            cleanup('ws write error');
        }
    });

    vnc.on('end', () => cleanup('vnc end'));
    vnc.on('error', (e) => { console.log('[VNC] TCP error:', e.message); cleanup('vnc error: ' + e.message); });
    vnc.on('close', () => cleanup('vnc close'));

    // WebSocket client -> VNC server
    socket.on('data', (data) => {
        rdMeter.vncUp += data.length;
        wsBuffer = Buffer.concat([wsBuffer, data]);

        while (wsBuffer.length > 0) {
            const frame = parseWSFrame(wsBuffer);
            if (!frame) break;

            wsBuffer = wsBuffer.slice(frame.bytesConsumed);

            switch (frame.opcode) {
                case WS_OP_BINARY:
                case WS_OP_TEXT:
                    try { vnc.write(frame.payload); } catch (e) { cleanup('vnc write error'); }
                    break;
                case WS_OP_PING:
                    try { socket.write(buildWSFrame(WS_OP_PONG, frame.payload)); } catch (e) {}
                    break;
                case WS_OP_CLOSE:
                    console.log('[VNC] Client sent close frame');
                    cleanup('client close frame');
                    return;
            }
        }
    });

    socket.on('end', () => cleanup('ws end'));
    socket.on('error', (e) => { console.log('[VNC] WS error:', e.message); cleanup('ws error: ' + e.message); });
    socket.on('close', () => cleanup('ws close'));

    // Process any data that arrived with the upgrade request
    if (head && head.length > 0) {
        socket.emit('data', head);
    }
});
