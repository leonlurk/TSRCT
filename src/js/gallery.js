// ==============================================
// TSRCT - Server Gallery
// Image upload, gallery management
// Phase 3B: IIFE-wrapped -- 30 internal fns private; explicit exports at bottom.
// ==============================================
(function () {

        // ═══════════════════════════════════════════════════════════════════
        // SERVER GALLERY  (mobile + the RD terminal overlay)
        //
        // Rebuilt 2026-09-05. The old grid was three 1:1 tiles per row with
        // `object-fit: cover`, and every file in that folder is called
        // `mobile-upload-<epoch>.jpg` -- so 175 phone screenshots rendered as
        // 175 identical crops of their own middles and picking the right one
        // was guesswork. Three things fix that, and they are all the same idea
        // (SHOW the difference instead of storing it):
        //   - the whole image (`contain`), not a centre crop, on taller tiles,
        //     at a column count Leon chooses and that sticks (1 / 2 / 3);
        //   - a date + size caption, because the FILENAME is not an identity
        //     here -- the timestamp is the only thing that differs;
        //   - a full-screen viewer with prev/next, for when the thumbnail
        //     genuinely cannot answer it.
        // Delete lives here too (per image, selection, or the whole folder).
        // Every destructive path goes through ONE confirm strip -- there is no
        // route from a single tap to a deleted file.
        // ═══════════════════════════════════════════════════════════════════
        let serverGalleryImages = [];
        let selectedServerImages = new Set();   // keyed by img.path (attachments use paths)
        let galleryCols = 2;
        let galleryPending = null;              // { names: [...], label, verb } while confirming
        let galleryViewerIndex = -1;

        function galleryPrefGet(key, fallback) {
            if (typeof window.pcPrefGet === 'function') return window.pcPrefGet(key, 'browser', fallback);
            try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
        }

        function galleryPrefSet(key, value) {
            if (typeof window.pcPrefSet === 'function') { window.pcPrefSet(key, value, 'browser'); return; }
            try { localStorage.setItem(key, String(value)); } catch (e) {}
        }

        function showGalleryModal() {
            galleryCols = parseInt(galleryPrefGet('gallery-cols', '2'), 10) || 2;
            $('gallery-modal').classList.remove('hidden');
            galleryCancelConfirm();
            loadServerGallery();
        }

        function hideGalleryModal() {
            const modal = $('gallery-modal');
            modal.classList.add('hidden');
            modal.classList.remove('rd-themed');
            modal.style.zIndex = '';
            // Restore terminal overlay z-index if it was lowered
            const rdOverlay = document.getElementById('rd-terminal-overlay');
            if (rdOverlay) rdOverlay.style.zIndex = '';
            galleryCloseViewer();
            galleryCancelConfirm();
            selectedServerImages.clear();
            updateGalleryAttachBtn();
            window.rdOverlayGalleryMode = false;
        }

        // 8367 -> "8 KB", 1258291 -> "1.2 MB". Always with a unit: a bare number
        // in a row of thumbnails reads as an index, not a size.
        function galleryFmtSize(bytes) {
            const n = Number(bytes) || 0;
            if (n < 1024) return n + ' B';
            if (n < 1048576) return Math.round(n / 1024) + ' KB';
            return (n / 1048576).toFixed(1) + ' MB';
        }

        // "Sep 5 13:55". Built by hand rather than through toLocaleString
        // because the phone's locale is Spanish and the whole app is English.
        const GALLERY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        function galleryFmtWhen(ms) {
            const d = new Date(Number(ms) || 0);
            if (isNaN(d.getTime())) return '';
            const pad = (n) => String(n).padStart(2, '0');
            const today = new Date();
            const sameDay = d.toDateString() === today.toDateString();
            const time = pad(d.getHours()) + ':' + pad(d.getMinutes());
            return sameDay ? 'Today ' + time : GALLERY_MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + time;
        }

        async function loadServerGallery() {
            const grid = $('gallery-grid');
            const count = $('gallery-count');

            grid.innerHTML = '<div class="gallery-empty">Loading images...</div>';
            count.textContent = 'Loading...';

            try {
                const res = await fetch('/api/images', {
                    headers: { 'Authorization': token }
                });
                const data = await res.json();

                if (!data.success) throw new Error(data.error || 'Failed');

                serverGalleryImages = data.images || [];

                // A selection can outlive the images it points at (another
                // window deleted them, or this one just did). Prune it, or the
                // ATTACH count promises files that are gone.
                const live = new Set(serverGalleryImages.map(img => img.path));
                for (const p of Array.from(selectedServerImages)) {
                    if (!live.has(p)) selectedServerImages.delete(p);
                }

                renderServerGallery(data.bytes);

            } catch (e) {
                console.error('Gallery load error:', e);
                grid.innerHTML = `<div class="gallery-empty gallery-err">Error: ${escapeHtml(e.message)}</div>`;
                count.textContent = 'Failed to load';
            }
        }

        function renderServerGallery(totalBytes) {
            const grid = $('gallery-grid');
            const count = $('gallery-count');
            const n = serverGalleryImages.length;

            if (typeof totalBytes !== 'number') {
                totalBytes = serverGalleryImages.reduce((s, img) => s + (img.size || 0), 0);
            }
            count.textContent = n
                ? `${n} image${n === 1 ? '' : 's'} · ${galleryFmtSize(totalBytes)}`
                : 'Folder is empty';

            grid.className = 'gallery-grid cols-' + galleryCols;
            const zoom = $('gallery-zoom');
            if (zoom) {
                zoom.querySelectorAll('button').forEach(b => {
                    b.classList.toggle('active', b.dataset.cols === String(galleryCols));
                });
            }

            if (n === 0) {
                grid.innerHTML = '<div class="gallery-empty">No images on the server.<br>Upload some from your phone first.</div>';
                updateGalleryAttachBtn();
                return;
            }

            grid.innerHTML = serverGalleryImages.map((img, idx) => `
                <div class="gallery-item${selectedServerImages.has(img.path) ? ' selected' : ''}"
                     data-index="${idx}" data-path="${escapeHtml(img.path)}"
                     onclick="toggleServerImage(${idx})">
                    <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.filename)}" loading="lazy">
                    <button class="gi-btn gi-del" title="Delete this image"
                            onclick="event.stopPropagation();galleryDeleteOne(${idx})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                    </button>
                    <button class="gi-btn gi-zoom" title="View full screen"
                            onclick="event.stopPropagation();galleryOpenViewer(${idx})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                    </button>
                    <div class="gi-meta"><span class="gi-when">${escapeHtml(galleryFmtWhen(img.modified))}</span><span class="gi-size"> · ${escapeHtml(galleryFmtSize(img.size))}</span></div>
                    <div class="gallery-check">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>
                </div>
            `).join('');

            updateGalleryAttachBtn();
        }

        function gallerySetCols(n) {
            galleryCols = Math.min(3, Math.max(1, parseInt(n, 10) || 2));
            galleryPrefSet('gallery-cols', galleryCols);
            renderServerGallery();
        }

        function toggleServerImage(index) {
            const img = serverGalleryImages[index];
            if (!img) return;

            if (selectedServerImages.has(img.path)) {
                selectedServerImages.delete(img.path);
            } else {
                selectedServerImages.add(img.path);
            }

            // Update UI
            const items = document.querySelectorAll('#gallery-grid .gallery-item');
            items.forEach(item => {
                const path = item.dataset.path;
                item.classList.toggle('selected', selectedServerImages.has(path));
            });

            updateGalleryAttachBtn();
        }

        function gallerySelectAll() {
            serverGalleryImages.forEach(img => selectedServerImages.add(img.path));
            renderServerGallery();
        }

        function galleryClearSelection() {
            selectedServerImages.clear();
            renderServerGallery();
        }

        function updateGalleryAttachBtn() {
            const count = selectedServerImages.size;
            const btn = $('gallery-attach-btn');
            if (btn) {
                btn.textContent = `ATTACH (${count})`;
                btn.disabled = count === 0;
            }
            const del = $('gallery-del-btn');
            if (del) {
                del.textContent = `DELETE (${count})`;
                del.disabled = count === 0;
            }
            const empty = $('gallery-empty-btn');
            if (empty) empty.disabled = serverGalleryImages.length === 0;
            if (galleryViewerIndex >= 0) galleryUpdateViewerChrome();
        }

        // ── Deleting ────────────────────────────────────────────────────────
        // Every delete -- one tile, the selection, or the whole folder -- parks
        // in `galleryPending` and waits for the confirm strip. One path, so
        // there is no button anywhere that destroys a file on a single tap.
        function galleryFilenamesFor(paths) {
            const byPath = new Map(serverGalleryImages.map(img => [img.path, img.filename]));
            return paths.map(p => byPath.get(p)).filter(Boolean);
        }

        function galleryShowConfirm(names, label, verb) {
            galleryPending = { names, label, verb: verb || 'DELETE' };
            const bar = $('gallery-confirm');
            const text = $('gallery-confirm-text');
            const yes = $('gallery-confirm-yes');
            if (text) text.textContent = label;
            if (yes) yes.textContent = galleryPending.verb;
            if (bar) bar.classList.remove('hidden');
            const actions = $('gallery-actions');
            if (actions) actions.classList.add('hidden');
        }

        function galleryCancelConfirm() {
            galleryPending = null;
            const bar = $('gallery-confirm');
            if (bar) bar.classList.add('hidden');
            const actions = $('gallery-actions');
            if (actions) actions.classList.remove('hidden');
        }

        function galleryDeleteOne(index) {
            const img = serverGalleryImages[index];
            if (!img) return;
            galleryShowConfirm([img.filename],
                `Delete this image? ${galleryFmtWhen(img.modified)} · ${galleryFmtSize(img.size)}. This cannot be undone.`);
        }

        function galleryAskDelete() {
            const names = galleryFilenamesFor(Array.from(selectedServerImages));
            if (!names.length) return;
            galleryShowConfirm(names,
                `Delete ${names.length} selected image${names.length === 1 ? '' : 's'}? This cannot be undone.`);
        }

        function galleryAskEmpty() {
            const n = serverGalleryImages.length;
            if (!n) return;
            const bytes = serverGalleryImages.reduce((s, img) => s + (img.size || 0), 0);
            galleryShowConfirm(null,
                `Empty the whole folder: ALL ${n} images (${galleryFmtSize(bytes)}). This cannot be undone.`,
                'EMPTY IT');
        }

        async function galleryConfirmRun() {
            if (!galleryPending) return;
            const { names } = galleryPending;
            galleryCancelConfirm();
            if (names === null) await galleryEmptyFolder();
            else await galleryDeleteNames(names);
        }

        // Drop deleted files from anything still pointing at them, so a prompt
        // never ships a path that no longer exists.
        function galleryForgetAttachments(paths) {
            const gone = new Set(paths);
            if (typeof attachedImages !== 'undefined' && Array.isArray(attachedImages)) {
                for (let i = attachedImages.length - 1; i >= 0; i--) {
                    if (gone.has(attachedImages[i])) attachedImages.splice(i, 1);
                }
                updateAttachmentIndicator();
            }
            if (Array.isArray(window.rdOverlayAttached)) {
                for (let i = window.rdOverlayAttached.length - 1; i >= 0; i--) {
                    if (gone.has(window.rdOverlayAttached[i])) window.rdOverlayAttached.splice(i, 1);
                }
                if (typeof window.rdUpdateOverlayAttachIndicator === 'function') window.rdUpdateOverlayAttachIndicator();
            }
        }

        async function galleryRunDelete(url, body) {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Authorization': token, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            // These routes ship in the same change as this panel, but the
            // PROCESS answering may predate them -- a PWA reload does not
            // restart the server. Its 404 is plain text ("Not found"), so
            // res.json() threw `Unexpected token 'N'`, which names a quote
            // character instead of the problem. Read the body once, as text,
            // and say the actual thing.
            const text = await res.text();
            if (res.status === 404) throw new Error('server is older than this route — restart the server');
            let data;
            try { data = JSON.parse(text); }
            catch (e) { throw new Error(`HTTP ${res.status}: ${text.trim().slice(0, 60) || 'no response body'}`); }
            if (!data.success) throw new Error(data.error || `delete failed (HTTP ${res.status})`);
            return data;
        }

        async function galleryDeleteNames(names) {
            const byName = new Map(serverGalleryImages.map(img => [img.filename, img.path]));
            try {
                const data = await galleryRunDelete('/api/images/delete', { filenames: names });
                const paths = (data.deleted || []).map(f => byName.get(f)).filter(Boolean);
                paths.forEach(p => selectedServerImages.delete(p));
                galleryForgetAttachments(paths);
                galleryCloseViewer();
                // Report what actually happened: a partial delete that reads as
                // a success is how you end up hunting for a file you were told
                // was gone.
                if (data.failed && data.failed.length) {
                    toast(`DELETED ${data.count}, ${data.failed.length} FAILED`, 'error');
                    console.warn('[gallery] delete failures:', data.failed);
                } else {
                    toast(`DELETED ${data.count} · ${galleryFmtSize(data.bytes)} FREED`, 'success');
                }
            } catch (e) {
                toast(`DELETE FAILED: ${e.message}`, 'error');
            }
            await loadServerGallery();
        }

        async function galleryEmptyFolder() {
            const paths = serverGalleryImages.map(img => img.path);
            try {
                const data = await galleryRunDelete('/api/images/empty', { confirm: true });
                selectedServerImages.clear();
                galleryForgetAttachments(paths);
                galleryCloseViewer();
                if (data.failed && data.failed.length) {
                    toast(`EMPTIED ${data.count}, ${data.failed.length} FAILED`, 'error');
                    console.warn('[gallery] empty failures:', data.failed);
                } else {
                    toast(`FOLDER EMPTIED · ${galleryFmtSize(data.bytes)} FREED`, 'success');
                }
            } catch (e) {
                toast(`EMPTY FAILED: ${e.message}`, 'error');
            }
            await loadServerGallery();
        }

        // ── Full-screen viewer ──────────────────────────────────────────────
        function galleryOpenViewer(index) {
            if (!serverGalleryImages[index]) return;
            galleryViewerIndex = index;
            const box = $('gallery-lightbox');
            if (box) box.classList.remove('hidden');
            galleryUpdateViewerChrome();
        }

        function galleryCloseViewer() {
            galleryViewerIndex = -1;
            const box = $('gallery-lightbox');
            if (box) box.classList.add('hidden');
            const img = $('glb-img');
            if (img) img.removeAttribute('src');   // stop decoding a picture nobody is looking at
        }

        function galleryUpdateViewerChrome() {
            const img = serverGalleryImages[galleryViewerIndex];
            if (!img) { galleryCloseViewer(); return; }
            const el = $('glb-img');
            if (el && el.getAttribute('src') !== img.url) el.src = img.url;
            const meta = $('glb-meta');
            if (meta) {
                meta.textContent = `${galleryViewerIndex + 1}/${serverGalleryImages.length} · ` +
                    `${galleryFmtWhen(img.modified)} · ${galleryFmtSize(img.size)}`;
            }
            const sel = $('glb-select');
            if (sel) {
                const on = selectedServerImages.has(img.path);
                sel.textContent = on ? 'SELECTED' : 'SELECT';
                sel.classList.toggle('on', on);
            }
        }

        function galleryViewerStep(delta) {
            if (galleryViewerIndex < 0 || !serverGalleryImages.length) return;
            const n = serverGalleryImages.length;
            galleryViewerIndex = (galleryViewerIndex + delta + n) % n;
            galleryUpdateViewerChrome();
        }

        function galleryViewerToggleSelect() {
            if (galleryViewerIndex < 0) return;
            toggleServerImage(galleryViewerIndex);
            galleryUpdateViewerChrome();
        }

        function galleryViewerDelete() {
            if (galleryViewerIndex < 0) return;
            const idx = galleryViewerIndex;
            galleryCloseViewer();
            galleryDeleteOne(idx);   // same confirm strip as everywhere else
        }

        function attachSelectedImages() {
            if (selectedServerImages.size === 0) return;

            // If called from the RD terminal overlay, target rdOverlayAttached
            if (window.rdOverlayGalleryMode && window.rdOverlayAttached) {
                for (const path of selectedServerImages) {
                    if (!window.rdOverlayAttached.includes(path)) {
                        window.rdOverlayAttached.push(path);
                    }
                }
                toast(`${selectedServerImages.size} IMG ATTACHED`, 'success');
                if (typeof window.rdUpdateOverlayAttachIndicator === 'function') window.rdUpdateOverlayAttachIndicator();
                window.rdOverlayGalleryMode = false;
                hideGalleryModal();
                return;
            }

            // Normal mode: add to main attachedImages
            for (const path of selectedServerImages) {
                if (!attachedImages.includes(path)) {
                    attachedImages.push(path);
                }
            }

            toast(`${selectedServerImages.size} IMG ATTACHED`, 'success');
            updateAttachmentIndicator();
            hideGalleryModal();
        }
        // ═══════════════════════════════════════════════════════════════════
        // SERVER FILES PICKER
        // ═══════════════════════════════════════════════════════════════════
        let serverFiles = [];
        let selectedServerFiles = new Set();

        function showFilesModal() {
            $('files-modal').classList.remove('hidden');
            loadServerFiles();
        }

        function hideFilesModal() {
            $('files-modal').classList.add('hidden');
            selectedServerFiles.clear();
            updateFilesAttachBtn();
        }

        async function loadServerFiles() {
            const list = $('files-list');
            const count = $('files-count');

            list.innerHTML = '<div class="gallery-empty">Loading files...</div>';
            count.textContent = 'Loading...';

            try {
                const res = await fetch('/api/files/list', {
                    headers: { 'Authorization': token }
                });
                const data = await res.json();
                if (!data.success) throw new Error(data.error || 'Failed');

                serverFiles = data.files || [];
                count.textContent = `${serverFiles.length} archivos en el servidor`;

                if (serverFiles.length === 0) {
                    list.innerHTML = '<div class="gallery-empty">No hay archivos en el servidor.</div>';
                    return;
                }

                list.innerHTML = serverFiles.map((f, idx) => {
                    const sizeStr = f.size < 1024 ? f.size + 'B'
                        : f.size < 1048576 ? (f.size / 1024).toFixed(1) + 'KB'
                        : (f.size / 1048576).toFixed(1) + 'MB';
                    return `<div class="file-item" data-index="${idx}" data-path="${escapeHtml(f.path)}" onclick="toggleServerFile(${idx})">
                        <div class="file-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
                        <div class="file-item-info"><div class="file-item-name">${escapeHtml(f.filename)}</div><div class="file-item-size">${sizeStr}</div></div>
                        <div class="file-item-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
                    </div>`;
                }).join('');
            } catch (e) {
                list.innerHTML = `<div class="gallery-empty" style="color:var(--red)">Error: ${e.message}</div>`;
                count.textContent = 'Error al cargar';
            }
        }

        function toggleServerFile(index) {
            const f = serverFiles[index];
            if (!f) return;
            if (selectedServerFiles.has(f.path)) {
                selectedServerFiles.delete(f.path);
            } else {
                selectedServerFiles.add(f.path);
            }
            document.querySelectorAll('.file-item').forEach(item => {
                item.classList.toggle('selected', selectedServerFiles.has(item.dataset.path));
            });
            updateFilesAttachBtn();
        }

        function updateFilesAttachBtn() {
            const btn = $('files-attach-btn');
            const c = selectedServerFiles.size;
            btn.textContent = `ADJUNTAR (${c})`;
            btn.disabled = c === 0;
        }

        function attachSelectedFiles() {
            if (selectedServerFiles.size === 0) return;
            for (const p of selectedServerFiles) {
                if (!attachedImages.includes(p)) {
                    attachedImages.push(p);
                }
            }
            toast(`${selectedServerFiles.size} FILES ATTACHED`, 'success');
            updateAttachmentIndicator();
            hideFilesModal();
        }
        // ═══════════════════════════════════════════════════════════════════

        function renderSessions(sessions, current) {
            // Mobile session modal -- same workspace filter as the PC sidebar.
            sessions = filterVisibleSessions(sessions);
            if (!sessions.length) {
                $('sessions-list').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">No tmux sessions found</div>';
                return;
            }
            $('sessions-list').innerHTML = sessions.map(s => `
                <div style="display:flex;gap:6px;align-items:stretch">
                    <button class="modal-btn ${s.current ? 'current' : ''}" style="flex:1" onclick="switchSession('${s.name.replace(/'/g, "\\'")}')">
                        <span class="modal-btn-title">${s.current ? '● ' : ''}${s.protected ? '🛡 ' : ''}${escapeHtml(s.name)}${window.SessionWeight ? window.SessionWeight.badge(s.name) : ''}</span>
                        <span class="modal-btn-desc">${s.windows} win${s.attached ? ' • attached' : ''}${s.protected ? ' • server' : ''}</span>
                    </button>
                    ${s.protected ? '' : `<button class="modal-btn danger" style="width:44px;display:flex;align-items:center;justify-content:center" onclick="killSession('${s.name.replace(/'/g, "\\'")}')">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>`}
                </div>
            `).join('');
        }
        async function switchSession(name) {
            hideSessionsModal();
            try {
                const r = await fetch('/api/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ session: name })
                });
                const d = await r.json();
                if (d.success) {
                    homeSession = name; // Update local session tracker
                    updateHomeSessionDisplay(); // Update UI label
                    $('terminal').textContent = '> Switched to ' + name + '...'; // Clear old output
                    playSound('success');
                    toast('Session: ' + name, 'success', false);
                    schedulePoll(300); // Poll faster to show new content
                } else {
                    playSound('error');
                    toast(d.error || 'Failed', 'error', false);
                }
            } catch (e) {
                toast('Error switching session', 'error');
            }
        }
        async function createNewSession() {
            const name = prompt('Session name (leave empty for auto):');
            if (name === null) return; // cancelled
            hideSessionsModal();
            try {
                const r = await fetch('/api/session/new', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ name: name || '' })
                });
                const d = await r.json();
                if (d.success) {
                    // Auto-switch to the new session, and claim it for this window.
                    if (window.tsrctOwnSession) window.tsrctOwnSession(d.session);
                    homeSession = d.session;
                    updateHomeSessionDisplay();
                    $('terminal').textContent = '> New session: ' + d.session;
                    playSound('success');
                    toast('Created & switched: ' + d.session, 'success', false);
                    schedulePoll(300);
                } else {
                    playSound('error');
                    toast(d.error || 'Failed', 'error', false);
                }
            } catch (e) {
                toast('Error creating session', 'error');
            }
        }
        async function killSession(name) {
            if (!confirm('Kill session "' + name + '"?')) return;
            try {
                const r = await fetch('/api/session/kill', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ name })
                });
                const d = await r.json();
                if (d.success) {
                    playSound('deny');
                    toast('Killed: ' + name, 'error', false);
                    showSessionsModal(); // Refresh list
                } else {
                    playSound('error');
                    toast(d.error || 'Failed', 'error', false);
                }
            } catch (e) {
                toast('Error killing session', 'error');
            }
        }
        function renderContext(ctx) {
            if (ctx.error) { $('context-body').innerHTML = '<div style="text-align:center;padding:20px;color:var(--red)">' + escapeHtml(ctx.error) + '</div>'; return; }
            let h = '<div class="ctx-section"><div class="ctx-label">Project</div><div class="ctx-value">' + escapeHtml(ctx.projectName) + '</div><div style="font-size:0.5rem;color:var(--text-muted)">' + escapeHtml(ctx.path) + '</div></div>';
            if (ctx.branch && ctx.branch !== 'N/A') {
                h += '<div class="ctx-section"><div class="ctx-label">Git</div><div class="ctx-branch">' + escapeHtml(ctx.branch) + '</div>';
                if (ctx.lastCommit) h += '<div class="ctx-commit">' + escapeHtml(ctx.lastCommit) + '</div>';
                h += '</div>';
            }
            if (ctx.gitStatus) h += '<div class="ctx-section"><div class="ctx-label">Changes</div><div class="ctx-changes">' + escapeHtml(ctx.gitStatus) + '</div></div>';
            if (ctx.packageInfo) {
                const p = ctx.packageInfo;
                h += '<div class="ctx-section"><div class="ctx-label">Package</div><div class="ctx-stats"><div class="ctx-stat"><div class="ctx-stat-val">' + p.version + '</div><div class="ctx-stat-lbl">Ver</div></div><div class="ctx-stat"><div class="ctx-stat-val">' + p.deps + '</div><div class="ctx-stat-lbl">Deps</div></div><div class="ctx-stat"><div class="ctx-stat-val">' + p.devDeps + '</div><div class="ctx-stat-lbl">Dev</div></div></div>';
                if (p.scripts && p.scripts.length) h += '<div class="ctx-pkg">' + p.scripts.map(s => '<span class="ctx-pkg-item">' + s + '</span>').join('') + '</div>';
                h += '</div>';
            }
            if (ctx.tree) h += '<div class="ctx-section"><div class="ctx-label">Tree</div><div class="ctx-tree">' + escapeHtml(ctx.tree) + '</div></div>';
            if (ctx.readme) h += '<div class="ctx-section"><div class="ctx-label">README</div><div class="ctx-readme">' + escapeHtml(ctx.readme) + '</div></div>';
            $('context-body').innerHTML = h;
        }

        // Upload images - convert to JPEG, resize and attach (supports multiple)
        // Tracks whether the phone picker was triggered from RD overlay
        let galleryPhoneForOverlay = false;

        function galleryPickPhone() {
            if (window.rdOverlayGalleryMode) {
                galleryPhoneForOverlay = true;
            }
            hideGalleryModal();
            $('gallery-input').click();
        }

        async function uploadImages(input) {
            const files = Array.from(input.files);
            if (!files.length) { galleryPhoneForOverlay = false; return; }

            const forOverlay = galleryPhoneForOverlay;
            galleryPhoneForOverlay = false;

            const btn = document.querySelector('.cam-btn');
            if (btn) btn.classList.add('loading');
            toast(`PROCESSING ${files.length} IMG...`, 'success');

            let uploaded = 0;
            let lastError = null;

            if (forOverlay && window.rdOverlayAttached) {
                // RD overlay mode: route to rdOverlayAttached
                const savedAttached = (typeof attachedImages !== 'undefined') ? [...attachedImages] : [];
                for (const file of files) {
                    try {
                        if (typeof processAndUploadImage === 'function') {
                            await processAndUploadImage(file);
                            if (typeof attachedImages !== 'undefined' && attachedImages.length > savedAttached.length + uploaded) {
                                window.rdOverlayAttached.push(attachedImages[attachedImages.length - 1]);
                            }
                        }
                        uploaded++;
                    } catch (e) {
                        console.error('Upload error:', e);
                        lastError = e;
                    }
                }
                // Restore main attachedImages
                if (typeof attachedImages !== 'undefined') {
                    attachedImages.length = 0;
                    savedAttached.forEach(p => attachedImages.push(p));
                }
                if (typeof updateAttachmentIndicator === 'function') updateAttachmentIndicator();
                if (typeof window.rdUpdateOverlayAttachIndicator === 'function') window.rdUpdateOverlayAttachIndicator();
            } else {
                // Normal mode
                for (const file of files) {
                    try {
                        await processAndUploadImage(file);
                        uploaded++;
                    } catch (e) {
                        console.error('Upload error:', e);
                        lastError = e;
                    }
                }
                updateAttachmentIndicator();
            }

            if (btn) btn.classList.remove('loading');
            input.value = '';

            if (uploaded > 0) {
                toast(`${uploaded} IMG ATTACHED`, 'success');
            } else if (lastError) {
                toast('IMG FAILED: ' + (lastError.toString ? lastError.toString().substring(0, 30) : 'Memory error'), 'error');
            }
        }

        // Upload any file type to centralized /PROJECTS/files/
        async function uploadFile(input) {
            const file = input.files[0];
            if (!file) return;

            toast('UPLOADING FILE...', 'success');
            try {
                const reader = new FileReader();
                const data = await new Promise((resolve, reject) => {
                    reader.onload = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                const res = await fetch('/api/upload-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ data, filename: file.name })
                });
                const d = await res.json();
                if (d.success) {
                    attachedImages.push(d.path);
                    updateAttachmentIndicator();
                    toast('FILE ATTACHED: ' + d.filename, 'success');
                } else {
                    toast('UPLOAD FAILED', 'error');
                }
            } catch (e) {
                toast('UPLOAD ERROR', 'error');
            }
            input.value = '';
        }

        // Process single image - resize and upload (with memory cleanup)
        async function processAndUploadImage(file) {
            return new Promise((resolve, reject) => {
                // Use object URL instead of base64 for better memory efficiency
                const objectUrl = URL.createObjectURL(file);
                const img = new Image();

                const cleanup = () => {
                    // Release memory
                    URL.revokeObjectURL(objectUrl);
                    img.onload = null;
                    img.onerror = null;
                    img.src = '';
                };

                img.onload = async () => {
                    let canvas = null;
                    try {
                        // Resize if too large (max 1000px for better memory)
                        const MAX_SIZE = 1000;
                        let width = img.width;
                        let height = img.height;

                        if (width > MAX_SIZE || height > MAX_SIZE) {
                            if (width > height) {
                                height = Math.round(height * MAX_SIZE / width);
                                width = MAX_SIZE;
                            } else {
                                width = Math.round(width * MAX_SIZE / height);
                                height = MAX_SIZE;
                            }
                        }

                        canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);

                        // JPEG with quality 0.6 for better compression
                        const jpegData = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];

                        // Clear canvas immediately to free memory
                        canvas.width = 0;
                        canvas.height = 0;
                        canvas = null;

                        const r = await fetch('/api/upload-image', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: token },
                            body: JSON.stringify({ image: jpegData, format: 'jpg' })
                        });
                        const d = await r.json();
                        cleanup();

                        if (d.success) {
                            attachedImages.push(d.path);
                            resolve(d.path);
                        } else {
                            reject('Upload failed');
                        }
                    } catch (e) {
                        cleanup();
                        if (canvas) { canvas.width = 0; canvas.height = 0; }
                        reject(e.message || 'Memory error - try a smaller image');
                    }
                };

                img.onerror = () => {
                    cleanup();
                    reject('Failed to load image');
                };

                img.src = objectUrl;
            });
        }

        // Mostrar indicador de imágenes adjuntas
        function updateAttachmentIndicator() {
            let ind = $('attach-indicator');
            if (!ind) {
                ind = document.createElement('div');
                ind.id = 'attach-indicator';
                ind.className = 'attach-indicator';
                document.querySelector('.input-area').insertBefore(ind, document.querySelector('.input-row'));
            }
            const hasFiles = attachedImages.length > 0;
            const hasRunners = typeof attachedRunners !== 'undefined' && attachedRunners.length > 0;
            const hasOrgs = typeof attachedOrgs !== 'undefined' && attachedOrgs.length > 0;

            if (hasFiles || hasRunners || hasOrgs) {
                ind.classList.remove('hidden');
                let html = '';
                if (hasFiles) {
                    html += attachedImages.map((path, i) =>
                        `<span class="attach-item"><span class="attach-name" onclick="startRenameAttachment(${i})" title="Rename">[F] ${escapeHtml(path.split(/[/\\]/).pop())}</span> <button class="attach-rename-btn" onclick="startRenameAttachment(${i})" title="Rename"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button><button onclick="removeAttachment(${i})">x</button></span>`
                    ).join('');
                }
                if (hasRunners) {
                    html += attachedRunners.map((r, i) =>
                        `<span class="attach-item runner">[T] ${r.name} <button onclick="removeRunnerAttachment(${i})">x</button></span>`
                    ).join('');
                }
                if (hasOrgs) {
                    html += attachedOrgs.map((o, i) =>
                        `<span class="attach-item org">[SF] ${o.alias} <button onclick="removeOrgAttachment(${i})">x</button></span>`
                    ).join('');
                }
                html += `<button class="attach-clear" onclick="clearAttachment()">Clear All</button>`;
                ind.innerHTML = html;
            } else {
                ind.classList.add('hidden');
                ind.innerHTML = '';
            }
            // The same list above the FULLSCREEN input (2026-10-08): attaching
            // there worked, but what was attached only showed on the home
            // screen, under the fullscreen layer.
            let fsInd = $('fs-attach-indicator');
            const fsRow = document.querySelector('#fs-quick .fs-input-row');
            if (!fsInd && fsRow) {
                fsInd = document.createElement('div');
                fsInd.id = 'fs-attach-indicator';
                fsInd.className = 'attach-indicator';
                fsRow.parentNode.insertBefore(fsInd, fsRow);
            }
            if (fsInd) {
                fsInd.innerHTML = ind.innerHTML;
                fsInd.classList.toggle('hidden', ind.classList.contains('hidden'));
            }
        }

        function removeAttachment(index) {
            attachedImages.splice(index, 1);
            updateAttachmentIndicator();
            updateIfsAttach();
            toast('IMG REMOVED', 'error');
        }

        // Turn a file chip into an inline rename editor
        function startRenameAttachment(index) {
            // Rename in the list you can SEE: fullscreen has its own copy.
            const ind = (deckIsOpen() && $('fs-attach-indicator')) || $('attach-indicator');
            if (!ind || !attachedImages[index]) return;
            const items = ind.querySelectorAll('.attach-item:not(.runner):not(.org)');
            const item = items[index];
            if (!item) return;
            const current = attachedImages[index].split(/[/\\]/).pop();
            item.innerHTML = `<input class="attach-rename-input" type="text" value="${escapeHtml(current)}" spellcheck="false"><button class="attach-rename-ok" title="OK">OK</button><button class="attach-rename-cancel" title="Cancel">x</button>`;
            const input = item.querySelector('.attach-rename-input');
            const commit = () => commitRenameAttachment(index, input.value);
            item.querySelector('.attach-rename-ok').onclick = commit;
            item.querySelector('.attach-rename-cancel').onclick = () => updateAttachmentIndicator();
            input.onkeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                else if (e.key === 'Escape') { e.preventDefault(); updateAttachmentIndicator(); }
            };
            input.focus();
            const dot = current.lastIndexOf('.');
            input.setSelectionRange(0, dot > 0 ? dot : current.length);
        }

        // Rename the on-disk attachment; update the path Claude will receive
        async function commitRenameAttachment(index, newName) {
            const oldPath = attachedImages[index];
            if (!oldPath) return;
            const current = oldPath.split(/[/\\]/).pop();
            newName = (newName || '').trim();
            if (!newName || newName === current) { updateAttachmentIndicator(); return; }
            try {
                const res = await fetch('/api/files/rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ oldPath, newName })
                });
                const d = await res.json();
                if (d.success) {
                    attachedImages[index] = d.path;
                    if (Array.isArray(window.rdOverlayAttached)) {
                        const oi = window.rdOverlayAttached.indexOf(oldPath);
                        if (oi !== -1) window.rdOverlayAttached[oi] = d.path;
                    }
                    updateAttachmentIndicator();
                    if (typeof updateIfsAttach === 'function') updateIfsAttach();
                    toast('RENAMED: ' + d.filename, 'success');
                } else {
                    updateAttachmentIndicator();
                    toast('RENAME FAILED: ' + (d.error || ''), 'error');
                }
            } catch (e) {
                updateAttachmentIndicator();
                toast('RENAME ERROR', 'error');
            }
        }

        function clearAttachment() {
            attachedImages = [];
            if (typeof attachedRunners !== 'undefined') attachedRunners.length = 0;
            if (typeof attachedOrgs !== 'undefined') attachedOrgs.length = 0;
            updateAttachmentIndicator();
            updateIfsAttach();
            toast('ALL CLEARED', 'error');
        }

        function removeRunnerAttachment(index) {
            if (typeof attachedRunners !== 'undefined') {
                attachedRunners.splice(index, 1);
                updateAttachmentIndicator();
                toast('RUNNER REMOVED', 'error');
            }
        }

        function removeOrgAttachment(index) {
            if (typeof attachedOrgs !== 'undefined') {
                attachedOrgs.splice(index, 1);
                updateAttachmentIndicator();
                toast('ORG REMOVED', 'error');
            }
        }

        // Speech Recognition
        function initSpeechRecognition() {
            const rec = createSpeechRecognizer({
                continuous: false, // Desactivado para evitar duplicación
                interimResults: false, // Solo resultados finales
                lang: speechLang, // Usar idioma seleccionado
                onResult: (e) => {
                    let transcript = '';
                    for (let i = e.resultIndex; i < e.results.length; i++) {
                        transcript += e.results[i][0].transcript;
                    }
                    // Actualizar input con el texto reconocido
                    const input = $('prompt');
                    const existing = input.dataset.preVoice || '';
                    input.value = existing + transcript;
                },
                onStart: () => {
                    isRecording = true;
                    $('mic-btn').classList.add('recording');
                    $('prompt').dataset.preVoice = $('prompt').value;
                    toast('LISTENING...', 'success');
                },
                onEnd: () => {
                    isRecording = false;
                    $('mic-btn').classList.remove('recording');
                    delete $('prompt').dataset.preVoice;
                },
                onError: (e) => {
                    console.error('Speech error:', e.error);
                    isRecording = false;
                    $('mic-btn').classList.remove('recording');
                    if (e.error === 'not-allowed') {
                        toast('MIC DENIED', 'error');
                    } else {
                        toast('MIC ERROR', 'error');
                    }
                }
            });
            if (!rec) { console.log('Speech recognition not supported'); return null; }
            return rec;
        }

        function toggleMic() {
            // Si ya estamos grabando, solo parar y cerrar fullscreen
            if (wantRecording) {
                toggleMicFs();
                closeInputFs();
                return;
            }
            // Abrir fullscreen sin focus (para no abrir teclado) y empezar a dictar
            openInputFs(true);
            setTimeout(() => toggleMicFs(), 100);
        }

        // Toggle idioma de dictado
        function toggleLang() {
            // Cambiar idioma
            if (speechLang === 'es-ES') {
                speechLang = 'en-US';
                $('ifs-lang-btn').textContent = 'EN';
                toast('ENGLISH', 'success');
            } else {
                speechLang = 'es-ES';
                $('ifs-lang-btn').textContent = 'ES';
                toast('ESPAÑOL', 'success');
            }
            // Reiniciar recognition para aplicar nuevo idioma
            if (recognition) {
                if (wantRecording) {
                    wantRecording = false;
                    recognition.stop();
                }
                recognition = null;
            }
        }

        // Fullscreen Input functions
        function openInputFs(noFocus) {
            $('ifs-input').value = $('prompt').value;
            $('input-fs').classList.add('active');
            document.body.style.overflow = 'hidden';
            updateIfsAttach();
            if (!noFocus) {
                $('ifs-input').focus();
            }
        }

        function closeInputFs() {
            // Sync back to small input
            $('prompt').value = $('ifs-input').value;
            $('input-fs').classList.remove('active');
            document.body.style.overflow = '';
            // Stop mic if recording
            if (isRecording && recognition) {
                recognition.stop();
            }
        }

        function sendFromFs() {
            // Capture the dictated text into the real input, then CLEAR the
            // fullscreen buffer so it can't be re-synced back into #prompt when the
            // mic is later turned off (that resync was the "sent text reappears" bug).
            // Close inline (NOT closeInputFs, which would re-copy ifs-input → prompt).
            $('prompt').value = $('ifs-input').value;
            $('ifs-input').value = '';
            $('prompt').dataset.preVoice = '';   // reset the dictation base so nothing accumulates
            $('input-fs').classList.remove('active');
            document.body.style.overflow = '';
            send();
        }

        function toggleMicFs() {
            if (!recognition) {
                recognition = initSpeechRecognition();
                if (!recognition) {
                    toast('NOT SUPPORTED', 'error');
                    return;
                }
                // Override to update fullscreen input - solo agregar resultado final
                recognition.onresult = (e) => {
                    const input = $('ifs-input');
                    // Tomar solo el último resultado final
                    const result = e.results[e.results.length - 1];
                    if (result && result.isFinal) {
                        const text = result[0].transcript.toLowerCase();
                        // Agregar al texto existente con espacio
                        if (input.value && !input.value.endsWith(' ')) {
                            input.value += ' ';
                        }
                        input.value += text;
                    }
                };
                recognition.onstart = () => {
                    isRecording = true;
                    $('ifs-mic-btn')?.classList.add('recording');
                    $('mic-btn')?.classList.add('recording');
                };
                recognition.onend = () => {
                    isRecording = false;
                    // Si queremos seguir grabando, reiniciar
                    if (wantRecording) {
                        try {
                            recognition.start();
                        } catch (e) {
                            // Ignorar errores de reinicio
                        }
                    } else {
                        $('ifs-mic-btn')?.classList.remove('recording');
                        $('mic-btn')?.classList.remove('recording');
                    }
                };
            }

            if (wantRecording) {
                // Parar grabación
                wantRecording = false;
                recognition.stop();
                toast('MIC OFF', 'error');
                trackTranscription();
            } else {
                // Iniciar grabación
                wantRecording = true;
                toast('LISTENING...', 'success');
                recognition.start();
            }
        }

        // Voice recognition for fullscreen terminal input
        let fsRecognition = null;
        let fsMicRecording = false;

        function toggleFsMic() {
            if (!fsRecognition) {
                fsRecognition = initSpeechRecognition();
                if (!fsRecognition) {
                    toast('NOT SUPPORTED', 'error');
                    return;
                }
                fsRecognition.onresult = (e) => {
                    const input = $('fs-prompt');
                    const result = e.results[e.results.length - 1];
                    if (result && result.isFinal) {
                        const text = result[0].transcript.toLowerCase();
                        if (input.value && !input.value.endsWith(' ')) {
                            input.value += ' ';
                        }
                        input.value += text;
                        // Also save to panel state
                        if (splitPanels[activePanel]) {
                            splitPanels[activePanel].inputValue = input.value;
                        }
                    }
                };
                fsRecognition.onstart = () => {
                    fsMicRecording = true;
                    $('fs-mic-btn')?.classList.add('recording');
                };
                fsRecognition.onend = () => {
                    // Keep recording if wanted
                    if (fsMicRecording) {
                        try {
                            fsRecognition.start();
                        } catch (e) {
                            fsMicRecording = false;
                            $('fs-mic-btn')?.classList.remove('recording');
                        }
                    } else {
                        $('fs-mic-btn')?.classList.remove('recording');
                    }
                };
                fsRecognition.onerror = (e) => {
                    fsMicRecording = false;
                    $('fs-mic-btn')?.classList.remove('recording');
                    if (e.error === 'not-allowed') {
                        toast('MIC DENIED', 'error');
                    }
                };
            }

            if (fsMicRecording) {
                // Stop recording
                fsMicRecording = false;
                fsRecognition.stop();
                toast('MIC OFF', 'error');
                trackTranscription();
            } else {
                // Start recording
                fsMicRecording = true;
                toast('LISTENING...', 'success');
                fsRecognition.start();
            }
        }

        function updateIfsAttach() {
            const ind = $('ifs-attach');
            if (attachedImages.length > 0) {
                ind.classList.remove('hidden');
                ind.innerHTML = attachedImages.length === 1
                    ? `📷 ${attachedImages[0].split(/[/\\]/).pop()} <button onclick="clearAttachment();updateIfsAttach()">×</button>`
                    : `📷 ${attachedImages.length} images <button onclick="clearAttachment();updateIfsAttach()">×</button>`;
            } else {
                ind.classList.add('hidden');
            }
        }

        // Drag up gesture on small input to open fullscreen
        function initInputDrag() {
            const input = $('prompt');
            let startY = 0;
            let isDragging = false;

            input.addEventListener('touchstart', (e) => {
                startY = e.touches[0].clientY;
                isDragging = true;
            });

            input.addEventListener('touchmove', (e) => {
                if (!isDragging) return;
                const deltaY = startY - e.touches[0].clientY;
                if (deltaY > 50) { // Drag up threshold
                    isDragging = false;
                    openInputFs();
                }
            });

            input.addEventListener('touchend', () => {
                isDragging = false;
            });
        }

        // Tab autocomplete - envía texto del input + Tab
        async function tabComplete() {
            const text = $('prompt').value;
            const targetSession = getCurrentTargetSession();
            try {
                if (text) {
                    // Enviar texto sin Enter
                    await fetch('/api/sendraw', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: token },
                        body: JSON.stringify({ text, session: targetSession })
                    });
                    $('prompt').value = '';
                }
                // Enviar Tab
                await fetch('/api/key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ key: 'Tab', session: targetSession })
                });
                toast('TAB', 'success');
                schedulePoll(300);
            } catch (e) { toast('ERROR', 'error'); }
        }

        // Enviar tecla especial
        async function sendKey(key) {
            try {
                const targetSession = getCurrentTargetSession();
                const r = await fetch('/api/key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: token },
                    body: JSON.stringify({ key, session: targetSession })
                });
                const d = await r.json();
                if (d.success) {
                    schedulePoll(500);
                }
            } catch (e) { toast('ERROR', 'error'); }
        }

        function addChat(msg, type) {
            chatHistory.push({ msg, type, time: new Date() });
            renderChat();
        }

        function renderChat() {
            const c = $('chat');
            c.innerHTML = chatHistory.slice(-20).map(m =>
                '<div class="chat-msg ' + m.type + '">' + escapeHtml(m.msg) + '<div class="chat-time">' + m.time.toLocaleTimeString() + '</div></div>'
            ).join('');
            c.scrollTop = c.scrollHeight;
        }

        // ── Fullscreen terminal: the SESSION DECK (mobile) ─────────────────────
        // 2026-10-08. The old fullscreen split cut a phone screen into 2-4 tiny
        // panes (two columns at 2), with three separate font controls and a typed
        // prompt() to pick a session. A phone is too narrow for side by side, so
        // the deck shows ONE session at full size and makes moving between them
        // instant:
        //   - swipe sideways = next/previous session (native CSS scroll-snap, so
        //     the motion is the browser's own, not a JS animation);
        //   - a dot strip on top carries the desktop's attention states; a
        //     session that starts waiting for you while you look at another one
        //     lights its dot and buzzes the phone once;
        //   - pinch (two fingers together) or [#] = overview of live tiles;
        //   - landscape shows two at a time, the only case where that fits;
        //   - the deck is one of the PC sidebar's FOLDERS (the same
        //     /api/sessions/groups the desktop reads), so groups are never built
        //     twice. "all" = every session this window may show.
        // splitPanels / activePanel keep their names: getCurrentTargetSession,
        // fsSend, the input drag and the keyboard scroll all read them.
        let splitPanels = [{ session: null, content: '', inputValue: '' }];
        let activePanel = 0;
        let deckGroup = null;          // a folder id, or 'all'
        let deckGroups = { groups: [], assignments: {} };
        let deckLive = [];             // live session names this window may show
        let deckStates = {};           // session -> dispatcher state
        let deckAttn = new Set();      // sessions waiting for you, not yet looked at
        let deckRemoved = new Set();   // sessions closed out of the deck this visit
        let deckOverview = false;
        let deckScrollRaf = 0;
        let deckProgrammatic = 0;      // ignore scroll events we caused ourselves
        const DECK_ATTN = new Set(['waiting_input', 'failed']);
        const DECK_POLL_MS = 3000;     // the session(s) on screen
        const DECK_BG_EVERY = 3;       // off-screen sessions: every 3rd tick
        const DECK_LIST_MS = 15000;    // session list + folders
        const DECK_STATES_MS = 6000;   // same pace as desktop's PC_STATES_EVERY_MS

        function deckEl() { return $('fs-split-container'); }
        function deckIsOpen() { const fs = $('terminal-fs'); return !!(fs && fs.classList.contains('active')); }

        function toggleFullscreen() {
            const fs = $('terminal-fs');
            const isActive = fs.classList.contains('active');
            if (!isActive) {
                fs.classList.add('active');
                document.body.style.overflow = 'hidden';
                deckRemoved = new Set();
                deckOverview = false;
                const target = homeSession || TMUX_SESSION || '';
                // Paint the current session at once; the folder fills in after.
                splitPanels = [{ session: target || null, content: '', inputValue: '' }];
                activePanel = 0;
                deckRender();
                const fsPrompt = $('fs-prompt');
                if (fsPrompt) fsPrompt.value = '';
                deckRefreshList(target).then(() => deckGoTo(deckIndexOf(target), false));
                startSplitPolling();
            } else {
                const fsPrompt = $('fs-prompt');
                if (fsPrompt && splitPanels[activePanel]) {
                    splitPanels[activePanel].inputValue = fsPrompt.value;
                }
                // The session you were looking at becomes the home screen's.
                homeSession = splitPanels[activePanel]?.session || TMUX_SESSION;
                updateHomeSessionDisplay();
                pollHomeSession();
                if (fsMicRecording && fsRecognition) {
                    fsMicRecording = false;
                    fsRecognition.stop();
                }
                fs.classList.remove('active');
                document.body.style.overflow = '';
                $('fs-quick').classList.add('hidden');
                if (window.resetFsQuickPosition) window.resetFsQuickPosition();
                stopSplitPolling();
            }
        }

        // ── Which sessions are in the deck ──────────────────────────────────
        function deckGroupOf(name) {
            const a = deckGroups.assignments || {};
            const byId = {};
            (deckGroups.groups || []).forEach(g => { byId[g.id] = g; });
            let gid = a[name];
            // A session in a sub-folder belongs to its top folder's deck, the
            // same way desktop's [Split] on a folder takes its children too.
            const seen = new Set();
            while (gid && byId[gid] && byId[gid].parent && byId[byId[gid].parent] && !seen.has(gid)) {
                seen.add(gid);
                gid = byId[gid].parent;
            }
            return gid && byId[gid] ? gid : null;
        }

        function deckMembers(group) {
            const live = deckLive.filter(n => !deckRemoved.has(n));
            if (!group || group === 'all') return live;
            return live.filter(n => deckGroupOf(n) === group);
        }

        async function deckRefreshList(preferSession) {
            try {
                const [rs, rg] = await Promise.all([
                    fetch('/api/sessions', { headers: { Authorization: token } }),
                    fetch('/api/sessions/groups', { headers: { Authorization: token } }),
                ]);
                const ds = await rs.json();
                let names = (ds.sessions || []).map(s => s.name);
                if (typeof window.tsrctFilterSessions === 'function') names = window.tsrctFilterSessions(names);
                deckLive = names;
                try { deckGroups = await rg.json(); } catch (e) { deckGroups = { groups: [], assignments: {} }; }
            } catch (e) { return; }
            if (!deckIsOpen()) return;
            // First fill: the deck is the folder of the session you opened from.
            if (deckGroup === null || (deckGroup !== 'all' && !(deckGroups.groups || []).some(g => g.id === deckGroup))) {
                const g = preferSession ? deckGroupOf(preferSession) : null;
                deckGroup = g && deckMembers(g).length > 1 ? g : 'all';
            }
            deckSync();
        }

        // Rebuild splitPanels from the folder WITHOUT losing what each panel
        // already shows (content, unsent draft) or which session you are on.
        function deckSync() {
            const current = splitPanels[activePanel]?.session || null;
            const names = deckMembers(deckGroup);
            if (current && !names.includes(current) && deckLive.includes(current)) names.unshift(current);
            if (!names.length) names.push(current || homeSession || TMUX_SESSION || null);
            const old = new Map(splitPanels.map(p => [p.session, p]));
            const same = names.length === splitPanels.length && names.every((n, i) => splitPanels[i].session === n);
            splitPanels = names.map(n => old.get(n) || { session: n, content: '', inputValue: '' });
            const idx = Math.max(0, names.indexOf(current));
            if (!same) {
                deckRender();
                deckGoTo(idx, false);
            } else {
                activePanel = idx;
                deckPaintChrome();
            }
        }

        function deckIndexOf(session) {
            const i = splitPanels.findIndex(p => p.session === session);
            return i < 0 ? 0 : i;
        }

        // ── Drawing ─────────────────────────────────────────────────────────
        function deckRender() {
            const track = deckEl();
            if (!track) return;
            track.className = 'fs-split-container fs-deck' + (deckOverview ? ' overview' : '');
            track.style.cssText = '';
            track.innerHTML = '';
            splitPanels.forEach((p, i) => track.appendChild(createPanel(i)));
            deckBindGestures(track);
            deckPaintChrome();
        }

        function createPanel(i) {
            const panel = document.createElement('div');
            const p = splitPanels[i];
            panel.className = 'fs-panel' + (i === activePanel ? ' active' : '');
            panel.id = 'fs-panel-' + i;
            panel.dataset.session = p.session || '';
            panel.addEventListener('click', () => {
                if (deckOverview) { deckSetOverview(false); deckGoTo(i, false); return; }
                if (i !== activePanel) setActivePanel(i);
            });
            panel.innerHTML = `
                <div class="fs-panel-header">
                    <span class="fs-panel-title"><span class="fs-deck-mark"></span><span class="session-name" id="panel-session-${i}">${escapeHtml(p.session || '--')}</span></span>
                    <div class="fs-panel-actions">
                        <button class="fs-panel-close" onclick="event.stopPropagation();showPanelSessionPicker(${i})" title="Change session">[*]</button>
                        ${splitPanels.length > 1 ? `<button class="fs-panel-x" onclick="event.stopPropagation();closePanel(${i})" title="Take out of this deck">x</button>` : ''}
                    </div>
                </div>
                <div class="fs-panel-content" id="panel-content-${i}"></div>`;
            const content = panel.querySelector('.fs-panel-content');
            if (p.content) {
                if (window.TermFocus) TermFocus.write(content, p.content, false);
                else content.textContent = p.content;
            }
            return panel;
        }

        // Header title, dot strip, active ring, per-panel state marks.
        function deckPaintChrome() {
            const cur = splitPanels[activePanel];
            const groupName = deckGroup === 'all' || !deckGroup ? 'all'
                : ((deckGroups.groups || []).find(g => g.id === deckGroup) || {}).name || 'folder';
            const title = $('fs-active-title');
            if (title) title.textContent = (cur && cur.session) || '--';
            const gbtn = $('fs-deck-group');
            if (gbtn) gbtn.textContent = groupName + ' ' + (activePanel + 1) + '/' + splitPanels.length + ' v';
            const strip = $('fs-deck-dots');
            if (strip) {
                strip.innerHTML = splitPanels.map((p, i) => {
                    const st = deckStates[p.session] || '';
                    const cls = ['fs-dot'];
                    if (i === activePanel) cls.push('active');
                    if (deckAttn.has(p.session)) cls.push('attn');
                    else if (st === 'working') cls.push('working');
                    const label = String(p.session || '--');
                    return `<button class="${cls.join(' ')}" data-i="${i}" title="${escapeHtml(label)}"><i></i><span>${escapeHtml(label.length > 12 ? label.slice(0, 11) + '.' : label)}</span></button>`;
                }).join('');
                const on = strip.querySelector('.fs-dot.active');
                if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
            document.querySelectorAll('#fs-split-container .fs-panel').forEach((el, i) => {
                const s = splitPanels[i] && splitPanels[i].session;
                el.classList.toggle('active', i === activePanel);
                el.classList.toggle('needs-attention', deckAttn.has(s));
                el.classList.toggle('working', !deckAttn.has(s) && deckStates[s] === 'working');
            });
        }

        // ── Moving between sessions ─────────────────────────────────────────
        function deckGoTo(idx, smooth) {
            const track = deckEl();
            if (!track || !splitPanels.length) return;
            idx = Math.max(0, Math.min(splitPanels.length - 1, idx));
            const panel = track.children[idx];
            if (!deckOverview && panel) {
                deckProgrammatic = Date.now();
                track.scrollTo({ left: panel.offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
            }
            setActivePanel(idx, true);
        }

        function deckOnScroll() {
            if (deckOverview || deckScrollRaf) return;
            deckScrollRaf = requestAnimationFrame(() => {
                deckScrollRaf = 0;
                // A jump we started (a dot tap) passes through the panels in
                // between; those are not visits, and each would swap the draft.
                if (Date.now() - deckProgrammatic < 600) return;
                const track = deckEl();
                if (!track || !track.children.length) return;
                const w = track.children[0].offsetWidth || track.clientWidth || 1;
                const idx = Math.round(track.scrollLeft / w);
                if (idx !== activePanel && idx >= 0 && idx < splitPanels.length) {
                    setActivePanel(idx, true);
                    updatePanel(idx);
                }
            });
        }

        function setActivePanel(idx, quiet) {
            if (!splitPanels[idx]) return;
            const fsPrompt = $('fs-prompt');
            if (idx !== activePanel && splitPanels[activePanel] && fsPrompt) {
                splitPanels[activePanel].inputValue = fsPrompt.value;
                if (fsPrompt && splitPanels[idx]) fsPrompt.value = splitPanels[idx].inputValue || '';
            }
            const changed = idx !== activePanel;
            activePanel = idx;
            const session = splitPanels[idx].session;
            // Looking at it IS the acknowledgement, as on desktop (pcAttentionAck).
            if (session) deckAttn.delete(session);
            deckPaintChrome();
            if (!quiet) playSound('tap');
            if (changed && session && navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
        }

        function deckSetOverview(on) {
            deckOverview = !!on;
            const track = deckEl();
            if (track) track.classList.toggle('overview', deckOverview);
            const b = $('fs-deck-overview');
            if (b) b.classList.toggle('active', deckOverview);
            if (deckOverview) {
                updateAllPanels();
                const cur = track && track.children[activePanel];
                if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
            } else {
                deckGoTo(activePanel, false);
            }
        }
        function deckToggleOverview() { playSound('tap'); deckSetOverview(!deckOverview); }

        // Pinch = overview. A two-finger gesture never fights the one-finger
        // swipe, and the page has user-scalable=no, so the browser does not
        // claim it either.
        function deckBindGestures(track) {
            if (track.dataset.deckBound) return;
            track.dataset.deckBound = '1';
            track.addEventListener('scroll', deckOnScroll, { passive: true });
            let d0 = 0;
            const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
            track.addEventListener('touchstart', e => {
                d0 = e.touches.length === 2 ? dist(e.touches) : 0;
            }, { passive: true });
            track.addEventListener('touchmove', e => {
                if (!d0 || e.touches.length !== 2) return;
                const r = dist(e.touches) / d0;
                if (!deckOverview && r < 0.7) { d0 = 0; deckSetOverview(true); }
                else if (deckOverview && r > 1.4) { d0 = 0; deckSetOverview(false); }
            }, { passive: true });
            track.addEventListener('touchend', () => { d0 = 0; }, { passive: true });
            const strip = $('fs-deck-dots');
            if (strip && !strip.dataset.deckBound) {
                strip.dataset.deckBound = '1';
                strip.addEventListener('click', e => {
                    const b = e.target.closest('.fs-dot');
                    if (!b) return;
                    if (deckOverview) deckSetOverview(false);
                    deckGoTo(parseInt(b.dataset.i, 10) || 0, true);
                });
            }
        }

        // ── Pickers (a sheet, not prompt()) ─────────────────────────────────
        function deckSheet(title, items, onPick) {
            let sheet = $('fs-deck-sheet');
            if (!sheet) {
                sheet = document.createElement('div');
                sheet.id = 'fs-deck-sheet';
                sheet.className = 'fs-deck-sheet';
                sheet.addEventListener('click', e => {
                    if (e.target === sheet) { sheet.classList.remove('visible'); return; }
                    const b = e.target.closest('[data-k]');
                    if (!b) return;
                    sheet.classList.remove('visible');
                    const fn = sheet._onPick;
                    if (fn) fn(b.dataset.k);
                });
                $('terminal-fs').appendChild(sheet);
            }
            sheet._onPick = onPick;
            sheet.innerHTML = `<div class="fs-deck-sheet-panel">
                <div class="fs-deck-sheet-title">${escapeHtml(title)}</div>
                ${items.map(it => `<button class="fs-deck-sheet-row${it.on ? ' on' : ''}" data-k="${escapeHtml(it.key)}">
                    <span>${escapeHtml(it.label)}</span><em>${escapeHtml(it.note || '')}</em></button>`).join('')}
            </div>`;
            sheet.classList.add('visible');
        }

        function deckPickGroup() {
            playSound('tap');
            const items = [{ key: 'all', label: 'all sessions', note: String(deckMembers('all').length), on: deckGroup === 'all' }];
            (deckGroups.groups || []).filter(g => !g.parent).forEach(g => {
                const n = deckMembers(g.id).length;
                if (n) items.push({ key: g.id, label: g.name || g.id, note: String(n), on: deckGroup === g.id });
            });
            deckSheet('deck', items, key => {
                deckGroup = key;
                deckRemoved = new Set();
                deckSync();
                deckGoTo(0, false);
                updateAllPanels();
            });
        }

        async function showPanelSessionPicker(idx) {
            playSound('tap');
            await deckRefreshList();
            const used = new Set(splitPanels.map((p, i) => i !== idx && p.session).filter(Boolean));
            const items = deckLive.map(n => ({
                key: n, label: n,
                note: n === splitPanels[idx]?.session ? 'here' : used.has(n) ? 'in deck' : (deckStates[n] || ''),
                on: n === splitPanels[idx]?.session,
            }));
            if (!items.length) { toast('No sessions available', 'error'); return; }
            deckSheet('session', items, name => {
                const at = splitPanels.findIndex(p => p.session === name);
                if (at >= 0) { deckGoTo(at, true); return; }   // already here: just go to it
                splitPanels[idx] = { session: name, content: '', inputValue: '' };
                deckRemoved.delete(name);
                deckRender();
                deckGoTo(idx, false);
                updatePanel(idx);
            });
        }

        function closePanel(idx) {
            if (splitPanels.length <= 1) return;
            playSound('tap');
            const gone = splitPanels[idx].session;
            if (gone) deckRemoved.add(gone);
            splitPanels.splice(idx, 1);
            const next = Math.min(idx, splitPanels.length - 1);
            activePanel = Math.min(activePanel, splitPanels.length - 1);
            deckRender();
            deckGoTo(next, false);
        }

        // ── Polling ─────────────────────────────────────────────────────────
        let splitPollInterval = null;
        let deckTick = 0, deckListAt = 0, deckStatesAt = 0;
        function startSplitPolling() {
            stopSplitPolling();
            deckTick = 0;
            deckListAt = Date.now();
            deckStatesAt = 0;
            deckPollTick();
            splitPollInterval = setInterval(deckPollTick, DECK_POLL_MS);
        }
        function stopSplitPolling() {
            if (splitPollInterval) clearInterval(splitPollInterval);
            splitPollInterval = null;
        }

        // On screen every tick; the rest every DECK_BG_EVERY ticks, so the
        // neighbour you swipe to is never more than ~9s stale and a deck of 8
        // does not cost 8 captures every 3 seconds.
        async function deckPollTick() {
            if (document.hidden || !deckIsOpen()) return;
            deckTick++;
            const now = Date.now();
            if (now - deckStatesAt >= DECK_STATES_MS) { deckStatesAt = now; deckRefreshStates(); }
            if (now - deckListAt >= DECK_LIST_MS) { deckListAt = now; deckRefreshList(); }
            const visible = new Set([activePanel]);
            if (deckOverview) splitPanels.forEach((p, i) => visible.add(i));
            else if (window.matchMedia('(orientation: landscape)').matches) visible.add(activePanel + 1);
            for (let i = 0; i < splitPanels.length; i++) {
                if (visible.has(i) || deckTick % DECK_BG_EVERY === 0) await updatePanel(i);
            }
        }

        async function deckRefreshStates() {
            try {
                const r = await fetch('/api/dispatcher/session-states', { headers: { Authorization: token } });
                if (!r.ok) return;
                const d = await r.json();
                const next = {};
                (d.sessions || []).forEach(s => { if (s && s.name) next[s.name] = s.state; });
                const inDeck = new Set(splitPanels.map(p => p.session));
                const onScreen = splitPanels[activePanel]?.session;
                let buzz = false;
                Object.keys(next).forEach(n => {
                    const was = deckStates[n], now = next[n];
                    if (DECK_ATTN.has(now) && !DECK_ATTN.has(was) && was !== undefined && n !== onScreen && inDeck.has(n)) {
                        deckAttn.add(n);
                        buzz = true;
                    }
                    if (now === 'working') deckAttn.delete(n);
                });
                deckStates = next;
                if (buzz && navigator.vibrate) { try { navigator.vibrate([40, 60, 40]); } catch (e) {} }
                deckPaintChrome();
            } catch (e) { /* dispatcher off: no states, no error */ }
        }

        async function updateAllPanels() {
            for (let i = 0; i < splitPanels.length; i++) await updatePanel(i);
        }

        async function updatePanel(idx) {
            const p = splitPanels[idx];
            if (!p) return;
            const session = p.session;
            try {
                // ?output=1 on the fallback: a panel with no session assigned
                // still wants a screen to show, and /api/status only ships the
                // capture when asked now.
                const url = session ? '/api/output?session=' + encodeURIComponent(session) : '/api/status?output=1';
                const r = await fetch(url, { headers: { Authorization: token } });
                const d = await r.json();
                const content = d.output || '';
                if (splitPanels[idx] !== p) return;   // the deck changed under us
                p.content = content;
                const el = $('panel-content-' + idx);
                if (el) {
                    if (window.TermFocus) {
                        TermFocus.write(el, content, false);
                    } else {
                        const wasAtBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 50;
                        el.textContent = content;
                        if (wasAtBottom) el.scrollTop = el.scrollHeight;
                    }
                }
            } catch (e) {}
        }

        // Track current TMUX session for panels. Empty = no session targeted yet
        // (no hardcoded 'claude'); the sidebar adopts the first real session, or
        // shows an empty state when there are none.
        let TMUX_SESSION = '';
        // Track which session is displayed on home screen (syncs with selected panel when exiting fullscreen).
        // Shared mutable state: declared here but ALSO written by desktop.js/main.js, so it lives on
        // window via a get/set proxy -- bare `homeSession` reads/writes in ANY file route through here.
        // ── MULTI-WINDOW COORDINATION ───────────────────────────────────────
        // Two TSRCT windows are two workstations, never one window twice.
        //
        // Presence is negotiated over a BroadcastChannel instead of localStorage
        // timestamps. A timestamp cannot answer the only question that matters
        // at startup -- "is another window ALIVE right now" -- because it cannot
        // tell a live sibling from a stale row, nor from THIS window's own row
        // after a reload. That ambiguity is what made the previous attempt fail.
        //
        // It also covers the case that silently defeated it: a window opened
        // FROM another window inherits a COPY of its sessionStorage, so it
        // arrives already believing it owns the opener's session and its own
        // window id. Both are re-derived here instead of trusted.
        const WIN_ID = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2) + Date.now();   // per PAGE LOAD, never persisted
        const peerSessions = new Map();   // peer window id -> session it is showing
        const peerOwned = new Map();      // peer window id -> sessions that window owns
        let emptyMode = false;            // fresh window: no session until the user picks
        let presenceResolved = false;
        // A window opened ALONE is the "home" workstation: it sees every session
        // on the machine except the ones another live window has taken. A window
        // opened beside a sibling is a fresh workspace: it sees ONLY what it
        // creates. This asymmetry is deliberate -- without it, the first window
        // would suddenly hide the 12 sessions that already existed, since it did
        // not create any of them in this page load.
        let isHome = true;
        let owned = new Set();
        try { owned = new Set(JSON.parse(sessionStorage.getItem('tsrct_owned') || '[]')); } catch (e) {}
        function saveOwned() {
            try { sessionStorage.setItem('tsrct_owned', JSON.stringify([...owned])); } catch (e) {}
        }

        let _homeSession = null;
        try { _homeSession = sessionStorage.getItem('tsrct_home_session') || null; } catch (e) {}

        let bc = null;
        try { bc = new BroadcastChannel('tsrct-windows'); } catch (e) {}
        function announce(t) {
            if (!bc) return;
            try { bc.postMessage({ t, id: WIN_ID, session: _homeSession, owned: [...owned] }); } catch (e) {}
        }
        if (bc) {
            bc.onmessage = e => {
                const m = e.data || {};
                if (!m.id || m.id === WIN_ID) return;
                if (m.t === 'bye') { peerSessions.delete(m.id); peerOwned.delete(m.id); redrawSessions(); return; }
                peerSessions.set(m.id, m.session || null);
                const before = JSON.stringify(peerOwned.get(m.id) || []);
                peerOwned.set(m.id, m.owned || []);
                // A sibling taking or releasing a session changes what THIS
                // window may show, so the sidebar has to be redrawn for it.
                if (before !== JSON.stringify(m.owned || [])) redrawSessions();
                if (m.t === 'ping') announce('pong');   // answer a newcomer's roll-call
            };
            window.addEventListener('pagehide', () => {
                try { bc.postMessage({ t: 'bye', id: WIN_ID }); } catch (e) {}
            });
        }
        function sessionsClaimedElsewhere() {
            return new Set([...peerSessions.values()].filter(Boolean));
        }

        Object.defineProperty(window, 'homeSession', {
            get: () => _homeSession,
            set: v => {
                _homeSession = v;
                // A deliberate pick ends the blank slate.
                if (v) emptyMode = false;
                try {
                    if (v) sessionStorage.setItem('tsrct_home_session', v);
                    else sessionStorage.removeItem('tsrct_home_session');
                } catch (e) {}
                if (window.pcLayout) window.pcLayout.mirror();
                announce('session');
                if (typeof updateHomeSessionDisplay === 'function') {
                    try { updateHomeSessionDisplay(); } catch (e) {}
                }
            },
            configurable: true,
        });

        // Roll-call at startup, then decide what kind of window this is.
        const presenceReady = new Promise(resolve => {
            if (!bc) { presenceResolved = true; resolve(); return; }
            announce('ping');
            setTimeout(() => {
                if (peerSessions.size > 0) {
                    isHome = false;   // a sibling is live -> this is a fresh workspace
                    const taken = sessionsClaimedElsewhere();
                    // Either no session of our own, or the one we "have" is the
                    // sibling's (that is the inherited-copy case) -> start clean.
                    if (!_homeSession || taken.has(_homeSession)) {
                        emptyMode = true;
                        window.homeSession = null;
                    }
                }
                presenceResolved = true;
                resolve();
            }, 300);
        });

        // THE single place that decides which session this window targets.
        // It exists because the rule was duplicated: main.js (mobile) and
        // desktop.js (PC mode) each had their own "adopt the first live
        // session" copy, so fixing one left the other mirroring.
        function pickSessionForThisWindow(names) {
            if (!presenceResolved) return _homeSession;   // never adopt before the roll-call
            if (emptyMode) return null;                   // fresh window: the user chooses
            if (!names || !names.length) return null;
            if (_homeSession && names.includes(_homeSession)) return _homeSession;
            const taken = sessionsClaimedElsewhere();
            return names.find(n => !taken.has(n)) || names[0];
        }

        function redrawSessions() {
            if (typeof refreshPCSessions === 'function') { try { refreshPCSessions(); } catch (e) {} }
        }
        function peerOwnedSet() {
            const out = new Set();
            for (const arr of peerOwned.values()) (arr || []).forEach(n => out.add(n));
            return out;
        }
        // This window created (or was handed) this session -- it is now its own.
        function ownSession(name) {
            if (!name || owned.has(name)) return;
            owned.add(name);
            saveOwned();
            announce('session');
        }
        function isVisibleSession(name) {
            if (!name) return false;
            if (owned.has(name)) return true;
            // Home shows everything not taken by a live sibling; a secondary
            // workspace shows nothing but its own.
            return isHome && !peerOwnedSet().has(name);
        }
        // Accepts ['a','b'] or [{name:'a'},...] -- both shapes are used.
        function filterVisibleSessions(list) {
            return (list || []).filter(x => isVisibleSession(typeof x === 'string' ? x : (x && x.name)));
        }

        window.sessionsClaimedElsewhere = sessionsClaimedElsewhere;
        window.pickSessionForThisWindow = pickSessionForThisWindow;
        window.tsrctOwnSession = ownSession;
        window.tsrctIsVisibleSession = isVisibleSession;
        window.tsrctFilterSessions = filterVisibleSessions;
        window.tsrctIsHome = () => isHome;
        window.tsrctPresenceReady = presenceReady;
        window.tsrctStartsClean = () => emptyMode;

        // Get the current target session based on context
        // In fullscreen split mode: use active panel's session
        // Otherwise: use homeSession
        function getCurrentTargetSession() {
            const fs = $('terminal-fs');
            if (fs && fs.classList.contains('active') && splitPanels[activePanel]?.session) {
                return splitPanels[activePanel].session;
            }
            return homeSession || TMUX_SESSION || '';
        }

        // Toggle Fullscreen Quick Menu
        function toggleFsMenu() {
            $('fs-quick').classList.toggle('hidden');
        }

        // Toggle entre menus en fullscreen
        function setFsMode(mode) {
            $('fs-toggle-claude').classList.toggle('active', mode === 'claude');
            $('fs-toggle-term').classList.toggle('active', mode === 'term');
            $('fs-claude').classList.toggle('hidden', mode !== 'claude');
            $('fs-term').classList.toggle('hidden', mode !== 'term');
        }

        // Send desde fullscreen. Goes through main.js send() (2026-10-08): the
        // fullscreen copy posted the bare text, so photos and files attached
        // from fullscreen never travelled, abbreviations did not expand, and the
        // vault switch was ignored. send() already targets the panel on screen
        // (getCurrentTargetSession) and restores the text if the send fails.
        async function fsSend() {
            const fsPrompt = $('fs-prompt');
            const home = $('prompt');
            if (!fsPrompt || !home || typeof window.send !== 'function') return;
            home.value = fsPrompt.value;
            fsPrompt.value = '';
            if (splitPanels[activePanel]) splitPanels[activePanel].inputValue = '';
            await window.send();
            // A failed send puts the text back in the home box; bring it here.
            if (home.value) { fsPrompt.value = home.value; home.value = ''; }
            schedulePoll(500);
            if (deckIsOpen()) setTimeout(() => updatePanel(activePanel), 600);
        }

        // Toast
        function toast(msg, type = 'success', sound = true) {
            const t = $('toast');
            t.className = 'toast ' + type;
            $('toast-msg').textContent = msg;
            t.classList.add('show');
            if (sound) playSound(type === 'success' ? 'success' : 'error');
            setTimeout(() => t.classList.remove('show'), 2500);
        }

        // Keyboard
        $('prompt')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); send(); }
        });
        $('fs-prompt')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); fsSend(); }
        });

        // Hide quick action buttons when keyboard opens (mobile)
        let keyboardOpen = false;
        let viewportInitialHeight = 0;

        function initKeyboardScroll() {
            const fsQuick = $('fs-quick');

            // Use visualViewport API - most reliable for mobile keyboards
            if (window.visualViewport) {
                viewportInitialHeight = window.visualViewport.height;

                const updateFsQuickPosition = () => {
                    const fs = $('terminal-fs');
                    if (!fs || !fs.classList.contains('active')) return;
                    if (!fsQuick || fsQuick.classList.contains('hidden')) return;

                    const currentHeight = window.visualViewport.height;
                    const heightDiff = viewportInitialHeight - currentHeight;

                    // Keyboard open if viewport shrinks by more than 150px
                    const isKeyboardNowOpen = heightDiff > 150;

                    if (isKeyboardNowOpen && !keyboardOpen) {
                        // Keyboard just opened - hide buttons, keep input
                        keyboardOpen = true;
                        fsQuick.classList.add('keyboard-open');
                    } else if (!isKeyboardNowOpen && keyboardOpen) {
                        // Keyboard closed - show buttons again
                        keyboardOpen = false;
                        fsQuick.classList.remove('keyboard-open');
                    }

                    // Position input at bottom of visual viewport (above keyboard)
                    const offsetTop = window.visualViewport.offsetTop;
                    const viewportBottom = offsetTop + currentHeight;
                    const windowHeight = window.innerHeight;
                    const bottomOffset = windowHeight - viewportBottom;

                    fsQuick.style.bottom = bottomOffset + 'px';

                    // Scroll panels to bottom
                    scrollPanelsToBottom();
                };

                window.visualViewport.addEventListener('resize', updateFsQuickPosition);
                window.visualViewport.addEventListener('scroll', updateFsQuickPosition);

                // Update initial height when orientation changes
                window.addEventListener('orientationchange', () => {
                    setTimeout(() => {
                        viewportInitialHeight = window.visualViewport.height;
                        keyboardOpen = false;
                        if (fsQuick) {
                            fsQuick.classList.remove('keyboard-open');
                            fsQuick.style.bottom = '0px';
                        }
                    }, 500);
                });

                // Reset position when fullscreen closes
                const resetFsQuickPosition = () => {
                    if (fsQuick) {
                        fsQuick.style.bottom = '0px';
                        fsQuick.classList.remove('keyboard-open');
                    }
                    keyboardOpen = false;
                };
                window.resetFsQuickPosition = resetFsQuickPosition;
            }
        }

        function scrollPanelsToBottom() {
            const fsContent = $('terminal-fs-content');
            if (fsContent) fsContent.scrollTop = fsContent.scrollHeight;
            const panelContent = $('panel-content-' + activePanel);
            if (panelContent) panelContent.scrollTop = panelContent.scrollHeight;
        }

        // ── Public API (Phase 3B): index.html inline handlers + cross-file refs
        //    (app/main/desktop/remote-desktop) + this file's own generated onclick ──
        Object.assign(window, {
            // shared utils used everywhere:
            toast, getCurrentTargetSession,
            // gallery / files / attachments:
            showGalleryModal, hideGalleryModal, loadServerGallery, toggleServerImage,
            attachSelectedImages, uploadImages, uploadFile, galleryPickPhone, processAndUploadImage,
            // gallery tools + viewer (handlers live in this file's generated HTML too):
            gallerySetCols, gallerySelectAll, galleryClearSelection,
            galleryAskDelete, galleryAskEmpty, galleryDeleteOne,
            galleryCancelConfirm, galleryConfirmRun,
            galleryOpenViewer, galleryCloseViewer, galleryViewerStep,
            galleryViewerToggleSelect, galleryViewerDelete,
            showFilesModal, hideFilesModal, loadServerFiles, toggleServerFile, attachSelectedFiles,
            clearAttachment, removeAttachment, removeOrgAttachment, removeRunnerAttachment,
            startRenameAttachment, commitRenameAttachment,
            updateAttachmentIndicator, updateIfsAttach,
            // sessions / terminal / panels:
            renderSessions, createNewSession, switchSession, killSession, showPanelSessionPicker,
            renderContext, addChat, sendKey, tabComplete, setActivePanel, setFsMode,
            closePanel, deckPickGroup, deckToggleOverview,
            closeInputFs, fsSend, sendFromFs, toggleFsMenu, toggleFsMic, toggleFullscreen,
            toggleLang, toggleMic, toggleMicFs, initInputDrag, initKeyboardScroll,
        });
        // TMUX_SESSION is never reassigned -> a getter is enough (homeSession proxy is above):
        Object.defineProperty(window, 'TMUX_SESSION', { get: () => TMUX_SESSION, configurable: true });

})();

