#!/usr/bin/env node
// The safety net for splitting handleAPI (docs/CLEANUP-PLAN.md, P0 #3 and #4).
//
// 1. INVENTORY - every /api/... route named in the server's code is listed in
//    scripts/routes-baseline.json. A route that disappears is red: moving ~230
//    routes out of one 4,800-line function is exactly how one gets dropped, and
//    only a user would notice. New routes are fine; `--update` records them.
// 2. GATE - inside handleAPI nothing may answer before the auth check except the
//    two documented local-only routes, and the exemption lists (SSE streams,
//    login bootstrap) are pinned, so widening them is a visible edit here.
//
// Static on purpose: it reads the files, it never starts the server.
'use strict';

const fs = require('fs');
const path = require('path');

// CHECK_ROUTES_ROOT points it at a copy, which is how its own red cases are proven.
const ROOT = process.env.CHECK_ROUTES_ROOT || path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'routes-baseline.json');

// Where routes live: server.js today, plus any route module the split creates.
function sourceFiles() {
    const files = [path.join(ROOT, 'server.js')];
    const dir = path.join(ROOT, 'lib', 'routes');
    if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
    return files;
}

// Comment lines are dropped: a route that only survives in a comment is gone.
function codeOf(text) {
    return text.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

function routesIn(code) {
    const found = new Set();
    // string and template literals: '/api/x', "/api/x", `/api/x/${id}`
    for (const m of code.matchAll(/['"`](\/api\/[A-Za-z0-9_\-./:{}$]*)['"`]/g)) found.add(m[1]);
    // regex literals: /^\/api\/hf\/output\//
    for (const m of code.matchAll(/\/\^((?:\\\/api)(?:\\\/|[A-Za-z0-9_\-.()[\]+*?|^$])*)/g)) {
        found.add('re:' + m[1].replace(/\\\//g, '/'));
    }
    return found;
}

function inventory() {
    const all = new Set();
    for (const f of sourceFiles()) for (const r of routesIn(codeOf(fs.readFileSync(f, 'utf8')))) all.add(r);
    return [...all].sort();
}

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) pass++;
    else { fail++; console.log('  FAIL ' + msg); }
}

// ── 1. inventory ─────────────────────────────────────────────────────────
const now = inventory();
if (process.argv.includes('--update')) {
    fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n');
    console.log(`check-routes: baseline written, ${now.length} routes`);
    process.exit(0);
}
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const have = new Set(now);
const lost = base.filter(r => !have.has(r));
ok(lost.length === 0, `routes gone since the baseline: ${lost.join(', ')}`);
ok(now.length > 150, `inventory found only ${now.length} routes - the extractor broke`);
const added = now.filter(r => !base.includes(r));
if (added.length) console.log(`  [i] ${added.length} new route(s) not in the baseline (run with --update): ${added.slice(0, 8).join(', ')}`);

// ── 2. the gate ──────────────────────────────────────────────────────────
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const start = server.indexOf('function handleAPI(req, res, pathname) {');
ok(start > 0, 'handleAPI found');
const gate = server.indexOf('!isAuthorized(auth, req)', start);
ok(gate > start, 'the auth gate is inside handleAPI');
const pre = server.slice(start, gate);

// Routes answered before the gate: only these, each local-only.
const PRE_GATE = ['/api/health', '/api/sessions/changed'];
const answered = [...pre.matchAll(/if \(pathname === '([^']+)'[^\n]*\{/g)].map(m => m[1]);
ok(JSON.stringify(answered.sort()) === JSON.stringify([...PRE_GATE].sort()),
    `routes answered before the auth gate: ${answered.join(', ')} (allowed: ${PRE_GATE.join(', ')})`);
for (const r of PRE_GATE) {
    const at = pre.indexOf(`pathname === '${r}'`);
    const body = at >= 0 ? pre.slice(at, at + 400) : '';
    ok(/if \(isRemoteRequest\(req\)\) \{ res\.writeHead\(404\)/.test(body), `${r} refuses remote callers`);
}
ok(!/\bhandle[A-Z]\w*Route\(|\broutes\.\w+\(|\bapi[A-Z]\w*\(req/.test(pre), 'no route group is called before the auth gate');
// handleAPI is the gate plus the list of route groups (P2 #9); routes go in a group.
const handleEnd = server.indexOf('\n}\n', gate);
const groupCalls = [...server.slice(gate, handleEnd).matchAll(/if \((api[A-Z]\w*)\(req, res, pathname[^)]*\) !== NOT_MINE\) return;/g)].map(m => m[1]);
ok(groupCalls.length >= 15, `handleAPI calls ${groupCalls.length} route groups after the gate`);
ok(server.slice(start, handleEnd).split('\n').length < 150, 'handleAPI stays short - put new routes in a route group');
// Each group lives in its own file under lib/routes/ (P2 #9, 2026-10-17), wired with the
// shared server state object, so server.js stays the gate and the boot.
for (const g of groupCalls) {
    ok(new RegExp(`const ${g} = require\\('\\./lib/routes/[\\w-]+'\\)\\(S\\);`).test(server),
        `${g} must be loaded from lib/routes/ (const ${g} = require('./lib/routes/...')(S)), not defined in server.js`);
    ok(!new RegExp(`\\nfunction ${g}\\(`).test(server), `${g} is still defined inside server.js`);
}

// The exemption lists, pinned. Widening one is a security decision: edit it here.
function listAfter(name) {
    const at = pre.indexOf(`const ${name} =`);
    if (at < 0) return null;
    const end = pre.indexOf(';', at);
    return [...pre.slice(at, end).matchAll(/'([^']+)'|\/\^(\\\/[^\s)]+)\//g)]
        .map(m => m[1] || 're:' + m[2].replace(/\\\//g, '/')).sort();
}
const SSE = ['/api/projector/stream', '/api/studio/gpu/stream', 're:/api/hf/output/', 're:/api/studio/progress/'];
const BOOTSTRAP = ['/api/auth/login', '/api/auth/logout', '/api/auth/refresh',
    '/api/auth/webauthn/login/options', '/api/auth/webauthn/login/verify'];
ok(JSON.stringify(listAfter('isSSERequest')) === JSON.stringify([...SSE].sort()),
    `SSE exemptions changed: ${JSON.stringify(listAfter('isSSERequest'))}`);
ok(JSON.stringify(listAfter('isAuthBootstrap')) === JSON.stringify([...BOOTSTRAP].sort()),
    `login exemptions changed: ${JSON.stringify(listAfter('isAuthBootstrap'))}`);
ok(/const isPublicImage = pathname\.startsWith\('\/images\/'\);/.test(pre), 'image exemption is /images/ only');
ok(/if \(!isSSERequest && !isPublicImage && !isAuthBootstrap && !isAppCall && !isAuthorized\(auth, req\)\)/.test(server.slice(start, gate + 40)),
    'the gate condition is unchanged');

// Run each route file for real: it must load, and pass on an address it does not own.
// The shared state is a stand-in whose every name is undefined except NOT_MINE and the
// two response helpers. dispatcher.js is not a group: it owns /api/dispatcher/* and
// answers an unknown one there with a 404, asynchronously.
async function runRouteFiles() {
    const NOT_MINE = Symbol('test');
    const codes = [];
    const S = new Proxy({ NOT_MINE, jsonResp: (r, code) => codes.push(code), parseReqUrl: () => ({ query: {} }) }, { get: (o, k) => o[k] });
    const dir = path.join(ROOT, 'lib', 'routes');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')) : [];
    ok(files.length >= 16, `lib/routes/ holds ${files.length} route files, expected the 15 groups and the dispatcher`);
    for (const f of files) {
        const res = { writeHead(c) { codes.push(c); }, end() {} };
        const req = { method: 'GET', url: '/api/dispatcher/__none__', headers: {}, on() { return req; } };
        codes.length = 0;
        let r;
        try {
            const handler = require(path.join(dir, f))(S);
            if (f === 'dispatcher.js') {
                await handler(req, res, '/api/dispatcher/__none__');
                ok(codes.includes(404), `lib/routes/dispatcher.js must answer an unknown dispatcher route with 404 (got ${codes.join(',') || 'nothing'})`);
                continue;
            }
            r = handler({ method: 'GET', url: '/api/__none__', headers: {} }, res, '/api/__none__');
        } catch (e) { r = e; }
        ok(r === NOT_MINE, `lib/routes/${f} must load and pass an unknown address on (got ${r && r.message || String(r)})`);
    }
}

runRouteFiles().then(() => {
console.log(`check-routes: ${pass}/${pass + fail} ${fail ? 'FAILED' : 'ok'} - ${now.length} routes in the inventory`);
process.exit(fail ? 1 : 0);
});
