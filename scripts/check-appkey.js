#!/usr/bin/env node
// scripts/check-appkey.js — the key Ghost Runner uses to talk to Tesla
// (lib/appKey.js, 2026-10-09).
//
// What it must never become: a second master token. It opens the talk routes
// and nothing else, only for a request that did not come through a proxy, and
// only with the exact key. And a press of a TSRCT button must never be queued
// because the runner app is polling: it has no buttons, so that "listo" would be
// a lie.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const keyFile = path.join(os.tmpdir(), `check-appkey-${process.pid}`, 'k');
process.env.TSRCT_APP_KEY_FILE = keyFile;
const appKey = require(path.join(ROOT, 'lib/appKey.js'));

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log('  [x] ' + label); } };

const key = appKey.ensure();
ok(key.length === 64 && fs.existsSync(keyFile), 'the key is created on first use');
ok((fs.statSync(keyFile).mode & 0o077) === 0, 'and only this user can read it');
ok(appKey.ensure() === key, 'and it is the same key the next time');

const call = (method, pathname, k, remote) => appKey.authorizes({ method, pathname, key: k, remote: !!remote });
ok(call('POST', '/api/talk/ask', key), 'a local talk question with the key is let in');
ok(call('GET', '/api/talk/status', key), 'and the status poll');
ok(call('POST', '/api/tts/say', key), 'and the voice');
ok(!call('POST', '/api/talk/ask', key, true), 'the same request through a proxy (the tailnet) is refused');
ok(!call('POST', '/api/talk/ask', key.slice(0, -1) + (key.endsWith('a') ? 'b' : 'a')), 'a wrong key is refused');
ok(!call('POST', '/api/talk/ask', ''), 'no key is refused');
for (const [m, p] of [['GET', '/api/git/status'], ['POST', '/api/send'], ['GET', '/api/output'], ['GET', '/api/fs/list'],
    ['POST', '/api/permission/respond'], ['POST', '/api/talk/did'], ['GET', '/api/talk/ask'], ['POST', '/api/sessions'], ['POST', '/api/runner/start']]) {
    ok(!call(m, p, key), `${m} ${p} stays closed to the app key`);
}

// The gate in server.js uses it, with the real remote check, before the master token.
const server = require('./serverSource')();
ok(/appKey\.authorizes\(\{[^}]*remote: isRemoteRequest\(req\)/.test(server), 'server.js asks appKey with the real isRemoteRequest()');
ok(/!isAppCall && !isAuthorized\(auth, req\)/.test(server), 'and the app key is checked in the main auth gate');
ok(/talk\.status\(\{ since: [^\n]*client: isAppCall \? 'runner'/.test(server), 'the status poll says who is polling, decided by the server, not by the caller');
ok(/talk\.ask\(\{[^)]*from: isAppCall \? 'runner'/.test(server), 'and so does a question');

// A TSRCT button is only pressed while a TSRCT page polls.
const talkSrc = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
ok(/uiActions\.configure\(\{ alive: \(\) => state\.open && Date\.now\(\) - state\.screenPollAt/.test(talkSrc), 'button presses wait for a TSRCT page, not for any poller');
ok(/if \(client !== 'runner'\) state\.screenPollAt/.test(talkSrc), 'and the runner app polling does not count as one');

fs.rmSync(path.dirname(keyFile), { recursive: true, force: true });
if (fail) { console.error(`[check-appkey] ${fail} failure(s) of ${pass + fail}`); process.exit(1); }
console.log(`[check-appkey] ${pass}/${pass}`);
