// Phase 2: heuristic parser for a tmux session's current state.
//
// Reads tmux pane via tmuxAdapter.captureSession, looks at the tail, and decides:
//   - working       — Claude is actively producing output
//   - waiting_input — Claude paused with a question or prompt
//   - done          — last completion marker / Stop event matched recently
//   - failed        — clear error pattern
//   - idle          — no activity for >5 minutes, no other signal
//   - unknown       — can't determine (no session, no output)
//
// State is decided from the union of (a) tmux capture tail and (b) event hints
// (stop_event_seen_at, last_capture_ts) the caller can pass in.

const tmux = require('./tmuxAdapter');
const paneShape = require('../paneShape');

const IDLE_MS = 5 * 60 * 1000;
// How many consecutive STATIC samples before a working session is allowed to
// settle. Claude thinks between tool calls with nothing moving on screen, so a
// single static 10s poll is not evidence that the turn ended -- without this the
// state flaps working -> idle -> working inside one minute, which is exactly
// what made the board untrustworthy.
const SETTLE_SAMPLES = 3;
const DONE_RECENT_MS = 90 * 1000;     // a Stop event in the last 90s = "done"
const RECENT_ACTIVITY_MS = 30 * 1000; // capture diff within 30s = "working"

// Strip ANSI sequences for cleaner regex matching.
function stripAnsi(s) {
    return String(s || '')
        .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B[=>]/g, '');
}

// Indicators that Claude is asking the user something (case-insensitive).
const WAITING_PATTERNS = [
    /\?\s*$/m,
    /\(y\/n\)/i,
    /\(yes\/no\)/i,
    /press\s+enter\s+to/i,
    /shall i (proceed|continue|run)/i,
    /should i /i,
    /\bdo you want me to\b/i,
    /\bwhich (one|option|approach)\b/i,
    /\bplease (confirm|specify|clarify|provide)\b/i,
    // Claude Code's interactive permission prompts:
    /❯\s*[^a-z0-9]*y(es)?\s*$/im,
    /\[(approve|deny|skip)\]/i,
];

// Indicators that a session is dead / something blew up.
const FAILED_PATTERNS = [
    /\bclaude:\s*command\s+not\s+found\b/i,
    /\bnpm\s+ERR!/i,
    /\bfatal:\b/i,
    /\btraceback \(most recent/i,
    /\bsegmentation fault\b/i,
    /\bunhandled (promise rejection|exception)\b/i,
    /\benoent\b/i,
];

// Indicators that Claude wrapped up the previous turn cleanly.
const DONE_PATTERNS = [
    /\bdone\.?\s*$/im,
    /\ball set\b/i,
    /\bfinished\b/i,
    /\b(thanks|that's all)\b/i,
    /\b(pr|commit) created\b/i,
];

// Claude's spinner glyphs, trailing "...", its explicit "busy" markers, or the
// 2026-08 TUI's "<Verb>… (<elapsed> · ↓ <n> tokens)" line. Any of them means the
// session is NOT finished even if a "<Verb> for <time>" summary is on screen.
// The patterns live in lib/paneShape.js -- this file, server.js and
// lib/sessionWeight.js each carried a copy until a TUI release blinded all three
// on the same day.
const looksLikeWorking = paneShape.looksLikeWorking;

// Claude prints a completion summary when a turn ends: a status glyph + a randomly
// chosen past-tense verb + elapsed time, e.g. "✻ Brewed for 1m 42s",
// "✻ Cogitated for 5s", "Baked for 3s". The verb is random but "<Verb> for <time>"
// is stable. Verb must be Capitalized (the status line) so prose like "account for
// 3 months" doesn't match; the unit needs a trailing word boundary so "months" /
// "minutes" don't false-trigger.
const COMPLETION_PATTERN = /\b[A-Z][a-z]{2,}\s+for\s+\d[\d.\s]*(?:ms|s|m|h)\b/;

// Claude presenting a list to pick from (permission menus, surveys like
// "1: Bad  2: Fine  3: Good", or "❯ 1. Yes / 2. No"). These need a selection.
function looksLikeMenu(tail) {
    // Two+ "N: x" / "N. x" option groups on ONE line (e.g. "1: Bad 2: Fine").
    // The original used `\s` between the groups, and \s MATCHES A NEWLINE -- so it
    // silently fired on any two consecutive numbered lines anywhere in the pane,
    // i.e. on every ordinary numbered list Claude writes. Inherited from the
    // cockpit parser. [^\S\n] is "whitespace except newline".
    if (/\d+[:.][^\S\n]*\S+[^\n]*[^\S\n]\d+[:.][^\S\n]*\S+/.test(tail)) return true;

    // Multi-line menus need the SELECTION AFFORDANCE, not just numbers. Claude
    // writes numbered lists in ordinary prose constantly, and counting those as a
    // menu marked two finished sessions "waiting_input / selection menu" when
    // nothing was being offered -- the right verdict for the wrong reason, which
    // is worse than being wrong, because it is unfalsifiable from the UI.
    const lines = tail.split('\n');
    const arrowed = lines.filter(l => /^\s*[❯>›→]\s*\(?\d+[.):]\s+\S/.test(l)).length;
    if (arrowed >= 1) return true;                       // Claude Code's own menu marker

    // Otherwise: short numbered lines, bunched at the very end = options.
    const tailEnd = lines.slice(-6);
    const shortNumbered = tailEnd.filter(l => {
        const m = /^\s*\(?\d+[.):]\s+(\S.*)$/.exec(l);
        return m && m[1].trim().length <= 50 && !/[.;]$/.test(m[1].trim());
    }).length;
    return shortNumbered >= 2;
}

// A TSRCT pane is ~1000 rows (tmux default-size 80x1000, so Claude's alt-screen
// TUI paints a tall canvas), and Claude leaves large blank gaps between the
// conversation and its input box. Taking the raw last 20 lines therefore lands
// entirely inside the blank gap + the box, and the end-of-turn line scrolls out
// of view -- which is why real, finished sessions were classified as "no signal".
// /api/output already collapses blank runs for the same reason; the parser never
// did. Collapse first, THEN take the tail.
function collapseBlanks(text) {
    return String(text || '')
        .split('\n')
        .reduce((acc, line) => {
            const blank = !line.trim();
            if (blank && acc.blanks >= 1) return acc;       // keep at most one
            acc.blanks = blank ? acc.blanks + 1 : 0;
            acc.out.push(line);
            return acc;
        }, { out: [], blanks: 0 })
        .out.join('\n');
}

// Claude Code's composer footer. Present exactly when the session is sitting at
// its prompt, i.e. NOT running -- while a turn is live the footer carries
// "esc to interrupt" instead. This is the difference between "idle" as a real
// observation and "idle" as a shrug.
const AT_PROMPT_PATTERNS = [
    /auto mode on \(shift\+tab to cycle\)/i,
    /shift\+tab to cycle/i,
    /\bfor agents\s*$/im,
    /\bnew task\?/i,
];
function looksAtPrompt(tail) {
    return AT_PROMPT_PATTERNS.some(re => re.test(tail));
}

// The composer is CHROME, not conversation, and matching Claude's own UI text is
// how an idle session gets read as a question: the placeholder literally says
// "new task?" and the trailing-"?" rule fires on it. Strip the box, the hint, the
// footer and the user's own draft line before looking for questions, errors or
// completion markers.
const COMPOSER_LINE = [
    /^[\s\u2500-\u257F]*$/,                 // box-drawing rules
    /new task\?/i,                           // placeholder hint
    /auto mode on|shift\+tab to cycle|for agents/i,
    // The user's own input line. NOT an arrowed menu option: Claude Code uses the
    // same glyph for its selection marker, and stripping "❯ 1. Yes" as chrome hid
    // the very menu we were trying to detect.
    /^\s*[\u276F>]\s(?!\s*\(?\d+[.):]\s)/,
    /\besc to interrupt\b/i,
];
function stripComposer(tail) {
    return tail.split('\n').filter(l => !COMPOSER_LINE.some(re => re.test(l))).join('\n');
}

// Terminal furniture that is never worth showing a human: tmux status bars,
// shell prompts, spinner/timing lines, MCP warnings, pure punctuation.
const CHROME_LINE = [
    /^[\s\u2580-\u259F]+/,                    // tmux/block glyphs
    /\(ctrl\+b|\bctrl\+b\b/i,
    /^\s*[⚠✻✽✢]/,
    /\b\d+s\s*·\s*\d+ lines?\b/,             // "(24s · 2 lines)"
    /MCP servers? need auth/i,
    /^\s*[^\w¿¡]{6,}\s*$/,                    // a line with no words at all
    /^\s*\$\s|^\s*[\w.-]+@[\w.-]+:/,          // shell prompts
];
function isChrome(line) { return CHROME_LINE.some(re => re.test(line)); }

// THE line that put this session in its state -- the question actually being
// asked, the menu, the error. TOWER shows this instead of the last N lines,
// because "the last thing on screen" is often the text AFTER the question.
// Model-free: it re-runs the same patterns the classifier used.
function evidenceLine(capture, state) {
    if (!capture) return '';
    const cleaned = stripComposer(collapseBlanks(stripAnsi(capture)));
    const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l && !isChrome(l));
    if (!lines.length) return '';
    const families = state === 'failed' ? [FAILED_PATTERNS]
        : state === 'waiting_input' ? [WAITING_PATTERNS]
            : [];
    for (const fam of families) {
        // last match wins: the most recent question is the live one
        for (let i = lines.length - 1; i >= 0; i--) {
            if (fam.some(re => re.test(lines[i]))) return lines[i].slice(0, 240);
        }
    }
    // menus: show the options, not the prose above them
    if (state === 'waiting_input') {
        const opts = lines.filter(l => /^\(?\d+[.):]\s+\S/.test(l) || /^[❯>›→]\s*\(?\d+[.):]/.test(l));
        if (opts.length >= 2) return opts.slice(-4).join('  ').slice(0, 240);
    }
    // otherwise the last real sentence beats the last raw line
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/[.!?…]$/.test(lines[i]) && lines[i].length > 25) return lines[i].slice(0, 240);
    }
    return lines.slice(-2).join(' ').slice(0, 240);
}

function lastNonEmptyLine(text) {
    const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
}

/**
 * @param {string} sessionName
 * @param {object} hints
 *   @prop {number} [stopEventSeenAt]   ms timestamp of last Stop hook for this session
 *   @prop {number} [previousCaptureAt] ms timestamp of last captured output
 *   @prop {string} [previousCapture]   the previous capture (to diff vs current)
 *   @prop {number} [now]               override clock (for testing)
 * @returns {{state, reason, lastActivity, lastLine, capture}}
 */
function parseSessionState(sessionName, hints = {}) {
    const now = hints.now || Date.now();

    if (!sessionName) {
        return { state: 'unknown', reason: 'no session name', lastActivity: null, lastLine: '', capture: '' };
    }

    let raw;
    try {
        raw = tmux.captureSession(sessionName, 200);
    } catch {
        return { state: 'unknown', reason: 'capture failed (session gone?)', lastActivity: null, lastLine: '', capture: '' };
    }
    if (!raw) {
        return { state: 'unknown', reason: 'empty capture', lastActivity: null, lastLine: '', capture: '' };
    }

    const cleaned = collapseBlanks(stripAnsi(raw)).trim();
    const tail = cleaned.split('\n').slice(-24).join('\n');
    const lastLine = lastNonEmptyLine(stripComposer(tail));

    // 1. ACTIVELY WORKING beats everything. If Claude is still producing output
    //    (live spinner, trailing "...", or the capture changed since the last
    //    sample), it is NOT finished/waiting — no matter what text is in the tail.
    //    This is checked FIRST so a question or "Traceback" or "do you want me to"
    //    that scrolls by mid-stream can't be misread as done/waiting/failed while
    //    output is still flowing. Only a screen that has gone STATIC for a full
    //    poll interval is interpreted as a real end-of-turn state below.
    const captureChanged = hints.previousCapture != null && raw !== hints.previousCapture;
    if (looksLikeWorking(tail)) {
        return { state: 'working', reason: 'spinner / dots in tail', lastActivity: now, lastLine, capture: raw, static: false };
    }
    if (captureChanged) {
        return { state: 'working', reason: 'output changed since last capture', lastActivity: now, lastLine, capture: raw, static: false };
    }

    // 1b. HYSTERESIS. The screen is static right now, but a session that was
    //     working needs several static samples before we call the turn over --
    //     Claude sits silent between tool calls. Only an explicit end-of-turn
    //     signal below (menu, question, completion line, error) may cut this short.
    const staticSamples = (hints.staticSamples || 0) + 1;
    const settling = hints.previousState === 'working' && staticSamples < SETTLE_SAMPLES;

    // --- From here down the screen is STATIC (no spinner, no change). ---

    // --- Patterns below read the CONVERSATION, with Claude's composer removed. ---
    const convo = stripComposer(tail);

    // 2. Failed — a clear error pattern on a settled screen.
    for (const re of FAILED_PATTERNS) {
        if (re.test(convo)) {
            return { state: 'failed', reason: `pattern: ${re}`, lastActivity: now, lastLine, capture: raw };
        }
    }

    // 3. Needs input — Claude is showing a selection menu or asking a question.
    //    Checked BEFORE "done" so a question-with-options reads as waiting (you
    //    must pick), not done — and these prompts carry no "<Verb> for <time>".
    if (looksLikeMenu(convo)) {
        return { state: 'waiting_input', reason: 'selection menu', lastActivity: now, lastLine, capture: raw };
    }
    for (const re of WAITING_PATTERNS) {
        if (re.test(convo)) {
            return { state: 'waiting_input', reason: `pattern: ${re}`, lastActivity: now, lastLine, capture: raw };
        }
    }

    // 4. Done — Claude's completion summary ("<Verb> for <time>") is the primary
    //    signal; a recent Stop hook or a textual done marker also count.
    if (COMPLETION_PATTERN.test(convo)) {
        return { state: 'done', reason: 'completion line (verb + time)', lastActivity: now, lastLine, capture: raw };
    }
    if (hints.stopEventSeenAt && (now - hints.stopEventSeenAt) < DONE_RECENT_MS) {
        return { state: 'done', reason: 'Stop hook recently', lastActivity: hints.stopEventSeenAt, lastLine, capture: raw };
    }
    for (const re of DONE_PATTERNS) {
        if (re.test(lastLine)) {
            return { state: 'done', reason: `pattern: ${re}`, lastActivity: now, lastLine, capture: raw };
        }
    }

    // 4b. Still settling: nothing said the turn ended, and it was working a
    //     moment ago. Keep it working rather than flapping to idle.
    if (settling) {
        return {
            state: 'working', reason: `static ${staticSamples}/${SETTLE_SAMPLES} - settling`,
            lastActivity: hints.previousCaptureAt || now, lastLine, capture: raw, static: true, staticSamples,
        };
    }

    // 4c. Sitting at the composer with nothing running. This is a POSITIVE
    //     observation of an idle session, not a failure to classify one.
    if (looksAtPrompt(tail)) {
        return { state: 'idle', reason: 'at prompt, nothing running', lastActivity: hints.previousCaptureAt || now, lastLine, capture: raw, static: true, staticSamples };
    }

    // 5. Idle if previous capture exists and is old enough.
    if (hints.previousCaptureAt && (now - hints.previousCaptureAt) >= IDLE_MS) {
        return { state: 'idle', reason: 'no change in 5min', lastActivity: hints.previousCaptureAt, lastLine, capture: raw, static: true, staticSamples };
    }

    // 6. Fall through. This is NOT idle -- it is "no signal I recognise", and
    //    calling it idle is the parser telling the UI a session is quiet when it
    //    has no idea. Same defect class as a sensor reporting `off` when it has
    //    simply never been probed. `unknown` is the honest answer; the UI renders
    //    it differently and does not claim the session is doing nothing.
    return { state: 'unknown', reason: 'no recognised signal', lastActivity: now, lastLine, capture: raw, static: true, staticSamples };
}

module.exports = { parseSessionState, stripAnsi, collapseBlanks, stripComposer, looksLikeMenu, looksAtPrompt, evidenceLine, isChrome, WAITING_PATTERNS, FAILED_PATTERNS, DONE_PATTERNS };
