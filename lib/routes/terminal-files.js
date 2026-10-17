'use strict';
// Sending input, uploads, images, files, the /api/fs browser, keys, tmux, cwd.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (TMUX_SESSION, dispatcher) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    function postSend(req, res, pathname) {
        const { NOT_MINE, augmentPrompt, sendToTmuxSession } = S;
        if (!(pathname === '/api/send' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { prompt, session, vault } = JSON.parse(body);
                // Use provided session or fallback to global TMUX_SESSION
                const targetSession = session || S.TMUX_SESSION;
                // Augment prompt with vault context if enabled
                const augmented = vault !== false ? augmentPrompt(prompt, targetSession) : prompt;
                const result = sendToTmuxSession(augmented, targetSession);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function postUploadImage(req, res, pathname) {
        const { NOT_MINE, UPLOADS_IMAGES, fs, path } = S;
        if (!(pathname === '/api/upload-image' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { image, format } = JSON.parse(body);
                const buffer = Buffer.from(image, 'base64');
                const timestamp = Date.now();
                // SECURITY: `format` is client-controlled and used to build a filename.
                // It used to go in raw, so `format: "png/../../.claude/settings.json"`
                // wrote attacker bytes anywhere path.join could reach. Whitelist the
                // extension, then confirm the resolved path is still inside the images
                // dir (belt and suspenders). Audit 2026-08-14.
                const ALLOWED_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
                const rawExt = String(format || 'png').toLowerCase().replace(/^\./, '');
                const ext = ALLOWED_IMAGE_EXT.includes(rawExt) ? rawExt : 'png';
                const filename = `mobile-upload-${timestamp}.${ext}`;
                const filepath = path.join(UPLOADS_IMAGES, filename);
                if (path.dirname(path.resolve(filepath)) !== path.resolve(UPLOADS_IMAGES)) {
                    throw new Error('invalid image path');
                }
                fs.writeFileSync(filepath, buffer);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, path: filepath, filename }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });

    // List uploaded images (from centralized images dir)
    }

    function getImages(req, res, pathname) {
        const { NOT_MINE, UPLOADS_IMAGES, fs, path } = S;
        if (!(pathname === '/api/images' && req.method === 'GET')) return NOT_MINE;
        try {
            const imgDir = UPLOADS_IMAGES;
            const files = fs.readdirSync(imgDir);
            const images = files
                .filter(f => /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(f))
                .map(filename => {
                    const filepath = path.join(imgDir, filename);
                    const stat = fs.statSync(filepath);
                    return {
                        filename,
                        path: filepath,
                        size: stat.size,
                        modified: stat.mtime.getTime(),
                        url: `/images/${filename}`
                    };
                })
                .sort((a, b) => b.modified - a.modified); // Newest first

            // `bytes` is what the folder actually costs. The gallery prints it
            // next to the count, because "empty the folder" is a decision you
            // make on a size, not on a number of files.
            const bytes = images.reduce((sum, img) => sum + img.size, 0);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, images, count: images.length, bytes, dir: imgDir }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }

    // Delete specific images from the uploads dir (mobile gallery).
    // Takes BARE FILENAMES, never paths -- see resolveUploadedImage().
    }

    function postImagesDelete(req, res, pathname) {
        const { NOT_MINE, deleteUploadedImage } = S;
        if (!(pathname === '/api/images/delete' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { filenames } = JSON.parse(body || '{}');
                const names = Array.isArray(filenames) ? filenames : [];
                if (!names.length) throw new Error('no filenames given');
                const deleted = [], failed = [];
                let bytes = 0;
                for (const name of names.slice(0, 1000)) bytes += deleteUploadedImage(name, deleted, failed);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, deleted, failed, count: deleted.length, bytes }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });

    // Empty the uploads images dir. Only image files, only the top level: a
    // subdirectory or a non-image that someone parked in there is left alone,
    // because "empty the gallery" is a promise about the gallery's contents and
    // nothing else. `confirm: true` is required in the body so a stray or
    // replayed POST is inert -- the UI confirmation is one layer, this is the
    // second, and this is the one an attacker cannot skip.
    }

    function postImagesEmpty(req, res, pathname) {
        const { NOT_MINE, UPLOADS_IMAGES, UPLOAD_IMAGE_EXT_RE, addEvent, deleteUploadedImage, fs } = S;
        if (!(pathname === '/api/images/empty' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { confirm } = JSON.parse(body || '{}');
                if (confirm !== true) throw new Error('confirm required');
                const names = fs.readdirSync(UPLOADS_IMAGES).filter(f => UPLOAD_IMAGE_EXT_RE.test(f));
                const deleted = [], failed = [];
                let bytes = 0;
                for (const name of names) bytes += deleteUploadedImage(name, deleted, failed);
                if (deleted.length) {
                    addEvent({
                        type: 'images_emptied',
                        title: 'Gallery folder emptied',
                        body: `${deleted.length} image${deleted.length === 1 ? '' : 's'} deleted ` +
                              `(${(bytes / 1048576).toFixed(1)} MB freed) from ${UPLOADS_IMAGES}`,
                    });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, deleted, failed, count: deleted.length, bytes }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });

    // Upload file (any type) to centralized files dir
    }

    function postUploadFile(req, res, pathname) {
        const { NOT_MINE, UPLOADS_FILES, fs, path } = S;
        if (!(pathname === '/api/upload-file' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { data, filename: origName } = JSON.parse(body);
                const buffer = Buffer.from(data, 'base64');
                const safeName = origName.replace(/[^a-zA-Z0-9._-]/g, '_');
                const filepath = path.join(UPLOADS_FILES, safeName);
                fs.writeFileSync(filepath, buffer);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, path: filepath, filename: safeName }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });

    // Rename an already-uploaded attachment on disk (images or files dir only)
    }

    function postFilesRename(req, res, pathname) {
        const { NOT_MINE, UPLOADS_FILES, UPLOADS_IMAGES, fs, path } = S;
        if (!(pathname === '/api/files/rename' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { oldPath, newName } = JSON.parse(body);
                if (!oldPath || !newName) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'oldPath and newName required' }));
                    return;
                }
                // Confine to the two upload dirs (resolve real path, block traversal)
                const resolvedOld = path.resolve(oldPath);
                const filesRoot = path.resolve(UPLOADS_FILES) + path.sep;
                const imagesRoot = path.resolve(UPLOADS_IMAGES) + path.sep;
                const baseDir = resolvedOld.startsWith(filesRoot) ? UPLOADS_FILES
                              : (resolvedOld.startsWith(imagesRoot) ? UPLOADS_IMAGES : null);
                if (!baseDir) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'path not allowed' }));
                    return;
                }
                if (!fs.existsSync(resolvedOld)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'file not found' }));
                    return;
                }
                // Sanitize new name to a bare basename; keep original extension if omitted
                let safeName = path.basename(String(newName)).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
                if (!safeName) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'invalid name' }));
                    return;
                }
                const origExt = path.extname(resolvedOld);
                if (!path.extname(safeName) && origExt) safeName += origExt;
                // Avoid clobbering an existing file
                let finalName = safeName;
                let finalPath = path.join(baseDir, finalName);
                if (fs.existsSync(finalPath) && path.resolve(finalPath) !== resolvedOld) {
                    const ext = path.extname(safeName);
                    const stem = path.basename(safeName, ext);
                    let n = 1;
                    do { finalName = `${stem}_${n}${ext}`; finalPath = path.join(baseDir, finalName); n++; }
                    while (fs.existsSync(finalPath));
                }
                fs.renameSync(resolvedOld, finalPath);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, path: finalPath, filename: finalName }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });

    // List files in centralized files dir
    }

    function getFilesList(req, res, pathname) {
        const { NOT_MINE, UPLOADS_FILES, fs, path } = S;
        if (!(pathname === '/api/files/list' && req.method === 'GET')) return NOT_MINE;
        try {
            const files = fs.readdirSync(UPLOADS_FILES)
                .filter(f => f !== 'CLAUDE.md')
                .map(filename => {
                    const filepath = path.join(UPLOADS_FILES, filename);
                    const stat = fs.statSync(filepath);
                    return { filename, path: filepath, size: stat.size, modified: stat.mtime.getTime() };
                })
                .sort((a, b) => b.modified - a.modified);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, files, count: files.length }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }

    // Browse files in PROJECTS directory
    }

    function postFilesBrowse(req, res, pathname) {
        const { NOT_MINE, PROJECTS_ROOT, fs, path, resolveWithinProjects } = S;
        if (!(pathname === '/api/files/browse' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { path: relPath } = JSON.parse(body);
                const root = PROJECTS_ROOT;
                const targetPath = relPath ? relPath : root;

                // Security: confine to PROJECTS_ROOT via resolveWithinProjects(),
                // which was written for exactly this and appends path.sep. The check
                // here used to be a bare `startsWith(root)`, so a SIBLING directory
                // whose name merely starts with the root -- /…/PROJECTSEVIL -- passed
                // containment. The newer /api/fs/* routes always used the helper;
                // this block predates it and was never swept. (Audit 2026-08-14.)
                const resolved = resolveWithinProjects(targetPath);
                if (!resolved) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Access denied' }));
                    return;
                }

                if (!fs.existsSync(resolved)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Path not found' }));
                    return;
                }

                // SecretCo fail-closed: never list a path inside an SecretCo tree.
                if (S.dispatcher.restrictedGuard.mentionsRestricted(resolved)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Access denied (SecretCo)' }));
                    return;
                }

                const entries = fs.readdirSync(resolved, { withFileTypes: true });
                const directories = [];
                const files = [];

                // Filter out hidden files and common excludes
                const excludes = ['node_modules', '.git', '.next', 'dist', '__pycache__', '.cache'];

                for (const entry of entries) {
                    if (entry.name.startsWith('.')) continue;
                    if (excludes.includes(entry.name)) continue;
                    if (S.dispatcher.restrictedGuard.mentionsRestricted(entry.name)) continue; // SecretCo fail-closed

                    if (entry.isDirectory()) {
                        directories.push(entry.name);
                    } else {
                        files.push(entry.name);
                    }
                }

                // Sort alphabetically
                directories.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                files.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

                // Determine parent path - only allow going up if still within PROJECTS_ROOT
                let parent = null;
                const parentPath = path.dirname(resolved);
                if (resolveWithinProjects(parentPath) && parentPath !== resolved) {
                    parent = parentPath;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    currentPath: resolved,
                    parent,
                    directories,
                    files
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });

    // Create a new file (for text/logs attachment)
    }

    function postFilesCreate(req, res, pathname) {
        const { NOT_MINE, UPLOADS_FILES, fs, path } = S;
        if (!(pathname === '/api/files/create' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { filename, content } = JSON.parse(body);

                if (!filename || !content) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Filename and content required' }));
                    return;
                }

                // Sanitize filename
                const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
                // Save to the shared attachments dir (PROJECTS/files), same place
                // /api/files/list reads from and /api/files/upload writes to --
                // NOT process.cwd() (which was the TSRCT repo root).
                const filePath = path.join(UPLOADS_FILES, safeName);

                // Don't overwrite existing files - add timestamp if exists
                let finalPath = filePath;
                if (fs.existsSync(filePath)) {
                    const timestamp = Date.now();
                    const ext = path.extname(safeName);
                    const base = path.basename(safeName, ext);
                    finalPath = path.join(UPLOADS_FILES, `${base}_${timestamp}${ext}`);
                }

                fs.writeFileSync(finalPath, content, 'utf8');

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    path: finalPath,
                    filename: path.basename(finalPath)
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });

    // ═══════════════════════════════════════════════════════════════════
    // OMNI FILE FINDER  —  desktop universal search bar (/api/fs/*)
    // Recursive fuzzy search + open-in-Windows + rename + duplicate, all
    // confined to PROJECTS_ROOT, argv-exec (no shell), SecretCo fail-closed.
    // ═══════════════════════════════════════════════════════════════════

    // Recursive fuzzy filename search under PROJECTS (VS-Code-style quick-open).
    }

    function getFsSearch(req, res, pathname) {
        const { FS_EXCLUDE_DIRS, NOT_MINE, PROJECTS_ROOT, fs, parseReqUrl, path, resolveWithinProjects } = S;
        if (!(pathname === '/api/fs/search' && req.method === 'GET')) return NOT_MINE;
        try {
            const urlObj = parseReqUrl(req.url);
            const rawQ = (urlObj.query.q || '').trim();
            const q = rawQ.toLowerCase().replace(/\s+/g, '');
            if (!q) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, results: [], truncated: false }));
                return;
            }
            // Optional scope narrows the walk to a subtree (still within PROJECTS).
            const scope = urlObj.query.scope ? resolveWithinProjects(urlObj.query.scope) : PROJECTS_ROOT;
            const root = scope && fs.existsSync(scope) ? scope : PROJECTS_ROOT;

            // Subsequence fuzzy scorer: substring-of-basename >> substring-of-path
            // >> subsequence-of-basename >> subsequence-of-path. -1 = no match.
            function score(name, rel) {
                const bi = name.indexOf(q);
                if (bi !== -1) return 1000 - bi * 2 - (name.length - q.length) + (bi === 0 ? 200 : 0);
                const ri = rel.indexOf(q);
                if (ri !== -1) return 500 - ri - (rel.length - q.length);
                let qi = 0, last = -1, gaps = 0;
                for (let i = 0; i < name.length && qi < q.length; i++) {
                    if (name[i] === q[qi]) { if (last >= 0) gaps += i - last - 1; last = i; qi++; }
                }
                if (qi === q.length) return 200 - gaps - name.length;
                qi = 0; last = -1; gaps = 0;
                for (let i = 0; i < rel.length && qi < q.length; i++) {
                    if (rel[i] === q[qi]) { if (last >= 0) gaps += i - last - 1; last = i; qi++; }
                }
                if (qi === q.length) return 100 - gaps - Math.floor(rel.length / 2);
                return -1;
            }

            const MAX_VISIT = 60000, MAX_RESULTS = 300;
            let visited = 0, truncated = false;
            const hits = [];
            const stack = [root];
            while (stack.length) {
                const dir = stack.pop();
                if (visited >= MAX_VISIT) { truncated = true; break; }
                let entries;
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
                catch { continue; }
                for (const ent of entries) {
                    if (ent.name.startsWith('.')) continue;
                    if (S.dispatcher.restrictedGuard.mentionsRestricted(ent.name)) continue; // SecretCo fail-closed
                    const full = path.join(dir, ent.name);
                    const isDir = ent.isDirectory();
                    if (isDir && FS_EXCLUDE_DIRS.has(ent.name)) continue;
                    visited++;
                    const rel = full.slice(PROJECTS_ROOT.length + 1);
                    const s = score(ent.name.toLowerCase(), rel.toLowerCase());
                    if (s > -1) {
                        hits.push({ name: ent.name, path: full, rel, isDir, score: s });
                    }
                    if (isDir) stack.push(full);
                }
            }
            hits.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
            if (hits.length > MAX_RESULTS) { truncated = true; hits.length = MAX_RESULTS; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, results: hits, truncated }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }

    // Open a file (default Windows app) or folder (Explorer) from WSL.
    }

    function postFsOpen(req, res, pathname) {
        const { NOT_MINE, fs, resolveWithinProjects, spawn, toWindowsPath } = S;
        if (!(pathname === '/api/fs/open' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { path: reqPath, reveal } = JSON.parse(body || '{}');
                const resolved = resolveWithinProjects(reqPath);
                if (!resolved) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'path not allowed' }));
                    return;
                }
                S.dispatcher.restrictedGuard.assertNotRestricted('fs open', resolved);
                if (!fs.existsSync(resolved)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'not found' }));
                    return;
                }
                const win = toWindowsPath(resolved);
                if (!win) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'not a Windows-reachable path' }));
                    return;
                }
                const isDir = fs.statSync(resolved).isDirectory();
                // reveal on a file selects it in Explorer; otherwise open with default app / open the dir.
                const args = (reveal && !isDir) ? [`/select,${win}`] : [win];
                // explorer.exe returns a non-zero exit code even on success — fire and forget.
                const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
                child.on('error', () => {}); // e.g. explorer.exe not on PATH (non-WSL) — swallow
                child.unref();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, opened: win, isDir }));
            } catch (e) {
                const code = e.code === 'RESTRICTED_PROJECT' ? 403 : 400;
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message, code: e.code }));
            }
        });

    // Rename a file/folder in place (anywhere under PROJECTS).
    }

    function postFsRename(req, res, pathname) {
        const { NOT_MINE, PROJECTS_ROOT, fs, path, resolveWithinProjects } = S;
        if (!(pathname === '/api/fs/rename' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { path: reqPath, newName } = JSON.parse(body || '{}');
                const resolved = resolveWithinProjects(reqPath);
                if (!resolved || resolved === PROJECTS_ROOT) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'path not allowed' }));
                    return;
                }
                if (!fs.existsSync(resolved)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'not found' }));
                    return;
                }
                // Sanitize to a bare basename (allow spaces + dots inside, block separators/control).
                let safe = path.basename(String(newName || '')).replace(/[\/\\\0-\x1f]/g, '').replace(/^\.+/, '').trim();
                if (!safe) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'invalid name' }));
                    return;
                }
                S.dispatcher.restrictedGuard.assertNotRestricted('fs rename', resolved, safe);
                const target = path.join(path.dirname(resolved), safe);
                if (!resolveWithinProjects(target)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'target not allowed' }));
                    return;
                }
                if (fs.existsSync(target) && path.resolve(target) !== resolved) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'a file with that name already exists' }));
                    return;
                }
                fs.renameSync(resolved, target);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, path: target, name: safe }));
            } catch (e) {
                const code = e.code === 'RESTRICTED_PROJECT' ? 403 : 400;
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message, code: e.code }));
            }
        });

    // Duplicate a file next to itself ("name copy.ext"). Files only.
    }

    function postFsCopy(req, res, pathname) {
        const { NOT_MINE, fs, path, resolveWithinProjects } = S;
        if (!(pathname === '/api/fs/copy' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { path: reqPath } = JSON.parse(body || '{}');
                const resolved = resolveWithinProjects(reqPath);
                if (!resolved) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'path not allowed' }));
                    return;
                }
                S.dispatcher.restrictedGuard.assertNotRestricted('fs copy', resolved);
                if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'file not found (directories not supported)' }));
                    return;
                }
                const dir = path.dirname(resolved);
                const ext = path.extname(resolved);
                const stem = path.basename(resolved, ext);
                let target = path.join(dir, `${stem} copy${ext}`);
                let n = 2;
                while (fs.existsSync(target)) { target = path.join(dir, `${stem} copy ${n}${ext}`); n++; }
                fs.copyFileSync(resolved, target);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, path: target, name: path.basename(target) }));
            } catch (e) {
                const code = e.code === 'RESTRICTED_PROJECT' ? 403 : 400;
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message, code: e.code }));
            }
        });
    }

    function postSendraw(req, res, pathname) {
        const { NOT_MINE, sendRawToTmuxSession } = S;
        if (!(pathname === '/api/sendraw' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { text, session } = JSON.parse(body);
                const targetSession = session || S.TMUX_SESSION;
                const result = sendRawToTmuxSession(text, targetSession);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function getSessionOutput(req, res, pathname) {
        const { NOT_MINE, getSessionOutput, parseReqUrl } = S;
        if (!(pathname === '/api/session/output' && req.method === 'GET')) return NOT_MINE;
        // Get output from a specific session
        const urlObj = parseReqUrl(req.url);
        const session = urlObj.query.session || S.TMUX_SESSION;
        const lines = parseInt(urlObj.query.lines) || 30;
        const result = getSessionOutput(session, lines);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    }

    function postKey(req, res, pathname) {
        const { NOT_MINE, sendKeyToTmuxSession } = S;
        if (!(pathname === '/api/key' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { key, session } = JSON.parse(body);
                const targetSession = session || S.TMUX_SESSION;
                // Teclas simples permitidas
                const allowedKeys = ['Up', 'Down', 'Enter', 'Escape', 'Tab', 'o'];
                // Combinaciones Ctrl permitidas (formato tmux: C-c, C-d, etc)
                const allowedCtrl = ['C-c', 'C-d', 'C-z', 'C-l', 'C-a', 'C-e', 'C-r', 'C-u', 'C-k', 'C-w', 'C-b'];
                if (!allowedKeys.includes(key) && !allowedCtrl.includes(key)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Key not allowed' }));
                    return;
                }
                const result = sendKeyToTmuxSession(key, targetSession);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function postTmuxPane(req, res, pathname) {
        const { NOT_MINE, tmuxNextPane } = S;
        if (!(pathname === '/api/tmux/pane' && req.method === 'POST')) return NOT_MINE;
        // Switch to next tmux pane
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session } = JSON.parse(body);
                const targetSession = session || S.TMUX_SESSION;
                const result = tmuxNextPane(targetSession);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function getCwd(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, getSessionPwd, parseReqUrl } = S;
        if (!(pathname === '/api/cwd' && req.method === 'GET')) return NOT_MINE;
        // Get a working directory. With no ?session= this is the server default,
        // which is what every pre-existing caller wants. HANDS ON passes the tmux
        // session it is teaching in, because in that mode the SESSION IS THE
        // PROJECT SELECTOR -- each tmux is already open in its own directory, so
        // switching session must re-root the file tree and the plan.
        // SecretCo: a path leaves the process here, so it goes through the guard.
        const cwdSession = ((parseReqUrl(req.url).query || {}).session || '').trim();
        const cwdOut = cwdSession ? getSessionPwd(cwdSession) : getSessionPwd();
        if (restrictedGuard.mentionsRestricted(cwdOut)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied (SecretCo)' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cwd: cwdOut, session: cwdSession || null }));

    // ── HANDS ON: the side the BROWSER talks to (normal auth gate) ───────────
    // Claude's half lives at the bare /handson/* paths above, local-only. These
    // three are the panel: read the plan, remember where Leon is, and report a
    // finished step. SecretCo-guarded on the cwd, same as everything else here.
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        postSend,
        postUploadImage,
        getImages,
        postImagesDelete,
        postImagesEmpty,
        postUploadFile,
        postFilesRename,
        getFilesList,
        postFilesBrowse,
        postFilesCreate,
        getFsSearch,
        postFsOpen,
        postFsRename,
        postFsCopy,
        postSendraw,
        getSessionOutput,
        postKey,
        postTmuxPane,
        getCwd,
    ];

    return function apiTerminalFiles(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
