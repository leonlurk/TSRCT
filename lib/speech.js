// ─────────────────────────────────────────────────────────────────────────
// lib/speech.js — HOW IT SOUNDS. Two jobs, and they are not the same job.
//
//   shape(text)    what the sentence IS: short, no lists, no markdown, no
//                  headings. Applied to everything the model writes, and to the
//                  log and the subtitle as well, because it is the answer.
//   forVoice(text) how the sentence is READ: only the voice sees this. "tsrct"
//                  is spelled t-s-r-c-t and pronounced "teseract"; 18:29 is
//                  read "las seis y media"; a bare "ok" is not "o k".
//
// Why in code and not in the prompt: the persona has asked for short spoken
// answers since the day it was written, and a 7B still produces a three-clause
// paragraph with a dash list in it about one turn in five. A prompt is a
// request. This is the rule. The same lesson as /plain-brief, which is enforced
// by a hook and not by a reminder.
//
// Nothing here changes MEANING. It cuts, it never rewrites: the last sentence
// of a long answer is dropped, never paraphrased, because paraphrasing is where
// a small model turns "no pude" into "listo".
// ─────────────────────────────────────────────────────────────────────────
'use strict';

// Spoken, so: two sentences. Measured against how long the House voice takes —
// ~14 characters a second — which makes 260 characters about eighteen seconds,
// and eighteen seconds is already a monologue.
const MAX_CHARS = Number(process.env.TALK_MAX_SAY_CHARS || 260);
const MAX_SENTENCES = Number(process.env.TALK_MAX_SENTENCES || 2);
// When HE asks for the explanation ("explicame bien todo", 2026-10-05). Haiku
// wrote 1866 characters, the cut kept two sentences, and he heard the first of
// four findings and then silence: "te estas quedando callada". Haiku's own
// memory holds the whole answer, so it believed it had explained and moved on.
// An explanation he asked for is allowed to be one: ~70 seconds of voice.
const LONG_CHARS = Number(process.env.TALK_LONG_SAY_CHARS || 1000);
const LONG_SENTENCES = Number(process.env.TALK_LONG_SENTENCES || 10);

// ── the shape ───────────────────────────────────────────────────────────────
function shape(text, opts = {}) {
    const maxSentences = opts.long ? LONG_SENTENCES : MAX_SENTENCES;
    const maxChars = opts.long ? LONG_CHARS : MAX_CHARS;
    let t = String(text || '').trim();
    if (!t) return '';
    // Markdown read out loud is noise: asterisks, backticks, hashes, bullets.
    t = t.replace(/[*_`#>|]/g, '');
    // A list is a shape for the eye. Spoken, the dashes become silence and the
    // items run together — so the items become a sentence with commas.
    const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
    const bullets = lines.filter(l => /^([-–•]|\d+[.)])\s+/.test(l));
    if (bullets.length >= 2) {
        const head = lines.find(l => !/^([-–•]|\d+[.)])\s+/.test(l)) || '';
        const items = bullets.map(l => l.replace(/^([-–•]|\d+[.)])\s+/, '').replace(/[.;]$/, ''));
        // Three, then how many are left: a list read out loud stops being a list
        // after the third item.
        const left = items.length - 3;
        const said = items.slice(0, 3).join(', ') + (left > 0 ? ` y ${left === 1 ? 'una' : left} mas` : '');
        t = (head ? `${head.replace(/[.:;,]+$/, '')}: ` : '') + said + '.';
    } else {
        t = lines.join(' ');
    }
    t = t.replace(/\s+/g, ' ').trim();

    // Two sentences. The cut is at a sentence boundary — never mid-clause, and
    // never a rewrite.
    // A sentence ends at . ! ? followed by a space or the end - NOT at the dot
    // inside "farmproweb.vercel.app" (Tesla review #10: the answer was cut to
    // "La pagina farmproweb.vercel.").
    const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (parts.length > maxSentences) t = parts.slice(0, maxSentences).join(' ').trim();
    if (t.length > maxChars) {
        const cut = t.slice(0, maxChars);
        const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
        t = (stop > 60 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '') + '...').trim();
    }
    return t;
}

// ── how it is read ──────────────────────────────────────────────────────────
// The names that come out wrong every single time. Only the VOICE gets these:
// the subtitle and the log keep the real spelling, or he would be reading a
// phonetic transcription of his own project names.
const SOUNDS = [
    [/\btsrct\b/gi, 'teseract'],
    [/\bvrtx\b/gi, 'vertex'],
    [/\bclickup\b/gi, 'clicap'],
    [/\bsf\b/gi, 'ese efe'],
    [/\bpv\b/gi, 'pe ve'],
    [/\bgpu\b/gi, 'ge pe u'],
    [/\bvram\b/gi, 'v ram'],
    [/\bssh\b/gi, 'ese ese hache'],
    [/\bpwa\b/gi, 'pe uve a'],
    [/\bnpm\b/gi, 'ene pe eme'],
    [/\bcwd\b/gi, 'carpeta'],
    [/\btmux\b/gi, 'te mux'],
    [/\bok\b/gi, 'oka'],
    [/\/compact\b/gi, 'compact'],
    [/\/clear\b/gi, 'clear'],
];

const HOURS = ['doce', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once'];

// 18:29 -> "seis y media". A clock read as digits is the single most robotic
// thing the voice does, and he asked for times in words from the start.
function clock(h, m) {
    const hh = HOURS[Number(h) % 12];
    const mm = Number(m);
    if (mm === 0) return `${hh} en punto`;
    if (mm === 30) return `${hh} y media`;
    if (mm === 15) return `${hh} y cuarto`;
    if (mm === 45) return `${HOURS[(Number(h) + 1) % 12]} menos cuarto`;
    return `${hh} y ${mm}`;
}

// `voice` (Tesla review #4): an English line goes to the English voice, which
// reads 18:30 and "ok" well by itself; the Spanish clock and spellings would
// make it say "seis y media" in an American accent.
function forVoice(text, voice) {
    let t = String(text || '');
    const english = /^en[_-]/i.test(String(voice || ''));
    if (!english) t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => clock(h, m));
    // A file path read character by character is unlistenable; the name at the
    // end is the only part he needs.
    t = t.replace(/(?:\/[\w.@-]+){2,}/g, (p) => p.split('/').filter(Boolean).pop());
    for (const [re, say] of SOUNDS) if (!english || re.source === '\\btsrct\\b') t = t.replace(re, say);
    // Underscores and dashes inside a name are pauses, not characters.
    t = t.replace(/([a-z])[_-]([a-z])/gi, '$1 $2');
    return t.replace(/\s+/g, ' ').trim();
}

// ── how it is heard (Tesla review #3, 2026-10-08) ───────────────────────────
// The other direction. The voice says tsrct as "teseract", so he says it that way
// too, and the recogniser writes it down as "teserac": "me abre una sesion de
// teserac" -> "no hay nada que se llame teserac", two turns to open one session.
// Mapped back to the real name before anything reads his sentence. Only forms
// that are not a Spanish word ("tesera" alone is left alone).
const HEARD = [
    [/\bte(?:ss?|z)era(?:c|k|ck|ct|kt)o?\b/gi, 'tsrct'],
];
function fromVoice(text) {
    let t = String(text || '');
    for (const [re, name] of HEARD) t = t.replace(re, name);
    return t;
}

module.exports = { shape, forVoice, fromVoice, MAX_CHARS, MAX_SENTENCES, LONG_CHARS };
