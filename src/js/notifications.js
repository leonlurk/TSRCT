// ─────────────────────────────────────────────────────────────────────────
// notifications.js — desktop "Notifs" tab.
//
// A review surface for two streams:
//   1. SECURITY AUDITS — durable weekly-audit history (GET /api/audit/history,
//      parsed from logs/security-audit.log). Survives server restarts.
//      [Run now] triggers an on-demand audit (POST /api/audit/run).
//   2. RECENT ACTIVITY — the live in-app event stream (GET /api/events), the
//      same queue hooks/notify.sh feed. Ephemeral (last 50, wiped on restart),
//      so its dismissals are local-only (localStorage).
//
// The tab badge is kept by a BACKGROUND poll, not by this tab's lifecycle: the
// point is to see that something happened while you are in Terminal.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    let audit = { exists: false, entries: [] };
    let events = [];
    let refCount = 0;
    let polling = null;
    let bgPolling = null;
    let loadError = null;
    let running = false;

    const SEEN_KEY = 'nf-seen-events';
    const EV_DISMISS_KEY = 'nf-dismissed-events';
    const AUDIT_DISMISS_KEY = 'nf-dismissed-audits';

    // "Dismiss" hides, it never destroys. These flags un-hide per section so a
    // security finding can always be brought back — see notifsShowHidden().
    let showAll = { audit: false, events: false };

    function tokenHeaders() { return { Authorization: (typeof token !== 'undefined' ? token : '') || '' }; }
    function jsonHeaders() { return { 'Content-Type': 'application/json', Authorization: (typeof token !== 'undefined' ? token : '') || '' }; }
    function note(msg, type) { if (typeof toast === 'function') toast(msg, type || 'success'); }
    function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }

    // localStorage can throw (private mode, quota). Never let it break the tab.
    function lsGet(key) {
        try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
        catch { return new Set(); }
    }
    function lsSet(key, set) {
        try { localStorage.setItem(key, JSON.stringify(Array.from(set).slice(-500))); }
        catch { /* full or unavailable — dismissals just don't persist */ }
    }

    function timeAgo(ts) {
        // ts may be epoch seconds (events) or an ISO string.
        const now = Date.now();
        const then = (typeof ts === 'number' ? ts * 1000 : Date.parse(ts));
        if (!then || isNaN(then)) return '';
        const s = Math.max(0, Math.round((now - then) / 1000));
        if (s < 60) return s + 's ago';
        const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
        const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
        return Math.round(h / 24) + 'd ago';
    }

    function setBadge(n) {
        const el = document.getElementById('nf-tab-badge');
        if (!el) return;
        if (n > 0) { el.textContent = String(n); el.classList.remove('hidden'); }
        else { el.textContent = ''; el.classList.add('hidden'); }
    }

    async function fetchAll() {
        try {
            const [aR, eR] = await Promise.all([
                fetch('/api/audit/history', { headers: tokenHeaders() }),
                fetch('/api/events?since=0', { headers: tokenHeaders() }),
            ]);
            if (!aR.ok) throw new Error('audit HTTP ' + aR.status);
            if (!eR.ok) throw new Error('events HTTP ' + eR.status);
            audit = await aR.json();
            events = (await eR.json()).events || [];
            loadError = null;
        } catch (e) {
            loadError = e.message || 'load failed';
        }
    }

    // ── rows ─────────────────────────────────────────────────────────────
    function auditRow(e) {
        const cls = e.ok ? 'nf-audit-ok' : 'nf-audit-alert';
        const badge = e.ok ? '[*] CLEAN' : '[!] FINDINGS';
        return (
            '<div class="nf-audit-row ' + cls + '">' +
            '<span class="nf-audit-badge">' + badge + '</span>' +
            '<span class="nf-audit-text">' + esc(e.text) + '</span>' +
            '<span class="nf-audit-ts" title="' + esc(e.ts) + '">' + esc(e.ts) + '</span>' +
            '<button class="nf-x" title="Dismiss (recoverable)" ' +
            'onclick="notifsDismissAudit(\'' + esc(e.ts) + '\')">[x]</button>' +
            '</div>'
        );
    }

    // "N hidden · [show]" / "[hide]" — the promise that dismiss is reversible.
    function hiddenNote(section, count) {
        if (showAll[section]) {
            return '<button class="nf-btn nf-btn-ghost" onclick="notifsShowHidden(\'' + section + '\', false)">[hide dismissed]</button>';
        }
        if (!count) return '';
        return '<span class="nf-muted nf-small">' + count + ' hidden</span>' +
            '<button class="nf-btn nf-btn-ghost" onclick="notifsShowHidden(\'' + section + '\', true)">[show]</button>';
    }

    function eventRow(ev) {
        const title = ev.title || ev.event || ev.type || 'event';
        const body = ev.body || ev.message || '';
        const isAudit = ev.type === 'security_audit';
        return (
            '<div class="nf-ev-row' + (isAudit ? ' nf-ev-audit' : '') + '">' +
            '<div class="nf-ev-head">' +
            '<span class="nf-ev-title">' + esc(title) + '</span>' +
            '<span class="nf-ev-ts">' + esc(timeAgo(ev.timestamp)) + '</span>' +
            '<button class="nf-x" title="Dismiss" onclick="notifsDismissEvent(\'' + esc(ev.id) + '\')">[x]</button>' +
            '</div>' +
            (body ? '<div class="nf-ev-body">' + esc(body) + '</div>' : '') +
            '</div>'
        );
    }

    function render() {
        const body = document.getElementById('pc-notifs-body');
        if (!body) return;
        body.innerHTML = renderAuditCard() + renderEventsCard();
    }

// The weekly security audit: the newest result and the findings he has not dismissed.
function renderAuditCard() {
        let html = '';

        // ── Security Audits ──────────────────────────────────────────────
        const latest = (audit.entries && audit.entries[0]) || null;
        const headline = latest
            ? (latest.ok ? '<span class="nf-ok">[*] Last audit clean</span>'
                         : '<span class="nf-alert">[!] Last audit found issues</span>')
            : '<span class="nf-muted">No audit runs recorded yet</span>';

        const auDismissed = lsGet(AUDIT_DISMISS_KEY);
        const allAudits = audit.entries || [];
        const visibleAudits = showAll.audit ? allAudits : allAudits.filter(e => !auDismissed.has(String(e.ts)));
        const hiddenFindings = allAudits.filter(e => !e.ok && auDismissed.has(String(e.ts))).length;

        html +=
            '<div class="nf-section">' +
            '<div class="nf-section-head">' +
            '<span class="nf-section-title">SECURITY AUDITS</span>' +
            '<span class="nf-section-actions">' + headline +
            hiddenNote('audit', allAudits.length - visibleAudits.length) +
            '<button class="nf-btn" ' + (visibleAudits.length ? '' : 'disabled') +
            ' onclick="notifsClearAudits()">[Clear all]</button>' +
            '<button class="nf-btn" ' + (running ? 'disabled' : '') +
            ' onclick="notifsRunAudit()">' + (running ? 'running…' : '[Run now]') + '</button>' +
            '</span></div>';

        if (loadError) html += '<div class="nf-warn">Load error: ' + esc(loadError) + '</div>';
        // Hiding a CLEAN row is housekeeping; hiding a FINDINGS row hides a real
        // vulnerability, so that one is always called out rather than left silent.
        if (hiddenFindings && !showAll.audit) {
            html += '<div class="nf-warn">' + hiddenFindings + ' dismissed audit run' +
                (hiddenFindings === 1 ? '' : 's') + ' had FINDINGS — hit [show] to review.</div>';
        }

        if (!allAudits.length) {
            html += '<div class="nf-empty">No audit history yet. It runs automatically every Monday, ' +
                'or hit <b>[Run now]</b>. Results are stored in logs/security-audit.log.</div>';
        } else if (!visibleAudits.length) {
            html += '<div class="nf-empty">All audit runs dismissed. Nothing was deleted — ' +
                'logs/security-audit.log still has them, and [show] brings them back.</div>';
        } else {
            html += '<div class="nf-audit-list">' + visibleAudits.map(auditRow).join('') + '</div>';
        }
        html += '</div>';
        return html;
}


// In-app events, minus the ones he dismissed.
function renderEventsCard() {
        let html = '';

        // ── Recent Activity (live event stream) ──────────────────────────
        const evDismissed = lsGet(EV_DISMISS_KEY);
        const visibleEvents = showAll.events ? events : events.filter(e => !evDismissed.has(String(e.id)));
        html +=
            '<div class="nf-section">' +
            '<div class="nf-section-head">' +
            '<span class="nf-section-title">RECENT ACTIVITY</span>' +
            '<span class="nf-section-actions">' +
            '<span class="nf-muted nf-small">live event stream · last 50 · resets on restart</span>' +
            hiddenNote('events', events.length - visibleEvents.length) +
            '<button class="nf-btn" ' + (visibleEvents.length ? '' : 'disabled') +
            ' onclick="notifsClearEvents()">[Clear all]</button>' +
            '</span></div>';

        if (!visibleEvents.length) {
            html += '<div class="nf-empty">No recent events. Hook activity, session events, and audit ' +
                'summaries appear here as they happen.</div>';
        } else {
            html += '<div class="nf-ev-list">' + visibleEvents.map(eventRow).join('') + '</div>';
        }
        html += '</div>';
        return html;
}


    async function refresh() { await fetchAll(); render(); }

    function scheduleNext() {
        if (polling) clearTimeout(polling);
        const interval = running ? 3000 : 12000;
        polling = setTimeout(async () => { if (refCount > 0) { await refresh(); scheduleNext(); } }, interval);
    }

    // ── actions ──────────────────────────────────────────────────────────
    async function notifsRunAudit() {
        if (running) return;
        running = true; render();
        note('running security audit…');
        try {
            const r = await fetch('/api/audit/run', { method: 'POST', headers: jsonHeaders() });
            const d = await r.json();
            if (d.ok) note('audit complete');
            else note('audit exited (code ' + (d.code != null ? d.code : '?') + ')', 'warn');
        } catch (e) {
            note('audit failed to run', 'error');
        } finally {
            running = false;
            await refresh();
            scheduleNext();
        }
    }

    function notifsDismissEvent(id) {
        const d = lsGet(EV_DISMISS_KEY);
        d.add(String(id));
        lsSet(EV_DISMISS_KEY, d);
        render();
    }

    function notifsClearEvents() {
        const d = lsGet(EV_DISMISS_KEY);
        events.forEach(e => d.add(String(e.id)));
        lsSet(EV_DISMISS_KEY, d);
        showAll.events = false;   // show-all ignores the set, so clearing leaves it
        render();
        note('activity cleared');
    }

    function notifsDismissAudit(ts) {
        const d = lsGet(AUDIT_DISMISS_KEY);
        d.add(String(ts));
        lsSet(AUDIT_DISMISS_KEY, d);
        render();
    }

    function notifsClearAudits() {
        const d = lsGet(AUDIT_DISMISS_KEY);
        (audit.entries || []).forEach(e => d.add(String(e.ts)));
        lsSet(AUDIT_DISMISS_KEY, d);
        showAll.audit = false;    // show-all ignores the set, so clearing leaves it
        render();
        note('audit history hidden (not deleted)');
    }

    // Un-hide: a local view toggle, the dismissals stay in localStorage.
    function notifsShowHidden(section, on) {
        showAll[section] = !!on;
        render();
    }

    function notifsClearEverything() {
        notifsClearAudits();
        notifsClearEvents();
        note('all notifications cleared — nothing deleted, use [show] to review');
    }

    // ── background poll (always running, independent of the tab) ─────────
    // The badge counts activity that arrived since the tab was last open.
    async function backgroundCheck() {
        try {
            const r = await fetch('/api/events?since=0', { headers: tokenHeaders() });
            if (!r.ok) return;
            const items = (await r.json()).events || [];
            const seen = lsGet(SEEN_KEY);
            if (refCount > 0) {
                // Tab is open — the user is looking at them, so they are seen.
                items.forEach(i => seen.add(String(i.id)));
                lsSet(SEEN_KEY, seen);
                setBadge(0);
                return;
            }
            const dismissed = lsGet(EV_DISMISS_KEY);
            setBadge(items.filter(i => !seen.has(String(i.id)) && !dismissed.has(String(i.id))).length);
        } catch { /* offline / server down — try again next tick */ }
    }

    function startBackgroundPolling() {
        if (bgPolling) return;
        backgroundCheck();
        bgPolling = setInterval(backgroundCheck, 30000);
    }

    // ── lifecycle ────────────────────────────────────────────────────────
    async function notifsInit() {
        refCount++;
        await refresh();
        // Opening the tab counts as seeing everything currently listed.
        const seen = lsGet(SEEN_KEY);
        events.forEach(i => seen.add(String(i.id)));
        lsSet(SEEN_KEY, seen);
        setBadge(0);
        scheduleNext();
    }
    function notifsTeardown() {
        refCount = Math.max(0, refCount - 1);
        if (refCount === 0 && polling) { clearTimeout(polling); polling = null; }
    }

    window.notifsInit = notifsInit;
    window.notifsTeardown = notifsTeardown;
    window.notifsRunAudit = notifsRunAudit;
    window.notifsDismissEvent = notifsDismissEvent;
    window.notifsClearEvents = notifsClearEvents;
    window.notifsDismissAudit = notifsDismissAudit;
    window.notifsClearAudits = notifsClearAudits;
    window.notifsShowHidden = notifsShowHidden;
    window.notifsClearEverything = notifsClearEverything;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startBackgroundPolling);
    } else {
        startBackgroundPolling();
    }
})();
