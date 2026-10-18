#!/usr/bin/env node
'use strict';
// ── The personality is data now, so it can be wrong in silence ───────────────
//
// lib/persona.js feeds every spoken answer: the identity block, the voice, and
// the few-shot examples that ARE the character. Two ways it breaks without a
// single error appearing anywhere:
//
//   1. An example's assistant message stops being the JSON the model is asked
//      to imitate. Ollama runs in JSON mode, so the model copies the SHAPE it is
//      shown; a malformed example teaches the wrong shape and every answer after
//      it comes back as "[object Object]" or empty. Nothing throws.
//   2. The identity block stops reaching the prompt. That is not a style
//      regression: it is hermes3 announcing it verified a fix Leon verified
//      (measured 2026-09-19). A wrong actor is a lie about his own work.
//
// So both are asserted here, plus the wiring — that the two spoken paths in
// hermes.js actually build their prompt through persona.system()/examples().
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const persona = require(path.join(ROOT, 'lib/persona.js'));

let failures = 0;
const fail = (m) => { console.error(`  [x] ${m}`); failures++; };
let checks = 0;
const ok = () => { checks++; };

// ── 1. the examples are valid, JSON-shaped, and alternate ──
for (const kind of ['narrate', 'chat']) {
    const ex = persona.examples(kind);
    if (!Array.isArray(ex)) { fail(`examples('${kind}') is not an array`); continue; }
    if (persona.ENABLED && !ex.length) fail(`examples('${kind}') is empty — the personality is the examples`);
    let expect = 'user';
    ex.forEach((m, i) => {
        if (!m || typeof m.content !== 'string' || !m.content) return fail(`${kind}[${i}]: empty message`);
        if (m.role !== expect) fail(`${kind}[${i}]: role is "${m.role}", expected "${expect}" — examples must alternate, starting with the user`);
        expect = m.role === 'user' ? 'assistant' : 'user';
        if (m.role !== 'assistant') return ok();
        let parsed;
        try { parsed = JSON.parse(m.content); } catch (e) {
            return fail(`${kind}[${i}]: the answer is not valid JSON (${e.message}) — it teaches the model the wrong shape`);
        }
        if (typeof parsed.respuesta !== 'string') {
            return fail(`${kind}[${i}]: the answer has no string "respuesta" — that is the field every caller reads`);
        }
        ok();
    });
    if (ex.length && expect !== 'user') fail(`${kind}: ends on a user turn — the last example must be an answer`);
}

// At least one example must teach SILENCE, or the live commentary narrates
// "sigue trabajando" once a minute until he switches it off.
if (persona.ENABLED) {
    const silent = persona.examples('narrate')
        .some(m => m.role === 'assistant' && JSON.parse(m.content).respuesta === '');
    if (!silent) fail('no narrate example teaches an EMPTY answer — nothing worth saying must be sayable');
    else ok();
}

// ── 2. the identity block survives assembly, personality on AND off ──
const built = persona.system('TRABAJO DE PRUEBA');
if (!built.includes('TRABAJO DE PRUEBA')) fail('persona.system() dropped the caller\'s job description');
else ok();
// The cast, by the assistant's CURRENT name — "Hermes" is the engine and Leon
// does not use it; he says House, dr casa, doc. The check follows the name.
const OWNER = (() => { try { return require(path.join(ROOT, 'lib/owner.js')).NAME; } catch { return 'the owner'; } })();
for (const marker of [persona.NAME.toUpperCase(), OWNER.toUpperCase(), 'CLAUDE']) {
    if (!built.toUpperCase().includes(marker)) fail(`the assembled prompt never names ${marker} — the cast has to be stated`);
    else ok();
}
// Every name he might say has to reach the "this is for you" pattern, or a
// sentence meant for the assistant is typed into a live session instead.
{
    const re = persona.addressedPattern();
    for (const alias of persona.ALIASES) {
        if (!re.test(`${alias}, que esta pasando`)) fail(`"${alias}" is listed as a name but the addressed pattern does not match it`);
        else ok();
    }
    // ...and an ordinary sentence must NOT be mistaken for one.
    for (const plain of ['corre los tests', 'housekeeping del repo', 'documenta eso']) {
        if (re.test(plain)) fail(`"${plain}" is read as addressing the assistant — it would never reach the session`);
        else ok();
    }
}
if (!persona.IDENTITY || persona.IDENTITY.length < 100) fail('IDENTITY is missing or too short to be the rule it has to be');
else ok();

// ── 3. temperature: a character needs room, a runaway is not a character ──
if (!(persona.TEMPERATURE > 0.3 && persona.TEMPERATURE <= 1.2)) {
    fail(`TALK_TEMPERATURE is ${persona.TEMPERATURE} — below ~0.3 every answer is the same flat report, above ~1.2 it stops answering the question`);
} else ok();

// ── 4. the wiring: the spoken paths must go through it ──
const h = fs.readFileSync(path.join(ROOT, 'lib/dispatcher/hermes.js'), 'utf8');
for (const fn of ['converse', 'narrateSession']) {
    const i = h.indexOf(`async function ${fn}(`);
    if (i < 0) { fail(`hermes.js: ${fn}() not found`); continue; }
    const rest = h.slice(i + 1);
    const end = rest.search(/\n(?:async )?function \w/);
    const body = end < 0 ? rest : rest.slice(0, end);
    if (!/persona\.system\(/.test(body)) fail(`hermes.js: ${fn}() does not build its system prompt with persona.system()`);
    else ok();
    if (!/persona\.examples\(/.test(body)) fail(`hermes.js: ${fn}() sends no examples — the personality is the examples`);
    else ok();
    if (!/temperature/.test(body)) fail(`hermes.js: ${fn}() does not set a temperature, so it inherits the classifier's 0.2 and speaks flat`);
    else ok();
}

// ── 5. whose assistant: OWNER_NAME, never a name written into the code ──────
// Tesla was written for one person, and 72 lines of her prompts said "Leon":
// anyone else who installed TSRCT was called Leon. The name now comes from
// OWNER_NAME (lib/owner.js); here it is set to another name in a fresh process.
{
    const { spawnSync } = require('child_process');
    const probe = spawnSync(process.execPath, ['-e', `
        const p = require('./lib/persona'); const o = require('./lib/owner');
        console.log(JSON.stringify({ name: o.NAME, identity: p.IDENTITY, built: p.system('X') }));
    `], { cwd: ROOT, env: { ...process.env, OWNER_NAME: 'Ana' }, encoding: 'utf8' });
    let got = null;
    try { got = JSON.parse(probe.stdout); } catch { fail(`lib/owner.js or persona does not load with OWNER_NAME set: ${(probe.stderr || '').split('\n').find(Boolean) || ''}`); }
    if (got) {
        if (got.name !== 'Ana') fail(`lib/owner.js NAME is "${got.name}", not the OWNER_NAME given`); else ok();
        if (!/Ana/.test(got.built) || /\bLeon\b/i.test(got.built)) fail('the assembled prompt does not name the owner from OWNER_NAME'); else ok();
    }
    // No line of code may spell a person's name: every prompt reads lib/owner.js.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const files = [...walk(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js')), path.join(ROOT, 'server.js')];
    const named = [];
    for (const f of files) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
            const code = l.replace(/^\s*(\/\/|\*|--).*$/, '').replace(/\s\/\/\s.*$/, '');
            if (/\bLeon\b|\bLEON\b/.test(code)) named.push(`${path.relative(ROOT, f)}:${i + 1}`);
        });
    }
    if (named.length) fail(`${named.length} line(s) of code still say "Leon" instead of reading lib/owner.js: ${named.slice(0, 8).join(', ')}${named.length > 8 ? ' ...' : ''}`); else ok();
}

// ── 6. which language: OWNER_LANG is the default, what he speaks still wins ──
// Spanish was written into the prompts, the spoken brief and the browser's
// recogniser. OWNER_LANG (es | en) is the language Tesla uses until the person
// speaks another one; the page learns it from a meta tag the server writes.
{
    const { spawnSync } = require('child_process');
    const probe = spawnSync(process.execPath, ['-e', `
        const o = require('./lib/owner');
        console.log(JSON.stringify({ lang: o.LANG, name: o.LANG_NAME }));
    `], { cwd: ROOT, env: { ...process.env, OWNER_LANG: 'en' }, encoding: 'utf8' });
    let got = null;
    try { got = JSON.parse(probe.stdout); } catch { fail('lib/owner.js does not load with OWNER_LANG set'); }
    if (got) { if (got.lang !== 'en' || got.name !== 'English') fail(`OWNER_LANG=en reads as ${JSON.stringify(got)}`); else ok(); }
    const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const rules = [
        ['lib/talk.js', /state\.lang \|\| OWNER_LANG\b/, 'the voice falls back to OWNER_LANG, not to Spanish'],
        ['lib/haikuBrain.js', /\(lang \|\| OWNER_LANG\) === 'en'/, 'the brain answers in OWNER_LANG unless he speaks another language'],
        ['lib/morningRoutine.js', /\$\{LANG_NAME\}/, 'the spoken brief is written in OWNER_LANG'],
        ['lib/promptWriter.js', /\$\{LANG_NAME\}/, 'the prompt writer summarises in OWNER_LANG'],
        ['server.js', /tsrct-lang/, 'the page is told the language (meta tsrct-lang)'],
        ['src/js/desktop.js', /tsrct-lang/, 'the recogniser starts in that language'],
    ];
    for (const [f, re, what] of rules) { if (!re.test(src(f))) fail(`${f}: ${what}`); else ok(); }
    for (const f of ['lib/morningRoutine.js', 'lib/promptWriter.js', 'lib/tasteBrain.js']) {
        if (/in neutral Latin American Spanish|sentence in Spanish|\(Spanish,/.test(src(f))) fail(`${f} still asks for Spanish by name`); else ok();
    }
}

if (failures) {
    console.error(`\n[check-persona] ${failures} failure(s). The character is in lib/persona.js — that is the file to fix.`);
    process.exit(1);
}
console.log(`[check-persona] ${checks}/${checks} — examples well-formed, identity stated, temperature sane, both spoken paths wired`);
