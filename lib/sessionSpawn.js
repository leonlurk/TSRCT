'use strict';
// ── sessionSpawn.js — open a tmux session, start Claude in it, prime it ──────
//
// This is the sequence the handoff already did (lib/sessionWeight.js), lifted
// out so more than one caller can use it: the handoff retires one session into a
// fresh one, the morning routine opens several at once from a plan.
//
// It is NOT a thin wrapper around tmux. Two incidents are baked into it and both
// cost a day, so read them before simplifying anything here:
//
// INCIDENT 2026-08-20 — waiting for "the pane stopped moving" is not the same as
// waiting for Claude. waitPaneIdle() only answers "is this pane NOT working",
// and a bash prompt sitting there doing nothing is, by that definition, idle.
// So a 24k-char summary was pasted into bash, which RAN it line by line:
// backticks became command substitution, a quoted `export ANTHROPIC_BASE_URL=...`
// really ran, and that one pane ended up pointed at another provider with no
// credential — invisible everywhere else, and it looked like "stdout is being
// dropped". Hence: prove the Claude input box is on screen (twice in a row, once
// can catch the TUI mid-paint), and paste with bracketed paste (-p) so that if
// the target ever is not Claude, the text lands as one inert line.
//
// INCIDENT 2026-08-25 — the input-box shapes used to be inlined here. Claude
// Code shipped a new TUI and every spawn aborted with "never came up in Claude".
// The shapes live in lib/paneShape.js now: one edit per TUI change, not three.
//
// Dependencies are injected (configure) so this never reaches back into
// server.js: tmux, sleep, sessionExists, sessionEnvArgs.

const fs = require('fs');
const paneShape = require('./paneShape');
const projectRegistry = require('./projectRegistry');

const PANE_COLS = 140;      // matches `default-size 140x1000` in ~/.tmux.conf
const PANE_ROWS = 1000;
const SHELL_WAIT_POLLS = 40;     // x 250 ms: up to 10 s for a new shell's prompt
const RETYPE_AFTER_POLLS = 8;    // x 700 ms: ~5 s at an empty prompt after typing
const NOT_FOUND_RETYPES = 6;     // ~35 s of "command not found": an update takes ~10-30 s

let deps = null;

function configure(injected) {
    deps = injected;
}

function ready() {
    return !!(deps && deps.tmux && deps.sleep && deps.sessionExists && deps.sessionEnvArgs);
}

function capturePane(session) {
    try {
        return paneShape.stripAnsi(deps.tmux(['capture-pane', '-t', session, '-p', '-S', '-40']));
    } catch {
        return null;
    }
}

// Wait until the input box is on screen TWICE in a row. Never returns ok on a
// shell prompt, however idle it looks.
async function waitForClaudePrompt(session, opts = {}) {
    const { pollMs = 700, timeoutMs = 90000, stableNeeded = 2, autoTrust = false, retype = null } = opts;
    const start = Date.now();
    let seen = 0, sawShell = false, sawTrust = false, answered = false, emptyFor = 0, retyped = false;
    let notFoundFor = 0, notFoundRetypes = 0;
    while (Date.now() - start < timeoutMs) {
        const raw = capturePane(session);
        if (raw === null) return { ok: false, reason: 'session gone' };
        const tail = paneShape.tailOf(raw);
        if (paneShape.looksLikeClaudePrompt(tail)) {
            if (++seen >= stableNeeded) return { ok: true };
        } else {
            seen = 0;
            // The trust menu: answered YES once, and only when the caller says
            // the folder may be (autoTrust - inside PROJECTS, never SecretCo). He
            // asked for that on 2026-09-23: the morning sessions sat on this
            // question. Otherwise it is left for him; keep waiting, and if he
            // says yes before the timeout priming carries on as if nothing happened.
            if (paneShape.looksLikeTrustDialog(tail)) {
                sawTrust = true;
                const keys = autoTrust && !answered ? paneShape.trustAnswerKeys(tail) : null;
                if (keys) {
                    answered = true;
                    for (const k of keys) { deps.tmux(['send-keys', '-t', session, k]); await deps.sleep(150); }
                }
            }
            else if (paneShape.looksLikeShellPrompt(tail)) {
                sawShell = true;
                // "claude: command not found" just above the prompt: Claude Code is
                // being updated and its link is briefly gone (review #18, 22:01: the
                // brain sat 80 s at a shell while he asked "tesla estas ahi"). Typed
                // again every ~5 s while it stays missing, then refused in words.
                const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
                if (/command not found/.test(lines[lines.length - 2] || '')) {
                    if (typeof retype === 'function' && ++notFoundFor >= RETYPE_AFTER_POLLS) {
                        notFoundFor = 0;
                        if (++notFoundRetypes > NOT_FOUND_RETYPES) {
                            return { ok: false, reason: 'the claude command was not found (Claude Code may be updating) - try again in a minute' };
                        }
                        console.warn(`[spawn] ${session}: claude not found - typing it again (${notFoundRetypes}/${NOT_FOUND_RETYPES})`);
                        retype();
                    }
                    await deps.sleep(pollMs);
                    continue;
                }
                // An EMPTY prompt for ~5 s: the command never ran (swallowed by a
                // shell still loading) or Claude quit at once. Typed again, once.
                if (typeof retype === 'function' && !retyped && ++emptyFor >= RETYPE_AFTER_POLLS) {
                    retyped = true;
                    emptyFor = 0;
                    console.warn(`[spawn] ${session}: still at an empty shell prompt - typing the command again`);
                    retype();
                }
            } else emptyFor = 0;
        }
        await deps.sleep(pollMs);
    }
    return {
        ok: false,
        reason: sawTrust
            ? 'Claude is asking whether you trust this folder - answer it in the session'
            : sawShell
            ? 'the pane is sitting at a shell prompt, not Claude'
            : 'the Claude input box never appeared',
    };
}

// Paste with tmux's bracketed-paste flag (-p). Deliberately NOT routed through
// server.js's sendToTmuxSession(): that one is shared by every other paste path
// and pastes without -p, and this protection has no business changing those.
function pasteIntoPane(session, text) {
    const tempFile = `/tmp/tsrct_spawn_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;
    try {
        fs.writeFileSync(tempFile, text, 'utf8');
        deps.tmux(['load-buffer', '-b', `tsrct-spawn-${process.pid}`, tempFile]);
        deps.tmux(['paste-buffer', '-p', '-b', `tsrct-spawn-${process.pid}`, '-t', session]);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    } finally {
        try { fs.unlinkSync(tempFile); } catch { /* best effort */ }
    }
}

// base -> base-2 -> base-3 ... skipping names that already exist.
function nextSessionName(oldName, exists) {
    const m = /^(.*?)-(\d+)$/.exec(oldName);
    const base = m ? m[1] : oldName;
    let n = m ? parseInt(m[2], 10) + 1 : 2;
    let candidate = `${base}-${n}`;
    while (exists(candidate) && n < 100) candidate = `${base}-${++n}`;
    return candidate.slice(0, 64);
}

// ── the sequence ─────────────────────────────────────────────────────────────
// createPrimedSession({ name, cwd, prompt, submit, onPhase })
//   name   - tmux session name to create. Must not exist (use nextSessionName).
//   cwd    - the directory the session opens in. The CALLER validates it: this
//            module has no idea what an allowed path is, and guessing here is
//            how a boundary ends up in two places disagreeing.
//   prompt - the priming text. Pasted, then Enter, only after the input box is
//            proven to be on screen. Omit it to leave the session at the prompt.
//   submit - false to paste without pressing Enter (default true).
//
// Returns { ok, session, phase, error }. It NEVER kills anything: a spawn that
// fails half-way leaves the session alive, because that pane is the only place
// the reason is written down.
async function createPrimedSession({ name, cwd, prompt, submit = true, onPhase, bootTimeoutMs = 90000, command = 'claude' } = {}) {
    if (!ready()) return { ok: false, phase: 'configure', error: 'sessionSpawn is not configured' };
    const say = (p) => { try { if (onPhase) onPhase(p); } catch { /* never break the spawn */ } };
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(name || ''))) {
        return { ok: false, phase: 'name', error: `bad session name: ${name}` };
    }
    if (!cwd || typeof cwd !== 'string') return { ok: false, phase: 'cwd', error: 'no directory given' };
    if (deps.sessionExists(name)) return { ok: false, phase: 'name', error: `session ${name} already exists` };

    try {
        say('creating');
        deps.tmux(['new-session', '-d', '-s', name, '-c', cwd, ...deps.sessionEnvArgs(name)]);
        if (!deps.sessionExists(name)) return { ok: false, phase: 'creating', error: 'could not create the session' };
        // A detached session takes its size from `default-size` in ~/.tmux.conf.
        // Pin it here too so this does not silently depend on that file having
        // been loaded by whoever started the tmux server. Non-fatal.
        try { deps.tmux(['resize-window', '-t', name, '-x', String(PANE_COLS), '-y', String(PANE_ROWS)]); }
        catch (e) { console.warn(`[spawn] ${name}: resize failed: ${e.message}`); }

        // Wait for the new shell to show its prompt before typing (2026-10-08,
        // just after a restart with 15 sessions open: the command was typed into
        // a shell still loading, vanished, and the brain sat at an empty prompt
        // for 90 s while his question waited behind it). Typed anyway after the
        // wait - a prompt this code cannot recognise must not block a start.
        for (let i = 0; i < SHELL_WAIT_POLLS; i++) {
            const raw = capturePane(name);
            if (raw && paneShape.looksLikeShellPrompt(paneShape.tailOf(raw))) break;
            await deps.sleep(250);
        }
        say('booting');
        // `command` lets a caller start Claude with flags (the hidden Haiku brain:
        // lib/haikuBrain.js). It is typed into the new shell, so callers build it
        // from fixed parts only - never from anything a person or a model said.
        deps.tmux(['send-keys', '-t', name, command, 'Enter']);
        await deps.sleep(2500);
        const r = await waitForClaudePrompt(name, {
            timeoutMs: bootTimeoutMs, autoTrust: projectRegistry.mayAutoTrust(cwd),
            retype: () => deps.tmux(['send-keys', '-t', name, command, 'Enter']),
        });
        if (!r.ok) {
            // What the pane said, so the next failure explains itself in the log.
            const last = (paneShape.tailOf(capturePane(name) || '').split('\n').filter(l => l.trim()).pop() || '').slice(0, 160);
            console.warn(`[spawn] ${name} never came up in Claude (${r.reason}); last line: ${last}`);
            return { ok: false, session: name, phase: 'booting', error: `${name} never came up in Claude (${r.reason}) - nothing pasted, session left alive` };
        }
        if (!prompt) return { ok: true, session: name, phase: 'ready' };

        say('priming');
        const paste = pasteIntoPane(name, prompt);
        if (!paste.success) {
            return { ok: false, session: name, phase: 'priming', error: `could not paste into ${name}: ${paste.error}` };
        }
        if (submit) {
            await deps.sleep(400);      // let the TUI absorb the paste before submitting
            deps.tmux(['send-keys', '-t', name, 'Enter']);
        }
        return { ok: true, session: name, phase: 'primed' };
    } catch (e) {
        return { ok: false, session: name, phase: 'error', error: e.message };
    }
}

module.exports = {
    configure,
    createPrimedSession,
    waitForClaudePrompt,
    pasteIntoPane,
    nextSessionName,
    capturePane,
    PANE_COLS,
    PANE_ROWS,
};
