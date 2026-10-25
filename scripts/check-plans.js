#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/check-plans.js — the owner's work plans (lib/plans.js), against the real module.
//
//   - a plan is rebuilt field by field: unknown keys gone, bad values defaulted;
//   - a plan that names SecretCo is refused, because its text goes to a model;
//   - the plan "on now" is today's day plan, else the week holding today;
//   - the /deeper pass goes to the worker on Opus, read only, with the method
//     named, and its steps land as a PROPOSAL, never approved;
//   - a step he already ticked keeps its status when the worker keeps it;
//   - a worker that fails lets the plan go back to draft;
//   - an approved plan's steps are marked done from a commit or a file made
//     after approval, never from a session's word, and she says so once;
//   - a save from the column never undoes a step the tracker marked;
//   - autopilot flies only an approved plan he switched on, one step per
//     session, stops at every risk and his own steps, approves only the
//     plan's allow list, nudges once and then blocks a quiet session;
//   - the command center shows the plan's sessions, their state and step,
//     only their cards (never SecretCo), and the pilot's events;
//   - the full screen mounts the plan column and the route answers its four ops.
//
// Writes only to a temp folder. No network, no model, no tmux.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsrct-check-plans-'));
const plans = require(path.join(ROOT, 'lib/plans.js'));
const hands = require(path.join(ROOT, 'lib/teslaHands.js'));

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) pass++;
    else { fail++; console.log(`  FAIL ${label}`); }
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

let started = [];
plans.configure({
    file: path.join(tmp, 'plans.json'),
    hands: { start: (o) => { started.push(o); return { key: 'hands-1', model: 'Opus' }; } },
    sessions: () => [{ name: 'tsrct', cwd: '/p/TSRCT' }, { name: 'acme', cwd: '/p/acme' }],
    projects: () => [{ name: 'TSRCT', cwd: '/p/TSRCT' }],
});

// ── save: cleaned, ids, defaults ──
const p1 = plans.save({
    kind: 'day', date: '2026-10-25', title: 'Sunday', evil: 1,
    goals: [{ text: 'Ship the plan editor', steps: [{ text: 'write lib/plans.js', tool: 'rocket', risk: 'nuke', status: 'weird', session: 'tsrct; rm -rf /' }] }, { text: '' }],
});
ok(/^p[0-9a-f]{8}$/.test(p1.id) && p1.evil === undefined, 'a saved plan gets an id and loses unknown keys');
ok(p1.goals.length === 1 && /^g[0-9a-f]{8}$/.test(p1.goals[0].id), 'an empty goal is dropped, a real one gets an id');
const s1 = p1.goals[0].steps[0];
ok(s1.tool === 'session' && s1.risk === '' && s1.status === 'todo', 'a bad tool, risk or status falls back to the default');
ok(s1.session === '', 'a session name that is not a name is dropped');
ok(p1.state === 'draft', 'a new plan starts as a draft');
ok(plans.save({ kind: 'week', date: 'tomorrow', goals: [] }).date === plans.today(), 'a bad date becomes today');
ok(plans.save({ kind: 'free', date: '2026-10-25' }).date === '', 'a free plan has no date');

// ── SecretCo ──
ok(throws(() => plans.save({ title: 'x', goals: [{ text: 'Fix the SecretCo import' }] })), 'a goal naming SecretCo is refused');
ok(throws(() => plans.save({ title: 'x', goals: [{ text: 'ok', steps: [{ text: 'ok', done: 'SecretCoSandbox commit' }] }] })), 'a step naming SecretCo is refused');
ok(!plans.list().some(p => /secretco/i.test(JSON.stringify(p))), 'nothing naming SecretCo was written');

// ── current ──
ok(plans.current(new Date(2026, 9, 25, 9)).id === p1.id, "today's day plan is the one on now");
const wk = plans.save({ kind: 'week', date: '2026-10-26', goals: [{ text: 'week goal' }] });
ok(plans.current(new Date(2026, 9, 28, 9)).id === wk.id, 'mid-week, the week plan is on');
ok(plans.current(new Date(2026, 10, 9, 9)) === null, 'two weeks later, no plan is on');

// ── setStep ──
const st = plans.setStep(p1.id, s1.id, { status: 'done', evidence: 'commit abc123' });
ok(st && st.status === 'done' && st.evidence === 'commit abc123' && st.at > 0, 'a step can be marked done with its evidence');
ok(plans.setStep(p1.id, 'snope', { status: 'done' }) === null, 'an unknown step is not invented');
ok(throws(() => plans.setStep(p1.id, s1.id, { evidence: 'secretco log' })), 'evidence naming SecretCo is refused');
ok(plans.get(p1.id).goals[0].steps[0].evidence === 'commit abc123', 'a refused evidence leaves the old one');

// ── describe: short, for her brain ──
const line = plans.describe(new Date(2026, 9, 25, 9));
ok(/PLAN ACTUAL "Sunday"/.test(line) && /1\/1 pasos hechos/.test(line) && line.length < 400, 'her brain gets one short line about the plan on now');

// ── deepen ──
const p2 = plans.save({ kind: 'day', date: '2026-10-27', title: 'Tuesday', goals: [
    { text: 'Get the acme invoices out', steps: [{ text: 'check the run', status: 'done' }] },
    { text: 'Tidy TSRCT' }] });
started = [];
const r = plans.deepen(p2.id);
ok(r.ok && started.length === 1, 'deepen hands the plan to the worker');
const job = started[0] || {};
ok(job.level === 'complex' && job.changes === false && job.recipe === 'plan_steps', 'on Opus, read only, as the plan_steps recipe');
ok(/skills\/deeper\/SKILL\.md/.test(job.task) && /NO le preguntes si va/.test(job.task), 'the task names the /deeper method and says he approves on screen');
ok(/tsrct \(\/p\/TSRCT\)/.test(job.task) && /Get the acme invoices out/.test(job.task) && /check the run/.test(job.task), 'it carries his goals, his steps and his sessions');
ok(/^PASOS \{/m.test(job.task) && /"done"/.test(job.task) && /Nunca "Claude dice que termino"/.test(job.task), 'it asks for checkable "done" lines as one JSON line');
ok(!/secretco/i.test(job.task), 'the task text never names SecretCo (it sits on a screen)');
ok(plans.get(p2.id).state === 'deepening', 'the plan shows Tesla is writing the steps');
ok(plans.deepen(p2.id).already === true && started.length === 1, 'a second deepen while one runs starts nothing');
ok(throws(() => plans.deepen(plans.save({ title: 'empty' }).id)), 'a plan with no goals is not sent');

const answer = [
    'Listo.',
    'PASOS {"goals":[{"n":1,"beyond":"no invoice goes out wrong","steps":[{"text":"check the run","session":"acme","tool":"session","done":"run shows 0 errors"},{"text":"send the invoices","session":"acme","tool":"browser","done":"status Sent","risk":"send"}]},{"n":2,"steps":[{"text":"run npm run check","session":"tsrct","done":"37/37"}]}]}',
    'RESULTADO {"ok": true, "dijo": "Te propongo 3 pasos.", "como": "", "falta": ""}',
].join('\n');
ok(typeof job.onText === 'function' && job.onText(answer) === true, 'the worker answer is read whole');
const landed = plans.get(p2.id);
ok(landed.state === 'proposed', 'the steps land as a proposal, not approved');
ok(landed.goals[0].beyond === 'no invoice goes out wrong' && landed.goals[0].steps.length === 2 && landed.goals[1].steps.length === 1, 'every goal gets its steps');
ok(landed.goals[0].steps[0].status === 'done', 'a step he ticked keeps its status when the worker keeps it');
ok(landed.goals[0].steps[1].risk === 'send' && landed.goals[0].steps[1].tool === 'browser' && landed.goals[0].steps[1].status === 'todo', 'a new step keeps its tool and risk and starts as todo');

const pa = plans.save({ title: 'mixed', goals: [{ text: 'Review Tesla' }] });
started = [];
plans.deepen(pa.id);
const mixed = 'PASOS {"goals":[{"n":1,"beyond":"ok","steps":[{"text":"read the logs","done":"a list"},{"text":"x","done":"check-secretco passes"},{"text":"fix it","done":"commit"}]}]}';
ok(started[0].onText(mixed) === true, 'an answer with one step naming SecretCo still lands');
const kept = plans.get(pa.id);
ok(kept.state === 'proposed' && kept.goals[0].steps.map(s => s.text).join('|') === 'read the logs|fix it', 'only the step naming SecretCo is left out');
ok(!/secretco/i.test(fs.readFileSync(path.join(tmp, 'plans.json'), 'utf8')), 'and the word is never written');
ok(/job\.landed = job\.onText\(text\) === true/.test(fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8'))
    && /if \(!job\.landed\) throw/.test(fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8')), 'hands lets the plan land first, and still drops an answer nothing could clean');

const p3 = plans.save({ title: 'fails', goals: [{ text: 'g' }] });
started = [];
plans.deepen(p3.id);
started[0].onText(null);
ok(plans.get(p3.id).state === 'draft', 'a worker that fails lets the plan go back to draft');
ok(plans._parseSteps('PASOS {not json') === null && plans._parseSteps('nothing') === null, 'a broken answer is no steps, not a crash');

// ── phase 3: progress from evidence (lib/planTracker.js) ──
const tracker = require(path.join(ROOT, 'lib/planTracker.js'));
const proj = path.join(tmp, 'projects');
fs.mkdirSync(path.join(proj, 'TSRCT'), { recursive: true });
ok(plans.save({ title: 'c', goals: [{ text: 'g', steps: [{ text: 's', check: { kind: 'rm -rf', arg: 'x' } }] }] }).goals[0].steps[0].check.kind === 'manual', 'an unknown check kind becomes manual');
const unapproved = plans.save({ kind: 'day', date: '2026-11-03', title: 'Track', goals: [{ text: 'Plans', steps: [
    { text: 'build the tracker', session: 'tsrct', check: { kind: 'git', arg: 'plan tracker' } },
    { text: 'write the notes', check: { kind: 'file', arg: path.join(proj, 'TSRCT', 'notes.md') } },
    { text: 'tell the accountant', check: { kind: 'manual' } },
    { text: 'outside', check: { kind: 'file', arg: '/etc/hostname' } },
    { text: 'old work', session: 'tsrct', check: { kind: 'git', arg: 'old commit' } }] }] });
ok(unapproved.approvedAt === 0, 'a plan not approved has no approval time');
let commits = [];
const said = [];
tracker.configure({ plans, cwdOf: (s) => (s === 'tsrct' ? path.join(proj, 'TSRCT') : ''), projectsRoot: proj,
    commits: () => commits, say: (l) => said.push(l) });
const day = new Date(2026, 10, 3, 10);
commits = [{ hash: 'abc1234def', at: Date.now() + 1000, subject: 'Add the plan tracker loop' }];
ok(tracker.tick(day).length === 0, 'nothing is marked on a plan he has not approved');
const appr = plans.save({ ...plans.get(unapproved.id), state: 'approved' });
ok(appr.approvedAt > 0, 'approving stamps the time evidence counts from');
ok(plans.save({ ...appr }).approvedAt === appr.approvedAt, 'saving it again keeps that time');
commits = [{ hash: 'old0000', at: appr.approvedAt - 60000, subject: 'old commit' }, { hash: 'abc1234def', at: appr.approvedAt + 1000, subject: 'Add the Plan Tracker loop' }];
const m1 = tracker.tick(day);
ok(m1.length === 1 && /commit abc1234 "Add the Plan Tracker loop"/.test(m1[0].evidence), 'a matching commit after approval marks its step done, with the commit as proof');
ok(plans.get(appr.id).goals[0].steps[4].status === 'todo', 'a commit from before approval is not this plan\'s proof');
ok(said.length === 1 && /Paso hecho: build the tracker/.test(said[0]) && /Van 1 de 5/.test(said[0]), 'she says which step and how far the plan is');
ok(tracker.tick(day).length === 0 && said.length === 1, 'a done step is not announced twice');
fs.writeFileSync(path.join(proj, 'TSRCT', 'notes.md'), 'x');
ok(tracker.tick(day).length === 1 && plans.get(appr.id).goals[0].steps[1].status === 'done', 'a promised file that appears marks its step done');
ok(plans.get(appr.id).goals[0].steps[3].status === 'todo', 'a file outside his projects folder proves nothing');
ok(plans.get(appr.id).goals[0].steps[2].status === 'todo', 'a manual step is his to tick');
ok(tracker._subjectMatches('Fix the TSRCT plan tracker', 'plan tracker') && !tracker._subjectMatches('Fix the planner', 'plan tracker'), 'every word of the check must be in the commit title');
const tsrc = fs.readFileSync(path.join(ROOT, 'lib/planTracker.js'), 'utf8');
ok(!/execFileSync|spawn|exec\(/.test(tsrc), 'the tracker runs no command itself; git comes through the server, argv');
ok(/startPlanTracker\(loops\)/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')) && /bootLoop\('plan-tracker'/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), 'it starts through bootLoop, so the Automations tab can pause it');

// ── page saves never undo the tracker ──
const pg = plans.get(appr.id);
const stale = JSON.parse(JSON.stringify(pg));
stale.goals[0].steps.forEach(x => { x.status = 'todo'; x.evidence = ''; });
stale.goals[0].steps[0].text = 'build the tracker loop';
stale.pilot = true; stale.allow = ['Bash'];
const after = plans.save(stale, { page: true });
ok(after.goals[0].steps[0].status === 'done' && /abc1234/.test(after.goals[0].steps[0].evidence) && after.goals[0].steps[0].text === 'build the tracker loop',
    'a save from the plan column keeps the steps the tracker marked done, and takes his text');
ok(after.pilot === false && after.allow.length === 0, 'the column cannot switch the pilot on or change its allow list by a plain save');

// ── phase 4: the autopilot (lib/planPilot.js) ──
const pilot = require(path.join(ROOT, 'lib/planPilot.js'));
const sent = [], told = [];
const sess = { a: { open: true, working: false, card: '' }, b: { open: true, working: false, card: '' } };
pilot.configure({ plans, exists: (n) => !!(sess[n] && sess[n].open), working: (n) => sess[n].working, waiting: (n) => sess[n].card,
    send: (n, t) => { sent.push({ n, t }); return { success: true }; }, say: (l, o) => told.push({ l, urgent: !!(o && o.urgent) }) });
const pday = new Date(2026, 10, 10, 9);
const pp = plans.save({ kind: 'day', date: '2026-11-10', title: 'Fly', allow: ['Bash(npm run check', 'Read'], goals: [
    { text: 'Goal A', steps: [{ text: 'step a1', session: 'a', done: 'tests pass', check: { kind: 'git', arg: 'a1 done' } }, { text: 'step a2', session: 'a' }] },
    { text: 'Goal B', steps: [{ text: 'send invoices', session: 'b', risk: 'send' }] },
    { text: 'Goal C', steps: [{ text: 'call the accountant', tool: 'me' }] }] });
ok(pilot.tick(pday).length === 0 && sent.length === 0, 'a plan not approved never flies');
plans.save({ ...plans.get(pp.id), state: 'approved' });
ok(pilot.tick(pday).length === 0, 'an approved plan does not fly until he switches the pilot on');
plans.save({ ...plans.get(pp.id), pilot: true });
sess.a.working = true;
pilot.tick(pday);
ok(sent.length === 0, 'a session mid-turn is not typed into');
const blockedB = plans.get(pp.id).goals[1].steps[0];
ok(blockedB.status === 'blocked' && told.some(t => t.urgent && /send/.test(t.l)), 'a risky step stops and tells him, urgent');
ok(plans.get(pp.id).goals[2].steps[0].status === 'blocked' && told.some(t => /tuyo/.test(t.l)), 'his own step stops and tells him');
sess.a.working = false;
const t0 = new Date(2026, 10, 10, 9, 1);
pilot.tick(t0);
ok(sent.length === 1 && sent[0].n === 'a' && /Paso: step a1/.test(sent[0].t) && /"a1 done"/.test(sent[0].t) && /tests pass/.test(sent[0].t), 'the next step goes to its session with what done means and the proof TSRCT will look for');
ok(plans.get(pp.id).goals[0].steps[0].status === 'doing', 'and is marked doing');
pilot.tick(new Date(2026, 10, 10, 9, 1, 30));
ok(sent.length === 1, 'step a2 waits: one step per session, in order');
ok(pilot.allows({ session: 'a', tool: 'Bash', command: 'npm run check:fast' }, t0), 'a card on the allow list is approved for the pilot session');
ok(!pilot.allows({ session: 'a', tool: 'Bash', command: 'rm -rf /' }, t0) && !pilot.allows({ session: 'a', tool: 'Edit', file: 'x' }, t0), 'a card off the list is not');
ok(!pilot.allows({ session: 'b', tool: 'Read', file: 'x' }, t0), 'a session not running a pilot step gets nothing from the list');
ok(!pilot.allows({ session: 'a', tool: 'Read', file: '/p/SecretCoSandbox/x' }, t0), 'nothing naming SecretCo is approved, list or not');
ok(pilot.onPermission({ session: 'a', tool: 'Edit', description: 'edit lib/x.js' }) && told.some(t => t.urgent && /necesita tu permiso/.test(t.l)), 'a card off the list rings him');
// quiet without proof: one nudge, then blocked
pilot.tick(new Date(2026, 10, 10, 9, 3));
ok(sent.length === 2 && /todavia no tiene su prueba/.test(sent[1].t), 'a session quiet without its proof is asked once');
pilot.tick(new Date(2026, 10, 10, 9, 3, 30));
pilot.tick(new Date(2026, 10, 10, 9, 6));
ok(plans.get(pp.id).goals[0].steps[0].status === 'blocked' && told.some(t => t.urgent && /paro sin la prueba/.test(t.l)), 'quiet again, the step is blocked and he is told');
// his OK on the risky step
plans.setStep(pp.id, blockedB.id, { status: 'todo', byHim: true });
ok(plans.get(pp.id).goals[1].steps[0].cleared === true, 'moving a blocked step back by hand is his OK');
plans.setStep(pp.id, plans.get(pp.id).goals[0].steps[0].id, { status: 'todo' });
ok(plans.get(pp.id).goals[0].steps[0].cleared === false, 'the tracker or pilot moving it is not');
pilot.tick(new Date(2026, 10, 10, 9, 7));
ok(sent.some(x => x.n === 'b' && /send invoices/.test(x.t)), 'after his OK the risky step goes out');
{
    // the tracker proves a1 done: a2 goes out on the next tick, same session
    const tmpPlan = plans.save({ kind: 'day', date: '2026-11-11', title: 'Chain', goals: [{ text: 'G', steps: [{ text: 'c1', session: 'a' }, { text: 'c2', session: 'a' }] }] });
    plans.save({ ...plans.get(tmpPlan.id), state: 'approved' });
    plans.save({ ...plans.get(tmpPlan.id), pilot: true });
    const d1 = new Date(2026, 10, 11, 9);
    const before = sent.length;
    pilot.tick(d1);
    plans.setStep(tmpPlan.id, plans.get(tmpPlan.id).goals[0].steps[0].id, { status: 'done' });
    pilot.tick(new Date(2026, 10, 11, 9, 0, 20));
    ok(sent.length === before + 2 && /Paso: c2/.test(sent[sent.length - 1].t), 'when the tracker proves a step done, the next one in the same session goes out');
    plans.remove(tmpPlan.id);
}
const cId = plans.get(pp.id).goals[2].steps[0].id;
plans.setStep(pp.id, cId, { status: 'todo', byHim: true });
const nTold = told.length;
pilot.tick(new Date(2026, 10, 10, 9, 7, 30));
ok(plans.get(pp.id).goals[2].steps[0].status === 'todo' && told.length === nTold, 'his own step, once cleared, waits for his tick and is not asked again');
// done everywhere: the pilot lands
const fin = plans.get(pp.id);
fin.goals.flatMap(g => g.steps).forEach(x => plans.setStep(pp.id, x.id, { status: 'done' }));
pilot.tick(new Date(2026, 10, 10, 9, 8));
ok(plans.get(pp.id).pilot === false && told.some(t => /esta completo/.test(t.l)), 'when every step is done the pilot switches itself off and says so');
const psrc = fs.readFileSync(path.join(ROOT, 'lib/routes/permissions.js'), 'utf8');
ok(psrc.indexOf('planPilot.allows(perm)') > 0 && psrc.indexOf('planPilot.allows(perm)') < psrc.indexOf('addEvent({ ...perm'), 'the permission route asks the pilot before showing a card');
ok(/'pilot'/.test(fs.readFileSync(path.join(ROOT, 'lib/routes/tesla.js'), 'utf8')) && /approve the plan first/.test(fs.readFileSync(path.join(ROOT, 'lib/routes/tesla.js'), 'utf8')), 'the switch refuses a plan not approved');
ok(/bootLoop\('plan-pilot'/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), 'the pilot starts through bootLoop');

// ── phase 5: the command center (lib/planCenter.js, lib/planEvents.js) ──
const planEvents = require(path.join(ROOT, 'lib/planEvents.js'));
const evs = planEvents.recent(60).map(e => e.kind);
ok(['sent', 'blocked', 'nudged', 'allowed', 'asked', 'finished'].every(k => evs.includes(k)), 'the pilot leaves an event for every kind of thing it did');
ok(planEvents.push('note', 'SecretCo import ran', 'x') === null && planEvents.push('note', 'fine', 'secretco') === null, 'an event naming SecretCo is dropped');
const center = require(path.join(ROOT, 'lib/planCenter.js'));
const cday = plans.save({ kind: 'day', date: plans.today(), title: 'Center', goals: [{ text: 'G', steps: [
    { text: 'one', session: 'a', status: 'done' }, { text: 'two', session: 'a' }, { text: 'three', session: 'b' }, { text: 'four', session: 'gone-one' }] }] });
plans.save({ ...plans.get(cday.id), state: 'approved' });
plans.setStep(cday.id, plans.get(cday.id).goals[0].steps[0].id, { status: 'done' });
center.configure({ plans, pilot: { active: () => [{ step: plans.get(cday.id).goals[0].steps[1].id, session: 'a' }] },
    exists: (n) => n !== 'gone-one', working: (n) => n === 'a', waiting: (n) => (n === 'b' ? 'Bash rm -rf build' : ''),
    pending: () => [{ id: 'p1', session: 'b', tool: 'Bash', command: 'rm -rf build' }, { id: 'p2', session: 'other', tool: 'Edit' }, { id: 'p3', session: 'b', tool: 'Read', file: '/x/SecretCoSandbox/y' }] });
const snap = center.snapshot();
const byName = Object.fromEntries(snap.sessions.map(x => [x.name, x]));
ok(snap.plan && snap.plan.title === 'Center' && snap.plan.done === 1 && snap.plan.steps === 4, 'the center shows the plan on now and how far it is');
ok(byName.a.state === 'working' && byName.a.pilot && byName.a.step === 'two' && byName.a.done === 1 && byName.a.total === 2, 'a session the pilot drives shows working, its step and its count');
ok(byName.b.state === 'waiting' && /rm -rf build/.test(byName.b.waiting), 'a session stopped on a card shows it needs him, and for what');
ok(byName['gone-one'].state === 'gone', 'a closed session shows closed');
ok(snap.pending.length === 1 && snap.pending[0].id === 'p1', 'only cards from the plan sessions are shown, and none naming SecretCo');
ok(Array.isArray(snap.events) && snap.events.length > 0, 'the feed rides on the same read');
const route5 = fs.readFileSync(path.join(ROOT, 'lib/routes/tesla.js'), 'utf8');
ok(/\/api\/tesla\/center/.test(route5) && /req\.method === 'GET'/.test(route5.slice(route5.indexOf('getCenter'))), 'the center is a GET: reading it changes nothing');
const tc = fs.readFileSync(path.join(ROOT, 'src/js/tesla-center.js'), 'utf8');
ok(/\/api\/permission\/\$\{encodeURIComponent/.test(tc), 'its [allow]/[deny] use the existing permission routes');
ok(/TeslaCenter\.start\(\)/.test(fs.readFileSync(path.join(ROOT, 'src/js/tesla-full.js'), 'utf8')) && /TeslaCenter\.stop\(\)/.test(fs.readFileSync(path.join(ROOT, 'src/js/tesla-full.js'), 'utf8')), 'it polls only while full screen is open');

// ── scripts/plan.js: a Claude session drafts, only he decides ──
const cli = fs.readFileSync(path.join(ROOT, 'scripts/plan.js'), 'utf8');
ok(/state: 'proposed', pilot: false/.test(cli), 'a plan drafted from a session always lands proposed, with the pilot off');
ok(/\['approve', 'pilot'\]\.includes\(cmd\)/.test(cli) && /only \$\{OWNER\} deletes it/.test(cli) && /only \$\{OWNER\} changes it/.test(cli),
    'the command refuses approving, the pilot, and changing or deleting an approved plan');
ok(/'\/api\/tesla\/plans'/.test(cli) && !/require\(.*lib\/plans/.test(cli), 'it goes through the server route, so the same cleaning and restricted-project refusal apply');
const tp = fs.readFileSync(path.join(ROOT, 'src/js/tesla-plan.js'), 'utf8');
ok(!/[^.\w]confirm\(/.test(tp.replace(/\/\/.*$/gm, '')) && /sureDelete/.test(tp), 'deleting asks inside TSRCT, never with the browser confirm that drops full screen');

// ── the worker side (lib/teslaHands.js) ──
const hsrc = fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8');
ok(/job\.onText\(text\)/.test(hsrc) && /job\.onText\(null\)/.test(hsrc), 'hands hands the whole answer over, and null when it failed');
ok(/skills', 'deeper'/.test(hsrc), 'hands may read the /deeper skill without a permission card');
ok(typeof hands.start === 'function', 'hands loads');

// ── wiring: route, server, full screen ──
const route = fs.readFileSync(path.join(ROOT, 'lib/routes/tesla.js'), 'utf8');
ok(/\/api\/tesla\/plans/.test(route) && ['save', 'delete', 'step', 'deepen'].every(op => route.includes(`p.op === '${op}'`)), 'the route answers save, delete, step and deepen');
ok(/RestrictedProjectError \? 403/.test(route.slice(route.indexOf('plansRoute'))), 'an SecretCo refusal is a 403');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
ok(/plans\.configure\(/.test(server) && /plans\.describe\(\)/.test(server), 'the server wires plans and gives her brain the plan line');
const full = fs.readFileSync(path.join(ROOT, 'src/js/tesla-full.js'), 'utf8');
ok(/TeslaPlan\.mount\(/.test(full) && /tf-zone-plan/.test(full), 'full screen mounts the plan column');
const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
ok(html.indexOf('tesla-plan.js') > 0 && html.indexOf('tesla-plan.js') < html.indexOf('tesla-full.js'), 'the plan script loads before full screen');
ok(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').includes("'/src/js/tesla-plan.js'"), 'the service worker caches it');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`check-plans: ${pass}/${pass + fail} ok`);
process.exit(fail ? 1 : 0);
