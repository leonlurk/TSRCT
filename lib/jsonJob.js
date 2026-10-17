'use strict';
// ── jsonJob.js — "ask headless Claude, get back JSON you can trust" ──────────
//
// WHY THIS EXISTS: three places already ask `claude -p` for JSON and each one
// re-invented the read-back — lib/dispatcher/worklogEngine.js:87 (fence strip +
// outermost [...]), lib/syften-daily.js:224 (out.match(/\[[\s\S]*\]/)),
// lib/dispatcher/digestEngine.js. None of them validates the SHAPE, so a run
// that answers with valid JSON of the wrong form ("{"error": "..."}" or an
// object where an array was asked for) gets as far as the code that consumes it
// before it breaks, and the failure is reported wherever it finally lands.
//
// Here the parse, the shape check and the retry live in one place:
//   - strip prose and ``` fences, take the outermost object or array;
//   - check it against a tiny declarative shape (no dependency, no JSON Schema);
//   - on a bad answer, RE-ASK ONCE with the parse error quoted back, then give
//     up with the raw text preserved for the log.
//
// The retry is deliberately one: a model that answered prose twice will answer
// prose a third time, and every attempt is a real headless Claude run.
//
// SecretCo: this goes through analyst.submitJob, which holds the choke point for
// every `claude -p` job in the tree (jobData + key). Nothing extra here — and
// callers that inline live content into the INSTRUCTION must guard it
// themselves, exactly as promptPolisher.submitFollowup does.

// ── shape checking ───────────────────────────────────────────────────────────
// A shape is one of:
//   'string' | 'number' | 'boolean' | 'any'
//   { array: <shape>, min?: n }
//   { object: { key: <shape>, ... }, optional?: ['key', ...] }
// Errors read like a path so the retry prompt can quote them:
//   sessions[0].cwd: expected string, got number
function checkShape(value, shape, path = '') {
    const at = path || 'the answer';
    if (shape === 'any') return [];
    if (typeof shape === 'string') {
        const t = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
        return t === shape ? [] : [`${at}: expected ${shape}, got ${t}`];
    }
    if (shape && shape.array) {
        if (!Array.isArray(value)) return [`${at}: expected an array, got ${value === null ? 'null' : typeof value}`];
        if (shape.min && value.length < shape.min) return [`${at}: expected at least ${shape.min} item(s), got ${value.length}`];
        const errs = [];
        value.forEach((v, i) => errs.push(...checkShape(v, shape.array, `${path || 'answer'}[${i}]`)));
        return errs;
    }
    if (shape && shape.object) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return [`${at}: expected an object, got ${Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value)}`];
        }
        const optional = new Set(shape.optional || []);
        const errs = [];
        for (const [k, s] of Object.entries(shape.object)) {
            const has = Object.prototype.hasOwnProperty.call(value, k) && value[k] !== null && value[k] !== undefined;
            if (!has) {
                if (!optional.has(k)) errs.push(`${path ? path + '.' : ''}${k}: missing`);
                continue;
            }
            errs.push(...checkShape(value[k], s, `${path ? path + '.' : ''}${k}`));
        }
        return errs;
    }
    return [`${at}: unknown shape declaration`];
}

// ── parsing ──────────────────────────────────────────────────────────────────
// Headless Claude answers with the JSON plus, often, a sentence around it or a
// ```json fence. Take the outermost balanced object/array so a brace inside a
// string cannot end the scan early (the old `/\[[\s\S]*\]/` regex also ate any
// trailing prose that happened to contain a bracket).
function extractJson(text) {
    const raw = String(text == null ? '' : text);
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : raw;
    const start = findFirstStart(body);
    if (start < 0) return { ok: false, error: 'no JSON object or array in the answer' };
    const end = matchEnd(body, start);
    if (end < 0) return { ok: false, error: 'the JSON in the answer is not closed' };
    const slice = body.slice(start, end + 1);
    try {
        return { ok: true, value: JSON.parse(slice), text: slice };
    } catch (e) {
        return { ok: false, error: `not valid JSON: ${e.message}` };
    }
}

function findFirstStart(s) {
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '{' || s[i] === '[') return i;
    }
    return -1;
}

// Balance-aware scan: counts braces/brackets, skips anything inside a string,
// honours backslash escapes.
function matchEnd(s, start) {
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) return i; }
    }
    return -1;
}

// Parse + validate in one step. Exported on its own because it is useful over
// any text, including output that did not come from a job (a pane capture, a
// file on disk).
function parse(text, shape) {
    const got = extractJson(text);
    if (!got.ok) return got;
    if (!shape) return got;
    const errs = checkShape(got.value, shape);
    if (errs.length) return { ok: false, error: `the JSON does not have the expected shape:\n- ${errs.join('\n- ')}`, value: got.value };
    return got;
}

// ── the job ──────────────────────────────────────────────────────────────────
// run({ analyst, key, kind, jobData, instruction, shape, allowedTools, model, retries })
//   -> { ok: true, value, raw } | { ok: false, error, raw, attempts }
//
// `analyst` is lib/dispatcher/clickupAnalyst (injected so this module stays
// testable and never reaches into the dispatcher on its own).
function run({ analyst, key, kind, jobData, instruction, shape, allowedTools, model, retries = 1 }) {
    if (!analyst || typeof analyst.submitJob !== 'function') {
        return Promise.resolve({ ok: false, error: 'no analyst job runner available', raw: '' });
    }
    let attempt = 0;

    const once = (instr, jobKey) => new Promise((resolve) => {
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; resolve(r); } };
        try {
            analyst.submitJob({
                key: jobKey,
                kind: kind || 'json',
                jobData,
                instruction: instr,
                allowedTools,
                model,
                onResult: (txt) => done({ ok: true, raw: txt }),
                onTimeout: () => done({ ok: false, raw: '', error: 'the job timed out' }),
                onError: (e) => done({ ok: false, raw: '', error: String(e) }),
                onCancel: () => done({ ok: false, raw: '', error: 'the job was cancelled' }),
            });
        } catch (e) {
            // SecretCo refusals land here: assertNotRestricted throws synchronously.
            done({ ok: false, raw: '', error: e.message });
        }
    });

    const go = async (instr, jobKey) => {
        attempt++;
        const r = await once(instr, jobKey);
        if (!r.ok) return { ...r, attempts: attempt };
        const parsed = parse(r.raw, shape);
        if (parsed.ok) return { ok: true, value: parsed.value, raw: r.raw, attempts: attempt };
        if (attempt > retries) {
            return { ok: false, error: parsed.error, raw: r.raw, attempts: attempt };
        }
        // Re-ask with the problem quoted. Keeping the original instruction in
        // full matters: a retry that only says "send JSON" loses the task.
        const retryInstr = [
            instr,
            '',
            '--- YOUR PREVIOUS ANSWER WAS REJECTED ---',
            parsed.error,
            '',
            'Answer again with ONLY the JSON. No prose before or after it, no markdown fence,',
            'no explanation. If you cannot fill a field, use null rather than dropping it.',
        ].join('\n');
        return go(retryInstr, `${jobKey}-retry${attempt}`);
    };

    return go(instruction, key);
}

module.exports = { run, parse, extractJson, checkShape };
