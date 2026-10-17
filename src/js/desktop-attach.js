/* ==============================================
   TSRCT - Desktop attachments: image gallery, files, runner output, Salesforce orgs
   ============================================== */
// Moved out of desktop.js (cleanup P2 #11). Loads BEFORE desktop.js; see desktop-git.js.
(function () {

// ==============================================
// PC IMAGE GALLERY
// ==============================================

let pcGalleryImages = [];
let pcSelectedImages = new Set();

function pcShowGallery() {
    const modal = document.getElementById('pc-gallery-modal');
    if (modal) {
        modal.classList.remove('hidden');
        pcLoadGallery();
    }
}

function pcHideGallery() {
    const modal = document.getElementById('pc-gallery-modal');
    if (modal) {
        modal.classList.add('hidden');
        pcSelectedImages.clear();
        pcUpdateAttachBtn();
    }
}

async function pcLoadGallery() {
    const grid = document.getElementById('pc-gallery-grid');
    const info = document.getElementById('pc-gallery-info');

    if (!grid || !info) return;

    grid.innerHTML = '<div class="pc-gallery-loading">Loading images...</div>';
    info.textContent = 'Loading...';

    try {
        const res = await fetch('/api/images', {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();

        if (!data.success) throw new Error(data.error || 'Failed to load');

        pcGalleryImages = data.images || [];
        info.textContent = `${pcGalleryImages.length} images on server`;

        if (pcGalleryImages.length === 0) {
            grid.innerHTML = '<div class="pc-gallery-empty">No images on server</div>';
            return;
        }

        grid.innerHTML = pcGalleryImages.map((img, idx) => `
            <div class="pc-gallery-item${pcSelectedImages.has(img.path) ? ' selected' : ''}"
                 data-index="${idx}"
                 data-path="${escapeHtml(img.path)}"
                 onclick="pcGalleryClick(event, ${idx})">
                <img src="${img.url}" alt="${escapeHtml(img.filename)}" loading="lazy">
                <div class="pc-gallery-check">[*]</div>
                <div class="pc-gallery-name">${escapeHtml(img.filename)}</div>
            </div>
        `).join('');

    } catch (e) {
        console.error('Gallery load error:', e);
        grid.innerHTML = `<div class="pc-gallery-error">Error: ${e.message}</div>`;
        info.textContent = 'Error loading';
    }
}

function pcGalleryClick(e, index) {
    if (e.ctrlKey) {
        // Ctrl+click = preview
        pcPreviewImage(index);
    } else {
        // Normal click = toggle selection
        pcToggleImage(index);
    }
}

function pcToggleImage(index) {
    const img = pcGalleryImages[index];
    if (!img) return;

    if (pcSelectedImages.has(img.path)) {
        pcSelectedImages.delete(img.path);
    } else {
        pcSelectedImages.add(img.path);
    }

    // Update UI
    const items = document.querySelectorAll('.pc-gallery-item');
    items.forEach(item => {
        const path = item.dataset.path;
        item.classList.toggle('selected', pcSelectedImages.has(path));
    });

    pcUpdateAttachBtn();
}

function pcPreviewImage(index) {
    const img = pcGalleryImages[index];
    if (!img) return;

    // Create or get preview modal
    let preview = document.getElementById('pc-gallery-preview');
    if (!preview) {
        preview = document.createElement('div');
        preview.id = 'pc-gallery-preview';
        preview.className = 'pc-gallery-preview';
        preview.innerHTML = `
            <div class="pc-preview-backdrop" onclick="pcClosePreview()"></div>
            <div class="pc-preview-content">
                <img id="pc-preview-img" src="" alt="">
                <div class="pc-preview-info">
                    <span id="pc-preview-name"></span>
                    <button onclick="pcClosePreview()">[x] Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(preview);
    }

    // Set image and show
    document.getElementById('pc-preview-img').src = img.url;
    document.getElementById('pc-preview-name').textContent = img.filename;
    preview.classList.add('visible');
}

function pcClosePreview() {
    const preview = document.getElementById('pc-gallery-preview');
    if (preview) {
        preview.classList.remove('visible');
    }
}

// ==============================================
// PC FILE ATTACHMENT
// ==============================================

let pcFileCurrentPath = '';
let pcFileBasePath = ''; // Server working directory for absolute paths
let pcSelectedFiles = new Set();

async function pcInitFileBasePath() {
    if (pcFileBasePath) return;
    try {
        const res = await fetch('/api/cwd', {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();
        if (data.cwd) {
            pcFileBasePath = data.cwd;
        }
    } catch (e) {
        console.error('Failed to get cwd:', e);
    }
}

// Ensure path is absolute and in Unix format
function pcEnsureAbsolutePath(path) {
    if (!path) return pcFileBasePath || '';

    // Convert Windows path to WSL path if needed
    path = pcConvertToUnixPath(path);

    if (path.startsWith('/')) return path;

    // Path is relative, prepend base path
    const basePath = pcConvertToUnixPath(pcFileBasePath || '');
    return basePath ? `${basePath}/${path}` : path;
}

// Convert Windows path (C:\...) to Unix/WSL path (/mnt/c/...)
function pcConvertToUnixPath(path) {
    if (!path) return path;

    // Check for Windows absolute path (e.g., C:\Users\...)
    const windowsMatch = path.match(/^([A-Za-z]):[\\\/](.*)$/);
    if (windowsMatch) {
        const drive = windowsMatch[1].toLowerCase();
        const rest = windowsMatch[2].replace(/\\/g, '/');
        return `/mnt/${drive}/${rest}`;
    }

    // Replace backslashes with forward slashes
    return path.replace(/\\/g, '/');
}

function pcShowFileAttach() {
    pcInitFileBasePath(); // Ensure we have the base path
    const modal = document.getElementById('pc-file-modal');
    if (modal) {
        modal.classList.remove('hidden');
        pcFileTab('text');
        // Clear previous state
        document.getElementById('pc-file-name').value = '';
        document.getElementById('pc-file-content').value = '';
        pcSelectedFiles.clear();
        pcUpdateFileSelected();
    }
}

function pcHideFileAttach() {
    const modal = document.getElementById('pc-file-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

function pcFileTab(tab) {
    const textTab = document.getElementById('pc-file-tab-text');
    const browseTab = document.getElementById('pc-file-tab-browse');
    const textPanel = document.getElementById('pc-file-text-panel');
    const browsePanel = document.getElementById('pc-file-browse-panel');

    if (tab === 'text') {
        textTab.classList.add('active');
        browseTab.classList.remove('active');
        textPanel.classList.remove('hidden');
        browsePanel.classList.add('hidden');
    } else {
        textTab.classList.remove('active');
        browseTab.classList.add('active');
        textPanel.classList.add('hidden');
        browsePanel.classList.remove('hidden');
        pcLoadFileList('');
    }
}

async function pcLoadFileList(path) {
    const list = document.getElementById('pc-file-list');
    const pathEl = document.getElementById('pc-file-path');

    list.innerHTML = '<div class="pc-file-loading">Loading...</div>';

    try {
        const res = await fetch('/api/files/browse', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ path: path || '' })
        });
        const data = await res.json();

        if (!data.success) throw new Error(data.error || 'Failed');

        pcFileCurrentPath = data.currentPath || '';
        pathEl.textContent = pcFileCurrentPath || '/';

        let html = '';

        // Parent directory
        if (data.parent !== null) {
            html += `<div class="pc-file-item pc-file-up" onclick="pcLoadFileList('${escapeHtml(data.parent || '')}')">
                <span class="icon">[..]</span>
                <span class="name">Parent Directory</span>
            </div>`;
        }

        // Directories
        for (const dir of (data.directories || [])) {
            const fullPath = data.currentPath ? `${data.currentPath}/${dir}` : dir;
            const isSelected = pcSelectedFiles.has(fullPath);
            html += `<div class="pc-file-item pc-file-dir${isSelected ? ' selected' : ''}" data-path="${escapeHtml(fullPath)}">
                <span class="icon">[D]</span>
                <span class="name" onclick="pcLoadFileList('${escapeHtml(fullPath)}')">${escapeHtml(dir)}</span>
                <button class="pc-file-select" onclick="pcToggleFile('${escapeHtml(fullPath)}', true)">${isSelected ? '[-]' : '[+]'}</button>
            </div>`;
        }

        // Files
        for (const file of (data.files || [])) {
            const fullPath = data.currentPath ? `${data.currentPath}/${file}` : file;
            const isSelected = pcSelectedFiles.has(fullPath);
            html += `<div class="pc-file-item pc-file-file${isSelected ? ' selected' : ''}" data-path="${escapeHtml(fullPath)}">
                <span class="icon">[F]</span>
                <span class="name">${escapeHtml(file)}</span>
                <button class="pc-file-select" onclick="pcToggleFile('${escapeHtml(fullPath)}', false)">${isSelected ? '[-]' : '[+]'}</button>
            </div>`;
        }

        if (!html) {
            html = '<div class="pc-file-empty">Empty directory</div>';
        }

        list.innerHTML = html;

    } catch (e) {
        console.error('File browse error:', e);
        list.innerHTML = `<div class="pc-file-error">Error: ${e.message}</div>`;
    }
}

function pcToggleFile(path, isDir) {
    if (pcSelectedFiles.has(path)) {
        pcSelectedFiles.delete(path);
    } else {
        pcSelectedFiles.add(path);
    }

    // Update UI
    const items = document.querySelectorAll('.pc-file-item');
    items.forEach(item => {
        const itemPath = item.dataset.path;
        if (itemPath === path) {
            item.classList.toggle('selected', pcSelectedFiles.has(path));
            const btn = item.querySelector('.pc-file-select');
            if (btn) btn.textContent = pcSelectedFiles.has(path) ? '[-]' : '[+]';
        }
    });

    pcUpdateFileSelected();
}

function pcUpdateFileSelected() {
    const el = document.getElementById('pc-file-selected');
    if (!el) return;

    if (pcSelectedFiles.size === 0) {
        el.innerHTML = '';
        return;
    }

    const items = Array.from(pcSelectedFiles).map(path => {
        const name = path.split('/').pop();
        return `<span class="pc-file-chip">${escapeHtml(name)} <button onclick="pcRemoveSelectedFile('${escapeHtml(path)}')">[x]</button></span>`;
    }).join('');

    el.innerHTML = `<div class="pc-file-selected-label">Selected (${pcSelectedFiles.size}):</div>${items}`;
}

function pcRemoveSelectedFile(path) {
    pcSelectedFiles.delete(path);
    pcUpdateFileSelected();
    // Refresh list to update buttons
    pcLoadFileList(pcFileCurrentPath);
}

async function pcAttachFiles() {
    const textPanel = document.getElementById('pc-file-text-panel');
    const isTextMode = !textPanel.classList.contains('hidden');

    if (isTextMode) {
        // Create new .md file
        const filename = document.getElementById('pc-file-name').value.trim();
        const content = document.getElementById('pc-file-content').value;

        if (!filename) {
            if (typeof toast === 'function') toast('Enter a filename', 'error');
            document.getElementById('pc-file-name').focus();
            return;
        }

        if (!content) {
            if (typeof toast === 'function') toast('Enter content', 'error');
            document.getElementById('pc-file-content').focus();
            return;
        }

        try {
            const res = await fetch('/api/files/create', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': (typeof token !== 'undefined' ? token : '')
                },
                body: JSON.stringify({ filename: filename + '.md', content })
            });
            const data = await res.json();

            if (!data.success) throw new Error(data.error || 'Failed');

            // Attach the file
            if (typeof attachedImages !== 'undefined' && !attachedImages.includes(data.path)) {
                attachedImages.push(data.path);
            }

            if (typeof toast === 'function') toast(`Created & attached: ${filename}.md`, 'success');
            pcUpdateAttachIndicator();
            pcHideFileAttach();

        } catch (e) {
            console.error('Create file error:', e);
            if (typeof toast === 'function') toast('Error: ' + e.message, 'error');
        }

    } else {
        // Attach selected files
        if (pcSelectedFiles.size === 0) {
            if (typeof toast === 'function') toast('Select files to attach', 'error');
            return;
        }

        for (const path of pcSelectedFiles) {
            // Convert Windows to Unix path - browsed paths should already be absolute from the API
            const unixPath = pcConvertToUnixPath(path);
            if (typeof attachedImages !== 'undefined' && !attachedImages.includes(unixPath)) {
                attachedImages.push(unixPath);
            }
        }

        if (typeof toast === 'function') toast(`${pcSelectedFiles.size} file(s) attached`, 'success');
        pcUpdateAttachIndicator();
        pcHideFileAttach();
    }
}

function pcUpdateAttachBtn() {
    const btn = document.getElementById('pc-gallery-attach');
    if (btn) {
        const count = pcSelectedImages.size;
        btn.textContent = `ATTACH (${count})`;
        btn.disabled = count === 0;
    }
}

function pcAttachImages() {
    if (pcSelectedImages.size === 0) return;

    // Add to global attachedImages array (defined in app.js)
    for (const path of pcSelectedImages) {
        if (typeof attachedImages !== 'undefined' && !attachedImages.includes(path)) {
            attachedImages.push(path);
        }
    }

    if (typeof toast === 'function') {
        toast(`${pcSelectedImages.size} IMG ATTACHED`, 'success');
    }

    pcUpdateAttachIndicator();
    pcHideGallery();
}

function pcUpdateAttachIndicator() {
    const ind = document.getElementById('pc-attach-indicator');
    if (!ind) return;

    const hasImages = typeof attachedImages !== 'undefined' && attachedImages.length > 0;
    const hasRunners = typeof attachedRunners !== 'undefined' && attachedRunners.length > 0;
    const hasOrgs = typeof attachedOrgs !== 'undefined' && attachedOrgs.length > 0;

    if (hasImages || hasRunners || hasOrgs) {
        ind.classList.remove('hidden');

        let html = '';

        // Images/files
        if (hasImages) {
            html += attachedImages.map((path, i) => {
                const name = path.split(/[/\\]/).pop();
                const ext = name.split('.').pop().toLowerCase();
                let icon = '[F]';
                if (/^(jpg|jpeg|png|gif|webp|bmp|svg)$/.test(ext)) icon = '[IMG]';
                else if (/^(md|txt|log)$/.test(ext)) icon = '[TXT]';
                else if (/^(js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h)$/.test(ext)) icon = '[CODE]';
                else if (/^(json|yaml|yml|xml|toml)$/.test(ext)) icon = '[CFG]';
                else if (/^(css|scss|less)$/.test(ext)) icon = '[CSS]';
                else if (/^(html|htm)$/.test(ext)) icon = '[HTML]';
                return `<span class="pc-attach-item"><span class="pc-attach-name" onclick="pcStartRenameAttachment(${i})" title="Rename">${icon} ${escapeHtml(name)}</span> <button class="pc-attach-rename-btn" onclick="pcStartRenameAttachment(${i})" title="Rename">[ren]</button><button onclick="pcRemoveAttachment(${i})">[x]</button></span>`;
            }).join('');
        }

        // Runners
        if (hasRunners) {
            html += attachedRunners.map((runner, i) => {
                return `<span class="pc-attach-item runner">[TERM] ${escapeHtml(runner.name)} <button onclick="pcRemoveRunnerAttachment(${i})">[x]</button></span>`;
            }).join('');
        }

        // SF Orgs
        if (hasOrgs) {
            html += attachedOrgs.map((org, i) => {
                return `<span class="pc-attach-item org">[SF] ${escapeHtml(org.alias)} <button onclick="pcRemoveOrgAttachment(${i})">[x]</button></span>`;
            }).join('');
        }

        html += `<button class="pc-attach-clear" onclick="pcClearAttachments()">Clear All</button>`;
        ind.innerHTML = html;
    } else {
        ind.classList.add('hidden');
        ind.innerHTML = '';
    }
}

function pcRemoveAttachment(index) {
    if (typeof attachedImages !== 'undefined') {
        attachedImages.splice(index, 1);
        pcUpdateAttachIndicator();
        if (typeof toast === 'function') {
            toast('IMG REMOVED', 'error');
        }
    }
}

// Inline-rename a file attachment in PC mode
function pcStartRenameAttachment(index) {
    const ind = document.getElementById('pc-attach-indicator');
    if (!ind || typeof attachedImages === 'undefined' || !attachedImages[index]) return;
    const items = ind.querySelectorAll('.pc-attach-item:not(.runner):not(.org)');
    const item = items[index];
    if (!item) return;
    const current = attachedImages[index].split(/[/\\]/).pop();
    item.innerHTML = `<input class="pc-attach-rename-input" type="text" value="${escapeHtml(current)}" spellcheck="false"><button class="pc-attach-rename-ok">OK</button><button class="pc-attach-rename-cancel">[x]</button>`;
    const input = item.querySelector('.pc-attach-rename-input');
    const commit = () => pcCommitRenameAttachment(index, input.value);
    item.querySelector('.pc-attach-rename-ok').onclick = commit;
    item.querySelector('.pc-attach-rename-cancel').onclick = () => pcUpdateAttachIndicator();
    input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); pcUpdateAttachIndicator(); }
    };
    input.focus();
    const dot = current.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : current.length);
}

async function pcCommitRenameAttachment(index, newName) {
    const oldPath = attachedImages[index];
    if (!oldPath) return;
    const current = oldPath.split(/[/\\]/).pop();
    newName = (newName || '').trim();
    if (!newName || newName === current) { pcUpdateAttachIndicator(); return; }
    try {
        const res = await fetch('/api/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: token },
            body: JSON.stringify({ oldPath, newName })
        });
        const d = await res.json();
        if (d.success) {
            attachedImages[index] = d.path;
            pcUpdateAttachIndicator();
            if (typeof toast === 'function') toast('RENAMED: ' + d.filename, 'success');
        } else {
            pcUpdateAttachIndicator();
            if (typeof toast === 'function') toast('RENAME FAILED: ' + (d.error || ''), 'error');
        }
    } catch (e) {
        pcUpdateAttachIndicator();
        if (typeof toast === 'function') toast('RENAME ERROR', 'error');
    }
}

function pcClearAttachments() {
    if (typeof attachedImages !== 'undefined') attachedImages.length = 0;
    if (typeof attachedRunners !== 'undefined') attachedRunners.length = 0;
    if (typeof attachedOrgs !== 'undefined') attachedOrgs.length = 0;
    pcUpdateAttachIndicator();
    if (typeof toast === 'function') {
        toast('ALL ATTACHMENTS REMOVED', 'error');
    }
}

// ==============================================
// RUNNER TERMINAL ATTACHMENT
// ==============================================

let pcRunnerAttachSelected = new Set();

function pcShowRunnerAttach() {
    const modal = document.getElementById('pc-runner-attach-modal');
    if (!modal) return;

    // Clear previous selection
    pcRunnerAttachSelected.clear();

    // Pre-select already attached runners
    if (typeof attachedRunners !== 'undefined') {
        attachedRunners.forEach(r => pcRunnerAttachSelected.add(r.id));
    }

    // Render runner list
    pcRenderRunnerAttachList();

    modal.classList.remove('hidden');
}

function pcHideRunnerAttach() {
    const modal = document.getElementById('pc-runner-attach-modal');
    if (modal) modal.classList.add('hidden');
}

function pcRenderRunnerAttachList() {
    const list = document.getElementById('pc-runner-attach-list');
    if (!list) return;

    const runners = Desktop.runners || [];

    if (runners.length === 0) {
        list.innerHTML = `<div class="pc-runner-attach-empty">No runners available. Create one from the sidebar.</div>`;
        return;
    }

    list.innerHTML = runners.map(runner => {
        const isSelected = pcRunnerAttachSelected.has(runner.id);
        const statusIcon = runner.status === 'running' ? '[*]' : runner.status === 'starting' ? '[~]' : '[x]';
        const statusClass = runner.status || 'stopped';
        const preview = (runner.output || '').trim().split('\n').pop() || '(no output)';
        const previewTrunc = preview.length > 50 ? preview.substring(0, 50) + '...' : preview;

        return `
            <div class="pc-runner-attach-item ${isSelected ? 'selected' : ''}"
                 data-id="${runner.id}"
                 onclick="pcToggleRunnerSelect('${runner.id}')">
                <input type="checkbox" class="pc-runner-attach-check" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation()">
                <span class="pc-runner-attach-name">${escapeHtml(runner.name)}</span>
                <span class="pc-runner-attach-status ${statusClass}">${statusIcon}</span>
                <span class="pc-runner-attach-preview">${escapeHtml(previewTrunc)}</span>
            </div>
        `;
    }).join('');

    pcUpdateRunnerAttachBtn();
}

function pcToggleRunnerSelect(id) {
    if (pcRunnerAttachSelected.has(id)) {
        pcRunnerAttachSelected.delete(id);
    } else {
        pcRunnerAttachSelected.add(id);
    }

    // Update UI
    const item = document.querySelector(`.pc-runner-attach-item[data-id="${id}"]`);
    if (item) {
        item.classList.toggle('selected', pcRunnerAttachSelected.has(id));
        const checkbox = item.querySelector('.pc-runner-attach-check');
        if (checkbox) checkbox.checked = pcRunnerAttachSelected.has(id);
    }

    pcUpdateRunnerAttachBtn();
}

function pcUpdateRunnerAttachBtn() {
    const btn = document.getElementById('pc-runner-attach-btn');
    if (btn) {
        const count = pcRunnerAttachSelected.size;
        btn.textContent = `ATTACH (${count})`;
        btn.disabled = count === 0;
    }
}

function pcAttachRunners() {
    if (pcRunnerAttachSelected.size === 0) return;

    // Get runner objects for selected IDs
    const runners = Desktop.runners || [];

    // Clear existing and add selected
    if (typeof attachedRunners !== 'undefined') {
        attachedRunners.length = 0;

        for (const id of pcRunnerAttachSelected) {
            const runner = runners.find(r => r.id === id);
            if (runner) {
                attachedRunners.push({
                    id: runner.id,
                    name: runner.name,
                    session: runner.session
                });
            }
        }
    }

    pcUpdateAttachIndicator();
    pcHideRunnerAttach();

    if (typeof toast === 'function') {
        toast(`${pcRunnerAttachSelected.size} RUNNER(S) ATTACHED`, 'success');
    }
}

function pcRemoveRunnerAttachment(index) {
    if (typeof attachedRunners !== 'undefined') {
        attachedRunners.splice(index, 1);
        pcUpdateAttachIndicator();
        if (typeof toast === 'function') {
            toast('RUNNER REMOVED', 'error');
        }
    }
}

// ==============================================
// SF CLI LAZY LOADING

let pcSfInitDone = false;

async function pcSfLazyInit(e) {
    if (pcSfInitDone) return;
    // Only trigger on first meaningful click (not collapse)
    pcSfInitDone = true;
    const orgsEl = $('pc-sf-orgs');
    if (orgsEl) orgsEl.innerHTML = '<div class="pc-sf-empty">Loading SF CLI...</div>';
    await loadSfCli();
}

async function pcSfAction(fnName, arg) {
    if (!sfCliLoaded) {
        const orgsEl = $('pc-sf-orgs');
        if (orgsEl) orgsEl.innerHTML = '<div class="pc-sf-empty">Loading SF CLI...</div>';
        await loadSfCli();
    }
    if (typeof window[fnName] === 'function') {
        await window[fnName](arg);
    }
}

// SF ORG ATTACHMENT
// ==============================================

let pcOrgAttachSelected = new Set();

async function pcShowOrgAttach() {
    if (!sfCliLoaded) await loadSfCli();
    const modal = document.getElementById('pc-org-attach-modal');
    if (!modal) return;

    pcOrgAttachSelected.clear();

    // Pre-select already attached orgs
    if (typeof attachedOrgs !== 'undefined') {
        attachedOrgs.forEach(o => pcOrgAttachSelected.add(o.alias));
    }

    pcRenderOrgAttachList();
    modal.classList.remove('hidden');
}

function pcHideOrgAttach() {
    const modal = document.getElementById('pc-org-attach-modal');
    if (modal) modal.classList.add('hidden');
}

function pcRenderOrgAttachList() {
    const list = document.getElementById('pc-org-attach-list');
    if (!list) return;

    // Get orgs from active workspace or all loaded orgs
    const ws = typeof sfGetActiveWorkspace === 'function' ? sfGetActiveWorkspace() : null;
    const wsOrgs = ws ? ws.orgs : [];
    const allOrgs = typeof sfOrgs !== 'undefined' ? sfOrgs : [];

    // Build list: workspace orgs first, then remaining
    const orgList = [];
    const seen = new Set();

    // Workspace orgs
    wsOrgs.forEach(alias => {
        seen.add(alias);
        const org = allOrgs.find(o => (o.alias || o.username) === alias);
        const h = typeof sfOrgHealthCache !== 'undefined' ? sfOrgHealthCache[alias] : null;
        orgList.push({
            alias,
            username: org ? org.username : alias,
            workspace: ws ? ws.name : '',
            connected: h ? h.connected : null
        });
    });

    // Other authenticated orgs not in workspace
    allOrgs.forEach(o => {
        const alias = o.alias || o.username;
        if (!seen.has(alias)) {
            seen.add(alias);
            orgList.push({
                alias,
                username: o.username || alias,
                workspace: '',
                connected: null
            });
        }
    });

    if (orgList.length === 0) {
        list.innerHTML = '<div class="pc-runner-attach-empty">No SF orgs available. Add orgs in SF CLI sidebar.</div>';
        return;
    }

    list.innerHTML = orgList.map(org => {
        const isSelected = pcOrgAttachSelected.has(org.alias);
        const statusIcon = org.connected === true ? '[*]' : org.connected === false ? '[!]' : '[?]';
        const statusClass = org.connected === true ? 'running' : org.connected === false ? 'stopped' : 'starting';
        const wsLabel = org.workspace ? ` (${org.workspace})` : '';

        return `
            <div class="pc-runner-attach-item ${isSelected ? 'selected' : ''}"
                 data-id="${org.alias}"
                 onclick="pcToggleOrgSelect('${org.alias}')">
                <input type="checkbox" class="pc-runner-attach-check" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation()">
                <span class="pc-runner-attach-name">${org.alias}${wsLabel}</span>
                <span class="pc-runner-attach-status ${statusClass}">${statusIcon}</span>
                <span class="pc-runner-attach-preview">${org.username}</span>
            </div>
        `;
    }).join('');

    pcUpdateOrgAttachBtn();
}

function pcToggleOrgSelect(alias) {
    if (pcOrgAttachSelected.has(alias)) {
        pcOrgAttachSelected.delete(alias);
    } else {
        pcOrgAttachSelected.add(alias);
    }

    const item = document.querySelector(`#pc-org-attach-list .pc-runner-attach-item[data-id="${alias}"]`);
    if (item) {
        item.classList.toggle('selected', pcOrgAttachSelected.has(alias));
        const checkbox = item.querySelector('.pc-runner-attach-check');
        if (checkbox) checkbox.checked = pcOrgAttachSelected.has(alias);
    }

    pcUpdateOrgAttachBtn();
}

function pcUpdateOrgAttachBtn() {
    const btn = document.getElementById('pc-org-attach-btn');
    if (btn) {
        const count = pcOrgAttachSelected.size;
        btn.textContent = `ATTACH (${count})`;
        btn.disabled = count === 0;
    }
}

function pcAttachOrgs() {
    if (pcOrgAttachSelected.size === 0) return;

    if (typeof attachedOrgs !== 'undefined') {
        attachedOrgs.length = 0;

        const ws = typeof sfGetActiveWorkspace === 'function' ? sfGetActiveWorkspace() : null;

        for (const alias of pcOrgAttachSelected) {
            attachedOrgs.push({
                alias,
                workspace: ws && ws.orgs.includes(alias) ? ws.name : ''
            });
        }
    }

    pcUpdateAttachIndicator();
    pcHideOrgAttach();

    if (typeof toast === 'function') {
        toast(`${pcOrgAttachSelected.size} ORG(S) ATTACHED`, 'success');
    }
}

function pcRemoveOrgAttachment(index) {
    if (typeof attachedOrgs !== 'undefined') {
        attachedOrgs.splice(index, 1);
        pcUpdateAttachIndicator();
        if (typeof toast === 'function') {
            toast('ORG REMOVED', 'error');
        }
    }
}

window.pcShowRunnerAttach = pcShowRunnerAttach;
window.pcHideRunnerAttach = pcHideRunnerAttach;
window.pcRenderRunnerAttachList = pcRenderRunnerAttachList;
window.pcToggleRunnerSelect = pcToggleRunnerSelect;
window.pcUpdateRunnerAttachBtn = pcUpdateRunnerAttachBtn;
window.pcAttachRunners = pcAttachRunners;
window.pcRemoveRunnerAttachment = pcRemoveRunnerAttachment;
window.pcShowOrgAttach = pcShowOrgAttach;
window.pcHideOrgAttach = pcHideOrgAttach;
window.pcToggleOrgSelect = pcToggleOrgSelect;
window.pcAttachOrgs = pcAttachOrgs;
window.pcRemoveOrgAttachment = pcRemoveOrgAttachment;
// were in desktop.js's "Public API gap" block: reached from generated onclick
// HTML and from desktop.js itself (keyboard shortcuts, send, the rail)
Object.assign(window, {
    pcShowGallery, pcHideGallery, pcGalleryClick, pcShowFileAttach, pcHideFileAttach,
    pcFileTab, pcLoadFileList, pcToggleFile, pcRemoveSelectedFile, pcAttachFiles, pcAttachImages,
    pcClearAttachments, pcRemoveAttachment, pcStartRenameAttachment, pcCommitRenameAttachment, pcUpdateAttachIndicator, pcClosePreview,
    pcSfAction, pcSfLazyInit,
});

})();
