#!/usr/bin/env node
// A whole Tesla turn, end to end, through each brain (cleanup P2, 2026-10-17).
//
// check-talk proves what a sentence MEANS and check-brain how the Haiku session is read,
// but no check drove a real turn through askTurn into the brain: with the Haiku path or
// the local chooser broken, every check stayed green. This one does, with the brain
// replaced by a stand-in that answers a known sentence - no tmux, no model, no network.
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  [x] ' + msg); } };

// ── the Haiku brain, replaced before talk.js loads it ─────────────────────
const asked = [];
const fakeHaiku = {
    ready: () => true,
    loaded: () => true,
    keepWarm: () => {},
    unload: () => {},
    decide: async (o) => { asked.push(o); return { say: 'Todo en orden, Leon. Ninguna sesion espera nada.', action: null }; },
    nudge: async () => ({ say: '', action: null }),
    rejected: async () => '',
    report: async () => '',
    converse: async () => 'Hablando por hablar.',   // a reply that is NOT the brain's decision
    narrateSession: async () => '',
};
const brainPath = require.resolve(path.join(ROOT, 'lib/haikuBrain.js'));
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: new Proxy(fakeHaiku, {
    get: (o, k) => (k in o ? o[k] : async () => undefined),   // anything else: a no-op that, like the real one, returns a promise
}) };

// The brain is fixed when talk.js loads, so the LOCAL-brain half runs in its own process.
if (process.env.CHECK_TURNS_PART === 'local') {
    process.env.TALK_BRAIN = 'local';
    process.env.TESLA_LOG = '0';
    const talkL = require(path.join(ROOT, 'lib/talk.js'));
    const actions = require(path.join(ROOT, 'lib/actions.js'));
    const ran = [];
    actions.run = async (name, args) => { ran.push(name); return { ok: true, value: { plain: 'Tres sesiones abiertas.' }, says: 'Tres sesiones abiertas.' }; };
    const chose = [];
    const histories = [];   // how many earlier turns each answer was handed
    const localModel = {
        ping: async () => ({ ok: true }), loaded: async () => true, keepWarm: async () => {}, unload: async () => {},
        converse: async (o) => { histories.push((o.history || []).length); return 'Hablando por hablar.'; }, narrateSession: async () => '',
        chooseAction: async (o) => { chose.push(o.text); return { name: 'sessions_overview', args: {} }; },
    };
    talkL.configure({ hermes: localModel, sessions: () => ['tsrct', 'harbor'], capture: () => '', send: () => ({ success: true }), brief: null, project: null });
    (async () => {
        // 1. the parser is not sure of "y entonces", so the model's chooser decides
        const r = await talkL.ask({ text: 'y entonces', toClaude: false }).catch(e => ({ ok: false, why: e.message }));
        ok(chose.length === 1, `with the local brain an unclear sentence goes to the chooser once (asked ${chose.length})`);
        ok(ran.join() === 'sessions_overview', `and the action it chose must run (ran: ${ran.join() || 'nothing'})`);
        ok(r && r.ok && r.reply === 'Hablando por hablar.', `the answer is the model's reply, shaped (got ${JSON.stringify(r && (r.reply || r.why))})`);
        // 2. the parser IS sure of "que onda": its action runs and no model is asked
        ran.length = 0; chose.length = 0;
        await talkL.ask({ text: 'que onda', toClaude: false }).catch(() => null);
        ok(histories.join() === '0,2', `the second turn is handed the first one (user + answer) as history (got ${histories.join()})`);
        ok(ran.join() === 'project_status' && chose.length === 0, `a sentence the parser is sure of runs its action without the model (ran: ${ran.join() || 'nothing'}, chooser asked ${chose.length})`);
        console.log(`check-turns (local brain): ${pass}/${pass + fail} ${fail ? 'FAILED' : 'ok'}`);
        process.exit(fail ? 1 : 0);
    })();
    return;
}

process.env.TALK_BRAIN = 'haiku';
process.env.TESLA_LOG = '0';
const talk = require(path.join(ROOT, 'lib/talk.js'));

(async () => {
    talk.configure({
        hermes: null, brief: null, project: null,
        sessions: () => ['tsrct', 'harbor'],
        capture: () => '', send: () => ({ success: true }),
    });
    let r;
    try { r = await talk.ask({ text: 'como va todo hoy', toClaude: false }); } catch (e) { r = { ok: false, why: 'threw ' + e.message }; }
    ok(asked.length === 1, `the turn must ask the Haiku brain once (asked ${asked.length})`);
    ok(asked[0] && asked[0].text === 'como va todo hoy', 'and hand it his sentence as he said it');
    ok(r && r.ok && /Ninguna sesion espera nada/.test(r.reply || ''), `his answer must be the brain's sentence (got ${JSON.stringify(r && (r.reply || r.why))})`);
    ok(r && !r.sent, 'a question to Tesla is not typed into a session');

    const local = require('child_process').spawnSync(process.execPath, [__filename], { env: { ...process.env, CHECK_TURNS_PART: 'local' }, encoding: 'utf8' });
    const localOut = (local.stdout || '') + (local.stderr || '');
    for (const l of localOut.split('\n')) if (/^\s+\[x\]|check-turns \(local/.test(l)) console.log(l);
    ok(local.status === 0, 'the local-brain turn passes');
    console.log(`check-turns: ${pass}/${pass + fail} ${fail ? 'FAILED' : 'ok'}`);
    process.exit(fail ? 1 : 0);
})();
