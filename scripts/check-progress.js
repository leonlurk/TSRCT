#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/check-progress.js — the [R] progress report, run against the real module.
//
//   - a tmux session finds ITS conversation through ~/.claude/sessions/<pid>.json
//     (the "tmux" field), not the newest log in a shared folder;
//   - only TODAY's turns are sent, his requests and Claude's finished answers;
//   - SecretCo is dropped by session name, by folder and by content, and reported;
//   - the Slack text is his format, assembled in code;
//   - the job is told the conversation decides "done", the colour is a hint,
//     and the morning brief is not the whole list.
//
// Writes only to temp folders. No network, no model.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsrct-check-progress-'));
process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, 'projects');
process.env.CLAUDE_SESSIONS_DIR = path.join(tmp, 'sessions');
process.env.PROGRESS_STATE_FILE = path.join(tmp, 'state.json');
fs.mkdirSync(process.env.CLAUDE_SESSIONS_DIR, { recursive: true });

const pr = require(path.join(ROOT, 'lib/progressReport.js'));
const pastSessions = require(path.join(ROOT, 'lib/pastSessions.js'));

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) pass++;
    else { fail++; console.log(`  FAIL ${label}`); }
}

const now = new Date();
const today = new Date(now); today.setHours(10, 0, 0, 0);
const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
const iso = (d, min = 0) => new Date(d.getTime() + min * 60000).toISOString();

function transcript(cwd, id, rows) {
    const dir = pastSessions.dirFor(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}
const ask = (t, at) => ({ type: 'user', timestamp: at, message: { role: 'user', content: t } });
const answer = (t, at) => ({ type: 'assistant', timestamp: at, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: t }] } });
const tool = (at) => ({ type: 'assistant', timestamp: at, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'calling a tool' }] } });

// Two sessions in ONE folder: the folder's newest log belongs to "beta".
const shared = '/mnt/c/Users/you/PROJECTS/Shared';
transcript(shared, 'aaa', [
    ask('build the fund screen', iso(yesterday)),
    answer('done yesterday', iso(yesterday, 5)),
    ask('now the sample for Chris', iso(today)),
    tool(iso(today, 1)),
    answer('The sample is ready and linked to his report.', iso(today, 3)),
    ask('<system-reminder>noise</system-reminder>', iso(today, 4)),
]);
transcript(shared, 'bbb', [ask('beta work', iso(today, 30)), answer('beta answer', iso(today, 31))]);
fs.writeFileSync(path.join(process.env.CLAUDE_SESSIONS_DIR, '1.json'), JSON.stringify({ pid: 1, sessionId: 'aaa', cwd: shared, tmux: 'alpha:@1.%1', updatedAt: 1 }));
fs.writeFileSync(path.join(process.env.CLAUDE_SESSIONS_DIR, '2.json'), JSON.stringify({ pid: 2, sessionId: 'bbb', cwd: shared, tmux: 'beta:@2.%2', updatedAt: 2 }));
// A session that only worked yesterday.
transcript('/mnt/c/Users/you/PROJECTS/Old', 'ccc', [ask('old ask', iso(yesterday)), answer('old answer', iso(yesterday, 2))]);
fs.writeFileSync(path.join(process.env.CLAUDE_SESSIONS_DIR, '3.json'), JSON.stringify({ pid: 3, sessionId: 'ccc', cwd: '/mnt/c/Users/you/PROJECTS/Old', tmux: 'old:@3.%3', updatedAt: 3 }));
// SecretCo by folder, and by content.
transcript('/mnt/c/Users/you/PROJECTS/SecretCoSandbox', 'ddd', [ask('x', iso(today)), answer('y', iso(today, 1))]);
fs.writeFileSync(path.join(process.env.CLAUDE_SESSIONS_DIR, '4.json'), JSON.stringify({ pid: 4, sessionId: 'ddd', cwd: '/mnt/c/Users/you/PROJECTS/SecretCoSandbox', tmux: 'work:@4.%4', updatedAt: 4 }));
// 2026-10-08: gaap, wrl-sync and fl-overdue were left out WHOLE because one line
// named SecretCo ("ni siquiera hay laburo de secretco en esas sesiones"). Only the lines
// that name it are left out; the rest of the day's work is read.
transcript('/mnt/c/Users/you/PROJECTS/Other', 'eee', [ask('look at the secretco org', iso(today)), answer('ok', iso(today, 1)), ask('now close the GAAP checklist', iso(today, 2)), answer('Checklist closed, 12 of 12.', iso(today, 3))]);
fs.writeFileSync(path.join(process.env.CLAUDE_SESSIONS_DIR, '5.json'), JSON.stringify({ pid: 5, sessionId: 'eee', cwd: '/mnt/c/Users/you/PROJECTS/Other', tmux: 'other:@5.%5', updatedAt: 5 }));

const { read, skipped } = pr._collect([
    { name: 'alpha', color: '#00a8ff', meaning: 'done' },
    { name: 'beta' },
    { name: 'old' },
    { name: 'secretco' },
    { name: 'work' },
    { name: 'other' },
    { name: 'ghost' },
], now);

const alpha = read.find(r => r.session === 'alpha');
ok(alpha, 'alpha was read');
ok(alpha && alpha.found === 'pane', 'alpha found through its pane record');
ok(alpha && alpha.today.length === 2, `alpha sends only today's ask + finished answer (got ${alpha && alpha.today.length})`);
ok(alpha && /sample for Chris/.test(alpha.today[0]) && /sample is ready/.test(alpha.today[1]), 'alpha turns are the right ones, in order');
ok(alpha && !alpha.today.some(t => /calling a tool|system-reminder|fund screen/.test(t)), 'no tool chatter, no harness noise, nothing from yesterday');
ok(alpha && alpha.mark === '#00a8ff = "done"', 'the colour and its meaning travel as a hint');
const beta = read.find(r => r.session === 'beta');
ok(beta && beta.today.some(t => /beta work/.test(t)) && !beta.today.some(t => /Chris/.test(t)), 'two sessions in one folder do not read each other');
const old = read.find(r => r.session === 'old');
ok(old && old.today.length === 0 && /old answer/.test(old.lastBeforeToday), 'a session idle today says so, with its last turn');
ok(!read.some(r => /secretco/i.test(JSON.stringify(r))), 'nothing about SecretCo is read');
ok(['secretco', 'work'].every(n => skipped.some(s => s.session === n)), 'SecretCo by name and folder is reported as skipped');
const other = read.find(r => r.session === 'other');
ok(other && !skipped.some(s => s.session === 'other'), 'a session that only NAMES SecretCo is still read');
ok(other && other.today.some(t => /Checklist closed/.test(t)) && !other.today.some(t => /secretco/i.test(t)) && other.leftOut === 1, `its real work is read and only the SecretCo line is left out (got ${JSON.stringify(other && other.today)})`);
{
    const mr = fs.readFileSync(path.join(ROOT, 'lib/morningRoutine.js'), 'utf8');
    ok(/\.filter\(a => !restrictedGuard\.mentionsRestricted\(a\)\)/.test(mr), 'the morning brief drops the lines that name SecretCo, not the whole project');
}
ok(skipped.some(s => s.session === 'ghost' && /no Claude conversation/.test(s.why)), 'a session with no log is reported, not guessed');

// The Slack text.
const slack = pr._slackText({
    done: ['Lilypad Leap tasks assigned by Jo', 'Tested new AF package'],
    pending: [{ item: 'Install new PS in sandbox', blocker: 'waiting on Salesforce API version' }, { item: 'Weekly SEO/GEO check' }],
});
ok(slack === 'Tasks nailed today:\n• Lilypad Leap tasks assigned by Jo\n• Tested new AF package\n\nPending:\n• Install new PS in sandbox (waiting on Salesforce API version)\n• Weekly SEO/GEO check',
    'the Slack text is his format exactly');
ok(!/undefined|null/.test(slack), 'a missing blocker prints nothing');
ok(pr._slackText({ done: [], pending: [] }).startsWith('Tasks nailed today:\n• (nothing finished yet)'), 'an empty day still reads as a message');
ok(pr.SHAPE.object.done && pr.SHAPE.object.pending, 'the answer shape asks for done and pending');

// The question.
const instr = pr._buildInstruction({ group: 'Acme Cloud Co', today: '2026-10-06', read, morning: ['Old ask (slack)'] });
ok(/THIS IS THE\s+TRUTH/.test(instr) && /mark is HIS opinion, a hint/.test(instr), 'the conversation decides, the colour is a hint');
ok(/NOT the full list/.test(instr), 'the morning brief is a starting point, not the list');
ok(/ClickUp/.test(instr) && /Slack/.test(instr) && /Gmail/.test(instr) && /Calendar/.test(instr) && /vault/.test(instr), 'all five sources are named');
ok(/HARD SECRETCO EXCLUSION/.test(instr), 'the instruction carries the SecretCo exclusion');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`check-progress: ${pass}/${pass + fail} ok`);
process.exit(fail ? 1 : 0);
