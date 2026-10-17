'use strict';
// lib/appKey.js — the key another of Leon's apps uses to talk to Tesla.
//
// WHY (2026-10-09). Leon: "tesla needs to live in runner app as well so i don't
// have to open tsrct". Ghost Runner (personal/runner-app) runs on this same
// laptop and passes his phone's requests on to this server over 127.0.0.1. It
// needs Tesla and NOTHING else: not git, not files, not the terminal stream,
// not the permission queue's HTTP side. The master token would have given it
// all of those, so it gets this instead.
//
// Three conditions, all required (server.js handleAPI):
//   1. the request is LOCAL (isRemoteRequest false) - a key that leaked to the
//      phone would still be useless from the tailnet;
//   2. the route is on the list below, method included;
//   3. the key matches, compared in constant time.
//
// The key lives in a file only this user can read, created on first use, so
// the other app can read the same file instead of carrying a copy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = process.env.TSRCT_APP_KEY_FILE
    || path.join(os.homedir(), '.config', 'tsrct', 'tesla-app.key');

// What Tesla's orb uses, and nothing more. /api/talk/did is left out on
// purpose: the other app has no TSRCT screen, so it never presses a button.
const ROUTES = {
    GET: new Set(['/api/talk/status', '/api/talk/jobs', '/api/tts/status', '/api/sessions']),
    POST: new Set([
        '/api/talk/open', '/api/talk/ask', '/api/talk/attach', '/api/talk/close',
        '/api/talk/event', '/api/talk/job', '/api/tts/say',
        '/api/upload-image', '/api/upload-file',
    ]),
};

let cached = null;

function ensure() {
    if (cached) return cached;
    try {
        const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
        if (k.length >= 32) { cached = k; return cached; }
    } catch { /* first run: created below */ }
    const k = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, k + '\n', { mode: 0o600 });
    cached = k;
    return cached;
}

function allows(method, pathname) {
    const set = ROUTES[String(method || '').toUpperCase()];
    return !!set && set.has(pathname);
}

function matches(provided) {
    if (typeof provided !== 'string' || !provided) return false;
    let key;
    try { key = ensure(); } catch { return false; }
    const a = Buffer.from(provided);
    const b = Buffer.from(key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The whole decision, so it can be tested without starting the server.
function authorizes({ method, pathname, key, remote }) {
    return !remote && allows(method, pathname) && matches(key);
}

module.exports = { KEY_FILE, ROUTES, ensure, allows, matches, authorizes };
