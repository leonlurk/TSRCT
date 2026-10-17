#!/usr/bin/env node
'use strict';
// scripts/check-automations.js — the Automations tab's rules, against the real modules.
//
//   - the scheduler's weekly jobs: owed on the day, CAUGHT UP later in the week
//     (the reason the cron jobs moved), given up after the window and reported
//     as MISSED, never run twice for one occurrence;
//   - an old daily state file (lastDay only) is still honoured;
//   - failures are counted in a streak and the second one is announced;
//   - a job moved from cron is seeded with cron's last run, so it does not
//     re-run on the first boot;
//   - the catalogue: unique ids, every job has a script on disk, hooks are
//     never switchable, the Windows CSV/date parsing works in Spanish;
//   - SecretCo text is hidden before it reaches a card;
//   - the tab is wired: surface, panel, room, script tag, service worker.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `tsrct-check-automations-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.SCHEDULER_STATE_FILE = path.join(tmp, 'scheduler.json');
process.env.AUTOMATIONS_STATE_FILE = path.join(tmp, 'automations.json');

const scheduler = require('../lib/scheduler');
const automations = require('../lib/automations');

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) pass++;
    else { fail++; console.log('  FAIL ' + msg); }
}

// Local dates, the way the scheduler reads them. 2026-09-21 is a Monday.
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);
const MON = at(2026, 9, 21, 7, 0);

(async () => {
    // ── weekly job: owed, caught up, then served ──────────────────────────
    let runs = 0;
    scheduler.register({ name: 'wk', at: '07:23', days: [1], window: 144, run: async () => { runs++; return { summary: 'fine' }; } });
    ok(scheduler.due('wk', MON).run === false, 'weekly: not yet before 07:23 on Monday');
    ok(scheduler.due('wk', at(2026, 9, 21, 7, 30)).run === true, 'weekly: owed at 07:30 Monday');
    ok(scheduler.due('wk', at(2026, 9, 23, 20, 0)).run === true, 'weekly: still owed Wednesday evening (the catch-up cron could not do)');
    const occ = scheduler.lastOccurrence('wk', at(2026, 9, 23, 20, 0));
    ok(occ && occ.getDay() === 1 && occ.getDate() === 21, 'lastOccurrence finds Monday from Wednesday');

    // run it "Wednesday" by faking the clock through the occurrence it serves
    const realNow = Date.now;
    const RealDate = Date;
    function withClock(d, fn) {
        const fixed = d.getTime();
        global.Date = class extends RealDate {
            constructor(...a) { if (a.length) super(...a); else super(fixed); }
            static now() { return fixed; }
        };
        try { return fn(); } finally { global.Date = RealDate; Date.now = realNow; }
    }
    await withClock(at(2026, 9, 23, 20, 0), () => scheduler.runJob('wk'));
    ok(runs === 1, 'runJob ran the job');
    ok(scheduler.due('wk', at(2026, 9, 23, 20, 5)).run === false, 'served: not owed again the same week');
    ok(scheduler.due('wk', at(2026, 9, 28, 7, 30)).run === true, 'owed again next Monday');
    ok(scheduler.due('wk', at(2026, 9, 28, 7, 0)).run === false, 'but not before its time next Monday');
    const v = scheduler.view('wk');
    ok(v.history.length === 1 && v.history[0].ok && v.lastSummary === 'fine', 'history + summary recorded from { summary }');

    // ── past the window -> missed, announced once ─────────────────────────
    let missed = [];
    scheduler.setOnMissed((name, day) => missed.push(name + '@' + day));
    // registered BEFORE the Monday it misses: register() stamps firstSeen with the clock,
    // and a real clock later than these dates makes the miss "before the job existed"
    withClock(at(2026, 9, 20, 12, 0), () =>
        scheduler.register({ name: 'wk2', at: '07:23', days: [1], window: 24, run: async () => 'x' }));
    ok(scheduler.due('wk2', at(2026, 9, 23, 9, 0)).why === 'past the window', 'past a 24h window on Wednesday');
    ok(scheduler.view('wk2').missedDay === '2026-09-21', 'missed day recorded for the tab');
    ok(missed.length === 1 && missed[0] === 'wk2@2026-09-21', 'onMissed called once with the day');
    scheduler.due('wk2', at(2026, 9, 23, 10, 0));
    ok(missed.length === 1, 'onMissed not repeated on the next tick');

    // ── the old daily state file ──────────────────────────────────────────
    const st = JSON.parse(fs.readFileSync(process.env.SCHEDULER_STATE_FILE, 'utf8'));
    st.jobs.daily = { enabled: true, lastDay: '2026-09-23' };
    fs.writeFileSync(process.env.SCHEDULER_STATE_FILE, JSON.stringify(st));
    delete require.cache[require.resolve('../lib/scheduler')];
    const sch2 = require('../lib/scheduler');
    sch2.register({ name: 'daily', at: '06:00', run: async () => 'd' });
    ok(sch2.due('daily', at(2026, 9, 23, 7, 0)).run === false, 'legacy lastDay still means "already ran today"');
    ok(sch2.due('daily', at(2026, 9, 24, 7, 0)).run === true, 'and the next day is owed');
    ok(sch2.due('daily', at(2026, 9, 24, 5, 0)).run === false, 'daily: not before its time');

    // ── failure streak and the second-failure announcement ────────────────
    let finished = [];
    sch2.setOnFinished((name, view) => finished.push(view.failStreak));
    sch2.register({ name: 'bad', at: '06:00', run: async () => { throw new Error('nope'); } });
    await sch2.runJob('bad', { manual: true });
    await sch2.runJob('bad', { manual: true });
    ok(sch2.view('bad').failStreak === 2 && finished.join(',') === '1,2', 'fail streak counts 1, 2');
    ok(sch2.view('bad').lastError === 'nope', 'the error is kept');
    sch2.register({ name: 'warny', at: '06:00', run: async () => ({ summary: '3 problems', warn: true }) });
    await sch2.runJob('warny', { manual: true });
    ok(sch2.view('warny').lastWarn === true && sch2.view('warny').lastOk === true, 'warn outcome kept apart from failure');

    // ── seeding from cron ─────────────────────────────────────────────────
    sch2.register({ name: 'moved', at: '10:00', days: [1], window: 144, run: async () => 'm' });
    ok(sch2.seed('moved', at(2026, 9, 21, 10, 0).getTime() + 2000) === true, 'seed accepted');
    ok(sch2.due('moved', at(2026, 9, 23, 12, 0)).run === false, 'a job cron already ran this week does not re-run after the move');
    ok(sch2.seed('moved', Date.now()) === false, 'seed never overwrites real history');

    // ── the catalogue ─────────────────────────────────────────────────────
    const ids = automations.ITEMS.map(i => i.id);
    ok(new Set(ids).size === ids.length, 'catalogue ids are unique');
    for (const i of automations.ITEMS.filter(x => x.kind === 'job')) {
        ok(i.id === 'morning-routine' || automations.SCRIPT_JOBS.some(j => j.name === i.id), `job card ${i.id} has a job behind it`);
    }
    for (const j of automations.SCRIPT_JOBS) {
        ok(fs.existsSync(j.file), `script on disk: ${path.basename(j.file)}`);
        ok(scheduler.parseAt(j.at) && j.window > 0, `valid time and window: ${j.name}`);
    }
    for (const g of new Set(automations.ITEMS.map(i => i.group))) {
        ok(automations.GROUPS.some(x => x.id === g), `group ${g} exists`);
    }
    const hooks = automations.readHooks();
    ok(hooks.every(h => h.canToggle === false && h.locked), 'hooks are shown, never switchable');

    // ── Windows parsing, Spanish locale ───────────────────────────────────
    const row = automations.parseCsvLine('"MYPC","\\MyTask","27/9/2026 11:00:00","Listo","x","20/9/2026 11:00:00","0","N/A","wscript.exe ""a b""","N/A","c","Habilitado"');
    ok(row.length === 12 && row[11] === 'Habilitado' && row[8] === 'wscript.exe "a b"', 'CSV parser handles quotes');
    const d = new Date(automations.parseWinDate(row[5]));
    ok(d.getDate() === 20 && d.getMonth() === 8 && d.getHours() === 11, 'Windows date read day-first');
    ok(automations.parseWinDate('N/A') === 0 && automations.parseWinDate('30/11/1999 0:00:00') === 0, '"never" reads as 0');

    // ── SecretCo never reaches a card ────────────────────────────────────────
    ok(/hidden/.test(automations.clean('Filed the SecretCoSandbox kickoff call')), 'SecretCo text is hidden');
    ok(automations.clean('Filed 4 new') === 'Filed 4 new', 'ordinary text passes');

    // ── loop pause persists ───────────────────────────────────────────────
    automations.setPaused('syften', true);
    ok(automations.isPaused('syften'), 'pause written');
    let started = false;
    ok(automations.bootLoop('syften', () => { started = true; }) === false && !started, 'a paused loop is not started at boot');
    automations.setPaused('syften', false);
    ok(automations.bootLoop('syften', () => { started = true; }) === true && started, 'an unpaused loop starts');

    // ── voice ─────────────────────────────────────────────────────────────
    const u = require('../lib/understand');
    const heard = (t) => u.parse(t) || {};
    ok(heard('apagá syften').name === 'set_automation' && heard('apagá syften').args.on === false, 'voice: "apaga syften" turns it off');
    ok(heard('prendé la auditoria').args.on === true, 'voice: "prende" turns on');
    ok(heard('apaga las voces').name === 'mute_voices', 'voice: a bare "apaga" without an automation is not this');
    ok(heard('como andan las automatizaciones').name === 'automations_status', 'voice: status question');
    ok(heard('contame las tareas de hoy').name === 'today_tasks', 'voice: today\'s tasks still go to today_tasks');
    const acts = require('../lib/actions');
    ok(acts.TYPES.automation('la rutina de la mañana') === 'morning-routine', 'voice: "la rutina de la mañana" resolves');
    ok(acts.TYPES.automation('lectura diaria de menciones') === 'syften-daily', 'voice: the specific syften one wins');
    let refused = false;
    try { acts.TYPES.automation('secretco guard'); } catch { refused = true; }
    ok(refused, 'voice: hooks cannot be named for a switch');
    const r = await acts.run('set_automation', { automation: 'syften', on: false });
    ok(r.needsConfirm && /apagar Brand mentions/.test(r.says), 'voice: a switch always confirms, naming the thing');

    // ── wiring ────────────────────────────────────────────────────────────
    const root = path.join(__dirname, '..');
    const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
    const desk = read('src/js/desktop.js'), html = read('src/index.html'), sw = read('sw.js'), srv = require('./serverSource')();
    ok(/automations:\s*\{[^}]*el: 'pc-automations-panel'[^}]*init: 'automationsInit'/.test(desk), 'desktop surface registered');
    ok(desk.includes('id="pc-automations-panel"') && desk.includes("pcSwitchTab('automations')"), 'desktop panel + tab button');
    ok(html.includes('id="automations-room"') && html.includes("WorldManager.open('automations')"), 'mobile room + launcher');
    ok(html.includes('/src/js/automations.js'), 'script tag');
    ok(sw.includes('/src/js/automations.js') && sw.includes('/src/css/rooms/room-automations.css'), 'service worker caches the tab');
    ok(/automations\.registerJobs\(scheduler\)/.test(srv), 'server registers the moved cron jobs');
    for (const id of ['syften', 'factory', 'session-monitor', 'clickup-sync', 'analyst']) {
        ok(srv.includes(`automations.bootLoop('${id}'`), `server starts ${id} through bootLoop`);
    }
    const fe = read('src/js/automations.js');
    for (const fn of ['automationsInit', 'automationsTeardown', 'auToggle', 'auRun', 'auOpen', 'auSetTime', 'auReload']) {
        ok(fe.includes(`window.${fn} = ${fn}`), `frontend exports ${fn}`);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`check-automations: ${pass}/${pass + fail} ${fail ? 'FAILED' : 'ok'}`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
