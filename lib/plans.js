'use strict';
// ── plans.js — his work plans, the ones Tesla orchestrates (2026-10-25) ──────
//
// The owner wants to plan his work days: a plan is defined by goals and steps,
// Tesla helps him make those steps precise, and every plan goes through the
// /deeper method.
//
// A plan is a day, a week, or free; it holds GOALS, and each goal holds STEPS.
// Every step says where it runs (a session), with what (the session itself, the
// separate browser, his PC, or him), and what "done" means in a way that can be
// checked. He writes the goals in Tesla's full screen; `deepen()` hands them to
// the `hands` worker on Opus, which applies the /deeper method and proposes the
// steps; he approves them there. Phase 3 marks progress from evidence, phase 4
// runs the steps: both read this file, nothing else holds a plan.
//
// Kept in .tsrct/plans.json (not boot-stamped: a plan outlives a restart).
// SecretCo: a plan that names it is refused on save, because the plan's text goes
// to a model (the worker) and onto a session's screen.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const restrictedGuard = require('./dispatcher/restrictedGuard');
const { stateFile } = require('./stateFile');
const { NAME: OWNER } = require('./owner');

const MAX_PLANS = 60;
const MAX_GOALS = 12;
const MAX_STEPS = 25;
const KINDS = ['day', 'week', 'free'];
// session: one of his sessions types it; browser: the separate browser
// (projector); pc: his Windows PC, mouse last; me: he does it himself.
const TOOLS = ['session', 'browser', 'pc', 'me'];
const STATUS = ['todo', 'doing', 'done', 'blocked'];
// What makes a step stop and ask him before it runs, whoever runs it.
const RISKS = ['', 'client-data', 'date', 'money', 'send'];
const STATES = ['draft', 'deepening', 'proposed', 'approved'];
// How phase 3 proves a step is done (lib/planTracker.js), without taking
// anyone's word for it: git = a commit in the step's session folder, made after
// the plan was approved, whose subject contains `arg`; file = a file under his
// projects folder, written after approval; manual = he ticks it.
const CHECKS = ['git', 'file', 'manual'];

let deps = {
    file: '',              // tests point this somewhere else
    hands: null,           // lib/teslaHands.js
    sessions: null,        // () => [{name, cwd}] of his live sessions, never SecretCo
    projects: null,        // () => [{name, cwd}] known project folders
    say: null,             // (line) => told to him
};
function configure(d) { deps = { ...deps, ...(d || {}) }; }
function file() { return deps.file || stateFile('plans.json'); }

const id = (p) => `${p}${crypto.randomBytes(4).toString('hex')}`;
const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function load() {
    try {
        const o = JSON.parse(fs.readFileSync(file(), 'utf8'));
        return Array.isArray(o.plans) ? o.plans : [];
    } catch { return []; }
}
function store(plans) {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify({ plans }, null, 1));
    fs.renameSync(f + '.tmp', f);
}

// Whatever comes in (the page, the worker) is rebuilt field by field: unknown
// keys are dropped, lengths are capped, and ids are kept only if they look like ours.
// `page`: the save comes from the plan column, whose copy can be minutes old.
// Then what the tracker and the pilot own (status, evidence, his OK) is kept
// from the server's copy, so a keystroke never undoes a step marked done.
function cleanStep(s, old, page) {
    const o = old || {};
    if (page && old) s = { ...s, status: o.status, evidence: o.evidence, at: o.at, cleared: o.cleared };
    else if (page) s = { ...s, status: 'todo', evidence: '', at: 0, cleared: false };
    return {
        id: /^s[0-9a-f]{8}$/.test(String(s.id || '')) ? s.id : id('s'),
        text: str(s.text, 400),
        session: /^[A-Za-z0-9._@-]{0,64}$/.test(String(s.session || '')) ? String(s.session || '') : '',
        tool: pick(s.tool, TOOLS, 'session'),
        done: str(s.done, 300),
        risk: pick(s.risk, RISKS, ''),
        check: cleanCheck(s.check !== undefined ? s.check : o.check),
        status: pick(s.status, STATUS, o.status || 'todo'),
        evidence: str(s.evidence !== undefined ? s.evidence : o.evidence, 300),
        // he cleared a risky step for autopilot (blocked -> todo, by hand)
        cleared: s.cleared !== undefined ? !!s.cleared : !!o.cleared,
        at: Number(s.at || o.at) || 0,
    };
}
function cleanCheck(c) {
    const kind = pick(c && c.kind, CHECKS, 'manual');
    return { kind, arg: kind === 'manual' ? '' : str(c.arg, 200) };
}
function cleanGoal(g, old, page) {
    const before = new Map(((old && old.steps) || []).map(s => [s.id, s]));
    return {
        id: /^g[0-9a-f]{8}$/.test(String(g.id || '')) ? g.id : id('g'),
        text: str(g.text, 300),
        beyond: str(g.beyond, 300),
        steps: (Array.isArray(g.steps) ? g.steps : []).slice(0, MAX_STEPS)
            .map(s => cleanStep(s || {}, before.get(s && s.id), page)).filter(s => s.text),
    };
}
function cleanPlan(p, old, page) {
    const before = new Map(((old && old.goals) || []).map(g => [g.id, g]));
    const kind = pick(p.kind, KINDS, 'day');
    const plan = {
        id: (old && old.id) || id('p'),
        title: str(p.title, 120),
        kind,
        date: kind === 'free' ? '' : (DAY.test(String(p.date || '')) ? p.date : today()),
        goals: (Array.isArray(p.goals) ? p.goals : []).slice(0, MAX_GOALS)
            .map(g => cleanGoal(g || {}, before.get(g && g.id), page)).filter(g => g.text),
        // Phase 4: the permission prompts autopilot may answer for this plan,
        // set by him. Anything else rings his phone.
        allow: (Array.isArray(p.allow) ? p.allow : []).map(a => str(a, 120)).filter(Boolean).slice(0, 20),
        state: pick(p.state, STATES, (old && old.state) || 'draft'),
        approvedAt: 0,
        // phase 4: autopilot runs this plan (lib/planPilot.js). Only an approved plan flies.
        pilot: false,
        note: str(p.note !== undefined ? p.note : (old && old.note), 600),
        createdAt: (old && old.createdAt) || Date.now(),
        updatedAt: Date.now(),
    };
    // Evidence counts only from the moment he approved: work done before is not this plan's.
    plan.approvedAt = plan.state === 'approved' ? ((old && old.state === 'approved' && old.approvedAt) || Date.now()) : 0;
    plan.pilot = plan.state === 'approved' && (!page && p.pilot !== undefined ? !!p.pilot : !!(old && old.pilot));
    if (page && old) plan.allow = old.allow;
    if (!plan.title) plan.title = plan.kind === 'week' ? `Week of ${plan.date}` : plan.kind === 'day' ? plan.date : 'Plan';
    return plan;
}

function today(now = new Date()) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function assertClean(plan) {
    const words = [plan.title, plan.note, ...plan.allow, ...plan.goals.flatMap(g => [g.text, g.beyond, ...g.steps.flatMap(s => [s.text, s.done, s.session, s.evidence, s.check.arg])])];
    restrictedGuard.assertNotRestricted('tesla plan', ...words);
}

function list() {
    return load().sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.updatedAt - a.updatedAt);
}
function get(planId) { return load().find(p => p.id === planId) || null; }

function save(input, { page } = {}) {
    const plans = load();
    const at = plans.findIndex(p => p.id === (input && input.id));
    const plan = cleanPlan(input || {}, at >= 0 ? plans[at] : null, !!page);
    assertClean(plan);
    if (at >= 0) plans[at] = plan; else plans.push(plan);
    // The oldest finished-with plans go first when there are too many.
    plans.sort((a, b) => b.updatedAt - a.updatedAt);
    store(plans.slice(0, MAX_PLANS));
    return plan;
}
function remove(planId) {
    const plans = load();
    const left = plans.filter(p => p.id !== planId);
    if (left.length === plans.length) return false;
    store(left);
    return true;
}

// One step changed (its status, the evidence for it): the only write phase 3 makes.
function setStep(planId, stepId, patch) {
    const plans = load();
    const plan = plans.find(p => p.id === planId);
    const step = plan && plan.goals.flatMap(g => g.steps).find(s => s.id === stepId);
    if (!step) return null;
    if (patch.status !== undefined) {
        const next = pick(patch.status, STATUS, step.status);
        // His hand moving a blocked step back to todo is the OK the pilot waits for.
        if (patch.byHim && step.status === 'blocked' && next === 'todo') step.cleared = true;
        step.status = next;
        step.at = Date.now();
    }
    if (patch.evidence !== undefined) step.evidence = str(patch.evidence, 300);
    restrictedGuard.assertNotRestricted('tesla plan', step.evidence);
    plan.updatedAt = Date.now();
    store(plans);
    return step;
}

// The plan that is on now: today's day plan, else the week that holds today.
function current(now = new Date()) {
    const d = today(now);
    const all = load();
    const day = all.find(p => p.kind === 'day' && p.date === d);
    if (day) return day;
    const t = Date.parse(d);
    return all.find(p => p.kind === 'week' && p.date && t >= Date.parse(p.date) && t < Date.parse(p.date) + 7 * 864e5) || null;
}

function progress(plan) {
    const steps = plan.goals.flatMap(g => g.steps);
    return { steps: steps.length, done: steps.filter(s => s.status === 'done').length, blocked: steps.filter(s => s.status === 'blocked').length };
}

// One line for Tesla's brain, so "que sigue en mi plan" has an answer. Short on
// purpose: her context is kept light.
function describe(now = new Date()) {
    const plan = current(now);
    if (!plan || !plan.goals.length) return '';
    const p = progress(plan);
    const next = plan.goals.flatMap(g => g.steps.map(s => ({ g, s }))).find(x => x.s.status !== 'done');
    return `PLAN ACTUAL "${plan.title}" (${plan.state === 'approved' ? 'aprobado' : 'sin aprobar'}): ${plan.goals.length} objetivos, ${p.done}/${p.steps} pasos hechos`
        + (p.blocked ? `, ${p.blocked} trabados` : '')
        + (next ? `. Lo siguiente: "${next.s.text.slice(0, 120)}"${next.s.session ? ` en ${next.s.session}` : ''} (objetivo "${next.g.text.slice(0, 60)}")` : '. Todo hecho');
}

// ── phase 2: the /deeper pass ────────────────────────────────────────────────
// His goals go to the `hands` worker on Opus, which works them through the
// /deeper method and answers with the steps as one JSON line. The steps land as
// a PROPOSAL: nothing runs until he approves the plan in the full screen.
function deeperTask(plan) {
    const sessions = (typeof deps.sessions === 'function' ? deps.sessions() : []).slice(0, 30);
    const projects = (typeof deps.projects === 'function' ? deps.projects() : []).slice(0, 40);
    const goals = plan.goals.map((g, i) => `${i + 1}. ${g.text}${g.steps.length ? `\n   pasos que ya escribio: ${g.steps.map(s => s.text).join(' | ')}` : ''}`).join('\n');
    return [
        `PLAN DE TRABAJO de ${OWNER}: "${plan.title}" (${plan.kind === 'week' ? `semana desde ${plan.date}` : plan.kind === 'day' ? `dia ${plan.date}` : 'sin fecha'}).`,
        plan.note ? `Lo que agrego: ${plan.note}` : '',
        `Sus objetivos:\n${goals}`,
        `Sus sesiones abiertas (tmux, con su carpeta): ${sessions.map(s => `${s.name} (${s.cwd})`).join(', ') || 'ninguna'}.`,
        projects.length ? `Sus proyectos: ${projects.map(p => p.name).join(', ')}.` : '',
        'Aplica el metodo del skill /deeper a CADA objetivo (lee ~/.claude/skills/deeper/SKILL.md): que haria el mejor profesional, el material crudo, los metodos reales, el juez externo, y el objetivo detras del objetivo. NO le preguntes si va: el aprueba los pasos en la pantalla de Tesla.',
        'Despues convierte cada objetivo en pasos PRECISOS, en orden. Cada paso:',
        '- "text": que hay que hacer, una frase concreta (no "trabajar en X").',
        '- "session": la sesion tmux donde se hace (una de las de arriba), o "" si no hay una que sirva.',
        '- "tool": "session" (lo escribe una sesion de Claude), "browser" (el navegador aparte), "pc" (su PC con el mouse, solo si no hay otro camino) o "me" (lo tiene que hacer el).',
        '- "done": como se COMPRUEBA que esta hecho sin creerle a nadie: un commit, un test que pasa, un archivo que existe, un estado en ClickUp. Nunca "Claude dice que termino".',
        '- "check": como lo comprueba TSRCT solo, sin preguntarle a nadie: {"kind":"git","arg":"<palabras que va a tener el titulo del commit>"} si el paso termina en un commit en la carpeta de su sesion, {"kind":"file","arg":"<ruta completa del archivo que va a existir>"} si termina en un archivo, o {"kind":"manual"} si solo el puede decir que esta hecho.',
        '- "risk": "client-data" si cambia datos de un cliente o contables, "date" si mueve una fecha prometida a un cliente, "money" si cobra o paga, "send" si le manda algo a otra persona, o "".',
        `Puedes leer los proyectos para que los pasos sean reales, pero no cambies nada. Lee SOLO con las herramientas Read, Grep y Glob, nunca con Bash: un comando de Bash frena en una tarjeta de permiso y ${OWNER} tiene que aprobarla.`,
        'Antes de la linea RESULTADO, escribe UNA linea exactamente asi (JSON en una linea):',
        'PASOS {"goals":[{"n":1,"beyond":"<el objetivo detras del objetivo, una frase>","steps":[{"text":"...","session":"...","tool":"session","done":"...","check":{"kind":"git","arg":"..."},"risk":""}]}]}',
        'En RESULTADO, "dijo" es una frase para decirle en voz alta: cuantos pasos propones y que los revise en pantalla completa.',
    ].filter(Boolean).join('\n');
}

// The PASOS line out of the worker's whole answer.
function parseSteps(text) {
    const m = /^PASOS\s*(\{.*\})\s*$/m.exec(String(text || ''));
    if (!m) return null;
    try {
        const o = JSON.parse(m[1]);
        return Array.isArray(o.goals) ? o.goals : null;
    } catch { return null; }
}

function deepen(planId) {
    if (!deps.hands) throw new Error('the worker is not wired');
    const plan = get(planId);
    if (!plan) throw new Error('no such plan');
    if (!plan.goals.length) throw new Error('write at least one goal first');
    if (plan.state === 'deepening') return { ok: true, already: true };
    assertClean(plan);
    const task = deeperTask(plan);
    const r = deps.hands.start({
        recipe: 'plan_steps', level: 'complex', changes: false, task,
        onText: (text) => land(planId, text),
    });
    save({ ...plan, state: 'deepening' });
    return { ok: true, key: r.key, model: r.model };
}

// The worker answered: its steps become the plan's proposal. Steps he had
// already ticked keep their status when the worker kept them word for word.
// A step that names SecretCo anywhere is left out (it would go back to a model),
// and so is a "beyond" line that does: the rest of the plan still lands.
const namesSecretCo = (o) => restrictedGuard.mentionsRestricted(JSON.stringify(o || ''));
function land(planId, text) {
    const plan = get(planId);
    if (!plan) return false;
    const goals = parseSteps(text);
    if (!goals) { save({ ...plan, state: 'draft' }); return false; }
    const next = plan.goals.map((g, i) => {
        const got = goals.find(x => Number(x.n) === i + 1);
        if (!got) return g;
        const kept = new Map(g.steps.map(s => [s.text, s]));
        const steps = (Array.isArray(got.steps) ? got.steps : []).filter(s => !namesSecretCo(s)).map(s => {
            const was = kept.get(str(s && s.text, 400));
            return was ? { ...s, id: was.id, status: was.status, evidence: was.evidence, at: was.at } : { ...s, status: 'todo' };
        });
        return { ...g, beyond: (!namesSecretCo(got.beyond) && got.beyond) || g.beyond, steps };
    });
    save({ ...plan, goals: next, state: 'proposed' });
    return true;
}

module.exports = {
    configure, list, get, save, remove, setStep, current, progress, describe, deepen, today,
    _parseSteps: parseSteps,
};
