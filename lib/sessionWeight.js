'use strict';
// ── Session weight: warn before a session turns expensive, then hand it off ───
//
// WHY THIS EXISTS (measured on Leon's August 2026 transcripts, 24,734 turns):
//   turns under 100k of context ....... 19% of turns,  5% of the token bill
//   turns over  300k of context ....... 27% of turns, 51% of the token bill
// The waste is not in what a session READS (fresh input is ~0.1M/day - the vault
// and MAP.md already fixed that). It is in what a session CARRIES: every turn
// re-sends the whole conversation, and sessions were living for days. Capping
// context at ~200k cuts roughly a third of the bill for the same work done.
//
// The weight number arrives from the Stop hook (~/.claude/hooks/session-weight.sh),
// which reads the transcript file. Nothing here asks a model anything, so the
// measurement itself costs zero tokens.
//
// The handoff reuses the SAME idle-detection contract as runSelfRefresh() in
// server.js: never inject into a pane mid-turn. Its dependencies are injected
// (see configure()) so this module never reaches back into server.js.

const fs = require('fs');
// What a Claude Code pane looks like. Standalone require, like restrictedGuard: this
// module must never reach a boundary check through an optional subsystem.
const paneShape = require('./paneShape');
// Opening a session, booting Claude in it and pasting the priming text is the
// same sequence the morning routine needs, so it lives in one place now
// (2026-09-18). The two incidents it protects against are documented there.
const sessionSpawn = require('./sessionSpawn');

const DEFAULTS = { warn: 200000, urgent: 300000 };
// Measured 2026-08-20 over the 61 real compact summaries on disk: median 17,462
// chars, p90 24,945, largest ever 32,198. The first cap here was 12,000, which
// silently trimmed 93% of them -- including all 12 handoffs of the first day in
// use. 48,000 clears the largest observed summary with room to spare and still
// costs only ~12k tokens to prime, against the 200k the handoff is saving.
const MAX_SUMMARY_CHARS = 48000;
const TAIL_BYTES = 2_000_000;      // enough to hold a compact summary record

// session name -> { ctx, ts, transcript, claudeSessionId, cwd }
const weights = new Map();
// session name -> epoch ms until which the UI stays quiet
const snoozes = new Map();
// session name -> { phase, startedAt, newSession, error, done }
const handoffs = new Map();

let deps = null;

function configure(injected) {
    deps = injected;
    // The spawn module takes the same primitives; configuring it here means a
    // caller cannot end up with a half-wired handoff.
    sessionSpawn.configure(injected);
}

function thresholds() {
    let t = { ...DEFAULTS };
    try {
        const raw = deps && deps.getConfig && deps.getConfig('session_weight_thresholds');
        if (raw) {
            const p = JSON.parse(raw);
            if (Number.isFinite(p.warn) && p.warn > 0) t.warn = p.warn;
            if (Number.isFinite(p.urgent) && p.urgent > 0) t.urgent = p.urgent;
        }
    } catch { /* defaults */ }
    if (t.urgent < t.warn) t.urgent = t.warn;
    return t;
}

function setThresholds(warn, urgent) {
    const t = {
        warn: Math.max(20000, Math.min(900000, Number(warn) || DEFAULTS.warn)),
        urgent: Math.max(20000, Math.min(950000, Number(urgent) || DEFAULTS.urgent)),
    };
    if (t.urgent < t.warn) t.urgent = t.warn;
    if (deps && deps.setConfig) deps.setConfig('session_weight_thresholds', JSON.stringify(t));
    return t;
}

function levelFor(ctx, t) {
    if (ctx >= t.urgent) return 'urgent';
    if (ctx >= t.warn) return 'warn';
    return 'ok';
}

// ── Ingest (called by the Stop hook) ─────────────────────────────────────────
function record(entry) {
    const session = String(entry.session || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(session)) return null;
    const ctx = Number(entry.ctx) || 0;
    if (ctx <= 0) return null;
    const row = {
        session,
        ctx,
        ts: Date.now(),
        transcript: typeof entry.transcript === 'string' ? entry.transcript : '',
        claudeSessionId: typeof entry.claude_session_id === 'string' ? entry.claude_session_id : '',
        cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    };
    weights.set(session, row);
    // A session that grew again after a snooze expired should speak up, but a
    // session that just got lighter (it was compacted) starts clean.
    const prev = snoozes.get(session);
    if (prev && Date.now() > prev) snoozes.delete(session);
    return row;
}

function snooze(session, minutes) {
    // 0 = wake it up now. The 30m button is one mis-tap away from the handoff
    // button, and without this the only undo was waiting the half hour out.
    if (Number(minutes) === 0) {
        snoozes.delete(session);
        return { session, until: 0, minutes: 0 };
    }
    const mins = Math.max(1, Math.min(240, Number(minutes) || 5));
    const until = Date.now() + mins * 60 * 1000;
    snoozes.set(session, until);
    return { session, until, minutes: mins };
}

function forget(session) {
    weights.delete(session);
    snoozes.delete(session);
    handoffs.delete(session);
}

// ── Read model for the UI ────────────────────────────────────────────────────
// How long a FINISHED handoff stays readable after it ends. The UI polls every
// 4s; two minutes covers a phone that was locked when it completed.
const HANDOFF_LINGER_MS = 120000;

function handoffView(h) {
    return h ? { phase: h.phase, done: !!h.done, error: h.error || '', newSession: h.newSession || '' } : null;
}

function all(liveSessions) {
    const t = thresholds();
    const now = Date.now();
    const live = Array.isArray(liveSessions) ? new Set(liveSessions) : null;
    const out = [];
    const seen = new Set();
    for (const [session, row] of weights) {
        if (live && !live.has(session)) continue;          // died; drop it
        const snoozedUntil = snoozes.get(session) || 0;
        const level = levelFor(row.ctx, t);
        const h = handoffs.get(session);
        seen.add(session);
        out.push({
            session,
            ctx: row.ctx,
            level,
            // Silence is only about NAGGING; the badge still shows the real level.
            silenced: snoozedUntil > now,
            snoozedUntil: snoozedUntil > now ? snoozedUntil : 0,
            ageMs: now - row.ts,
            cwd: row.cwd,
            handoff: handoffView(h),
        });
    }
    // A handoff OUTLIVES the things it is keyed to: on success the old session is
    // killed (so it is not in `live`) and its weight row is deleted (so the loop
    // above never reaches it). Reporting only weight rows meant the browser could
    // never see the ending it was polling for -- it just watched the row vanish and
    // sat on the last phase it happened to catch. Report the handoff regardless,
    // and reap it once it has been readable long enough.
    for (const [session, h] of handoffs) {
        if (seen.has(session)) continue;
        const age = now - (h.finishedAt || h.startedAt || now);
        if (h.done && age > HANDOFF_LINGER_MS) { handoffs.delete(session); continue; }
        out.push({
            session,
            ctx: 0,
            level: 'ok',
            silenced: true,          // no nagging for a session that is on its way out
            snoozedUntil: 0,
            ageMs: 0,
            cwd: '',
            handoff: handoffView(h),
        });
    }
    out.sort((a, b) => b.ctx - a.ctx);
    return { thresholds: t, sessions: out };
}

function handoffState(session) {
    return handoffs.get(session) || null;
}

// ── Compact summary extraction (free: it is already on disk) ─────────────────
// After /compact, Claude Code writes a `type:"system", subtype:"compact_boundary"`
// record followed by a `type:"user", isCompactSummary:true` record whose message
// content IS the summary. Reading it costs nothing; asking an agent to re-read
// the session would cost exactly what this feature is trying to save.
function extractCompactSummary(transcript, notBeforeMs) {
    if (!transcript) return null;
    let raw;
    try {
        const size = fs.statSync(transcript).size;
        const fd = fs.openSync(transcript, 'r');
        try {
            const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
            const len = size - start;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, start);
            raw = buf.toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return null;
    }
    if (raw.length && raw[0] !== '{') raw = raw.slice(raw.indexOf('\n') + 1);

    let best = null;
    for (const line of raw.split('\n')) {
        if (line.indexOf('isCompactSummary') === -1) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || rec.isCompactSummary !== true) continue;
        if (notBeforeMs) {
            const ts = Date.parse(rec.timestamp || '');
            if (!Number.isFinite(ts) || ts < notBeforeMs) continue;
        }
        const msg = rec.message;
        let content = msg && msg.content;
        if (Array.isArray(content)) {
            content = content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
        }
        if (typeof content === 'string' && content.trim()) best = content.trim();
    }
    return best;
}

// ── Is this pane actually Claude, or a bare shell? ───────────────────────────
// The two incidents behind this question (a compact summary pasted into bash on
// 2026-08-20, and the TUI change that blinded every call site on 2026-08-25) are
// written up in lib/sessionSpawn.js, which now owns the waiting and the pasting.
// What stays here is the READ of a pane, because the handoff inspects the OLD
// session before it touches anything.
const stripAnsi = paneShape.stripAnsi;
const looksLikeClaudePrompt = paneShape.looksLikeClaudePrompt;

function capturePane(session) {
    try {
        return stripAnsi(deps.tmux(['capture-pane', '-t', session, '-p', '-S', '-40']));
    } catch {
        return null;
    }
}

// base -> base-2 -> base-3 ... Shared with the morning routine so two callers
// cannot pick the same name in different ways.
const nextSessionName = sessionSpawn.nextSessionName;

// ── The handoff: compact the old session, prime a fresh one, retire the old ──

// Cutting the TAIL is the worst possible cut: a compact summary ends with the
// current work and the next step, which is the entire point of the handoff. So
// if one ever does exceed the cap, keep both ends and say out loud that the
// middle is missing, instead of handing the new session a sentence that stops.
function clampSummary(summary) {
    if (summary.length <= MAX_SUMMARY_CHARS) return summary;
    const head = Math.floor(MAX_SUMMARY_CHARS * 0.55);
    const tail = MAX_SUMMARY_CHARS - head;
    const dropped = summary.length - MAX_SUMMARY_CHARS;
    return summary.slice(0, head)
        + `\n\n[... ${dropped} characters trimmed from the middle of this summary ...]\n\n`
        + summary.slice(summary.length - tail);
}

function buildPrimingPrompt(summary, cwd, oldSession) {
    return [
        'You are continuing work from a previous session that was retired for context weight.',
        `Directory: ${cwd}`,
        `Previous session: ${oldSession} (already closed).`,
        '',
        'Below is the summary of what was going on. Pick up from there. You do not need to',
        're-read the whole project, but do verify any file before you touch it.',
        '',
        '--- SUMMARY OF THE PREVIOUS SESSION ---',
        summary,
        '--- END OF SUMMARY ---',
        '',
        'Reply with one line stating what you understand needs to happen next, and wait for',
        'confirmation before changing any code.',
    ].join('\n');
}

function setPhase(session, phase, extra = {}) {
    const cur = handoffs.get(session) || { startedAt: Date.now() };
    const next = { ...cur, phase, ...extra };
    // Stamp the ending so all() knows when it is safe to reap. Without it a
    // finished handoff either vanishes immediately (and the UI never sees the
    // result) or lingers forever.
    if (next.done && !next.finishedAt) next.finishedAt = Date.now();
    handoffs.set(session, next);
}

// Runs in the BACKGROUND after the HTTP ack, like runSelfRefresh: while the
// request is in flight the pane may still be working.
async function runHandoff(session, opts = {}) {
    const killOld = opts.killOld !== false;
    const started = Date.now();
    const row = weights.get(session);
    const transcript = row && row.transcript;
    try {
        // (0) PRE-FLIGHT, before anything that waits. A `&`-backgrounded shell in
        // the old pane dies when step (f) kills that session, and only Leon knows
        // whether that shell mattered -- so refuse and name it, rather than
        // deciding either way on his behalf. This runs FIRST because the honest
        // answer is instant: making him watch a 3-minute timeout for a verdict we
        // already have is its own kind of lie.
        setPhase(session, 'checking');
        const preTail = capturePane(session);
        if (preTail === null) throw new Error('could not read the session');
        const shells = paneShape.backgroundShells(paneShape.tailOf(preTail));
        if (shells) {
            throw new Error(`${shells} background shell${shells > 1 ? 's' : ''} still running`
                + ' - retiring this session would kill it. Stop it (or let it finish) and try again');
        }

        setPhase(session, 'waiting_idle');
        let r = await deps.waitPaneIdle(session, { timeoutMs: 180000 });
        if (!r.ok) throw new Error(`the session never went idle (${r.reason})`);

        const cwd = deps.getSessionPwd(session);
        if (!cwd) throw new Error('could not read the session directory');

        // (a) /compact in the old pane. Same keystroke contract as runSelfRefresh.
        // Check the box is there first: typing /compact at a shell is harmless,
        // but then step (b) fails with "no readable summary", which describes the
        // symptom and hides the cause.
        const oldTail = capturePane(session);
        if (oldTail === null) throw new Error('could not read the session');
        if (!looksLikeClaudePrompt(oldTail.trim().split('\n').slice(-20).join('\n'))) {
            throw new Error('this session is not sitting at a Claude prompt - nothing to compact');
        }
        setPhase(session, 'compacting');
        deps.tmux(['send-keys', '-t', session, '/compact']);
        await deps.sleep(450);
        deps.tmux(['send-keys', '-t', session, 'Enter']);
        await deps.sleep(2000);
        r = await deps.waitPaneIdle(session, { timeoutMs: 300000 });
        if (!r.ok) throw new Error(`/compact did not complete (${r.reason})`);

        // (b) Read the summary off disk. Free.
        setPhase(session, 'reading_summary');
        let summary = null;
        for (let i = 0; i < 6 && !summary; i++) {
            summary = extractCompactSummary(transcript, started);
            if (!summary) await deps.sleep(1500);
        }
        if (!summary) {
            throw new Error('/compact left no readable summary - old session untouched');
        }
        const rawLen = summary.length;
        summary = clampSummary(summary);

        // (c-e) Fresh session in the SAME directory, Claude booted in it, the
        // summary pasted once the input box is really on screen. The sequence
        // and both of its incidents live in lib/sessionSpawn.js.
        setPhase(session, 'starting_new');
        const newName = nextSessionName(session, deps.sessionExists);
        setPhase(session, 'starting_new', { newSession: newName });
        const spawned = await sessionSpawn.createPrimedSession({
            name: newName,
            cwd,
            prompt: buildPrimingPrompt(summary, cwd, session),
            onPhase: (p) => setPhase(session, p === 'priming' ? 'priming' : 'starting_new', { newSession: newName }),
        });
        if (!spawned.ok) {
            // The new session is left ALIVE on purpose: it is the only place to
            // see why Claude did not come up, and the old one is still untouched.
            throw new Error(`${spawned.error} (${session} left alive)`);
        }

        // (f) Only now is retiring the old one safe.
        if (killOld) {
            setPhase(session, 'killing_old', { newSession: newName });
            await deps.sleep(1200);
            try { deps.tmux(['kill-session', '-t', session]); }
            catch (e) { console.warn(`[weight] ${session}: kill failed: ${e.message}`); }
        }

        setPhase(session, 'done', { newSession: newName, done: true });
        console.log(`[weight] ${session} -> ${newName}: handoff done (summary ${summary.length} chars`
            + `${rawLen > summary.length ? `, TRIMMED from ${rawLen}` : ''}, old ${killOld ? 'killed' : 'kept'})`);
        weights.delete(session);
        snoozes.delete(session);
    } catch (e) {
        console.warn(`[weight] ${session}: handoff aborted: ${e.message}`);
        setPhase(session, 'failed', { error: e.message, done: true });
    }
}

function startHandoff(session, opts = {}) {
    const existing = handoffs.get(session);
    if (existing && !existing.done) return { status: 'already_running', phase: existing.phase };
    handoffs.set(session, { phase: 'queued', startedAt: Date.now() });
    setImmediate(() => runHandoff(session, opts));
    return { status: 'scheduled' };
}

module.exports = {
    configure,
    record,
    snooze,
    forget,
    all,
    thresholds,
    setThresholds,
    levelFor,
    handoffState,
    startHandoff,
    extractCompactSummary,
    clampSummary,
    nextSessionName,
};
