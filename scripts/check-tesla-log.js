#!/usr/bin/env node
// scripts/check-tesla-log.js — the conversation log (lib/teslaLog.js): it writes
// one line per turn, flags the friction it can measure, never writes SecretCo, and
// the orb can only log the kinds it allows. Writes into a temp dir.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-log-'));
process.env.TESLA_LOG_DIR = tmp;
const log = require('../lib/teslaLog');

let fails = 0, n = 0;
function ok(cond, what) { n++; if (!cond) { fails++; console.log(`  FAIL ${what}`); } }
const read = () => fs.readFileSync(path.join(tmp, `${log.localDay()}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));

log.opened({ session: 'tsrct' });
const a = log.turn({ said: 'abrime una sesion en harbor', via: 'voice', result: { ok: true, reply: 'Queres que abra harbor?', asking: true }, ms: 1200, trace: [{ tag: 'path', detail: 'haiku' }] });
ok(a && a.friction.length === 0, 'a clean turn has no friction');
const b = log.turn({ said: 'abrime una sesion en harbor', via: 'voice', result: { ok: true, reply: 'Queres que abra harbor?', asking: true }, ms: 9000, trace: [] });
ok(b.friction.includes('repeated'), 'the same request twice is "repeated"');
ok(b.friction.includes('slow'), 'over 8s is "slow"');
ok(b.friction.includes('asked-twice'), 'two questions in a row is "asked-twice"');
const c = log.turn({ said: 'no, te dije la de tsrct', result: { ok: false, why: 'x' }, ms: 100, trace: [{ tag: 'nudge' }, { tag: 'claim-fixed' }] });
ok(c.friction.includes('correction'), '"no, te dije" is a correction');
ok(c.friction.includes('error'), 'a failed turn is an error');
ok(c.friction.includes('promised-without-action') && c.friction.includes('claimed-false-start'), 'the talk.js guards are flagged');
const d = log.turn({ said: 'no', result: { ok: true, reply: 'Listo, no lo hice.' }, ms: 50 });
ok(!d.friction.includes('correction'), 'a plain "no" to its question is not a correction');

const e = log.turn({ said: 'que pasa con secretco', result: { ok: true, reply: 'nada de secretco' }, ms: 10 });
ok(e.said === '[secretco - not logged]' && e.reply === '[secretco - not logged]', 'SecretCo is never written');
ok(!/que pasa con secretco/.test(fs.readFileSync(path.join(tmp, `${log.localDay()}.jsonl`), 'utf8')), 'the SecretCo sentence is not in the file');

ok(log.ui('hush', 'una frase larga').friction[0] === 'hush', 'hush is logged as friction');
ok(log.ui('rm -rf', 'x') === null, 'an unknown orb kind is dropped');

ok(log.isFeedback('tesla, anota eso como error'), 'feedback phrase is recognised');
ok(log.isFeedback('eso estuvo mal'), 'short "eso estuvo mal" is feedback');
ok(!log.isFeedback('decile a la sesion que el test de ayer eso estuvo mal hecho y que lo rehaga entero por favor ya'), 'inside a long sentence it is not');

log.closed({ reason: 'said' });
const rows = read();
ok(rows[0].kind === 'open' && rows[rows.length - 1].kind === 'close', 'open and close are written');
ok(rows.filter(r => r.kind === 'turn').every(r => r.conv === rows[0].conv), 'turns carry the conversation id');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`check-tesla-log: ${n - fails}/${n} ok`);
process.exit(fails ? 1 : 0);
