#!/usr/bin/env node
// scripts/check-desk.js — Tesla's eyes on the PC (lib/desk.js, 2026-10-10).
//
// What it must never do: hand a screenshot to a model when the screen may show
// SecretCo. Three layers, each tested on its own, with no real screen involved:
// TSRCT served an SecretCo pane recently, a window title, and the OCR of each
// monitor (where a clean monitor is still served next to a refused one).
'use strict';
process.env.WIN_HOME = '/mnt/c/Users/you';   // the Windows side these checks describe
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-desk-'));
process.env.DESK_SEEN_FILE = path.join(tmp, 'seen');
process.env.DESK_STATE_FILE = path.join(tmp, 'state.json');
process.env.DESK_LOG_DIR = path.join(tmp, 'log');
const desk = require(path.join(ROOT, 'lib/desk.js'));

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log('  [x] ' + label); } };
// Timed checks hand their finish here; the final count waits for all of them.
const timedChecks = [];
const refuses = (fn) => { try { fn(); return false; } catch (e) { return e.code === 'DESK_REFUSED'; } };

// ── parsing look.ps1's records ──
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const raw = desk._parse([
    'T|chrome: Inbox - Gmail',
    'T|WindowsTerminal: tsrct | main',
    `S|1|0|0|2560|1440|C:\\Users\\you\\PROJECTS\\TSRCT\\.tsrct\\desk\\9-1.staged.png|${b64('git status\nhttps://secretcolaw.lightning.force.com/lightning/r/Account')}`,
    `S|2|-1920|368|1920|1080|C:\\Users\\you\\PROJECTS\\TSRCT\\.tsrct\\desk\\9-2.staged.png|${b64('Buscar 12:32')}`,
].join('\r\n'));
ok(raw.titles.length === 2 && raw.shots.length === 2, 'both kinds of record are read');
ok(raw.shots[1].x === -1920 && raw.shots[1].staged === '/mnt/c/Users/you/PROJECTS/TSRCT/.tsrct/desk/9-2.staged.png', 'a monitor left of the main one keeps its negative x, and the path comes back as a WSL path');
ok(/lightning\.force\.com/.test(raw.shots[0].text), 'the OCR text is decoded for the check');

// ── layer 3: per monitor, and only WORK in SecretCo counts ──
const v = desk._judge(raw);
ok(v.shots.length === 1 && v.shots[0].screen === 2, 'the monitor showing their org is dropped and the clean one is kept');
ok(v.refused.length === 1 && v.refused[0].screen === 1, 'and the dropped one is named');
ok(!('text' in v.refused[0]) && !JSON.stringify(v.refused).includes('lightning'), 'and nothing it read is passed on');
ok(refuses(() => desk._judge({ titles: [], shots: [raw.shots[0]] })), 'with only an SecretCo monitor there is nothing to show');
// Being IN it (OCR misreads included).
for (const work of [
    'secretco.my.salesforce.com/lightning/setup',
    'https://secretc0--uat.sandbox.my.salesforce.com/001',
    'SecretC0Law.lightning.force.com',
    'user@LAPTOP:~/PROJECTS/SecretCoSandbox$ git status',
    'PS C:\\Users\\you\\PROJECTS\\SecretCoSandbox\\force-app>',
]) ok(desk.screenSaysRestricted(work), `working in SecretCo is refused: "${work}"`);
// Only NAMING them - his rule: "una carpeta o algun mensaje que los mencione no deberia detenerlo".
for (const mention of [
    'Re: SecretCo invoice for September',
    'SecretCoSandbox      10/09/2026 18:02    File folder',
    'The SecretCo contract: AI for SecretCo must run only through AWS Bedrock',
    '#secretco-delivery  Jo: the SecretCo close is done',
    'Threstrictedg you', 'rrestrictedg', 'Buscar',
]) ok(!desk.screenSaysRestricted(mention), `a mention is looked at: "${mention}"`);
process.env.DESK_RESTRICTED_HOSTS = '';

// ── layer 2: a window that IS SecretCo work ──
for (const t of [
    'Code: force-app - SecretCoSandbox - Visual Studio Code',
    'WindowsTerminal: user@LAPTOP: ~/PROJECTS/SecretCoSandbox',
    'explorer: SecretCoSandbox',
    'WindowsTerminal: secretco',
    'chrome: SecretCo | Salesforce - Google Chrome',
]) ok(desk.titleIsRestrictedWork(t), `an SecretCo work window closes the eyes: "${t}"`);
for (const t of [
    'chrome: Re: SecretCo invoice - you@example.com - Gmail - Google Chrome',
    'slack: secretco-delivery (Channel) - Acme Cloud Co - Slack',
    'WindowsTerminal: tsrct | talking about the SecretCo contract',
    'explorer: PROJECTS',
]) ok(!desk.titleIsRestrictedWork(t), `a window that only names them does not: "${t}"`);
ok(refuses(() => desk._judge({ titles: ['Code: force-app - SecretCoSandbox - Visual Studio Code'], shots: [raw.shots[1]] })), 'an SecretCo work window closes every monitor');

// ── layer 1: TSRCT showed the secretco pane ──
ok(!desk.restrictedPaneRecently(), 'nothing marked yet');
desk.sawRestrictedPane();
ok(desk.restrictedPaneRecently(), 'once TSRCT serves an SecretCo pane the eyes close');
ok(refuses(() => desk._judge({ titles: [], shots: [raw.shots[1]] })), 'even for a clean monitor');
ok(!desk.restrictedPaneRecently(Date.now() + 3 * 60 * 1000), 'and open again a few minutes later');
// ── the hands: planAct decides, act.ps1 does ──
{
    const T = Date.now() + 10 * 60 * 1000;   // past the SecretCo-pane mark set above
    const looks = { 1: { at: T - 5000, x: 0, y: 0, w: 2560, h: 1600 }, 2: { at: T - 5000, x: -1920, y: 368, w: 1920, h: 1080 } };
    const st = { lastLookAt: T - 5000, looks, lastLookRefused: [], cursor: { x: 100, y: 100, at: T - 5000 } };
    const plan = (s, r) => desk._planAct(s, r, T);
    const refusesPlan = (s, r) => refuses(() => plan(s, r));
    const a = plan(st, { op: 'click', screen: 2, x: 10, y: 20 });
    ok(a.join(' ').includes('-X -1910 -Y 388'), 'a click on screen 2 lands at that screen\'s own offset (left of and below the main one)');
    ok(a.includes('-ExpectX') && a[a.indexOf('-ExpectX') + 1] === '100', 'every act tells act.ps1 where the cursor must still be');
    const deny = a[a.indexOf('-Deny') + 1];
    ok(deny.startsWith('(?i)') && new RegExp(deny.slice(4), 'i').test('Code: x - SecretCoSandbox - Visual Studio Code'), 'and the SecretCo window pattern goes with it, the same one the titles use');
    ok(!new RegExp(deny.slice(4), 'i').test('chrome: Re: SecretCo invoice - Gmail - Google Chrome'), 'which lets a mail that only names them through');
    ok(refusesPlan({ ...st, lastLookAt: T - 90000 }, { op: 'click', screen: 1, x: 1, y: 1 }), 'no act without a look in the last minute');
    ok(refusesPlan({ ...st, humanAt: T - 30000 }, { op: 'key', keys: 'enter' }), 'he took the mouse 30 s ago: nothing is done');
    ok(refusesPlan({ ...st, humanAt: T - 30000, lastLookAt: T - 1000 }, { op: 'key', keys: 'enter' }), 'and a new look does not lift that stop');
    ok(!refusesPlan({ ...st, humanAt: T - 4 * 60 * 1000 }, { op: 'key', keys: 'enter' }), 'a few minutes later she may go on');
    const oneRefused = { ...st, looks: { 2: looks[2] }, lastLookRefused: [1] };
    ok(refusesPlan(oneRefused, { op: 'click', screen: 1, x: 5, y: 5 }), 'no click on a screen the latest look refused');
    ok(refusesPlan(oneRefused, { op: 'type', text: 'hola' }), 'no typing while a refused screen may have the focus');
    ok(!refusesPlan({ ...oneRefused, focusCleanAt: T - 1000 }, { op: 'type', text: 'hola' }), 'typing is fine after a click on the clean screen');
    let threwOutside = false;
    try { plan(st, { op: 'click', screen: 2, x: 1920, y: 5 }); } catch (e) { threwOutside = e.code !== 'DESK_REFUSED'; }
    ok(threwOutside, 'a click outside the screen is an error, not a guess');
    // drag (2026-10-11, the App Builder only takes a field by drag-and-drop)
    const dg = plan(st, { op: 'drag', screen: 2, x: 10, y: 20, toX: 110, toY: 220 });
    ok(dg.join(' ').includes('-X -1910 -Y 388') && dg.join(' ').includes('-X2 -1810 -Y2 588'), 'a drag sends both ends at that screen\'s offset');
    ok(dg.includes('-ExpectX') && dg.includes('-Deny'), 'and carries the same mouse and SecretCo checks as a click');
    let dragOff = false;
    try { plan(st, { op: 'drag', screen: 2, x: 10, y: 20, toX: 5000, toY: 5 }); } catch (e) { dragOff = e.code !== 'DESK_REFUSED'; }
    ok(dragOff, 'a drop point off that screen is an error');
    ok(refusesPlan(oneRefused, { op: 'drag', screen: 1, x: 5, y: 5, toX: 9, toY: 9 }), 'no drag on a screen the latest look refused');
    ok(refuses(() => plan(st, { op: 'type', text: 'x' })) === false && plan(st, { op: 'type', text: 'á ñ' }).includes(Buffer.from('á ñ').toString('base64')), 'text travels base64, accents intact');
    let badKeys = false;
    try { plan(st, { op: 'key', keys: 'ctrl+s; rm -rf' }); } catch { badKeys = true; }
    ok(badKeys, 'keys are a short combination of names, nothing else');
}

// ── an open window is brought forward in ONE step (review 2026-10-10) ──
// "abrir spotify": the worker saw "Spotify already has an open window ... behind
// TSRCT" and, with no way to raise a window, went Start menu -> type -> Enter:
// 3 acts + 3 looks, 22 s of the 35 s task.
{
    const T = Date.now() + 10 * 60 * 1000;
    const st = { lastLookAt: T - 5000, looks: { 1: { at: T - 5000, x: 0, y: 0, w: 2560, h: 1600 } }, lastLookRefused: [], cursor: { x: 1, y: 1, at: T - 5000 } };
    let f = null;
    try { f = desk._planAct(st, { op: 'focus', window: 'Spotify' }, T); } catch (e) { f = e; }
    ok(Array.isArray(f) && f[f.indexOf('-Op') + 1] === 'focus' && f.includes(Buffer.from('Spotify').toString('base64')), 'focus raises a window by name in one act');
    ok(Array.isArray(f) && f.includes('-Deny'), 'and the window it raises is checked against the SecretCo pattern first');
    ok(refuses(() => desk._planAct({ ...st, humanAt: T - 1000 }, { op: 'focus', window: 'Spotify' }, T)), 'not while he has the mouse');
    let empty = false;
    try { desk._planAct(st, { op: 'focus', window: '' }, T); } catch { empty = true; }
    ok(empty, 'focus needs a name');
    const act = fs.readFileSync(path.join(ROOT, 'scripts/desk/act.ps1'), 'utf8');
    ok(/'focus'/.test(act) && /ShowWindow/.test(act) && /SetForegroundWindow/.test(act), 'act.ps1 restores a minimized window and brings it forward');
    const recipes = fs.readFileSync(path.join(ROOT, 'lib/actions.js'), 'utf8');
    ok(/focus --window/.test(recipes) && /YA esta abierto/.test(recipes), 'the do_on_pc recipe says: an app already open is raised with focus, not searched for');
    const cli = fs.readFileSync(path.join(ROOT, 'scripts/desk.js'), 'utf8');
    ok(/'focus'/.test(cli), 'the desk command accepts focus');
    const hands = fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8');
    ok(/'look', 'click', 'double', 'right', 'move', 'scroll', 'type', 'key', 'focus'/.test(hands), 'and hands may run it without a permission card');
    ok(/HANDS_POLL_MS \|\| 1000/.test(hands), 'her answer is picked up within a second, not three');
}

// ── the PC without the mouse (lib/pcDirect.js, 2026-10-10) ──
// "buscalo y abrilo, o ponelo en tal lugar" - and the rule for everything:
// whatever has a faster path than the physical mouse takes it.
{
    const pc = require(path.join(ROOT, 'lib/pcDirect.js'));
    const at = (m) => new Date(Date.now() - m * 60000).toISOString();
    const tu = (name, input, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name, input }] } });
    const fake = [
        tu('Write', { file_path: '/x/proj/report.pdf' }, at(30)),
        tu('Read', { file_path: '/x/proj/notes.md' }, at(20)),
        tu('Edit', { file_path: 'src/app.js' }, at(10)),
        tu('Write', { file_path: '/x/proj/report.pdf' }, at(2)),
    ].join('\n');
    const got = pc._filesFromTranscript(fake, '/x/proj');
    ok(got.length === 2 && got[0].path === '/x/proj/report.pdf' && got[1].path === '/x/proj/src/app.js', 'the files a session wrote come from its own tool calls, newest first, relative paths made whole');
    ok(!got.some(f => /notes\.md/.test(f.path)), 'a file it only READ is not one it made');

    // A real transcript on disk, through sessionFiles, with an SecretCo path and a vanished file in it.
    const d = path.join(tmp, 'proj');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'report.pdf'), 'pdf');
    const tfile = path.join(tmp, 't.jsonl');
    fs.writeFileSync(tfile, [tu('Write', { file_path: path.join(d, 'report.pdf') }, at(3)), tu('Write', { file_path: '/x/SecretCoSandbox/ledger.csv' }, at(2)), tu('Write', { file_path: path.join(d, 'gone.txt') }, at(1))].join('\n'));
    pc.configure({ transcriptFor: () => ({ file: tfile, cwd: d }) });
    const files = pc.sessionFiles('harbor');
    ok(files.length === 1 && files[0].path === path.join(d, 'report.pdf'), 'sessionFiles keeps what exists and drops the restricted project\'s paths');
    ok(/ARCHIVOS QUE harbor ESCRIBIO/.test(pc.filesLine('harbor')) && pc.filesLine('harbor').includes('report.pdf'), 'and the brain gets them as one line it can act on');
    let refusedSession = false;
    try { pc.sessionFiles('secretco'); } catch (e) { refusedSession = e.code === 'RESTRICTED_PROJECT'; }
    ok(refusedSession, 'the secretco session is never read');

    ok(pc._toWindows('/mnt/c/Users/you/Downloads/a.pdf') === 'C:\\Users\\you\\Downloads\\a.pdf', 'a /mnt/c path opens as C:\\...');
    ok(/^\\\\wsl\.localhost\\[^\\]+\\home\\user\\a\.md$/.test(pc._toWindows('/home/user/a.md')), 'a Linux-only path opens through \\\\wsl.localhost');
    ok(pc.resolveFolder('descargas') === '/mnt/c/Users/you/Downloads' && pc.resolveFolder('la carpeta de descargas') === '/mnt/c/Users/you/Downloads' && pc.resolveFolder('escritorio') === '/mnt/c/Users/you/Desktop', 'his words for the usual folders');

    // Moving: never over another file, and never into or out of the restricted project.
    const to = path.join(tmp, 'dest');
    fs.mkdirSync(to);
    const moved = pc.moveFile({ path: path.join(d, 'report.pdf'), to });
    ok(moved.to === path.join(to, 'report.pdf') && fs.existsSync(moved.to) && !fs.existsSync(path.join(d, 'report.pdf')), 'move_file moves it');
    fs.writeFileSync(path.join(d, 'report.pdf'), 'second');
    let noOverwrite = false;
    try { pc.moveFile({ path: path.join(d, 'report.pdf'), to }); } catch (e) { noOverwrite = /no lo piso/.test(e.message); }
    ok(noOverwrite && fs.readFileSync(path.join(to, 'report.pdf'), 'utf8') === 'pdf', 'and never steps on a file already there');
    let restrictedMove = false;
    try { pc.moveFile({ path: path.join(d, 'report.pdf'), to: '/mnt/c/Users/you/PROJECTS/SecretCoSandbox' }); } catch (e) { restrictedMove = e.code === 'RESTRICTED_PROJECT'; }
    ok(restrictedMove, 'nothing is moved into the restricted project');
    pc.openPath({ path: '/mnt/c/Users/you/PROJECTS/SecretCoSandbox/x.pdf' }).then(() => ok(false, 'opened a restricted path'), (e) => ok(e.code === 'RESTRICTED_PROJECT', 'nothing in the restricted project is opened'));
    pc.openUrl('javascript:alert(1)').then(() => ok(false, 'opened a non-web url'), () => ok(true, 'only https/http links open'));

    // The actions: opening asks nothing, moving asks once.
    const actions = require(path.join(ROOT, 'lib/actions.js'));
    actions.configure({ pcDirect: { openPath: async (o) => ({ opened: o.path, reveal: !!o.reveal }), openApp: async (n) => ({ app: n, how: 'focused' }), moveFile: () => { throw new Error('moved without his yes'); }, sessionFiles: () => [] } });
    Promise.all([
        actions.run('open_file', { path: '/mnt/c/a/report.pdf' }, {}),
        actions.run('open_app', { name: 'spotify' }, {}),
        actions.run('move_file', { path: '/mnt/c/a/report.pdf', to: 'descargas' }, {}),
    ]).then(([of, oa, mv]) => {
        ok(of && !of.needsConfirm && (of.value && of.value.plain) === 'Abierto.', 'open_file runs at once and says one word');
        ok(oa && !oa.needsConfirm && (oa.value && oa.value.plain) === 'Listo.', 'open_app runs at once; an open app is just brought forward');
        ok(mv && mv.needsConfirm && /muevo report\.pdf a descargas/.test(mv.says), 'move_file asks first, in five words');
    }).catch(e => { fail++; console.log('  [x] direct actions threw: ' + e.message); });

    const brainSrc = fs.readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
    ok(/PRIMERO LO DIRECTO, EL MOUSE AL FINAL/.test(brainSrc) && /do_on_pc \(el mouse\) SOLO para lo que pasa ADENTRO/.test(brainSrc), 'the brain is told: the direct path first, the mouse last');
    const recipeSrc = fs.readFileSync(path.join(ROOT, 'lib/actions.js'), 'utf8');
    ok(/REGLA DE ORO: el camino mas directo primero, el mouse al final/.test(recipeSrc), 'and so is the worker');
    const talkSrc = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    ok(/deps\.sessionFiles\(session\)/.test(talkSrc), 'the watched session\'s new files ride along with its context');
}

// ── Tesla review #10 (2026-10-10 16:00-16:40Z, 25 turns) ──
{
    // 1. The worst: hands sat on a permission card for 5 minutes while she said
    //    "Opus sigue trabajando ... no hay error a la vista" three times.
    process.env.HANDS_POLL_MS = '15';
    process.env.HANDS_PERMISSION_GRACE_MS = '0';   // the grace period is for real redraws, not this fake
    const hands = require(path.join(ROOT, 'lib/teslaHands.js'));
    const offered = [];
    const said = [];
    let polls = 0;
    hands.configure({
        tmux: () => '', spawn: async () => ({ ok: true }), paste: () => ({ success: true }),
        readAnswer: (e) => { e.file = e.file || __filename; polls++; return polls > 6 ? 'RESULTADO {"ok": true, "dijo": "Listo.", "como": "x"}' : null; },
        permission: (s) => (s === 'hands' && polls >= 2 && polls <= 4 ? 'Bash: cd /tmp/farm' : ''),
        offer: (name, args) => { offered.push({ name, args }); return { ok: true }; },
        say: (l) => said.push(l), denyRules: () => [], dataDir: tmp, projectsRoot: tmp, logFile: '',
    });
    const job = hands.start({ task: 'investigar farmproweb.vercel.app', level: 'medium' });
    const waitingSeen = [];
    const toldBrain = [];
    const spy = setInterval(() => { const l = hands.list().find(j => j.key === job.key); if (l) waitingSeen.push(l.state + '|' + l.step); toldBrain.push(hands.describe()); }, 10);
    // Judged when the fake job has FINISHED (its 7th poll answers), not at a fixed
    // 400 ms: on a loaded machine the poller had not reached the permission by then
    // and all three checks below failed together (seen 2026-10-16 in a full run).
    const t0 = Date.now();
    timedChecks.push(new Promise(done => { const until = setInterval(() => {
        if (polls <= 6 && Date.now() - t0 < 5000) return;
        clearInterval(until);
        clearInterval(spy);
        ok(offered.length === 1 && offered[0].name === 'approve_session_permission' && offered[0].args.session === 'hands', 'a permission hands is waiting on is OFFERED to him once, so his "si" approves it');
        ok(waitingSeen.some(s => /^waiting\|.*permiso.*cd \/tmp\/farm/i.test(s)), 'while it waits, the background status says it is waiting for his permission and for what, not "trabajando"');
        ok(toldBrain.some(d => /ESPERA SU PERMISO para Bash: cd \/tmp\/farm/.test(d) && /approve_session_permission/.test(d) && /no digas que sigue trabajando/.test(d)), 'and the brain is told it is stopped on his permission, and how to approve it');
        try { hands.stopWorker('test'); } catch { /* fake */ }
        done();
    }, 20); }));

    // 2. Too long. Every PC action was re-told by a second model ("haiku-report",
    //    9 times): "Le pase el pedido a Sonnet, que mira la pantalla y no toca nada.
    //    Te digo en un momento..." - 9.3 s of audio for "voy".
    const talkSrc = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    ok(/actions\.speaksPlain\(acted\.did\)/.test(talkSrc), 'a PC action says its own short line; no second model rewrites it');
    const actions = require(path.join(ROOT, 'lib/actions.js'));
    for (const n of ['open_app', 'open_file', 'move_file', 'session_files', 'look_at_screen', 'do_on_pc', 'look_into', 'workaround'])
        ok(actions.speaksPlain && actions.speaksPlain(n), `${n} speaks its own line`);
    ok(actions.speaksPlain && !actions.speaksPlain('today_tasks'), 'a list (today\'s tasks) is still told by the brain');
    const fakeStart = { start: () => ({ key: 'k', model: 'Sonnet', changes: false }) };
    actions.configure({ teslaHands: fakeStart, pcDirect: { openApp: async (n) => ({ app: n, how: 'focused' }) } });
    Promise.all([
        actions.run('open_app', { name: 'Spotify' }, {}),
        actions.run('look_at_screen', { question: 'que dice' }, {}),
        actions.run('look_into', { task: 'investigar la pagina' }, {}),
        actions.run('do_on_pc', { task: 'poner eminem' }, { confirmed: true }),
    ]).then((rs) => {
        const lines = rs.map(r => (r.value && r.value.plain) || '');
        for (const l of lines) {
            ok(l.split(/\s+/).length <= 6, `said in a few words: "${l}"`);
            ok(!/sonnet|opus|haiku|hands|boton|accion|segundo plano/i.test(l), `no machinery in what she says: "${l}"`);
        }
    }).catch(e => { fail++; console.log('  [x] short lines threw: ' + e.message); });
    const recipes = fs.readFileSync(path.join(ROOT, 'lib/actions.js'), 'utf8');
    ok(/"dijo": UNA frase/.test(recipes) && !/"dijo": la respuesta en dos frases/.test(recipes), 'the PC worker reports in ONE short sentence');
    const handsSrc = fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8');
    ok(!/lo hizo por otro camino/.test(handsSrc), 'and is not introduced with "Sonnet lo hizo por otro camino:"');
    const brain = fs.readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
    ok(/BREVE CON LA PC/.test(brain), 'the brain is told: the result in a few words, never how, never which model');

    // 3+4. "abrir slack y fijarse cual fue el ultimo mensaje de sam" ran only the
    //    open half; "No lo pude ver: WhatsApp tiene abierto el chat de mi amor ...
    //    yo solo puedo mirar" cost another yes.
    ok(/brings the app forward|focus --window/.test(recipes.slice(recipes.indexOf('look_at_screen: (question'), recipes.indexOf('do_on_pc: (task'))), 'look_at_screen may bring the app forward first');
    ok(/NAVEGAR para leer/.test(recipes) && /NUNCA escribas, mandes, borres/.test(recipes), 'and may navigate to read (open a chat, scroll) but never type, send or delete');
    ok(/"abri X y fijate/.test(brain), 'the brain does "open X and look at Y" as ONE look');

    // 5. "pone musica de eminem" -> offered in prose with no ACCION -> two yeses.
    ok(/NUNCA OFREZCAS EN PALABRAS/.test(brain), 'the brain never offers in words what an action does');
    const t = require(path.join(ROOT, 'lib/talk.js'));
    ok(t._asksToAct && t._asksToAct.test('Puedo hacerlo con la PC, con el mouse y el teclado, buscando a Eminem en Spotify y dandole play.'), 'an offer without a question mark is caught too');

    // 6. "probablemente necesite que sonet explore" -> Opus.
    ok(/SI NOMBRA UN MODELO/.test(brain), 'a model he names sets the level');
}

// ── Tesla review #11 (2026-10-10 16:51-17:29Z) ──
{
    const actions = require(path.join(ROOT, 'lib/actions.js'));
    const handsSrc = fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8');
    const recipes = fs.readFileSync(path.join(ROOT, 'lib/actions.js'), 'utf8');
    // 1. Her own desk commands asked for permission: the worker wrote
    //    "cd /mnt/c/.../TSRCT && node scripts/desk.js key --keys ctrl+a &".
    ok(/'Bash\(cd:\*\)'/.test(handsSrc), 'a cd in front of the desk command does not stop hands on a permission card');
    ok(/TAL CUAL: sin cd, sin && y sin &/.test(recipes), 'and the worker is told to run the desk command exactly as written');
    //    "¿Aprobar el permiso que hands pide en pantalla (╌╌╌╌╌╌...)?" five times.
    const fakeScreen = ['some output', '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌', ' Bash command', '   node scripts/desk.js key --keys ctrl+a', '   Press a key', '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');
    actions.configure({ tmux: { captureSession: () => fakeScreen, listSessions: () => [] }, permissionDesk: null });
    const dlg = actions._permissionDialog ? actions._permissionDialog('hands') : null;
    ok(dlg && /desk\.js key/.test(dlg.what) && !/╌/.test(dlg.what), `a permission dialog is described by its command, not its border: "${dlg && dlg.what}"`);
    //    Re-offered every time the text changed.
    ok(/job\.offeredAt/.test(handsSrc) && /OFFER_AGAIN_MS/.test(handsSrc), 'one question per stop, not one per screen redraw');

    // 2. "pone algo, sorprendeme" -> "¿Pongo Happy?" -> "tampoco tan generico" -> cancelled ->
    //    "no me preguntes ... ponelo directamente".
    const started = [];
    actions.configure({ teslaHands: { start: (o) => { started.push(o); return { key: 'k', model: 'Haiku', changes: true }; } } });
    Promise.all([
        actions.run('do_on_pc', { task: 'En Spotify, buscar Hey Ya de OutKast y darle play', harmless: 'si' }, {}),
        actions.run('do_on_pc', { task: 'Mandarle un mail a Paul con el contrato', harmless: 'si' }, {}),
        actions.run('do_on_pc', { task: 'En Spotify, buscar Hey Ya de OutKast y darle play' }, {}),
    ]).then(([play, mail, unmarked]) => {
        ok(play && !play.needsConfirm && started.length === 1, 'a harmless PC task (play a song) runs without a question');
        ok(mail && mail.needsConfirm, 'one that sends something still asks, whatever the brain says');
        ok(unmarked && unmarked.needsConfirm, 'and one the brain did not mark harmless asks too');
    }).catch(e => { fail++; console.log('  [x] harmless do_on_pc threw: ' + e.message); });

    // 3. "subele el volumen al maximo" took a minute: "volumeup" was not a key.
    const actPs = fs.readFileSync(path.join(ROOT, 'scripts/desk/act.ps1'), 'utf8');
    ok(/volumeup = 0xAF/.test(actPs) && /playpause = 0xB3/.test(actPs) && /nexttrack = 0xB0/.test(actPs), 'act.ps1 knows the media keys');
    const T = Date.now() + 10 * 60 * 1000;
    let media = null;
    try { media = desk._planAct({ humanAt: T - 1000 }, { op: 'media', keys: 'volumeup', times: 50, direct: true }, T); } catch (e) { media = e; }
    ok(Array.isArray(media) && media.includes('media') && media.includes('50'), 'a media key needs no look and is not stopped by his mouse when he asked for it');
    ok(actions.manifest().some(a => a.name === 'media') && actions.speaksPlain('media'), 'and there is a "media" action that says one word');

    // 4. "puedes pedirle a opus que haga una revision general de mi maquina" went to the
    //    tsrct SESSION as a message.
    const t = require(path.join(ROOT, 'lib/talk.js'));
    ok(t._askedOfSession('look_into', 'puedes pedirle a opus que haga una revisión general de mi máquina', 'tsrct') === false, 'asking a MODEL (opus) for a job is not a message for the watched session');
    ok(t._askedOfSession('look_into', 'pedile que revise el test', 'tsrct') === true, 'while "pedile ..." alone still goes to the session');

    // 5. focus on an app with no window ("no open window matches Spotify"), and looking at one monitor.
    const cli = fs.readFileSync(path.join(ROOT, 'scripts/desk.js'), 'utf8');
    ok(/cmd === 'focus'/.test(cli) && /openApp/.test(cli), 'the desk command\'s focus falls back to launching the app (which brings it forward)');
    ok(/mira TODOS los monitores/.test(recipes), 'after opening something the worker looks at every monitor');
    ok(/falta --screen/.test(fs.readFileSync(path.join(ROOT, 'lib/desk.js'), 'utf8')), 'a click without --screen says so in plain words');

    // 6. After "si", the PC action was narrated by a model ("Voy. Solo confirmo que el pedido
    //    quedo en marcha; todavia no se si...") and results were said twice when the orb watched hands.
    const talkSrc = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    ok(/trace\('plain', `\$\{pend\.name\} \(after yes\)`\)/.test(talkSrc), 'after his yes a PC action says its own short line');
    ok(/HANDS_SESSION/.test(talkSrc) && /state\.session === HANDS_SESSION/.test(talkSrc), 'the hands session is not narrated on top of its own result');
}

// ── Tesla review #12 (2026-10-10 17:30-17:48Z): "leeme toda la conversacion" four times ──
{
    const t = require(path.join(ROOT, 'lib/talk.js'));
    // His real sentences: each one asked for the WHOLE thing.
    for (const s of ['puedes abrir whatsapp en mi pc y buscar mi conversación con alejo y leerme toda la conversación que tuvimos hoy',
        'okay pero nunca me leíste toda la conversación', 'okay me puedes leer la conversación entera por favor',
        'describime todo lo que hablamos', 'leeme el mail completo'])
        ok(t._wantsDetail(s), `wants the whole thing: "${s}"`);
    ok(!t._wantsDetail('lee el ultimo mensaje de sam'), 'one message is not the whole thing');
    const talkSrc = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    ok(/DETAIL_ACTIONS\.has\(d\.action\.name\) && wantsDetail\(clean\)/.test(talkSrc), 'when he asks for the whole thing, the PC job is told so');
    const actions = require(path.join(ROOT, 'lib/actions.js'));
    const started = [];
    actions.configure({ teslaHands: { start: (o) => { started.push(o); return { key: 'k', model: 'Sonnet' }; } } });
    Promise.all([
        actions.run('look_at_screen', { question: 'En WhatsApp: leer la conversacion con ale de hoy', detail: 'si' }, {}),
        actions.run('look_at_screen', { question: 'que dice el ultimo mensaje' }, {}),
    ]).then(() => {
        const [full, one] = started;
        ok(full && full.detail === true && /lee TODO/.test(full.task) && !/"dijo": UNA frase corta con la respuesta/.test(full.task), 'a detailed look reads everything, not one sentence');
        ok(one && !one.detail && /"dijo": UNA frase corta/.test(one.task), 'a plain look still answers in one sentence');
    }).catch(e => { fail++; console.log('  [x] detail look threw: ' + e.message); });
    const handsSrc = fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8');
    ok(/job\.detail \? 3000 : 400/.test(handsSrc) || /detail \? 3000 : 400/.test(handsSrc), 'the worker\'s answer is kept whole (3000 chars) when he asked for detail');
    ok(/slice\(0, 3000\), 'bg'[,)]/.test(talkSrc), 'and is not cut to 400 on its way to his ear');
    ok(/lastResult/.test(handsSrc), 'and the brain keeps the full text, so "leemela entera" does not send it to look again');

    // "que paso no te escuche" -> "Lo que dijiste no llego completo..." - she did not
    // know what she had said (a background line). Repeat it, word for word, no model.
    ok(t._notHeard && t._notHeard.test('qué pasó no te escuché') && t._notHeard.test('repetímelo') && t._notHeard.test('que dijiste') && !t._notHeard.test('que dijiste sobre harbor'), '"no te escuche" / "repetimelo" is recognised');
    ok(/trace\('path', 'repeat-last'\)/.test(talkSrc), 'and answered with her last line, as it was');
}

// ── Tesla review #13 (2026-10-10 17:52-17:56Z) ──
{
    const actions = require(path.join(ROOT, 'lib/actions.js'));
    const started = [];
    actions.configure({ teslaHands: { start: (o) => { started.push(o); return { key: 'k', model: 'Sonnet' }; } } });
    // 1. "leeme todo lo que hablamos hoy" -> 172 s of messages read one by one, hushed.
    //    His rule: read it all, then EXPLAIN what they wanted to tell him, ordered and detailed.
    Promise.all([
        actions.run('look_at_screen', { question: 'En WhatsApp: leeme todo lo que hablamos hoy con Ale', detail: 'si' }, {}),
        actions.run('look_at_screen', { question: 'leemelo textual', detail: 'textual' }, {}),
    ]).then(([a, b]) => {
        const [explain, literal] = started.slice(-2);
        ok(explain && /EXPLICASELO/.test(explain.task) && /no mensaje por mensaje/.test(explain.task), 'a whole conversation is EXPLAINED, ordered by what they wanted, not read message by message');
        ok(explain && /hablale de vos/.test(explain.task), 'and told to him as "vos", not "Leon mando..."');
        ok(literal && /palabra por palabra/.test(literal.task), 'word for word only when he says "textual"');
    }).catch(e => { fail++; console.log('  [x] explain look threw: ' + e.message); });
    const t = require(path.join(ROOT, 'lib/talk.js'));
    ok(/detail: LITERAL\.test\(clean\) \? 'textual' : 'si'/.test(fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8')), '"textual / literal / palabra por palabra" asks for the words themselves');

    // 2. The look worker did not know the scroll syntax: it ran "--help", grep and "| head",
    //    which stopped it on permission cards.
    const recipes = fs.readFileSync(path.join(ROOT, 'lib/actions.js'), 'utf8');
    const lookRecipe = recipes.slice(recipes.indexOf('look_at_screen: (question'), recipes.indexOf('do_on_pc: (task'));
    ok(/scroll --screen N --x X --y Y --amount/.test(lookRecipe), 'the look recipe gives the exact scroll/click syntax');
    ok(/sin \| head, sin > archivo y sin 2>&1/.test(recipes), 'and says no pipes or redirections around the desk command');
    const handsSrc = fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8');
    ok(/Bash\(node scripts\/desk\.js \$\{op\}:\*\)/.test(handsSrc), 'the relative "node scripts/desk.js ..." form is allowed too');
    // 3. "¿Aprobar el permiso ... (Tip: auto mode handles these prompts for you ...)?" for a
    //    card his approver had already allowed.
    ok(/firstSeen/.test(handsSrc) && /PERMISSION_GRACE_MS/.test(handsSrc), 'a card is only asked about if it is still there a few seconds later');
    const scr = ['╌╌╌╌╌╌', ' Bash command', '   node scripts/desk.js scroll --screen 1 --x 1536 --y 768 --amount 5', ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');
    actions.configure({ tmux: { captureSession: () => scr, listSessions: () => [] }, permissionDesk: null });
    const d = actions._permissionDialog('hands');
    ok(d && /desk\.js scroll/.test(d.what) && !/Tip|auto mode/.test(d.what), `a Tip line is not the description: "${d && d.what}"`);
}

// ── do_on_pc: confirmed once, careful by instruction ──
{
    const actions = require(path.join(ROOT, 'lib/actions.js'));
    const started = [];
    actions.configure({ teslaHands: { start: (o) => { started.push(o); return { key: 'k', model: 'Sonnet', changes: true }; } } });
    ok(actions.manifest().some(x => x.name === 'do_on_pc'), 'do_on_pc is in the catalogue the brain sees');
    const recipe = require('fs').readFileSync(path.join(ROOT, 'lib/actions.js'), 'utf8');
    for (const [rule, re] of [
        ['only the desk command', /UNICA forma de ver y tocar la PC/],
        ['check the window in front before typing (the Notepad lesson)', /ANTES de escribir, confirma en "front"/],
        ['never type into his existing files unasked', /Nunca escribas en un documento o archivo suyo/],
        ['ask before anything that cannot be undone', /PARA y preguntale antes de cualquier paso que no se puede deshacer/],
        ['stop when he takes the mouse', /Leon tomo el mouse: PARA/],
        ['look again and go on after he moves the mouse', /Leon movio el mouse y paro: mira la pantalla de nuevo/],
    ]) ok(re.test(recipe), `the do_on_pc recipe says: ${rule}`);
}

// ── the recipe texts must pass the hands guard (2026-10-10, his first real try) ──
// "puedes abrir spotify" -> "si por favor" -> crashed: the do_on_pc text said
// "SecretCo" in its own safety rule, and teslaHands.start refuses any task that
// names it. The checks above faked start(); this runs the REAL guard on the REAL text.
{
    const restrictedGuard = require(path.join(ROOT, 'lib/dispatcher/restrictedGuard.js'));
    const actions = require(path.join(ROOT, 'lib/actions.js'));
    const seen = [];
    actions.configure({ teslaHands: { start: (o) => { seen.push(o); return { key: 'k', model: 'Haiku', changes: !!o.changes }; } } });
    Promise.all([
        actions.run('look_at_screen', { question: 'que dice ese mail' }, {}),
        actions.run('do_on_pc', { task: 'Abrir la aplicacion Spotify en la PC', level: 'simple' }, { confirmed: true }),
    ]).then(() => {
        for (const o of seen) ok(!restrictedGuard.mentionsRestricted(o.task), `the ${o.recipe} text passes the hands SecretCo guard (it names nothing restricted)`);
        ok(seen.some(o => o.recipe === 'do_on_pc'), 'do_on_pc reached hands once confirmed');
    }).catch(e => { fail++; console.log('  [x] recipe run threw: ' + e.message); });
}

// ── step three: talking to her from VR, about the PC ──
{
    const brain = require(path.join(ROOT, 'lib/haikuBrain.js'));
    const vr = brain._decidePrompt({ text: 'abrime el excel de ventas', where: 'vr', sessions: [] });
    const desk2 = brain._decidePrompt({ text: 'abrime el excel de ventas', where: '', sessions: [] });
    ok(/casco de realidad virtual/.test(vr) && !/casco de realidad virtual/.test(desk2), 'from VR the brain is told he is in the headset looking at his desktop, and only from VR');
    const brainSrc = fs.readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
    ok(/"abrime el excel",[\s\S]{0,40}"cerra spotify"[\s\S]{0,80}nunca son open_session, close_session ni say_to_session/.test(brainSrc), 'the brain is told PC sentences are not session orders');
    ok(/stop_sessions con session = \["hands"\]/.test(brainSrc), '"para" while she works the PC stops the hands worker');
    ok(/say_to_session a hands con su[\s\S]{0,20}respuesta tal cual/.test(brainSrc), 'and his answer to her question goes back to it');
    const talkSrc = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    const serverSrc = require('./serverSource')();
    const orbSrc = fs.readFileSync(path.join(ROOT, 'src/js/assistant.js'), 'utf8');
    // the VR half lives in its own module since cleanup P2 #12
    const rdSrc = ['src/js/remote-desktop.js', 'src/js/remote-desktop-vr.js']
        .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    ok(/where: \(document\.body && document\.body\.dataset\.teslaWhere\) \|\| ''/.test(orbSrc), 'the one orb says where he is talking from');
    ok(/p\.where === 'vr' \? 'vr' : ''/.test(serverSrc) && /where: from === 'runner' \|\| from === 'vr' \? from : ''/.test(talkSrc), 'and only "vr" passes through the server to the brain');
    ok((rdSrc.match(/document\.body\.dataset\.teslaWhere = 'vr'/g) || []).length === 2 && /delete document\.body\.dataset\.teslaWhere/.test(rdSrc), 'VR sets it on both ways in and clears it on the way out');
    ok(/window\.Assistant\.toggle\(\)/.test(rdSrc) && !/new \(window\.SpeechRecognition|webkitSpeechRecognition[\s\S]{0,200}rdVrTesla/.test(rdSrc), 'the VR button drives the one orb, no second recogniser');
    ok(/last\.x !== sx \|\| last\.y !== sy \|\| last\.b !== rdVrMouseBtnState/.test(rdSrc), 'VR sends the cursor only when it moved, so it cannot drag Windows\' cursor off her click');
}

let threw = null;
desk.look({}).catch(e => { threw = e; }).finally(() => {
    ok(threw && threw.code === 'DESK_REFUSED', 'look() refuses BEFORE it captures anything');

    // ── the wiring ──
    const server = require('./serverSource')();
    ok(/mentionsRestricted\(decodeURIComponent\(req\.url\)\)\) desk\.sawRestrictedPane\(\)/.test(server), 'server.js marks every request that names SecretCo');
    const actions = require(path.join(ROOT, 'lib/actions.js'));
    const started = [];
    actions.configure({ teslaHands: { start: (o) => { started.push(o); return { key: 'k', model: 'Sonnet', changes: false }; } } });
    Promise.resolve(actions.run('look_at_screen', { question: 'que error hay', screen: '2' }, {})).then((r) => {
        const s = started[0];
        ok(s && s.recipe === 'look_at_screen' && s.changes === false, 'look_at_screen is a read-only recipe');
        ok(s && /scripts\/desk\.js look --screen 2/.test(s.task), 'it looks only through scripts/desk.js, at the monitor he named');
        ok(s && /NO intentes verlo de otra forma/.test(s.task), 'and is told not to work around a refusal');
        ok(r && !r.needsConfirm, 'it does not ask first: it only looks');
        const hands = fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8');
        ok(/Bash\(node \$\{cli\} \$\{op\}:\*\)/.test(hands) && /\['look', 'click', 'double', 'right', 'move', 'scroll', 'type', 'key', 'focus', 'open', 'media',/.test(hands), 'hands may run the desk command without a permission card, and only that command');
        return actions.run('do_on_pc', { task: 'abri el excel de ventas' }, {});
    }).then((d) => {
        ok(d && d.needsConfirm, 'do_on_pc asks him once before it starts');
        ok(!started.some(s => s.recipe === 'do_on_pc'), 'and nothing runs before his yes');
        const logged = fs.readFileSync(path.join(tmp, 'log', fs.readdirSync(path.join(tmp, 'log')).find(f => f.endsWith('.jsonl'))), 'utf8').trim().split('\n').map(JSON.parse);
        ok(logged.some(r => r.kind === 'look' && /SecretCo/.test(r.refused)), 'a refused look is written in the desk log, for the review');
    }).catch(e => { fail++; console.log('  [x] look_at_screen threw: ' + e.message); }).finally(() => Promise.all(timedChecks).then(() => setTimeout(() => {
        // The timed checks above have finished (timedChecks); the delay is for the
        // promise-based checks that report without being awaited.
        fs.rmSync(tmp, { recursive: true, force: true });
        if (fail) { console.error(`[check-desk] ${fail} failure(s) of ${pass + fail}`); process.exit(1); }
        console.log(`[check-desk] ${pass}/${pass}`);
        process.exit(0);
    }, 700)));
});
