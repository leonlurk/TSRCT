#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/plan.js — how a Claude session writes the owner's plans (2026-10-25).
//
// The owner describes the day to a session in their own words, and the session
// turns it into a detailed plan that they approve before the autopilot runs it.
// So a session can DRAFT, never decide: every plan it saves lands as
// "proposed" with the pilot off, and shows up by itself in Tesla's full screen,
// where only the owner presses [approve] and [pilot]. Approving, switching the pilot
// and deleting an approved plan are refused here on purpose.
//
//   node scripts/plan.js list
//   node scripts/plan.js show <id|today>
//   node scripts/plan.js sessions                 his open sessions and their folders
//   node scripts/plan.js draft <file.json>        create or update (an "id" updates)
//   node scripts/plan.js deepen <id>              Opus rewrites the steps with /deeper
//   node scripts/plan.js delete <id>              only a plan he has not approved
//
// The JSON is the plan itself (see lib/plans.js): {kind:'day'|'week'|'free',
// date:'YYYY-MM-DD', title, note, goals:[{text, steps:[{text, session,
// tool:'session'|'browser'|'pc'|'me', done, check:{kind:'git'|'file'|'manual',
// arg}, risk:''|'client-data'|'date'|'money'|'send'}]}]}.
// It talks to the running server (local, master token), so a plan goes through
// the same cleaning and restricted-project refusal as the screen's.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const { NAME: OWNER } = require('../lib/owner');
function env(name) {
    if (process.env[name]) return process.env[name];
    try {
        const m = new RegExp(`^${name}=(.*)$`, 'm').exec(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
        return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    } catch { return ''; }
}
const PORT = Number(env('BRIDGE_PORT') || 3847);
const TOKEN = env('BRIDGE_TOKEN');

function request(method, p, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : '';
        const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
            headers: { Authorization: TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
            let out = '';
            res.on('data', c => { out += c; });
            res.on('end', () => {
                let j = null;
                try { j = JSON.parse(out || '{}'); } catch { j = { error: out.slice(0, 200) }; }
                if (res.statusCode >= 400 || j.ok === false) reject(new Error(j.error || j.why || `HTTP ${res.statusCode}`));
                else resolve(j);
            });
        });
        req.on('error', (e) => reject(new Error(`TSRCT is not answering on ${PORT}: ${e.message}`)));
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
        req.end(data);
    });
}
const all = async () => request('GET', '/api/tesla/plans');
const post = (body) => request('POST', '/api/tesla/plans', body);

async function find(which) {
    const d = await all();
    const id = which === 'today' ? d.current : which;
    const p = d.plans.find(x => x.id === id);
    if (!p) throw new Error(which === 'today' ? 'no plan is on today' : `no plan ${which}`);
    return p;
}

function brief(p) {
    const steps = p.goals.flatMap(g => g.steps);
    return `${p.id}  ${p.kind}${p.date ? ' ' + p.date : ''}  "${p.title}"  ${p.state}${p.pilot ? ' (pilot ON)' : ''}  ${steps.filter(s => s.status === 'done').length}/${steps.length} done`;
}

async function main() {
    const [cmd, arg] = process.argv.slice(2);
    if (!TOKEN) throw new Error('no BRIDGE_TOKEN in .env');
    if (cmd === 'list') {
        const d = await all();
        console.log(d.plans.length ? d.plans.map(p => (p.id === d.current ? '* ' : '  ') + brief(p)).join('\n') : 'no plans');
        return;
    }
    if (cmd === 'show') { console.log(JSON.stringify(await find(arg || 'today'), null, 1)); return; }
    if (cmd === 'sessions') {
        const d = await request('GET', '/api/sessions');
        const list = Array.isArray(d) ? d : (d.sessions || []);
        console.log(list.map(s => (typeof s === 'string' ? s : `${s.name}${s.cwd || s.path ? '  ' + (s.cwd || s.path) : ''}`)).join('\n') || 'no sessions');
        return;
    }
    if (cmd === 'draft') {
        if (!arg) throw new Error('usage: plan.js draft <file.json>');
        const input = JSON.parse(fs.readFileSync(arg, 'utf8'));
        if (input.id) {
            const old = await find(input.id);
            if (old.state === 'approved') throw new Error(`that plan is approved: only ${OWNER} changes it now, on screen`);
        }
        // His decision, never ours: a draft is a proposal with the pilot off.
        const r = await post({ op: 'save', plan: { ...input, state: 'proposed', pilot: false } });
        console.log(`${brief(r.plan)}\nIt is on Tesla's full screen now, waiting for ${OWNER} to check it and press [approve].`);
        return;
    }
    if (cmd === 'deepen') {
        const r = await post({ op: 'deepen', id: arg });
        console.log(r.already ? 'already writing its steps' : `Opus is writing the steps (${r.key}). They land as a proposal on screen.`);
        return;
    }
    if (cmd === 'delete') {
        const p = await find(arg);
        if (p.state === 'approved') throw new Error(`that plan is approved: only ${OWNER} deletes it, on screen`);
        await post({ op: 'delete', id: p.id });
        console.log(`deleted ${p.id}`);
        return;
    }
    if (['approve', 'pilot'].includes(cmd)) throw new Error(`approving a plan and switching the pilot are for ${OWNER}, on Tesla's full screen`);
    console.log('usage: node scripts/plan.js list | show <id|today> | sessions | draft <file.json> | deepen <id> | delete <id>');
    process.exitCode = 2;
}

main().catch((e) => { console.error(`plan.js: ${e.message}`); process.exitCode = 1; });
