#!/usr/bin/env node
'use strict';
// Fixture test for lib/paneShape.js — the one place that knows what a Claude Code
// pane looks like.
//
// WHY: on 2026-08-25 Claude Code shipped a new TUI and three subsystems went blind
// at once (the handoff refused to compact anything, and waitPaneIdle read two
// actively-working panes as idle — the one failure the idle contract exists to
// prevent). Nothing failed loudly; the handoff just aborted three seconds in and
// the UI froze on "waiting for idle".
//
// These fixtures are VERBATIM tails captured off Leon's real tmux sessions, one
// set per TUI generation. When Claude Code changes its TUI again this file fails
// FIRST, and the fix is to ADD the new shape here and in paneShape.js — never to
// replace the old one, because panes started before the upgrade keep running the
// old binary.
//
// Costs nothing to run: no tmux, no network, no model. Wired into `npm run check`.

const ps = require('../lib/paneShape');

// ── Fixtures ─────────────────────────────────────────────────────────────────
const RULE = '─'.repeat(140);

// 2026-08 TUI: `❯` composer fenced by two full-width rules, statusline + mode line.
const NEW_IDLE = [
    '',
    '                                                     new task? /clear to ',
    RULE,
    '❯ ya te lo paso, dame un minuto',
    RULE,
    '  [5h 9%] [7d 41%] [ctx 14%] Opus 5 · ledgerly-quirks',
    '  ⏸ manual mode on · ← for agents',
].join('\n');

const NEW_WORKING = [
    '✢ Forging… (6m 7s · ↓ 27.7k tokens)',
    '  ⎿  Tip: You have free guest passes to share · /passes',
    '',
    RULE,
    '❯',
    RULE,
    '  [5h 36%] [7d 44%] [ctx 23%] Opus 5 (1M context) · implementor-brain',
    '  ⏸ manual mode on · ← for agents',
].join('\n');

// End-of-turn summary: same glyph family as the spinner, but NO ellipsis and no
// parenthesised running clock. Must NOT read as working.
const NEW_JUST_FINISHED = [
    '',
    '✻ Sautéed for 1m 49s',
    '',
    RULE,
    '❯ segui con el espejo, gore y cierre',
    RULE,
    '  [5h 34%] [7d 43%] [ctx 27%] Opus 5 (1M context) · _tools',
    '  ⏸ manual mode on · ← for agents',
].join('\n');

// Turn OVER, but a `&`-backgrounded shell outlived it. The counter sits on the
// end-of-turn line AND in the mode line, and stays for as long as the shell lives.
// Must NOT read as working (it made waitPaneIdle burn its full 180s timeout on a
// pane that was at its prompt the whole time), but MUST be counted, because the
// handoff kills the old session and would take the shell with it.
const NEW_BACKGROUND_SHELL = [
    '  Cuando las tenga, las pego en el canon y quedan abiertas las cuentas.',
    '',
    '✻ Cooked for 42s · 1 shell still running',
    '',
    RULE,
    '❯ ok mientras tanto, escuche la mezcla, esta aprobada',
    RULE,
    '  [5h 25%] [7d 47%] [ctx 41%] Opus 5 (1M context) · ro',
    '  ⏸ manual mode on · 1 shell · ← for agents',
].join('\n');

// Same, but genuinely mid-turn WITH a background shell: the running timer wins.
const NEW_WORKING_WITH_SHELL = [
    '✢ Forging… (6m 7s · ↓ 27.7k tokens)',
    RULE,
    '❯',
    RULE,
    '  ⏸ manual mode on · 3 shells · ← for agents',
].join('\n');

// Pre-2026-08 TUI: rounded box + "? for shortcuts" hint + braille spinner.
const OLD_IDLE = [
    '╭──────────────────────────────────────────────╮',
    '│ >                                            │',
    '╰──────────────────────────────────────────────╯',
    '  ? for shortcuts',
].join('\n');

const OLD_WORKING = [
    '⠹ Cogitating… (12s · esc to interrupt)',
    '╭──────────────────────────────────────────────╮',
    '│ >                                            │',
    '╰──────────────────────────────────────────────╯',
].join('\n');

// A bare shell. This is the tsrct-2 incident: idle by every "did the screen stop
// moving" measure, and pasting a compact summary into it EXECUTED the summary.
const SHELL = 'user@laptop:/mnt/c/Users/you/PROJECTS$';

const SHELL_AFTER_BAD_PASTE = [
    'bash: -> tsrct-2: command not found',
    'bash: syntax error near unexpected token `('
    ,'user@laptop:/mnt/c/Users/you/PROJECTS$',
].join('\n');

// ── Expectations ─────────────────────────────────────────────────────────────
// [name, tail, {working, claudePrompt, shell, shells?}]
const CASES = [
    ['new TUI · idle at composer', NEW_IDLE, { working: false, claudePrompt: true, shell: false, shells: 0 }],
    ['new TUI · mid-turn', NEW_WORKING, { working: true, claudePrompt: true, shell: false, shells: 0 }],
    ['new TUI · turn just ended', NEW_JUST_FINISHED, { working: false, claudePrompt: true, shell: false, shells: 0 }],
    ['new TUI · done, background shell alive', NEW_BACKGROUND_SHELL, { working: false, claudePrompt: true, shell: false, shells: 1 }],
    ['new TUI · mid-turn WITH background shells', NEW_WORKING_WITH_SHELL, { working: true, claudePrompt: true, shell: false, shells: 3 }],
    ['old TUI · idle at composer', OLD_IDLE, { working: false, claudePrompt: true, shell: false, shells: 0 }],
    ['old TUI · mid-turn', OLD_WORKING, { working: true, claudePrompt: true, shell: false, shells: 0 }],
    ['bare shell prompt', SHELL, { working: false, claudePrompt: false, shell: true, shells: 0 }],
    ['shell after a bad paste', SHELL_AFTER_BAD_PASTE, { working: false, claudePrompt: false, shell: true, shells: 0 }],
];

// tailOf() must survive tmux's blank padding: a 1000-row pane capture is mostly
// empty lines, and slicing the last 20 WITHOUT trimming first lands entirely
// inside the padding — which is how a working pane reads as idle.
const PADDED = NEW_WORKING + '\n'.repeat(400);

let failures = 0;
const fail = (msg) => { console.error(`  [x] ${msg}`); failures++; };

for (const [name, tail, want] of CASES) {
    const got = {
        working: ps.looksLikeWorking(tail),
        claudePrompt: ps.looksLikeClaudePrompt(tail),
        shell: ps.looksLikeShellPrompt(tail),
        shells: ps.backgroundShells(tail),
    };
    for (const k of Object.keys(want)) {
        if (got[k] !== want[k]) fail(`${name}: ${k} = ${got[k]}, expected ${want[k]}`);
    }
}

if (!ps.looksLikeWorking(ps.tailOf(PADDED))) {
    fail('tailOf() did not trim tmux blank padding — a working pane reads as idle');
}

// ── trustAnswerKeys(): how to say YES to the trust menu (2026-09-23) ────────
// Real shape from c7-recon: the cursor starts on "No, exit" and "Yes" is below
// it. A wrong answer here exits Claude, so anything unclear must return null.
{
    const TRUST = (first, second, cursorOn) => [
        'Accessing workspace:', '/mnt/c/Users/you/PROJECTS/c7-recon/C7_Reconciliation',
        'Quick safety check: Is this a project you created or one you trust?',
        (cursorOn === 0 ? '❯ ' : '  ') + first,
        (cursorOn === 1 ? '❯ ' : '  ') + second,
        'Enter to confirm · Esc to cancel',
    ].join('\n');
    const keys = (t) => JSON.stringify(ps.trustAnswerKeys(t));
    if (keys(TRUST('No, exit', 'Yes, I trust this folder', 0)) !== '["Down","Enter"]') fail(`trust: No first -> ${keys(TRUST('No, exit', 'Yes, I trust this folder', 0))}`);
    if (keys(TRUST('1. Yes, proceed', '2. No, exit', 0)) !== '["Enter"]') fail('trust: Yes first, cursor on it -> Enter only');
    if (keys(TRUST('Yes, I trust this folder', 'No, exit', 1)) !== '["Up","Enter"]') fail('trust: cursor below Yes -> Up, Enter');
    if (ps.trustAnswerKeys(TRUST('No, exit', 'Yes, I trust this folder', -1)) !== null) fail('trust: no cursor visible must return null');
    if (ps.trustAnswerKeys(NEW_IDLE) !== null) fail('trust: the composer is not a trust menu');

    // Who may be answered yes: inside PROJECTS only, never SecretCo, never PROJECTS itself.
    const reg = require('../lib/projectRegistry');
    const P = reg.PROJECTS_ROOT;
    if (require('fs').existsSync(require('path').join(P, 'TSRCT')) && !reg.mayAutoTrust(require('path').join(P, 'TSRCT'))) fail('trust: a folder inside PROJECTS should be answered');
    if (reg.mayAutoTrust(P)) fail('trust: PROJECTS itself is not a project folder');
    if (reg.mayAutoTrust('/home/user')) fail('trust: a folder outside PROJECTS must never be answered');
    if (reg.mayAutoTrust(require('path').join(P, 'SecretCoSandbox'))) fail('trust: SecretCo must never be answered');
    if (reg.mayAutoTrust(require('path').join(P, 'no-such-folder-xyz'))) fail('trust: a missing folder must never be answered');
}

// ── readableTail(): what a PERSON would read off the pane ───────────────────
// TALK hands this to the local model. Two ways it can be wrong and both are
// silent: keeping the furniture (the model then summarises the furniture, which
// is exactly what made TOWER's tiles useless), or eating the content along with
// it (the model is asked about a screen it was never shown).
{
    const readable = ps.readableTail(NEW_BACKGROUND_SHELL, { lines: 40, chars: 4000 });
    // Chrome must be gone...
    if (/─{10}/.test(readable)) fail('readableTail() kept a full-width rule');
    if (/\[ctx \d+%\]/.test(readable)) fail('readableTail() kept the token/context footer');
    if (/manual mode on/.test(readable)) fail('readableTail() kept the mode line');
    if (/Cooked for/.test(readable)) fail('readableTail() kept the end-of-turn status line');
    // ...and everything a person would actually read must survive, including
    // the line he typed, which is half of what "what is going on" means.
    if (!/las pego en el canon/.test(readable)) fail('readableTail() dropped the agent output');
    if (!/escuche la mezcla/.test(readable)) fail('readableTail() dropped what he typed into the composer');

    // Claude's suggested next prompt is DIM after `❯` (captured from wlcrane-1430,
    // 2026-09-25). Tesla read it as something he had sent. What he really sent
    // (bright, on the grey band) must survive.
    const colored = ps.readableTail([
        '\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231mupdate vault si no lo hiciste\x1b[39m',
        'Lo unico que necesito de vos: en que formato lo queres?',
        '\x1b[39m❯ \x1b[2mword, copiando el estado\x1b[0m',
    ].join('\n'));
    if (/copiando el estado/.test(colored)) fail('readableTail() kept Claude\'s dim suggested prompt');
    if (!/update vault/.test(colored)) fail('readableTail() dropped a prompt he really sent');
    if (!/en que formato/.test(colored)) fail('readableTail() dropped the answer above the composer');

    // The old TUI draws content INSIDE a box. If the gutter is not taken off
    // before a line is judged, every line of an answer looks like furniture.
    const boxed = ps.readableTail([
        '╭────────────────────────────╮',
        '│ > deploy the reports       │',
        '╰────────────────────────────╯',
        '  ? for shortcuts',
    ].join('\n'), { lines: 20, chars: 2000 });
    if (!/deploy the reports/.test(boxed)) fail('readableTail() threw away the old TUI composer content with its box');
    if (/for shortcuts/.test(boxed)) fail('readableTail() kept the old hint line');

    // An empty screen is an absence, not a paragraph of blanks.
    if (ps.readableTail('\n'.repeat(50) + RULE, { lines: 20 }).trim() !== '') {
        fail('readableTail() returned furniture for an otherwise empty pane');
    }
}

// The four call sites must all go through this module. A private copy of these
// regexes is what caused the incident, so grep for the old ones coming back.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const COPIES = [
    ['server.js', /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
    ['lib/sessionWeight.js', /for shortcuts/],
    ['lib/dispatcher/outputParser.js', /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
    // TALK reads panes to decide when a turn ended. Fourth consumer, same rule.
    ['lib/talk.js', /for shortcuts/],
];
for (const [rel, re] of COPIES) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    // Comments are allowed to quote the glyphs; code is not.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (re.test(code)) {
        fail(`${rel}: a private copy of the pane-shape regexes is back — use lib/paneShape.js`);
    }
}

if (failures) {
    console.error(`\n[check-paneshape] ${failures} failure(s).`);
    console.error('If Claude Code changed its TUI: ADD the new shape to lib/paneShape.js and a');
    console.error('fixture here. Do NOT replace the old shape — both builds run on this machine.');
    process.exit(1);
}
console.log(`[check-paneshape] ok — ${CASES.length} pane fixtures, ${COPIES.length} call sites clean`);
