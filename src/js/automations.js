// ─────────────────────────────────────────────────────────────────────────
// automations.js — the "Automations" tab (desktop) and room (mobile).
//
// Everything that runs by itself, one card each, grouped by what it is for.
// A card is a dot, a name and a switch; the line under it says when it last ran
// and how that went. Tap the card for the rest: what it does, the last runs,
// and the time for the scheduled ones.
//
// Renders GET /api/automations into every `.au-mount` on the page, so the
// desktop panel and the mobile room share one module. The server decides every
// state (lib/automations.js); this file only draws it and sends the taps.
//
// Two confirmations and no more: turning OFF something the machine leans on
// (session watcher, phone alerts), and running by hand a job that spends
// Claude tokens. Hooks and system services show a lock, never a switch.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    let data = null;
    let loadError = null;
    let refCount = 0;
    let timer = null;
    let badgeTimer = null;
    const openCards = new Set();
    const busy = new Set();          // ids with a request in flight

    function tokenHeaders() { return { Authorization: (typeof token !== 'undefined' ? token : '') || '' }; }
    function jsonHeaders() { return { 'Content-Type': 'application/json', ...tokenHeaders() }; }
    function note(msg, type) { if (typeof toast === 'function') toast(msg, type || 'success'); }
    function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }

    // ── data ─────────────────────────────────────────────────────────────
    async function fetchData() {
        try {
            const r = await fetch('/api/automations', { headers: tokenHeaders() });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            data = await r.json();
            loadError = null;
            setBadge(data.alerts || 0);
        } catch (e) {
            loadError = e.message || 'load failed';
        }
    }

    async function post(op, body) {
        const r = await fetch('/api/automations/' + op, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
        let j = {};
        try { j = await r.json(); } catch { /* empty */ }
        if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
    }

    function allItems() {
        return data ? data.groups.flatMap(g => g.items) : [];
    }
    function item(id) { return allItems().find(i => i.id === id); }

    // ── formatting ───────────────────────────────────────────────────────
    function ago(ms) {
        if (!ms) return '';
        const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
        if (m < 1) return 'just now';
        if (m < 60) return m + 'm ago';
        const h = Math.round(m / 60);
        return h < 48 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
    }
    function ahead(ms) {
        if (!ms) return '';
        const m = Math.round((ms - Date.now()) / 60000);
        if (m <= 1) return 'now';
        if (m < 60) return 'in ' + m + 'm';
        const h = Math.round(m / 60);
        if (h < 24) return 'in ' + h + 'h';
        const d = new Date(ms);
        return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' +
            String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    const STATE_WORD = { ok: 'OK', warn: 'Look at this', fail: 'Needs attention', running: 'Running', off: 'Off', idle: 'Waiting' };

    // The one line under the name: what happened last, or why it is quiet.
    function statusLine(it) {
        if (it.state === 'running') return 'Running now...';
        if (it.missed && it.state === 'fail' && !it.result) return 'Missed its run on ' + it.missed;
        const bits = [];
        if (it.lastRun) bits.push(ago(it.lastRun));
        if (it.result) bits.push(it.result);
        else if (it.line) bits.push(it.line);
        if (!bits.length) return it.on === false ? 'Off' : (it.schedule || '');
        return bits.join(' · ');
    }

    // ── pieces ───────────────────────────────────────────────────────────
    function sw(it) {
        if (it.locked || !it.canToggle || it.on === null) {
            return '<span class="au-lock" title="Shown only: change it by hand">[L]</span>';
        }
        const b = busy.has(it.id);
        return '<button class="au-switch' + (it.on ? ' on' : '') + (b ? ' busy' : '') + '" role="switch" aria-checked="' + (it.on ? 'true' : 'false') + '"' +
            ' data-id="' + esc(it.id) + '" onclick="event.stopPropagation();auToggle(this)" title="' + (it.on ? 'On - tap to turn off' : 'Off - tap to turn on') + '">' +
            '<span class="au-knob"></span></button>';
    }

    function details(it) {
        const rows = [];
        if (it.blurb) rows.push('<div class="au-blurb">' + esc(it.blurb) + '</div>');
        const facts = [];
        if (it.schedule) facts.push('<span>' + esc(it.schedule) + '</span>');
        if (it.nextRun) facts.push('<span>Next: <b>' + esc(ahead(it.nextRun)) + '</b></span>');
        if (it.failStreak > 1) facts.push('<span class="au-red">Failed ' + it.failStreak + ' times in a row</span>');
        if (facts.length) rows.push('<div class="au-facts">' + facts.join('') + '</div>');
        if (it.editableTime) {
            rows.push('<div class="au-time">Time <input type="time" value="' + esc(it.at || '') + '" data-id="' + esc(it.id) + '"' +
                ' onclick="event.stopPropagation()" onchange="auSetTime(this)"></div>');
        }
        if (it.history && it.history.length) {
            rows.push('<div class="au-hist">' + it.history.slice(0, 5).map(h =>
                '<div class="au-hist-row"><span class="au-dot au-dot-' + (h.ok ? (h.warn ? 'warn' : 'ok') : 'fail') + '"></span>' +
                '<span class="au-hist-when">' + esc(ago(h.at)) + (h.manual ? ' (by hand)' : '') + '</span>' +
                '<span class="au-hist-text">' + esc(h.text || (h.ok ? 'OK' : 'Failed')) + '</span></div>').join('') + '</div>');
        }
        return '<div class="au-details">' + rows.join('') + '</div>';
    }

    function card(it) {
        const isOpen = openCards.has(it.id);
        const runBtn = it.canRun
            ? '<button class="au-run" data-id="' + esc(it.id) + '" onclick="event.stopPropagation();auRun(this)" title="Run it now">[&gt;] Run</button>'
            : '';
        return '<div class="au-card au-card-' + esc(it.state) + (isOpen ? ' open' : '') + '" data-id="' + esc(it.id) + '" onclick="auOpen(this)">' +
            '<div class="au-head">' +
                '<span class="au-dot au-dot-' + esc(it.state) + '" title="' + esc(STATE_WORD[it.state] || '') + '"></span>' +
                '<span class="au-name">' + esc(it.title) + '</span>' +
                sw(it) +
            '</div>' +
            '<div class="au-line">' + esc(statusLine(it)) + '</div>' +
            (runBtn ? '<div class="au-actions">' + runBtn + '</div>' : '') +
            (isOpen ? details(it) : '') +
        '</div>';
    }

    function render() {
        const mounts = document.querySelectorAll('.au-mount');
        if (!mounts.length) return;
        let html;
        if (!data && loadError) {
            html = '<div class="au-warn">Could not load the automations: ' + esc(loadError) + '</div>';
        } else if (!data) {
            html = '<div class="au-empty">Loading...</div>';
        } else {
            const items = allItems();
            const on = items.filter(i => i.on === true && !i.locked).length;
            const off = items.filter(i => i.on === false).length;
            const bad = items.filter(i => i.state === 'fail');
            html = '<div class="au-bar"><span class="au-summary">' +
                '<b>' + on + '</b> on · <b>' + off + '</b> off' +
                (bad.length ? ' · <b class="au-red">' + bad.length + '</b> need attention' : ' · all good') +
                '</span><button class="au-btn" onclick="auReload()" title="Reload">[~]</button></div>';
            if (loadError) html += '<div class="au-warn">Last refresh failed: ' + esc(loadError) + '</div>';
            if (bad.length) {
                html += '<div class="au-group au-attention"><div class="au-group-h">Needs attention</div><div class="au-grid">' +
                    bad.map(card).join('') + '</div></div>';
            }
            for (const g of data.groups) {
                const rest = g.items.filter(i => i.state !== 'fail');
                if (!rest.length) continue;
                html += '<div class="au-group"><div class="au-group-h">' + esc(g.title) + '</div><div class="au-grid">' +
                    rest.map(card).join('') + '</div></div>';
            }
        }
        mounts.forEach(m => { m.innerHTML = html; });
    }

    function setBadge(n) {
        const b = document.getElementById('au-tab-badge');
        if (b) {
            b.textContent = n > 0 ? String(n) : '';
            b.classList.toggle('hidden', !(n > 0));
        }
        // The mobile button's dot is styled inline: room CSS is not loaded yet.
        const mb = document.getElementById('au-quick-badge');
        if (mb) mb.style.display = n > 0 ? 'inline-block' : 'none';
    }

    // ── taps ─────────────────────────────────────────────────────────────
    async function auToggle(el) {
        const id = el.dataset.id;
        const it = item(id);
        if (!it || busy.has(id)) return;
        const turnOn = !it.on;
        if (!turnOn && it.core && !confirm('Turn off "' + it.title + '"?\n\n' + (it.blurb || ''))) return;
        busy.add(id);
        it.on = turnOn;                 // optimistic: the switch moves at once
        render();
        try {
            await post('set', { id, on: turnOn });
            note(it.title + (turnOn ? ' on' : ' off'));
        } catch (e) {
            note(it.title + ': ' + e.message, 'error');
        }
        busy.delete(id);
        await refresh();
    }

    async function auRun(el) {
        const id = el.dataset.id;
        const it = item(id);
        if (!it || busy.has(id)) return;
        if (it.costly && !confirm('Run "' + it.title + '" now? It spends Claude tokens.')) return;
        busy.add(id);
        try {
            await post('run', { id });
            note(it.title + ' started');
        } catch (e) {
            note(it.title + ': ' + e.message, 'error');
        }
        busy.delete(id);
        setTimeout(refresh, 1500);
    }

    function auOpen(el) {
        const id = el.dataset.id;
        if (openCards.has(id)) openCards.delete(id); else openCards.add(id);
        render();
    }

    async function auSetTime(el) {
        const id = el.dataset.id;
        const it = item(id);
        try {
            await post('time', { id, at: el.value });
            note((it ? it.title : id) + ' now at ' + el.value);
        } catch (e) {
            note(e.message, 'error');
        }
        await refresh();
    }

    async function refresh() {
        await fetchData();
        render();
    }
    function auReload() { return refresh(); }

    // Faster while something is running, so its result shows up without a tap.
    function scheduleNext() {
        if (timer) clearTimeout(timer);
        if (refCount === 0) { timer = null; return; }
        const running = allItems().some(i => i.state === 'running');
        timer = setTimeout(async () => { await refresh(); scheduleNext(); }, running ? 5000 : 30000);
    }

    // ── the red number on the tab button, from boot ──────────────────────
    async function pollBadge() {
        try {
            const r = await fetch('/api/automations/alerts', { headers: tokenHeaders() });
            if (r.ok) setBadge((await r.json()).alerts || 0);
        } catch { /* offline: keep the last number */ }
    }
    function startBadge() {
        if (badgeTimer) return;
        setTimeout(pollBadge, 8000);
        badgeTimer = setInterval(pollBadge, 120000);
    }

    // ── lifecycle ────────────────────────────────────────────────────────
    async function automationsInit() {
        refCount++;
        render();
        await refresh();
        scheduleNext();
    }
    function automationsTeardown() {
        refCount = Math.max(0, refCount - 1);
        if (refCount === 0 && timer) { clearTimeout(timer); timer = null; }
    }

    if (typeof WorldManager !== 'undefined') {
        WorldManager.rooms.automations = {
            id: 'automations-room',
            theme: 'terminal',
            title: 'Automations',
            icon: 'clock',
            description: 'Everything that runs by itself',
            onOpen: null,
            onClose: null,
        };
        WorldManager.onRoomOpen('automations', automationsInit);
        WorldManager.onRoomClose('automations', automationsTeardown);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startBadge);
    else startBadge();

    window.automationsInit = automationsInit;
    window.automationsTeardown = automationsTeardown;
    window.auToggle = auToggle;
    window.auRun = auRun;
    window.auOpen = auOpen;
    window.auSetTime = auSetTime;
    window.auReload = auReload;
})();
