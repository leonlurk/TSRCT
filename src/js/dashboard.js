// Productivity Dashboard — desktop "Tasks" tab with three sub-views:
//   Tasks    (Increment 1) — ClickUp assigned tasks + on-demand completion analysis
//   Worklogs (Increment 2) — generate worklog proposals -> edit -> create in ClickUp
//   Digest   (Increment 3) — vault digest feed + meeting-note routing
// Desktop-only; renders into #pc-dashboard-list (.dash-target). Modeled on cockpit.js
// (IIFE + init/teardown/poll/render + window exports). The cc-tsrct-analyst session
// does all reasoning; the server does all deterministic ClickUp writes.

(function () {
    'use strict';

    let dashView = 'inbox';          // inbox | tasks | worklogs | digest
    let dashPolling = null;
    let dashRefCount = 0;

    // Per-view data caches
    let inbox = { items: [], counts: {}, token_configured: false };
    // Noise groups start collapsed; the action-needed groups start open.
    let inboxCollapsed = { mention: false, comment: false, due: false, assigned: true, status: true };
    let tasks = [], tokenConfigured = false;
    let sessionList = [];          // live tmux sessions (for the task->session mapper)
    let analystActivity = null;    // { running, key, kind, steps } — live feed while analyzing
    let selectedTaskIds = new Set(); // multi-select for bulk session mapping
    let taskGroupCollapsed = {};   // session name -> collapsed?
    let wlState = { batch_id: null, generating: false, error: null, proposals: [] };
    // Generator form survives the 7s re-render (it used to snap back to today/empty).
    let wlForm = null;               // { start, end, hint }
    // Active ClickUp lists for the "create a task" picker. Loaded once per open of the
    // view; null = not asked yet, [] = asked and got nothing.
    let wlLists = null;
    // HOURS RECALL panel — all view state lives here so the poll re-render keeps it.
    let hrs = { scan: null, ai: null };
    let hrsOpen = false;
    let hrsExpanded = {};            // date -> open?
    let hrsOff = {};                 // `${date}|${project}` -> excluded? (overrides the personal default)
    let hrsPick = {};                // date -> hours Leon typed
    let hrsRestricted = {};               // date -> SecretCo hours typed by hand (never scanned)
    let hrsNote = '';
    let digest = null, notes = [];
    // ClickUp token config (never holds the token itself — only the masked
    // fingerprint the server reports, plus the result of the last save).
    let cfg = null;            // { token_configured, token_source, token_masked, env_override_present, user_id, workspace_name }
    let cfgOpen = false;       // token panel expanded?
    let cfgResult = null;      // { ok, message, user, worklog_team, workspaces, warnings }

    function tokenHeaders() { return { Authorization: token || '' }; }
    function jsonHeaders() { return { ...tokenHeaders(), 'Content-Type': 'application/json' }; }

    function fmtAge(ts) {
        if (!ts) return '';
        const mins = Math.round((Date.now() - ts) / 60000);
        if (mins < 1) return 'now';
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        if (h < 24) return `${h}h`;
        return `${Math.floor(h / 24)}d`;
    }

    // Don't clobber an input/textarea/select the user is actively editing.
    function editingActive() {
        const ae = document.activeElement;
        if (!ae || !ae.closest || !ae.closest('.dash-target')) return false;
        // Only guard TEXT entry from being clobbered mid-edit. A <select>, checkbox,
        // radio or button is NOT text entry — counting them blocked the re-render, so
        // a session mapping (select) and a multi-select (checkbox) looked like they
        // "did nothing" until the next unrelated render.
        if (ae.tagName === 'TEXTAREA') return true;
        if (ae.tagName === 'INPUT') {
            const t = (ae.type || 'text').toLowerCase();
            return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(t);
        }
        return false;
    }

    // ─── Fetch (active view only) ───────────────────────────────────────────
    async function fetchActive() {
        try {
            if (dashView === 'inbox') {
                const r = await fetch('/api/dispatcher/clickup/inbox', { headers: tokenHeaders() });
                inbox = await r.json();
            } else if (dashView === 'tasks') {
                const [rt, rs] = await Promise.all([
                    fetch('/api/dispatcher/clickup/tasks', { headers: tokenHeaders() }),
                    fetch('/api/sessions', { headers: tokenHeaders() }),
                ]);
                const d = await rt.json();
                tasks = d.tasks || []; tokenConfigured = !!d.token_configured;
                try { sessionList = ((await rs.json()).sessions || []).map(s => s.name).filter(n => !n.startsWith('run-')); } catch { sessionList = []; }
                // Only poll the live activity feed while something is actually analyzing.
                if (tasks.some(t => t.analyzing)) {
                    try { analystActivity = await (await fetch('/api/dispatcher/clickup/analyst-activity', { headers: tokenHeaders() })).json(); } catch { analystActivity = null; }
                } else { analystActivity = null; }
            } else if (dashView === 'worklogs') {
                const [rw] = await Promise.all([
                    fetch('/api/dispatcher/worklogs', { headers: tokenHeaders() }),
                    fetchConfig(),   // worklogs are what the token actually writes — keep it visible here
                ]);
                wlState = await rw.json();
                if (wlLists === null && (wlState.proposals || []).some(x => x.new_task_json)) {
                    wlLists = [];
                    try { wlLists = (await (await fetch('/api/dispatcher/clickup/lists', { headers: tokenHeaders() })).json()).lists || []; } catch {}
                }
                if (hrsOpen) {
                    try { hrs = await (await fetch('/api/dispatcher/hours', { headers: tokenHeaders() })).json(); } catch {}
                }
            } else if (dashView === 'digest') {
                const [rd, rn] = await Promise.all([
                    fetch('/api/dispatcher/digest', { headers: tokenHeaders() }),
                    fetch('/api/dispatcher/notes', { headers: tokenHeaders() }),
                ]);
                digest = (await rd.json()).digest || null;
                notes = (await rn.json()).notes || [];
            }
        } catch (e) { console.error('[dashboard] fetch failed', e); }
    }

    // GET the token config (server-side only: never returns the token itself).
    async function fetchConfig() {
        try { cfg = await (await fetch('/api/dispatcher/clickup/config', { headers: tokenHeaders() })).json(); }
        catch (e) { console.error('[dashboard] config fetch failed', e); }
    }

    // ─── Nav ────────────────────────────────────────────────────────────────
    function renderNav() {
        const unread = (inbox.counts && inbox.counts.unread) || 0;
        const badge = unread ? ` <span class="dash-nav-badge">${unread}</span>` : '';
        const tab = (id, label) => `<button class="btn dash-btn dash-nav-btn ${dashView === id ? 'active' : ''}" onclick="dashSwitchView('${id}')">${label}</button>`;
        return `<div class="dash-nav">${tab('inbox', '[I] Inbox' + badge)}${tab('tasks', '[T] Tasks')}${tab('worklogs', '[W] Worklogs')}${tab('digest', '[D] Digest')}</div>`;
    }

    // ─── Inbox view ("where I stand") ───────────────────────────────────────
    const INBOX_GROUPS = [
        { kind: 'mention',  label: 'MENTIONS',         icon: '[@]' },
        { kind: 'due',      label: 'DUE / OVERDUE',    icon: '[!]' },  // due + overdue
        { kind: 'comment',  label: 'NEW COMMENTS',     icon: '[c]' },
        { kind: 'assigned', label: 'NEW ASSIGNMENTS',  icon: '[+]' },
        { kind: 'status',   label: 'STATUS CHANGES',   icon: '[>]' },
    ];
    function inboxKindMatch(group, it) {
        if (group === 'due') return it.kind === 'due' || it.kind === 'overdue';
        return it.kind === group;
    }
    function renderInboxRow(it) {
        const icon = it.kind === 'overdue' ? '[!]'
            : it.kind === 'due' ? '[~]'
            : it.kind === 'mention' ? '[@]'
            : it.kind === 'comment' ? '[c]'
            : it.kind === 'assigned' ? '[+]'
            : it.kind === 'status' ? '[>]' : '[*]';
        const name = it.url
            ? `<a class="dash-ib-name" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">${escapeHtml(it.task_name || '(untitled)')}</a>`
            : `<span class="dash-ib-name">${escapeHtml(it.task_name || '(untitled)')}</span>`;
        const meta = [];
        if (it.actor) meta.push(escapeHtml(it.actor));
        if (it.project) meta.push(escapeHtml(it.project));
        if (it.priority) meta.push(escapeHtml(it.priority));
        const snippet = it.snippet ? `<div class="dash-ib-snippet">${escapeHtml(it.snippet)}</div>` : '';
        return `<div class="dash-ib-row dash-ib-${escapeHtml(it.kind)}" data-key="${escapeHtml(it.item_key)}">
            <span class="dash-ib-icon">${icon}</span>
            <div class="dash-ib-body">
                <div class="dash-ib-line">${name}<span class="dash-ib-age">${fmtAge(it.ts)}</span></div>
                ${meta.length ? `<div class="dash-ib-meta">${meta.join(' · ')}</div>` : ''}
                ${snippet}
            </div>
            <div class="dash-ib-actions">
                ${it.url ? `<a class="btn dash-btn dash-btn-mini" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">[open]</a>` : ''}
                <button class="btn dash-btn dash-btn-mini" onclick="dashInboxSeen('${encodeURIComponent(it.item_key)}', this)">[seen]</button>
            </div>
        </div>`;
    }
    function renderInboxView() {
        const c = inbox.counts || {};
        let html = '';
        if (!inbox.token_configured) { html += renderTokenSetup(); }

        // Summary bar — only nonzero signals.
        const bits = [];
        if (c.mention) bits.push(`<b>${c.mention}</b> mention you`);
        if (c.due) bits.push(`<b>${c.due}</b> due/overdue`);
        if (c.comment) bits.push(`<b>${c.comment}</b> comments`);
        if (c.assigned) bits.push(`<b>${c.assigned}</b> assigned`);
        if (c.status) bits.push(`<b>${c.status}</b> status changes`);
        html += `<div class="dash-ib-bar">
            <div class="dash-ib-stand">${bits.length ? bits.join(' &nbsp;·&nbsp; ') : 'all clear — nothing pending'}</div>
            <div class="dash-head-actions">
                <button class="btn dash-btn" onclick="dashInboxRefresh(this)">[ REFRESH ]</button>
                ${(c.unread || 0) ? '<button class="btn dash-btn" onclick="dashInboxSeenAll(this)">[ CLEAR ALL ]</button>' : ''}
            </div>
        </div>`;

        // Unread items only (seen ones vanish, like a real inbox).
        const unread = (inbox.items || []).filter(it => !it.seen);
        if (!unread.length) {
            html += `<div class="dash-empty">${inbox.token_configured ? 'inbox clear — nothing needs your attention' : 'configure your ClickUp token to see your inbox'}</div>`;
            return html;
        }
        for (const g of INBOX_GROUPS) {
            const rows = unread.filter(it => inboxKindMatch(g.kind, it));
            if (!rows.length) continue;
            const collapsed = !!inboxCollapsed[g.kind];
            html += `<div class="dash-ib-group ${collapsed ? 'collapsed' : ''}">
                <div class="dash-ib-grouphead" onclick="dashInboxToggle('${g.kind}')">
                    <span class="dash-ib-caret">${collapsed ? '[+]' : '[-]'}</span>
                    <span class="dash-ib-grouptitle">${g.icon} ${g.label}</span>
                    <span class="dash-ib-groupcount">${rows.length}</span>
                </div>
                ${collapsed ? '' : `<div class="dash-ib-rows">${rows.map(renderInboxRow).join('')}</div>`}
            </div>`;
        }
        return html;
    }

    // ─── Tasks view (Increment 1) ───────────────────────────────────────────
    function statusBadge(s) {
        const v = (s || '').toLowerCase();
        const cls = ['complete', 'incomplete', 'unclear', 'skipped'].includes(v) ? v : 'unclear';
        return `<span class="dash-verdict-badge dash-status-${cls}">${escapeHtml(v || 'unclear')}</span>`;
    }
    function renderTokenSetup() {
        return `
        <div class="dash-tokensetup">
            <div class="dash-tokensetup-title">[!] ClickUp API token required</div>
            <div class="dash-tokensetup-hint">Paste a ClickUp personal API token (starts with pk_). Stored server-side; never shown again.</div>
            <div class="dash-row">
                <input type="password" class="dash-token-input" id="dash-token-input" placeholder="pk_..." autocomplete="off" spellcheck="false">
                <button class="btn dash-btn dash-btn-approve" onclick="dashSaveToken(this)">[ SAVE ]</button>
            </div>
            ${renderTokenResult()}
        </div>`;
    }
    // Outcome of the last save: who the token belongs to, where worklogs will land,
    // and anything that will bite later (unreachable workspace, stale CLICKUP_USER_ID).
    function renderTokenResult() {
        if (!cfgResult) return '';
        if (!cfgResult.ok) {
            return `<div class="dash-token-result dash-token-bad">[!] ${escapeHtml(cfgResult.message || 'token rejected')} &mdash; the previous token is still in use</div>`;
        }
        const u = cfgResult.user || {};
        const wt = cfgResult.worklog_team;
        let out = `<div class="dash-token-result dash-token-ok">[+] token saved &mdash; ${escapeHtml(u.username || u.id || '')}${u.email ? ' &lt;' + escapeHtml(u.email) + '&gt;' : ''}`
            + (wt ? ` &middot; worklogs -&gt; ${escapeHtml(wt.name || wt.id)}` : '')
            + (cfgResult.workspaces && cfgResult.workspaces.length ? ` &middot; sees ${cfgResult.workspaces.length} workspace(s)` : '')
            + `</div>`;
        for (const w of (cfgResult.warnings || [])) {
            out += `<div class="dash-token-result dash-token-warn">[!] ${escapeHtml(w)}</div>`;
        }
        return out;
    }

    // Token panel: change the ClickUp token that worklogs are created with, without
    // having to clear the old one first. Shown collapsed behind [ TOKEN ] in the
    // worklogs controls; the input is the same id as the first-run setup card (only
    // one of the two ever renders at a time).
    function renderTokenPanel() {
        if (!cfgOpen) return '';
        const c = cfg || {};
        const meta = [];
        if (c.token_configured) {
            meta.push(`current: <b>${escapeHtml(c.token_masked || '')}</b> (${escapeHtml(c.token_source === 'env' ? 'CLICKUP_API_TOKEN env' : 'saved in config')})`);
        } else {
            meta.push('current: <b>none configured</b>');
        }
        if (c.workspace_name) meta.push(`worklog workspace: <b>${escapeHtml(c.workspace_name)}</b>`);
        if (c.user_id) meta.push(`CLICKUP_USER_ID: <b>${escapeHtml(String(c.user_id))}</b>`);

        const result = renderTokenResult();
        return `
        <div class="dash-tokenpanel">
            <div class="dash-token-meta">${meta.join(' &nbsp;·&nbsp; ')}</div>
            <div class="dash-tokensetup-hint">Paste a ClickUp personal API token (starts with pk_). It is verified against ClickUp before it replaces the current one, and is never shown again.</div>
            <div class="dash-row">
                <input type="password" class="dash-token-input" id="dash-token-input" placeholder="pk_..." autocomplete="off" spellcheck="false">
                <button class="btn dash-btn dash-btn-approve" onclick="dashSaveToken(this)">[ SAVE ]</button>
                <button class="btn dash-btn" onclick="dashToggleTokenPanel()">[ CLOSE ]</button>
            </div>
            ${result}
        </div>`;
    }
    // Session mapper: bind a task to a live tmux session (its cwd = what the analyst reads).
    function renderMapper(t) {
        const names = sessionList.slice();
        if (t.mapped_session && !names.includes(t.mapped_session)) names.unshift(t.mapped_session); // keep a dead/foreign mapping visible
        const opts = ['<option value="">(no session mapped)</option>']
            .concat(names.map(n => `<option value="${escapeHtml(n)}" ${n === t.mapped_session ? 'selected' : ''}>${escapeHtml(n)}</option>`))
            .join('');
        return `<label class="dash-interp-label">work session — its folder is what the analyst reads (vault + code):</label>
            <select class="dash-map-select" onchange="dashMapSession(${t.id}, this.value)">${opts}</select>`;
    }

    // Completion analysis: % bar + what's missing + next step (compact). Falls back
    // to skipped/legacy text shapes.
    function renderAnalysis(t) {
        const a = t.analysis;
        if (!a) return '';
        if (a.status === 'skipped') return `<div class="dash-verdict">${statusBadge('skipped')}<span class="dash-verdict-age">${fmtAge(a.at)}</span><div class="dash-verdict-text">${escapeHtml(a.text || '')}</div></div>`;
        if (typeof a.percent === 'number') {
            const p = Math.max(0, Math.min(100, a.percent));
            const cls = p >= 100 ? 'complete' : (p >= 50 ? 'mid' : 'low');
            return `<div class="dash-analysis">
                <div class="dash-pct-row">
                    <div class="dash-pct-bar"><div class="dash-pct-fill dash-pct-${cls}" style="width:${p}%"></div></div>
                    <span class="dash-pct-num dash-pct-${cls}">${p}%</span>
                    <span class="dash-verdict-age">${fmtAge(a.at)}</span>
                </div>
                ${a.missing ? `<div class="dash-analysis-line"><span class="dash-analysis-k">missing</span> ${escapeHtml(a.missing)}</div>` : ''}
                ${a.next ? `<div class="dash-analysis-line"><span class="dash-analysis-k">next</span> ${escapeHtml(a.next)}</div>` : ''}
            </div>`;
        }
        // legacy / unclear / timeout
        return `<div class="dash-verdict">${a.status ? statusBadge(a.status) : ''}<span class="dash-verdict-age">${fmtAge(a.at)}</span><div class="dash-verdict-text">${escapeHtml(a.text || '')}</div></div>`;
    }

    // Live feed: what the analyst is doing right now, for the row currently running.
    function renderLiveFeed(t) {
        if (!t.analyzing) return '';
        const act = analystActivity;
        let mine = false;
        if (act && act.key) { const m = act.key.match(/^[a-z](\d+)-/); if (m && Number(m[1]) === t.id) mine = true; }
        const steps = (mine && act && Array.isArray(act.steps)) ? act.steps : [];
        const body = steps.length
            ? steps.map(s => `<div class="dash-feed-step">[&gt;] ${escapeHtml(s.label)}</div>`).join('')
            : `<div class="dash-feed-step dash-feed-wait">starting${act && act.kind === 'propose' ? ' proposal' : ' analysis'}…</div>`;
        return `<div class="dash-feed"><div class="dash-feed-head">[~] analyst working — live</div>${body}</div>`;
    }

    function renderTask(t) {
        const analyzeLabel = t.analyzing ? '[ WORKING ]' : (t.analysis ? '[ RE-ANALYZE ]' : '[ ANALYZE ]');
        const confirmed = t.user_interpretation || '';
        const proposed = t.proposed_interpretation || '';
        const isPlaceholder = proposed.startsWith('('); // secretco / error / timeout note
        const showProposal = !confirmed && proposed && !isPlaceholder;
        const interpVal = confirmed || (showProposal ? proposed : '');
        const selected = selectedTaskIds.has(t.id);
        return `
        <div class="dash-task ${selected ? 'dash-task-sel' : ''}" data-id="${t.id}">
            <div class="dash-row dash-task-head">
                <input type="checkbox" class="dash-task-check" ${selected ? 'checked' : ''} onclick="event.stopPropagation(); dashToggleSelect(${t.id})" title="select for bulk session mapping">
                <span class="dash-task-title">${escapeHtml(t.title || '(untitled)')}</span>
                ${t.mapped_session ? (sessionList.includes(t.mapped_session)
                    ? `<span class="dash-task-mapped" title="mapped work session (live)">[S] ${escapeHtml(t.mapped_session)}</span>`
                    : `<span class="dash-task-mapped dash-task-mapped-off" title="mapped session is offline — recreate it with this name, or pick a live one below">[S] ${escapeHtml(t.mapped_session)} (offline)</span>`) : ''}
                <span class="dash-task-status">${escapeHtml(t.clickup_status || '')}</span>
            </div>
            <div class="dash-row dash-task-meta">
                <span class="dash-task-proj">${escapeHtml(t.project || '(no project)')}</span>
                ${t.list_name ? `<span class="dash-task-listname">${escapeHtml(t.list_name)}</span>` : ''}
                ${t.url ? `<a class="dash-task-link" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">[open]</a>` : ''}
            </div>
            ${renderMapper(t)}
            <label class="dash-interp-label">interpretation — what "done" means (the analyst measures progress against this):</label>
            <textarea class="dash-interp" id="dash-interp-${t.id}" rows="2" placeholder="propose one with [PROPOSE], or write it: e.g. done when the recon report is committed and FL refunds reconcile" onblur="dashSaveInterpretation(${t.id}, this)">${escapeHtml(interpVal)}</textarea>
            ${showProposal ? `<div class="dash-propose-hint">[~] analyst proposal — edit above (auto-saves on blur) or <button class="btn dash-btn dash-btn-mini" onclick="dashConfirmInterp(${t.id})">[ confirm ]</button></div>` : ''}
            ${isPlaceholder && !confirmed ? `<div class="dash-propose-hint">${escapeHtml(proposed)}</div>` : ''}
            <div class="dash-row dash-task-actions">
                <button class="btn dash-btn" ${t.analyzing ? 'disabled' : ''} onclick="dashPropose(${t.id}, this)">[ PROPOSE ]</button>
                <button class="btn dash-btn dash-btn-approve" ${t.analyzing ? 'disabled' : ''} onclick="dashAnalyze(${t.id}, this)">${analyzeLabel}</button>
            </div>
            ${renderLiveFeed(t)}
            ${t.analyzing ? '' : renderAnalysis(t)}
        </div>`;
    }
    // Bulk-map bar: appears when tasks are selected — map the whole selection to a
    // session at once (that shared session IS the group).
    function renderBulkBar() {
        if (!selectedTaskIds.size) return '';
        const opts = ['<option value="">map selected to…</option>']
            .concat(sessionList.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`))
            .concat(['<option value="__none__">(unmap)</option>'])
            .join('');
        return `<div class="dash-bulkbar">
            <span class="dash-bulk-count">${selectedTaskIds.size} selected</span>
            <select class="dash-map-select dash-bulk-select" onchange="dashBulkMap(this.value)">${opts}</select>
            <button class="btn dash-btn dash-btn-mini" onclick="dashClearSelect()">[ clear ]</button>
        </div>`;
    }
    function renderTasksView() {
        let html = `<div class="dash-sec-title-row">
            <span class="dash-sec-title">ASSIGNED TASKS (${tasks.length})</span>
            <div class="dash-head-actions">
                <button class="btn dash-btn" onclick="dashSync(this)">[ SYNC ]</button>
                ${tasks.length ? '<button class="btn dash-btn dash-btn-approve" onclick="dashAnalyzeAll(this)">[ ANALYZE ALL ]</button>' : ''}
            </div>
        </div>`;
        if (!tokenConfigured) html += renderTokenSetup();
        if (!tasks.length) { html += `<div class="dash-empty">${tokenConfigured ? 'no assigned tasks — click SYNC to poll ClickUp' : 'configure a token, then SYNC'}</div>`; return html; }

        html += renderBulkBar();

        // Cluster by mapped session (shared session = group). Flat list when nothing
        // is mapped yet, to keep the simple case clean.
        const anyMapped = tasks.some(t => t.mapped_session);
        if (!anyMapped) { html += '<div class="dash-tasks">' + tasks.map(renderTask).join('') + '</div>'; return html; }

        const groups = new Map();
        for (const t of tasks) { const k = t.mapped_session || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
        const keys = Array.from(groups.keys()).filter(k => k).sort();
        if (groups.has('')) keys.push(''); // unmapped last

        // Collapse/expand-all toggle so groups can be crushed to header bars.
        const anyExpanded = keys.some(k => !taskGroupCollapsed[k]);
        html += `<div class="dash-tg-allbar">
            <button class="btn dash-btn dash-btn-mini" onclick="dashGroupToggleAll()">${anyExpanded ? '[-] collapse all' : '[+] expand all'}</button>
        </div>`;

        for (const k of keys) {
            const rows = groups.get(k);
            const collapsed = !!taskGroupCollapsed[k];
            const kArg = k ? escapeHtml(k) : '';
            const offline = k && !sessionList.includes(k);
            const label = k ? `[S] ${escapeHtml(k)}${offline ? ' (offline)' : ''}` : 'UNMAPPED';
            // Tiny progress summary on the (collapsed) header: avg % of analyzed rows.
            const pcts = rows.map(r => r.analysis && typeof r.analysis.percent === 'number' ? r.analysis.percent : null).filter(v => v != null);
            const avg = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
            html += `<div class="dash-tg ${collapsed ? 'collapsed' : ''}">
                <div class="dash-tg-head ${offline ? 'dash-tg-off' : ''}" onclick="dashGroupToggle('${kArg}')">
                    <span class="dash-tg-caret">${collapsed ? '[+]' : '[-]'}</span>
                    <span class="dash-tg-title">${label}</span>
                    <span class="dash-tg-count">${rows.length}</span>
                    ${avg != null ? `<span class="dash-tg-avg">~${avg}%</span>` : ''}
                    ${k ? `<button class="btn dash-btn dash-btn-mini dash-btn-approve" onclick="event.stopPropagation(); dashAnalyzeGroup('${kArg}', this)">[ ANALYZE GROUP ]</button>` : ''}
                </div>
                ${collapsed ? '' : `<div class="dash-tg-body">${rows.map(renderTask).join('')}</div>`}
            </div>`;
        }
        return html;
    }

    // ─── Worklogs view (Increment 2) ────────────────────────────────────────
    function renderWorklogsView() {
        const today = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
        // Hide dismissed rows — they stay in the DB (and the batch) but must vanish
        // from the table, otherwise clicking [x] looks like it did nothing.
        const p = (wlState.proposals || []).filter(x => x.status !== 'dismissed');
        const pending = p.filter(x => x.status === 'proposed' || x.status === 'failed');
        const totalH = pending.reduce((a, x) => a + (Number(x.hours) || 0), 0);
        const tokLabel = (cfg && cfg.token_configured)
            ? `[ TOKEN: ${escapeHtml(cfg.token_masked || 'set')} ]`
            : '[ TOKEN: NOT SET ]';
        let html = `<div class="dash-sec-title-row"><span class="dash-sec-title">WORKLOGS</span>
            <div class="dash-head-actions">
                <button class="btn dash-btn ${cfg && !cfg.token_configured ? 'dash-btn-warn' : ''}" onclick="dashToggleTokenPanel()">${tokLabel}</button>
            </div>
        </div>
        ${renderTokenPanel()}
        <div class="dash-wl-controls">
            <label>From <input type="date" class="dash-date" id="dash-wl-start" value="${escapeHtml(wlForm ? wlForm.start : today)}" onchange="dashWlForm()"></label>
            <label>To <input type="date" class="dash-date" id="dash-wl-end" value="${escapeHtml(wlForm ? wlForm.end : today)}" onchange="dashWlForm()"></label>
            <input type="text" class="dash-wl-hint" id="dash-wl-hint" value="${escapeHtml(wlForm ? wlForm.hint : '')}" oninput="dashWlForm()" placeholder="net hours hint, e.g. 'Mon 8, Tue 6'">
            <button class="btn dash-btn dash-btn-hrs" onclick="dashHrsScan(this)" title="Scan your sessions for this range and estimate the hours you worked each day">[ ESTIMATE HOURS ]</button>
            <button class="btn dash-btn dash-btn-approve" ${wlState.generating ? 'disabled' : ''} onclick="dashWlGenerate(this)">${wlState.generating ? '[ GENERATING ]' : '[ GENERATE ]'}</button>
            ${wlState.generating ? `<button class="btn dash-btn dash-btn-danger" onclick="dashWlCancel(this)">[ CANCEL ]</button>` : ''}
        </div>`;
        if (hrsOpen) html += renderHoursPanel();
        if (wlState.generating) html += `<div class="dash-verdict-running">[~] analyst reading sources (vault + full WSL session scan)... ~1-8min</div>`;
        if (wlState.cancelled && !wlState.generating) html += `<div class="dash-wl-cancelled">[x] generation cancelled — nothing was saved; set a range and GENERATE to start over</div>`;
        if (wlState.error) html += `<div class="dash-wl-error">[!] ${escapeHtml(wlState.error)}</div>`;
        if (!p.length) { html += `<div class="dash-empty">no proposals yet — set a range and GENERATE</div>`; return html; }

        html += `<table class="dash-wl-table"><thead><tr>
            <th>Date</th><th>Project</th><th>Task ID</th><th>Hours</th><th>Bill</th><th>Comment</th><th></th></tr></thead><tbody>`;
        for (const x of p) {
            const created = x.status === 'created';
            const dis = created ? 'disabled' : '';
            const nt = !created ? wlNewTask(x) : null;
            html += `<tr class="dash-wl-row dash-wl-${x.status}" data-id="${x.id}">
                <td>${escapeHtml(x.work_date || '')}</td>
                <td>${escapeHtml(x.project || '')}<div class="dash-wl-taskname" id="dash-wl-tn-${x.id}">${escapeHtml(nt ? '' : (x.task_name || ''))}</div></td>
                <td>${nt ? renderNewTaskCell(x, nt) : renderTaskIdCell(x, dis, created)}</td>
                <td><input class="dash-wl-in dash-wl-hours" id="dash-wl-hours-${x.id}" type="number" step="0.25" min="0" value="${x.hours}" ${dis} onblur="dashWlSave(${x.id})"></td>
                <td><input type="checkbox" id="dash-wl-bill-${x.id}" ${x.billable ? 'checked' : ''} ${dis} onchange="dashWlSave(${x.id})"></td>
                <td><input class="dash-wl-in dash-wl-comment" id="dash-wl-comment-${x.id}" value="${escapeHtml(x.comment || '')}" ${dis} onblur="dashWlSave(${x.id})"></td>
                <td class="dash-wl-actions"><button class="btn dash-btn dash-btn-mini dash-btn-why" title="where did this come from?" onclick="dashWlWhy(${x.id})">[?]</button>
                    ${created
                    ? '<span class="dash-wl-ok">[created]</span>'
                    : `<button class="btn dash-btn dash-btn-mini" onclick="dashWlDismiss(${x.id}, this)">[x]</button>`}
                    ${x.status === 'failed' ? `<span class="dash-wl-fail" title="${escapeHtml(x.error || '')}">[failed]</span>` : ''}</td>
            </tr>`;
        }
        const blocked = pending.filter(x => !wlNewTask(x) && WL_BLOCKING.includes(x.task_state)).length;
        const newTasks = pending.filter(x => wlNewTask(x)).length;
        html += `</tbody></table>
        <div class="dash-wl-footer">
            <span class="dash-wl-total">${pending.length} pending — ${totalH.toFixed(2)}h${newTasks ? ` · ${newTasks} new task${newTasks > 1 ? 's' : ''}` : ''}${blocked ? ` · <span class="dash-wl-bad">${blocked} blocked</span>` : ''}</span>
            <button class="btn dash-btn dash-btn-approve" ${pending.length ? '' : 'disabled'} onclick="dashWlCreateAll(this)">[ CREATE ALL IN CLICKUP ]</button>
        </div>`;
        return html;
    }

    // ─── Task cell: live / closed / archived, or "create this task" ──────────
    // Archived and deleted tasks BLOCK the row (the server refuses them too);
    // closed ones only warn — he does log time on work he just finished.
    const WL_BLOCKING = ['archived', 'gone'];
    function wlNewTask(x) {
        if (!x.new_task_json) return null;
        try { return JSON.parse(x.new_task_json); } catch { return null; }
    }
    function renderTaskIdCell(x, dis, created) {
        let badge = '';
        if (!created && WL_BLOCKING.includes(x.task_state)) {
            badge = `<div class="dash-wl-state dash-wl-bad">[!] ${escapeHtml(x.task_note || 'archived')} — blocked</div>`;
        } else if (!created && x.task_state === 'closed') {
            badge = `<div class="dash-wl-state dash-wl-warn">[~] closed (${escapeHtml((x.task_note || '').replace(/^status: /, ''))})</div>`;
        }
        return `<input class="dash-wl-in dash-wl-task" id="dash-wl-task-${x.id}" value="${escapeHtml(x.task_id || '')}" ${dis} onblur="dashWlLookup(${x.id})">
            ${badge}
            ${created ? '' : `<button class="btn dash-btn dash-btn-mini" title="no good task? create one for this worklog" onclick="dashWlNewTask(${x.id}, true)">[+ new task]</button>`}`;
    }
    function renderNewTaskCell(x, nt) {
        const lists = wlLists || [];
        const opts = lists.map(l => {
            const label = [l.folder, l.list].filter(Boolean).join(' / ');
            return `<option value="${escapeHtml(l.list_id)}" ${l.list_id === nt.list_id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');
        return `<div class="dash-wl-newtask">
            <div class="dash-wl-state dash-wl-new">[+] new task${x.task_id && WL_BLOCKING.includes(x.task_state) ? ` <span title="${escapeHtml(x.task_id)}">(old one ${escapeHtml(x.task_note || 'archived')})</span>` : ''}</div>
            <input class="dash-wl-in" id="dash-wl-ntname-${x.id}" value="${escapeHtml(nt.name || '')}" placeholder="task name" onblur="dashWlSaveNewTask(${x.id})">
            <select class="dash-wl-in" id="dash-wl-ntlist-${x.id}" onchange="dashWlSaveNewTask(${x.id})">
                <option value="" ${nt.list_id ? '' : 'selected'}>${lists.length ? '— pick a list —' : '(loading lists…)'}</option>${opts}
            </select>
            <input class="dash-wl-in" id="dash-wl-ntdesc-${x.id}" value="${escapeHtml(nt.description || '')}" placeholder="description (optional)" onblur="dashWlSaveNewTask(${x.id})">
            <button class="btn dash-btn dash-btn-mini" title="log on an existing task id instead" onclick="dashWlNewTask(${x.id}, false)">[use a task id]</button>
        </div>`;
    }

    // ─── Hours Recall panel (inside Worklogs) ────────────────────────────────
    // The server scans the sessions; everything the user toggles (projects in/out,
    // typed hours, SecretCo hours) is recomputed here from the per-project blocks.
    const HRS_COLORS = ['#00d4ff', '#00ff41', '#ffb000', '#ff4fd8', '#b388ff', '#1de9b6', '#ffee58', '#ff7a59'];
    function hrsColor(name) {
        let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        return HRS_COLORS[h % HRS_COLORS.length];
    }
    const r025 = (h) => Math.round(h * 4) / 4;
    const fmtH = (h) => `${(Math.round(h * 100) / 100).toString()}h`;
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    function hrsIncluded(date, p) {
        const k = `${date}|${p.name}`;
        return k in hrsOff ? !hrsOff[k] : !p.personal;
    }
    function hrsUnionH(lists) {
        const all = [].concat(...lists).sort((a, b) => a[0] - b[0]);
        let total = 0, cur = null;
        for (const b of all) {
            if (cur && b[0] <= cur[1]) cur[1] = Math.max(cur[1], b[1]);
            else { if (cur) total += cur[1] - cur[0]; cur = [b[0], b[1]]; }
        }
        if (cur) total += cur[1] - cur[0];
        return total / 60;
    }
    function hrsAiDay(date) { return ((hrs.ai && hrs.ai.days) || []).find(x => x && x.date === date) || null; }
    // One day's numbers: calc (activity x Leon's ratio), Claude's, the pick, the final.
    function hrsDay(day, cal) {
        const active = hrsUnionH(day.projects.filter(p => hrsIncluded(day.date, p)).map(p => p.blocks));
        const calc = { est: r025(active * cal.ratio), low: r025(active * cal.ratio_low), high: r025(active * cal.ratio_high) };
        const aiD = hrsAiDay(day.date);
        const aiH = aiD && isFinite(Number(aiD.hours)) ? Number(aiD.hours) : null;
        const base = hrsPick[day.date] != null ? hrsPick[day.date] : (aiH != null ? aiH : calc.est);
        const secretco = Number(hrsRestricted[day.date]) || 0;
        return { active, calc, aiD, aiH, base, secretco, final: r025(base + secretco) };
    }

    function renderHoursPanel() {
        const s = (hrs && hrs.scan) || {};
        const a = (hrs && hrs.ai) || {};
        let html = `<div class="dash-hrs">
            <div class="dash-sec-title-row"><span class="dash-sec-title">HOURS RECALL</span>
                <div class="dash-head-actions">
                    ${s.result ? (a.running
                        ? `<button class="btn dash-btn dash-btn-danger" onclick="dashHrsCancel(this)">[ STOP CLAUDE ]</button>`
                        : `<button class="btn dash-btn dash-btn-hrs" onclick="dashHrsAsk(this)" title="Claude reads the scan + your vault notes and estimates each day with a reason">[ ASK CLAUDE ]</button>`) : ''}
                    ${s.result ? `<button class="btn dash-btn dash-btn-approve" onclick="dashHrsUse()" title="Copy the final hours into the generator above">[ USE THESE HOURS ]</button>` : ''}
                    <button class="btn dash-btn dash-btn-mini" onclick="dashHrsClose()">[x]</button>
                </div>
            </div>`;
        if (s.running) {
            const pr = s.progress || {}; const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
            html += `<div class="dash-verdict-running">[~] reading your sessions... ${pr.done || 0}/${pr.total || '?'} files</div>
                <div class="dash-hrs-progress"><div style="width:${pct}%"></div></div>`;
        }
        if (s.error) html += `<div class="dash-wl-error">[!] ${escapeHtml(s.error)}</div>`;
        if (!s.result) { if (!s.running) html += `<div class="dash-empty">pick a range and press ESTIMATE HOURS</div>`; return html + '</div>'; }

        const r = s.result, cal = r.calibration;
        const calLine = cal.calibrated
            ? `your ClickUp hours = <b>${cal.ratio}x</b> your session time (usual range ${cal.ratio_low}-${cal.ratio_high}x, from ${cal.days_used} days you logged)`
            : `[!] not enough logged days to learn your ratio (${cal.days_used} of 3 needed) - using session time 1:1`;
        html += `<div class="dash-hrs-cal">${calLine}${cal.typical_logged_day_h != null ? ` &middot; your usual weekday: <b>${cal.typical_logged_day_h}h</b>` : ''}
            ${cal.clickup_error ? `<div class="dash-token-warn">[!] could not read ClickUp: ${escapeHtml(cal.clickup_error)}</div>` : ''}
            <div class="dash-hrs-muted">SecretCo sessions are never read - type SecretCo hours by hand. Personal projects start unchecked.</div></div>`;

        if (a.running) html += `<div class="dash-verdict-running">[~] Claude is reading the scan + vault notes... ~1-4min</div>`;
        if (a.error) html += `<div class="dash-wl-error">[!] Claude: ${escapeHtml(a.error)}</div>`;
        if (!a.running) html += `<div class="dash-hrs-note-row"><input class="dash-wl-hint" id="dash-hrs-note" value="${escapeHtml(hrsNote)}" oninput="dashHrsNote(this.value)" placeholder="tell Claude anything it can't see, e.g. 'Tue 2h call with Paul, Thu off at 3pm'"></div>`;

        // Shared time window so days line up visually.
        let lo = 9 * 60, hi = 19 * 60;
        for (const d of r.days) { if (d.first_min != null) lo = Math.min(lo, d.first_min); if (d.last_min != null) hi = Math.max(hi, d.last_min); }
        lo = Math.floor(lo / 60) * 60; hi = Math.min(1440, Math.ceil(hi / 60) * 60);
        const span = Math.max(60, hi - lo);
        const pos = (m) => ((m - lo) / span) * 100;
        let ticks = '';
        for (let m = lo; m <= hi; m += 60) {
            const lbl = (m - lo) % 180 === 0 ? `<span>${String(Math.floor(m / 60) % 24).padStart(2, '0')}</span>` : '';
            ticks += `<i style="left:${pos(m)}%">${lbl}</i>`;
        }

        let weekTotal = 0, weekLogged = 0;
        for (const d of r.days) {
            const n = hrsDay(d, cal);
            weekTotal += n.final; weekLogged += d.logged_h || 0;
            const open = !!hrsExpanded[d.date];
            const weekend = d.weekday === 'Sat' || d.weekday === 'Sun';
            const loggedCls = d.logged_h <= 0 ? 'dash-hrs-miss' : (d.logged_h + 0.25 >= n.final ? 'dash-hrs-done' : 'dash-hrs-part');
            const conf = n.aiD && n.aiD.confidence ? escapeHtml(String(n.aiD.confidence)) : '';
            const lanes = d.projects.map((p, i) => {
                const on = hrsIncluded(d.date, p);
                const col = hrsColor(p.name);
                const bars = p.blocks.map(b => `<b style="left:${pos(b[0])}%;width:${Math.max(0.4, pos(b[1]) - pos(b[0]))}%;background:${col}" title="${escapeHtml(p.name)} ${hhmm(b[0])}-${hhmm(b[1])}"></b>`).join('');
                return `<div class="dash-hrs-lane ${on ? '' : 'off'}">
                    <label class="dash-hrs-proj" title="count this project">
                        <input type="checkbox" ${on ? 'checked' : ''} onchange="dashHrsProj('${d.date}', ${i})">
                        <span style="color:${col}">${escapeHtml(p.name)}</span> <em>${fmtH(p.active_h)}</em>
                    </label>
                    <div class="dash-hrs-track">${bars}</div>
                </div>`;
            }).join('');

            html += `<div class="dash-hrs-day ${weekend ? 'weekend' : ''}">
                <div class="dash-hrs-head" onclick="dashHrsToggle('${d.date}')">
                    <span class="dash-hrs-date">${open ? '[-]' : '[+]'} ${escapeHtml(d.weekday)} ${escapeHtml(d.date.slice(5))}</span>
                    <span class="dash-hrs-big">${fmtH(n.final)}</span>
                    <span class="dash-hrs-range">calc ${fmtH(n.calc.est)} (${n.calc.low}-${n.calc.high})</span>
                    ${n.aiH != null ? `<span class="dash-hrs-ai">claude ${fmtH(n.aiH)}${n.aiD.low != null ? ` (${n.aiD.low}-${n.aiD.high})` : ''}${conf ? ` &middot; ${conf}` : ''}</span>` : ''}
                    <span class="dash-hrs-logged ${loggedCls}">clickup ${fmtH(d.logged_h || 0)}</span>
                    ${d.projects.length ? `<span class="dash-hrs-muted">${hhmm(d.first_min)}-${hhmm(d.last_min)}</span>` : '<span class="dash-hrs-muted">no session activity</span>'}
                </div>
                ${n.aiD && n.aiD.headline ? `<div class="dash-hrs-headline">${escapeHtml(String(n.aiD.headline))}</div>` : ''}
                ${d.projects.length ? `<div class="dash-hrs-timeline"><div class="dash-hrs-ticks">${ticks}</div>${lanes}</div>` : ''}
                <div class="dash-hrs-pick" onclick="event.stopPropagation()">
                    <label>hours <input class="dash-wl-in dash-wl-hours" type="number" step="0.25" min="0" value="${n.base}" onchange="dashHrsPick('${d.date}', this.value)"></label>
                    <button class="btn dash-btn dash-btn-mini" onclick="dashHrsPick('${d.date}', ${n.calc.est})">calc ${n.calc.est}</button>
                    ${n.aiH != null ? `<button class="btn dash-btn dash-btn-mini" onclick="dashHrsPick('${d.date}', ${n.aiH})">claude ${n.aiH}</button>` : ''}
                    <label>+ SecretCo <input class="dash-wl-in dash-wl-hours" type="number" step="0.25" min="0" value="${hrsRestricted[d.date] || ''}" onchange="dashHrsRestricted('${d.date}', this.value)"></label>
                    ${n.aiD && n.aiD.why ? `<span class="dash-hrs-muted">why: ${escapeHtml(String(n.aiD.why))}</span>` : ''}
                </div>
                ${open ? renderHoursDetail(d, n) : ''}
            </div>`;
        }
        html += `<div class="dash-wl-footer">
            <span class="dash-wl-total">${r.days.length} days &middot; estimated <b>${fmtH(r025(weekTotal))}</b> &middot; already in ClickUp ${fmtH(Math.round(weekLogged * 100) / 100)}</span>
            <button class="btn dash-btn dash-btn-approve" onclick="dashHrsUse()">[ USE THESE HOURS ]</button>
        </div></div>`;
        return html;
    }

    // What you did that day: Claude's breakdown, then the raw evidence.
    function renderHoursDetail(d, n) {
        let h = '<div class="dash-hrs-detail">';
        const acts = n.aiD && Array.isArray(n.aiD.activities) ? n.aiD.activities : [];
        if (acts.length) {
            h += `<div class="dash-interp-label">CLAUDE'S RECALL</div><ul class="dash-hrs-acts">` +
                acts.map(x => `<li><b>${escapeHtml(String(x.hours != null ? x.hours : ''))}h</b> <span style="color:${hrsColor(x.project)}">${escapeHtml(String(x.project || ''))}</span> - ${escapeHtml(String(x.what || ''))}</li>`).join('') + '</ul>';
        }
        if (d.vault_notes.length) h += `<div class="dash-interp-label">VAULT NOTES</div><div class="dash-hrs-chips">${d.vault_notes.map(v => `<span>${escapeHtml(v)}</span>`).join('')}</div>`;
        if (d.logged_entries && d.logged_entries.length) {
            h += `<div class="dash-interp-label">ALREADY IN CLICKUP</div><ul class="dash-hrs-acts">` +
                d.logged_entries.map(e => `<li><b>${escapeHtml(String(e.hours))}h</b> ${escapeHtml(e.task_name || '')} - ${escapeHtml(e.comment || '')}</li>`).join('') + '</ul>';
        }
        for (const p of d.projects) {
            if (!p.titles.length && !p.prompts.length) continue;
            h += `<div class="dash-hrs-pdetail"><div style="color:${hrsColor(p.name)}">${escapeHtml(p.name)} <em>${fmtH(p.active_h)} &middot; ${p.sessions} session(s) &middot; ${p.prompts_count} asks${p.personal ? ' &middot; personal' : ''}</em></div>`;
            if (p.titles.length) h += `<div class="dash-hrs-chips">${p.titles.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>`;
            if (p.prompts.length) h += `<ul class="dash-hrs-prompts">${p.prompts.map(x => `<li><i>${hhmm(x.min)}</i> ${escapeHtml(x.text)}</li>`).join('')}</ul>`;
            h += '</div>';
        }
        return h + '</div>';
    }

    // ─── Digest view (Increment 3) ──────────────────────────────────────────
    function renderDigestView() {
        let html = `<div class="dash-sec-title-row"><span class="dash-sec-title">VAULT DIGEST</span>
            <div class="dash-head-actions"><button class="btn dash-btn dash-btn-approve" onclick="dashDigestGenerate(this)">[ GENERATE DIGEST ]</button></div></div>`;
        if (!digest) html += `<div class="dash-empty">no digest yet — click GENERATE to summarize today's vault writes</div>`;
        else if (digest.status === 'pending') html += `<div class="dash-verdict-running">[~] reading today's vault writes...</div>`;
        else html += `<div class="dash-digest dash-digest-${escapeHtml(digest.status)}"><div class="dash-digest-age">${fmtAge(digest.ready_at || digest.run_at)}</div><pre class="dash-digest-text">${escapeHtml(digest.content || '')}</pre></div>`;

        html += `<div class="dash-sec-title-row dash-notes-title"><span class="dash-sec-title">NOTE ROUTING</span></div>
        <div class="dash-note-input">
            <textarea class="dash-note-text" id="dash-note-text" rows="3" placeholder="Paste a meeting / Gemini note — the analyst proposes where it goes in the vault"></textarea>
            <button class="btn dash-btn dash-btn-approve" onclick="dashNoteRoute(this)">[ ROUTE ]</button>
        </div>`;
        if (notes.length) {
            html += '<div class="dash-notes">' + notes.map(n => {
                if (n.status === 'pending') return `<div class="dash-note dash-note-pending"><div class="dash-note-snippet">${escapeHtml((n.note_text || '').slice(0, 80))}...</div><div class="dash-verdict-running">[~] routing...</div></div>`;
                if (n.status === 'written') return `<div class="dash-note dash-note-written"><span class="dash-wl-ok">[written]</span> ${escapeHtml(n.proposed_path || '')}</div>`;
                if (n.status === 'failed') return `<div class="dash-note dash-note-failed"><span class="dash-wl-fail">[failed]</span> ${escapeHtml(n.error || '')} <button class="btn dash-btn dash-btn-mini" onclick="dashNoteDismiss(${n.id}, this)">[x]</button></div>`;
                // ready
                return `<div class="dash-note dash-note-ready" data-id="${n.id}">
                    <div class="dash-note-rationale">${escapeHtml(n.rationale || '')}</div>
                    <label class="dash-interp-label">destination path (vault-relative):</label>
                    <input class="dash-note-path" id="dash-note-path-${n.id}" value="${escapeHtml(n.proposed_path || '')}">
                    <label class="dash-interp-label">content to write/append:</label>
                    <textarea class="dash-note-content" id="dash-note-content-${n.id}" rows="6">${escapeHtml(n.proposed_content || '')}</textarea>
                    <div class="dash-row">
                        <button class="btn dash-btn dash-btn-approve" onclick="dashNoteApprove(${n.id}, this)">[ WRITE TO VAULT ]</button>
                        <button class="btn dash-btn" onclick="dashNoteDismiss(${n.id}, this)">[ DISMISS ]</button>
                    </div>
                </div>`;
            }).join('') + '</div>';
        }
        return html;
    }

    function render() {
        const wraps = document.querySelectorAll('.dash-target');
        if (!wraps.length) return;
        if (editingActive()) return;
        let body = '';
        if (dashView === 'inbox') body = renderInboxView();
        else if (dashView === 'tasks') body = renderTasksView();
        else if (dashView === 'worklogs') body = renderWorklogsView();
        else if (dashView === 'digest') body = renderDigestView();
        const html = renderNav() + `<div class="dash-view">${body}</div>`;
        wraps.forEach(w => { w.innerHTML = html; });
    }

    async function refresh() { await fetchActive(); render(); }

    function dashSwitchView(v) { dashView = v; refresh(); }

    // ─── Inbox actions ──────────────────────────────────────────────────────
    function dashInboxToggle(kind) { inboxCollapsed[kind] = !inboxCollapsed[kind]; render(); }
    async function dashInboxSeen(keyEnc, btn) {
        const item_key = decodeURIComponent(keyEnc);
        if (btn) btn.disabled = true;
        // Optimistic: drop it locally so it vanishes instantly, then persist.
        if (inbox.items) inbox.items = inbox.items.map(it => it.item_key === item_key ? { ...it, seen: true } : it);
        if (inbox.counts && inbox.counts.unread) inbox.counts.unread = Math.max(0, inbox.counts.unread - 1);
        render();
        try { await fetch('/api/dispatcher/clickup/inbox/seen', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ item_key }) }); }
        catch (e) { console.error('[dashboard] inbox seen failed', e); }
    }
    async function dashInboxSeenAll(btn) {
        if (btn) { btn.disabled = true; btn.textContent = '[ ... ]'; }
        try { await fetch('/api/dispatcher/clickup/inbox/seen-all', { method: 'POST', headers: jsonHeaders(), body: '{}' }); await refresh(); }
        catch (e) { alert('error: ' + e.message); }
    }
    async function dashInboxRefresh(btn) {
        if (btn) { btn.disabled = true; btn.textContent = '[ REFRESHING ]'; }
        try {
            const r = await fetch('/api/dispatcher/clickup/inbox/refresh', { method: 'POST', headers: jsonHeaders(), body: '{}' });
            const d = await r.json();
            if (d.error) alert('refresh error: ' + d.error);
            await refresh();
        } catch (e) { alert('refresh error: ' + e.message); if (btn) { btn.disabled = false; btn.textContent = '[ REFRESH ]'; } }
    }

    // ─── Token config (shared by the setup card and the worklogs panel) ─────
    async function dashToggleTokenPanel() {
        cfgOpen = !cfgOpen;
        cfgResult = null;
        if (cfgOpen && !cfg) await fetchConfig();
        render();
    }
    // Save = replace the token in use. The server verifies it against ClickUp
    // first, so a rejected token leaves the working one untouched.
    async function dashSaveToken(btn) {
        const input = document.getElementById('dash-token-input');
        const tok = input ? input.value.trim() : '';
        if (!tok) { alert('paste a token first'); return; }
        if (btn) { btn.disabled = true; btn.textContent = '[ CHECKING ]'; }
        cfgResult = null;
        try {
            const r = await fetch('/api/dispatcher/clickup/config', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ token: tok }) });
            const d = await r.json();
            if (d.error) {
                cfgResult = { ok: false, message: d.error };
                cfgOpen = true;             // keep the panel open so the error is readable
                if (input) input.value = '';
                render();
                return;
            }
            cfgResult = { ok: true, user: d.user, worklog_team: d.worklog_team, workspaces: d.workspaces, warnings: d.warnings || [] };
            if (input) input.value = '';
            await fetchConfig();
            // The token feeds both views; re-pull whichever one is on screen.
            if (dashView === 'tasks') await dashSync(null);
            else await refresh();
        } catch (e) {
            cfgResult = { ok: false, message: e.message };
            cfgOpen = true;
            render();
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '[ SAVE ]'; }
        }
    }

    // ─── Tasks actions (Increment 1) ────────────────────────────────────────
    async function dashSync(btn) {
        if (btn) { btn.disabled = true; btn.textContent = '[ SYNCING ]'; }
        try {
            const r = await fetch('/api/dispatcher/clickup/tasks/sync', { method: 'POST', headers: jsonHeaders(), body: '{}' });
            const d = await r.json();
            if (d.error) alert('sync error: ' + d.error);
            await refresh();
        } catch (e) { alert('sync error: ' + e.message); if (btn) { btn.disabled = false; btn.textContent = '[ SYNC ]'; } }
    }
    async function dashSaveInterpretation(id, el) {
        const interpretation = el ? el.value : '';
        try {
            await fetch(`/api/dispatcher/clickup/task/${id}/interpretation`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ interpretation }) });
            const t = tasks.find(x => x.id === id); if (t) t.user_interpretation = interpretation;
        } catch (e) { console.error('[dashboard] save interpretation failed', e); }
    }
    // Confirm the analyst proposal sitting in the textarea (saves it as authoritative).
    async function dashConfirmInterp(id) {
        const el = document.getElementById(`dash-interp-${id}`);
        await dashSaveInterpretation(id, el);
        await refresh();
    }
    // Map this task to a tmux session (its cwd becomes the analyst's source).
    async function dashMapSession(id, session) {
        try {
            await fetch(`/api/dispatcher/clickup/task/${id}/map`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ session }) });
            const t = tasks.find(x => x.id === id); if (t) t.mapped_session = session || null;
            if (typeof toast === 'function') toast(session ? `mapped to ${session}` : 'session unmapped');
            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
            await refresh();
        } catch (e) { console.error('[dashboard] map session failed', e); if (typeof toast === 'function') toast('map failed'); }
    }
    // Ask the analyst to propose an interpretation (reads the mapped project).
    async function dashPropose(id, btn) {
        if (btn) { btn.disabled = true; btn.textContent = '[ PROPOSING ]'; }
        try { await fetch(`/api/dispatcher/clickup/task/${id}/propose`, { method: 'POST', headers: jsonHeaders(), body: '{}' }); await refresh(); }
        catch (e) { alert('propose error: ' + e.message); if (btn) btn.disabled = false; }
    }
    // ─── Grouping (shared-session clusters) ──────────────────────────────────
    function dashToggleSelect(id) { if (selectedTaskIds.has(id)) selectedTaskIds.delete(id); else selectedTaskIds.add(id); render(); }
    function dashClearSelect() { selectedTaskIds.clear(); render(); }
    function dashGroupToggle(session) { taskGroupCollapsed[session] = !taskGroupCollapsed[session]; render(); }
    function dashGroupToggleAll() {
        const keys = Array.from(new Set(tasks.map(t => t.mapped_session || '')));
        const anyExpanded = keys.some(k => !taskGroupCollapsed[k]);
        keys.forEach(k => { taskGroupCollapsed[k] = anyExpanded; }); // expanded -> collapse all, else expand all
        render();
    }
    async function dashBulkMap(value) {
        if (!value || !selectedTaskIds.size) return;
        const session = value === '__none__' ? '' : value;
        const ids = Array.from(selectedTaskIds);
        try {
            await fetch('/api/dispatcher/clickup/tasks/map-bulk', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ids, session }) });
            ids.forEach(id => { const t = tasks.find(x => x.id === id); if (t) t.mapped_session = session || null; });
            selectedTaskIds.clear();
            if (typeof toast === 'function') toast(`mapped ${ids.length} task(s) to ${session || '(none)'}`);
            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
            await refresh();
        } catch (e) { alert('bulk map error: ' + e.message); }
    }
    async function dashAnalyzeGroup(session, btn) {
        if (btn) { btn.disabled = true; btn.textContent = '[ QUEUEING ]'; }
        try {
            const r = await fetch('/api/dispatcher/clickup/analyze-group', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ session }) });
            const d = await r.json(); console.log('[dashboard] group analyze queued', d.submitted);
            await refresh();
        } catch (e) { alert('analyze group error: ' + e.message); if (btn) btn.disabled = false; }
    }
    async function dashAnalyze(id, btn) {
        if (btn) { btn.disabled = true; btn.textContent = '[ ANALYZING ]'; }
        try { await fetch(`/api/dispatcher/clickup/task/${id}/analyze`, { method: 'POST', headers: jsonHeaders(), body: '{}' }); await refresh(); }
        catch (e) { alert('analyze error: ' + e.message); if (btn) btn.disabled = false; }
    }
    async function dashAnalyzeAll(btn) {
        if (!confirm('Analyze ALL assigned tasks? Each spawns a targeted check in the cc-tsrct-analyst session (serialized).')) return;
        if (btn) { btn.disabled = true; btn.textContent = '[ QUEUEING ]'; }
        try {
            const r = await fetch('/api/dispatcher/clickup/analyze-bulk', { method: 'POST', headers: jsonHeaders(), body: '{}' });
            const d = await r.json(); console.log('[dashboard] queued', d.submitted, 'analyses');
            await refresh();
        } catch (e) { alert('analyze-all error: ' + e.message); if (btn) btn.disabled = false; }
    }

    // ─── Worklogs actions (Increment 2) ─────────────────────────────────────
    async function dashWlGenerate(btn) {
        const start = (document.getElementById('dash-wl-start') || {}).value;
        const end = (document.getElementById('dash-wl-end') || {}).value;
        const hint = (document.getElementById('dash-wl-hint') || {}).value || '';
        if (!start || !end) { alert('pick a date range'); return; }
        if (btn) { btn.disabled = true; btn.textContent = '[ GENERATING ]'; }
        try {
            await fetch('/api/dispatcher/worklogs/generate', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ range_start: start, range_end: end, hours_hint: hint }) });
            await refresh();
        } catch (e) { alert('generate error: ' + e.message); if (btn) btn.disabled = false; }
    }
    // Kill the running analyst job and unstick the panel. Destructive enough to
    // confirm (it throws away however many minutes the analyst has already spent),
    // but nothing has been written to ClickUp at this stage, so there is nothing to undo.
    async function dashWlCancel(btn) {
        if (!confirm('Cancel worklog generation?\n\nThe running analyst job will be killed and its work discarded. Nothing has been written to ClickUp yet.')) return;
        if (btn) { btn.disabled = true; btn.textContent = '[ CANCELLING ]'; }
        try {
            const r = await fetch('/api/dispatcher/worklogs/cancel', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ batch_id: wlState.batch_id }) });
            const d = await r.json();
            if (d.error) alert('cancel error: ' + d.error);
            await refresh();
        } catch (e) {
            alert('cancel error: ' + e.message);
            if (btn) { btn.disabled = false; btn.textContent = '[ CANCEL ]'; }
        }
    }
    async function dashWlSave(id) {
        const g = (s) => document.getElementById(`dash-wl-${s}-${id}`);
        const body = {
            task_id: (g('task') || {}).value,
            hours: parseFloat((g('hours') || {}).value) || 0,
            comment: (g('comment') || {}).value,
            billable: (g('bill') || {}).checked,
        };
        try { await fetch(`/api/dispatcher/worklog/${id}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) }); }
        catch (e) { console.error('[dashboard] worklog save failed', e); }
    }
    async function dashWlLookup(id) {
        await dashWlSave(id); // persist the new task_id first (the server re-checks its state)
        const tid = (document.getElementById(`dash-wl-task-${id}`) || {}).value;
        if (!tid) return;
        try {
            const r = await fetch(`/api/dispatcher/clickup/task-lookup?id=${encodeURIComponent(tid)}`, { headers: tokenHeaders() });
            const d = await r.json();
            const el = document.getElementById(`dash-wl-tn-${id}`);
            if (d.task && el) { el.textContent = d.task.name || ''; await fetch(`/api/dispatcher/worklog/${id}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ task_name: d.task.name }) }); }
            else if (el) el.textContent = '(task id not found)';
            await refresh(); // redraw the live / closed / archived badge
        } catch (e) { console.error('[dashboard] lookup failed', e); }
    }
    async function loadWlLists(force) {
        if (wlLists && wlLists.length && !force) return;
        try { wlLists = (await (await fetch('/api/dispatcher/clickup/lists', { headers: tokenHeaders() })).json()).lists || []; }
        catch { wlLists = wlLists || []; }
    }
    // Switch a row to "create this task first" (on) or back to a task id (off).
    async function dashWlNewTask(id, on) {
        const x = (wlState.proposals || []).find(p => p.id === id) || {};
        let body;
        if (on) {
            await loadWlLists();
            // No list here on purpose: the server pre-picks the current task's list
            // when that list is still active.
            body = { new_task: { name: (x.comment || x.task_name || '').slice(0, 120), list_id: null, description: '' } };
        } else {
            body = { new_task: null };
        }
        try {
            const r = await fetch(`/api/dispatcher/worklog/${id}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
            const d = await r.json();
            if (d.error) alert(d.error);
            await refresh();
        } catch (e) { alert(e.message); }
    }
    async function dashWlSaveNewTask(id) {
        const v = (s) => (document.getElementById(`dash-wl-${s}-${id}`) || {}).value || '';
        const body = { new_task: { name: v('ntname'), list_id: v('ntlist') || null, description: v('ntdesc') } };
        if (!body.new_task.name.trim()) { alert('the new task needs a name'); return; }
        try {
            const r = await fetch(`/api/dispatcher/worklog/${id}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
            const d = await r.json();
            if (d.error) alert(d.error);
            else {
                // Keep local state in step so the 7s re-render does not flash the old values.
                const x = (wlState.proposals || []).find(p => p.id === id);
                if (x) x.new_task_json = JSON.stringify(body.new_task);
            }
        } catch (e) { console.error('[dashboard] new task save failed', e); }
    }
    async function dashWlDismiss(id, btn) {
        if (btn) btn.disabled = true;
        try { await fetch(`/api/dispatcher/worklog/${id}/dismiss`, { method: 'POST', headers: jsonHeaders(), body: '{}' }); await refresh(); }
        catch (e) { alert(e.message); }
    }
    async function dashWlCreateAll(btn) {
        if (!wlState.batch_id) return;
        const pend = (wlState.proposals || []).filter(x => x.status === 'proposed' || x.status === 'failed');
        const nts = pend.filter(x => wlNewTask(x));
        const noList = nts.filter(x => !wlNewTask(x).list_id).length;
        const blocked = pend.filter(x => !wlNewTask(x) && WL_BLOCKING.includes(x.task_state)).length;
        let msg = 'Create all pending worklogs as time entries in ClickUp? This cannot be undone via the API.';
        if (nts.length) msg += `\n\n${nts.length} of them first CREATE a new ClickUp task (assigned to you).`;
        if (noList) msg += `\n${noList} new task(s) have no list picked and will be skipped.`;
        if (blocked) msg += `\n${blocked} row(s) point at an archived or deleted task and will be skipped.`;
        if (!confirm(msg)) return;
        if (btn) { btn.disabled = true; btn.textContent = '[ CREATING ]'; }
        try {
            const r = await fetch('/api/dispatcher/worklogs/create', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ batch_id: wlState.batch_id }) });
            const d = await r.json();
            if (d.error) alert('create error: ' + d.error);
            else alert(`Created ${d.created}, failed ${d.failed}, skipped ${d.skipped}${d.tasks_created ? `, new tasks ${d.tasks_created}` : ''}.`);
            await refresh();
        } catch (e) { alert('create error: ' + e.message); if (btn) btn.disabled = false; }
    }

    // ─── Worklog [?] modal: where a suggestion came from ────────────────────
    // Lives on document.body, outside .dash-target, so the 7s re-render never touches it.
    const EV_STATUS = {
        found:           ['dash-ev-ok',   '[ok] it is in the file'],
        found_other_day: ['dash-ev-warn', '[~] it is in the file, but on another day'],
        not_found:       ['dash-ev-bad',  '[!] not found in the file: it may be misquoted'],
        no_file:         ['dash-ev-bad',  '[!] the file does not exist or cannot be opened'],
        too_short:       ['dash-ev-warn', '[?] quote too short to check'],
        not_checked:     ['dash-ev-muted', '[?] cannot be checked from here'],
    };
    function evRefLabel(ev) {
        const ref = String(ev.ref || '');
        const pathPart = ref.split(' @')[0];
        const sm = pathPart.match(new RegExp('\\.claude/projects/' + window.TSRCT_PROJECTS_ROOT.replace(/[\\/]/g, '-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-?([^/]*)/'));
        if (sm) return `Claude session: ${sm[1] || 'PROJECTS'}${ev.time ? ` @ ${ev.time}` : (ref.includes(' @') ? ` @ ${ref.split(' @')[1]}` : '')}`;
        const vm = pathPart.match(/\/vault\/(.+)$/);
        if (vm) return `vault: ${vm[1]}`;
        return ref;
    }
    function dashWlWhyClose() {
        const el = document.getElementById('dash-ev-overlay');
        if (el) el.remove();
        document.removeEventListener('keydown', evKey);
    }
    function evKey(e) { if (e.key === 'Escape') dashWlWhyClose(); }
    async function dashWlWhy(id) {
        dashWlWhyClose();
        const x = (wlState.proposals || []).find(p => p.id === id) || {};
        const ov = document.createElement('div');
        ov.id = 'dash-ev-overlay';
        ov.className = 'dash-ev-overlay dash-target-modal';
        ov.onclick = (e) => { if (e.target === ov) dashWlWhyClose(); };
        ov.innerHTML = `<div class="dash-ev-modal">
            <div class="dash-ev-head"><span>[?] WHERE THIS CAME FROM</span><button class="btn dash-btn dash-btn-mini" onclick="dashWlWhyClose()">[x]</button></div>
            <div class="dash-ev-entry">${escapeHtml(x.work_date || '')} &middot; ${escapeHtml(x.project || '')} &middot; ${escapeHtml(String(x.hours != null ? x.hours : ''))}h<div>${escapeHtml(x.comment || '')}</div></div>
            <div class="dash-ev-body"><div class="dash-verdict-running">[~] finding the evidence and checking each quote...</div></div>
        </div>`;
        document.body.appendChild(ov);
        document.addEventListener('keydown', evKey);
        const body = ov.querySelector('.dash-ev-body');
        try {
            const r = await fetch(`/api/dispatcher/worklog/${id}/evidence`, { headers: tokenHeaders() });
            const d = await r.json();
            if (!document.body.contains(ov)) return;          // closed while loading
            if (d.error) { body.innerHTML = `<div class="dash-wl-error">[!] ${escapeHtml(d.error)}</div>`; return; }
            let h = `<div class="dash-ev-why">${d.why ? escapeHtml(d.why)
                : 'Claude left no explanation for this suggestion (it was made before this button existed, or skipped it). Below is what a keyword search found.'}</div>`;
            if (d.evidence && d.evidence.length) {
                h += `<div class="dash-interp-label">WHAT CLAUDE QUOTED</div>`;
                for (const ev of d.evidence) {
                    const [cls, label] = EV_STATUS[ev.status] || EV_STATUS.not_checked;
                    h += `<div class="dash-ev-item">
                        <div class="dash-ev-ref">${escapeHtml(evRefLabel(ev))}${ev.status === 'found_other_day' && ev.found_date ? ` (${escapeHtml(ev.found_date)})` : ''}</div>
                        <blockquote>${escapeHtml(ev.quote || '')}</blockquote>
                        <div class="${cls}">${label}</div>
                    </div>`;
                }
            }
            const a = d.auto || {};
            if ((a.prompts && a.prompts.length) || (a.notes && a.notes.length)) {
                h += `<div class="dash-interp-label">FOUND THAT DAY BY KEYWORD <span class="dash-hrs-muted">(${escapeHtml((a.keywords || []).slice(0, 6).join(', '))}) - may not be exact</span></div>`;
                for (const p of a.prompts || []) {
                    h += `<div class="dash-ev-item"><div class="dash-ev-ref">${p.kind === 'title' ? 'session title' : 'what you asked'}: ${escapeHtml(p.project)}${p.time ? ` @ ${escapeHtml(p.time)}` : ''}</div><blockquote>${escapeHtml(p.text)}</blockquote></div>`;
                }
                for (const n of a.notes || []) {
                    h += `<div class="dash-ev-item"><div class="dash-ev-ref">vault: sessions/${escapeHtml(n.note)}</div><blockquote>${escapeHtml(n.text)}</blockquote></div>`;
                }
            } else if (!(d.evidence && d.evidence.length)) {
                h += `<div class="dash-empty">nothing from that day matches this worklog</div>`;
            }
            body.innerHTML = h;
        } catch (e) {
            if (document.body.contains(ov)) body.innerHTML = `<div class="dash-wl-error">[!] ${escapeHtml(e.message)}</div>`;
        }
    }

    // ─── Hours Recall actions ───────────────────────────────────────────────
    function dashWlForm() {
        const v = (id) => (document.getElementById(id) || {}).value || '';
        wlForm = { start: v('dash-wl-start'), end: v('dash-wl-end'), hint: v('dash-wl-hint') };
    }
    async function dashHrsScan(btn) {
        dashWlForm();
        if (!wlForm.start || !wlForm.end) { alert('pick a date range'); return; }
        if (wlForm.start > wlForm.end) { alert('"From" is after "To"'); return; }
        if (btn) { btn.disabled = true; btn.textContent = '[ SCANNING ]'; }
        hrsOpen = true;
        try {
            const d = await (await fetch('/api/dispatcher/hours/scan', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ range_start: wlForm.start, range_end: wlForm.end }) })).json();
            if (d.error) alert('scan error: ' + d.error);
            else if (d.started === false && d.reason && typeof toast === 'function') toast(d.reason);
            await refresh(); scheduleNext();
        } catch (e) { alert('scan error: ' + e.message); if (btn) btn.disabled = false; }
    }
    async function dashHrsAsk(btn) {
        if (btn) { btn.disabled = true; btn.textContent = '[ ASKING ]'; }
        try {
            const d = await (await fetch('/api/dispatcher/hours/ask', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ note: hrsNote }) })).json();
            if (d.started === false && d.reason) alert(d.reason);
            await refresh(); scheduleNext();
        } catch (e) { alert('ask error: ' + e.message); if (btn) btn.disabled = false; }
    }
    async function dashHrsCancel(btn) {
        if (btn) btn.disabled = true;
        try { await fetch('/api/dispatcher/hours/ask/cancel', { method: 'POST', headers: jsonHeaders(), body: '{}' }); await refresh(); }
        catch (e) { alert(e.message); }
    }
    function dashHrsToggle(date) { hrsExpanded[date] = !hrsExpanded[date]; render(); }
    function dashHrsProj(date, idx) {
        const day = (((hrs.scan || {}).result || {}).days || []).find(d => d.date === date);
        const p = day && day.projects[idx];
        if (!p) return;
        hrsOff[`${date}|${p.name}`] = hrsIncluded(date, p);   // flip
        delete hrsPick[date];                                  // typed hours no longer match the selection
        render();
    }
    function dashHrsPick(date, v) {
        const n = parseFloat(v);
        if (isFinite(n) && n >= 0) hrsPick[date] = n; else delete hrsPick[date];
        render();
    }
    function dashHrsRestricted(date, v) {
        const n = parseFloat(v);
        if (isFinite(n) && n > 0) hrsRestricted[date] = n; else delete hrsRestricted[date];
        render();
    }
    function dashHrsNote(v) { hrsNote = String(v || ''); }
    function dashHrsClose() { hrsOpen = false; render(); }
    // Hand the final numbers to the generator: range + "hours hint", ready for GENERATE.
    function dashHrsUse() {
        const r = (hrs.scan || {}).result;
        if (!r) return;
        const parts = [];
        for (const d of r.days) {
            const n = hrsDay(d, r.calibration);
            if (n.final > 0) parts.push(`${d.weekday} ${d.date} ${n.final}h${n.secretco ? ` (incl ${n.secretco}h SecretCo)` : ''}`);
        }
        wlForm = { start: r.dates[0], end: r.dates[r.dates.length - 1], hint: parts.join(', ') };
        if (typeof toast === 'function') toast('hours copied to the generator - press GENERATE');
        const ae = document.activeElement; if (ae && ae.blur) ae.blur();
        render();
    }

    // ─── Digest actions (Increment 3) ───────────────────────────────────────
    async function dashDigestGenerate(btn) {
        if (btn) { btn.disabled = true; btn.textContent = '[ GENERATING ]'; }
        try { await fetch('/api/dispatcher/digest/generate', { method: 'POST', headers: jsonHeaders(), body: '{}' }); await refresh(); }
        catch (e) { alert('digest error: ' + e.message); if (btn) btn.disabled = false; }
    }
    async function dashNoteRoute(btn) {
        const ta = document.getElementById('dash-note-text');
        const note = ta ? ta.value.trim() : '';
        if (!note) { alert('paste a note first'); return; }
        if (btn) { btn.disabled = true; btn.textContent = '[ ROUTING ]'; }
        try { await fetch('/api/dispatcher/notes/route', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ note }) }); if (ta) ta.value = ''; await refresh(); }
        catch (e) { alert('route error: ' + e.message); if (btn) btn.disabled = false; }
    }
    async function dashNoteApprove(id, btn) {
        const path = (document.getElementById(`dash-note-path-${id}`) || {}).value;
        const content = (document.getElementById(`dash-note-content-${id}`) || {}).value;
        if (!path || !content) { alert('path and content required'); return; }
        if (!confirm(`Write this note to ${path}?`)) return;
        if (btn) { btn.disabled = true; btn.textContent = '[ WRITING ]'; }
        try {
            const r = await fetch(`/api/dispatcher/note/${id}/approve`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ path, content }) });
            const d = await r.json();
            if (d.error) { alert('write error: ' + d.error); if (btn) btn.disabled = false; return; }
            await refresh();
        } catch (e) { alert('write error: ' + e.message); if (btn) btn.disabled = false; }
    }
    async function dashNoteDismiss(id, btn) {
        if (btn) btn.disabled = true;
        try { await fetch(`/api/dispatcher/note/${id}/dismiss`, { method: 'POST', headers: jsonHeaders(), body: '{}' }); await refresh(); }
        catch (e) { alert(e.message); }
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────
    // Self-scheduling poll: tightens to ~2.5s while the analyst is working (so the
    // live feed feels real-time), relaxes to 7s otherwise.
    function scheduleNext() {
        if (dashPolling) clearTimeout(dashPolling);
        if (dashRefCount === 0) { dashPolling = null; return; }
        const busy = (dashView === 'tasks' && tasks.some(t => t.analyzing))
            || (dashView === 'worklogs' && hrsOpen && hrs && ((hrs.scan && hrs.scan.running) || (hrs.ai && hrs.ai.running)));
        dashPolling = setTimeout(tickPoll, busy ? 2500 : 7000);
    }
    async function tickPoll() { await refresh(); scheduleNext(); }
    async function dashInit() {
        dashRefCount++;
        await refresh();
        scheduleNext();
    }
    function dashTeardown() {
        dashRefCount = Math.max(0, dashRefCount - 1);
        if (dashRefCount === 0 && dashPolling) { clearTimeout(dashPolling); dashPolling = null; }
    }

    window.dashInit = dashInit;
    window.dashTeardown = dashTeardown;
    window.dashSwitchView = dashSwitchView;
    // inbox
    window.dashInboxToggle = dashInboxToggle;
    window.dashInboxSeen = dashInboxSeen;
    window.dashInboxSeenAll = dashInboxSeenAll;
    window.dashInboxRefresh = dashInboxRefresh;
    // token config
    window.dashSaveToken = dashSaveToken;
    window.dashToggleTokenPanel = dashToggleTokenPanel;
    // tasks
    window.dashSync = dashSync;
    window.dashSaveInterpretation = dashSaveInterpretation;
    window.dashConfirmInterp = dashConfirmInterp;
    window.dashMapSession = dashMapSession;
    window.dashPropose = dashPropose;
    window.dashAnalyze = dashAnalyze;
    window.dashAnalyzeAll = dashAnalyzeAll;
    window.dashToggleSelect = dashToggleSelect;
    window.dashClearSelect = dashClearSelect;
    window.dashGroupToggle = dashGroupToggle;
    window.dashGroupToggleAll = dashGroupToggleAll;
    window.dashBulkMap = dashBulkMap;
    window.dashAnalyzeGroup = dashAnalyzeGroup;
    // worklogs
    window.dashWlGenerate = dashWlGenerate;
    window.dashWlCancel = dashWlCancel;
    window.dashWlSave = dashWlSave;
    window.dashWlLookup = dashWlLookup;
    window.dashWlNewTask = dashWlNewTask;
    window.dashWlSaveNewTask = dashWlSaveNewTask;
    window.dashWlDismiss = dashWlDismiss;
    window.dashWlCreateAll = dashWlCreateAll;
    window.dashWlForm = dashWlForm;
    window.dashWlWhy = dashWlWhy;
    window.dashWlWhyClose = dashWlWhyClose;
    // hours recall
    window.dashHrsScan = dashHrsScan;
    window.dashHrsAsk = dashHrsAsk;
    window.dashHrsCancel = dashHrsCancel;
    window.dashHrsToggle = dashHrsToggle;
    window.dashHrsProj = dashHrsProj;
    window.dashHrsPick = dashHrsPick;
    window.dashHrsRestricted = dashHrsRestricted;
    window.dashHrsNote = dashHrsNote;
    window.dashHrsClose = dashHrsClose;
    window.dashHrsUse = dashHrsUse;
    // digest
    window.dashDigestGenerate = dashDigestGenerate;
    window.dashNoteRoute = dashNoteRoute;
    window.dashNoteApprove = dashNoteApprove;
    window.dashNoteDismiss = dashNoteDismiss;
})();
