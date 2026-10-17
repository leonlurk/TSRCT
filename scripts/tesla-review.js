#!/usr/bin/env node
// scripts/tesla-review.js — reads logs/tesla/*.jsonl (lib/teslaLog.js) back and
// prints what a fixing session needs: how the conversations went, where they
// were slow or wrong, and each friction moment WITH the turns around it, so the
// cause can be read instead of guessed.
//
//   node scripts/tesla-review.js              since the last review (or 7 days)
//   node scripts/tesla-review.js --since 2026-10-01
//   node scripts/tesla-review.js --all
//   node scripts/tesla-review.js --full       also every conversation, row by row
//   node scripts/tesla-review.js --mark       also record today as reviewed
//   node scripts/tesla-review.js --desk       also every step she took on the PC (lib/desk.js)
//
// Read-only except --mark, which writes logs/tesla/.reviewed.
'use strict';

const fs = require('fs');
const path = require('path');
const { DIR, localDay } = require('../lib/teslaLog');

const argv = process.argv.slice(2);
const MARK = path.join(DIR, '.reviewed');
let since = '';
if (argv.includes('--all')) since = '0000-00-00';
else if (argv.includes('--since')) since = argv[argv.indexOf('--since') + 1] || '';
else {
    try { since = fs.readFileSync(MARK, 'utf8').trim(); } catch { since = ''; }
    if (!since) since = localDay(new Date(Date.now() - 7 * 86400000));
}

let files = [];
try { files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= since).sort(); } catch { files = []; }
const rows = [];
for (const f of files) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* a torn line */ }
    }
}
// Her hands on the PC (lib/desk.js): a separate log, read even with no conversation.
const DESK_DIR = path.join(DIR, 'desk');
let deskFiles = [];
try { deskFiles = fs.readdirSync(DESK_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= since).sort(); } catch { deskFiles = []; }
const desk = [];
for (const f of deskFiles) {
    for (const l of fs.readFileSync(path.join(DESK_DIR, f), 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { desk.push(JSON.parse(l)); } catch { /* a torn line */ }
    }
}
process.on('exit', () => { if (desk.length) deskReport(); });

// Grouped into stretches (one task is a run of steps with no gap over 3 min).
// Each stretch: what happened, and every step when anything went wrong in it,
// with the screenshot she saw (kept DESK_KEEP_DAYS) so the review can open it.
function deskReport() {
    const sec1 = (v) => typeof v === 'number' ? (v / 1000).toFixed(1) + 's' : '-';
    const med = (v) => { v = v.filter(x => typeof x === 'number').sort((a, b) => a - b); return v.length ? sec1(v[Math.floor(v.length / 2)]) : '-'; };
    // `refused` is a sentence on a refusal and a list (maybe empty) of dropped monitors on a look.
    const isRefused = (r) => Array.isArray(r.refused) ? r.refused.length > 0 : !!r.refused;
    const stretches = [];
    for (const r of desk) {
        const cur = stretches[stretches.length - 1];
        if (!cur || Date.parse(r.at) - Date.parse(cur[cur.length - 1].at) > 180000) stretches.push([r]); else cur.push(r);
    }
    const acts = desk.filter(r => r.kind === 'act');
    const looks = desk.filter(r => r.kind === 'look');
    console.log(`\nDESK (Tesla on the PC)  ${stretches.length} stretches · ${looks.length} looks (median ${med(looks.map(r => r.ms))}) · ${acts.length} acts (median ${med(acts.map(r => r.ms))})`);
    console.log(`  refused ${desk.filter(r => isRefused(r) && !r.humanTook).length} · he took the mouse ${desk.filter(r => r.humanTook).length} · errors ${desk.filter(r => r.error).length} · screenshots kept in ${path.join(DESK_DIR, 'shots')}`);
    // Direct paths vs the mouse (TESLA-PC-PATHS.md phase 9): the more of the
    // first, the faster she is. A stretch of clicks with no path in it is a
    // candidate for a new shortcut, routine or link (lib/deskShortcuts.js).
    const PATH_KINDS = ['place', 'solo', 'layout-save', 'layout-restore', 'workspace', 'zones', 'shortcut', 'routine', 'settings', 'spotify-search', 'lock'];
    const paths = desk.filter(r => PATH_KINDS.includes(r.kind));
    const mouse = acts.filter(r => ['click', 'double', 'right', 'scroll', 'type'].includes(r.op));
    console.log(`  direct paths ${paths.length} (${Object.entries(paths.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {})).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}) · mouse/typing steps ${mouse.length}`);
    const step = (r) => {
        const t = r.at.slice(11, 19);
        const bad = r.error ? `  ERROR: ${r.error}` : isRefused(r) ? `  REFUSED: ${typeof r.refused === 'string' ? r.refused : JSON.stringify(r.refused)}` : '';
        if (r.kind === 'look') return `  ${t} look${r.screen ? ' s' + r.screen : ''} ${sec1(r.ms)}${(r.shots || []).map(s => ` [s${s.screen} ${s.kept || ''}]`).join('')}${bad}`;
        if (PATH_KINDS.includes(r.kind)) return `  ${t} PATH ${r.kind} ${r.name || r.window || r.keep || r.layout || r.page || ''}${r.slot ? ' ' + r.slot : ''}${r.missing && r.missing.length ? ' missing ' + r.missing.join(',') : ''} ${sec1(r.ms)}${r.ok === false ? '  FAILED ' + (r.why || '') : ''}${bad}`;
        const where = r.x !== undefined ? ` s${r.screen} (${r.x},${r.y})` : '';
        const what = r.keys ? ` ${r.keys}` : r.text !== undefined ? ` "${r.text}"${r.textLength > 300 ? ` (+${r.textLength - 300} chars)` : ''}` : r.amount !== undefined ? ` ${r.amount}` : '';
        return `  ${t} ${r.op}${where}${what} ${sec1(r.ms)}${r.front ? ` -> front: ${r.front}` : ''}${bad}`;
    };
    for (const st of stretches) {
        const troubled = st.some(r => r.error || isRefused(r));
        const a = st.filter(r => r.kind === 'act').length;
        const clicks = st.filter(r => r.kind === 'act' && ['click', 'double', 'right', 'type'].includes(r.op)).length;
        const candidate = clicks >= 3 && !st.some(r => PATH_KINDS.includes(r.kind)) ? `  (${clicks} clicks/typing, no direct path: candidate for a new shortcut)` : '';
        console.log(`\n-- ${st[0].at.slice(0, 16).replace('T', ' ')}  ${a} acts, ${st.length - a} looks, ${sec1(Date.parse(st[st.length - 1].at) - Date.parse(st[0].at))}${troubled ? '  (trouble)' : ''}${candidate}`);
        if (troubled || argv.includes('--full') || argv.includes('--desk')) for (const r of st) console.log(step(r));
    }
    console.log('  The worker\'s own reasoning for each step is in the `hands` transcript of that time (logs/tesla-workarounds.md names the task).');
}

if (!rows.length) { console.log(`No Tesla conversations logged since ${since} (${DIR}).`); process.exit(0); }

const turns = rows.filter(r => r.kind === 'turn');
const convs = new Set(rows.map(r => r.conv).filter(Boolean));
const ms = turns.map(t => t.ms || 0).sort((a, b) => a - b);
const pct = (p) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : 0;
const count = (list) => list.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ') || '-';

const paths = count(turns.map(t => {
    const p = (t.trace || []).find(x => x.tag === 'path');
    if (p) return p.detail.startsWith('parser') ? 'parser' : p.detail.split(' ')[0] === 'yes' ? 'yes' : p.detail.split(' ')[0] === 'no' ? 'no' : p.detail;
    return (t.trace || []).some(x => x.tag === 'feedback') ? 'feedback' : 'other';
}));
const friction = count(rows.flatMap(r => r.friction || []));
const actionsAsked = count(turns.flatMap(t => (t.trace || []).filter(x => x.tag.startsWith('action-')).map(x => `${x.tag.slice(7)}:${String(x.detail).split(/[ :]/)[0]}`)));
const ends = count(rows.filter(r => r.kind === 'close').map(r => r.reason));
const uis = count(rows.filter(r => r.kind === 'ui').map(r => r.what));

console.log(`TESLA REVIEW  ${files[0].slice(0, 10)} .. ${files[files.length - 1].slice(0, 10)}`);
console.log(`conversations ${convs.size} · turns ${turns.length} · narrations ${rows.filter(r => r.kind === 'narration').length} · typed ${turns.filter(t => t.via === 'typed').length} / voice ${turns.filter(t => t.via === 'voice').length}`);
console.log(`latency  median ${(pct(0.5) / 1000).toFixed(1)}s · p90 ${(pct(0.9) / 1000).toFixed(1)}s · max ${(pct(1) / 1000).toFixed(1)}s`);
console.log(`paths    ${top(paths)}`);
console.log(`actions  ${top(actionsAsked)}`);
console.log(`friction ${top(friction)}`);
console.log(`orb      ${top(uis)}`);
console.log(`ended by ${top(ends)}`);

// Where the time goes, as he lives it (page) and inside the server.
const sec = (v) => v == null ? '-' : (v / 1000).toFixed(1) + 's';
const stat = (vals) => {
    const v = vals.filter(x => typeof x === 'number').sort((a, b) => a - b);
    if (!v.length) return '-';
    return `median ${sec(v[Math.floor(v.length / 2)])} · p90 ${sec(v[Math.min(v.length - 1, Math.floor(v.length * 0.9))])} · max ${sec(v[v.length - 1])} (n ${v.length})`;
};
const timings = rows.filter(r => r.kind === 'ui' && r.what === 'timing').map(r => r.data || {});
const steps = turns.flatMap(t => (t.trace || []).filter(x => x.data && typeof x.data.ms === 'number'));
const byStep = steps.reduce((m, x) => ((m[x.tag] = m[x.tag] || []).push(x.data.ms), m), {});
console.log('\nTIMING (his side, from the page)');
console.log(`  felt wait (his last word -> its first word)  ${stat(timings.map(t => t.feltWaitMs))}`);
console.log(`  he spoke for                                 ${stat(timings.map(t => t.speakMs))}`);
console.log(`  pause before sending                         ${stat(timings.map(t => t.pauseMs))}`);
console.log(`  round trip to the server                     ${stat(timings.map(t => t.roundTripMs))}`);
console.log(`  making the voice                             ${stat(timings.map(t => t.ttsMs))}`);
console.log(`  the voice talking                            ${stat(timings.map(t => t.audioMs))}`);
console.log(`  mic back after it spoke                      ${stat(timings.map(t => t.micBackMs))}`);
console.log(`  from its last word to his next               ${stat(timings.map(t => t.sinceItsLastWordMs))}`);
console.log('TIMING (server steps)');
for (const [k, v] of Object.entries(byStep).sort()) console.log(`  ${k.padEnd(44)} ${stat(v)}`);
const hk = steps.filter(x => x.data.haiku);
if (hk.length) {
    console.log(`  haiku: own answer ${stat(hk.map(x => x.data.haiku.answerMs))}`);
    console.log(`  haiku: waiting behind another question ${stat(hk.map(x => x.data.haiku.waitMs))}`);
    const pasted = hk.map(x => x.data.haiku.pasteMs).filter(v => typeof v === 'number');
    if (pasted.length) console.log(`  haiku: typing the question in ${stat(pasted)}`);
}
const boots = steps.filter(x => x.data.bootMs);
if (boots.length) console.log(`  haiku cold starts inside a turn: ${boots.length}, ${stat(boots.map(x => x.data.bootMs))}`);
const dropped = rows.filter(r => r.kind === 'ui' && r.what === 'dropped');
if (dropped.length) {
    console.log(`\nLOST SENTENCES (${dropped.length}) - he said it, the server never got it`);
    for (const r of dropped) console.log(`  ${r.at.slice(5, 19)} "${r.detail}" (${(r.data || {}).why})`);
}

// Each friction moment with two turns before it and the one after, in order.
const flagged = rows.map((r, i) => ({ r, i })).filter(x => (x.r.friction || []).length);
console.log(`\nFRICTION MOMENTS (${flagged.length})`);
const line = (r) => {
    const t = r.at.slice(11, 19);
    if (r.kind === 'turn') {
        const tr = (r.trace || []).map(x => `${x.tag}@${sec(x.t)}` + (x.data ? `(${JSON.stringify(x.data).slice(0, 140)})` : x.detail ? `(${x.detail.slice(0, 90)})` : '')).join(' > ');
        return `  ${t} [${r.via}${r.session ? ' @' + r.session : ''}] LEON: ${r.said}\n           TESLA (${((r.ms || 0) / 1000).toFixed(1)}s${r.ok ? '' : ', FAILED: ' + r.why}): ${r.reply || ''}`
            + (tr ? `\n           path: ${tr}` : '');
    }
    if (r.kind === 'narration') return `  ${t} narration @${r.session}: ${r.said}`;
    if (r.kind === 'ui') return `  ${t} orb: ${r.what} ${r.detail || ''}${r.data ? ' ' + Object.entries(r.data).map(([k, v]) => `${k}=${typeof v === 'number' && /Ms$/.test(k) ? sec(v) : v}`).join(' ') : ''}`;
    if (r.kind === 'open') return `  ${t} -- conversation opened${r.session ? ' @' + r.session : ''}`;
    if (r.kind === 'close') return `  ${t} -- conversation closed (${r.reason}, ${r.turns} turns, ${r.minutes} min)`;
    return `  ${t} ${r.kind} ${JSON.stringify(r).slice(0, 160)}`;
};
let lastShown = -1;
for (const { r, i } of flagged) {
    if (i <= lastShown) { console.log(`   ^ also flagged ${(r.friction || []).join(', ')}: ${r.kind === 'turn' ? r.said : r.detail || r.what || r.kind}`); continue; }
    const from = Math.max(lastShown + 1, i - 2);
    console.log(`\n-- ${(r.friction || []).join(', ')} (${r.at.slice(0, 10)}, conv ${r.conv || '?'})`);
    for (let j = from; j <= Math.min(rows.length - 1, i + 1); j++) if ((rows[j].conv === r.conv || rows[j].kind === 'ui') && rows[j].what !== 'phrase') console.log((j === i ? '>' : ' ') + line(rows[j]).slice(1));
    lastShown = i + 1;
}

// --full: every conversation, every row in order (phrases included), with friction marked.
if (argv.includes('--full')) {
    console.log('\nFULL TRANSCRIPT');
    let cur = null;
    for (const r of rows) {
        if (r.conv !== cur) { cur = r.conv; console.log(`\n== conversation ${cur || '?'}`); }
        console.log(((r.friction || []).length ? '!' : ' ') + line(r).slice(1) + ((r.friction || []).length ? `   <- ${r.friction.join(', ')}` : ''));
    }
}

if (argv.includes('--mark')) { fs.writeFileSync(MARK, localDay() + '\n'); console.log(`\nmarked reviewed through ${localDay()}`); }
