// ─────────────────────────────────────────────────────────────────────────
// tesla-plan.js — his work plans, in Tesla's full screen (2026-10-25).
//
// The owner writes his plan in Tesla's full screen, organised by date, by week
// or however he wants. A plan is a day, a week or free; it holds goals, and each goal
// holds steps. He writes the goals; [deeper] sends them to the worker, which
// proposes precise steps (lib/plans.js deepen); he edits them and [approve]s.
//
// The server owns the plan (/api/tesla/plans). This file keeps a copy, edits
// it in place and saves it 600 ms after the last keystroke, so nothing typed is
// lost and nothing is saved on every letter.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const TOOLS = { session: 'session', browser: 'browser', pc: 'my PC', me: 'me' };
    const RISKS = { '': 'no risk', 'client-data': 'client data', date: 'client date', money: 'money', send: 'sends' };
    const MARK = { todo: '[ ]', doing: '[~]', done: '[x]', blocked: '[!]' };
    const NEXT = { todo: 'doing', doing: 'done', done: 'todo', blocked: 'todo' };
    const CHECKS = { manual: 'I tick it', git: 'a commit says', file: 'this file exists' };
    const STATE = { draft: 'draft', deepening: 'Tesla is writing the steps', proposed: 'steps proposed, check them', approved: 'approved' };

    let root = null, plans = [], cur = null, today = '', sessions = [], saveTimer = 0, poll = 0, sureDelete = '';
    // Plans seen so far: one that appears from elsewhere (a Claude session drafting
    // it with scripts/plan.js) and is the plan on now is opened by itself.
    let seen = null;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const headers = () => ({ 'Content-Type': 'application/json', Authorization: (typeof token !== 'undefined' && token) ? token : (window.token || '') });

    async function call(body) {
        const r = await fetch('/api/tesla/plans', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
        return d;
    }

    async function load(keep) {
        try {
            const r = await fetch('/api/tesla/plans', { headers: headers() });
            const d = await r.json();
            plans = d.plans || [];
            today = d.today || '';
            const fresh = seen && d.current && !seen.has(d.current);
            seen = new Set(plans.map(p => p.id));
            const want = fresh ? d.current : (keep || (cur && cur.id) || d.current);
            cur = plans.find(p => p.id === want) || plans[0] || null;
            if (fresh) note('A new plan arrived for today. Check it, then [approve].');
        } catch (e) { note(`could not load the plans: ${e.message}`); }
        try {
            const r = await fetch('/api/sessions', { headers: headers() });
            const d = await r.json();
            const list = Array.isArray(d) ? d : (d.sessions || []);
            sessions = list.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean);
        } catch (e) { sessions = []; }
        render();
    }

    function note(text) {
        const n = root && root.querySelector('.tp-note');
        if (n) n.textContent = text || '';
    }

    function stepHtml(s, gi, si) {
        const opts = (map, val) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}"${k === val ? ' selected' : ''}>${esc(v)}</option>`).join('');
        const names = sessions.includes(s.session) || !s.session ? sessions : [s.session, ...sessions];
        return `<div class="tp-step" data-st="${esc(s.status)}">
            <div class="tp-line">
                <button class="tp-mark" data-tp="mark" data-g="${gi}" data-s="${si}" title="todo, doing, done">${MARK[s.status] || '[ ]'}</button>
                <textarea class="tp-in tp-stext" data-f="text" data-g="${gi}" data-s="${si}" rows="${Math.min(8, Math.ceil(s.text.length / 34) || 1)}" placeholder="step">${esc(s.text)}</textarea>
                <button class="tp-x" data-tp="del-step" data-g="${gi}" data-s="${si}" title="remove step">[-]</button>
            </div>
            <div class="tp-meta">
                <select data-f="session" data-g="${gi}" data-s="${si}"><option value="">no session</option>${names.map(n => `<option${n === s.session ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
                <select data-f="tool" data-g="${gi}" data-s="${si}">${opts(TOOLS, s.tool)}</select>
                <select data-f="risk" data-g="${gi}" data-s="${si}" class="${s.risk ? 'tp-risk' : ''}">${opts(RISKS, s.risk)}</select>
            </div>
            <input class="tp-in tp-done" data-f="done" data-g="${gi}" data-s="${si}" value="${esc(s.done)}" placeholder="done when... (a commit, a test, a file, a status)">
            <div class="tp-check">
                <span>proof:</span>
                <select data-f="check.kind" data-g="${gi}" data-s="${si}">${opts(CHECKS, (s.check && s.check.kind) || 'manual')}</select>
                ${s.check && s.check.kind !== 'manual' ? `<input class="tp-in" data-f="check.arg" data-g="${gi}" data-s="${si}" value="${esc(s.check.arg)}" placeholder="${s.check.kind === 'git' ? 'words in the commit title' : 'full path of the file'}">` : ''}
            </div>
            ${s.evidence ? `<div class="tp-ev">${esc(s.evidence)}</div>` : ''}
        </div>`;
    }

    function render() {
        if (!root) return;
        const pick = plans.map(p => `<option value="${esc(p.id)}"${cur && p.id === cur.id ? ' selected' : ''}>${esc(p.title)}${p.date && p.title !== p.date ? ` · ${esc(p.date)}` : ''}</option>`).join('');
        let body = '<div class="tp-empty">No plan yet. Start one for today or for this week.</div>';
        if (cur) {
            const steps = cur.goals.flatMap(g => g.steps);
            const done = steps.filter(s => s.status === 'done').length;
            body = `
                <div class="tp-head">
                    <input class="tp-in tp-title" data-f="title" value="${esc(cur.title)}">
                    <select data-f="kind">${['day', 'week', 'free'].map(k => `<option${k === cur.kind ? ' selected' : ''}>${k}</option>`).join('')}</select>
                    ${cur.kind === 'free' ? '' : `<input type="date" data-f="date" value="${esc(cur.date)}">`}
                </div>
                <div class="tp-state" data-state="${esc(cur.state)}">${esc(STATE[cur.state] || cur.state)}${cur.pilot ? ' · autopilot on' : ''} · ${done}/${steps.length} steps done</div>
                <textarea class="tp-in tp-notes" data-f="note" rows="2" placeholder="anything Tesla should know about this plan">${esc(cur.note)}</textarea>
                ${cur.goals.map((g, gi) => `
                    <div class="tp-goal">
                        <div class="tp-line">
                            <span class="tp-n">${gi + 1}</span>
                            <textarea class="tp-in tp-gtext" data-f="goal" data-g="${gi}" rows="${Math.min(4, Math.ceil(g.text.length / 38) || 1)}" placeholder="goal">${esc(g.text)}</textarea>
                            <button class="tp-x" data-tp="del-goal" data-g="${gi}" title="remove goal">[-]</button>
                        </div>
                        ${g.beyond ? `<div class="tp-beyond">${esc(g.beyond)}</div>` : ''}
                        ${g.steps.map((s, si) => stepHtml(s, gi, si)).join('')}
                        <button class="tp-add" data-tp="add-step" data-g="${gi}">[+] step</button>
                    </div>`).join('')}
                <form class="tp-line tp-newgoal" data-tp-form="goal">
                    <input class="tp-in" name="goal" placeholder="new goal, then Enter" autocomplete="off">
                </form>
                ${cur.state === 'approved' ? `
                <div class="tp-pilot${cur.pilot ? ' on' : ''}">
                    <button class="tf-btn" data-tp="pilot">${cur.pilot ? '[pilot on] stop it' : '[pilot off] let Tesla run it'}</button>
                    <textarea class="tp-in tp-allow" data-tp-allow rows="2" placeholder="permissions the pilot may approve, one per line: Bash(npm run check   Edit   Read">${esc((cur.allow || []).join('\n'))}</textarea>
                    <div class="tp-hint">Anything else, any risky step and your own steps stop it and tell you.</div>
                </div>` : ''}
                <div class="tp-actions">
                    <button class="tf-btn" data-tp="deepen"${cur.state === 'deepening' || !cur.goals.length ? ' disabled' : ''}>[deeper] write the steps</button>
                    <button class="tf-btn" data-tp="approve"${cur.state === 'approved' || !steps.length ? ' disabled' : ''}>[approve]</button>
                    ${sureDelete === cur.id
                        ? '<button class="tf-btn tp-sure" data-tp="delete">[yes, delete it]</button><button class="tf-btn" data-tp="keep">[keep]</button>'
                        : '<button class="tf-btn" data-tp="delete">[delete]</button>'}
                </div>`;
        }
        root.innerHTML = `
            <div class="tp-bar">
                <span class="tp-label">PLAN</span>
                <select class="tp-pick" data-tp-pick>${pick}</select>
                <button class="tf-btn" data-tp="new-day">[+ day]</button>
                <button class="tf-btn" data-tp="new-week">[+ week]</button>
            </div>
            <div class="tp-body">${body}</div>
            <div class="tp-note"></div>`;
        // While Tesla writes the steps, look again every 5 s; stop once they land.
        // An approved plan moves by itself (the tracker, the pilot): every 10 s,
        // but never while he is typing in the column.
        clearInterval(poll);
        if (cur && cur.state === 'deepening') poll = setInterval(() => load(cur.id), 5000);
        else poll = setInterval(() => { if (!saveTimer && !sureDelete && !root.contains(document.activeElement)) load(cur && cur.id); }, 10000);
    }

    function field(el) {
        const f = el.dataset.f, gi = Number(el.dataset.g), si = Number(el.dataset.s);
        const v = el.value;
        if (f === 'goal') cur.goals[gi].text = v;
        else if (f.startsWith('check.')) {
            const step = cur.goals[gi].steps[si];
            step.check = Object.assign({ kind: 'manual', arg: '' }, step.check, { [f.slice(6)]: v });
        } else if (el.dataset.s !== undefined) cur.goals[gi].steps[si][f] = v;
        else cur[f] = v;
    }

    function saveSoon(now) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, now ? 0 : 600);
    }
    async function save() {
        clearTimeout(saveTimer);
        saveTimer = 0;
        if (!cur) return;
        try {
            const d = await call({ op: 'save', plan: cur });
            const at = plans.findIndex(p => p.id === d.plan.id);
            if (at >= 0) plans[at] = d.plan; else plans.unshift(d.plan);
            // Ids for new goals and steps come back from the server; keep the
            // inputs he is typing in, only take the ids.
            if (cur.id === d.plan.id || !cur.id) {
                cur.id = d.plan.id;
                cur.goals.forEach((g, gi) => {
                    const sg = d.plan.goals[gi];
                    if (!sg) return;
                    g.id = sg.id; g.steps.forEach((s, si) => { if (sg.steps[si]) s.id = sg.steps[si].id; });
                });
            }
            note('saved');
            return d.plan;
        } catch (e) { note(`not saved: ${e.message}`); return null; }
    }

    async function onClick(e) {
        const el = e.target.closest('[data-tp]');
        if (!el || !root.contains(el)) return;
        const a = el.dataset.tp, gi = Number(el.dataset.g), si = Number(el.dataset.s);
        if (a === 'new-day' || a === 'new-week') {
            cur = { kind: a === 'new-day' ? 'day' : 'week', date: today, title: '', goals: [], note: '' };
            const p = await save();
            if (p) await load(p.id);
            return;
        }
        if (!cur) return;
        if (a === 'mark') {
            const s = cur.goals[gi].steps[si];
            s.status = NEXT[s.status] || 'doing';
            if (s.id) { try { await call({ op: 'step', id: cur.id, step: s.id, status: s.status }); } catch (err) { note(err.message); } }
            return render();
        }
        if (a === 'add-step') { cur.goals[gi].steps.push({ text: '', session: '', tool: 'session', done: '', risk: '', status: 'todo', check: { kind: 'manual', arg: '' } }); render(); return; }
        if (a === 'del-step') { cur.goals[gi].steps.splice(si, 1); render(); return saveSoon(true); }
        if (a === 'del-goal') { cur.goals.splice(gi, 1); render(); return saveSoon(true); }
        if (a === 'approve') { cur.state = 'approved'; await save(); return render(); }
        if (a === 'pilot') {
            const box = root.querySelector('[data-tp-allow]');
            const allow = box ? box.value.split('\n').map(x => x.trim()).filter(Boolean) : (cur.allow || []);
            try {
                const d = await call({ op: 'pilot', id: cur.id, on: !cur.pilot, allow });
                Object.assign(cur, { pilot: d.plan.pilot, allow: d.plan.allow });
                note(cur.pilot ? 'Autopilot on: Tesla sends each step to its session.' : 'Autopilot off.');
            } catch (err) { note(err.message); }
            return render();
        }
        // Asked here, not with the browser's confirm(): a native dialog takes the
        // page out of full screen, which closed Tesla's view on every delete.
        if (a === 'keep') { sureDelete = ''; return render(); }
        if (a === 'delete') {
            if (sureDelete !== cur.id) { sureDelete = cur.id; return render(); }
            sureDelete = '';
            try { await call({ op: 'delete', id: cur.id }); note('Plan deleted.'); } catch (err) { note(err.message); }
            cur = null;
            return load();
        }
        if (a === 'deepen') {
            const p = await save();
            if (!p) return;
            try {
                await call({ op: 'deepen', id: p.id });
                note('Tesla is writing the steps with the /deeper method. They show up here when ready.');
            } catch (err) { note(err.message); }
            return load(p.id);
        }
    }

    function mount(el) {
        root = el;
        root.classList.add('tp');
        root.addEventListener('click', onClick);
        root.addEventListener('input', (e) => {
            if (!cur || !e.target.dataset.f || e.target.tagName === 'SELECT' || e.target.type === 'date') return;
            field(e.target);
            saveSoon();
        });
        root.addEventListener('change', (e) => {
            if (e.target.matches('[data-tp-pick]')) { cur = plans.find(p => p.id === e.target.value) || cur; return render(); }
            if (!cur || !e.target.dataset.f) return;
            field(e.target);
            saveSoon(true);
            if (['kind', 'risk', 'check.kind'].includes(e.target.dataset.f)) render();
        });
        root.addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = e.target.querySelector('input[name="goal"]');
            const text = input && input.value.trim();
            if (!text || !cur) return;
            cur.goals.push({ text, beyond: '', steps: [] });
            await save();
            render();
            const next = root.querySelector('.tp-newgoal input');
            if (next) next.focus();
        });
        load();
    }

    function stop() { clearInterval(poll); poll = 0; if (saveTimer) save(); }

    window.TeslaPlan = { mount, refresh: () => load(cur && cur.id), stop };
})();
