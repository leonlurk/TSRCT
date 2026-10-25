'use strict';
// ── planTracker.js — phase 3: progress from evidence, not from anyone's word ──
//
// The owner (2026-10-25): Tesla has to track progress precisely against his
// open sessions. A session saying "listo" is not proof; a commit is.
// Once a minute, for the plan on now (lib/plans.js current()) and only once he
// approved it, every open step with an automatic check is tested:
//   git  - a commit in the step's session folder, made after he approved the
//          plan, whose subject contains the step's words;
//   file - the file exists under his projects folder, written after approval.
// A step that passes is marked done with the evidence (the commit or the file)
// and she tells him in one line. `manual` steps are his to tick. Nothing here
// runs a command a model wrote, and nothing is ever marked undone.
//
// Cheap: one `git log` per folder per minute, only while an approved plan has
// open checks. Started through automations.bootLoop('plan-tracker').

const fs = require('fs');
const path = require('path');
const restrictedGuard = require('./dispatcher/restrictedGuard');
const events = require('./planEvents');

const EVERY_MS = Number(process.env.PLAN_TRACKER_MS || 60 * 1000);

let deps = {
    plans: null,           // lib/plans.js
    cwdOf: null,           // (session) => its folder
    // (cwd, sinceMs) => [{hash, subject, at}] - argv git, allowed roots, never SecretCo
    commits: null,
    projectsRoot: '',
    say: null,             // (line) => told to him (orb, or his phone)
};
function configure(d) { deps = { ...deps, ...(d || {}) }; }

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Does a commit subject carry the step's words? Every word of 3+ letters, in any order.
function subjectMatches(subject, arg) {
    const words = norm(arg).split(/[^a-z0-9._/-]+/).filter(w => w.length >= 3);
    if (!words.length) return false;
    const s = norm(subject);
    return words.every(w => s.includes(w));
}

function checkGit(step, since, cache) {
    if (!step.session || !deps.cwdOf || !deps.commits) return null;
    let cwd = '';
    try { cwd = String(deps.cwdOf(step.session) || ''); } catch { cwd = ''; }
    if (!cwd || restrictedGuard.mentionsRestricted(cwd)) return null;
    if (!cache.has(cwd)) {
        let list = [];
        try { list = deps.commits(cwd, since) || []; } catch { list = []; }
        cache.set(cwd, list);
    }
    const hit = cache.get(cwd).find(c => c.at >= since && subjectMatches(c.subject, step.check.arg));
    return hit ? `commit ${String(hit.hash).slice(0, 7)} "${String(hit.subject).slice(0, 120)}"` : null;
}

function checkFile(step, since) {
    const f = path.resolve(String(step.check.arg || ''));
    const root = deps.projectsRoot ? path.resolve(deps.projectsRoot) : '';
    if (!root || !f.startsWith(root + path.sep) || restrictedGuard.mentionsRestricted(f)) return null;
    try {
        const st = fs.statSync(f);
        // 2 s of slack: the kernel stamps files with a coarse clock that can read
        // a few ms behind Date.now(), and check-plans failed 1 run in 3 on it.
        return st.mtimeMs >= since - 2000 ? `file ${f.slice(root.length + 1)} written ${new Date(st.mtimeMs).toTimeString().slice(0, 5)}` : null;
    } catch { return null; }
}

// One pass. Returns the steps it marked done (for tests and the log).
function tick(now = new Date()) {
    const plan = deps.plans && deps.plans.current(now);
    if (!plan || plan.state !== 'approved' || !plan.approvedAt) return [];
    const cache = new Map();
    const marked = [];
    for (const g of plan.goals) {
        for (const s of g.steps) {
            if (s.status === 'done' || !s.check || s.check.kind === 'manual' || !s.check.arg) continue;
            let evidence = null;
            try {
                evidence = s.check.kind === 'git' ? checkGit(s, plan.approvedAt, cache) : checkFile(s, plan.approvedAt);
            } catch (e) { console.warn('[planTracker]', e.message); evidence = null; }
            if (!evidence || restrictedGuard.mentionsRestricted(evidence)) continue;
            const step = deps.plans.setStep(plan.id, s.id, { status: 'done', evidence });
            if (!step) continue;
            marked.push({ goal: g.text, step: s.text, evidence });
            events.push('done', `${s.text.slice(0, 120)} - proof: ${evidence}`, s.session);
        }
    }
    if (marked.length && deps.say) {
        const p = deps.plans.progress(deps.plans.get(plan.id));
        const line = marked.length === 1
            ? `Paso hecho: ${marked[0].step.slice(0, 100)}. Lo vi en ${marked[0].evidence.split(' "')[0]}. Van ${p.done} de ${p.steps}.`
            : `${marked.length} pasos hechos, con su prueba. Van ${p.done} de ${p.steps}.`;
        try { deps.say(line); } catch { /* nobody listening */ }
    }
    return marked;
}

let timer = null;
function start() {
    if (timer) return;
    timer = setInterval(() => { try { tick(); } catch (e) { console.warn('[planTracker]', e.message); } }, EVERY_MS);
    if (timer.unref) timer.unref();
}
function stop() { clearInterval(timer); timer = null; }
const running = () => !!timer;

module.exports = { configure, tick, start, stop, running, _subjectMatches: subjectMatches };
