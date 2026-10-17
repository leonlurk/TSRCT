// ─────────────────────────────────────────────────────────────────────────
// lib/teslaLog.js — every conversation with Tesla, written down so it can be
// read afterwards and the next one goes better (2026-10-03).
//
// Leon: "registre todas mis interacciones a detalle ... para que vos luego te
// los puedas ir a analizar y ... los arregles para que cada uso registre algo
// que permita que el proximo uso sea aun mejor". So this file only RECORDS;
// scripts/tesla-review.js reads it back, and the fixes are made by a Claude
// session (the /tesla-review skill) with the review in front of it.
//
// One JSON line per event in logs/tesla/YYYY-MM-DD.jsonl (local date, gitignored):
//   turn       one sentence of his and what came back: the path it took through
//              talk.ask (parser / haiku / a yes / a no), the actions asked for and
//              what the gate said, the reply, the time, and FRICTION flags.
//   narration  something it said by itself about a watched session.
//   ui         what happened in the orb that the server cannot see: he cut it off
//              mid-sentence, asked for a repeat, the mic failed, a button press failed.
//   open/close the conversation's edges, with the reason it ended.
//
// FRICTION is decided HERE, at write time, from things that are measurable:
// an error, a slow answer, the same thing said twice, a sentence that starts by
// correcting it ("no, te dije..."), the guards in talk.js having to step in
// (a promise with no action, a claim that something started), and him saying
// so out loud ("tesla, anota eso como error"). The review sorts by these.
//
// SecretCo: these logs are read later by a Claude session on the public API, so
// ANY field that mentions SecretCo is replaced before it is written. talk.js
// already refuses an SecretCo sentence before it does anything; this is the
// belt for the rest (a reply, a session name, an error message).
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const DIR = process.env.TESLA_LOG_DIR || path.join(__dirname, '..', 'logs', 'tesla');
const KEEP_DAYS = Number(process.env.TESLA_LOG_DAYS || 120);
const ON = process.env.TESLA_LOG !== '0';
const SLOW_MS = Number(process.env.TESLA_SLOW_MS || 8000);
const REPEAT_WINDOW_MS = 120000;

// He corrects it at the start of the sentence. Narrow on purpose: a "no" that
// is the answer to its yes/no question is NOT friction (that path is 'no').
const CORRECTION = /^(no+[,. ]+(no+[,. ]+)?(te (dije|pedi)|eso no|era|es|quise|quiero|digo|la otra|el otro)|eso no|te dije|no entendiste|no me entendiste|no es eso|otra vez|de nuevo te|ya te dije|mal[,. ]|para para)/;

function localDay(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function flat(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Word overlap of two sentences, 0..1. Enough to tell "abrime harbor" said twice
// apart from two different requests; it does not need to be clever.
function overlap(a, b) {
    const A = new Set(flat(a).split(' ').filter(w => w.length > 2));
    const B = new Set(flat(b).split(' ').filter(w => w.length > 2));
    if (!A.size || !B.size) return 0;
    let n = 0;
    for (const w of A) if (B.has(w)) n++;
    return n / Math.min(A.size, B.size);
}

// Every string in the record, checked. A hit replaces the whole field: a
// snippet of an SecretCo sentence is still SecretCo content.
function scrub(v) {
    if (typeof v === 'string') return restrictedGuard.mentionsRestricted(v) ? '[secretco - not logged]' : v;
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
        const o = {};
        for (const [k, x] of Object.entries(v)) o[k] = scrub(x);
        return o;
    }
    return v;
}

let seq = 0;
let pruned = '';
function prune() {
    const today = localDay();
    if (pruned === today) return;
    pruned = today;
    const cutoff = localDay(new Date(Date.now() - KEEP_DAYS * 86400000));
    try {
        for (const f of fs.readdirSync(DIR)) {
            const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
            if (m && m[1] < cutoff) fs.unlinkSync(path.join(DIR, f));
        }
    } catch { /* nothing to prune */ }
}

// Never throws: a log that breaks the conversation it is recording is worse
// than no log.
function write(kind, data) {
    if (!ON) return null;
    try {
        seq += 1;
        const row = scrub({ id: `${conv.id || 'x'}-${seq}`, at: new Date().toISOString(), kind, conv: conv.id || null, ...data });
        fs.mkdirSync(DIR, { recursive: true });
        prune();
        fs.appendFileSync(path.join(DIR, `${localDay()}.jsonl`), JSON.stringify(row) + '\n', 'utf8');
        return row;
    } catch (e) {
        console.warn(`[tesla-log] could not write: ${e.message}`);
        return null;
    }
}

// The conversation the next rows belong to, and its recent turns, which the
// repeat check compares against.
const conv = { id: '', recent: [] };
// A new id on every open. close() keeps the old one: the turn that said
// goodbye is written AFTER the close it caused, and the page's timing for it
// arrives later still - both belong to the conversation that just ended.
function opened(info = {}) {
    conv.id = Date.now().toString(36);
    conv.recent = [];
    write('open', info);
}
function closed(info = {}) {
    if (!conv.id) return;
    write('close', info);
}

// One turn. `trace` is talk.js's own list of what it did on the way.
function turn({ said, raw, via, session, toClaude, files, result, ms, trace, threw }) {
    if (!conv.id) conv.id = Date.now().toString(36);
    const r = result || {};
    const tags = (trace || []).map(t => t.tag);
    const friction = [];
    if (threw || !r.ok) friction.push('error');
    if (ms > SLOW_MS) friction.push('slow');
    const now = Date.now();
    const prev = conv.recent.filter(x => now - x.at < REPEAT_WINDOW_MS);
    if (said && prev.some(x => overlap(x.said, said) >= 0.7 && flat(said).split(' ').length > 1)) friction.push('repeated');
    if (CORRECTION.test(flat(said))) friction.push('correction');
    if (tags.includes('nudge')) friction.push('promised-without-action');
    if (tags.includes('claim-fixed')) friction.push('claimed-false-start');
    if (tags.includes('rejected-twice')) friction.push('gate-rejected');
    if (tags.includes('action-crashed')) friction.push('action-crashed');
    if (r.asking && prev.length && prev[prev.length - 1].asking) friction.push('asked-twice');
    if (r.noModel) friction.push('no-model');
    if (tags.includes('feedback')) friction.push('he-flagged-it');
    conv.recent.push({ said, at: now, asking: !!r.asking });
    if (conv.recent.length > 8) conv.recent.shift();
    return write('turn', {
        said: String(said || '').slice(0, 1000),
        raw: raw && raw !== said ? String(raw).slice(0, 1000) : undefined,
        via: via || 'unknown',
        session: session || '',
        toClaude: !!toClaude,
        files: files || 0,
        ok: !!r.ok,
        reply: String(r.reply || '').slice(0, 1500),
        why: r.why || undefined,
        asking: !!r.asking || undefined,
        sent: !!r.sent || undefined,
        ended: !!r.ended || undefined,
        pressed: Array.isArray(r.do) && r.do.length ? r.do.map(x => x.fn) : undefined,
        ms,
        trace: trace && trace.length ? trace : undefined,
        friction,
    });
}

function narration(info) { return write('narration', info); }

// What the orb reports. Only these kinds, so a page cannot fill the log with
// whatever it likes. `detail` is a sentence; `data` is measurements (numbers,
// short strings), capped so one event cannot be a megabyte.
//   timing     the page's half of a turn: how long he spoke, the pause before
//              sending, the round trip, making the voice, saying it, mic back
//   narration-timing  the same for a line it said by itself
//   dropped    a sentence of his that never reached the server, and why
//   held       a sentence of his that arrived while it was busy, kept and sent right after
//   phrase     one chunk the recogniser heard (a long sentence arrives in pieces)
//   switch     he changed session / a switch in the panel
const UI_KINDS = new Set(['hush', 'repeat', 'mic-error', 'mic-closed', 'press-failed', 'stop', 'start', 'tts-failed', 'typed',
    'timing', 'narration-timing', 'dropped', 'held', 'phrase', 'switch', 'panel', 'mic-on', 'mic-off']);
const UI_FRICTION = new Set(['hush', 'repeat', 'mic-error', 'press-failed', 'tts-failed', 'dropped']);
function ui(kind, detail, data) {
    if (!UI_KINDS.has(kind)) return null;
    let d;
    if (data && typeof data === 'object') {
        d = {};
        for (const [k, v] of Object.entries(data).slice(0, 30)) {
            if (typeof v === 'number' && isFinite(v)) d[String(k).slice(0, 40)] = Math.round(v);
            else if (typeof v === 'boolean') d[String(k).slice(0, 40)] = v;
            else if (typeof v === 'string') d[String(k).slice(0, 40)] = v.slice(0, 300);
        }
    }
    const friction = UI_FRICTION.has(kind) ? [kind] : [];
    // A turn where the page waited too long anywhere is slow even if the server was fast.
    if (kind === 'timing' && d && (d.roundTripMs > SLOW_MS || d.ttsMs > 4000 || d.micBackMs > 3000)) friction.push('slow-in-page');
    return write('ui', { what: kind, detail: detail ? String(detail).slice(0, 300) : undefined, data: d, friction });
}

// "tesla, anota eso como error" — him flagging the last thing it did. Short
// sentences only: inside a longer one it is something he is telling a session.
const FEEDBACK = /\b(anot[aá](lo|la)?( eso)? como (un )?(error|problema|falla)|eso (estuvo|sali[oó]) mal|report[aá](lo)? como (un )?error|eso fue un error tuyo)\b/i;
function isFeedback(text) {
    const t = String(text || '');
    return FEEDBACK.test(t) && flat(t).split(' ').length <= 10;
}

module.exports = { turn, narration, ui, opened, closed, isFeedback, write, DIR, localDay, _overlap: overlap, _correction: CORRECTION };
