// ─────────────────────────────────────────────────────────────────────────
// codemap.js — desktop "Codemap" tab (next to Tasks).
//
// You don't browse the code index — your ACTIVE Claude sessions do. This panel
// keeps each session's MAP.md fresh and arms a running session to read it first.
//   [Regenerate] runs the repo-map generator against that session's repo.
//   [Prime]      injects a short "read MAP.md first" directive into that session.
//   Auto-keep-fresh regenerates stale/missing maps on a timer (no auto-prime).
//
// SECRETCO: locked sessions render [LOCKED] with NO buttons; the server refuses them
// too. The browser only ever receives counts/age/drift — never any code.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    let state = { genmap_ok: true, autopilot: false, sessions: [] };
    let busy = new Set();          // session names currently regenerating/priming
    let refCount = 0;
    let polling = null;
    let loadError = null;

    function tokenHeaders() { return { Authorization: (typeof token !== 'undefined' ? token : '') || '' }; }
    function jsonHeaders() { return { 'Content-Type': 'application/json', Authorization: (typeof token !== 'undefined' ? token : '') || '' }; }
    function note(msg, type) { if (typeof toast === 'function') toast(msg, type || 'success'); }
    function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }

    async function fetchState() {
        try {
            const r = await fetch('/api/dispatcher/codemap/sessions', { headers: tokenHeaders() });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            state = await r.json();
            loadError = null;
        } catch (e) {
            loadError = e.message || 'load failed';
        }
    }

    function statusLine(s) {
        if (s.secretco) return '<span class="cm-lock">[LOCKED] SecretCo — Bedrock-only, never mapped</span>';
        const m = s.map;
        if (!m || !m.exists) return '<span class="cm-nomap">No map yet — regenerate to index this repo</span>';
        const bits = [];
        if (m.symbols != null) bits.push('<b>' + m.symbols + '</b> symbols');
        if (m.files != null) bits.push(m.files + ' files');
        if (m.age) bits.push('mapped ' + esc(m.age));
        let html = bits.join(' &middot; ');
        if (m.drift > 0) {
            html += ' &middot; <span class="' + (m.stale ? 'cm-drift-stale' : 'cm-drift') + '">' +
                m.drift + ' changed since</span>';
        }
        return html;
    }

    function card(s) {
        const isBusy = busy.has(s.name);
        const cls = ['cm-card'];
        if (s.secretco) cls.push('cm-card-secretco');
        else if (s.map && s.map.stale) cls.push('cm-card-stale');
        else if (!s.map || !s.map.exists) cls.push('cm-card-nomap');
        const dot = s.attached ? '<span class="cm-dot cm-dot-on" title="attached"></span>' : '<span class="cm-dot" title="detached"></span>';
        let actions = '';
        if (!s.secretco) {
            const dis = isBusy ? ' disabled' : '';
            const regenLabel = isBusy ? 'mapping…' : ((s.map && s.map.exists) ? '[Regenerate]' : '[Generate map]');
            actions =
                '<div class="cm-actions">' +
                '<button class="cm-btn cm-btn-regen"' + dis + ' onclick="codemapRegen(\'' + esc(s.name) + '\')">' + regenLabel + '</button>' +
                '<button class="cm-btn cm-btn-prime"' + dis + ' onclick="codemapPrime(\'' + esc(s.name) + '\')" title="Inject a read-MAP.md-first directive into this live session">[Prime session]</button>' +
                '</div>';
        }
        return (
            '<div class="' + cls.join(' ') + '">' +
            '<div class="cm-card-head">' + dot +
            '<span class="cm-name">' + esc(s.name) + '</span>' +
            '<span class="cm-proj">' + esc(s.project) + '</span>' +
            '</div>' +
            '<div class="cm-status">' + statusLine(s) + '</div>' +
            actions +
            '</div>'
        );
    }

    function render() {
        const body = document.getElementById('pc-codemap-body');
        if (!body) return;
        const sessions = state.sessions || [];
        const mapped = sessions.filter(s => !s.secretco && s.map && s.map.exists).length;
        const needs = sessions.filter(s => !s.secretco && (!s.map || !s.map.exists || s.map.stale)).length;
        const locked = sessions.filter(s => s.secretco).length;

        let summary = sessions.length + ' session' + (sessions.length === 1 ? '' : 's') +
            ' &middot; ' + mapped + ' mapped';
        if (needs) summary += ' &middot; <span class="cm-drift-stale">' + needs + ' need refresh</span>';
        if (locked) summary += ' &middot; ' + locked + ' locked';

        let html =
            '<div class="cm-bar">' +
            '<span class="cm-summary">' + summary + '</span>' +
            '<span class="cm-bar-actions">' +
            '<label class="cm-auto" title="Regenerate stale/missing maps automatically (never auto-primes)">' +
            '<input type="checkbox" ' + (state.autopilot ? 'checked' : '') + ' onchange="codemapToggleAuto(this.checked)"> Auto-keep-fresh</label>' +
            '<button class="cm-btn" onclick="codemapRegenAll()">[Regenerate all]</button>' +
            '</span>' +
            '</div>';

        if (!state.genmap_ok) {
            html += '<div class="cm-warn">repo-map generator not found (~/.claude/skills/repo-map/genmap.js). ' +
                'Maps can\'t be (re)generated until it exists.</div>';
        }
        if (loadError) html += '<div class="cm-warn">Load error: ' + esc(loadError) + '</div>';

        if (!sessions.length) {
            html += '<div class="cm-empty">No active sessions. Create one (sidebar [+]), then regenerate its map ' +
                'so your Claude session can read code by file:line instead of grepping.</div>';
        } else {
            html += '<div class="cm-list">' + sessions.map(card).join('') + '</div>';
        }

        html += '<div class="cm-foot">Your session reads MAP.md on disk; the browser only ever sees counts. ' +
            'The Obsidian vault is the <i>why</i>; MAP.md is the <i>where</i>.</div>';

        body.innerHTML = html;
    }

    async function refresh() { await fetchState(); render(); }

    function scheduleNext() {
        if (polling) clearTimeout(polling);
        const interval = busy.size ? 2500 : 8000;
        polling = setTimeout(async () => { if (refCount > 0) { await refresh(); scheduleNext(); } }, interval);
    }

    // ── actions ──────────────────────────────────────────────────────────
    async function codemapRegen(name) {
        if (busy.has(name)) return;
        busy.add(name); render();
        try {
            const r = await fetch('/api/dispatcher/codemap/regenerate', {
                method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ session: name }),
            });
            const d = await r.json();
            if (d.ok) note('mapped ' + name + (d.map && d.map.symbols != null ? ' · ' + d.map.symbols + ' symbols' : ''));
            else note((d.secretco ? 'SecretCo: ' : '') + (d.error || 'regenerate failed'), d.secretco ? 'warn' : 'error');
        } catch (e) {
            note('regenerate failed', 'error');
        } finally {
            busy.delete(name);
            await refresh(); scheduleNext();
        }
    }

    async function codemapPrime(name) {
        if (busy.has(name)) return;
        busy.add(name); render();
        try {
            const r = await fetch('/api/dispatcher/codemap/prime', {
                method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ session: name }),
            });
            const d = await r.json();
            if (d.success) note('primed ' + name + ' — directive sent');
            else note((d.secretco ? 'SecretCo: ' : '') + (d.error || 'prime failed'), d.secretco ? 'warn' : 'error');
        } catch (e) {
            note('prime failed', 'error');
        } finally {
            busy.delete(name); render();
        }
    }

    async function codemapRegenAll() {
        const targets = (state.sessions || []).filter(s => !s.secretco).map(s => s.name);
        if (!targets.length) { note('no mappable sessions', 'warn'); return; }
        note('regenerating ' + targets.length + ' map' + (targets.length === 1 ? '' : 's') + '…');
        for (const name of targets) { await codemapRegen(name); }
    }

    async function codemapToggleAuto(enabled) {
        try {
            const r = await fetch('/api/dispatcher/codemap/autopilot', {
                method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ enabled: !!enabled }),
            });
            const d = await r.json();
            state.autopilot = !!(d && d.autopilot);
            note('auto-keep-fresh ' + (state.autopilot ? 'on' : 'off'));
        } catch (e) { note('toggle failed', 'error'); }
        render();
    }

    // ── lifecycle ────────────────────────────────────────────────────────
    async function codemapInit() {
        refCount++;
        await refresh();
        scheduleNext();
    }
    function codemapTeardown() {
        refCount = Math.max(0, refCount - 1);
        if (refCount === 0 && polling) { clearTimeout(polling); polling = null; }
    }

    window.codemapInit = codemapInit;
    window.codemapTeardown = codemapTeardown;
    window.codemapRegen = codemapRegen;
    window.codemapPrime = codemapPrime;
    window.codemapRegenAll = codemapRegenAll;
    window.codemapToggleAuto = codemapToggleAuto;
})();
