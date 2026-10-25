// ─────────────────────────────────────────────────────────────────────────
// tesla-center.js — the command center, right side of Tesla's full screen
// (2026-10-25). From Tesla's full screen the owner sees the plan's progress and
// her connections to the tmux sessions: the command center.
//
// Top right: her CONNECTIONS. Tesla is the hub; every session the plan on now
// touches is a node, its line coloured by state (working, idle, waiting for a
// permission, closed) and moving while the session works, with the step it is
// on. Bottom right: the permission cards waiting in those sessions, with
// [allow]/[deny] (the same /api/permission routes as everywhere), and the feed
// of what the tracker and the pilot did. One GET /api/tesla/center every 4 s,
// only while full screen is open.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const STATE = { working: 'working', idle: 'idle', waiting: 'needs you', gone: 'closed' };
    const KIND = { sent: '[>]', done: '[x]', blocked: '[!]', nudged: '[?]', allowed: '[+]', asked: '[!]', finished: '[*]' };
    let net = null, feed = null, timer = 0, busy = false;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const headers = () => ({ 'Content-Type': 'application/json', Authorization: (typeof token !== 'undefined' && token) ? token : (window.token || '') });
    const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

    function drawNet(d) {
        const plan = d.plan;
        const list = d.sessions || [];
        const head = plan
            ? `<div class="tc-head"><span class="tc-label">CONNECTIONS</span><span class="tc-sub">${esc(plan.title)} · ${plan.done}/${plan.steps}${plan.pilot ? ' · <b class="tc-pilot">autopilot</b>' : ''}</span></div>`
            : '<div class="tc-head"><span class="tc-label">CONNECTIONS</span><span class="tc-sub">no plan on now</span></div>';
        if (!list.length) { net.innerHTML = head + '<div class="tc-empty">The sessions of the plan on now show up here.</div>'; return; }
        // The map: Tesla at the left, one node per session, a line between.
        const row = 46, h = Math.max(90, list.length * row + 10), hubY = h / 2;
        const lines = list.map((s, i) => {
            const y = 5 + row / 2 + i * row;
            return `<path class="tc-link" data-st="${esc(s.state)}" d="M 34 ${hubY} C 80 ${hubY}, 80 ${y}, 128 ${y}"/>`
                + `<circle class="tc-node" data-st="${esc(s.state)}" cx="132" cy="${y}" r="5"/>`;
        }).join('');
        const svg = `<svg class="tc-map" viewBox="0 0 140 ${h}" preserveAspectRatio="xMinYMin meet" style="height:${h}px" aria-hidden="true">
            ${lines}<circle class="tc-hub" cx="22" cy="${hubY}" r="12"/><text class="tc-hubt" x="22" y="${hubY + 3}">T</text></svg>`;
        const cards = list.map(s => `
            <div class="tc-s" data-st="${esc(s.state)}" style="height:${row}px">
                <div class="tc-sl"><span class="tc-sn">${esc(s.name)}</span><span class="tc-st">${esc(STATE[s.state] || s.state)}${s.pilot ? ' · pilot' : ''}</span><span class="tc-sc">${s.done}/${s.total}</span></div>
                <div class="tc-step">${esc(s.state === 'waiting' && s.waiting ? s.waiting : s.step || 'nothing pending')}</div>
            </div>`).join('');
        net.innerHTML = head + `<div class="tc-net">${svg}<div class="tc-list">${cards}</div></div>`;
    }

    function drawFeed(d) {
        const cards = (d.pending || []).map(c => `
            <div class="tc-card">
                <div class="tc-ct"><b>${esc(c.session)}</b> wants ${esc(c.tool || 'a permission')}</div>
                <div class="tc-cw">${esc(c.what)}</div>
                <div class="tc-cb"><button class="tf-btn" data-tc="approve" data-id="${esc(c.id)}">[allow]</button><button class="tf-btn" data-tc="deny" data-id="${esc(c.id)}">[deny]</button></div>
            </div>`).join('');
        const rows = (d.events || []).map(e => `
            <div class="tc-ev" data-k="${esc(e.kind)}"><span class="tc-et">${hhmm(e.at)}</span><span class="tc-ek">${KIND[e.kind] || '[i]'}</span><span class="tc-ex">${e.session ? `<b>${esc(e.session)}</b> ` : ''}${esc(e.text)}</span></div>`).join('');
        feed.innerHTML = `<div class="tc-head"><span class="tc-label">UPDATES</span><span class="tc-sub">${(d.pending || []).length ? `${d.pending.length} waiting for you` : 'nothing waiting for you'}</span></div>`
            + cards + (rows || '<div class="tc-empty">What the tracker and the pilot do shows up here.</div>');
    }

    async function refresh() {
        if (busy || !net) return;
        busy = true;
        try {
            const r = await fetch('/api/tesla/center', { headers: headers() });
            if (r.ok) { const d = await r.json(); drawNet(d); drawFeed(d); }
        } catch (e) { /* the next poll tries again */ }
        busy = false;
    }

    async function onClick(e) {
        const b = e.target.closest('[data-tc]');
        if (!b) return;
        b.disabled = true;
        try {
            await fetch(`/api/permission/${encodeURIComponent(b.dataset.id)}/${b.dataset.tc === 'approve' ? 'approve' : 'deny'}`, { method: 'POST', headers: headers() });
        } catch (err) { /* refresh shows it is still there */ }
        refresh();
    }

    function mount(netEl, feedEl) {
        net = netEl; feed = feedEl;
        net.classList.add('tc'); feed.classList.add('tc');
        feed.addEventListener('click', onClick);
    }
    function start() { clearInterval(timer); refresh(); timer = setInterval(refresh, 4000); }
    function stop() { clearInterval(timer); timer = 0; }

    window.TeslaCenter = { mount, start, stop };
})();
