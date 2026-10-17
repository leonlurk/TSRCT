'use strict';
// ── What a Claude Code pane LOOKS like — the one place that knows ────────────
//
// WHY THIS FILE EXISTS (incident 2026-08-25):
// The same two questions — "is this pane mid-turn?" and "is Claude's input box on
// screen?" — were answered by three independent copies of the same regexes:
// server.js paneWorkState(), lib/sessionWeight.js looksLikeClaudePrompt(), and
// lib/dispatcher/outputParser.js looksLikeWorking(). Claude Code shipped a new TUI
// (the composer went from a rounded `╭─ │ > ╰─` box with a "? for shortcuts" hint
// to a `❯` line fenced by two full-width rules; the spinner went from braille
// `⠋⠙⠹` + "esc to interrupt" to `✢ Forging… (6m 7s · ↓ 27.7k tokens)`), and all
// three copies went blind on the same day:
//   - the one-click handoff aborted instantly with "this session is not sitting at
//     a Claude prompt", because the box it was looking for no longer exists;
//   - worse, waitPaneIdle() read two ACTIVELY WORKING panes as idle, which is the
//     one failure the idle contract exists to prevent (a /compact or a paste
//     mid-turn corrupts the session).
// Three copies is why one TUI release broke three subsystems. There is now one.
//
// Deliberately ZERO dependencies: sessionWeight.js and server.js must be able to
// require it standalone, never through `dispatcher.*` (same contract as
// restrictedGuard.js — a boundary must not depend on an optional subsystem loading).
//
// RULE FOR THE NEXT TUI CHANGE: add the new shape, KEEP the old one. Both builds
// exist on this machine at once (a pane started yesterday is still running the
// old binary), and an OR of shapes costs nothing.

// Strip ANSI so every heuristic below matches on clean text.
function stripAnsi(s) {
    return String(s || '')
        .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B[=>]/g, '');
}

// ── Is the pane mid-turn? ────────────────────────────────────────────────────
// These are the strongest "do NOT inject" markers. Anything that matches means
// Claude has NOT finished, whatever else is on screen.
const WORKING_PATTERNS = [
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,              // braille spinner (pre-2026-08 TUI)
    /\.{3}\s*$/,                     // trailing "..." (pre-2026-08 TUI)
    /\besc to interrupt\b/i,         // the live-turn footer, both TUIs
    /\bstill running\b/i,            // a background agent/monitor is going
    // 2026-08 TUI: "<Verb>… (<elapsed> · ↓ <n> tokens)". The discriminator is the
    // ellipsis followed by a PARENTHESISED ELAPSED TIMER — the finished-turn line
    // ("✻ Sautéed for 1m 49s") has no ellipsis and no parens, and ordinary prose
    // does not put a running clock in brackets. Accepts "…" or "..." so the same
    // rule covers a build that renders the ellipsis as three dots.
    /(?:…|\.{3})\s*\(\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+(?:\.\d+)?\s*(?:ms|s)\b/,
];

// ── Background shells ────────────────────────────────────────────────────────
// INCIDENT 2026-08-25, second round (session piel-2). The 2026-08 TUI reports a
// `&`-backgrounded shell in TWO places, and keeps reporting it for as long as
// that shell lives — which can be hours:
//
//     ✻ Cooked for 42s · 1 shell still running        <- the END-OF-TURN line
//     ────────────────────────────────────────
//     ❯ ok mientras tanto, escuche la mezcla
//     ────────────────────────────────────────
//       [5h 25%] [7d 47%] [ctx 41%] Opus 5 · ro
//       ⏸ manual mode on · 1 shell · ← for agents     <- the MODE line
//
// The turn is OVER — "Cooked for 42s" says so. A shell simply outlived it. But
// the bare /\bstill running\b/ rule read that as mid-turn, so waitPaneIdle spun
// out its full 180s timeout on a pane that was sitting at its prompt the whole
// time, then failed with "the session never went idle". It could never have
// succeeded: the counter does not go away.
//
// The rule was answering the wrong question. It asks whether some BACKGROUND
// process is alive; what the idle contract needs to know is whether the TURN is
// alive. A background shell does not stop you typing into the composer, so it
// must not stop us either.
//
// It is still worth KNOWING about, which is why this is a separate question with
// its own answer: the handoff kills the old session at the end, and that kills
// the background shell with it. Whether that matters is the user's call, not
// ours — so the handoff refuses and says so, rather than deciding either way.
const SHELLS_STILL_RUNNING = /\b(\d+)\s+shells?\s+still\s+running\b/i;
const SHELLS_IN_MODE_LINE = /·\s*(\d+)\s+shells?\s*·/i;

// How many background shells the pane is reporting. 0 when it reports none.
function backgroundShells(tail) {
    const t = String(tail || '');
    let n = 0;
    for (const re of [SHELLS_STILL_RUNNING, SHELLS_IN_MODE_LINE]) {
        const m = re.exec(t);
        if (m) n = Math.max(n, parseInt(m[1], 10) || 0);
    }
    return n;
}

function looksLikeWorking(tail) {
    // Strip the background-shell counter BEFORE the patterns run, so its
    // "still running" cannot be mistaken for a live turn. The bare form is left
    // in WORKING_PATTERNS for any build that uses it to mean exactly that.
    const t = String(tail || '').replace(new RegExp(SHELLS_STILL_RUNNING.source, 'gi'), ' ');
    return WORKING_PATTERNS.some((re) => re.test(t));
}

// ── Is Claude's input box actually on screen? ────────────────────────────────
// POSITIVE evidence only — anything less counts as "not ready", fail closed. The
// caller uses this before pasting, because "the pane stopped moving" is ALSO true
// of a bash prompt sitting there doing nothing (see the tsrct-2 incident note in
// lib/sessionWeight.js).
// Claude's first-run "do you trust this folder?" menu. It has a `❯` cursor and
// `─` rules like the composer, so without this it passed for the input box: the
// morning routine pasted its prompt into it and the Enter picked "No, exit"
// (c7-recon, 2026-09-21). This file only READS it; whether to answer is the
// caller's decision (sessionSpawn, and only for folders he already trusts).
function looksLikeTrustDialog(tail) {
    const t = String(tail || '');
    return /trust this folder|Quick safety check|Do you trust the files/i.test(t)
        && /No, exit|Yes, (I trust|proceed)/i.test(t);
}

// The keys that move the menu cursor onto "Yes" and confirm it, read off the
// screen rather than assumed: builds differ on which option comes first, and a
// blind Enter picks "No, exit" (2026-09-23). null when the cursor or the Yes line
// is not clearly visible - a wrong guess here exits Claude.
function trustAnswerKeys(tail) {
    const t = String(tail || '');
    if (!looksLikeTrustDialog(t)) return null;
    const options = t.split('\n').filter(l => /No, exit|Yes, (I trust|proceed)/i.test(l));
    const yes = options.findIndex(l => /Yes, (I trust|proceed)/i.test(l));
    const cursor = options.findIndex(l => /^\s*[❯>]/.test(l));
    if (yes < 0 || cursor < 0) return null;
    const move = yes > cursor ? 'Down' : 'Up';
    return [...Array(Math.abs(yes - cursor)).fill(move), 'Enter'];
}

function looksLikeClaudePrompt(tail) {
    const t = String(tail || '');
    if (looksLikeTrustDialog(t)) return false;
    if (/\?\s+for shortcuts/i.test(t)) return true;                    // old hint line
    if (/│\s*>/.test(t) && /[╭╰]─{3,}[╮╯]/.test(t)) return true;       // old rounded box
    // 2026-08 TUI: a `❯` composer line fenced by full-width `─` rules. BOTH halves
    // are required — `❯` alone is a common shell prompt glyph (starship, zsh), and
    // a rule alone is any separator Claude ever printed.
    if (/^\s*❯/m.test(t) && /^\s*─{20,}\s*$/m.test(t)) return true;
    // Same TUI, footer form: the mode line under the composer. Kept as a second
    // way in, because the rules scroll off a pane whose last output was very wide.
    if (/(?:manual|auto|plan) mode on\b/i.test(t) && /\bfor agents\b/i.test(t)) return true;
    return false;
}

// The tsrct-2 signature, kept so an abort message can name what it actually saw
// instead of shrugging with a generic timeout.
function looksLikeShellPrompt(tail) {
    const t = String(tail || '');
    const lines = t.split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1] || '';
    // Guard against the new composer: "❯" with no rules around it would otherwise
    // read as a shell prompt on a pane that is really Claude mid-repaint.
    if (looksLikeClaudePrompt(t)) return false;
    if (/[$#]\s*$/.test(last)) return true;
    return /\bcommand not found\b/i.test(t) || /\bsyntax error\b/i.test(t);
}

// Everything above reads the TAIL, not the whole capture. Doing it in one place
// so the `.trim()`-before-slice rule cannot be forgotten again: tmux pads a
// capture with blank lines up to the pane height (1000 rows here), and slicing
// the last 20 lines WITHOUT trimming first lands entirely inside that padding —
// hiding the live status line and reading a working pane as idle.
function tailOf(raw, lines = 20) {
    return stripAnsi(raw).trim().split('\n').slice(-lines).join('\n');
}

// ── What is READABLE on the pane ────────────────────────────────────────────
// tailOf() above answers "what does the screen look like" for the heuristics.
// This answers a different question: "what would a person READ off this screen".
//
// WHY IT EXISTS (2026-09-19): TOWER handed the raw capture to the local model and
// its summaries were junk, because two thirds of a Claude Code pane is furniture —
// full-width rules, the rounded composer box, the spinner line, the token/context
// footer, the mode line. A model given 40 lines of box drawing summarises the box.
// Every line dropped here is CHROME, never content: the rule is that removing it
// changes nothing a human would have read out loud.
const CHROME = [
    /^\s*[─━═╌╍–—_\-]{3,}\s*$/,                       // full-width rules, both TUIs
    /^\s*[╭╮╰╯┌┐└┘├┤┬┴┼╔╗╚╝║]+[\s─━═]*[╮╯┐┘]?\s*$/,    // the corners of the old box
    /^\s*❯\s*$/,                                       // empty composer
    /^\s*│\s*>\s*$/,                                   // empty composer, old TUI
    /\?\s+for shortcuts/i,                             // the old hint line
    /(?:manual|auto|plan) mode on\b/i,                 // the mode line under the box
    /^\s*\[\d+[hdm]\s+\d+%\]/,                         // [5h 25%] [7d 47%] [ctx 41%]
    /\besc to interrupt\b/i,                           // live-turn footer
    /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✢✳✻✽·*]\s/,                        // spinner / "✻ Cooked for 42s"
    /^\s*(?:⏵|⏸|⎿)\s*$/,
];

// The last `lines` lines of real text, chrome removed, capped at `chars`.
// Kept here rather than in the caller because it is the same knowledge as the
// rest of this file: one TUI release changes both at once.
// Claude's SUGGESTED next prompt: dim text (SGR 2) straight after the composer's
// `❯`. It is Claude guessing, not Leon typing, and with the colour stripped
// Tesla read "❯ word, copiando el estado" as something he had sent (2026-09-25).
// Only visible in a capture taken with -e; a plain capture cannot tell them apart.
const SUGGESTION = /❯[\s ]*\x1B\[2m.*$/gm;

function readableTail(raw, { lines = 60, chars = 2500 } = {}) {
    const out = [];
    for (let line of stripAnsi(String(raw || '').replace(SUGGESTION, '❯')).split('\n')) {
        // The old TUI draws content inside a box, so the gutter comes off before
        // the line is judged — otherwise every line of an answer looks like chrome.
        line = line.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '').replace(/\s+$/, '');
        if (!line.trim()) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
        if (CHROME.some((re) => re.test(line))) continue;
        out.push(line);
    }
    while (out.length && out[0] === '') out.shift();
    while (out.length && out[out.length - 1] === '') out.pop();
    let text = out.slice(-lines).join('\n');
    // Cut from the FRONT: the end of the screen is the part that matters, and a
    // head-cut costs a half sentence nobody was going to read anyway.
    if (text.length > chars) text = text.slice(text.length - chars).replace(/^[^\n]*\n/, '');
    return text;
}

module.exports = {
    stripAnsi,
    tailOf,
    readableTail,
    looksLikeWorking,
    looksLikeClaudePrompt,
    looksLikeTrustDialog,
    trustAnswerKeys,
    looksLikeShellPrompt,
    backgroundShells,
    WORKING_PATTERNS,
};
