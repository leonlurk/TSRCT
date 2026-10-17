// ─────────────────────────────────────────────────────────────────────────
// clients.js — desktop "Clients" tab: how each client relationship is doing.
//
// Renders GET /api/clients and nothing else. The facts come from headless
// Claude (the morning run, or [Refresh]); the health colour, the verdict
// fallback, the next steps and the this-week / backlog split are decided on
// the server (lib/clientHealth.js). No client is named here.
//
// Per card, top to bottom, in the order he decides: the verdict, at most three
// NEXT steps with a button that does them, anything else waiting on him, what
// is due THIS WEEK, and the backlog folded away. [x] expires an item: TSRCT
// stops showing it and the next job is told not to report it. That is the only
// thing this tab writes, and it writes it to TSRCT itself.
//
// No polling while idle: the data only changes when a job runs.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    let data = null;
    let loadError = null;
    let refCount = 0;
    let polling = null;
    // View state that survives a re-render: which folds are open, which quote is showing.
    const open = new Set();      // `${client}|backlog`, `${client}|expired`, `q|${key}`

    function tokenHeaders() { return { Authorization: (typeof token !== 'undefined' ? token : '') || '' }; }
    function jsonHeaders() { return { 'Content-Type': 'application/json', ...tokenHeaders() }; }
    function note(msg, type) { if (typeof toast === 'function') toast(msg, type || 'success'); }
    function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }

    async function fetchData() {
        try {
            const r = await fetch('/api/clients', { headers: tokenHeaders() });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            data = await r.json();
            loadError = null;
        } catch (e) {
            loadError = e.message || 'load failed';
        }
    }

    // ── formatting ───────────────────────────────────────────────────────
    function ago(ms) {
        if (!ms) return '';
        const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
        if (m < 60) return m + 'm';
        const h = Math.round(m / 60);
        return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
    }
    function agoIso(iso) { return iso ? ago(Date.parse(iso)) : ''; }
    function shortDay(d) { return d ? d.slice(5) : ''; }

    function mailUrl(threadId) {
        const box = data && data.mailbox;
        return box
            ? 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(box) + '#all/' + encodeURIComponent(threadId)
            : 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(threadId);
    }
    function btn(url, label, cls) {
        return '<a class="' + (cls || 'cl-act') + '" href="' + esc(url) + '" target="_blank" rel="noopener">' + label + '</a>';
    }
    function dataAttrs(o) {
        return Object.entries(o).map(([k, v]) => ' data-' + k + '="' + esc(v) + '"').join('');
    }
    function expireBtn(key, client, title, refs) {
        if (!key) return '';
        return '<button class="cl-x"' + dataAttrs({ key, client, title, refs: (refs || []).join('|') }) +
            ' onclick="clientsExpire(this)" title="expire: stop showing this">[x]</button>';
    }

    function ruleTip() {
        const r = (data && data.rule) || {};
        return 'red: unanswered > ' + r.unansweredHours + ' weekday h · high overdue · promise overdue\n' +
            'yellow: unanswered · overdue · not in ClickUp · oldest > ' + r.oldestOpenDays + 'd · more open than last week · mail not read';
    }

    // ── pieces ───────────────────────────────────────────────────────────
    function stats(c) {
        const k = c.counts;
        const bits = ['<b>' + k.open + '</b> open', '<b>' + k.high + '</b> high'];
        if (k.overdue) bits.push('<b class="cl-red">' + k.overdue + '</b> overdue');
        if (k.oldest != null) bits.push('oldest <b>' + k.oldest + 'd</b>');
        if (k.review) bits.push('<span class="cl-amber" title="items Claude could not interpret with certainty">[?] ' + k.review + '</span>');
        const arrow = k.open > k.openLastWeek ? '<span class="cl-amber">&#9650;</span>'
            : k.open < k.openLastWeek ? '<span class="cl-green">&#9660;</span>' : '=';
        bits.push('<span title="open a week ago -> now · resolved this week: ' + k.resolvedWeek + '">' + arrow + ' ' + k.openLastWeek + '&rarr;' + k.open + '</span>');
        if (c.mail) {
            bits.push('<span title="last mail from them ' + esc(c.last_in || '-') + '">in ' + (agoIso(c.last_in) || '-') + '</span>');
            bits.push('<span title="our last reply ' + esc(c.last_out || '-') + '">out ' + (agoIso(c.last_out) || '-') + '</span>');
        } else {
            bits.push('<span class="cl-amber">mail -</span>');
        }
        return bits.join(' &middot; ');
    }

    function nextSteps(c) {
        if (!c.actions.length) return '';
        return '<div class="cl-sec">[>] NEXT</div>' + c.actions.map((a, i) =>
            '<div class="cl-next">' +
            '<span class="cl-n">' + (i + 1) + '</span>' +
            '<span class="cl-do">' + esc(a.do) + (a.why ? '<span class="cl-why">' + esc(a.why) + '</span>' : '') + '</span>' +
            '<span class="cl-ctas">' +
            (a.thread_id ? btn(mailUrl(a.thread_id), /^reply/i.test(a.do) ? 'REPLY' : 'MAIL', 'cl-cta') : '') +
            (a.url ? btn(a.url, 'TASK', 'cl-cta') : '') +
            (!a.thread_id && !a.url && c.soon.length ? '<button class="cl-cta" data-client="' + esc(c.name) + '" onclick="clientsJump(this)">SHOW</button>' : '') +
            expireBtn(a.key, c.name, a.do) +
            '</span></div>').join('');
    }

    const KIND = { unanswered: 'UNANSWERED', promise: 'PROMISE' };
    function waitingRows(c) {
        if (!c.waiting.length) return '';
        return '<div class="cl-sec">[!] WAITING</div>' + c.waiting.map(w =>
            '<div class="cl-row' + (w.late ? ' cl-row-red' : ' cl-row-amber') + '"' + (w.quote ? ' title="' + esc(w.quote) + '"' : '') + '>' +
            '<span class="cl-kind">' + KIND[w.kind] + '</span>' +
            '<span class="cl-age">' + (w.kind === 'promise' ? esc(shortDay(w.due)) : w.hours + 'h') + '</span>' +
            '<span class="cl-title">' + (w.who ? '<span class="cl-who">' + esc(w.who) + '</span> ' : '') + esc(w.subject || w.what) + '</span>' +
            '<span class="cl-ctas">' + (w.thread_id ? btn(mailUrl(w.thread_id), '[mail]') : '') +
            (w.url ? btn(w.url, '[task]') : '') + expireBtn(w.key, c.name, w.subject || w.what) + '</span>' +
            '</div>').join('');
    }

    // Every ClickUp place the request lives in (a task, or a checkbox inside one),
    // then its mail threads. No place at all = it lives only in a mail.
    function placeLinks(r) {
        return r.places.map((p, i) => '<a class="cl-act" href="' + esc(p.url) + '" target="_blank" rel="noopener" title="' +
            esc(p.label) + '">' + (i ? '[task ' + (i + 1) + ']' : '[task]') + '</a>').join('');
    }

    function requestRow(c, r, resolved) {
        const cls = ['cl-row', 'cl-req'];
        if (resolved) cls.push('cl-row-dim');
        else if (r.overdue) cls.push(r.high ? 'cl-row-red' : 'cl-row-amber');
        const showQuote = open.has('q|' + r.key);
        const flags =
            (r.review ? '<span class="cl-flag" title="' + esc(r.review) + '">[?]</span>' : '') +
            (!r.places.length && !resolved ? '<span class="cl-flag" title="no ClickUp place">[mail only]</span>' : '');
        return '<div class="' + cls.join(' ') + '">' +
            '<span class="cl-age" title="days since the client first asked">' + (r.age != null ? r.age + 'd' : '-') + '</span>' +
            '<span class="cl-prio' + (r.high ? ' cl-prio-high' : '') + '" title="' + esc(r.priority) + '">' +
            (r.high ? 'H' : (r.priority ? esc(r.priority[0].toUpperCase()) : '-')) + '</span>' +
            '<span class="cl-title' + (r.quote ? ' cl-has-quote' : '') + '"' +
            (r.quote ? dataAttrs({ key: r.key }) + ' onclick="clientsQuote(this)"' : '') + '>' +
            (r.who ? '<span class="cl-who">' + esc(r.who) + '</span> ' : '') + esc(r.title) + flags +
            (showQuote ? '<span class="cl-quote">"' + esc(r.quote.replace(/^"+|"+$/g, '')) + '"</span>' : '') + '</span>' +
            '<span class="cl-due' + (r.overdue ? ' cl-red' : '') + '">' +
            (resolved ? esc(shortDay(r.resolved_on)) : (r.due ? esc(shortDay(r.due)) : '')) + '</span>' +
            '<span class="cl-ctas">' + placeLinks(r) +
            (r.thread_ids[0] ? btn(mailUrl(r.thread_ids[0]), '[mail]') : '') +
            (resolved ? '' : expireBtn(r.key, c.name, r.title, r.refs)) + '</span>' +
            '</div>';
    }

    function fold(c, id, label) {
        const on = open.has(c.name + '|' + id);
        return '<button class="cl-fold"' + dataAttrs({ client: c.name, sec: id }) + ' onclick="clientsToggle(this)">' +
            (on ? '[-] ' : '[+] ') + label + '</button>';
    }

    function card(c) {
        const k = c.counts;
        let html = '<div class="cl-card cl-card-' + c.health + '" id="cl-card-' + esc(c.name.replace(/[^\w-]/g, '_')) + '">' +
            '<div class="cl-head">' +
            '<span class="cl-dot cl-dot-' + c.health + '" title="' + esc((c.reasons.join(' · ') || 'ok') + '\n\n' + ruleTip()) + '"></span>' +
            (c.code ? '<span class="cl-code">' + esc(c.code) + '</span>' : '') +
            '<span class="cl-name">' + esc(c.name) + '</span>' +
            '<span class="cl-stats">' + stats(c) + '</span>' +
            '</div>' +
            '<div class="cl-verdict cl-verdict-' + c.health + '">' + esc(c.verdict) + '</div>' +
            nextSteps(c) + waitingRows(c);

        if (c.soon.length) {
            html += '<div class="cl-sec cl-soon-h">[~] THIS WEEK ' + c.soon.length + '</div>' +
                c.soon.map(r => requestRow(c, r)).join('');
        }
        const folds = [];
        if (k.backlog) folds.push(fold(c, 'backlog', 'BACKLOG ' + k.backlog));
        if (c.resolved.length) folds.push(fold(c, 'resolved', 'RESOLVED ' + c.resolved.length));
        if (c.expired.length) folds.push(fold(c, 'expired', 'EXPIRED ' + c.expired.length));
        if (folds.length) html += '<div class="cl-folds">' + folds.join('') + '</div>';
        if (open.has(c.name + '|backlog')) html += c.backlog.map(r => requestRow(c, r)).join('');
        if (open.has(c.name + '|resolved')) html += c.resolved.map(r => requestRow(c, r, true)).join('');
        if (open.has(c.name + '|expired')) {
            html += c.expired.map(e =>
                '<div class="cl-row cl-row-dim">' +
                '<span class="cl-kind">EXPIRED</span>' +
                '<span class="cl-age">' + ago(e.at) + '</span>' +
                '<span class="cl-title">' + esc(e.title || e.key) + '</span>' +
                '<span class="cl-ctas"><button class="cl-x"' + dataAttrs({ key: e.key }) +
                ' onclick="clientsRestore(this)" title="show it again">[restore]</button></span>' +
                '</div>').join('');
        }
        return html + '</div>';
    }

    function render() {
        const body = document.getElementById('pc-clients-body');
        if (!body) return;
        const clients = (data && data.clients) || [];
        let bar = clients.length + ' client' + (clients.length === 1 ? '' : 's');
        if (data && data.updatedAt) {
            bar += ' &middot; <span title="' + esc(new Date(data.updatedAt).toLocaleString()) + '">' +
                ago(data.updatedAt) + '</span> &middot; ' + esc(data.source || '');
        }
        const running = data && data.running;
        let html =
            '<div class="cl-bar">' +
            '<span class="cl-summary">' + bar + '</span>' +
            '<span class="cl-bar-actions">' +
            (running
                ? '<span class="cl-amber">reading ' + ago(data.runStartedAt) + '</span>'
                : '<button class="cl-btn" onclick="clientsRun()" title="Re-read ClickUp + Gmail now (headless Claude)">[Refresh]</button>') +
            '</span></div>';
        if (loadError) html += '<div class="cl-warn">' + esc(loadError) + '</div>';
        if (data && data.lastError) html += '<div class="cl-warn">' + esc(data.lastError) + '</div>';
        html += clients.length
            ? '<div class="cl-list">' + clients.map(card).join('') + '</div>'
            : '<div class="cl-empty">' + (data && data.configured === 0 ? 'no clients configured' : 'no data') + '</div>';
        body.innerHTML = html;
    }

    async function refresh() { await fetchData(); render(); }

    function scheduleNext() {
        if (polling) { clearTimeout(polling); polling = null; }
        if (!(data && data.running) || refCount === 0) return;
        polling = setTimeout(async () => { await refresh(); scheduleNext(); }, 15000);
    }

    // ── actions ──────────────────────────────────────────────────────────
    async function clientsRun() {
        try {
            const r = await fetch('/api/clients/run', { method: 'POST', headers: tokenHeaders() });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) note(d.error || 'refresh failed', 'warn');
        } catch (e) {
            note('refresh failed', 'error');
        }
        await refresh();
        scheduleNext();
    }

    async function postExpire(body, msg) {
        try {
            const r = await fetch('/api/clients/expire', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) { note(d.error || 'failed', 'error'); return; }
            note(msg);
        } catch (e) {
            note('failed', 'error');
        }
        await refresh();
    }
    function clientsExpire(el) {
        const d = el.dataset;
        return postExpire({ key: d.key, refs: d.refs ? d.refs.split('|') : [], client: d.client, title: d.title }, 'expired');
    }
    function clientsRestore(el) { return postExpire({ key: el.dataset.key, undo: true }, 'restored'); }

    function clientsToggle(el) {
        const id = el.dataset.client + '|' + el.dataset.sec;
        if (open.has(id)) open.delete(id); else open.add(id);
        render();
    }
    function clientsQuote(el) {
        const id = 'q|' + el.dataset.key;
        if (open.has(id)) open.delete(id); else open.add(id);
        render();
    }
    function clientsJump(el) {
        const card = document.getElementById('cl-card-' + String(el.dataset.client).replace(/[^\w-]/g, '_'));
        const h = card && card.querySelector('.cl-soon-h');
        if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ── lifecycle ────────────────────────────────────────────────────────
    async function clientsInit() {
        refCount++;
        await refresh();
        scheduleNext();
    }
    function clientsTeardown() {
        refCount = Math.max(0, refCount - 1);
        if (refCount === 0 && polling) { clearTimeout(polling); polling = null; }
    }

    window.clientsInit = clientsInit;
    window.clientsTeardown = clientsTeardown;
    window.clientsRun = clientsRun;
    window.clientsExpire = clientsExpire;
    window.clientsRestore = clientsRestore;
    window.clientsToggle = clientsToggle;
    window.clientsQuote = clientsQuote;
    window.clientsJump = clientsJump;
})();
