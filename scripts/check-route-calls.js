#!/usr/bin/env node
// Every route, actually called. check-routes proves each address is still NAMED in the code;
// this proves each one still REACHES the same handler and does the same thing.
//
// Each address in routes-baseline.json is sent as GET, POST, PUT and DELETE through the real
// route groups in lib/routes/, in the order server.js tries them. The server around them is a
// stand-in that records instead of acting: every S.<name> is a recorder (a few pure helpers stay
// real), fs and child_process required inside a route are recorders too, timers never fire,
// process.chdir/exit are recorded, and the clock is frozen. Nothing touches the machine.
// For each request it keeps which group answered, the calls the route made and the response,
// and compares that with scripts/routes-calls.json. `--update` records a new snapshot, which is
// the step that says "this change in behaviour is intended".
//
// Last night's one-off version of this proved the move into lib/routes/ (2026-10-17); this is
// the permanent one, so the next refactor is held to the same standard.
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const ROOT = process.env.CHECK_ROUTES_ROOT || path.join(__dirname, '..');
const SNAPSHOT = path.join(__dirname, 'routes-calls.json');
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const BODY = JSON.stringify({
    session: 'probe', name: 'probe', text: 'probe', message: 'probe', prompt: 'probe', id: 'probe',
    cwd: '/projects/probe', path: '/projects/probe', alias: 'probe', action: 'probe', key: 'probe',
});
// Kept before the world is frozen: the routes get stand-ins, the check keeps the real ones.
const realSetImmediate = setImmediate;
const realExit = process.exit.bind(process);
const realLog = console.log.bind(console);

// ── the recorder ────────────────────────────────────────────────────────────
let log = [];
const say = s => { if (log.length < 60) log.push(s); };

// Paths of this machine are written as <root> and ~, so the snapshot holds on any machine and
// in any folder (and carries no one's home folder into the repo).
// The folders above the repo too: GET /api/projects walks up from it. The temp folder and the
// folders above it stay <tmp>, even for a copy that lives inside it.
const HOME = require('os').homedir();
const TMP = require('os').tmpdir();
const BASE = path.basename(ROOT);
const ABOVE = [];
for (let d = path.dirname(ROOT), up = '<root>/..'; d.length > 1; d = path.dirname(d), up += '/..') {
    if (TMP === d || TMP.startsWith(d + '/')) break;
    ABOVE.push([d, up]);
}
function portable(s) {
    if (s === BASE) return '<root name>';
    s = s.split(`"${BASE}"`).join('"<root name>"');
    s = s.split(ROOT).join('<root>');
    for (const [d, up] of ABOVE) if (s === d || s.startsWith(d + '/')) return up + s.slice(d.length);
    if (s.startsWith(TMP + '/')) return '<tmp>' + s.slice(TMP.length);
    return s.split(HOME).join('~');
}

function brief(v) {
    if (typeof v === 'string') { v = portable(v); return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '...' : v); }
    if (typeof v === 'number' || typeof v === 'boolean' || v == null) return String(v);
    if (typeof v === 'function') return v[NAME] || 'fn';
    if (Array.isArray(v)) return `[${v.length}]`;
    return `{${Object.keys(v).slice(0, 6).join(',')}}`;
}

const NAME = Symbol('recorder name');
const recorders = new Map();
// A stand-in for anything: every property is another recorder, every call is logged and
// returns a recorder. It is also a promise that resolves to undefined, since routes call
// `.then` on what an async helper returns; `.catch`/`.finally` are plain recorded calls.
function recorder(name) {
    if (recorders.has(name)) return recorders.get(name);
    const target = function () {};
    const then = (onDone) => {
        realSetImmediate(() => { try { if (typeof onDone === 'function') onDone(undefined); } catch (e) { say(`threw ${e.name}`); } });
        return recorder(`${name}.then()`);
    };
    const p = new Proxy(target, {
        get(t, k) {
            if (k === NAME) return name;
            if (k === 'then') return then;
            if (k === Symbol.toPrimitive) return () => `<${name}>`;
            if (k === Symbol.iterator) return function* () {};
            if (k === 'toJSON') return () => `<${name}>`;
            if (typeof k === 'symbol') return undefined;
            return recorder(`${name}.${k}`);
        },
        set(t, k) { say(`${name}.${String(k)}=`); return true; },
        apply(t, self, args) { say(`${name}(${args.map(brief).join(', ')})`); return recorder(`${name}()`); },
        construct(t, args) { say(`new ${name}(${args.map(brief).join(', ')})`); return recorder(`new ${name}`); },
    });
    recorders.set(name, p);
    return p;
}

// ── the stand-in server state (S) ───────────────────────────────────────────
function standInS() {
    const real = {
        NOT_MINE: Symbol('not this route group'),
        path,
        PROJECTS_ROOT: '/projects', REMOTE_URL: '', SERVER_SESSION: 'tsrct', TMUX_SESSION: 'probe',
        TMUX_TIMEOUT_MS: 5000, SESSION_TTL_MS: 3600000, LOGIN_LOCK_MS: 60000, MAX_HF_SESSIONS: 3,
        UPLOADS_IMAGES: '/uploads/images', UPLOADS_FILES: '/uploads/files',
        UPLOAD_IMAGE_EXT_RE: /\.(png|jpe?g|gif|webp)$/i, FS_EXCLUDE_DIRS: new Set(['node_modules', '.git']),
        isRemoteRequest: () => false,
        isAuthorized: () => true,
        parseReqUrl(u) {
            const x = new URL(u, 'http://localhost');
            return { pathname: x.pathname, query: Object.fromEntries(x.searchParams) };
        },
        readBody: req => new Promise(resolve => {
            let data = '';
            req.on('data', c => data += c);
            req.on('end', () => resolve(data));
        }),
        jsonResp(res, code, obj) {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        },
        sendJson(req, res, obj, code) {
            res.writeHead(code || 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        },
    };
    const S = new Proxy(real, {
        get(t, k) { return k in t ? t[k] : recorder(`S.${String(k)}`); },
        set(t, k, v) { say(`S.${String(k)}=${brief(v)}`); t[k] = v; return true; },
    });
    return S;
}

// Inside a route file, fs, child_process and the two lazily required modules are recorders.
const FAKE_MODULES = new Set(['fs', 'child_process']);
function fakeRequires() {
    const load = Module._load;
    const routesDir = path.join(ROOT, 'lib', 'routes') + path.sep;
    Module._load = function (request, parent, ...rest) {
        if (parent && parent.filename && parent.filename.startsWith(routesDir) && FAKE_MODULES.has(request)) {
            return recorder(`require(${request})`);
        }
        return load.call(this, request, parent, ...rest);
    };
}

// Timers never fire, the clock is frozen, chdir/exit are recorded: a route can schedule a
// restart or move the process, and here it only says so.
function freezeTheWorld() {
    const RealDate = Date;
    global.Date = class extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(FIXED_NOW); }
        static now() { return FIXED_NOW; }
    };
    let seed = 1;
    Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const handle = () => ({ unref() { return this; }, ref() { return this; } });
    global.setTimeout = (fn, ms) => { say(`setTimeout(${ms})`); return handle(); };
    global.setInterval = (fn, ms) => { say(`setInterval(${ms})`); return handle(); };
    global.clearTimeout = global.clearInterval = () => {};
    process.chdir = d => say(`process.chdir(${brief(d)})`);
    process.cwd = () => ROOT;
    process.exit = c => say(`process.exit(${c})`);
    console.log = console.info = console.warn = console.error = () => {};
}

// ── requests ────────────────────────────────────────────────────────────────
function fakeReq(method, url) {
    const req = new EventEmitter();
    Object.assign(req, {
        method, url,
        headers: { host: 'localhost:3847', authorization: 'Bearer probe', 'content-type': 'application/json' },
        socket: { remoteAddress: '127.0.0.1' }, connection: { remoteAddress: '127.0.0.1' },
    });
    // The body is delivered to whoever listens, whenever they start listening.
    const on = req.on.bind(req);
    req.on = req.addListener = (ev, fn) => {
        on(ev, fn);
        if (ev === 'end') realSetImmediate(() => {
            try { req.emit('data', BODY); req.emit('end'); } catch (e) { say(`threw ${e.name}`); }
        });
        return req;
    };
    return req;
}

function fakeRes() {
    const res = new EventEmitter();
    Object.assign(res, {
        headersSent: false, writableEnded: false, statusCode: 200,
        setHeader() {}, getHeader() {}, removeHeader() {}, flushHeaders() {},
        writeHead(code) { say(`=> ${code}`); res.headersSent = true; return res; },
        write(chunk) { say(`write(${String(chunk).length})`); return true; },
        end(body) {
            if (body != null) say(`end ${portable(String(body)).replace(/\s+/g, ' ').slice(0, 100)}`);
            else say('end');
            res.writableEnded = true;
        },
    });
    return res;
}

// The groups and their order, read from server.js, so this check follows the real chain.
function chain(S) {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const files = {};
    for (const m of server.matchAll(/const (\w+) = require\('\.\/lib\/routes\/([\w-]+)'\)\(S\);/g)) files[m[1]] = m[2];
    S.handleDispatcherRoute = require(path.join(ROOT, 'lib', 'routes', files.handleDispatcherRoute))(S);
    const order = [...server.matchAll(/if \((api\w+)\(req, res, pathname(?:, (\w+))?\) !== NOT_MINE\) return;/g)];
    const EXTRA = { auth: 'Bearer probe', isAppCall: false };
    return order.map(([, name, extra]) => ({
        name, extra: extra ? [EXTRA[extra]] : [],
        fn: require(path.join(ROOT, 'lib', 'routes', files[name]))(S),
    }));
}

// A concrete address for each baseline entry: regexes and templates get a sample id.
function addressOf(entry) {
    let a = entry.startsWith('re:') ? entry.slice(3).replace(/[([].*$/, '') : entry;
    a = a.replace(/\$\{[^}]*\}?/g, 'probe').replace(/[^A-Za-z0-9_\-./:]/g, '');
    if (a.endsWith('/') || a.endsWith(':')) a += 'probe';
    return a;
}

async function settle() {
    let last = -1, still = 0;
    for (let i = 0; i < 200 && still < 5; i++) {
        await new Promise(r => realSetImmediate(r));
        if (log.length === last) still++; else { still = 0; last = log.length; }
    }
}

async function callOne(groups, S, method, address) {
    log = [];
    const req = fakeReq(method, address);
    const res = fakeRes();
    let owner = 'none';
    try {
        for (const g of groups) {
            if (g.fn(req, res, address, ...g.extra) !== S.NOT_MINE) { owner = g.name; break; }
        }
    } catch (e) { say(`threw ${e.name}`); }
    await settle();
    return `${owner} | ${log.join(' ; ')}`;
}

async function record() {
    fakeRequires();
    freezeTheWorld();
    process.on('unhandledRejection', e => say(`rejected ${e && e.name}`));
    process.on('uncaughtException', e => say(`threw ${e && e.name}`));
    const S = standInS();
    const groups = chain(S);
    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'routes-baseline.json'), 'utf8'));
    // /images/ is the one public route outside /api/, so the baseline does not list it.
    const addresses = [...new Set([...baseline.map(addressOf), '/images/probe', '/images/probe.png'])].sort();
    const out = {};
    for (const a of addresses) for (const m of METHODS) out[`${m} ${a}`] = await callOne(groups, S, m, a);
    return { groups: groups.length, out };
}

function compare(now, before) {
    const problems = [];
    for (const k of Object.keys(before)) {
        if (!(k in now)) problems.push(`gone: ${k}`);
        else if (now[k] !== before[k]) problems.push(`changed: ${k}\n      was: ${before[k]}\n      now: ${now[k]}`);
    }
    for (const k of Object.keys(now)) if (!(k in before)) problems.push(`new: ${k} (run with --update to record it)`);
    return problems;
}

record().then(({ groups, out }) => {
    const owned = Object.values(out).filter(v => !v.startsWith('none ')).length;
    const total = Object.keys(out).length;
    // A floor, so the check cannot pass on nothing (a guard check once read 0 routes and stayed green).
    if (groups < 15 || owned < 200) {
        realLog(`check-route-calls: FAILED - only ${groups} route groups and ${owned} answered requests found; the chain in server.js was not read`);
        realExit(1);
    }
    if (process.argv.includes('--update')) {
        fs.writeFileSync(SNAPSHOT, JSON.stringify(out, null, 1) + '\n');
        realLog(`check-route-calls: recorded ${total} requests (${owned} answered) to ${path.basename(SNAPSHOT)}`);
        realExit(0);
    }
    const before = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : {};
    const problems = compare(out, before);
    problems.slice(0, 10).forEach(p => realLog('  FAIL ' + p));
    if (problems.length > 10) realLog(`  ... and ${problems.length - 10} more`);
    realLog(`check-route-calls: ${total} requests through ${groups} groups, ${owned} answered` +
        (problems.length ? ` - ${problems.length} differ from the snapshot FAILED` : ', all as recorded ok'));
    realExit(problems.length ? 1 : 0);
}).catch(e => {
    // A route file that does not load must be red, never a quiet exit.
    realLog(`check-route-calls: FAILED - could not run the routes: ${e && e.message}`);
    realExit(1);
});
