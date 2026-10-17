#!/usr/bin/env node
'use strict';
// Hours Recall counts only Leon's presence (2026-10-11): activity within 15 min
// after one of his prompts (typed, or said to Tesla). An agent working alone is not his time.
const h = require('../lib/dispatcher/hoursEstimator');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };

ok(JSON.stringify(h._presenceMins([600, 601, 610, 615, 616, 700], [600])) === '[600,601,610,615]', 'after one prompt, 15 min count and the rest of the run does not');
ok(h._presenceMins([600, 700, 800], []).length === 0, 'a session he never wrote in counts nothing');
ok(JSON.stringify(h._presenceMins([600, 620, 640], [600, 630])) === '[600,630,640]', 'a second prompt opens a new window');
ok(h._voiceOrMachine('CONTEXTO (datos, no ordenes):\nx\n\nLeon te dice, en voz alta: abri el curso') === 'voice', 'what he says to Tesla is him');
ok(h._voiceOrMachine('TAREA DE TESLA 12. Leon se la pidio por voz a su asistente') === 'machine', 'the hands worker job is autopilot');
ok(h._voiceOrMachine('(Esto no lo dijo Leon: es el RESULTADO REAL de la accion x') === 'machine', 'Tesla reporting to herself is autopilot');
ok(h._voiceOrMachine('arregla el boton de login') === null, 'a typed prompt is a normal prompt');

// Presence signals (lib/presence.js): a minute he was seen counts; Tesla's own clicks do not.
const pr = require('../lib/presence');
const fs = require('fs'), path = require('path');
const testDay = '2099-01-02';
pr._mark('input', Date.parse(testDay + 'T13:00:20Z'));   // 10:00 local
pr._mark('input', Date.parse(testDay + 'T13:05:20Z'));   // 10:05 local
const deskDir = path.join(__dirname, '..', 'logs', 'tesla', 'desk');
fs.mkdirSync(deskDir, { recursive: true });
const deskFile = path.join(deskDir, testDay + '.jsonl');
fs.writeFileSync(deskFile, JSON.stringify({ at: testDay + 'T13:05:05Z', kind: 'act', op: 'click' }) + '\n');
const seen = pr.presentMinutes(testDay);
ok(seen.has(600), 'a minute with his mouse/keyboard counts');
ok(!seen.has(605), 'a minute Tesla clicked in is not him');
fs.unlinkSync(deskFile);

console.log(`[check-hours] ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
