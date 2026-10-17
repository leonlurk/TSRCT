'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// lib/handson.js — the plan store for HANDS ON.
//
// The deal: Claude PUBLISHES a plan here and never touches a project file; Leon
// types the plan in TSRCT and his progress comes back here so Claude can see
// what he actually wrote. Everything crossing between the two is this file.
//
// Durable on DISK, deliberately. `lib/dispatcher/db.js` drops and recreates its
// tables on every boot, and a half-typed lesson that evaporates when the server
// restarts is worse than no lesson at all — you lose the one thing you were
// building. Same call as `data/syften-items.json`.
//
// Standalone like sessionWeight/syften: a failure in here must not take anything
// else down, so every entry point returns a value and never throws at a caller.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, '..', 'data', 'handson-plans.json');

// Caps. A plan arrives from a model, so it is untrusted input in the ordinary
// sense: not malicious, but perfectly capable of being 4000 lines long by
// accident and taking the panel (and this file) with it.
const MAX_STEPS = 40;
const MAX_LINES = 200;
const MAX_TEXT = 400;
const MAX_WHY = 300;
const MAX_EVENTS = 100;
const MAX_PROJECTS = 40;

let state = null;   // { plans: { [cwd]: entry } }

function load() {
    if (state) return state;
    try {
        state = JSON.parse(fs.readFileSync(STORE, 'utf8'));
        if (!state || typeof state !== 'object' || !state.plans) state = { plans: {} };
    } catch {
        state = { plans: {} };   // absent or corrupt both mean "no plans yet"
    }
    return state;
}

function save() {
    try {
        fs.mkdirSync(path.dirname(STORE), { recursive: true });
        // tmp + rename: a crash mid-write must not leave a truncated file that
        // then parses as "no plans" and silently discards a lesson in progress.
        const tmp = STORE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, STORE);
        return true;
    } catch (e) {
        console.error('[handson] save failed:', e.message);
        return false;
    }
}

const clamp = (v, n) => String(v == null ? '' : v).slice(0, n);

// ── validation ───────────────────────────────────────────────────────────────
// Returns { ok:true, plan } or { ok:false, error }. This is the contract with
// the skill, so the errors are written to be READ by the model that got it
// wrong — "steps[2] has no lines" is actionable, "invalid plan" is not.
function validate(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be a JSON object' };
    const steps = raw.steps;
    if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: 'steps must be a non-empty array' };
    if (steps.length > MAX_STEPS) return { ok: false, error: `too many steps (${steps.length} > ${MAX_STEPS}); split the work into more than one plan` };

    const out = [];
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (!s || typeof s !== 'object') return { ok: false, error: `steps[${i}] is not an object` };
        if (!s.file || typeof s.file !== 'string') return { ok: false, error: `steps[${i}].file is required (repo-relative path)` };
        if (path.isAbsolute(s.file) || s.file.includes('..')) return { ok: false, error: `steps[${i}].file must be repo-relative, with no ".."` };
        if (!Array.isArray(s.lines) || s.lines.length === 0) return { ok: false, error: `steps[${i}].lines must be a non-empty array` };
        if (s.lines.length > MAX_LINES) return { ok: false, error: `steps[${i}] has ${s.lines.length} lines (max ${MAX_LINES}); a step should be one coherent chunk, not a whole file` };

        const lines = [];
        for (let j = 0; j < s.lines.length; j++) {
            const l = s.lines[j];
            if (!l || typeof l !== 'object' || typeof l.text !== 'string') {
                return { ok: false, error: `steps[${i}].lines[${j}] must be {text, why}` };
            }
            if (l.text.includes('\n')) return { ok: false, error: `steps[${i}].lines[${j}].text contains a newline; one entry per line` };
            // A line with no `why` is the whole feature missing. Blank lines are
            // the one exception: nothing to explain about an empty line.
            if (l.text.trim() && !String(l.why || '').trim()) {
                return { ok: false, error: `steps[${i}].lines[${j}] has no "why"; every non-blank line needs its plain-language reason` };
            }
            lines.push({ text: clamp(l.text, MAX_TEXT), why: clamp(l.why, MAX_WHY) });
        }
        out.push({
            file: clamp(s.file, 300),
            action: s.action === 'create' ? 'create' : 'edit',
            anchor: clamp(s.anchor, 200),
            note: clamp(s.note, 300),
            lines,
        });
    }
    return { ok: true, plan: { title: clamp(raw.title, 200) || 'untitled', steps: out } };
}

// ── public API ───────────────────────────────────────────────────────────────

function putPlan(cwd, raw, nowIso) {
    const v = validate(raw);
    if (!v.ok) return { ok: false, error: v.error };
    const st = load();
    st.plans[cwd] = {
        title: v.plan.title,
        steps: v.plan.steps,
        publishedAt: nowIso,
        progress: { stepIndex: 0, lineIndex: 0, typed: [], revealed: [], doneSteps: [], tally: { typed: 0, revealed: 0 } },
        events: [],
    };
    // Keep the store bounded: drop the least recently published projects.
    const keys = Object.keys(st.plans);
    if (keys.length > MAX_PROJECTS) {
        keys.sort((a, b) => String(st.plans[a].publishedAt).localeCompare(String(st.plans[b].publishedAt)))
            .slice(0, keys.length - MAX_PROJECTS)
            .forEach((k) => delete st.plans[k]);
    }
    save();
    const steps = v.plan.steps.length;
    const lines = v.plan.steps.reduce((n, s) => n + s.lines.length, 0);
    return { ok: true, steps, lines, title: v.plan.title };
}

function getPlan(cwd) {
    const e = load().plans[cwd];
    if (!e) return null;
    return { title: e.title, steps: e.steps, publishedAt: e.publishedAt, progress: e.progress };
}

function saveProgress(cwd, p) {
    const e = load().plans[cwd];
    if (!e) return { ok: false, error: 'no plan for this project' };
    e.progress = {
        stepIndex: Number(p.stepIndex) || 0,
        lineIndex: Number(p.lineIndex) || 0,
        typed: Array.isArray(p.typed) ? p.typed.map((t) => clamp(t, MAX_TEXT)) : [],
        revealed: Array.isArray(p.revealed) ? p.revealed.map(Boolean) : [],
        // Which steps are finished. Kept explicitly rather than derived from
        // stepIndex, because stepping BACK with [<] would otherwise re-open
        // every step after it and the rail would lie about what you have done.
        doneSteps: Array.isArray(p.doneSteps) ? p.doneSteps.slice(0, MAX_STEPS).map(Boolean) : [],
        tally: {
            typed: Number(p.tally && p.tally.typed) || 0,
            revealed: Number(p.tally && p.tally.revealed) || 0,
        },
    };
    save();
    return { ok: true };
}

// The signal back to Claude. It records what Leon ACTUALLY typed, not what the
// plan said — the two differing is the interesting case, and the whole reason
// the loop exists rather than the plan being fire-and-forget.
function recordStepDone(cwd, stepIndex, typedLines, nowIso) {
    const e = load().plans[cwd];
    if (!e) return { ok: false, error: 'no plan for this project' };
    const step = e.steps[stepIndex];
    if (!step) return { ok: false, error: 'no such step' };

    const expected = step.lines.map((l) => l.text);
    const actual = (Array.isArray(typedLines) ? typedLines : []).map((t) => clamp(t, MAX_TEXT));
    const diverged = [];
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
        const a = (actual[i] || '').replace(/\s+$/, '');
        const b = (expected[i] || '').replace(/\s+$/, '');
        if (a !== b) diverged.push({ line: i + 1, expected: expected[i] ?? null, typed: actual[i] ?? null });
    }

    e.events.push({
        at: nowIso,
        kind: 'step_done',
        step: stepIndex,
        file: step.file,
        lines: expected.length,
        diverged,
    });
    if (e.events.length > MAX_EVENTS) e.events = e.events.slice(-MAX_EVENTS);
    save();
    return { ok: true, diverged: diverged.length };
}

// Claude polls this. `since` is an index, so a re-read is cheap and idempotent
// and nothing is consumed — a poll that destroyed events would lose them the
// first time two windows polled at once.
function getEvents(cwd, since) {
    const e = load().plans[cwd];
    if (!e) return { events: [], next: 0, plan: null };
    const from = Math.max(0, Number(since) || 0);
    return {
        plan: { title: e.title, steps: e.steps.length, publishedAt: e.publishedAt },
        progress: e.progress,
        events: e.events.slice(from),
        next: e.events.length,
    };
}

function clearPlan(cwd) {
    const st = load();
    if (!st.plans[cwd]) return { ok: false, error: 'no plan for this project' };
    delete st.plans[cwd];
    save();
    return { ok: true };
}

module.exports = { putPlan, getPlan, saveProgress, recordStepDone, getEvents, clearPlan, validate };
