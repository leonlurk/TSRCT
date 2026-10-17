/* ==============================================
   TSRCT - Desktop git panel
   ============================================== */
// Moved out of desktop.js (cleanup P2 #11). Loads BEFORE desktop.js: it reaches
// desktop.js only through window.*, and desktop.js reaches it the same way
// (pcGitInit in initDesktopMode), so neither depends on the other at load time.
(function () {

// ==============================================
// GIT PANEL - Simple Git Operations
// ==============================================

const PC_GIT_BASE_PATH = window.TSRCT_PROJECTS_ROOT;

// Initialize git panel on load
async function pcGitInit() {
    const savedCwd = localStorage.getItem('pc_git_cwd');
    if (savedCwd) {
        Desktop.git.cwd = savedCwd;
        await pcGitRefresh();
    }
    // Restore collapsed state
    const collapsed = localStorage.getItem('pc_git_collapsed') === 'true';
    if (collapsed) {
        document.querySelector('.pc-git-section')?.classList.add('collapsed');
    }
}

// Toggle collapse git panel
function pcGitToggleCollapse() {
    const section = document.querySelector('.pc-git-section');
    if (section) {
        section.classList.toggle('collapsed');
        const isCollapsed = section.classList.contains('collapsed');
        localStorage.setItem('pc_git_collapsed', isCollapsed);
        const btn = section.querySelector('.pc-git-collapse');
        if (btn) btn.textContent = isCollapsed ? '[+]' : '[_]';
    }
}

// Refresh git info for current project
async function pcGitRefresh() {
    const cwd = Desktop.git.cwd;
    if (!cwd || cwd === '' || cwd === PC_GIT_BASE_PATH) {
        pcGitRenderEmpty();
        return;
    }

    try {
        const res = await fetch(`/api/git/info?cwd=${encodeURIComponent(cwd)}`, {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();

        if (data.success) {
            Desktop.git = { ...Desktop.git, ...data };
            pcGitRender();
        } else {
            pcGitRenderEmpty();
        }
    } catch (e) {
        console.error('[GIT] Refresh failed:', e);
        pcGitRenderEmpty();
    }
}

// Render empty state
function pcGitRenderEmpty() {
    const nameEl = document.getElementById('pc-git-project-name');
    const infoEl = document.getElementById('pc-git-info');
    const actionsEl = document.getElementById('pc-git-actions');

    if (nameEl) nameEl.textContent = Desktop.git.cwd === PC_GIT_BASE_PATH ? 'Select project...' : Desktop.git.cwd.split('/').pop();
    if (infoEl) infoEl.innerHTML = '<div class="pc-git-placeholder">Not a git repository</div>';
    if (actionsEl) actionsEl.innerHTML = `<button class="pc-git-btn" onclick="pcGitInitRepo()">git init</button>`;
}

// Render git info
function pcGitRender() {
    const nameEl = document.getElementById('pc-git-project-name');
    const infoEl = document.getElementById('pc-git-info');
    const actionsEl = document.getElementById('pc-git-actions');

    if (!Desktop.git.isRepo) {
        pcGitRenderEmpty();
        return;
    }

    // Project name
    if (nameEl) nameEl.textContent = Desktop.git.cwd.split('/').pop();

    // Info section
    if (infoEl) {
        infoEl.innerHTML = `
            <div class="pc-git-row">
                <span class="pc-git-label">Branch:</span>
                <span class="pc-git-value pc-git-branch" onclick="pcGitShowBranchPicker()">${escapeHtml(Desktop.git.branch || 'main')} [v]</span>
            </div>
            <div class="pc-git-row">
                <span class="pc-git-label">Changes:</span>
                <span class="pc-git-value ${Desktop.git.changedCount > 0 ? 'pc-git-changed' : ''}">${Desktop.git.changedCount} files</span>
            </div>
            ${Desktop.git.remoteUrl ? `
            <div class="pc-git-row">
                <span class="pc-git-label">Remote:</span>
                <span class="pc-git-value pc-git-remote" title="${escapeHtml(Desktop.git.remoteUrl)}">${escapeHtml(Desktop.git.remoteUrl.replace(/^https:\/\/[^@\/]+@/, 'https://').replace('https://github.com/', '').replace('.git', ''))}</span>
                <span class="pc-git-edit" onclick="pcGitUpdateCredentials()" title="Update credentials">[edit]</span>
            </div>
            ` : `
            <div class="pc-git-row">
                <span class="pc-git-label">Remote:</span>
                <span class="pc-git-value pc-git-no-remote" onclick="pcGitSetupRemote()">Not configured [+]</span>
            </div>
            `}
        `;
    }

    // Actions
    if (actionsEl) {
        actionsEl.innerHTML = `
            <button class="pc-git-btn pc-git-commit-btn" onclick="pcGitShowCommitModal()" ${Desktop.git.changedCount === 0 ? 'disabled' : ''}>Commit</button>
            <button class="pc-git-btn pc-git-push-btn" onclick="pcGitShowPushModal()" ${!Desktop.git.remoteUrl ? 'disabled' : ''}>Push</button>
            <button class="pc-git-btn pc-git-token-btn" onclick="pcGitManageToken()" title="Set or update the GitHub token for this repo">Token</button>
            <button class="pc-git-btn pc-git-refresh-btn" onclick="pcGitRefresh()">[R]</button>
        `;
    }
}

// Show project picker modal (like runner dir picker)
async function pcGitShowProjectPicker() {
    document.getElementById('pc-git-picker-modal')?.remove();

    const modal = document.createElement('div');
    modal.className = 'pc-git-modal';
    modal.id = 'pc-git-picker-modal';
    modal.innerHTML = `
        <div class="pc-git-modal-content">
            <div class="pc-git-modal-header">
                <span>Select Project</span>
                <button onclick="pcGitCloseModal('pc-git-picker-modal')">[x]</button>
            </div>
            <div class="pc-git-modal-body">
                <div class="pc-git-dir-path" id="pc-git-dir-path">${PC_GIT_BASE_PATH}</div>
                <div class="pc-git-dir-list" id="pc-git-dir-list">
                    <div class="pc-git-loading">Loading...</div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) pcGitCloseModal('pc-git-picker-modal');
    });

    await pcGitBrowseDir(PC_GIT_BASE_PATH);
}

// Browse directory for project picker
async function pcGitBrowseDir(dir) {
    const listEl = document.getElementById('pc-git-dir-list');
    const pathEl = document.getElementById('pc-git-dir-path');
    if (!listEl || !pathEl) return;

    pathEl.textContent = dir;
    listEl.innerHTML = '<div class="pc-git-loading">Loading...</div>';

    try {
        const res = await fetch(`/api/runner/browse?dir=${encodeURIComponent(dir)}`, {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();

        if (data.error && !data.directories) {
            listEl.innerHTML = `<div class="pc-git-error">${escapeHtml(data.error)}</div>`;
            return;
        }

        // Clear and build with event delegation
        listEl.innerHTML = '';

        // Parent directory
        if (data.parent && dir !== PC_GIT_BASE_PATH) {
            const parentItem = document.createElement('div');
            parentItem.className = 'pc-git-dir-item pc-git-dir-up';
            parentItem.textContent = '[..] Parent';
            parentItem.onclick = () => pcGitBrowseDir(data.parent);
            listEl.appendChild(parentItem);
        }

        // Select current directory
        const selectCurrent = document.createElement('div');
        selectCurrent.className = 'pc-git-dir-item pc-git-dir-select';
        selectCurrent.textContent = '[*] Select this directory';
        selectCurrent.onclick = () => pcGitSelectProject(data.current);
        listEl.appendChild(selectCurrent);

        // Subdirectories
        if (data.directories && data.directories.length > 0) {
            data.directories.forEach(d => {
                const item = document.createElement('div');
                item.className = 'pc-git-dir-item';

                const nameSpan = document.createElement('span');
                nameSpan.textContent = '[>] ' + d.name;
                nameSpan.onclick = (e) => {
                    e.stopPropagation();
                    pcGitBrowseDir(d.path);
                };

                const selectBtn = document.createElement('button');
                selectBtn.textContent = '[*]';
                selectBtn.title = 'Select';
                selectBtn.onclick = (e) => {
                    e.stopPropagation();
                    pcGitSelectProject(d.path);
                };

                item.appendChild(nameSpan);
                item.appendChild(selectBtn);
                listEl.appendChild(item);
            });
        } else {
            const emptyItem = document.createElement('div');
            emptyItem.className = 'pc-git-dir-empty';
            emptyItem.textContent = 'No subdirectories';
            listEl.appendChild(emptyItem);
        }
    } catch (e) {
        listEl.innerHTML = '<div class="pc-git-error">Failed to browse</div>';
    }
}

// Select a project
async function pcGitSelectProject(path) {
    Desktop.git.cwd = path;
    localStorage.setItem('pc_git_cwd', path);
    pcGitCloseModal('pc-git-picker-modal');
    await pcGitRefresh();
}

// Initialize git repo
async function pcGitInitRepo() {
    try {
        const res = await fetch('/api/git/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': (typeof token !== 'undefined' ? token : '') },
            body: JSON.stringify({ cwd: Desktop.git.cwd })
        });
        const data = await res.json();

        if (data.success) {
            if (typeof toast === 'function') toast('Git initialized', 'success');
            await pcGitRefresh();
        } else {
            if (typeof toast === 'function') toast(data.error, 'error');
        }
    } catch (e) {
        if (typeof toast === 'function') toast('Init failed', 'error');
    }
}

// Show branch picker
async function pcGitShowBranchPicker() {
    if (!Desktop.git.branches || Desktop.git.branches.length === 0) return;

    document.getElementById('pc-git-branch-modal')?.remove();

    const modal = document.createElement('div');
    modal.className = 'pc-git-modal';
    modal.id = 'pc-git-branch-modal';
    modal.innerHTML = `
        <div class="pc-git-modal-content pc-git-modal-small">
            <div class="pc-git-modal-header">
                <span>Switch Branch</span>
                <button onclick="pcGitCloseModal('pc-git-branch-modal')">[x]</button>
            </div>
            <div class="pc-git-modal-body">
                ${Desktop.git.branches.map(b => `
                    <div class="pc-git-branch-item ${b === Desktop.git.branch ? 'active' : ''}" onclick="pcGitCheckout('${escapeHtml(b)}')">
                        ${escapeHtml(b)} ${b === Desktop.git.branch ? '[*]' : ''}
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) pcGitCloseModal('pc-git-branch-modal');
    });
}

// Checkout branch
async function pcGitCheckout(branch) {
    try {
        const res = await fetch('/api/git/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': (typeof token !== 'undefined' ? token : '') },
            body: JSON.stringify({ branch, cwd: Desktop.git.cwd })
        });
        const data = await res.json();

        pcGitCloseModal('pc-git-branch-modal');

        if (data.success) {
            if (typeof toast === 'function') toast(`Switched to ${branch}`, 'success');
            await pcGitRefresh();
        } else {
            if (typeof toast === 'function') toast(data.error, 'error');
        }
    } catch (e) {
        if (typeof toast === 'function') toast('Checkout failed', 'error');
    }
}

// Setup remote
async function pcGitSetupRemote() {
    document.getElementById('pc-git-remote-modal')?.remove();

    const modal = document.createElement('div');
    modal.className = 'pc-git-modal';
    modal.id = 'pc-git-remote-modal';
    modal.innerHTML = `
        <div class="pc-git-modal-content">
            <div class="pc-git-modal-header">
                <span>Setup Remote</span>
                <button onclick="pcGitCloseModal('pc-git-remote-modal')">[x]</button>
            </div>
            <div class="pc-git-modal-body">
                <div class="pc-git-field">
                    <label>Repository URL</label>
                    <input type="text" id="pc-git-remote-url" placeholder="https://github.com/user/repo.git" autocomplete="off">
                </div>
                <div class="pc-git-field">
                    <label>GitHub Username (for auth)</label>
                    <input type="text" id="pc-git-username" placeholder="username" autocomplete="off">
                </div>
                <div class="pc-git-field">
                    <label>Personal Access Token</label>
                    <input type="password" id="pc-git-token" placeholder="ghp_xxxxxxxxxxxx" autocomplete="off">
                    <small>Token is stored in repo's .git/config (local only)</small>
                </div>
            </div>
            <div class="pc-git-modal-footer">
                <button onclick="pcGitCloseModal('pc-git-remote-modal')">Cancel</button>
                <button onclick="pcGitSaveRemote()">Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) pcGitCloseModal('pc-git-remote-modal');
    });

    setTimeout(() => document.getElementById('pc-git-remote-url')?.focus(), 100);
}

// Save remote config
async function pcGitSaveRemote() {
    const urlInput = document.getElementById('pc-git-remote-url');
    const usernameInput = document.getElementById('pc-git-username');
    const tokenInput = document.getElementById('pc-git-token');

    const remoteUrl = urlInput?.value.trim();
    const username = usernameInput?.value.trim();
    const ghToken = tokenInput?.value.trim();

    if (!remoteUrl) {
        if (typeof toast === 'function') toast('URL required', 'error');
        return;
    }

    try {
        // Add remote
        const res1 = await fetch('/api/git/remote/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': (typeof token !== 'undefined' ? token : '') },
            body: JSON.stringify({ cwd: Desktop.git.cwd, url: remoteUrl })
        });
        const data1 = await res1.json();

        if (!data1.success) {
            if (typeof toast === 'function') toast(data1.error, 'error');
            return;
        }

        // Add credentials if provided
        if (username && ghToken) {
            const res2 = await fetch('/api/git/credentials', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': (typeof token !== 'undefined' ? token : '') },
                body: JSON.stringify({ cwd: Desktop.git.cwd, username, token: ghToken })
            });
            const data2 = await res2.json();

            if (!data2.success) {
                if (typeof toast === 'function') toast('Remote added, but credentials failed: ' + data2.error, 'error');
            }
        }

        pcGitCloseModal('pc-git-remote-modal');
        if (typeof toast === 'function') toast('Remote configured', 'success');
        await pcGitRefresh();
    } catch (e) {
        if (typeof toast === 'function') toast('Setup failed', 'error');
    }
}

// Entry point for the sidebar "Token" button: update creds if a remote already
// exists, otherwise fall through to full remote setup (which also captures a token).
function pcGitManageToken() {
    if (!Desktop.git.isRepo) {
        if (typeof toast === 'function') toast('Not a git repository', 'error');
        return;
    }
    if (Desktop.git.remoteUrl) {
        pcGitUpdateCredentials();
    } else {
        pcGitSetupRemote();
    }
}

// Update credentials for an already-configured remote (e.g., refresh expired token)
async function pcGitUpdateCredentials() {
    document.getElementById('pc-git-creds-modal')?.remove();

    const modal = document.createElement('div');
    modal.className = 'pc-git-modal';
    modal.id = 'pc-git-creds-modal';
    modal.innerHTML = `
        <div class="pc-git-modal-content">
            <div class="pc-git-modal-header">
                <span>Update Token &mdash; ${escapeHtml((Desktop.git.cwd || '').split('/').pop() || 'repo')}</span>
                <button onclick="pcGitCloseModal('pc-git-creds-modal')">[x]</button>
            </div>
            <div class="pc-git-modal-body">
                <div class="pc-git-field">
                    <label>GitHub Username</label>
                    <input type="text" id="pc-git-creds-username" placeholder="username" autocomplete="off">
                </div>
                <div class="pc-git-field">
                    <label>Personal Access Token</label>
                    <input type="password" id="pc-git-creds-token" placeholder="ghp_xxxxxxxxxxxx" autocomplete="off">
                    <small>Replaces existing credentials in repo's .git/config (local only)</small>
                </div>
            </div>
            <div class="pc-git-modal-footer">
                <button onclick="pcGitCloseModal('pc-git-creds-modal')">Cancel</button>
                <button onclick="pcGitSaveCredentials()">Update</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) pcGitCloseModal('pc-git-creds-modal');
    });

    setTimeout(() => document.getElementById('pc-git-creds-username')?.focus(), 100);
}

async function pcGitSaveCredentials() {
    const username = document.getElementById('pc-git-creds-username')?.value.trim();
    const ghToken = document.getElementById('pc-git-creds-token')?.value.trim();

    if (!username || !ghToken) {
        if (typeof toast === 'function') toast('Username and token required', 'error');
        return;
    }

    try {
        const res = await fetch('/api/git/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': (typeof token !== 'undefined' ? token : '') },
            body: JSON.stringify({ cwd: Desktop.git.cwd, username, token: ghToken })
        });
        const data = await res.json();

        if (data.success) {
            pcGitCloseModal('pc-git-creds-modal');
            if (typeof toast === 'function') toast('Credentials updated', 'success');
            await pcGitRefresh();
        } else {
            if (typeof toast === 'function') toast(data.error || 'Update failed', 'error');
        }
    } catch (e) {
        if (typeof toast === 'function') toast('Update failed', 'error');
    }
}

// Show commit modal
// Track files selected for commit
let pcGitCommitFiles = [];

async function pcGitShowCommitModal() {
    document.getElementById('pc-git-commit-modal')?.remove();

    // Get changed files
    pcGitCommitFiles = [];
    try {
        const res = await fetch(`/api/git/changed-files?cwd=${encodeURIComponent(Desktop.git.cwd)}`, {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();
        pcGitCommitFiles = data.files || [];
    } catch (e) {}

    const modal = document.createElement('div');
    modal.className = 'pc-git-modal';
    modal.id = 'pc-git-commit-modal';
    modal.innerHTML = `
        <div class="pc-git-modal-content">
            <div class="pc-git-modal-header">
                <span>Create Commit</span>
                <button onclick="pcGitCloseModal('pc-git-commit-modal')">[x]</button>
            </div>
            <div class="pc-git-modal-body">
                <div class="pc-git-field">
                    <label>Files to commit (<span id="pc-git-files-count">${pcGitCommitFiles.length}</span>)</label>
                    <div class="pc-git-files" id="pc-git-files">
                        ${pcGitRenderCommitFiles()}
                    </div>
                </div>
                <div class="pc-git-field">
                    <label>Commit message</label>
                    <textarea id="pc-git-commit-msg" placeholder="Describe your changes..." rows="3"></textarea>
                </div>
            </div>
            <div class="pc-git-modal-footer">
                <button onclick="pcGitCloseModal('pc-git-commit-modal')">Cancel</button>
                <button onclick="pcGitDoCommit()" id="pc-git-commit-btn">Commit</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) pcGitCloseModal('pc-git-commit-modal');
    });

    setTimeout(() => document.getElementById('pc-git-commit-msg')?.focus(), 100);
}

// Render the list of files for commit
function pcGitRenderCommitFiles() {
    if (pcGitCommitFiles.length === 0) {
        return '<div class="pc-git-no-files">No files to commit</div>';
    }
    return pcGitCommitFiles.map((f, idx) => `
        <div class="pc-git-file">
            <span class="pc-git-file-status">${escapeHtml(f.status)}</span>
            <span class="pc-git-file-name">${escapeHtml(f.file)}</span>
            <button class="pc-git-file-remove" onclick="pcGitRemoveFile(${idx})" title="Remove from commit">[x]</button>
        </div>
    `).join('');
}

// Remove a file from the commit list
function pcGitRemoveFile(index) {
    if (index >= 0 && index < pcGitCommitFiles.length) {
        pcGitCommitFiles.splice(index, 1);
        // Update the UI
        const filesEl = document.getElementById('pc-git-files');
        const countEl = document.getElementById('pc-git-files-count');
        if (filesEl) {
            filesEl.innerHTML = pcGitRenderCommitFiles();
        }
        if (countEl) {
            countEl.textContent = pcGitCommitFiles.length;
        }
        // Disable commit button if no files
        const commitBtn = document.getElementById('pc-git-commit-btn');
        if (commitBtn) {
            commitBtn.disabled = pcGitCommitFiles.length === 0;
        }
    }
}

// Do commit with selected files
async function pcGitDoCommit() {
    const message = document.getElementById('pc-git-commit-msg')?.value.trim();

    if (!message) {
        if (typeof toast === 'function') toast('Commit message required', 'error');
        return;
    }

    if (pcGitCommitFiles.length === 0) {
        if (typeof toast === 'function') toast('No files selected', 'error');
        return;
    }

    try {
        // Git add selected files
        const filePaths = pcGitCommitFiles.map(f => f.file);
        const res1 = await fetch('/api/git/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': (typeof token !== 'undefined' ? token : '') },
            body: JSON.stringify({ cwd: Desktop.git.cwd, paths: filePaths })
        });
        const data1 = await res1.json();

        if (!data1.success) {
            if (typeof toast === 'function') toast('Add failed: ' + data1.error, 'error');
            return;
        }

        // Git commit
        const res2 = await fetch('/api/git/commit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': (typeof token !== 'undefined' ? token : '') },
            body: JSON.stringify({ cwd: Desktop.git.cwd, message })
        });
        const data2 = await res2.json();

        if (data2.success) {
            pcGitCloseModal('pc-git-commit-modal');
            if (typeof toast === 'function') toast('Committed!', 'success');
            await pcGitRefresh();
        } else {
            if (typeof toast === 'function') toast('Commit failed: ' + data2.error, 'error');
        }
    } catch (e) {
        if (typeof toast === 'function') toast('Commit error', 'error');
    }
}

// Show push modal
async function pcGitShowPushModal() {
    document.getElementById('pc-git-push-modal')?.remove();

    const modal = document.createElement('div');
    modal.className = 'pc-git-modal';
    modal.id = 'pc-git-push-modal';
    modal.innerHTML = `
        <div class="pc-git-modal-content pc-git-modal-small">
            <div class="pc-git-modal-header">
                <span>Push to Remote</span>
                <button onclick="pcGitCloseModal('pc-git-push-modal')">[x]</button>
            </div>
            <div class="pc-git-modal-body">
                <div class="pc-git-field">
                    <label>Branch</label>
                    <select id="pc-git-push-branch">
                        ${Desktop.git.branches.map(b => `<option value="${escapeHtml(b)}" ${b === Desktop.git.branch ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
                    </select>
                </div>
                ${!Desktop.git.hasUpstream ? `
                <div class="pc-git-field">
                    <label><input type="checkbox" id="pc-git-set-upstream" checked> Set upstream (-u)</label>
                </div>
                ` : ''}
            </div>
            <div class="pc-git-modal-footer">
                <button onclick="pcGitCloseModal('pc-git-push-modal')">Cancel</button>
                <button onclick="pcGitDoPush()">Push</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) pcGitCloseModal('pc-git-push-modal');
    });
}

// Do push
async function pcGitDoPush() {
    const branch = document.getElementById('pc-git-push-branch')?.value;
    const setUpstreamEl = document.getElementById('pc-git-set-upstream');
    const setUpstream = setUpstreamEl ? setUpstreamEl.checked : false;

    try {
        const res = await fetch('/api/git/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': (typeof token !== 'undefined' ? token : '') },
            body: JSON.stringify({ cwd: Desktop.git.cwd, branch, setUpstream })
        });
        const data = await res.json();

        pcGitCloseModal('pc-git-push-modal');

        if (data.success) {
            if (typeof toast === 'function') toast('Pushed!', 'success');
            await pcGitRefresh();
        } else {
            if (typeof toast === 'function') toast('Push failed: ' + data.error, 'error');
        }
    } catch (e) {
        if (typeof toast === 'function') toast('Push error', 'error');
    }
}

// Close modal helper
function pcGitCloseModal(id) {
    document.getElementById(id)?.remove();
}

window.pcGitInit = pcGitInit;
window.pcGitToggleCollapse = pcGitToggleCollapse;
window.pcGitRefresh = pcGitRefresh;
window.pcGitRender = pcGitRender;
window.pcGitRenderEmpty = pcGitRenderEmpty;
window.pcGitShowProjectPicker = pcGitShowProjectPicker;
window.pcGitBrowseDir = pcGitBrowseDir;
window.pcGitSelectProject = pcGitSelectProject;
window.pcGitInitRepo = pcGitInitRepo;
window.pcGitShowBranchPicker = pcGitShowBranchPicker;
window.pcGitCheckout = pcGitCheckout;
window.pcGitSetupRemote = pcGitSetupRemote;
window.pcGitSaveRemote = pcGitSaveRemote;
window.pcGitManageToken = pcGitManageToken;
window.pcGitUpdateCredentials = pcGitUpdateCredentials;
window.pcGitSaveCredentials = pcGitSaveCredentials;
window.pcGitShowCommitModal = pcGitShowCommitModal;
window.pcGitRenderCommitFiles = pcGitRenderCommitFiles;
window.pcGitRemoveFile = pcGitRemoveFile;
window.pcGitDoCommit = pcGitDoCommit;
window.pcGitShowPushModal = pcGitShowPushModal;
window.pcGitDoPush = pcGitDoPush;
window.pcGitCloseModal = pcGitCloseModal;

})();
