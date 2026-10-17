#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/check-clients.js — the Clients tab's rules, run against the real module.
//
//   - the health rule gives the colour it claims to (red / yellow / green);
//   - weekend hours do not count toward "unanswered";
//   - the week-ago count is right when requests open and resolve inside the week;
//   - DUPLICATES: the job merges; the server merges only the same ClickUp place
//     listed twice, NEVER on a shared mail thread (one mail can carry several
//     requests); a merge keeps every place and the earliest ask, and stays OPEN
//     (flagged) when the copies disagree;
//   - only CONFIGURED clients are stored; bad links, ids and dates are dropped;
//     SecretCo never reaches the store;
//   - expiring works and cannot keep a client red; a thread comes back on a new mail;
//   - the morning routine asks for, accepts and stores the client section;
//   - NOTHING about any client or any recording format is in the code.
//
// Writes only to temp files. No network, no model.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tmp = path.join(os.tmpdir(), `tsrct-check-clients-${process.pid}`);
process.env.CLIENTS_STATE_FILE = tmp + '.json';
process.env.CLIENTS_EXPIRED_FILE = tmp + '-expired.json';
process.env.CLIENTS_CONFIG_FILE = tmp + '-config.json';
fs.writeFileSync(process.env.CLIENTS_CONFIG_FILE, JSON.stringify({ clients: [
    { name: 'Client A', code: 'CA', domains: ['a.example'], clickup: { workspace: '1000', folders: ['2000'], lists: [] } },
    { name: 'Client B', domains: ['b.example'], clickup: { lists: ['3000'] } },
    { name: 'SecretCoSandbox', domains: ['secretco.example'], clickup: { folders: ['4000'] } },
    { name: 'No Place' },
] }));
const ch = require(path.join(ROOT, 'lib/clientHealth.js'));

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) pass++;
    else { fail++; console.log('  [x] ' + label); }
}

// A fixed "now": Monday 2026-09-21 12:00 local.
const NOW = new Date(2026, 8, 21, 12, 0).getTime();
const iso = (y, m, d, h) => new Date(y, m - 1, d, h || 0).toISOString();
const base = { name: 'Client A', requests: [], unanswered: [], promises: [], mail: true };
const place = (id, label) => ({ url: 'https://app.clickup.com/t/' + id, label: label || 'task ' + id });
const R = (o) => ({ title: 't', who: 'Ann', first_asked: '2026-09-01', status: 'open', priority: 'normal', due: '', quote: '',
    places: [place('aaa111')], thread_ids: [], review: '', resolved_on: '', ...o });

// ── config ───────────────────────────────────────────────────────────────
const cfg = ch.loadConfig();
ok(cfg.map(c => c.name).join('|') === 'Client A|Client B', `config keeps valid clients only, never SecretCo (got ${cfg.map(c => c.name).join('|')})`);
const instr = ch.instructionSection(cfg);
ok(instr.includes('"Client A": mail a.example; ClickUp workspace 1000; folder(s) 2000') && instr.includes('list(s) 3000'),
    'the question names each configured client and where it lives');
ok(/checkbox/.test(instr) && /Source thread/.test(instr) && /NOT resolved/.test(instr) && /review/.test(instr),
    'the question covers any container, merging, resolved-means-solved and the review flag');

// ── the rule ─────────────────────────────────────────────────────────────
ok(ch.derive({ ...base }, NOW, NOW).health === 'green', 'nothing pending is green');
ok(ch.derive({ ...base, mail: false }, NOW, NOW).health === 'yellow', 'mail not read is never green');

const fri = iso(2026, 9, 18, 12);
ok(Math.round(ch.weekdayHours(Date.parse(fri), NOW)) === 24, 'weekend hours are not counted');
let d = ch.derive({ ...base, unanswered: [{ subject: 's', who: 'x', received: fri, thread_id: 'abcdef12' }] }, NOW, NOW);
ok(d.health === 'yellow', 'unanswered exactly 24 weekday h is yellow, not red');
d = ch.derive({ ...base, unanswered: [{ subject: 's', who: 'x', received: iso(2026, 9, 17, 12), thread_id: 'abcdef12' }] }, NOW, NOW);
ok(d.health === 'red', 'unanswered 48 weekday h is red');

d = ch.derive({ ...base, requests: [R({ priority: 'high', due: '2026-09-20' })] }, NOW, NOW);
ok(d.health === 'red' && d.counts.overdue === 1, 'high request past due is red');
d = ch.derive({ ...base, requests: [R({ first_asked: '2026-09-10', due: '2026-09-20' })] }, NOW, NOW);
ok(d.health === 'yellow', 'normal request past due is yellow');
d = ch.derive({ ...base, requests: [R({ first_asked: '2026-09-15', priority: 'high', due: '2026-09-21' })] }, NOW, NOW);
ok(d.counts.overdue === 0, 'due today is not overdue');
d = ch.derive({ ...base, requests: [R({ first_asked: '2026-03-04', due: '2026-10-02' })] }, NOW, NOW);
ok(d.health === 'yellow' && d.counts.oldest === 201, 'oldest > 30 days is yellow, age counted from the client\'s first ask (201d)');
d = ch.derive({ ...base, requests: [R({ first_asked: '2026-01-01', status: 'resolved', resolved_on: '2026-09-19', priority: 'high', due: '2026-02-01' })] }, NOW, NOW);
ok(d.counts.open === 0 && d.health === 'green' && d.resolved.length === 1, 'a resolved request counts for nothing but the trend');
d = ch.derive({ ...base, promises: [{ what: 'send it', due: '2026-09-18' }] }, NOW, NOW);
ok(d.health === 'red', 'overdue promise is red');
d = ch.derive({ ...base, requests: [R({ first_asked: '2026-05-01', places: [], thread_ids: ['thr00mail'] })] }, NOW, NOW);
ok(d.health === 'yellow' && d.reasons.includes('1 not in ClickUp') && d.soon.length === 1,
    'a request that lives only in a mail is yellow and always "this week"');

// Trend: 3 open now; 1 asked this week; resolved this week: 1 old, 1 asked+resolved inside the week.
d = ch.derive({
    ...base,
    requests: [
        R({ title: 'a', first_asked: '2026-09-01', due: '2026-10-02' }),
        R({ title: 'b', first_asked: '2026-09-05', due: '2026-10-02' }),
        R({ title: 'c', first_asked: '2026-09-19', due: '2026-10-02' }),
        R({ title: 'old', first_asked: '2026-08-01', status: 'resolved', resolved_on: '2026-09-18' }),
        R({ title: 'quick', first_asked: '2026-09-16', status: 'resolved', resolved_on: '2026-09-17' }),
    ],
}, NOW, NOW);
ok(d.counts.openLastWeek === 3 && d.counts.resolvedWeek === 2, `week-ago count (got ${d.counts.openLastWeek}/${d.counts.resolvedWeek}, want 3/2)`);
ok(d.backlog[0] && d.backlog[0].title === 'a', 'backlog is sorted oldest first');

// ── verdict, next steps, this week vs backlog ────────────────────────────
d = ch.derive({
    ...base,
    unanswered: [{ subject: 'Where is the report', who: 'Pat Smith', received: iso(2026, 9, 16, 12), thread_id: 'thr000001' }],
    requests: [
        R({ title: 'due friday', first_asked: '2026-03-04', priority: 'high', due: '2026-09-25', places: [place('aaa111')] }),
        R({ title: 'old, due later', first_asked: '2026-04-01', due: '2026-10-09', places: [place('bbb222')] }),
        R({ title: 'asked this week', first_asked: '2026-09-18', priority: 'low', due: '2026-10-09', places: [place('ccc333')] }),
    ],
}, NOW, NOW);
ok(/^Pat has waited 3 working days/.test(d.verdict) && /1 high request due by 09-25/.test(d.verdict), `rule verdict (got: ${d.verdict})`);
ok(d.actions.length >= 1 && d.actions.length <= 3 && d.actions[0].thread_id === 'thr000001', 'first next step is the late reply, with its thread');
ok(d.soon.map(r => r.title).join('|') === 'due friday|asked this week' && d.backlog.map(r => r.title).join('|') === 'old, due later',
    'this week = due within 7d or asked in 14d; the rest is backlog');
d = ch.derive({ ...base, summary: 'Written by the job.', actions: [{ do: 'Call Pat', thread_id: 'thr000001' }] }, NOW, NOW);
ok(d.verdict === 'Written by the job.' && d.actions[0].do === 'Call Pat', 'the job\'s summary and steps win when present');

// ── duplicates: the job merges; the server only merges on the same place ─
const merged = ch.mergeRequests([
    R({ title: 'Report of sales with missing cost', first_asked: '2026-03-04', places: [place('mst001', 'Master #1'), place('old777', 'Report of sales')], thread_ids: ['thrDUP001'], priority: 'high' }),
    R({ title: 'Missing product cost report', first_asked: '2026-03-20', places: [place('old777', 'Report of sales')], thread_ids: ['thrDUP002'] }),
    R({ title: 'Unrelated', places: [place('zzz999')], thread_ids: ['thrOTHER1'] }),
]);
ok(merged.length === 2, `the same ClickUp place listed twice is one request (got ${merged.length})`);
const m0 = merged[0];
ok(m0.first_asked === '2026-03-04' && m0.places.length === 2 && m0.thread_ids.length === 2 && m0.priority === 'high',
    'the merged request keeps the earliest ask, every place, every thread and the highest priority');
// Measured on real data 2026-09-22: one client mail carried three requests.
const oneMail = ch.mergeRequests([
    R({ title: 'Vintus invoice missing', places: [place('mst001', 'Master #7')], thread_ids: ['thrSAME01'] }),
    R({ title: 'Notify when automations fail', places: [place('mst001', 'Master #8')], thread_ids: ['thrSAME01'] }),
    R({ title: 'Price overrides', places: [place('mst001', 'Master #13')], thread_ids: ['thrSAME01'] }),
]);
ok(oneMail.length === 3, `three requests from ONE mail stay three (got ${oneMail.length})`);
const disagree = ch.mergeRequests([
    R({ title: 'x', status: 'resolved', resolved_on: '2026-09-10', places: [place('mst001', 'Master #4')] }),
    R({ title: 'x copy', status: 'open', places: [place('mst001', 'Master #4')] }),
]);
ok(disagree.length === 1 && disagree[0].status === 'open' && /disagree/.test(disagree[0].review),
    'when copies disagree it stays OPEN and is flagged for review, never dropped');

// ── expiring ─────────────────────────────────────────────────────────────
const EXP_REF = 'req:task:mst001:master #9';
const exp = {
    [EXP_REF]: { key: EXP_REF, refs: [EXP_REF, 'req:task:old123:loose copy'], client: 'Client A', at: NOW - 1000 },
    'mail:thr000001': { key: 'mail:thr000001', client: 'Client A', at: NOW - 3600e3 },
};
d = ch.derive({
    ...base,
    requests: [
        // the loose copy was deleted since; the request still sits in the master checkbox
        R({ title: 'expired one, reworded', first_asked: '2026-01-01', priority: 'high', due: '2026-09-01', places: [place('mst001', 'Master #9')], thread_ids: ['thrSAME01'] }),
        R({ title: 'sibling from the same mail', first_asked: '2026-09-10', places: [place('mst001', 'Master #10')], thread_ids: ['thrSAME01'] }),
    ],
    unanswered: [{ subject: 'old thread', who: 'x', received: iso(2026, 9, 10, 9), thread_id: 'thr000001' }],
    actions: [{ do: 'act on expired', thread_id: 'thr000001' }],
}, NOW, NOW, exp);
ok(d.counts.open === 1 && d.soon[0].title === 'sibling from the same mail' && d.health === 'green',
    'an expired request is gone (even reworded), cannot keep the client red, and its sibling from the same mail stays');
ok(!d.waiting.length && !d.actions.some(a => a.do === 'act on expired'), 'expired items leave WAITING and NEXT too');
ok(d.expired.length === 2, 'expired items are listed for restore');
d = ch.derive({ ...base, unanswered: [{ subject: 'same thread, new mail', who: 'x', received: new Date(NOW - 60e3).toISOString(), thread_id: 'thr000001' }] }, NOW, NOW, exp);
ok(d.waiting.length + d.actions.length > 0, 'a thread comes back when the client writes again after it was expired');
ok(!ch.expire({ key: 'rm -rf /; echo' }).ok, 'expire refuses a malformed key');
ok(/EXPIRED BY LEON/.test(ch.instructionSection(cfg)) === false, 'no expired block when nothing is expired');
ok(ch.expire({ key: 'req:thread:thrEXP002', client: 'Client A', title: 'old ask' }).ok && ch.loadExpired()['req:thread:thrEXP002'], 'expire writes');
ok(/EXPIRED BY LEON[\s\S]*old ask/.test(ch.instructionSection(cfg)), 'the job is told what was expired');
ok(ch.expire({ key: 'req:thread:thrEXP002', undo: true }).ok && !ch.loadExpired()['req:thread:thrEXP002'], 'restore removes');

// ── cleaning + store ─────────────────────────────────────────────────────
const n = ch.ingest({
    mailbox: 'me@example.com',
    clients: [
        { name: 'Client A', requests: [
            R({ title: 'ok', places: [place('abc123', 'Master #2')], thread_ids: ['19a0b1c2d3e4f5a6'] }),
            R({ title: 'bad', first_asked: 'yesterday', places: [{ url: 'javascript:alert(1)' }], thread_ids: ['"><script>'] }),
        ] },
        { name: 'Invented Client', requests: [R({})] },
        { name: 'Client B', requests: [R({ title: 'about the secretco org' })] },
    ],
}, 'refresh');
const stored = ch.load();
ok(n === 1 && stored.clients.length === 1 && stored.clients[0].code === 'CA', 'only configured clients are stored (not invented, not SecretCo), code from config');
const reqs = stored.clients[0].requests;
ok(reqs[0].places.length === 1 && reqs[0].thread_ids.length === 1, 'valid ClickUp place and thread id kept');
ok(!reqs[1].places.length && !reqs[1].thread_ids.length && !reqs[1].first_asked, 'bad link, thread id and date dropped');
ok(stored.clients[0].mail === false, 'no mail fields means "mail not read", not "nothing pending"');
const v = ch.view();
ok(v.clients.length === 1 && v.updatedAt && v.rule && v.configured === 2, 'view() serves the stored report with the rule');

// ── the morning routine carries the section ──────────────────────────────
const mr = require(path.join(ROOT, 'lib/morningRoutine.js'));
const minstr = mr.buildInstruction({ today: '2026-09-21', live: [], projects: [], vaultNotes: [], claudeWork: [] });
ok(minstr.includes('CLIENT HEALTH') && minstr.includes('"clients"') && minstr.includes('Client A'), 'morning instruction asks for the configured clients');
const jj = require(path.join(ROOT, 'lib/jsonJob.js'));
ok(jj.checkShape({ brief: 'b', sessions: [], clients: [{ name: 'X', requests: [{ title: 't', status: 'open' }] }] }, mr.PLAN_SHAPE).length === 0, 'morning plan shape accepts clients');
ok(jj.checkShape({ brief: 'b', sessions: [] }, mr.PLAN_SHAPE).length === 0, 'morning plan shape still accepts no clients');
// 2026-09-23: a promise found in a mail without a date failed the WHOLE morning brief.
ok(jj.checkShape({ brief: 'b', sessions: [], clients: [{ name: 'X', requests: [], promises: [{ what: 'look into it' }] }] }, mr.PLAN_SHAPE).length === 0,
    'a promise with no date does not fail the morning brief');
d = ch.derive({ ...base, promises: [{ what: 'look into it', due: '' }, { what: 'send it', due: '2026-09-25' }] }, NOW, NOW);
ok(d.health !== 'red' && d.waiting.filter(w => w.kind === 'promise').length === 2 && d.waiting.every(w => !w.late),
    'an undated promise is shown, sorts last and is never overdue');ok(/clientHealth\.ingest\(/.test(fs.readFileSync(path.join(ROOT, 'lib/morningRoutine.js'), 'utf8')), 'morning run stores the client section');

// ── nothing hardcoded ────────────────────────────────────────────────────
const code = ['lib/clientHealth.js', 'src/js/clients.js', 'src/css/rooms/room-clients.css']
    .map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n').toLowerCase();
for (const s of ['frog', 'rossowine', 'coldwell', 'shannon', 'patty', 'flw rescue', 'client requests', '901316041707', '90132466381', '86akn']) {
    ok(!code.includes(s), `nothing about a client or a recording format in the code (${s})`);
}
ok(!/fetch\([^)]*(clickup|googleapis|gmail)/i.test(code), 'the tab and module call no external service');

for (const f of [process.env.CLIENTS_STATE_FILE, process.env.CLIENTS_EXPIRED_FILE, process.env.CLIENTS_CONFIG_FILE]) {
    try { fs.unlinkSync(f); } catch {}
}
console.log(`check-clients: ${pass}/${pass + fail} ${fail ? 'FAILED' : 'ok'}`);
process.exit(fail ? 1 : 0);
