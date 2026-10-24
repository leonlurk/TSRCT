#!/usr/bin/env node
// scripts/check-brain.js — Tesla's hidden Haiku brain (lib/haikuBrain.js).
//
// What can be proven without starting Claude: the answer is read from the
// transcript correctly (only the FINISHED message, never the "let me look"
// text between tool calls, never a message still being written), the spoken
// cleanup, which folder a question is asked from, the hidden-name rule, and
// that the SecretCo guards are in the code paths that type and that start.
// No tmux, no network, no model.
'use strict';
process.env.PROJECTS_ROOT = process.env.PROJECTS_ROOT || require('path').dirname(require('path').resolve(__dirname, '..'));   // the repo's parent counts as the projects folder
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const brain = require(path.join(ROOT, 'lib/haikuBrain.js'));

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log('  [x] ' + label); } };

// ── reading the answer from the transcript ──────────────────────────────────
const f = path.join(os.tmpdir(), `check-brain-${process.pid}.jsonl`);
const row = (o) => JSON.stringify(o) + '\n';
const say = (req, stop, text, extra) => row({ type: 'assistant', requestId: req, message: { id: req, stop_reason: stop, content: [{ type: 'text', text }] }, ...(extra || {}) });
fs.writeFileSync(f, row({ type: 'user', message: { content: 'old question' } }) + say('r0', 'end_turn', 'old answer'));
const entry = { id: 'x', file: f, offset: fs.statSync(f).size };
ok(brain._readAnswer(entry) === null, 'nothing after the question yet -> still waiting');
fs.appendFileSync(f, row({ type: 'user', message: { content: 'new question' } }) + say('r1', 'tool_use', 'Dejame mirar el archivo.'));
ok(brain._readAnswer(entry) === null, 'text between tool calls is not the answer');
fs.appendFileSync(f, say('r2', 'end_turn', 'La sesion corrio los tests y fallo uno.') + '{"type":"assist');
ok(brain._readAnswer(entry) === 'La sesion corrio los tests y fallo uno.', `the finished answer only (got ${JSON.stringify(brain._readAnswer(entry))})`);
fs.unlinkSync(f);

ok(brain._clean('```json\n**Hola** Leon,\n\nlisto') === 'Hola Leon, listo', 'markdown and fences never reach the voice');

// ── the action line Haiku adds when he asks for something ─────────────────
{
    const r = brain._stripAction('Dale, te abro cinco.\nACCION {"name":"open_session","args":{"project":["tsrct","harbor"]}}');
    ok(r.action && r.action.name === 'open_session' && r.action.args.project.length === 2 && r.say.trim() === 'Dale, te abro cinco.', 'a trailing ACCION line becomes an action, and is not spoken');
    ok(brain._stripAction('Listo.\n`ACCION {"name":"go_tab","args":{"tab":"tasks"}}`').action.name === 'go_tab', 'backticks around it are tolerated');
    const bad = brain._stripAction('Te abro.\nACCION {"name": open_session}');
    ok(bad.action === null, 'broken JSON is no action at all');
    ok(brain._stripAction('Si queres digo ACCION {"name":"x"} y sigo hablando.').action === null, 'ACCION in the middle of a sentence is not an action');
    ok(brain._stripAction('Solo charlando.').action === null, 'no line, no action');
}

// ── which folder, which name ────────────────────────────────────────────────
brain.configure({ cwdOf: () => '/mnt/c/Users/you/PROJECTS/SecretCoSandbox' });
ok(brain._whereFor('secretco').name === 'tesla-general', 'an SecretCo folder is never a brain\'s folder');
brain.configure({ cwdOf: () => '/tmp' });
ok(brain._whereFor('x').name === 'tesla-general', 'a folder outside PROJECTS gets the general brain');
ok(brain._whereFor('').name === 'tesla-general', '"no session - just talk" is the general brain, in PROJECTS');
brain.configure({ cwdOf: () => path.join(ROOT) });
// The repo's own brain is named after the folder it was cloned into, not a fixed name.
const OWN_BRAIN = 'tesla-' + path.basename(ROOT).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
ok(brain._whereFor('tsrct').name === OWN_BRAIN, `a project folder gets its own brain (${OWN_BRAIN}, got ${brain._whereFor('tsrct').name})`);
ok(brain.isHidden('tesla-tsrct') && !brain.isHidden('tsrct'), 'tesla-* is hidden, his sessions are not');

// ── no ghosts: boot and closeAll kill every tesla-*, and only those ─────────
let sweepDone = Promise.resolve();
{
    const killed = [];
    let live = ['tsrct', 'tesla-free', 'harbor', 'tesla-general'];
    const fake = (args) => {
        if (args[0] === 'list-sessions') return live.join('\n') + '\n';
        if (args[0] === 'kill-session') { const n = args[2].replace(/^=/, ''); killed.push(n); live = live.filter(x => x !== n); return ''; }
        throw new Error('no such session');
    };
    brain.configure({ tmux: fake });
    ok(killed.join(',') === 'tesla-free,tesla-general', `boot kills the last server's hidden sessions and nothing else (killed ${killed.join(',') || 'none'})`);
    live.push('tesla-harbor');
    killed.length = 0;
    sweepDone = brain.closeAll().then(async () => {
        ok(killed.join(',') === 'tesla-harbor', `closeAll kills a tesla-* it never started (killed ${killed.join(',') || 'none'})`);
        ok(live.join(',') === 'tsrct,harbor', 'his own sessions survive every sweep');
        // 2026-10-05: a close landed while his sentence was being answered (and
        // once just after a new one had started a brain): the sweep killed the
        // brain mid-question - "can't find pane: tesla-tsrct". The close waits for
        // the question in flight, and does not sweep if a conversation reopened.
        live.push('tesla-tsrct');
        killed.length = 0;
        let release;
        brain._inFlight(new Promise(r => { release = r; }));
        let swept = false;
        const closing = brain.closeAll({ stillClosed: () => true }).then(() => { swept = true; });
        await new Promise(r => setTimeout(r, 50));
        ok(!swept && !killed.length, 'closeAll waits for the question in flight');
        release();
        await closing;
        ok(killed.join(',') === 'tesla-tsrct', 'and sweeps once it has its answer');
        live.push('tesla-general');
        killed.length = 0;
        await brain.closeAll({ stillClosed: () => false });
        ok(!killed.length, 'a close that a new conversation overtook does not kill its brain');
    });
}

// ── the guards are where the text goes out ──────────────────────────────────
const src = fs.readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
const body = (name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
ok(/assertNotRestricted/.test(body('askIn')), 'askIn() checks the prompt for SecretCo before typing it');
ok(/assertNotRestricted/.test(body('start')), 'start() refuses an SecretCo folder before opening a session');
ok(/--disallowedTools[^']*Bash[^']*Edit[^']*Write/.test(src), 'the hidden session cannot run, edit or write');
const server = require('./serverSource')();
ok(/isHiddenSession = \(name\) => isRoSession\(name\) \|\| String\(name \|\| ''\)\.startsWith\('tesla-'\)/.test(server), 'server.js hides tesla-* sessions');

// ── it knows where his folders are, in plain words (2026-10-05) ─────────────
// "abrime una sesion nueva en mi aplicacion personal de corredor" -> "Cual es el
// nombre del proyecto?". The folder was personal/runner-app: one level down,
// so it did not exist for the registry, and the brain only ever saw bare names.
{
    const reg = require(path.join(ROOT, 'lib/projectRegistry.js'));
    const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'check-folders-'));
    const mk = (rel, file, text) => { fs.mkdirSync(path.join(fx, rel), { recursive: true }); if (file) fs.writeFileSync(path.join(fx, rel, file), text); };
    mk('personal/runner-app', 'README.md', '# Ghost Runner\n\nA running app you install from your own server. It records a run.\n');
    mk('personal/cv', null);                                            // not a project: no marker
    mk('HARBOR', 'README.md', '# HARBOR\n\nProduct allocations for a distributor.\n');
    mk('HARBOR/sf-metadata', 'sfdx-project.json', '{}');                  // part of HARBOR, not its own
    mk('SecretCoSandbox', 'README.md', '# x\n\ny\n');
    mk('some-brain/advisors', 'README.md', '---\ntags: [advisors]\n---\n# Advisors\n');   // a knowledge section, not a project
    mk('vault/projects', 'HARBOR.md', '---\npath: ' + path.join(fx, 'HARBOR') + '\n---\n# HARBOR\n\n## What It Is\nThe Salesforce work for a farm-equipment\ndistributor, allocating products.\n\n## Layout\n');
    const dirs = reg._scan(fx);
    ok(!dirs.has('some-brain-advisors'), 'a knowledge-base section is not a project');
    ok(dirs.get('personal-runner-app') === path.join(fx, 'personal/runner-app'), `a project inside a container folder is found (got ${dirs.get('personal-runner-app')})`);
    ok(!dirs.has('personal-cv'), 'a plain subfolder is not a project');
    ok(!dirs.has('harbor-sf-metadata'), "a project's own subfolder is not a separate project");
    ok(![...dirs.keys()].some(k => /secretco/i.test(k)), 'SecretCo is never indexed');
    const map = reg._mapText(fx);
    ok(/personal-runner-app \(personal\/runner-app\): Ghost Runner - A running app/.test(map), `the map says what each folder IS (got ${JSON.stringify(map.slice(0, 200))})`);
    ok(!/secretco/i.test(map), 'SecretCo never reaches the map');
    ok(/- harbor \(HARBOR\): The Salesforce work for a farm-equipment distributor, allocating products\./.test(map), `his vault note wins over the README, a wrapped sentence whole (got ${JSON.stringify((map.match(/- harbor .*/) || [''])[0])})`);
    fs.rmSync(fx, { recursive: true, force: true });
    ok(/CARPETAS DE \$\{OWNER_UP\}/.test(src) && /projectRegistry\.mapText\(\)/.test(src), 'the brain is handed the folder map when it starts');
}

// ── a question the brain never took (Tesla review #3, 2026-10-07 00:44) ─────
// "decile a la sesion que ya volvi de correr..." went into a brain that had just
// booted, and never became a message: that brain has no transcript at all. TSRCT
// waited the full 120 s for an answer to a question nobody had received, and his
// two retries meanwhile were refused with "still answering the last one". Now the
// question must SHOW UP in the transcript within seconds, or Enter is pressed
// again, then it is typed again, then the brain is dropped and he is told.
async function receiptChecks() {
    const sessionSpawn = require(path.join(ROOT, 'lib/sessionSpawn.js'));
    const real = { create: sessionSpawn.createPrimedSession, paste: sessionSpawn.pasteIntoPane };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-receipt-'));
    fs.mkdirSync(path.join(dir, 'proj'));
    const live = new Set();
    let id = '', enters = 0, pastes = 0, takeOn = 2;
    const killed = [];
    sessionSpawn.createPrimedSession = async ({ name, command }) => { id = /--session-id (\S+)/.exec(command)[1]; live.add(name); enters = 0; pastes = 0; return { ok: true }; };
    sessionSpawn.pasteIntoPane = () => { pastes++; return { success: true }; };
    const tmux = (args) => {
        const name = String(args[2] || '').replace(/^=/, '');
        if (args[0] === 'has-session') { if (live.has(name)) return ''; throw new Error('no'); }
        if (args[0] === 'kill-session') { live.delete(name); killed.push(name); return ''; }
        if (args[0] === 'list-sessions') return '';
        if (args[0] === 'capture-pane') return '';
        if (args[0] === 'send-keys' && args.includes('Enter')) {
            enters++;
            if (enters === takeOn) fs.writeFileSync(path.join(dir, 'proj', `${id}.jsonl`), row({ type: 'user', message: { content: 'q' } }) + say('a1', 'end_turn', 'Listo.'));
            return '';
        }
        return '';
    };
    brain.configure({ tmux, cwdOf: () => ROOT, projectsDir: dir, receiptMs: 300 });
    try {
        const said = await brain.converse({ text: 'hola', session: 'tsrct' });
        ok(said === 'Listo.' && enters === 2, `an unsent question gets a second Enter, then its answer (got ${JSON.stringify(said)}, ${enters} Enters)`);
        killed.length = 0;
        takeOn = Infinity;
        live.clear();                                  // the next question boots a fresh brain
        const t0 = Date.now();
        let why = '';
        try { await brain.converse({ text: 'hola otra vez', session: 'tsrct' }); } catch (e) { why = e.message; }
        ok(/did not take the question/.test(why), `a question that never arrives fails out loud (got "${why}")`);
        ok(Date.now() - t0 < 15000, `and fast, not after the 120 s answer wait (took ${Date.now() - t0} ms)`);
        ok(pastes === 2 && killed.includes(OWN_BRAIN), `it is typed once more before giving up, and the stuck brain is dropped (pastes ${pastes}, killed ${killed.join(',') || 'none'})`);
    } finally {
        sessionSpawn.createPrimedSession = real.create;
        sessionSpawn.pasteIntoPane = real.paste;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── the thread survives a switch to a session in another folder ─────────────
// 2026-10-08 20:57: "ahi acabo de cambiar tu vista a la nueva sesion, ahora si le
// podes mandar" went to tesla-tsrct, a NEW brain (one per folder) that had heard
// none of it: "Decime que le queres mandar". A brain that did not hear the last
// turns gets them in the prompt; the one that did hear them does not.
function handoffChecks() {
    if (typeof brain._remember !== 'function' || typeof brain._handoff !== 'function') { ok(false, 'haikuBrain has no conversation handoff'); return; }
    brain._forget();
    brain._remember('tesla-probill', 'decirle que haga la corrida del skill de revision de tesla', 'Eso es para tsrct-2, pero no la tengo en mi lista.');
    const h = brain._handoff('tesla-tsrct');
    ok(/decirle que haga la corrida del skill de revision de tesla/.test(h) && /no la tengo en mi lista/.test(h), `a new brain is told what was just said (got ${JSON.stringify(h.slice(0, 120))})`);
    ok(brain._handoff('tesla-probill') === '', 'the brain that heard it is not told twice');
    brain._forget();
    ok(brain._handoff('tesla-tsrct') === '', 'a closed conversation hands nothing over');
}

// ── what each turn tells the brain (Tesla review #4) ────────────────────────
function promptChecks() {
    const P = brain._decidePrompt;
    if (typeof P !== 'function') { ok(false, 'haikuBrain has no decidePrompt'); return; }
    const base = { session: 'pro-services', sessions: ['pro-services'] };
    // Review #15 (2026-10-13 23:37): an `secretco-doc` tmux session was open, its NAME
    // rode in "Sesiones abiertas ahora" on every turn, and the SecretCo guard refused
    // every question - "hola" included - for as long as it stayed open. The name of
    // an SecretCo session is left out of the list; the guard itself stays.
    const withRestricted = P({ text: 'me pones un poco de sade en spotify', session: '', sessions: ['tsrct', 'secretco-doc', 'SecretCoSandbox-2', 'shopline'] });
    ok(!require('../lib/dispatcher/restrictedGuard').mentionsRestricted(withRestricted), 'an open SecretCo session does not put SecretCo into every question');
    ok(/Sesiones abiertas ahora: tsrct, shopline/.test(withRestricted), 'the other open sessions are still listed');
    // Review #15 (2026-10-12 11:53, watching kara-bva): "dice que se fije por favor y que
    // compare contra la documentacion y el codigo" was "decile que", misheard. Haiku read the
    // code ITSELF for 21 s and answered "no hace falta ninguna accion".
    ok(/"dice que \.\.\." es casi siempre "decile que/.test(src), 'the brain knows "dice que <pedido>" is a misheard "decile que"');
    ok(/Nunca hagas vos el trabajo de la sesion/.test(src), 'the brain never does a session\'s work itself with Read');
    // Review #15: narrations ran 200-260 characters (13-16 s of audio), 24 of them in 23
    // minutes on one session, and 4 of his 5 hushes were narrations. A finished turn is
    // told in ONE short sentence; the detail is there if he asks.
    const nIdx = src.indexOf('async function narrateSession');
    const nSrc = nIdx > 0 ? src.slice(nIdx, nIdx + 2000) : '';
    ok(nSrc && !/Contale a Leon en una o dos frases/.test(nSrc) && /UNA sola frase/.test(nSrc), 'a finished turn is narrated in ONE short sentence');
    ok(/menos de 20 palabras/.test(nSrc), 'with a word cap he can hear in a few seconds');
    // "okay monitorealo por favor" -> "No puedo vigilarla por mi cuenta", with live narration ON.
    ok(/YA LA ESTAS VIGILANDO/.test(P({ ...base, text: 'okay monitorearlo por favor', watching: 'live' })), 'the brain is told it is already watching the session');
    ok(!/YA LA ESTAS VIGILANDO/.test(P({ ...base, text: 'como va', watching: '' })), 'and not told so when nothing is watched');
    // "hola como estas" -> a status paragraph (hushed); "que" -> the last narration retold at length (hushed).
    ok(/solo te saluda/i.test(P({ ...base, text: 'hola como estas' })), 'a greeting is answered as a greeting');
    ok(!/solo te saluda/i.test(P({ ...base, text: 'hola, como va el deploy de harbor?' })), 'a question that starts with hola is still a question');
    ok(/una sola palabra/i.test(P({ ...base, text: 'qué' })), 'a lone "que" gets the last line again, short');
    // He spoke English and it answered in Spanish.
    ok(/en ingles/i.test(P({ ...base, text: 'yes please do that', lang: 'en' })), 'an English sentence is answered in English');
    ok(!/en ingles/i.test(P({ ...base, text: 'si por favor', lang: 'es' })), 'a Spanish one is not');
    // "open it in this same terminal" -> "no tengo forma", though show_session exists.
    ok(/misma terminal/.test(src) && /show_session/.test(src), 'the brain knows "en esta misma terminal" is open_session + show_session');
    // Ghost Runner (2026-10-09): from the phone, mid-run, with no TSRCT screen.
    const run = P({ ...base, text: 'que esta haciendo harbor', where: 'runner' });
    ok(/app de correr/.test(run) && /nombra la sesion/.test(run), 'a turn from the runner app tells the brain he is running and to name the session before sending');
    ok(!/app de correr/.test(P({ ...base, text: 'que esta haciendo harbor' })), 'and a turn from TSRCT does not');
    // Tesla review #8: on his run she tried the SCREEN approve button, then typed "si" into the session.
    ok(/approve_session_permission/.test(run) && /nunca approve_permission/.test(run), 'from the runner app, a permission is approved with the server-side action, never the screen button');
    // ...and from TSRCT too (2026-10-09): never by typing "si" into the session, and the action rides with her question.
    ok(/approve_session_permission/.test(src.slice(src.indexOf('const BASE'), src.indexOf('function actionsSection'))) && /nunca[^.]*say_to_session/.test(src.slice(src.indexOf('const BASE'), src.indexOf('function actionsSection'))),
        'everywhere, a permission is approved with an action, never by typing "si" into the session');
}

// ── Tesla review #7 (2026-10-09 21:46-21:50, from the runner app) ──────────
// "abrí la nueva" / "abrila de una vez" / "si por favor": Haiku put its ACCION on
// the SAME line as its sentence, three times. Nothing ran (the session never
// opened, his message never went), and the action was read out loud with its
// underscores eaten by clean(). An inline ACCION is still an action.
{
    const r1 = brain._stripAction('Listo, mando la apertura de la sesión nueva en personal-runner-app. ACCION {"name":"open_session","args":{"project":"personal-runner-app"}}');
    ok(r1.action && r1.action.name === 'open_session' && !/ACCION/.test(r1.say) && /personal-runner-app\.\s*$/.test(r1.say), `an ACCION at the end of the sentence is an action and is not spoken (got ${JSON.stringify(r1)})`);
    const r2 = brain._stripAction('Dale, se lo mando a la sesión tsrct. ACCION {"name":"say_to_session","args":{"session":"tsrct","text":"Hacé un tesla-review. Gracias."}}');
    ok(r2.action && r2.action.name === 'say_to_session' && r2.action.args.text === 'Hacé un tesla-review. Gracias.', 'and its text keeps every character');
    const r3 = brain._stripAction('Va. ACCION {"name": open_session}');
    ok(!r3.action && !/ACCION/.test(r3.say), 'a broken inline ACCION is still never read out loud');
    ok(brain._stripAction('La palabra ACCION no es una orden.').say === 'La palabra ACCION no es una orden.', 'the word on its own, mid-sentence, is left alone');
}

// ── Tesla review (2026-10-23 23:20, from the runner app): Haiku wrote its accents
// as literal escapes - "Terminó la corrida 30 ... más rápido" - and
// she read 21.9 s of codes out loud. clean() turns them back into the letters.
{
    const said = brain._clean('Termin\\u00f3 la corrida 30, la parte f\\u00e1cil bien y el tramo final m\\u00e1s r\\u00e1pido.');
    ok(said === 'Terminó la corrida 30, la parte fácil bien y el tramo final más rápido.', `a literal \\u escape is spoken as its letter (got ${JSON.stringify(said)})`);
    ok(brain._clean('Listo, abrí la sesión.') === 'Listo, abrí la sesión.', 'and real accents are untouched');
}

// ── Tesla review #16 (2026-10-14 00:02): he said "nada" and she said out loud
// 'Leon dijo "nada", asi que no hago nada. (nada)'. An answer that ends in the
// "(nada)" marker is silence, not a sentence about him. Not '' - talk.js reads an
// empty answer as "did not answer, say it again"; "(silencio)" is its quiet turn.
{
    const q = brain._quietIfNada;
    ok(typeof q === 'function' && q('Leon dijo "nada", así que no hago nada. (nada)') === '(silencio)', '"... (nada)" is silence (the marker talk.js keeps quiet)');
    ok(typeof q === 'function' && q('(nada)') === '(silencio)' && q('Dale, te paso la lista.') === 'Dale, te paso la lista.', 'a bare "(nada)" is silence and a real answer is untouched');
    ok(/_quietIfNada|quietIfNada\(clean\(r\.say\)\)/.test(src.slice(src.indexOf('async function decide('), src.indexOf('async function rejected('))), 'decide() applies it');
}

// ── Tesla review #6 (2026-10-08 23:05-23:12, a call with Jose) ─────────────
// "hola jose cómo andás ... estoy por ponerme con el proxy" and two more lines
// meant for someone else: each answered OUT LOUD with "eso no parece dirigido
// a mi" plus a status line, and he cut off all three. Not for her = silence.
ok(/\(silencio\)/.test(src), 'the brain is told to answer "(silencio)" to what is said to someone else');
// Switching session (23:10 tsrct-2, 22:52 marketing-stack) paid a 6.6-6.8 s cold
// brain boot inside his NEXT question. The switch itself starts the brain now.
{
    const talkSrc = fs.readFileSync(path.join(ROOT, 'lib/talk.js'), 'utf8');
    const att = talkSrc.slice(talkSrc.indexOf('function attach('), talkSrc.indexOf('function openLight('));
    ok(/haiku\.warm\(/.test(att), 'pointing the conversation at another session warms that folder\'s brain');
}

// ── a start command the new shell swallowed (2026-10-08 22:31, after a restart) ──
// "tesla-tsrct never came up in Claude (the pane is sitting at a shell prompt)":
// his first question waited 73 s and failed; the very next start came up in 4 s.
// The machine was loaded (15 sessions, a server just restarted) and the command
// was typed before the new shell was ready, so it vanished and the pane sat at
// an EMPTY prompt. Now the spawn waits for the prompt before typing, and types
// the command once more if the prompt is still empty a few seconds later.
async function spawnChecks() {
    const sessionSpawn = require(path.join(ROOT, 'lib/sessionSpawn.js'));
    const shell = 'user@laptop:/mnt/c/Users/you/PROJECTS/TSRCT$ ';
    const claude = [' ▝▝   ▝▝   /mnt/c/Users/you/PROJECTS/TSRCT', '─'.repeat(100), '❯ Try "edit desktop.css to..."', '─'.repeat(100), '  Haiku 5.5 · TSRCT', '  ⏸ manual mode on · ← for agents'].join('\n');
    let typed = 0, polls = 0, made = false;
    const tmux = (args) => {
        if (args[0] === 'new-session') { made = true; return ''; }
        if (args[0] === 'resize-window') return '';
        if (args[0] === 'send-keys' && args.includes('claude --x')) { typed++; return ''; }
        if (args[0] === 'capture-pane') { polls++; return polls < 3 ? '' : (typed >= 2 ? claude : shell); }   // blank while bash loads; the first command is lost
        return '';
    };
    const real = { configure: sessionSpawn.configure };
    sessionSpawn.configure({ tmux, sleep: async () => {}, sessionExists: () => made, sessionEnvArgs: () => [] });
    const r = await sessionSpawn.createPrimedSession({ name: 'tesla-probe', cwd: ROOT, command: 'claude --x', bootTimeoutMs: 5000 });
    ok(r.ok && typed === 2, `a swallowed start command is typed again and the session comes up (ok ${r.ok}, typed ${typed}, ${r.error || ''})`);
    // A pane that never shows a prompt at all gets the command anyway, once, after the wait.
    typed = 0; polls = 0; made = false;
    const tmux2 = (args) => { if (args[0] === 'new-session') { made = true; return ''; } if (args[0] === 'send-keys' && args.includes('claude --x')) { typed++; return ''; } if (args[0] === 'capture-pane') return typed ? claude : ''; return ''; };
    sessionSpawn.configure({ tmux: tmux2, sleep: async () => {}, sessionExists: () => made, sessionEnvArgs: () => [] });
    const r2 = await sessionSpawn.createPrimedSession({ name: 'tesla-probe', cwd: ROOT, command: 'claude --x', bootTimeoutMs: 5000 });
    ok(r2.ok && typed === 1, `no prompt seen at all still types the command exactly once (ok ${r2.ok}, typed ${typed})`);
    real.configure(null);
}

// ── Tesla review #14 (2026-10-12) ────────────────────────────────────────────
{
    const src = require('fs').readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
    // 12:46 "le puedes preguntar cuánto porcentaje completó del curso" -> she answered
    // from the screen ("no tengo ese porcentaje"); he had to say "me refería a que le
    // preguntes a la sesión". "le podes preguntar" is a message FOR the session.
    ok(/le pod[eé]s preguntar/i.test(src), 'the brain knows "le podes preguntar ..." is a message for the session, not a question for her');
    // 13:04 "le puedes preguntar a la sección de cerac ..." -> "no encuentro ninguna
    // sección ni proyecto que se llame cerac". The recogniser hears tsrct as "cerac"
    // and "sesión" as "sección".
    ok(/cerac/i.test(src) && /secci[oó]n/i.test(src), 'the brain knows how the recogniser mishears "sesion" and tsrct');
    // 19:01 the retry after a guard read like an accusation and came back as
    // "Tenés razón, me equivoqué ... Leon dijo sólo 'hola güera'".
    const nudge = src.slice(src.indexOf('async function nudge('), src.indexOf('function kill('));
    ok(/disculp/i.test(nudge) && /tercera persona/i.test(nudge), 'the retry tells the brain not to apologise or talk about Leon in the third person');
}

// 2026-10-14: a raw answer naming SecretCo was kept in the handoff memory and every
// later question to another brain was refused, "pone taylor swift" included.
function restrictedPoisonChecks() {
    const hb = require('../lib/haikuBrain');
    const guard = require('../lib/dispatcher/restrictedGuard');
    hb._forget();
    hb._remember('tesla-tsrct', 'abri las quince', 'Ocho tienen carpeta. La secretco-doc no la toco. Las otras no se donde estan.');
    const h = hb._handoff('tesla-general');
    ok(h && !guard.mentionsRestricted(h), 'the handoff memory keeps no SecretCo sentence');
    ok(/Ocho tienen carpeta/.test(h), 'the rest of that answer survives in the handoff');
    hb._forget();
}

// Review #18 (2026-10-16, 22:01): Claude Code updated itself while Tesla's brain
// was starting, the pane said "claude: command not found", the spawn retyped ONCE
// and then sat 80 s at a shell, and his "tesla estas ahi" got "still answering".
// A missing command is retried while it stays missing, then refused quickly in words.
async function notFoundChecks() {
    const sp = require(path.join(ROOT, 'lib/sessionSpawn.js'));
    const prompt = 'user@laptop:/mnt/c/Users/you/PROJECTS$ ';
    let typed = 0, fixAfter = Infinity;
    const screen = () => typed >= fixAfter
        ? '╭───╮\n│ > │\n╰───╯\n  ? for shortcuts'
        : `${prompt}claude --model haiku\nclaude: command not found\n${prompt}`;
    const deps = {
        tmux: (a) => (a[0] === 'capture-pane' ? screen() : ''),
        sleep: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 2))),
        sessionExists: () => true, sessionEnvArgs: () => [],
    };
    sp.configure(deps);
    const t0 = Date.now();
    const r = await sp.waitForClaudePrompt('tesla-x', { pollMs: 2, timeoutMs: 4000, retype: () => { typed++; } });
    ok(!r.ok && /not found/.test(r.reason), `a missing claude command is named (got ${JSON.stringify(r)})`);
    ok(typed >= 3, `a missing claude command is typed again more than once (typed ${typed})`);
    ok(Date.now() - t0 < 3000, `a missing claude command gives up before the timeout (${Date.now() - t0} ms)`);
}

sweepDone.then(receiptChecks).then(promptChecks).then(spawnChecks).then(handoffChecks).then(restrictedPoisonChecks).then(notFoundChecks).catch(e => ok(false, `threw: ${e.stack}`)).then(finish);

function finish() {
    if (fail) { console.error(`[check-brain] ${fail} failure(s) of ${pass + fail}`); process.exit(1); }
    console.log(`[check-brain] ${pass}/${pass} — answer read from the transcript, folders, hidden names, guards, no ghosts`);
}
