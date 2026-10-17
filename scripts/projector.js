#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/projector.js — a separate browser a Claude session drives, which
// Leon watches live in TSRCT's PROJECTOR window (lib/projector.js).
//
// It never touches his real mouse or keyboard: this is a headless
// chrome-headless-shell with its OWN profile (~/.config/tsrct/projector/
// profiles/<session>), driven over CDP by puppeteer-core. puppeteer-core is not
// a TSRCT dependency; like tools/reddit-fetch.js this reuses the install in
// ~/headless-chrome.
//
// From a Claude session running inside tmux (the session name is detected):
//   node scripts/projector.js start                 open the browser, register it
//   node scripts/projector.js open <url>            go to a page
//   node scripts/projector.js look [--full]         screenshot -> prints the PNG path (Read it)
//   node scripts/projector.js read                  url, title, visible text
//   node scripts/projector.js find <text>           clickable things matching text, with x,y (iframes too)
//   node scripts/projector.js click <x> <y>         also: click text=Save | click css=#id
//   node scripts/projector.js dblclick|rightclick <x> <y>
//   node scripts/projector.js type "<text>"         types into whatever has focus
//   node scripts/projector.js key Enter             also Tab, Escape, Control+A ...
//   node scripts/projector.js drag <x1> <y1> <x2> <y2> [--synthetic]   (a real drag; works for HTML5 too)
//   node scripts/projector.js scroll <dy> [x y]
//   node scripts/projector.js upload [x y | text=... | css=...] <file>   fill a file input / answer the file picker
//   node scripts/projector.js download <url> [name]   public file -> projector/downloads/<session>/
//   node scripts/projector.js back | reload | tabs | tab <n>
//   node scripts/projector.js status | stop
// Add --session NAME to drive another session's browser (or TSRCT_SESSION=...).
//
// The browser is ONE per session, closes on `stop`, when its tmux session ends,
// or after IDLE_MS with nobody driving or watching it. Passwords: Leon types his
// own in the projector window; nothing here stores, prints or logs them.
// SecretCo: a session, url or page that mentions SecretCo is refused, because what
// `read`/`look` print goes straight back into a public-API Claude session.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../lib/paths');
const { spawn, spawnSync } = require('child_process');
const projector = require('../lib/projector');
const restrictedGuard = require('../lib/dispatcher/restrictedGuard');

const PUP = process.env.PUPPETEER_CORE_PATH || path.join(paths.HEADLESS_DIR, 'node_modules/puppeteer-core');
const CHROME = process.env.CHROME_SHELL_PATH
    || path.join(paths.HEADLESS_DIR, 'chs/chrome-headless-shell-linux64/chrome-headless-shell');
// The shell's own shared libraries (libnspr4 & co.) are unpacked next to it, not
// installed system-wide: without this the browser exits 127 at launch.
const CHROME_LIBS = process.env.CHROME_LIBS || path.join(paths.HEADLESS_DIR, 'libs/usr/lib/x86_64-linux-gnu');
const VIEW = { width: 1280, height: 800 };
const IDLE_MS = Number(process.env.PROJECTOR_IDLE_MS) || 3 * 3600 * 1000;
const KEEPER_TICK_MS = 20000;

const COMMANDS = ['start', 'stop', 'status', 'open', 'look', 'read', 'find', 'click', 'dblclick', 'rightclick',
    'type', 'key', 'drag', 'scroll', 'upload', 'download', 'back', 'reload', 'tabs', 'tab', 'serve'];
const DOWNLOAD_MAX = 300 * 1024 * 1024;

function urlProblem(url) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u) && u !== 'about:blank') return 'only http(s) pages';
    if (restrictedGuard.mentionsRestricted(u)) return 'SecretCo is never opened here (AWS Bedrock only)';
    return null;
}

// A file the page may receive: it must exist, be a plain file, and never be SecretCo's.
function uploadable(p) {
    if (!p) die('upload [x y | text=... | css=...] <file>');
    const abs = path.resolve(p);
    if (restrictedGuard.mentionsRestricted(abs)) die('an SecretCo file is never uploaded here (AWS Bedrock only)');
    let st = null;
    try { st = fs.statSync(abs); } catch {}
    if (!st || !st.isFile()) die('no such file: ' + abs);
    return abs;
}

// download <url> [name] -> ~/.config/tsrct/projector/downloads/<session>/<name>.
// A plain fetch, not the browser: no cookies, so it is for public files (a
// GitHub "Download ZIP"). Redirects are followed and the final address checked too.
async function download(session, url, name) {
    const bad = urlProblem(url);
    if (bad) die(bad);
    const res = await fetch(url, { redirect: 'follow' }).catch(e => die('download failed: ' + e.message));
    if (restrictedGuard.mentionsRestricted(res.url)) die('it redirected to SecretCo - refused');
    if (!res.ok) die(`download failed: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > DOWNLOAD_MAX) die('over 300 MB - not downloaded');
    const cd = res.headers.get('content-disposition') || '';
    const fromHeader = (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1];
    let file = (name || fromHeader || decodeURIComponent(new URL(res.url).pathname.split('/').pop() || '') || 'download')
        .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 120);
    const dir = path.join(projector.dir(), 'downloads', session);
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > DOWNLOAD_MAX) die('over 300 MB - not downloaded');
    const out = path.join(dir, file);
    fs.writeFileSync(out, buf);
    console.log(`[projector] saved ${buf.length} bytes to ${out}`);
}

function die(msg) { console.error('[projector] ' + msg); process.exit(1); }

function argValue(args, flag) {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
}

function sessionName(args) {
    const s = argValue(args, '--session') || process.env.TSRCT_SESSION
        || (process.env.TMUX ? (spawnSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8', timeout: 5000 }).stdout || '').trim() : '');
    if (!s) die('no session: run inside tmux or pass --session NAME');
    if (!projector.NAME_RE.test(s)) die('bad session name: ' + s);
    if (restrictedGuard.mentionsRestricted(s)) die('SecretCo is never projected (AWS Bedrock only)');
    return s;
}

function loadPuppeteer() {
    try { return require(PUP); } catch { die('puppeteer-core not found at ' + PUP + ' (set PUPPETEER_CORE_PATH)'); }
}

function tmuxHas(session) {
    return spawnSync('tmux', ['has-session', '-t', '=' + session], { timeout: 5000 }).status === 0;
}

// ── the keeper: owns the browser for as long as it lives ────────────────────
async function serve(session) {
    const puppeteer = loadPuppeteer();
    const profile = path.join(projector.dir(), 'profiles', session);
    fs.mkdirSync(profile, { recursive: true });
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        userDataDir: profile,
        defaultViewport: VIEW,
        env: fs.existsSync(CHROME_LIBS)
            ? { ...process.env, LD_LIBRARY_PATH: [CHROME_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
            : process.env,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=en-US',
            '--password-store=basic', '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication',
            `--window-size=${VIEW.width},${VIEW.height}`],
    });
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    const port = Number(new URL(browser.wsEndpoint()).port);
    const targetId = await idOf(page);
    let closing = false;
    const close = async (why) => {
        if (closing) return;
        closing = true;
        projector.unregister(session);
        console.error(`[projector] ${session}: closing (${why})`);
        try { await browser.close(); } catch {}
        process.exit(0);
    };
    const r = projector.register({
        session, kind: 'browser', port, pid: browser.process().pid, keeperPid: process.pid,
        targetId, wsEndpoint: browser.wsEndpoint(), url: 'about:blank', title: '',
        startedAt: Date.now(), lastUsed: Date.now(),
    });
    if (!r.ok) { await browser.close(); die(r.error); }
    // A redirect can land where `open` would have refused to go.
    browser.on('targetchanged', async (t) => {
        if (t.type() !== 'page') return;
        const url = t.url();
        if (restrictedGuard.mentionsRestricted(url)) {
            try { const p = await t.page(); await p.goto('about:blank'); } catch {}
            return;
        }
        const cur = projector.source(session);
        if (cur && (await idOf(await t.page()).catch(() => '')) === cur.targetId) {
            let title = '';
            try { title = await (await t.page()).title(); } catch {}
            projector.touch(session, { url, title: restrictedGuard.mentionsRestricted(title) ? '' : title });
        }
    });
    browser.on('disconnected', () => close('browser gone'));
    process.on('SIGTERM', () => close('stop'));
    process.on('SIGINT', () => close('stop'));
    setInterval(() => {
        if (!tmuxHas(session)) return close('tmux session ended');
        const cur = projector.source(session);
        if (!cur) return close('unregistered');
        const last = Math.max(cur.lastUsed || 0, cur.lastViewed || 0);
        if (Date.now() - last > IDLE_MS) close('idle');
    }, KEEPER_TICK_MS);
}

async function idOf(page) {
    const c = await page.createCDPSession();
    try { return (await c.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { c.detach().catch(() => {}); }
}

// ── commands that drive an already-running browser ──────────────────────────
async function withPage(session, fn) {
    const entry = projector.source(session);
    if (!entry) die(`no browser for ${session}. Run: node scripts/projector.js start`);
    const puppeteer = loadPuppeteer();
    const browser = await puppeteer.connect({ browserWSEndpoint: entry.wsEndpoint, defaultViewport: null });
    try {
        const pages = await browser.pages();
        let page = null;
        for (const p of pages) if ((await idOf(p).catch(() => '')) === entry.targetId) { page = p; break; }
        if (!page) page = pages[0];
        if (!page) die('the browser has no page');
        projector.touch(session, { lastUsed: Date.now() });
        return await fn(page, browser, entry);
    } finally {
        browser.disconnect();
    }
}

async function guardPage(page) {
    const url = page.url();
    let title = '';
    try { title = await page.title(); } catch {}
    if (restrictedGuard.mentionsRestricted(url, title)) die('this page is SecretCo - refused (AWS Bedrock only)');
    return { url, title };
}

// ── finding things on the page: every frame, open shadow roots, visible first ──
// Measured on the ShopLine course (2026-10-12), three ways the first
// version picked wrong:
//   - `css=textarea` took the FIRST match, the Academy's hidden "Chat with
//     Instructor" box, so the typing went nowhere;
//   - `text=OK, let's go` took the first element whose text CONTAINED the label,
//     the modal itself, and clicked its middle instead of the button;
//   - nothing looked inside iframes, so Salesforce Setup and the shopline.com
//     sign-up form had "no fields".
// So: every frame (same- and cross-origin) is searched, open shadow roots too,
// an element must really be visible (checkVisibility: display, visibility,
// opacity) to count, on screen and not covered beats off screen, a real control
// (button, link, input) beats a container, and a match that holds a smaller
// match loses to it (innermost wins). Run inside the page, so it is plain JS
// with no closure.
const CLICKABLE = 'a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=combobox],[draggable=true],label,summary,[onclick],[tabindex]';
function inPagePick(kind, q, opts) {
    const deepAll = (sel) => {
        const out = [];
        const walk = (root) => {
            for (const e of root.querySelectorAll(sel)) out.push(e);
            for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
        };
        walk(document);
        return out;
    };
    const visible = (e) => {
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        return e.checkVisibility ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
    };
    const onScreen = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const uncovered = (e, r) => {
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = (e.getRootNode().elementFromPoint || document.elementFromPoint).call(e.getRootNode(), x, y);
        return !!hit && (hit === e || e.contains(hit) || (hit.shadowRoot && hit.shadowRoot.contains(e)));
    };
    const label = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title')
        || e.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ');
    const REAL = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/;
    const ROLE = /^(button|link|tab|menuitem|option|checkbox|radio|combobox)$/;
    const want = String(q || '').trim().toLowerCase();

    let found;
    if (kind === 'css') {
        try { found = deepAll(q); } catch (err) { return { error: 'bad css: ' + err.message }; }
    } else if (kind === 'file') {
        found = deepAll('input[type=file]');
    } else {
        found = deepAll(opts.clickable).filter(e => {
            const t = label(e).toLowerCase();
            return want ? t.includes(want) : !!t;
        });
    }
    const rows = [];
    for (const e of found) {
        const vis = visible(e);
        if (!vis && !opts.hidden) continue;
        const r = e.getBoundingClientRect();
        const t = label(e);
        let score = vis ? 100 : 0;
        if (vis && onScreen(r)) score += 20;
        if (vis && onScreen(r) && uncovered(e, r)) score += 10;
        if (kind === 'text') {
            const tl = t.toLowerCase();
            score += tl === want ? 60 : tl.startsWith(want) ? 40 : 20;
            if (REAL.test(e.tagName) || ROLE.test(e.getAttribute('role') || '')) score += 30;
            else if (e.tagName === 'LABEL') score += 15;
            // A match that holds another match is the container: the inner one wins.
            if (found.some(o => o !== e && e.contains(o) && (visible(o) || opts.hidden))) score -= 80;
        }
        rows.push({ e, score, area: r.width * r.height, tag: e.tagName.toLowerCase(), text: t.slice(0, 80),
            x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), vis, type: e.type || '' });
    }
    // Higher score first; among equals the smaller box (more precise), then page order.
    rows.sort((a, b) => b.score - a.score || a.area - b.area);
    if (opts.all) return { rows: rows.slice(0, opts.limit || 40).map(({ e, ...r }) => r) };
    const best = rows[0];
    return best ? { el: best.e, score: best.score, vis: best.vis, tag: best.tag, type: best.type } : { none: true };
}

// The frames worth searching: attached, and never SecretCo.
function framesOf(page) {
    return page.frames().filter(f => !f.detached && !restrictedGuard.mentionsRestricted(f.url()));
}

// Where a frame's content starts on the page (0,0 for the main frame).
async function frameOffset(frame) {
    if (!frame.parentFrame()) return { x: 0, y: 0 };
    try {
        const el = await frame.frameElement();
        const bm = el && await el.boxModel();
        if (bm) return { x: bm.content[0].x, y: bm.content[0].y };
    } catch {}
    return null;
}

// The best element for text=/css=/file across every frame -> {handle, frame, ...}.
async function bestElement(page, kind, q, { hidden = false } = {}) {
    let best = null;
    for (const frame of framesOf(page)) {
        let h;
        try { h = await frame.evaluateHandle(inPagePick, kind, q, { clickable: CLICKABLE, hidden }); } catch { continue; }
        const info = await h.evaluate(r => r.error ? { error: r.error } : r.none ? null : { score: r.score, vis: r.vis, tag: r.tag, type: r.type }).catch(() => null);
        if (info && info.error) { await h.dispose(); die(info.error); }
        if (info && (!best || info.score > best.score)) {
            if (best) await best.h.dispose();
            best = { ...info, h, frame };
        } else await h.dispose();
    }
    if (!best) return null;
    const handle = (await best.h.getProperty('el')).asElement();
    await best.h.dispose();
    return handle ? { handle, frame: best.frame, vis: best.vis, tag: best.tag, type: best.type } : null;
}

// "text=Save" / "css=#id" / "x y" -> a point on the page (+ the element, when there is one).
async function pointOf(page, args, { hidden = false } = {}) {
    const a = args[0] || '';
    if (/^(text|css)=/.test(a)) {
        const [kind, ...rest] = a.split('=');
        const q = rest.join('=') || args.slice(1).join(' ');
        const hit = await bestElement(page, kind, q, { hidden });
        if (!hit) die(`nothing visible on the page matches ${a}`);
        if (!hit.vis) return { handle: hit.handle, tag: hit.tag, type: hit.type };
        await hit.handle.scrollIntoView().catch(() => {});
        const box = await hit.handle.boundingBox();
        if (!box) die(`${a} is not on screen`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, handle: hit.handle, tag: hit.tag, type: hit.type };
    }
    const x = Number(args[0]), y = Number(args[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) die('give x y, or text=..., or css=...');
    return { x, y };
}

const KEYMAP = { ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', cmd: 'Meta', meta: 'Meta', enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab' };

async function run(cmd, args) {
    if (cmd === 'serve') return serve(sessionName(args));
    const session = sessionName(args);

    if (cmd === 'start') {
        const cur = projector.source(session);
        if (cur) return console.log(`[projector] ${session}: already running (port ${cur.port}). It shows in TSRCT's projector window.`);
        // The keeper's own output goes to a log next to the registry, so a launch
        // that fails says why instead of timing out in silence.
        fs.mkdirSync(projector.dir(), { recursive: true });
        const logFile = path.join(projector.dir(), session + '.log');
        const fd = fs.openSync(logFile, 'w');
        const child = spawn(process.execPath, [__filename, 'serve', '--session', session], {
            detached: true, stdio: ['ignore', fd, fd], env: { ...process.env },
        });
        child.unref();
        fs.closeSync(fd);
        let exited = false;
        child.on('exit', () => { exited = true; });
        for (let i = 0; i < 60 && !exited; i++) {
            await new Promise(r => setTimeout(r, 500));
            const e = projector.source(session);
            if (e) return console.log(`[projector] ${session}: browser ready (${VIEW.width}x${VIEW.height}). Watch it in TSRCT: projector button, pick "${session}".`);
        }
        let why = '';
        try { why = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(0, 6).join('\n'); } catch {}
        die(`the browser did not come up${why ? ':\n' + why : ' in 30 s'}`);
    }
    if (cmd === 'stop') {
        const cur = projector.source(session);
        if (!cur) return console.log(`[projector] ${session}: nothing running`);
        try { process.kill(cur.keeperPid, 'SIGTERM'); } catch {}
        for (let i = 0; i < 20 && projector.source(session); i++) await new Promise(r => setTimeout(r, 300));
        if (projector.source(session)) { try { process.kill(cur.pid, 'SIGKILL'); } catch {} projector.unregister(session); }
        return console.log(`[projector] ${session}: browser closed`);
    }
    if (cmd === 'download') return download(session, args[0] || '', args[1]);
    if (cmd === 'status') {
        const cur = projector.source(session);
        return console.log(cur ? JSON.stringify({ session, url: cur.url, title: cur.title, startedAt: new Date(cur.startedAt).toISOString() }) : `[projector] ${session}: nothing running`);
    }

    return withPage(session, async (page, browser, entry) => {
        if (cmd === 'open') {
            let url = args[0] || '';
            if (url && !/^[a-z]+:/i.test(url)) url = 'https://' + url;
            const bad = urlProblem(url);
            if (bad) die(bad);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.error('[projector] ' + e.message));
            await new Promise(r => setTimeout(r, 800));
            const g = await guardPage(page);
            return console.log(JSON.stringify(g));
        }
        if (cmd === 'back') { await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); return console.log(JSON.stringify(await guardPage(page))); }
        if (cmd === 'reload') { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); return console.log(JSON.stringify(await guardPage(page))); }
        if (cmd === 'tabs' || cmd === 'tab') {
            const pages = (await browser.pages());
            const rows = [];
            for (let i = 0; i < pages.length; i++) {
                const id = await idOf(pages[i]).catch(() => '');
                const u = pages[i].url();
                rows.push({ n: i, active: id === entry.targetId, url: restrictedGuard.mentionsRestricted(u) ? '[secretco - hidden]' : u, id });
            }
            if (cmd === 'tab') {
                const row = rows[Number(args[0])];
                if (!row) die('no such tab');
                if (row.url === '[secretco - hidden]') die('that tab is SecretCo - refused');
                projector.touch(session, { targetId: row.id, url: row.url });
                await pages[row.n].bringToFront();
                return console.log(`[projector] now driving tab ${row.n}: ${row.url}`);
            }
            return console.log(JSON.stringify(rows.map(({ id, ...r }) => r)));
        }

        await guardPage(page);
        if (cmd === 'look') {
            const full = args.includes('--full');
            const out = path.join(projector.dir(), 'shots', `${session}-${Date.now()}.png`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            // Keep the last 20 only.
            const dir = path.dirname(out);
            const old = fs.readdirSync(dir).filter(f => f.startsWith(session + '-')).sort();
            for (const f of old.slice(0, Math.max(0, old.length - 19))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
            await page.screenshot({ path: out, fullPage: full });
            return console.log(out);
        }
        if (cmd === 'read') {
            const text = await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n'));
            return console.log(`URL: ${page.url()}\nTITLE: ${await page.title()}\n\n${text.slice(0, 20000)}${text.length > 20000 ? '\n[... cut at 20000 chars]' : ''}`);
        }
        if (cmd === 'find') {
            // Every frame, in page coordinates: a field inside an iframe gets the x,y
            // a click on the page needs.
            const q = args.join(' ');
            const rows = [];
            for (const frame of framesOf(page)) {
                const off = await frameOffset(frame);
                if (!off) continue;
                const got = await frame.evaluate(inPagePick, 'text', q, { clickable: CLICKABLE, all: true, limit: 40 }).catch(() => null);
                for (const r of (got && got.rows) || []) {
                    const x = r.x + off.x, y = r.y + off.y;
                    rows.push({ tag: r.tag, text: r.text, x: Math.round(x), y: Math.round(y),
                        onScreen: y > 0 && y < VIEW.height && x > 0 && x < VIEW.width,
                        ...(frame.parentFrame() ? { inFrame: true } : {}), score: r.score });
                }
            }
            rows.sort((a, b) => b.score - a.score);
            return console.log(JSON.stringify(rows.slice(0, 40).map(({ score, ...r }) => r), null, 0));
        }
        if (cmd === 'upload') {
            // upload [x y | text=... | css=...] <file>. A file input is filled
            // directly (even a hidden one); anything else is clicked while a file
            // chooser is awaited, which is how a "Choose file" button or a drop
            // zone in front of a hidden input works.
            const file = uploadable(args.pop());
            if (!args.length) {
                const hit = await bestElement(page, 'file', '', { hidden: true });
                if (!hit) die('no file input on this page: give the upload button, e.g. upload "text=Upload Files" ' + file);
                await hit.handle.uploadFile(file);
                return console.log(`[projector] uploaded ${path.basename(file)} into the page's file input`);
            }
            const p = await pointOf(page, args, { hidden: /^css=/.test(args[0] || '') });
            if (p.handle && p.tag === 'input' && p.type === 'file') {
                await p.handle.uploadFile(file);
                return console.log(`[projector] uploaded ${path.basename(file)} into ${args[0]}`);
            }
            if (p.x === undefined) die(`${args[0]} is hidden and is not a file input`);
            const chooser = page.waitForFileChooser({ timeout: 6000 }).catch(() => null);
            await page.mouse.move(p.x, p.y, { steps: 5 });
            await page.mouse.click(p.x, p.y);
            const fc = await chooser;
            if (!fc) die(`clicking ${args.join(' ')} at ${Math.round(p.x)},${Math.round(p.y)} opened no file picker`);
            await fc.accept([file]);
            return console.log(`[projector] uploaded ${path.basename(file)} through the picker at ${Math.round(p.x)},${Math.round(p.y)}`);
        }
        if (cmd === 'click' || cmd === 'dblclick' || cmd === 'rightclick') {
            const p = await pointOf(page, args);
            await page.mouse.move(p.x, p.y, { steps: 5 });
            await page.mouse.click(p.x, p.y, { button: cmd === 'rightclick' ? 'right' : 'left', clickCount: cmd === 'dblclick' ? 2 : 1 });
            return console.log(`[projector] ${cmd} at ${Math.round(p.x)},${Math.round(p.y)}`);
        }
        if (cmd === 'type') {
            await page.keyboard.type(args.join(' '), { delay: 25 });
            return console.log(`[projector] typed ${args.join(' ').length} chars`);
        }
        if (cmd === 'key') {
            const combo = String(args[0] || '').split('+').map(k => KEYMAP[k.toLowerCase()] || k);
            const mods = combo.slice(0, -1), last = combo[combo.length - 1];
            for (const m of mods) await page.keyboard.down(m);
            await page.keyboard.press(last);
            for (const m of mods.reverse()) await page.keyboard.up(m);
            return console.log(`[projector] key ${combo.join('+')}`);
        }
        if (cmd === 'drag') {
            const synthetic = args.includes('--synthetic');
            const nums = args.filter(a => a !== '--synthetic').map(Number);
            if (nums.length < 4 || nums.some(n => !Number.isFinite(n))) die('drag x1 y1 x2 y2');
            const [x1, y1, x2, y2] = nums;
            if (!synthetic) {
                // A human-shaped drag: press, a small first move (libraries wait
                // for a threshold), many steps, a pause over the target, release.
                // Measured 2026-10-12: in chrome-headless-shell this one gesture
                // works for BOTH kinds - a JS mouse-drag library and a native
                // HTML5 draggable (dataTransfer + drop) - with one drop each.
                // (Intercepting the drag over CDP never fired in this old
                // headless, and puppeteer's mouse.dragAndDrop hung and left the
                // page deaf to input until the browser restarted. Don't.)
                await page.mouse.move(x1, y1);
                await page.mouse.down();
                await page.mouse.move(x1 + 6, y1 + 6, { steps: 3 });
                await page.mouse.move(x2, y2, { steps: 25 });
                await new Promise(r => setTimeout(r, 300));
                await page.mouse.up();
            } else {
                // Last resort, for a page that ignores the real gesture: play the
                // HTML5 events in the page with one shared DataTransfer
                // (dragstart -> dragenter -> dragover -> drop -> dragend) on
                // whatever is under each point. Untrusted events: some apps
                // refuse them, which is why this is not the default.
                const r = await page.evaluate((x1, y1, x2, y2) => {
                    const src = document.elementFromPoint(x1, y1), dst = document.elementFromPoint(x2, y2);
                    if (!src || !dst) return 'no element under one of the points';
                    const dt = new DataTransfer();
                    const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
                    fire(src, 'dragstart', x1, y1);
                    fire(dst, 'dragenter', x2, y2);
                    fire(dst, 'dragover', x2, y2);
                    fire(dst, 'drop', x2, y2);
                    fire(src, 'dragend', x2, y2);
                    return '';
                }, x1, y1, x2, y2);
                if (r) die('synthetic drag: ' + r);
            }
            return console.log(`[projector] dragged ${x1},${y1} -> ${x2},${y2}${synthetic ? ' (synthetic)' : ''}`);
        }
        if (cmd === 'scroll') {
            const dy = Number(args[0]) || 600;
            const x = Number(args[1]) || VIEW.width / 2, y = Number(args[2]) || VIEW.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.wheel({ deltaY: dy });
            return console.log(`[projector] scrolled ${dy}`);
        }
        die('unknown command: ' + cmd);
    });
}

if (require.main === module) {
    const [cmd, ...args] = process.argv.slice(2);
    if (!cmd || !COMMANDS.includes(cmd)) {
        console.log('usage: node scripts/projector.js <' + COMMANDS.filter(c => c !== 'serve').join('|') + '> ... [--session NAME]');
        process.exit(cmd ? 1 : 0);
    }
    // No command may hang a Claude session's Bash call: 90 s is the cap
    // (the keeper, `serve`, lives as long as the browser and has no cap).
    if (cmd !== 'serve') setTimeout(() => die(`${cmd} took over 90 s - gave up`), 90000).unref();
    run(cmd, args).then(() => { if (cmd !== 'serve') process.exit(0); }).catch(e => die(e.message));
}

module.exports = { urlProblem, COMMANDS };
