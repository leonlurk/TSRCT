'use strict';
// ── planPilot.js — phase 4: autopilot runs his approved plan ─────────────────
//
// The owner (2026-10-25): leave TSRCT on autopilot and let Tesla run his whole
// plan, taking turns between the tmux sessions, managing them and sending him
// the updates.
//
// With the pilot ON for the plan on now (approved, lib/plans.js), every 20 s:
//   - each goal's next open step is looked at, in order; steps of different
//     goals run side by side, never two in the same session;
//   - a `session` step with no risk is typed into its session once that session
//     is idle, with what "done" means and the proof TSRCT will look for;
//   - a step with a risk (client data, a client date, money, sending), a step
//     that is his (`me`), or one with no session STOPS that goal and tells him,
//     urgent. A risky step goes on only after he clears it (blocked -> todo);
//   - a session that went quiet without the proof is asked once to leave it or
//     say what it needs; quiet again, the step is blocked and he is told;
//   - a permission card in a session running a pilot step is approved ONLY if it
//     matches the plan's allow list (set by him, `allow`); anything else rings him.
// "done" is still decided by lib/planTracker.js from the proof, never here.
//
// Not yet: answering a session's questions by itself (they go to him), and
// browser/PC steps (they stop and go to him too).

const restrictedGuard = require('./dispatcher/restrictedGuard');
const { NAME: OWNER } = require('./owner');
const events = require('./planEvents');

const EVERY_MS = Number(process.env.PLAN_PILOT_MS || 20 * 1000);
// How long a session may sit idle after its step before it is nudged, and
// after the nudge before the step is called stuck.
const QUIET_MS = Number(process.env.PLAN_PILOT_QUIET_MS || 90 * 1000);

let deps = {
    plans: null,           // lib/plans.js
    exists: null,          // (session) => bool
    working: null,         // (session) => true | false (mid-turn or not)
    waiting: null,         // (session) => what a permission card asks, or ''
    send: null,            // (session, text) => types it and presses Enter
    say: null,             // (line, {urgent}) => told to him (orb, or his phone)
};
function configure(d) { deps = { ...deps, ...(d || {}) }; }

// stepId -> { session, sentAt, sawWorking, quietSince, nudged }
const live = new Map();

function proofLine(s) {
    if (s.check && s.check.kind === 'git' && s.check.arg) return `TSRCT lo da por hecho cuando vea un commit en esta carpeta con estas palabras en el titulo: "${s.check.arg}".`;
    if (s.check && s.check.kind === 'file' && s.check.arg) return `TSRCT lo da por hecho cuando exista el archivo ${s.check.arg}.`;
    return `Cuando termines, decilo en una frase: ${OWNER} lo marca.`;
}
function prompt(g, s) {
    return [
        `PASO DEL PLAN DE ${OWNER.toUpperCase()} (lo manda Tesla, piloto automatico).`,
        `Objetivo: ${g.text}`,
        `Paso: ${s.text}`,
        s.done ? `Esta hecho cuando: ${s.done}` : '',
        proofLine(s),
        `Hace SOLO este paso. Si necesitas una decision de ${OWNER}, preguntala en una frase y para.`,
    ].filter(Boolean).join(' ');
}

// The plan the pilot works on: the plan on now, approved, pilot on.
function flying(now) {
    const plan = deps.plans && deps.plans.current(now);
    return plan && plan.state === 'approved' && plan.pilot ? plan : null;
}

function tell(line, urgent) { try { if (deps.say) deps.say(line, { urgent: !!urgent }); } catch { /* nobody listening */ } }
function block(plan, s, why, urgent) {
    deps.plans.setStep(plan.id, s.id, { status: 'blocked', evidence: why });
    events.push('blocked', `${s.text.slice(0, 90)}: ${why}`, s.session);
    live.delete(s.id);
    tell(`Piloto: paro en "${s.text.slice(0, 90)}". ${why}`, urgent);
}

function tick(now = new Date()) {
    const plan = flying(now);
    if (!plan) { live.clear(); return []; }
    const did = [];
    // A step the tracker proved done (or he moved by hand) frees its session:
    // the first real run kept step two waiting forever behind a finished step one.
    const open = new Set(plan.goals.flatMap(g => g.steps).filter(x => x.status === 'doing').map(x => x.id));
    for (const id of [...live.keys()]) if (!open.has(id)) live.delete(id);
    const busy = new Set([...live.values()].map(x => x.session));
    for (const g of plan.goals) {
        const s = g.steps.find(x => x.status !== 'done');
        if (!s || s.status === 'blocked') continue;          // finished, or waiting for him
        // already running: watch it
        const run = live.get(s.id);
        if (run) { watch(plan, s, run, now.getTime()); continue; }
        // His step: told once; after he clears it, it waits for his tick, never asked again.
        if (s.tool !== 'session' || !s.session) {
            if (!s.cleared) { block(plan, s, s.tool === 'me' ? 'Este paso es tuyo.' : 'Este paso no tiene una sesion que lo haga.', false); did.push({ step: s.id, why: 'his' }); }
            continue;
        }
        if (s.risk && !s.cleared) { block(plan, s, `Necesita tu OK antes (${s.risk}). Cuando lo veas, pasalo de [!] a [ ] y sigo.`, true); did.push({ step: s.id, why: 'risk' }); continue; }
        if (busy.has(s.session)) continue;
        if (!deps.exists(s.session)) { block(plan, s, `La sesion ${s.session} no esta abierta.`, false); continue; }
        if (deps.working(s.session) || deps.waiting(s.session)) continue;    // its turn first
        const text = prompt(g, s);
        if (restrictedGuard.mentionsRestricted(text)) { block(plan, s, 'No lo puedo mandar desde aca.', false); continue; }
        const sent = deps.send(s.session, text);
        if (sent && sent.success === false) { block(plan, s, `No pude escribir en ${s.session}.`, false); continue; }
        deps.plans.setStep(plan.id, s.id, { status: 'doing' });
        events.push('sent', s.text.slice(0, 140), s.session);
        live.set(s.id, { session: s.session, sentAt: now.getTime(), sawWorking: false, quietSince: 0, nudged: false });
        busy.add(s.session);
        did.push({ step: s.id, sent: s.session });
    }
    const left = plan.goals.flatMap(g => g.steps).filter(x => x.status !== 'done');
    if (!left.length) {
        deps.plans.save({ ...plan, pilot: false });
        events.push('finished', `Plan "${plan.title}" complete, every step with its proof.`, '');
        tell(`Piloto: el plan "${plan.title}" esta completo, con prueba en cada paso.`, false);
    }
    return did;
}

function watch(plan, s, run, t) {
    if (!deps.exists(run.session)) return block(plan, s, `La sesion ${run.session} se cerro.`, true);
    if (deps.waiting(run.session)) { run.quietSince = 0; return; }   // the permission side handles it
    if (deps.working(run.session)) { run.sawWorking = true; run.quietSince = 0; return; }
    // idle: count from the first quiet look (or the send, if it never started)
    if (!run.quietSince) run.quietSince = run.sawWorking ? t : run.sentAt;
    if (t - run.quietSince < QUIET_MS) return;
    if (!run.nudged) {
        run.nudged = true;
        events.push('nudged', `${run.session} went quiet without the proof; asked once.`, run.session);
        run.quietSince = 0;
        run.sawWorking = false;
        deps.send(run.session, `Tesla (piloto): el paso "${s.text.slice(0, 120)}" todavia no tiene su prueba. ${proofLine(s)} Si te falta algo de ${OWNER}, decilo en una frase.`);
        return;
    }
    block(plan, s, `${run.session} paro sin la prueba. Mirala: puede estar esperando una respuesta tuya.`, true);
}

// ── permission cards (lib/routes/permissions.js) ─────────────────────────────
// "Bash(npm run check" allows Bash whose command starts with that; "Edit" allows
// every Edit. Only for a session running a pilot step, never anything naming SecretCo.
function matches(rule, perm) {
    const m = /^([A-Za-z]+)(?:\((.*))?$/.exec(String(rule || '').trim());
    if (!m || m[1] !== perm.tool) return false;
    if (m[2] === undefined) return true;
    const what = String(perm.command || perm.file || perm.description || '');
    const prefix = m[2].replace(/\)$/, '');
    return !!prefix && what.startsWith(prefix);
}
function piloting(session) { return [...live.values()].some(x => x.session === session); }
function allows(perm, now = new Date()) {
    if (!perm || !perm.session || !piloting(perm.session)) return false;
    const plan = flying(now);
    if (!plan || !plan.allow.length) return false;
    if (restrictedGuard.mentionsRestricted(JSON.stringify(perm))) return false;
    const rule = plan.allow.find(r => matches(r, perm));
    if (rule) events.push('allowed', `${perm.tool} ${String(perm.command || perm.file || '').slice(0, 100)} (list: ${rule})`, perm.session);
    return !!rule;
}
// A card the allow list did not cover, in a pilot session: he is told, urgent.
function onPermission(perm) {
    if (!perm || !piloting(perm.session)) return false;
    const what = restrictedGuard.mentionsRestricted(JSON.stringify(perm)) ? 'algo' : String(perm.command || perm.file || perm.description || perm.tool || 'algo').slice(0, 120);
    events.push('asked', `${perm.session} needs your OK for ${what}`, perm.session);
    tell(`Piloto: ${perm.session} necesita tu permiso para ${what}. No esta en la lista del plan.`, true);
    return true;
}

let timer = null;
function start() {
    if (timer) return;
    timer = setInterval(() => { try { tick(); } catch (e) { console.warn('[planPilot]', e.message); } }, EVERY_MS);
    if (timer.unref) timer.unref();
}
function stop() { clearInterval(timer); timer = null; }
const running = () => !!timer;

// For the command center: which session runs which step right now.
function active() { return [...live.entries()].map(([step, x]) => ({ step, session: x.session, sentAt: x.sentAt, nudged: x.nudged })); }

module.exports = { configure, tick, start, stop, running, allows, onPermission, active };
