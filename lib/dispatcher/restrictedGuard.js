// ─────────────────────────────────────────────────────────────────────────
// RESTRICTED PROJECTS GUARD  —  single chokepoint, fail-closed.
//
// Some projects must never reach an AI service or leave this machine: a client
// whose contract allows AI only through its own channel (for example AWS Bedrock,
// in a separate Claude Code session started with CLAUDE_CODE_USE_BEDROCK=1), work
// under NDA, anything you decide. List them in .env:
//
//     RESTRICTED_PROJECTS=secretco,acme-legal
//
// Each name is matched as a whole word (case-insensitive) in session names, folder
// paths, page titles, prompts and answers, and "<name>-sandbox" folders too. When a
// restricted project is detected, the feature is DISABLED - it fails out loud,
// never silently downgrades. Its work is done by hand, outside this tool.
//
// Detection is intentionally broad: a false positive (an ordinary task wrongly
// held back) is cheap, a false negative (restricted data reaching a model or an
// external service) is the breach this exists to prevent.
//
// With nothing set, the example name `secretco` is restricted, so the checks and
// the docs have something to exercise. Set your own list to replace it.
// ─────────────────────────────────────────────────────────────────────────

const NAMES = String(process.env.RESTRICTED_PROJECTS || 'secretco')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = NAMES.flatMap(n => [new RegExp(`\\b${esc(n)}\\b`, 'i'), new RegExp(`${esc(n)}-?sandbox`, 'i')]);

class RestrictedProjectError extends Error {
    constructor(feature) {
        super(`Restricted project: "${feature}" is disabled for it. ` +
            `Do this work by hand, outside TSRCT (see RESTRICTED_PROJECTS).`);
        this.name = 'RestrictedProjectError';
        this.code = 'RESTRICTED_PROJECT';
        this.feature = feature;
    }
}

// True if ANY of the given strings mentions a restricted project.
function mentionsRestricted(...texts) {
    for (const t of texts) {
        if (t == null) continue;
        const s = String(t);
        if (PATTERNS.some(re => re.test(s))) return true;
    }
    return false;
}

// True if a dispatcher task object relates to a restricted project (project, session, text…).
function taskIsRestricted(task) {
    if (!task) return false;
    return mentionsRestricted(
        task.project, task.matched_session, task.proposed_session, task.proposed_cwd,
        task.raw_text, task.composed_prompt, task.title, task.sender,
    );
}

// Throw if any of the given strings mentions a restricted project. Use at every egress point.
function assertNotRestricted(feature, ...texts) {
    if (mentionsRestricted(...texts)) throw new RestrictedProjectError(feature);
}

// Claude Code deny rules that keep a session's file tools out of every restricted
// path under these roots: by name anywhere below (every letter of every name in
// both cases, because Claude Code globs are case-sensitive), and every restricted
// folder at the top. Read(...) rules cover Grep and Glob too.
function denyRules(roots) {
    const fs = require('fs');
    const path = require('path');
    const rules = new Set();
    for (const root of new Set(roots)) {
        for (const name of NAMES) {
            const glob = [...name].map(c => /[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c).join('');
            rules.add(`Read(/${root}/**/*${glob}*)`);
            rules.add(`Read(/${root}/**/*${glob}*/**)`);
        }
        let names = [];
        try { names = fs.readdirSync(root); } catch { names = []; }
        for (const n of names) if (mentionsRestricted(n)) rules.add(`Read(/${path.join(root, n)}/**)`);
    }
    return [...rules];
}

module.exports = { NAMES, PATTERNS, RestrictedProjectError, mentionsRestricted, taskIsRestricted, assertNotRestricted, denyRules };
