#!/usr/bin/env node
'use strict';
// scripts/check-taste.js — his music taste (lib/tasteBrain.js, 2026-10-14).
// What must hold: a moment sets how far a pick goes (never far while he runs),
// a "no" is never played again, a reason is kept, the pool refills through the
// job runner and never offers what he already knows, a named artist is NOT
// replaced by a pick, and the sentences reach the right action without a model.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-'));
process.env.TASTE_FILE = path.join(tmp, 'taste.json');

const ROOT = path.join(__dirname, '..');
const taste = require(path.join(ROOT, 'lib', 'tasteBrain'));
const understand = require(path.join(ROOT, 'lib', 'understand'));

let failed = 0, passed = 0;
const fail = (m) => { failed++; console.log('  [x] ' + m); };
const ok = () => { passed++; };

(async () => {
    // A job runner that answers at once with a fixed pool.
    let jobs = 0, lastData = null, lastOpts = null;
    const answer = {
        traits: ['graves sucios', 'atmosfera oscura', 'sintes analogicos'],
        picks: [
            { name: 'Close One', kind: 'artist', why: 'mismo mundo', distance: 'close', moments: ['correr'] },
            { name: 'Close Two', kind: 'artist', why: 'mismo mundo', distance: 'close', moments: [] },
            { name: 'Step One', kind: 'artist', why: 'vecino', distance: 'step', moments: ['chill'] },
            { name: 'Step Two', kind: 'artist', why: 'vecino', distance: 'step', moments: [] },
            { name: 'Far One', kind: 'artist', why: 'lejos', distance: 'far', moments: ['casa'] },
            { name: 'Far Two', kind: 'artist', why: 'lejos', distance: 'far', moments: ['casa', 'correr'] },
            { name: 'deadmau5', kind: 'artist', why: 'ya lo conoce', distance: 'close', moments: [] },
            { name: 'Step Three', kind: 'artist', why: 'vecino', distance: 'banana', moments: ['nope'] },
            { name: 'Far Three', kind: 'artist', why: 'lejos', distance: 'far', moments: [] },
            { name: 'Close Three', kind: 'artist', why: 'mismo mundo', distance: 'close', moments: [] },
        ],
    };
    const jsonJob = { run: async (o) => { jobs++; lastData = o.jobData; lastOpts = o; return { ok: true, value: answer }; } };
    let seq = 0;
    taste.configure({ analyst: { submitJob: () => {} }, jsonJob, noPrime: true, now: () => 1e12 + (seq++) * 1000, random: () => 0 });

    // Born with his first seeds and no pool: nothing to pick, and that asks for a refill.
    if (taste.pick({ moment: 'casa' }) !== null) fail('an empty pool must answer null (spotify then plays its old list)'); else ok();
    await new Promise(r => setImmediate(r));
    if (jobs !== 1) fail(`an empty pool did not start one learning job (got ${jobs})`); else ok();
    if (!lastData || !lastData.seeds.some(s => /lorn/i.test(s.text))) fail('the job was not handed his seeds'); else ok();
    if (!lastOpts || lastOpts.kind !== 'tesla-taste' || !/never pick these/.test(lastOpts.instruction)) fail('the job instruction lost the "known" rule'); else ok();

    const st = taste.status();
    if (st.pool !== 9) fail(`a known name must be dropped and a bad distance coerced: expected 9 fresh picks, got ${st.pool}`); else ok();

    // The dial: running = close, home = far, chill = step.
    const run = taste.pick({ moment: 'correr' });
    if (!run || run.distance !== 'close') fail(`running must pick close (got ${run && run.distance})`); else ok();
    const home = taste.pick({ moment: 'casa' });
    if (!home || home.distance !== 'far') fail(`home must pick far (got ${home && home.distance})`); else ok();
    const chill = taste.pick({ moment: 'chill' });
    if (!chill || chill.distance !== 'step') fail(`chill must pick step (got ${chill && chill.distance})`); else ok();
    const any = taste.pick({});
    if (!any || any.distance !== 'step') fail(`no moment must pick a step out (got ${any && any.distance})`); else ok();

    // A "no" with a reason is kept, with its moment, and never played again.
    taste.played(home, 'Far One - Track');
    const r = taste.react({ liked: 'no', reason: 'demasiado limpio' });
    if (r.liked !== false || r.why !== 'demasiado limpio') fail('a "no" and its reason were not kept'); else ok();
    for (let i = 0; i < 10; i++) { const p = taste.pick({ moment: 'casa' }); if (p && p.query === 'Far One') { fail('a rejected pick came back'); break; } }
    ok();
    const saved = JSON.parse(fs.readFileSync(process.env.TASTE_FILE, 'utf8'));
    if (!saved.reactions.length || saved.reactions[0].moment !== 'casa') fail('the reaction lost the moment it played in'); else ok();

    // While he runs, never far, even when only far is left for running.
    const s = JSON.parse(fs.readFileSync(process.env.TASTE_FILE, 'utf8'));
    taste._reset();
    s.pool = [{ name: 'Only Far', kind: 'artist', why: 'x', distance: 'far', moments: ['correr'] }];
    fs.writeFileSync(process.env.TASTE_FILE, JSON.stringify(s));
    if (taste.pick({ moment: 'correr' }) !== null) fail('a far pick played while he runs'); else ok();

    // A reason he teaches is kept on the seed it belongs to.
    const t = taste.teach({ what: 'LORN', why: 'los graves sucios' });
    if (!t.known) fail('teaching a seed he already gave made a second one'); else ok();
    if (!/graves sucios/.test(JSON.parse(fs.readFileSync(process.env.TASTE_FILE, 'utf8')).seeds.find(x => /lorn/i.test(x.text)).why)) fail('the reason was not saved'); else ok();

    // SecretCo never enters the file.
    try { taste.teach({ what: 'secretco', why: 'x' }); fail('an SecretCo seed was saved'); } catch { ok(); }

    // Moments: only when the request is ABOUT the moment.
    for (const [q, m] of [['para correr', 'correr'], ['chill', 'chill'], ['para estar en casa', 'casa'], ['algo tranqui', 'chill'], ['deadmau5 para correr', null], ['lorn', null], ['', null]]) {
        if (taste.momentOf(q) !== m) fail(`momentOf("${q}") = ${taste.momentOf(q)}, expected ${m}`); else ok();
    }

    // The sentences, with no model.
    const parse = (s) => understand.parse(understand.flat ? understand.flat(s) : s.toLowerCase(), {});
    for (const [s, q] of [['poneme algo para correr', 'para correr'], ['poneme algo chill', 'chill'], ['ponme musica para estar en casa', 'para estar en casa']]) {
        const p = parse(s);
        if (!p || p.name !== 'play_music' || p.args.query !== q) fail(`"${s}" -> ${p && p.name} ${p && JSON.stringify(p.args)}`); else ok();
    }
    for (const [s, liked, reason] of [['me gusta este tema', 'si', undefined], ['no me gusta este tema, demasiado limpio', 'no', 'demasiado limpio'], ['me encanta esta cancion por el bajo', 'si', 'el bajo']]) {
        const p = parse(s);
        if (!p || p.name !== 'music_react' || p.args.liked !== liked || p.args.reason !== reason) fail(`"${s}" -> ${p && p.name} ${p && JSON.stringify(p.args)}`); else ok();
    }
    for (const s of ['me gusta esto', 'voy a correr', 'no me gusta como quedo el boton']) {
        const p = parse(s);
        if (p && p.sure && /music/.test(p.name)) fail(`"${s}" was read as ${p.name}`); else ok();
    }

    // spotify.js: a named artist is played as named; "sorprendeme" asks the taste.
    const spotify = require(path.join(ROOT, 'lib', 'spotify'));
    const asked = [];
    spotify.configure({
        sleep: async () => {},
        taste: { momentOf: taste.momentOf, pick: () => ({ query: 'Step Two', why: 'vecino', distance: 'step', moment: null }), played: () => {} },
        run: async (args) => {
            if (args[0] === 'search') { asked.push(args[1]); return JSON.stringify({ artists: [{ name: args[1], uri: 'spotify:artist:x' }] }); }
            if (args[0] === 'now-playing') return JSON.stringify({ currently_playing: { is_playing: true, description: 'X' } });
            return '{}';
        },
    });
    const named = await spotify.playMusic('deadmau5');
    if (asked[0] !== 'deadmau5' || named.why) fail('a named artist was replaced by a taste pick'); else ok();
    const sur = await spotify.playMusic('');
    if (asked[1] !== 'Step Two' || sur.why !== 'vecino') fail(`"sorprendeme" did not play his taste (searched ${asked[1]})`); else ok();

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`check-taste: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
