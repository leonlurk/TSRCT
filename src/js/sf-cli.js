// ==============================================
// TSRCT - SF CLI (Sidebar Section)
// Salesforce org management, SOQL/Apex via modals
// Phase 3B: IIFE-wrapped -- interior is private; explicit window exports at bottom.
// ==============================================
(function () {

// State
let sfWorkspaces = [];
let sfOrgs = [];
let sfActiveWsId = '';
let sfOrgHealthCache = {};
let sfHealthPoller = null;
let sfEditingWsId = null; // null = create, string = edit

// ── API Helpers ──────────────────────────────────────────────────

async function sfFetch(url, opts = {}) {
    const headers = { Authorization: token, 'Content-Type': 'application/json', ...opts.headers };
    const r = await fetch(url, { ...opts, headers });
    return r.json();
}

async function sfLoadOrgs() {
    try {
        const data = await sfFetch('/api/sf/orgs');
        const result = data.result || data;
        sfOrgs = [
            ...(result.nonScratchOrgs || []),
            ...(result.scratchOrgs || [])
        ];
    } catch (e) {
        sfOrgs = [];
    }
}

async function sfLoadWorkspaceList() {
    try {
        const data = await sfFetch('/api/sf/workspaces');
        sfWorkspaces = data.workspaces || [];
    } catch (e) {
        sfWorkspaces = [];
    }
}

async function sfCheckOrgHealth(alias) {
    const safeAlias = encodeURIComponent(alias);
    const data = await sfFetch(`/api/sf/org/${safeAlias}/health`);
    sfOrgHealthCache[alias] = {
        connected: data.connected,
        details: data.details || {},
        checkedAt: Date.now()
    };
    return data;
}

async function sfOpenOrg(alias) {
    const data = await sfFetch(`/api/sf/org/${encodeURIComponent(alias)}/open`, { method: 'POST' });
    if (data.url) window.open(data.url, '_blank');
    return data;
}

// ── Sidebar Rendering ────────────────────────────────────────────

function sfGetActiveWorkspace() {
    return sfWorkspaces.find(w => w.id === sfActiveWsId) || null;
}

function sfRenderSidebar() {
    // Update workspace dropdown
    const sel = $('pc-sf-workspace');
    if (!sel) return;

    const prev = sel.value;
    sel.innerHTML = '<option value="">-- Select Workspace --</option>';
    sfWorkspaces.forEach(ws => {
        const opt = document.createElement('option');
        opt.value = ws.id;
        opt.textContent = ws.name;
        if (ws.id === sfActiveWsId) opt.selected = true;
        sel.appendChild(opt);
    });
    if (!sfActiveWsId && prev) sfActiveWsId = prev;

    // Render org list
    sfRenderOrgs();
}

function sfRenderOrgs() {
    const container = $('pc-sf-orgs');
    const quick = $('pc-sf-quick');
    if (!container) return;

    const ws = sfGetActiveWorkspace();
    if (!ws) {
        container.innerHTML = '<div class="pc-sf-empty">No workspace selected</div>';
        if (quick) quick.style.display = 'none';
        return;
    }

    if (quick) quick.style.display = '';

    // Always show add button
    let html = '<div class="pc-sf-org-toolbar"><button onclick="sfShowAddOrgModal()" title="Add org to workspace">[+] Add Org</button></div>';

    if (!ws.orgs || ws.orgs.length === 0) {
        container.innerHTML = html + '<div class="pc-sf-empty">No orgs in workspace</div>';
        return;
    }

    html += ws.orgs.map(alias => {
        const h = sfOrgHealthCache[alias];
        const org = sfOrgs.find(o => (o.alias || o.username) === alias);
        const username = org ? org.username : '';
        const statusCls = h ? (h.connected ? 'ok' : 'err') : 'unk';
        const statusTxt = h ? (h.connected ? 'OK' : 'EXP') : '...';

        return `
            <div class="pc-sf-org">
                <span class="pc-sf-dot pc-sf-dot-${statusCls}"></span>
                <span class="pc-sf-org-alias">${alias}</span>
                <span class="pc-sf-org-status pc-sf-st-${statusCls}">${statusTxt}</span>
                <div class="pc-sf-org-acts">
                    <button onclick="sfOpenOrg('${alias}')" title="Open in browser">[>]</button>
                    <button onclick="sfCheckOrgHealth('${alias}').then(()=>sfRenderOrgs())" title="Check health">[?]</button>
                    <button onclick="sfSidebarRemoveOrg('${alias}')" title="Remove">[x]</button>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

async function sfSwitchWorkspaceSidebar(wsId) {
    sfActiveWsId = wsId;
    // Reload fresh data on every switch
    await Promise.all([sfLoadOrgs(), sfLoadWorkspaceList()]);
    sfRenderOrgs();
    if (wsId) {
        const ws = sfGetActiveWorkspace();
        if (ws) {
            ws.orgs.forEach(alias => {
                sfCheckOrgHealth(alias).then(() => sfRenderOrgs()).catch(() => {});
            });
        }
    }
}

function sfToggleCollapse() {
    const panel = $('pc-sf-panel');
    const section = panel ? panel.closest('.pc-sf-section') : null;
    if (section) section.classList.toggle('collapsed');
}

async function sfRefreshSidebar() {
    await Promise.all([sfLoadOrgs(), sfLoadWorkspaceList()]);
    sfRenderSidebar();
    if (typeof toast === 'function') toast('SF CLI refreshed', 'success');
}

async function sfSidebarRemoveOrg(alias) {
    if (!sfActiveWsId || !confirm(`Remove ${alias}?`)) return;
    await sfFetch(`/api/sf/workspaces/${encodeURIComponent(sfActiveWsId)}/orgs/${encodeURIComponent(alias)}`, { method: 'DELETE' });
    await sfLoadWorkspaceList();
    sfRenderSidebar();
    if (typeof toast === 'function') toast(`Removed ${alias}`, 'success');
}

// ── Modal Helpers ────────────────────────────────────────────────

function sfCloseModal(id) {
    const el = $(id);
    if (el) el.classList.add('hidden');
}

function sfOpenModal(id) {
    const el = $(id);
    if (el) el.classList.remove('hidden');
}

// Populate org selector in SOQL/Apex modals
function sfPopulateOrgSelectors() {
    const ws = sfGetActiveWorkspace();
    const orgs = ws ? ws.orgs : sfOrgs.map(o => o.alias || o.username);

    ['sf-m-soql-org', 'sf-m-apex-org'].forEach(selId => {
        const sel = $(selId);
        if (!sel) return;
        sel.innerHTML = '';
        orgs.forEach(alias => {
            const opt = document.createElement('option');
            opt.value = alias;
            opt.textContent = alias;
            sel.appendChild(opt);
        });
    });
}

// ── SOQL Modal ───────────────────────────────────────────────────

function sfShowSOQLModal() {
    sfPopulateOrgSelectors();

    // Load bookmarks
    const bmContainer = $('sf-m-soql-bookmarks');
    if (bmContainer) {
        const ws = sfGetActiveWorkspace();
        if (ws && ws.soqlBookmarks && ws.soqlBookmarks.length > 0) {
            bmContainer.innerHTML = ws.soqlBookmarks.map((bm, i) => {
                return `<button class="sf-modal-bookmark" onclick="sfModalLoadBookmark(${i})">${bm.name}</button>`;
            }).join('');
        } else {
            bmContainer.innerHTML = '';
        }
    }

    sfOpenModal('sf-soql-modal');
}

function sfModalLoadBookmark(idx) {
    const ws = sfGetActiveWorkspace();
    if (!ws || !ws.soqlBookmarks) return;
    const bm = ws.soqlBookmarks[idx];
    if (!bm) return;
    const input = $('sf-m-soql-input');
    if (input) input.value = bm.query;
}

async function sfModalExecuteSOQL() {
    const orgSel = $('sf-m-soql-org');
    const input = $('sf-m-soql-input');
    const resultEl = $('sf-m-soql-result');
    if (!orgSel || !input || !resultEl) return;

    const alias = orgSel.value;
    const query = input.value.trim();
    if (!alias || !query) return;

    resultEl.innerHTML = '<div class="sf-modal-loading">Executing query...</div>';

    try {
        const data = await sfFetch('/api/sf/query', {
            method: 'POST',
            body: JSON.stringify({ alias, query })
        });

        if (data.status !== 0 && data.message) {
            resultEl.innerHTML = `<div class="sf-modal-error">[!] ${data.message}</div>`;
            return;
        }

        const records = data.result?.records || [];
        if (records.length === 0) {
            resultEl.innerHTML = '<div class="sf-modal-empty">No records returned</div>';
            return;
        }

        const fields = Object.keys(records[0]).filter(k => k !== 'attributes');
        const totalSize = data.result?.totalSize || records.length;

        let html = `<div class="sf-modal-meta">${totalSize} record${totalSize !== 1 ? 's' : ''}</div>`;
        html += '<div class="sf-modal-table-wrap"><table class="sf-modal-table"><thead><tr>';
        fields.forEach(f => { html += `<th>${f}</th>`; });
        html += '</tr></thead><tbody>';
        records.forEach(rec => {
            html += '<tr>';
            fields.forEach(f => {
                let val = rec[f];
                if (val && typeof val === 'object') val = JSON.stringify(val);
                html += `<td>${val != null ? val : ''}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        resultEl.innerHTML = html;
    } catch (e) {
        resultEl.innerHTML = `<div class="sf-modal-error">[!] ${e.message}</div>`;
    }
}

// ── Apex Modal ───────────────────────────────────────────────────

function sfShowApexModal() {
    sfPopulateOrgSelectors();
    sfOpenModal('sf-apex-modal');
}

async function sfModalExecuteApex() {
    const orgSel = $('sf-m-apex-org');
    const input = $('sf-m-apex-input');
    const resultEl = $('sf-m-apex-result');
    if (!orgSel || !input || !resultEl) return;

    const alias = orgSel.value;
    const code = input.value.trim();
    if (!alias || !code) return;

    resultEl.innerHTML = '<div class="sf-modal-loading">Running Apex...</div>';

    try {
        const data = await sfFetch('/api/sf/apex/run', {
            method: 'POST',
            body: JSON.stringify({ alias, code })
        });

        if (data.status !== 0 && data.message) {
            resultEl.innerHTML = `<div class="sf-modal-error">[!] ${data.message}</div>`;
            return;
        }

        const result = data.result || data;
        const logs = result.logs || result.log || '';
        const success = result.success !== false;

        resultEl.innerHTML = `
            <div class="sf-modal-meta">${success ? 'SUCCESS' : 'FAILED'}</div>
            ${result.compileProblem ? `<div class="sf-modal-error">[!] Compile: ${result.compileProblem}</div>` : ''}
            ${result.exceptionMessage ? `<div class="sf-modal-error">[!] Exception: ${result.exceptionMessage}</div>` : ''}
            <pre class="sf-modal-log">${logs || 'No debug output'}</pre>
        `;
    } catch (e) {
        resultEl.innerHTML = `<div class="sf-modal-error">[!] ${e.message}</div>`;
    }
}

// ── Workspace Create/Edit Modal ──────────────────────────────────

function sfShowCreateModal() {
    sfEditingWsId = null;
    const title = $('sf-ws-modal-title');
    const saveBtn = $('sf-m-ws-save');
    const idInput = $('sf-m-ws-id');
    if (title) title.textContent = 'NEW WORKSPACE';
    if (saveBtn) { saveBtn.textContent = '[+] CREATE'; saveBtn.onclick = sfModalSaveWorkspace; }
    if (idInput) { idInput.value = ''; idInput.disabled = false; }

    $('sf-m-ws-name').value = '';
    $('sf-m-ws-theme').value = 'default';
    $('sf-m-ws-path').value = '';
    $('sf-m-ws-recon').checked = false;

    const bmWrap = $('sf-m-ws-bookmarks-wrap');
    if (bmWrap) bmWrap.classList.add('hidden');
    const bmList = $('sf-m-ws-bookmarks');
    if (bmList) bmList.innerHTML = '';

    sfOpenModal('sf-ws-modal');
}

function sfShowEditModal() {
    const ws = sfGetActiveWorkspace();
    if (!ws) {
        if (typeof toast === 'function') toast('Select a workspace first', 'warn');
        return;
    }

    sfEditingWsId = ws.id;
    const title = $('sf-ws-modal-title');
    const saveBtn = $('sf-m-ws-save');
    const idInput = $('sf-m-ws-id');
    if (title) title.textContent = 'EDIT: ' + ws.name;
    if (saveBtn) { saveBtn.textContent = '[S] SAVE'; saveBtn.onclick = sfModalSaveWorkspace; }
    if (idInput) { idInput.value = ws.id; idInput.disabled = true; }

    $('sf-m-ws-name').value = ws.name;
    $('sf-m-ws-theme').value = ws.theme || 'default';
    $('sf-m-ws-path').value = ws.projectPath || '';
    $('sf-m-ws-recon').checked = !!(ws.extensions && ws.extensions.recon);

    // Show bookmarks
    const bmWrap = $('sf-m-ws-bookmarks-wrap');
    const bmList = $('sf-m-ws-bookmarks');
    if (bmWrap) bmWrap.classList.remove('hidden');
    if (bmList) {
        bmList.innerHTML = (ws.soqlBookmarks || []).map(() => '').join('');
        bmList.innerHTML = '';
        (ws.soqlBookmarks || []).forEach(bm => {
            sfModalAddBookmark(bm.name, bm.query);
        });
    }

    sfOpenModal('sf-ws-modal');
}

function sfModalAddBookmark(name, query) {
    const container = $('sf-m-ws-bookmarks');
    if (!container) return;
    const bmWrap = $('sf-m-ws-bookmarks-wrap');
    if (bmWrap) bmWrap.classList.remove('hidden');

    const div = document.createElement('div');
    div.className = 'sf-modal-bm-row';
    div.innerHTML = `
        <input type="text" class="sf-modal-input sf-m-bm-name" value="${name || ''}" placeholder="Name" style="width:120px;flex-shrink:0">
        <textarea class="sf-modal-textarea sf-m-bm-query" rows="2" placeholder="SOQL" style="flex:1">${query || ''}</textarea>
        <button class="sf-modal-btn" onclick="this.parentElement.remove()" style="padding:4px 8px">[x]</button>
    `;
    container.appendChild(div);
}

async function sfModalSaveWorkspace() {
    const id = sfEditingWsId || ($('sf-m-ws-id') || {}).value;
    const name = ($('sf-m-ws-name') || {}).value;
    const theme = ($('sf-m-ws-theme') || {}).value;
    const projectPath = ($('sf-m-ws-path') || {}).value;
    const recon = ($('sf-m-ws-recon') || {}).checked;

    if (!id || !name) {
        if (typeof toast === 'function') toast('ID and name required', 'error');
        return;
    }

    // Collect bookmarks
    const bmEls = document.querySelectorAll('#sf-m-ws-bookmarks .sf-modal-bm-row');
    const soqlBookmarks = [];
    bmEls.forEach(el => {
        const n = el.querySelector('.sf-m-bm-name');
        const q = el.querySelector('.sf-m-bm-query');
        if (n && q && n.value.trim()) {
            soqlBookmarks.push({ name: n.value.trim(), query: q.value.trim() });
        }
    });

    // Keep existing orgs if editing
    const existing = sfWorkspaces.find(w => w.id === id);
    const orgs = existing ? existing.orgs : [];

    await sfFetch('/api/sf/workspaces', {
        method: 'POST',
        body: JSON.stringify({
            id, name, theme, projectPath, orgs, soqlBookmarks,
            extensions: { recon: !!recon }
        })
    });

    sfCloseModal('sf-ws-modal');
    await sfLoadWorkspaceList();
    if (!sfActiveWsId) sfActiveWsId = id;
    sfRenderSidebar();
    if (typeof toast === 'function') toast(sfEditingWsId ? 'Workspace updated' : `Workspace "${name}" created`, 'success');
}

// ── Add Org Modal ────────────────────────────────────────────────

async function sfShowAddOrgModal() {
    const ws = sfGetActiveWorkspace();
    if (!ws) return;

    // Refresh org list before showing
    await sfLoadOrgs();

    const assigned = new Set(ws.orgs || []);
    const available = sfOrgs.filter(o => !assigned.has(o.alias || o.username));
    const list = $('sf-addorg-list');
    if (!list) return;

    // Login button always at top
    let html = `<button class="modal-btn" style="border-color:#00a8ff" onclick="sfCloseModal('sf-addorg-modal');sfShowLoginModal()">
        <span class="modal-btn-title" style="color:#00a8ff">[L] Login New Org</span>
        <span class="modal-btn-desc">Authenticate a new Salesforce org via browser</span>
    </button>`;

    if (available.length === 0) {
        html += '<div class="sf-modal-empty">No other authenticated orgs to add</div>';
    } else {
        html += available.map(o => {
            const alias = o.alias || o.username;
            return `<button class="modal-btn" onclick="sfModalAddOrg('${alias}')">
                <span class="modal-btn-title">${alias}</span>
                <span class="modal-btn-desc">${o.username || ''}</span>
            </button>`;
        }).join('');
    }

    list.innerHTML = html;
    sfOpenModal('sf-addorg-modal');
}

async function sfModalAddOrg(alias) {
    if (!sfActiveWsId) return;
    await sfFetch(`/api/sf/workspaces/${encodeURIComponent(sfActiveWsId)}/orgs`, {
        method: 'POST',
        body: JSON.stringify({ alias })
    });
    sfCloseModal('sf-addorg-modal');
    await sfLoadWorkspaceList();
    sfRenderSidebar();
    sfCheckOrgHealth(alias).then(() => sfRenderOrgs()).catch(() => {});
    if (typeof toast === 'function') toast(`Added ${alias}`, 'success');
}

function sfModalClearResult(id) {
    const el = $(id);
    if (el) el.innerHTML = '';
}

// ── Org Login ────────────────────────────────────────────────────

function sfShowLoginModal() {
    const aliasInput = $('sf-login-alias');
    const instanceInput = $('sf-login-instance');
    const status = $('sf-login-status');
    if (aliasInput) aliasInput.value = '';
    if (instanceInput) instanceInput.value = '';
    if (status) status.innerHTML = '';
    sfOpenModal('sf-login-modal');
}

async function sfDoLogin() {
    const alias = ($('sf-login-alias') || {}).value.trim();
    if (!alias) {
        if (typeof toast === 'function') toast('Alias required', 'error');
        return;
    }

    const instanceUrl = ($('sf-login-instance') || {}).value.trim();
    const status = $('sf-login-status');
    if (status) status.innerHTML = '<div class="sf-modal-loading">Opening browser for login...</div>';

    try {
        const data = await sfFetch(`/api/sf/org/${encodeURIComponent(alias)}/login`, {
            method: 'POST',
            body: JSON.stringify({ instanceUrl: instanceUrl || undefined })
        });

        if (data.success) {
            if (status) status.innerHTML = '<div class="sf-modal-meta">Browser opened. Complete login there, then click Refresh below.</div>' +
                '<button class="sf-modal-btn" onclick="sfAfterLogin()" style="margin-top:8px">[~] REFRESH ORGS</button>';
            if (typeof toast === 'function') toast('Browser opened for login', 'success');
        } else {
            if (status) status.innerHTML = `<div class="sf-modal-error">[!] ${data.error || 'Login failed'}</div>`;
        }
    } catch (e) {
        if (status) status.innerHTML = `<div class="sf-modal-error">[!] ${e.message}</div>`;
    }
}

async function sfAfterLogin() {
    await Promise.all([sfLoadOrgs(), sfLoadWorkspaceList()]);
    // Update sidebar if in desktop mode
    if (typeof sfRenderSidebar === 'function' && $('pc-sf-workspace')) sfRenderSidebar();
    // Update mobile room if open
    if ($('sfcli-body')) sfRenderMobileRoom();
    sfCloseModal('sf-login-modal');
    if (typeof toast === 'function') toast('Orgs refreshed', 'success');
}

// ── Mobile Room Rendering ────────────────────────────────────────

function sfRenderMobileRoom() {
    const body = $('sfcli-body');
    if (!body) return;

    if (sfActiveWsId && sfGetActiveWorkspace()) {
        sfRenderMobileWorkspaceDetail(body);
    } else {
        sfRenderMobileWorkspaceList(body);
    }
}

function sfRenderMobileWorkspaceList(body) {
    const cards = sfWorkspaces.map(ws => {
        const orgCount = ws.orgs ? ws.orgs.length : 0;
        const healthDots = (ws.orgs || []).map(alias => {
            const h = sfOrgHealthCache[alias];
            const color = h ? (h.connected ? '#00ff41' : '#ff0040') : '#555';
            return `<span class="sf-health-dot" style="background:${color}"></span>`;
        }).join('');

        return `
            <div class="sf-ws-card" onclick="sfMobileOpenWs('${ws.id}')">
                <div class="sf-ws-card-header">
                    <span class="sf-ws-name">${ws.name}</span>
                    <span class="sf-ws-org-count">${orgCount} org${orgCount !== 1 ? 's' : ''}</span>
                </div>
                <div class="sf-ws-card-health">${healthDots}</div>
                ${ws.projectPath ? `<div class="sf-ws-card-path">${ws.projectPath}</div>` : ''}
            </div>
        `;
    }).join('');

    body.innerHTML = `
        <div class="sf-ws-list">
            <div class="sf-toolbar">
                <button class="sf-btn" onclick="sfShowCreateModal()">[+] NEW</button>
                <button class="sf-btn" onclick="sfMobileRefresh()">[~] REFRESH</button>
            </div>
            <div class="sf-ws-grid">${cards || '<div class="sf-empty">No workspaces</div>'}</div>
        </div>
    `;
}

function sfRenderMobileWorkspaceDetail(body) {
    const ws = sfGetActiveWorkspace();
    if (!ws) return;

    const orgCards = (ws.orgs || []).map(alias => {
        const h = sfOrgHealthCache[alias];
        const org = sfOrgs.find(o => (o.alias || o.username) === alias);
        const username = org ? org.username : alias;
        const statusCls = h ? (h.connected ? 'sf-status-ok' : 'sf-status-err') : 'sf-status-unknown';
        const statusTxt = h ? (h.connected ? 'OK' : 'EXP') : '...';

        return `
            <div class="sf-org-card">
                <div class="sf-org-header">
                    <span class="sf-org-status ${statusCls}"></span>
                    <span class="sf-org-alias">${alias}</span>
                    <span class="sf-org-status-text ${statusCls}">${statusTxt}</span>
                </div>
                <div class="sf-org-username">${username}</div>
                <div class="sf-org-actions">
                    <button class="sf-btn-sm" onclick="sfOpenOrg('${alias}')">[>] Open</button>
                    <button class="sf-btn-sm" onclick="sfCheckOrgHealth('${alias}').then(()=>sfRenderMobileRoom())">[?] Check</button>
                    <button class="sf-btn-sm sf-btn-danger" onclick="sfMobileRemoveOrg('${alias}')">[x]</button>
                </div>
            </div>
        `;
    }).join('');

    body.innerHTML = `
        <div class="sf-ws-detail">
            <div class="sf-detail-header">
                <button class="sf-btn" onclick="sfMobileBack()">[<] BACK</button>
                <span class="sf-detail-title">${ws.name}</span>
                <button class="sf-btn" onclick="sfShowEditModal()">[E]</button>
            </div>
            <div class="sf-section" style="margin:8px">
                <div class="sf-section-title">ORGS
                    <button class="sf-btn-sm" onclick="sfShowAddOrgModal()">[+]</button>
                    <button class="sf-btn-sm" onclick="sfMobileCheckAll()">[?] All</button>
                </div>
                <div class="sf-org-grid">${orgCards || '<div class="sf-empty">No orgs</div>'}</div>
            </div>
            <div style="display:flex;gap:6px;padding:0 8px 8px">
                <button class="sf-btn sf-btn-primary" onclick="sfShowSOQLModal()" style="flex:1">[Q] SOQL</button>
                <button class="sf-btn sf-btn-primary" onclick="sfShowApexModal()" style="flex:1">[A] Apex</button>
            </div>
        </div>
    `;
}

function sfMobileOpenWs(wsId) {
    sfActiveWsId = wsId;
    sfRenderMobileRoom();
    const ws = sfGetActiveWorkspace();
    if (ws) ws.orgs.forEach(a => sfCheckOrgHealth(a).then(() => sfRenderMobileRoom()).catch(() => {}));
}

function sfMobileBack() {
    sfActiveWsId = '';
    sfRenderMobileRoom();
}

async function sfMobileRefresh() {
    const body = $('sfcli-body');
    if (body) body.innerHTML = '<div class="sf-loading">Loading...</div>';
    await Promise.all([sfLoadOrgs(), sfLoadWorkspaceList()]);
    sfRenderMobileRoom();
    if (typeof toast === 'function') toast('SF CLI refreshed', 'success');
}

async function sfMobileRemoveOrg(alias) {
    if (!sfActiveWsId || !confirm(`Remove ${alias}?`)) return;
    await sfFetch(`/api/sf/workspaces/${encodeURIComponent(sfActiveWsId)}/orgs/${encodeURIComponent(alias)}`, { method: 'DELETE' });
    await sfLoadWorkspaceList();
    sfRenderMobileRoom();
}

async function sfMobileCheckAll() {
    const ws = sfGetActiveWorkspace();
    if (!ws) return;
    await Promise.all(ws.orgs.map(a => sfCheckOrgHealth(a).catch(() => {})));
    sfRenderMobileRoom();
}

// ── Mobile Org Attach Picker ─────────────────────────────────────

function showOrgAttachPickerImpl() {
    // Ensure orgs are loaded
    if (sfOrgs.length === 0 && sfWorkspaces.length === 0) {
        Promise.all([sfLoadOrgs(), sfLoadWorkspaceList()]).then(() => showOrgAttachPickerUI());
    } else {
        showOrgAttachPickerUI();
    }
}

function showOrgAttachPickerUI() {
    // Gather all available orgs: workspace orgs first
    const orgList = [];
    const seen = new Set();

    sfWorkspaces.forEach(ws => {
        (ws.orgs || []).forEach(alias => {
            if (!seen.has(alias)) {
                seen.add(alias);
                orgList.push({ alias, workspace: ws.name });
            }
        });
    });

    sfOrgs.forEach(o => {
        const alias = o.alias || o.username;
        if (!seen.has(alias)) {
            seen.add(alias);
            orgList.push({ alias, workspace: '' });
        }
    });

    if (orgList.length === 0) {
        if (typeof toast === 'function') toast('No SF orgs available', 'warn');
        return;
    }

    let overlay = document.getElementById('org-attach-picker');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'org-attach-picker';
        overlay.className = 'modal-overlay';
        overlay.onclick = function(e) { if (e.target === overlay) overlay.classList.add('hidden'); };
        document.body.appendChild(overlay);
    }

    const alreadyAttached = new Set((typeof attachedOrgs !== 'undefined' ? attachedOrgs : []).map(o => o.alias));

    overlay.innerHTML = `<div class="modal" style="max-width:350px" onclick="event.stopPropagation()">
        <div class="modal-header" style="color:#00a8ff">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            ATTACH SF ORG
        </div>
        <div class="modal-body" style="padding:8px;max-height:60vh;overflow-y:auto">
            ${orgList.map(o => {
                const attached = alreadyAttached.has(o.alias);
                const wsLabel = o.workspace ? ` (${o.workspace})` : '';
                return `<button class="modal-btn" style="border-color:${attached ? '#00a8ff' : 'var(--border)'}" onclick="pickOrgAttach('${o.alias}','${o.workspace}')">
                    <span class="modal-btn-title" style="color:${attached ? '#00a8ff' : 'var(--text)'}">${attached ? '[+] ' : ''}${o.alias}${wsLabel}</span>
                    <span class="modal-btn-desc">${attached ? '(attached)' : 'tap to attach'}</span>
                </button>`;
            }).join('')}
        </div>
        <button class="modal-close" onclick="document.getElementById('org-attach-picker').classList.add('hidden')">CLOSE</button>
    </div>`;
    overlay.classList.remove('hidden');
}

function pickOrgAttach(alias, workspace) {
    if (typeof attachedOrgs === 'undefined') return;

    const already = attachedOrgs.some(o => o.alias === alias);
    if (already) {
        const idx = attachedOrgs.findIndex(o => o.alias === alias);
        attachedOrgs.splice(idx, 1);
        if (typeof toast === 'function') toast('ORG DETACHED: ' + alias, 'warn');
    } else {
        attachedOrgs.push({ alias, workspace });
        if (typeof toast === 'function') toast('ORG ATTACHED: ' + alias, 'success');
    }

    if (typeof updateAttachmentIndicator === 'function') updateAttachmentIndicator();
    // Re-render picker to reflect toggle
    showOrgAttachPickerUI();
}

// ── Init (called when desktop mode activates) ────────────────────

async function sfInitSidebar() {
    await Promise.all([sfLoadOrgs(), sfLoadWorkspaceList()]);

    // Auto-select first workspace if available
    if (sfWorkspaces.length > 0 && !sfActiveWsId) {
        sfActiveWsId = sfWorkspaces[0].id;
    }

    sfRenderSidebar();

    // Check health for active workspace orgs
    const ws = sfGetActiveWorkspace();
    if (ws) {
        ws.orgs.forEach(alias => {
            sfCheckOrgHealth(alias).then(() => sfRenderOrgs()).catch(() => {});
        });
    }

    // Periodic health check (5 min)
    if (sfHealthPoller) clearInterval(sfHealthPoller);
    sfHealthPoller = setInterval(() => {
        const w = sfGetActiveWorkspace();
        if (w) w.orgs.forEach(a => sfCheckOrgHealth(a).then(() => sfRenderOrgs()).catch(() => {}));
    }, 5 * 60 * 1000);
}

// ── Mobile Room Lifecycle ────────────────────────────────────────

async function sfOnRoomOpen() {
    const body = $('sfcli-body');
    if (body) body.innerHTML = '<div class="sf-loading">Connecting to SF CLI...</div>';
    await Promise.all([sfLoadOrgs(), sfLoadWorkspaceList()]);
    sfRenderMobileRoom();
}

// Called after script loads -- register room + init sidebar if in pc-mode
function sfBootstrap() {
    WorldManager.onRoomOpen('sfcli', sfOnRoomOpen);
    if (document.body.classList.contains('pc-mode') && $('pc-sf-workspace')) {
        sfInitSidebar();
    }
}

// ── Public API (Phase 3B) ───────────────────────────────────────────────────
// Only names referenced by index.html inline handlers or other modules
// (desktop.js, app.js, world-manager.js); everything else stays private.
Object.assign(window, {
    sfBootstrap, sfCloseModal, sfDoLogin, sfGetActiveWorkspace, sfModalAddBookmark,
    sfModalClearResult, sfModalExecuteApex, sfModalExecuteSOQL, sfModalSaveWorkspace,
    sfOnRoomOpen, sfRefreshSidebar, sfShowApexModal, sfShowCreateModal, sfShowEditModal,
    sfShowLoginModal, sfShowSOQLModal, sfSwitchWorkspaceSidebar, sfToggleCollapse,
    showOrgAttachPickerImpl,
    // Called from on*= handlers in this file's own generated HTML (run in global scope):
    sfOpenOrg, sfCheckOrgHealth, sfAfterLogin, sfModalAddOrg, sfModalLoadBookmark,
    sfShowAddOrgModal, sfSidebarRemoveOrg, pickOrgAttach,
    sfMobileBack, sfMobileCheckAll, sfMobileOpenWs, sfMobileRefresh, sfMobileRemoveOrg,
    sfRenderOrgs, sfRenderMobileRoom,
});
// Live mutable state read by desktop.js (getters keep them current after reassignment):
Object.defineProperty(window, 'sfOrgs', { get: () => sfOrgs, configurable: true });
Object.defineProperty(window, 'sfOrgHealthCache', { get: () => sfOrgHealthCache, configurable: true });

})();
