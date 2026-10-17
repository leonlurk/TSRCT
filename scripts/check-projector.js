#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/check-projector.js — the PROJECTOR (2026-10-12).
//
// Run: node scripts/check-projector.js   (exit 0 = clean, 1 = a check failed)
//
// The projector is a live view of a SEPARATE browser that another Claude
// session drives, so Leon can watch a course run on screen while his own mouse
// and keyboard stay his. What has to hold:
//   - a source registers itself under its tmux session and disappears when its
//     browser dies (the dropdown reflects reality, no manual setup);
//   - nothing SecretCo is ever registered, listed, streamed or read back;
//   - frames flow ONLY while a window is watching that session: the last viewer
//     leaving, or picking another session, stops the screencast;
//   - a click on the picture lands on the same spot of the page, letterboxing
//     included;
//   - the button sits right below the Usage ($) rail button, opens the window in
//     one tap, and every handler the window uses is on `window`.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let failed = 0, passed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.error(`  [!] ${name}${detail ? ' -- ' + detail : ''}`);
}

(async () => {
    let projector = null;
    try { projector = require('../lib/projector'); }
    catch (e) { check('lib/projector.js loads', false, e.message); }

    if (projector) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projector-check-'));
        const alive = new Set([111, 222]);
        projector.configure({ dir, isAlive: (pid) => alive.has(pid) });

        // ── registry ──
        const r1 = projector.register({ session: 'shopline-d7', kind: 'browser', port: 9333, pid: 111, targetId: 'T1', wsEndpoint: 'ws://x' });
        check('a browser registers under its tmux session', r1 && r1.ok, JSON.stringify(r1));
        check('the registered source is read back', (projector.source('shopline-d7') || {}).port === 9333);
        const bad = projector.register({ session: 'secretco', kind: 'browser', port: 1, pid: 111, targetId: 'T' });
        check('an SecretCo session is refused at registration', bad && !bad.ok);
        const bad2 = projector.register({ session: 'SecretCoSandbox-2', kind: 'browser', port: 1, pid: 111, targetId: 'T' });
        check('an SecretCoSandbox session is refused at registration', bad2 && !bad2.ok);
        const bad3 = projector.register({ session: '../etc', kind: 'browser', port: 1, pid: 111, targetId: 'T' });
        check('a session name with a path in it is refused', bad3 && !bad3.ok);

        // A file planted by hand (or left from before a rename) must still never be listed.
        fs.writeFileSync(path.join(dir, 'secretco.json'), JSON.stringify({ session: 'secretco', kind: 'browser', port: 2, pid: 111, targetId: 'T' }));
        projector.register({ session: 'dead-one', kind: 'browser', port: 9444, pid: 999, targetId: 'T2' });
        const listed = projector.sourcesFor(['shopline-d7', 'dead-one', 'secretco', 'tsrct', 'tesla-tsrct', 'run-x']);
        const names = listed.map(s => s.name);
        check('the dropdown lists live tmux sessions', names.includes('shopline-d7') && names.includes('tsrct'), names.join(','));
        check('the dropdown never lists SecretCo', !names.some(n => /secretco/i.test(n)), names.join(','));
        check('the dropdown hides Tesla brains and runners', !names.includes('tesla-tsrct') && !names.includes('run-x'));
        check('a session with a browser shows it', (listed.find(s => s.name === 'shopline-d7') || {}).source);
        check('a session without one says so (source null)', (listed.find(s => s.name === 'tsrct') || {}).source === null);
        check('a dead browser is not projectable', (listed.find(s => s.name === 'dead-one') || {}).source === null);
        check('a dead browser is pruned from disk', !fs.existsSync(path.join(dir, 'dead-one.json')));
        projector.unregister('shopline-d7');
        check('unregister removes the source', projector.source('shopline-d7') === null);

        // ── SecretCo on the page itself ──
        check('an SecretCo url blocks the stream', projector.isBlocked({ session: 'x', url: 'https://secretco-sandbox.my.salesforce.com/', title: '' }));
        check('an SecretCo title blocks the stream', projector.isBlocked({ session: 'x', url: 'about:blank', title: 'SecretCo | Home' }));
        check('an ordinary page is not blocked', !projector.isBlocked({ session: 'shopline-d7', url: 'https://trailhead.salesforce.com/', title: 'Theme Developer' }));

        // ── frames only while watched ──
        const calls = [];
        const fakes = [];
        projector.configure({
            connect: async (entry) => {
                const handlers = [];
                const c = {
                    entry, closed: false,
                    send: async (method, params) => {
                        calls.push(entry.session + ':' + method);
                        // a still page: Chrome answers a screenshot, but the screencast stays silent
                        if (method === 'Page.captureScreenshot') return { data: 'STILL' };
                        if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
                        return {};
                    },
                    on: (fn) => handlers.push(fn),
                    onClose: () => {},
                    close: () => { c.closed = true; calls.push(entry.session + ':close'); },
                    emit: (m, p) => handlers.forEach(h => h(m, p)),
                };
                fakes.push(c);
                return c;
            },
            pageInfo: async () => ({ url: 'https://trailhead.salesforce.com/', title: 'Course' }),
        });
        projector.register({ session: 'course-a', kind: 'browser', port: 9001, pid: 111, targetId: 'A' });
        projector.register({ session: 'course-b', kind: 'browser', port: 9002, pid: 222, targetId: 'B' });

        const got = [];
        const stopA1 = await projector.watch('course-a', ev => got.push(ev));
        const stopA2 = await projector.watch('course-a', () => {});
        check('watching starts the screencast', calls.includes('course-a:Page.startScreencast'), calls.join(' '));
        // 2026-10-17: the window stayed black on "Connecting..." over a login page. With
        // everyNthFrame 6 a page that does not move never sends a frame; the viewer must
        // get the page as it is right away, not wait for a repaint that never comes.
        check('a still page is shown at once (the first frame is a screenshot)', got[0] && got[0].kind === 'frame' && got[0].data === 'STILL' && got[0].w === 1280 && got[0].h === 800, JSON.stringify(got[0]));
        check('two viewers share ONE connection', fakes.filter(f => f.entry.session === 'course-a').length === 1);
        fakes[0].emit('Page.screencastFrame', { data: 'AAAA', sessionId: 7, metadata: { deviceWidth: 1280, deviceHeight: 800 } });
        check('a frame reaches the viewer', got.some(e => e.kind === 'frame' && e.data === 'AAAA' && e.w === 1280));
        check('each frame is acknowledged (or Chrome stops sending)', calls.includes('course-a:Page.screencastFrameAck'));
        stopA1();
        check('one viewer leaving keeps the stream for the other', !calls.includes('course-a:Page.stopScreencast'));
        stopA2();
        await new Promise(r => setImmediate(r));
        check('the last viewer leaving stops the screencast', calls.includes('course-a:Page.stopScreencast'));
        check('... and closes the connection', fakes[0].closed);
        check('no stream is left running', projector.streams().length === 0, JSON.stringify(projector.streams()));

        const none = [];
        const stopN = await projector.watch('tsrct', ev => none.push(ev));
        stopN();
        check('a session with nothing to project says so', none.some(e => e.kind === 'none'), JSON.stringify(none));

        const ank = [];
        await projector.watch('secretco', ev => ank.push(ev));
        check('watching an SecretCo session is refused', ank.some(e => e.kind === 'refused'));

        // A page that navigates INTO SecretCo mid-stream stops streaming.
        projector.configure({ pageInfo: async () => ({ url: 'https://secretco-sandbox.lightning.force.com/', title: '' }) });
        const nav = [];
        const before = calls.length;
        await projector.watch('course-b', ev => nav.push(ev));
        check('a page already on SecretCo is never streamed', !calls.slice(before).includes('course-b:Page.startScreencast') && nav.some(e => e.kind === 'refused'), calls.slice(before).join(' '));
        projector.configure({ pageInfo: async () => ({ url: 'https://example.com/', title: 'ok' }) });
        const nav2 = [];
        const stopB = await projector.watch('course-b', ev => nav2.push(ev));
        const fb = fakes[fakes.length - 1];
        fb.emit('Page.frameNavigated', { frame: { url: 'https://secretco.example.com/home' } });
        await new Promise(r => setImmediate(r));
        check('navigating into SecretCo mid-stream stops it', nav2.some(e => e.kind === 'refused') && fb.closed);
        stopB();

        // ── input goes only to a session being watched ──
        const inp = await projector.input('course-a', { kind: 'mouse', type: 'down', x: 10, y: 10 });
        check('input to a session nobody is watching is refused', inp && !inp.ok);

        // ── key mapping ──
        const k = projector.keyParams({ key: 'Enter' });
        check('Enter maps to a real key event', k.windowsVirtualKeyCode === 13 && k.key === 'Enter');
        const a = projector.keyParams({ key: 'a', ctrl: true });
        check('Ctrl+A carries the modifier and the select-all command', a.modifiers === 2 && (a.commands || []).includes('selectAll'));
        const t = projector.keyParams({ key: 'x' });
        check('a plain letter carries its text', t.text === 'x');

        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }

    // ── the CLI refuses SecretCo before it navigates ──
    let cli = null;
    try { cli = require('./projector'); } catch (e) { check('scripts/projector.js loads as a module', false, e.message); }
    if (cli) {
        check('the CLI refuses an SecretCo url', cli.urlProblem('https://secretco-sandbox.my.salesforce.com') !== null);
        check('the CLI accepts a normal url', cli.urlProblem('https://trailhead.salesforce.com/content/learn') === null);
        check('the CLI refuses a file: url', cli.urlProblem('file:///etc/passwd') !== null);
        check('the CLI knows open/look/click/type/drag/scroll/read', ['open', 'look', 'click', 'type', 'drag', 'scroll', 'read', 'key', 'start', 'stop'].every(c => cli.COMMANDS.includes(c)), (cli.COMMANDS || []).join(','));
        // 2026-10-12, the Theme Importer step: upload a ZIP, fetch it first.
        check('the CLI can upload and download', ['upload', 'download'].every(c => cli.COMMANDS.includes(c)));
        // What it picks (visible, innermost, every frame) is exercised for real by
        // scripts/check-projector-live.js, which starts a browser and so is not in npm run check.
        check('a live check of picking and uploading exists', fs.existsSync(path.join(ROOT, 'scripts/check-projector-live.js')));
    }
    {
        const hands = read('lib/teslaHands.js');
        check('hands may upload/download without a permission card', /projOps = \[[^\]]*'upload'[^\]]*'download'/.test(hands));
        check('the browser recipe teaches upload', /upload/.test(read('lib/actions.js').slice(read('lib/actions.js').indexOf('browser_task: (task)'), read('lib/actions.js').indexOf('browser_task: (task)') + 4000)));
        check('the worker sheet teaches upload', /\$P upload/.test(read('tesla-skills/pc-browser/SKILL.md')));
    }

    // ── the frontend ──
    const desk = read('src/js/desktop.js');
    const usageBtn = desk.indexOf('data-panel="usage"');
    const spacer = desk.indexOf('pc-rail-spacer', usageBtn);
    const projBtn = desk.indexOf('projectorOpen()', usageBtn);
    check('the rail button sits right below Usage ($)', usageBtn > 0 && projBtn > usageBtn && projBtn < spacer);
    check('the rail button is not a panel (one tap opens the window)', !/data-panel="projector"/.test(desk));
    const runners = read('src/js/desktop-runners.js');
    check('runner drag/resize are shared on window', /window\.runnerSetupDrag = runnerSetupDrag/.test(runners) && /window\.runnerSetupResize = runnerSetupResize/.test(runners));

    let src = '';
    try { src = read('src/js/projector.js'); } catch { check('src/js/projector.js exists', false); }
    if (src) {
        const win = { addEventListener() {} };
        const ctx = vm.createContext({ window: win, document: { addEventListener() {} }, console });
        try { vm.runInContext(src, ctx); } catch (e) { check('projector.js runs', false, e.message); }
        for (const fn of ['projectorOpen', 'projectorClose', 'projectorPick', 'projectorRefresh', 'projectorToPage']) {
            check(`window.${fn} is exported`, typeof win[fn] === 'function');
        }
        if (typeof win.projectorToPage === 'function') {
            // 1000x500 box showing a 1280x800 page: contained to 800x500, 100px bars left and right.
            const rect = { left: 0, top: 0, width: 1000, height: 500 };
            const p = win.projectorToPage(100 + 400, 250, rect, 1280, 800);
            check('a click in the middle lands in the middle of the page', p && Math.round(p.x) === 640 && Math.round(p.y) === 400, JSON.stringify(p));
            check('a click on the black bar lands nowhere', win.projectorToPage(50, 250, rect, 1280, 800) === null);
        }
    }
    const html = read('src/index.html');
    check('index.html loads projector.js', /<script src="\/src\/js\/projector\.js"><\/script>/.test(html));
    check('sw.js caches projector.js', /'\/src\/js\/projector\.js'/.test(read('sw.js')));

    // ── the server ──
    const server = require('./serverSource')();
    check('server has GET /api/projector/sources', server.includes("pathname === '/api/projector/sources'"));
    check('server has the SSE stream', server.includes("pathname === '/api/projector/stream'"));
    check('server has POST /api/projector/input', server.includes("pathname === '/api/projector/input'"));
    check('the stream is in the SSE self-auth list', /isSSERequest[\s\S]{0,400}\/api\/projector\/stream/.test(server));
    const si = server.indexOf("pathname === '/api/projector/stream' && req.method");
    check('the stream validates ?token= itself', si > 0 && /isAuthorized\(qToken, req\)/.test(server.slice(si, si + 600)));

    // ── Tesla knows it (2026-10-12, his words: "tesla tiene que saber usar esta
    // habilidad si lo necesito, me lo tiene que preguntar") ──
    {
        const restrictedGuard = require('../lib/dispatcher/restrictedGuard');
        const actions = require('../lib/actions');
        const started = [];
        actions.configure({ teslaHands: { start: (o) => { started.push(o); return { key: 'k', model: 'Sonnet', changes: !!o.changes }; } } });
        check('Tesla has a browser_task action', actions.manifest().some(x => x.name === 'browser_task'));
        let ask = null, go = null;
        try { ask = await actions.run('browser_task', { task: 'hacer la leccion 1 del curso Theme Developer' }, {}); } catch (e) { check('browser_task runs', false, e.message); }
        check('browser_task asks him first', ask && ask.needsConfirm);
        check('the question says: separate browser, his mouse stays free', ask && /navegador aparte/i.test(ask.says || '') && /mouse/i.test(ask.says || ''), ask && ask.says);
        check('nothing runs before his yes', !started.length);
        try { go = await actions.run('browser_task', { task: 'hacer la leccion 1 del curso Theme Developer' }, { confirmed: true }); } catch (e) { check('browser_task runs once confirmed', false, e.message); }
        const s = started[0];
        check('after his yes, hands gets the browser recipe', s && s.recipe === 'browser_task' && s.changes === true);
        check('the recipe drives scripts/projector.js and never his mouse (desk.js)', s && /scripts\/projector\.js start/.test(s.task) && !/desk\.js/.test(s.task));
        check('the recipe stops for his password', s && /contrase/i.test(s.task));
        check('the recipe passes the hands SecretCo guard', s && !restrictedGuard.mentionsRestricted(s.task));
        check('she tells him to watch it in the projector', go && go.value && /proyector/i.test(go.value.plain || ''));
        check('what she says is said as is (no second model call)', actions.speaksPlain('browser_task'));
    }
    const brainSrc = read('lib/haikuBrain.js');
    check('the brain knows when to pick browser_task', /browser_task/.test(brainSrc) && /navegador aparte/.test(brainSrc));
    const handsSrc = read('lib/teslaHands.js');
    check('hands may run the projector CLI without a permission card', /scripts', 'projector\.js'/.test(handsSrc));
    check('a stopped browser_task is answered like do_on_pc', /\['do_on_pc', 'browser_task'\]\.includes\(job\.recipe\)/.test(handsSrc));
    check('the hands worker has a skill sheet for the separate browser', fs.existsSync(path.join(ROOT, 'tesla-skills/pc-browser/SKILL.md')));
    const ui = require('../lib/uiActions');
    check('show_projector is a page button she can press', ui.CATALOG.some(a => a.name === 'show_projector'));
    check('the page allowlist presses it', /show_projector: /.test(read('src/js/ui-actions.js')));

    // ── on a phone (2026-10-14, "agregar al modo mobile el projector en las tools") ──
    // Proven in a real phone-sized browser once (tap = one click at the right page
    // point, swipe = scroll, the type bar types); these keep the pieces wired.
    const indexHtml = read('src/index.html');
    const tools = indexHtml.slice(indexHtml.indexOf('id="quick-tools"'), indexHtml.indexOf('</div>', indexHtml.indexOf('id="quick-tools"')));
    check('the phone TOOLS grid has the Projector', /onclick="projectorOpen\(\)"/.test(tools));
    const pj = read('src/js/projector.js');
    check('a phone gets the full-screen layout', /projector-phone/.test(pj) && /\.projector-phone\s*\{[\s\S]{0,200}position: fixed/.test(read('src/css/main.css')));
    check('a tap is a click and a swipe scrolls', /'touchend'/.test(pj) && /'touchmove'/.test(pj));
    check('a phone can type (its keyboard never opens on a picture)', /projector-typebar/.test(pj) && /window\.projectorSendText = projectorSendText/.test(pj) && /window\.projectorKey = projectorKey/.test(pj));

    if (failed) { console.error(`[check-projector] ${failed} failed, ${passed} passed`); process.exit(1); }
    console.log(`[check-projector] OK -- ${passed} checks`);
})();
