// ─────────────────────────────────────────────────────────────────────────
// notifications.js — desktop "Notifs" tab.
//
// A review surface for three streams:
//   1. SYFTEN MENTIONS — competitor/keyword mentions from Syften (GET
//      /api/syften/items). DURABLE: the server keeps them in
//      data/syften-items.json, so a restart does not lose a mention.
//      Each row links straight to the post. [x] dismisses one, [Clear all]
//      dismisses every visible one (server-side, so it sticks).
//   2. SECURITY AUDITS — durable weekly-audit history (GET /api/audit/history,
//      parsed from logs/security-audit.log). Survives server restarts.
//      [Run now] triggers an on-demand audit (POST /api/audit/run).
//   3. RECENT ACTIVITY — the live in-app event stream (GET /api/events), the
//      same queue hooks/notify.sh feed. Ephemeral (last 50, wiped on restart),
//      so its dismissals are local-only (localStorage).
//
// The Syften poll runs in the BACKGROUND, not on this tab's lifecycle: the
// whole point is to hear a new mention while you are in Terminal. The tab
// only draws. Sound + tab badge come from startBackgroundPolling().
//
// No ntfy — this is the in-app window into events that previously had no UI.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    let audit = { exists: false, entries: [] };
    let events = [];
    let syften = { items: [], lastError: null, configured: false };
    // The once-a-day read: threads actually opened and judged. Separate from the
    // raw mention feed above it, because these two answer different questions —
    // "what matched" vs "what is worth answering".
    let daily = { leads: [], latest: null, lastRun: null, running: false, scheduledHour: null, progress: null };
    // The software factory: its research days and, while one runs, the live
    // line. Optional like Syften — a missing factory must not blank the tab.
    let factory = null;
    // The PV card-testing watch (lib/shopWatch.js). Optional too.
    let shop = null;
    let refCount = 0;
    let polling = null;
    // Separate from `polling` because it is not a fetch: it only repaints the
    // elapsed clock. Re-rendering the whole tab once a second to move a timer
    // would throw the scroll position and the [why?] toggle away every second.
    let liveTimer = null;
    let bgPolling = null;
    let loadError = null;
    let running = false;
    let audioCtx = null;

    const SEEN_KEY = 'nf-syften-seen';
    const EV_DISMISS_KEY = 'nf-dismissed-events';
    const AUDIT_DISMISS_KEY = 'nf-dismissed-audits';

    // "Dismiss" hides, it never destroys. These flags un-hide per section so a
    // security finding can always be brought back — see notifsShowHidden().
    let showAll = { syften: false, audit: false, events: false, daily: false };

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
        // ts may be epoch seconds (events) or an ISO string (Syften).
        const now = Date.now();
        const then = (typeof ts === 'number' ? ts * 1000 : Date.parse(ts));
        if (!then || isNaN(then)) return '';
        const s = Math.max(0, Math.round((now - then) / 1000));
        if (s < 60) return s + 's ago';
        const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
        const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
        return Math.round(h / 24) + 'd ago';
    }

    // Two-note bell chime (G5 → C6), same voice the Dispatcher uses so a new
    // mention sounds like the rest of the system rather than a second alarm.
    function playMentionChime() {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch { return; }
        const ctx = audioCtx;
        if (!ctx) return;
        if (ctx.state === 'suspended') { try { ctx.resume(); } catch { /* needs a gesture */ } }
        const now = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.setValueAtTime(0.0001, now);
        master.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
        master.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
        master.connect(ctx.destination);
        [{ freq: 783.99, delay: 0.00, dur: 0.9 },
         { freq: 1046.5, delay: 0.08, dur: 1.0 }].forEach(n => {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(n.freq, now + n.delay);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, now + n.delay);
            g.gain.exponentialRampToValueAtTime(0.7, now + n.delay + 0.015);
            g.gain.exponentialRampToValueAtTime(0.0001, now + n.delay + n.dur);
            osc.connect(g).connect(master);
            osc.start(now + n.delay);
            osc.stop(now + n.delay + n.dur + 0.05);
        });
    }

    function setBadge(n) {
        const el = document.getElementById('nf-tab-badge');
        if (!el) return;
        if (n > 0) { el.textContent = String(n); el.classList.remove('hidden'); }
        else { el.textContent = ''; el.classList.add('hidden'); }
    }

    async function fetchAll() {
        try {
            const [aR, eR, sR, dR, fR, pR] = await Promise.all([
                fetch('/api/audit/history', { headers: tokenHeaders() }),
                fetch('/api/events?since=0', { headers: tokenHeaders() }),
                fetch('/api/syften/items' + (showAll.syften ? '?all=1' : ''), { headers: tokenHeaders() }),
                fetch('/api/syften/daily', { headers: tokenHeaders() }),
                fetch('/api/factory/state', { headers: tokenHeaders() }).catch(() => null),
                fetch('/api/shopwatch/state', { headers: tokenHeaders() }).catch(() => null),
            ]);
            if (!aR.ok) throw new Error('audit HTTP ' + aR.status);
            if (!eR.ok) throw new Error('events HTTP ' + eR.status);
            audit = await aR.json();
            events = (await eR.json()).events || [];
            // Syften is optional: a failure here must not blank the whole tab.
            if (sR.ok) syften = await sR.json();
            if (dR.ok) daily = await dR.json();
            if (fR && fR.ok) factory = await fR.json();
            if (pR && pR.ok) shop = await pR.json();
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
            return '<button class="nf-btn nf-btn-ghost" onclick="notifsShowHidden(\'' + section + '\', false)">[hide dismissed]</button>' +
                (section === 'syften'
                    ? '<button class="nf-btn nf-btn-ghost" onclick="notifsRestoreSyften()">[restore all]</button>'
                    : '');
        }
        if (!count) return '';
        return '<span class="nf-muted nf-small">' + count + ' hidden</span>' +
            '<button class="nf-btn nf-btn-ghost" onclick="notifsShowHidden(\'' + section + '\', true)">[show]</button>';
    }

    function syftenRow(m) {
        const where = esc(m.backend) + (m.community ? ' · ' + esc(m.community) : '');
        const link = m.url
            ? '<a class="nf-sy-link" href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer">' + esc(m.title) + '</a>'
            : '<span class="nf-sy-title">' + esc(m.title) + '</span>';
        return (
            '<div class="nf-sy-row">' +
            '<div class="nf-sy-head">' +
            '<span class="nf-sy-where">' + where + '</span>' +
            (m.filter ? '<span class="nf-sy-filter">' + esc(m.filter) + '</span>' : '') +
            '<span class="nf-sy-ts">' + esc(timeAgo(m.ts)) + '</span>' +
            '<button class="nf-x" title="Dismiss" onclick="notifsDismissSyften(\'' + esc(m.id) + '\')">[x]</button>' +
            '</div>' +
            '<div class="nf-sy-title-line">' + link + '</div>' +
            (m.text ? '<div class="nf-sy-body">' + esc(m.text) + '</div>' : '') +
            (m.author ? '<div class="nf-sy-meta">' + esc(m.type || 'post') + ' by ' + esc(m.author) + '</div>' : '') +
            '</div>'
        );
    }

    function fmtDur(sec) {
        if (!isFinite(sec)) return '';          // a missing timestamp prints nothing, never "NaNs"
        const s = Math.max(0, Math.round(sec));
        if (sec > 0 && s === 0) return 'under a second';
        if (s < 60) return s + 's';
        return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
    }

    // The live block: what the run is doing RIGHT NOW.
    //
    // Built because on 2026-09-02 a run finished in 20 milliseconds — there was
    // nothing new to read — and looked exactly like a run that had hung. Every
    // number in here is measured: the count comes from the reader as each page
    // finishes, and the "left" figure is the average of the pages already read,
    // so before the first one comes back it says "still measuring" instead of
    // guessing.
    function dailyLive() {
        const p = daily.progress;
        if (!p) return '';
        const total = p.total || 0;
        const done = p.done || 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const reading = p.phase === 'reading' && total;

        let sub = '';
        if (reading) {
            sub = p.etaSec != null
                ? 'about ' + fmtDur(p.etaSec) + ' left'
                : 'still measuring how long a page takes';
            sub += ' · 6s between pages, deliberately';
        } else if (p.phase === 'thinking') {
            sub = 'usually under a minute, sometimes a few';
        }

        return (
            '<div class="nf-dy-live">' +
            '<div class="nf-dy-live-head">' +
            '<span class="nf-dy-dot"></span>' +
            '<span class="nf-dy-live-text">' + esc(p.text || 'working') + '</span>' +
            '<span class="nf-dy-live-time" id="nf-dy-elapsed" data-since="' +
            esc(p.startedAt || '') + '">' + fmtDur((Date.now() - Date.parse(p.startedAt)) / 1000) + '</span>' +
            '</div>' +
            '<div class="nf-dy-bar' + (reading ? '' : ' nf-dy-bar-idle') + '">' +
            (reading ? '<i style="width:' + pct + '%"></i>' : '<i></i>') + '</div>' +
            (sub ? '<div class="nf-dy-live-sub">' + esc(sub) + '</div>' : '') +
            (p.url ? '<div class="nf-dy-live-url">' + esc(p.url) + '</div>' : '') +
            '</div>'
        );
    }

    // Moves the clock without repainting the tab. Reads the start time off the
    // element itself, so it keeps working across a re-render that replaced it.
    function tickLive() {
        const el = document.getElementById('nf-dy-elapsed');
        if (!el) return;
        const since = Date.parse(el.getAttribute('data-since') || '');
        if (!since || isNaN(since)) return;
        el.textContent = fmtDur((Date.now() - since) / 1000);
    }

    // One judged thread. The VERDICT and the reason lead, because the whole
    // point is to save Leon the click — a row he has to open to evaluate has
    // saved him nothing.
    function dailyRow(l) {
        const yes = l.verdict === 'yes';
        const brand = l.brand && l.brand !== 'none' ? l.brand : '';
        return (
            '<div class="nf-dy-row' + (yes ? ' nf-dy-yes' : '') + '">' +
            '<div class="nf-sy-head">' +
            '<span class="nf-dy-verdict">' + (yes ? '[>] WORTH IT' : '[-] skip') + '</span>' +
            (brand ? '<span class="nf-dy-brand">' + esc(brand) + '</span>' : '') +
            '<span class="nf-sy-where">' + esc(l.room || '') + '</span>' +
            '<span class="nf-sy-ts">' + (l.comments || 0) + ' comments' +
            (l.ageHours == null ? '' : ' · ' + l.ageHours + 'h old') + '</span>' +
            '</div>' +
            // A rejected thread gets a PLAIN title and a small [open]. Giving a
            // skip the same big underlined link as a recommendation is what made
            // Leon open two threads the system had already told him to skip —
            // one of them deleted. The loudest thing in a row is read as its
            // instruction, whatever the label says.
            '<div class="nf-sy-title-line">' +
            (yes
                ? '<a class="nf-sy-link" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' +
                  esc(l.title || l.url) + '</a>'
                : '<span class="nf-dy-skip-title">' + esc(l.title || l.url) + '</span>' +
                  ' <a class="nf-dy-open" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">[open anyway]</a>') +
            '</div>' +
            (l.why ? '<div class="nf-sy-body">' + esc(l.why) + '</div>' : '') +
            (l.angle ? '<div class="nf-dy-angle">what you can say: ' + esc(l.angle) + '</div>' : '') +
            '</div>'
        );
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

        let html = '';
        html += renderShopCard();
        html += renderDailyCard();
        html += renderFactoryCard();
        html += renderMentionsCard();
        html += renderAuditCard();
        html += renderEventsCard();

        body.innerHTML = html;
    }

// PV card-testing watch: what the shop watch saw last.
function renderShopCard() {
        let html = '';

        // ── PV card testing (lib/shopWatch.js) ───────────────────────────
        // First on the tab: a live attack costs money by the hour, a mention
        // does not. A failed check is shown as failed, never as "quiet".
        if (shop) {
            const hist = shop.history || [];
            html +=
                '<div class="nf-section">' +
                '<div class="nf-section-head">' +
                '<span class="nf-section-title">PV CARD TESTING</span>' +
                '<span class="nf-section-actions">' +
                '<span class="nf-muted nf-small">' +
                (shop.on ? 'checks every ' + esc(shop.every) : 'paused (Automations tab)') +
                (shop.lastRun ? ' · last ' + timeAgo(shop.lastRun) : ' · not run yet') +
                '</span>' +
                '<button class="nf-btn" ' + (shop.running ? 'disabled' : '') +
                ' onclick="notifsRunShop()">' + (shop.running ? '[checking…]' : '[Check now]') + '</button>' +
                '</span></div>';
            if (shop.lastError) html += '<div class="nf-warn">Not checking: ' + esc(shop.lastError) + '</div>';
            else if (shop.lastSummary) html += '<div class="nf-dy-none">' + esc(shop.lastSummary) + '</div>';
            if (hist.length) {
                html += '<div class="nf-ev-list">' + hist.slice(0, 5).map(h =>
                    '<div class="nf-ev-row nf-ev-audit"><div class="nf-ev-head">' +
                    '<span class="nf-ev-title">[!] ' + esc(h.why) + '</span>' +
                    '<span class="nf-ev-ts">' + esc(timeAgo(h.at)) + '</span></div></div>').join('') + '</div>';
            }
            html += '</div>';
        }
        return html;
}


// The daily mentions read: leads it kept and skipped, and how the last run went.
function renderDailyCard() {
        let html = '';

        // ── Worth answering (the daily read) ─────────────────────────────
        const leads = daily.leads || [];
        const yesLeads = leads.filter(l => l.verdict === 'yes');
        const skipLeads = leads.filter(l => l.verdict !== 'yes');
        const lastR = daily.latest || {};
        html +=
            '<div class="nf-section">' +
            '<div class="nf-section-head">' +
            '<span class="nf-section-title">WORTH ANSWERING</span>' +
            '<span class="nf-section-actions">' +
            '<span class="nf-muted nf-small">' +
            (daily.lastRun
                ? (lastR.read || 0) + ' read · ' + timeAgo(daily.lastRun)
                : 'never run') +
            (daily.scheduledHour == null ? ' · not scheduled'
                : ' · daily at ' + String(daily.scheduledHour).padStart(2, '0') + ':00') +
            '</span>' +
            '<button class="nf-btn" ' + (daily.running ? 'disabled' : '') +
            ' onclick="notifsRunDaily()">' + (daily.running ? '[running…]' : '[Run now]') + '</button>' +
            '</span></div>';
        // Above everything else: a run in flight is the answer to the only
        // question being asked while it runs.
        html += dailyLive();
        if (lastR.halted) html += '<div class="nf-warn">Halted: ' + esc(lastR.halted) + '</div>';
        if (lastR.claudeErr) html += '<div class="nf-warn">Claude: ' + esc(lastR.claudeErr) + '</div>';

        if (!daily.lastRun) {
            html += '<div class="nf-empty">Opens the threads Syften delivered, reads them, and asks ' +
                'Claude which are worth a reply. Nothing is ever posted — you write.</div>';
        } else {
            // The verdict of the DAY leads, in words, before any row. A list of
            // rejected threads under a heading that says WORTH ANSWERING reads
            // as a list of recommendations no matter how the rows are styled.
            if (yesLeads.length) {
                html += '<div class="nf-sy-list">' + yesLeads.map(dailyRow).join('') + '</div>';
            } else if (!lastR.read && lastR.note) {
                // A run that opened NOTHING is a different sentence from a run
                // that read six threads and liked none. Saying "0 thread(s)
                // read, all skipped" for both is how a working day looks broken:
                // the run on 2026-09-02 took 20ms because there was nothing new,
                // and the panel gave no way to know that.
                html += '<div class="nf-dy-none">Nothing opened — ' + esc(lastR.note) + '. ' +
                    'The run finished in ' +
                    fmtDur((Date.parse(lastR.finished) - Date.parse(lastR.started)) / 1000) +
                    '; there was nothing to read.</div>';
            } else {
                html += '<div class="nf-dy-none">Nothing worth answering. ' +
                    (lastR.read || 0) + ' thread(s) read, all skipped — saying no is the useful answer.</div>';
            }
            // Rejects are auditable, not on display. A shortlist you cannot check
            // is one you stop trusting; a shortlist that shows its rejects at full
            // volume is one you misread.
            if (skipLeads.length) {
                html += '<div class="nf-section-actions nf-dy-skipbar">' +
                    '<span class="nf-muted nf-small">' + skipLeads.length + ' skipped</span>' +
                    '<button class="nf-btn nf-btn-ghost" onclick="notifsShowHidden(\'daily\', ' +
                    (showAll.daily ? 'false' : 'true') + ')">' +
                    (showAll.daily ? '[hide skipped]' : '[why?]') + '</button></div>';
                if (showAll.daily) {
                    html += '<div class="nf-sy-list">' + skipLeads.map(dailyRow).join('') + '</div>';
                }
            }
            if (lastR.droppedAsDead) {
                html += '<div class="nf-muted nf-small">' + lastR.droppedAsDead +
                    ' dropped before reading (bad room, job ad or cross-post campaign)' +
                    (lastR.unreadable ? ' · ' + lastR.unreadable + ' could not be read' : '') + '</div>';
            }
        }
        html += '</div>';
        return html;
}


// The factory watcher card.
function renderFactoryCard() {
        let html = '';

        // ── Factory (the software factory's research days) ───────────────
        // One line while a run is live, then one row per research day. The
        // events themselves (run started, finding written, run finished, new
        // candidates pulled) also land in RECENT ACTIVITY below.
        if (factory) {
            const live = factory.live || null;
            const active = !!factory.liveActive || !!(factory.localRun && factory.localRun.active);
            const runs = factory.runs || [];
            html +=
                '<div class="nf-section">' +
                '<div class="nf-section-head">' +
                '<span class="nf-section-title">FACTORY</span>' +
                '<span class="nf-section-actions">' +
                '<span class="nf-muted nf-small">' +
                (factory.available
                    ? runs.length + ' research day' + (runs.length === 1 ? '' : 's') +
                      (factory.routine && factory.routine.human ? ' · ' + esc(factory.routine.human) : '')
                    : 'factory not found') +
                '</span>' +
                '<button class="nf-btn" onclick="window.pcSwitchTab && pcSwitchTab(\'factory\')">[Open tab]</button>' +
                '</span></div>';
            if (active && live) {
                const a = live.apps || {};
                html += '<div class="nf-dy-live"><div class="nf-dy-live-head"><span class="nf-dy-dot"></span>' +
                    '<span class="nf-dy-live-text">' + esc(live.phase || 'working') + ' · ' + esc(live.category || '') +
                    (a.total ? ' · app ' + (a.done || 0) + ' of ' + a.total : '') +
                    ' · ' + (live.quotesKept || 0) + ' quotes kept</span></div>' +
                    (a.currentUrl ? '<div class="nf-dy-live-url">' + esc(a.currentUrl) + '</div>' : '') +
                    '</div>';
            }
            if (factory.lastError) html += '<div class="nf-warn">Factory: ' + esc(factory.lastError) + '</div>';
            if (!runs.length) {
                html += '<div class="nf-empty">No research days yet. The cloud researcher reads a shelf of ' +
                    'paid-app reviews every morning; each day lands here as one row.</div>';
            } else {
                html += '<div class="nf-ev-list">' + runs.slice(0, 7).map(r =>
                    '<div class="nf-ev-row' + (r.worth ? ' nf-ev-audit' : '') + '">' +
                    '<div class="nf-ev-head"><span class="nf-ev-title">' + esc(r.date) + ' · ' + esc(r.category || '?') +
                    ' · ' + (r.findings || 0) + ' finding' + (r.findings === 1 ? '' : 's') +
                    (r.worth ? ' · ' + r.worth + ' WORTH BUILDING' : '') + '</span>' +
                    '<span class="nf-ev-ts">' + (r.apps || 0) + ' apps read</span></div>' +
                    (r.note ? '<div class="nf-ev-body">' + esc(r.note) + '</div>' : '') +
                    '</div>').join('') + '</div>';
            }
            html += '</div>';
        }
        return html;
}


// Syften mentions: the live Reddit/forum feed.
function renderMentionsCard() {
        let html = '';

        // ── Syften mentions ──────────────────────────────────────────────
        const mentions = syften.items || [];
        html +=
            '<div class="nf-section">' +
            '<div class="nf-section-head">' +
            '<span class="nf-section-title">SYFTEN MENTIONS</span>' +
            '<span class="nf-section-actions">' +
            '<span class="nf-muted nf-small">' +
            (syften.configured
                // In show-all mode these rows are NOT open — saying "open" here is
                // what made a working Clear all look broken.
                ? mentions.length + (showAll.syften ? ' shown (dismissed included)' : ' open') + ' · polls every 60s'
                : 'SYFTEN_TOKEN not set in .env') +
            '</span>' +
            hiddenNote('syften', syften.hidden || 0) +
            '<button class="nf-btn" ' + (mentions.length ? '' : 'disabled') +
            ' onclick="notifsClearSyften()">[Clear all]</button>' +
            '</span></div>';
        if (syften.lastError) html += '<div class="nf-warn">Syften: ' + esc(syften.lastError) + '</div>';
        if (!mentions.length) {
            html += '<div class="nf-empty">No open mentions. New keyword hits land here with a chime ' +
                'and a link straight to the post.</div>';
        } else {
            html += '<div class="nf-sy-list">' + mentions.map(syftenRow).join('') + '</div>';
        }
        html += '</div>';
        return html;
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
        // A daily run moves roughly once every six seconds, so 12s of polling
        // would show a stale count more often than a fresh one.
        const interval = (running || daily.running) ? 3000 : 12000;
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

    // Same endpoint the Automations card's [run] uses; the check takes ~5s.
    async function notifsRunShop() {
        try {
            const r = await fetch('/api/automations/run', { method: 'POST', headers: jsonHeaders(),
                body: JSON.stringify({ id: 'pv-card-watch' }) });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            if (shop) shop.running = true;
            render();
            note('Checking the store', 'success');
            setTimeout(async () => { await fetchAll(); render(); }, 8000);
        } catch (e) { note('Could not start: ' + e.message, 'error'); }
    }

    async function notifsRunDaily() {
        // The server answers 202 immediately and works in the background: this
        // opens ~25 pages six seconds apart and then waits on Claude, which is
        // minutes. Nothing here blocks on that.
        try {
            const r = await fetch('/api/syften/daily/run', { method: 'POST', headers: jsonHeaders() });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            daily.running = true;
            // A placeholder so the block appears on the click rather than on
            // the next poll — three seconds of nothing is exactly the gap that
            // made a started run look like a dead button.
            daily.progress = { phase: 'picking', startedAt: new Date().toISOString(),
                text: 'sorting what Syften brought in' };
            render();
            scheduleNext();          // straight to the 3s cadence
            note('Reading the threads — watch the bar', 'success');
        } catch (e) { note('Could not start: ' + e.message, 'error'); }
    }

    async function notifsDismissSyften(id) {
        // Optimistic: drop the row now, then persist. A failed write reappears
        // on the next refresh rather than silently pretending it was dismissed.
        syften.items = (syften.items || []).filter(i => i.id !== id);
        render();
        try {
            await fetch('/api/syften/dismiss', {
                method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ id }),
            });
        } catch { note('dismiss failed to save', 'warn'); await refresh(); }
    }

    async function notifsClearSyften() {
        const n = (syften.items || []).length;
        // Clearing while "show dismissed" is on used to look like a no-op: the
        // next refresh asked for ?all=1 and every row it had just dismissed came
        // straight back. Clearing always drops the view back to open-only.
        showAll.syften = false;
        syften.items = [];
        render();
        try {
            await fetch('/api/syften/clear', { method: 'POST', headers: jsonHeaders() });
            note('cleared ' + n + ' mention' + (n === 1 ? '' : 's'));
        } catch { note('clear failed to save', 'warn'); await refresh(); }
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
        showAll.events = false;   // same trap as Syften: show-all ignores the set
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
        showAll.audit = false;    // same trap as Syften: show-all ignores the set
        render();
        note('audit history hidden (not deleted)');
    }

    // Un-hide. For Syften the dismissals live on the server, so showing them
    // again is a real restore; for the other two it is a local view toggle.
    async function notifsShowHidden(section, on) {
        showAll[section] = !!on;
        if (section === 'syften' && !on) {
            // Leaving "show all" re-applies whatever is still dismissed.
            await refresh(); return;
        }
        if (section === 'syften' && on) { await refresh(); return; }
        render();
    }

    async function notifsRestoreSyften() {
        try {
            await fetch('/api/syften/restore', { method: 'POST', headers: jsonHeaders() });
            showAll.syften = false;
            await refresh();
            note('mentions restored');
        } catch { note('restore failed', 'warn'); }
    }

    async function notifsClearEverything() {
        notifsClearAudits();
        notifsClearEvents();
        await notifsClearSyften();
        note('all notifications cleared — nothing deleted, use [show] to review');
    }

    // ── background poll (always running, independent of the tab) ─────────
    // This is what makes a mention audible while you are in Terminal.
    async function backgroundCheck() {
        try {
            const r = await fetch('/api/syften/items', { headers: tokenHeaders() });
            if (!r.ok) return;
            const d = await r.json();
            const items = d.items || [];
            const seen = lsGet(SEEN_KEY);
            const fresh = items.filter(i => !seen.has(i.id));

            if (refCount > 0) {
                // Tab is open — the user is looking at them, so they are seen.
                items.forEach(i => seen.add(i.id));
                lsSet(SEEN_KEY, seen);
                setBadge(0);
                return;
            }
            if (fresh.length) {
                playMentionChime();
                fresh.forEach(i => seen.add(i.id));
                lsSet(SEEN_KEY, seen);
            }
            // Badge shows everything still open, not just this batch.
            setBadge(items.length);
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
        // Opening the tab counts as seeing everything currently open.
        const seen = lsGet(SEEN_KEY);
        (syften.items || []).forEach(i => seen.add(i.id));
        lsSet(SEEN_KEY, seen);
        setBadge(0);
        scheduleNext();
        if (!liveTimer) liveTimer = setInterval(tickLive, 1000);
    }
    function notifsTeardown() {
        refCount = Math.max(0, refCount - 1);
        if (refCount === 0 && polling) { clearTimeout(polling); polling = null; }
        if (refCount === 0 && liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    }

    window.notifsInit = notifsInit;
    window.notifsTeardown = notifsTeardown;
    window.notifsRunAudit = notifsRunAudit;
    window.notifsRunDaily = notifsRunDaily;
    window.notifsRunShop = notifsRunShop;
    window.notifsDismissSyften = notifsDismissSyften;
    window.notifsClearSyften = notifsClearSyften;
    window.notifsDismissEvent = notifsDismissEvent;
    window.notifsClearEvents = notifsClearEvents;
    window.notifsDismissAudit = notifsDismissAudit;
    window.notifsClearAudits = notifsClearAudits;
    window.notifsShowHidden = notifsShowHidden;
    window.notifsRestoreSyften = notifsRestoreSyften;
    window.notifsClearEverything = notifsClearEverything;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startBackgroundPolling);
    } else {
        startBackgroundPolling();
    }
})();
