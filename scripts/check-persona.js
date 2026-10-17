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
for (const marker of [persona.NAME.toUpperCase(), 'LEON', 'CLAUDE']) {
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

if (failures) {
    console.error(`\n[check-persona] ${failures} failure(s). The character is in lib/persona.js — that is the file to fix.`);
    process.exit(1);
}
console.log(`[check-persona] ${checks}/${checks} — examples well-formed, identity stated, temperature sane, both spoken paths wired`);
