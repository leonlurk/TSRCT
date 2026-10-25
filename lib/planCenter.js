'use strict';
// ── planCenter.js — phase 5: the command center's one read ───────────────────
//
// The owner asked for one place, Tesla's full screen, to see the plan's
// progress and her connections to the tmux sessions: the command center.
// One snapshot for the full screen's right side, polled every 4 s while it is
// open: the plan on now and how far it is, every session the plan touches
// (working, idle, waiting for a permission, closed) with the step it runs, the
// permission cards waiting in those sessions, and the latest plan events.
// Reads only; a card is answered through the existing /api/permission routes.
// Cost: one capture-pane per plan session per poll, and only while he looks.

const restrictedGuard = require('./dispatcher/restrictedGuard');
const events = require('./planEvents');

let deps = {
    plans: null,           // lib/plans.js
    pilot: null,           // lib/planPilot.js (active())
    exists: null,          // (session) => bool
    working: null,         // (session) => bool
    waiting: null,         // (session) => what a card asks, or ''
    pending: null,         // () => pending permission cards [{id, session, tool, command, file, description}]
};
function configure(d) { deps = { ...deps, ...(d || {}) }; }

const safe = (s) => (restrictedGuard.mentionsRestricted(String(s || '')) ? '' : String(s || ''));

function snapshot() {
    const plan = deps.plans ? deps.plans.current() : null;
    const active = deps.pilot ? deps.pilot.active() : [];
    const steps = plan ? plan.goals.flatMap(g => g.steps.map(s => ({ g, s }))) : [];
    const names = [...new Set([...steps.map(x => x.s.session), ...active.map(a => a.session)].filter(Boolean))]
        .filter(n => !restrictedGuard.mentionsRestricted(n)).slice(0, 12);
    const sessions = names.map(name => {
        let open = false, working = false, waiting = '';
        try { open = !!deps.exists(name); } catch { open = false; }
        if (open) {
            try { working = !!deps.working(name); } catch { working = false; }
            try { waiting = safe(deps.waiting(name)); } catch { waiting = ''; }
        }
        const run = active.find(a => a.session === name);
        const cur = steps.find(x => x.s.session === name && (run ? x.s.id === run.step : x.s.status === 'doing'))
            || steps.find(x => x.s.session === name && x.s.status !== 'done');
        const mine = steps.filter(x => x.s.session === name);
        return {
            name, open,
            state: !open ? 'gone' : waiting ? 'waiting' : working ? 'working' : 'idle',
            waiting: waiting.slice(0, 160),
            pilot: !!run,
            step: cur ? cur.s.text.slice(0, 160) : '', goal: cur ? cur.g.text.slice(0, 100) : '',
            done: mine.filter(x => x.s.status === 'done').length, total: mine.length,
        };
    });
    let cards = [];
    try { cards = (deps.pending ? deps.pending() : []).filter(c => names.includes(c.session)); } catch { cards = []; }
    // A card that names SecretCo anywhere is not shown at all (his approver still has it).
    const pending = cards.filter(c => !restrictedGuard.mentionsRestricted(JSON.stringify(c)))
        .map(c => ({ id: c.id, session: c.session, tool: c.tool, what: String(c.command || c.file || c.description || '').slice(0, 200) })).slice(0, 8);
    const p = plan ? deps.plans.progress(plan) : null;
    return {
        plan: plan ? { id: plan.id, title: safe(plan.title), state: plan.state, pilot: !!plan.pilot, done: p.done, steps: p.steps, blocked: p.blocked } : null,
        sessions, pending, events: events.recent(20),
    };
}

module.exports = { configure, snapshot };
