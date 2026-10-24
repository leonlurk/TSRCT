// ==============================================
// TSRCT - Attachments: the server gallery, the files picker and uploads
// The image gallery modal (mobile + the RD terminal overlay) with its viewer, the
// server files picker, phone uploads, and the attachment chips over the input.
// Cut out of gallery.js (now sessions.js) verbatim (cleanup round 4, 2026-10-24); it loads just after it.
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

        Object.assign(window, {
            attachSelectedFiles, attachSelectedImages, clearAttachment, commitRenameAttachment, galleryAskDelete,
            galleryAskEmpty, galleryCancelConfirm, galleryClearSelection, galleryCloseViewer, galleryConfirmRun,
            galleryDeleteOne, galleryOpenViewer, galleryPickPhone, gallerySelectAll, gallerySetCols,
            galleryViewerDelete, galleryViewerStep, galleryViewerToggleSelect, hideFilesModal, hideGalleryModal,
            loadServerFiles, loadServerGallery, processAndUploadImage, removeAttachment, removeOrgAttachment,
            removeRunnerAttachment, showFilesModal, showGalleryModal, startRenameAttachment, toggleServerFile,
            toggleServerImage, updateAttachmentIndicator, uploadFile, uploadImages,
        });

})();
