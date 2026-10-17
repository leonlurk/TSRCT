'use strict';
// terminal images, Studio, the playlist.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (studio) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    // (auth already enforced at the top of handleAPI)

    // ═══════════════════════════════════════════════════════════════════
    // TERMINAL INLINE IMAGES  (GET /api/termimg?path=<abs>)
    // Serves an image file referenced in terminal output so the frontend can
    // render it inline (chat-style). AUTHED (unlike public /images/): the client
    // fetches it as a blob with the Authorization header, so we can safely allow
    // arbitrary paths behind a strict containment guard instead of exposing every
    // image on the box publicly. Fail-closed: only real image files that resolve
    // (via realpath, so symlinks can't escape) UNDER PROJECTS_ROOT are served;
    // SecretCo paths are refused outright (contract: no SecretCo bytes off the box).
    // ═══════════════════════════════════════════════════════════════════
    function getTermimg(req, res, pathname) {
        const { NOT_MINE, PROJECTS_ROOT, fs, parseReqUrl, path } = S;
        if (!(pathname === '/api/termimg' && req.method === 'GET')) return NOT_MINE;
        const send = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        try {
            let raw = (parseReqUrl(req.url).query || {}).path; // already decoded
            if (Array.isArray(raw)) raw = raw[0];
            if (!raw || typeof raw !== 'string') return send(400, { error: 'missing path' });

            // Expand a leading ~ ; everything else stays literal (paths may hold spaces).
            let p = raw;
            if (p === '~') p = require('os').homedir();
            else if (p.startsWith('~/')) p = path.join(require('os').homedir(), p.slice(2));

            // Only ever serve image files.
            if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) return send(403, { error: 'not an image' });

            // Resolve through symlinks, then containment-check the REAL path so a
            // symlink under PROJECTS can't point outside it.
            let real, rootReal;
            try { real = fs.realpathSync(p); } catch (e) { return send(404, { error: 'not found' }); }
            try { rootReal = fs.realpathSync(PROJECTS_ROOT); } catch (e) { rootReal = PROJECTS_ROOT; }
            if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
                return send(403, { error: 'outside project root' });
            }
            // SecretCo contract: never serve SecretCo bytes, even locally.
            if (/secretco/i.test(real)) return send(403, { error: 'forbidden' });

            const st = fs.statSync(real);
            if (!st.isFile()) return send(404, { error: 'not a file' });
            if (st.size > 20 * 1024 * 1024) return send(413, { error: 'too large' });

            const types = {
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
                '.svg': 'image/svg+xml'
            };
            const ct = types[path.extname(real).toLowerCase()] || 'application/octet-stream';
            res.writeHead(200, {
                'Content-Type': ct,
                'Content-Length': st.size,
                'Cache-Control': 'private, max-age=3600'
            });
            fs.createReadStream(real).pipe(res);
        } catch (e) {
            send(500, { error: 'server error' });
        }
        return;
    }


    // ═══════════════════════════════════════════════════════════════════
    // GENERATIVE AI STUDIO ENDPOINTS (/api/studio/*)
    // ComfyUI lifecycle + GPU telemetry + workflow submission — all proxied
    // through this server so the phone (tunnel) reaches localhost-only ComfyUI.
    // ═══════════════════════════════════════════════════════════════════
    function anyStudio(req, res, pathname) {
        const { NOT_MINE, fs, isAuthorized, parseReqUrl, path, resolveWithinProjects } = S;
        if (!(pathname.startsWith('/api/studio/'))) return NOT_MINE;
        if (!S.studio) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'studio backend unavailable' }));
            return;
        }
        const sj = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const readBody = (cb) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { let j = {}; try { j = JSON.parse(b || '{}'); } catch {} cb(j); }); };

        if (pathname === '/api/studio/status' && req.method === 'GET') {
            S.studio.comfy.status().then(s => sj(200, { success: true, comfy: s })).catch(e => sj(500, { error: e.message }));
            return;
        }
        if (pathname === '/api/studio/comfy/start' && req.method === 'POST') {
            readBody(b => S.studio.comfy.start({ vramMode: b.vramMode }).then(r => sj(200, { success: true, ...r })).catch(e => sj(500, { error: e.message })));
            return;
        }
        if (pathname === '/api/studio/comfy/stop' && req.method === 'POST') {
            S.studio.comfy.stop().then(r => sj(200, { success: true, ...r })).catch(e => sj(500, { error: e.message }));
            return;
        }
        if (pathname === '/api/studio/gpu' && req.method === 'GET') {
            S.studio.gpu.sample().then(g => sj(200, { success: true, gpu: g })).catch(e => sj(500, { error: e.message }));
            return;
        }
        if (pathname === '/api/studio/gpu/stream' && req.method === 'GET') {
            const qToken = (parseReqUrl(req.url).query || {}).token;
            if (!isAuthorized(qToken, req)) { res.writeHead(401); res.end(); return; }
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            let alive = true;
            const tick = async () => { if (!alive) return; try { const g = await S.studio.gpu.sample(); res.write(`data: ${JSON.stringify(g)}\n\n`); } catch {} };
            tick();
            const iv = setInterval(tick, 1000);
            req.on('close', () => { alive = false; clearInterval(iv); });
            return;
        }
        if (pathname === '/api/studio/models' && req.method === 'GET') {
            S.studio.comfy.models().then(m => sj(200, { success: true, models: m })).catch(e => sj(500, { error: e.message }));
            return;
        }
        // Stage a PROJECTS-local image into ComfyUI/input so LoadImage modes can use it.
        if (pathname === '/api/studio/stage' && req.method === 'POST') {
            readBody(b => {
                try {
                    const src = resolveWithinProjects(b.path);
                    if (!src || !fs.existsSync(src)) return sj(400, { error: 'invalid source path' });
                    sj(200, { success: true, name: S.studio.comfy.stageInput(src) });
                } catch (e) { sj(400, { error: e.message }); }
            });
            return;
        }
        if (pathname === '/api/studio/generate' && req.method === 'POST') {
            readBody(b => {
                let graph;
                try { graph = S.studio.workflows.build(b.mode, b.params || {}); }
                catch (e) { return sj(400, { error: e.message }); }
                S.studio.comfy.submit(graph).then(promptId => sj(200, { success: true, promptId }))
                    .catch(e => sj(502, { error: e.message, detail: e.detail || null }));
            });
            return;
        }
        if (pathname === '/api/studio/interrupt' && req.method === 'POST') {
            S.studio.comfy.interrupt().then(() => sj(200, { success: true })).catch(e => sj(500, { error: e.message }));
            return;
        }
        // Live progress SSE — relays ComfyUI /ws (step/preview) + a /history completion watcher.
        if (pathname.startsWith('/api/studio/progress/') && req.method === 'GET') {
            const qToken = (parseReqUrl(req.url).query || {}).token;
            if (!isAuthorized(qToken, req)) { res.writeHead(401); res.end(); return; }
            const promptId = decodeURIComponent(pathname.split('/').pop());
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            res.write(`data: ${JSON.stringify({ kind: 'connected', promptId })}\n\n`);
            let closed = false, done = false;
            const cleanup = () => { if (closed) return; closed = true; S.studio.comfy.bus.removeListener('ev', onEv); clearInterval(poll); clearInterval(keepAlive); try { res.end(); } catch {} };
            const finish = async () => {
                if (done) return; done = true;
                let outputs = [];
                try {
                    const h = await S.studio.comfy.history(promptId);
                    const entry = h && h[promptId];
                    if (entry) for (const o of Object.values(entry.outputs || {})) {
                        for (const key of ['images', 'gifs', 'video', 'videos']) {
                            for (const it of (o[key] || [])) {
                                if (it && it.filename) {
                                    const sub = it.subfolder || '', type = it.type || 'output';
                                    outputs.push({ filename: it.filename, subfolder: sub, type,
                                        isVideo: /\.(mp4|webm|gif)$/i.test(it.filename),
                                        url: `/api/studio/view?filename=${encodeURIComponent(it.filename)}&subfolder=${encodeURIComponent(sub)}&type=${encodeURIComponent(type)}` });
                                }
                            }
                        }
                    }
                } catch {}
                try { res.write(`data: ${JSON.stringify({ kind: 'done', promptId, outputs })}\n\n`); } catch {}
                cleanup();
            };
            const onEv = (ev) => {
                if (ev.prompt_id && ev.prompt_id !== promptId) return; // previews carry no prompt_id → forwarded
                try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
                if (ev.kind === 'error') finish();
            };
            S.studio.comfy.bus.on('ev', onEv);
            const poll = setInterval(async () => {
                try {
                    const h = await S.studio.comfy.history(promptId);
                    const e = h && h[promptId];
                    if (e && ((e.status && e.status.completed) || Object.keys(e.outputs || {}).length)) finish();
                } catch {}
            }, 2500);
            const keepAlive = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 15000);
            req.on('close', cleanup);
            return;
        }
        // Serve an output file's raw bytes (image/video) FROM DISK — no ComfyUI
        // dependency, so the gallery keeps working after ComfyUI is stopped.
        if (pathname === '/api/studio/view' && req.method === 'GET') {
            const q = parseReqUrl(req.url).query || {};
            const out = S.studio.comfy.readOutput(q.filename, q.subfolder);
            if (!out) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
            res.writeHead(200, { 'Content-Type': out.contentType, 'Cache-Control': 'no-cache' });
            res.end(out.buffer);
            return;
        }
        // Result of a prompt from /history — a reliable completion fallback for
        // the UI when the live progress SSE doesn't deliver (stale ws, etc.).
        if (pathname === '/api/studio/result' && req.method === 'GET') {
            const id = (parseReqUrl(req.url).query || {}).promptId;
            if (!id) return sj(400, { error: 'promptId required' });
            S.studio.comfy.history(id).then((h) => {
                const entry = h && h[id];
                const outputs = [];
                if (entry) for (const o of Object.values(entry.outputs || {})) {
                    for (const key of ['images', 'gifs', 'video', 'videos']) {
                        for (const it of (o[key] || [])) {
                            if (it && it.filename) {
                                const sub = it.subfolder || '', type = it.type || 'output';
                                outputs.push({ filename: it.filename, subfolder: sub, type, isVideo: /\.(mp4|webm|gif)$/i.test(it.filename),
                                    url: `/api/studio/view?filename=${encodeURIComponent(it.filename)}&subfolder=${encodeURIComponent(sub)}&type=${encodeURIComponent(type)}` });
                            }
                        }
                    }
                }
                sj(200, { success: true, done: !!(entry && ((entry.status && entry.status.completed) || outputs.length)), outputs });
            }).catch(() => sj(200, { success: true, done: false, outputs: [] }));
            return;
        }
        if (pathname === '/api/studio/outputs' && req.method === 'GET') {
            try {
                const q = parseReqUrl(req.url).query || {};
                sj(200, { success: true, outputs: S.studio.comfy.recentOutputs(parseInt(q.limit, 10) || 40) });
            } catch (e) { sj(500, { error: e.message }); }
            return;
        }
        // Open an output file in Windows (reveal → open its folder, file selected).
        if (pathname === '/api/studio/open' && req.method === 'POST') {
            readBody(b => { const r = S.studio.comfy.openOutput(b.filename, b.subfolder, b.reveal); sj(r.ok ? 200 : 400, r.ok ? { success: true } : { error: r.error }); });
            return;
        }
        // Delete an output file.
        if (pathname === '/api/studio/delete' && req.method === 'POST') {
            readBody(b => { const ok = S.studio.comfy.deleteOutput(b.filename, b.subfolder); sj(ok ? 200 : 400, ok ? { success: true } : { error: 'delete failed' }); });
            return;
        }
        // Copy an output into ComfyUI/input for chaining (Animate/Upscale-this).
        if (pathname === '/api/studio/stage-out' && req.method === 'POST') {
            readBody(b => { try { sj(200, { success: true, name: S.studio.comfy.stageOutput(b.filename, b.subfolder) }); } catch (e) { sj(400, { error: e.message }); } });
            return;
        }
        // ── Scenes editor (project-based ffmpeg video assembly) ──────────────
        if (pathname === '/api/studio/scene/projects' && req.method === 'GET') {
            try { sj(200, { success: true, projects: S.studio.scenes.listProjects((parseReqUrl(req.url).query || {}).base) }); }
            catch (e) { sj(500, { error: e.message }); }
            return;
        }
        if (pathname === '/api/studio/scene/project' && req.method === 'POST') {
            readBody(b => { try { sj(200, { success: true, ...S.studio.scenes.createProject(b.base, b.name) }); } catch (e) { sj(400, { error: e.message }); } });
            return;
        }
        if (pathname === '/api/studio/scene/project' && req.method === 'GET') {
            try { sj(200, { success: true, project: S.studio.scenes.loadProject((parseReqUrl(req.url).query || {}).path) }); }
            catch (e) { sj(400, { error: e.message }); }
            return;
        }
        if (pathname === '/api/studio/scene/project/save' && req.method === 'POST') {
            readBody(b => { try { sj(200, { success: true, project: S.studio.scenes.saveProject(b.path, b.project) }); } catch (e) { sj(400, { error: e.message }); } });
            return;
        }
        if (pathname === '/api/studio/scene/project/delete' && req.method === 'POST') {
            readBody(b => { try { S.studio.scenes.deleteProject(b.path); sj(200, { success: true }); } catch (e) { sj(400, { error: e.message }); } });
            return;
        }
        if (pathname === '/api/studio/scene/clips' && req.method === 'GET') {
            try { sj(200, { success: true, clips: S.studio.scenes.listClips((parseReqUrl(req.url).query || {}).project) }); }
            catch (e) { sj(500, { error: e.message }); }
            return;
        }
        if (pathname === '/api/studio/scene/thumb' && req.method === 'GET') {
            const clip = (parseReqUrl(req.url).query || {}).clip;
            const t = S.studio.scenes.thumbFor(clip);
            if (!t) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no thumb' })); return; }
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
            fs.createReadStream(t).pipe(res);
            return;
        }
        // Serve a project file (export/preview), PROJECTS-confined.
        if (pathname === '/api/studio/scene/file' && req.method === 'GET') {
            const p = S.studio.scenes.safeProjectPath((parseReqUrl(req.url).query || {}).path);
            if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
            const ext = path.extname(p).toLowerCase();
            const ct = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.png': 'image/png' }[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
            fs.createReadStream(p).pipe(res);
            return;
        }
        if (pathname === '/api/studio/scene/render' && req.method === 'POST') {
            readBody(b => { try { sj(200, { success: true, job: S.studio.scenes.startRender(b.path) }); } catch (e) { sj(400, { error: e.message }); } });
            return;
        }
        if (pathname === '/api/studio/scene/render/status' && req.method === 'GET') {
            const st = S.studio.scenes.renderStatus((parseReqUrl(req.url).query || {}).job);
            sj(200, { success: true, status: st });
            return;
        }
        sj(404, { error: 'unknown studio route' });
        return;
    }


    // ═══════════════════════════════════════════════════════════════════
    // LURK CATALOG / PLAYLIST ENDPOINTS (/api/playlist/*)
    // A branded audio player room (the leonlurk "set"). Lists Leon's track
    // catalog from personal/lurk/tracks and streams a track as an
    // authenticated blob for a filming reference (real audio dubbed in edit).
    // Confined to the tracks dir; header-auth like every other API route.
    // ═══════════════════════════════════════════════════════════════════
    function anyPlaylist(req, res, pathname) {
        const { NOT_MINE, PROJECTS_ROOT, fs, parseReqUrl, path } = S;
        if (!(pathname.startsWith('/api/playlist/'))) return NOT_MINE;
        const TRACKS_DIR = path.join(PROJECTS_ROOT, 'personal/lurk/tracks');
        const AUDIO_CT = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac' };
        const sj = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

        if (pathname === '/api/playlist/list' && req.method === 'GET') {
            const tracks = [];
            try {
                for (const e of fs.readdirSync(TRACKS_DIR, { withFileTypes: true })) {
                    if (!e.isFile() || e.name.startsWith('.')) continue;
                    const ext = path.extname(e.name).toLowerCase();
                    if (!AUDIO_CT[ext]) continue;
                    const full = path.join(TRACKS_DIR, e.name);
                    let st; try { st = fs.statSync(full); } catch { continue; }
                    tracks.push({ name: e.name, path: full, size: st.size, mtime: st.mtimeMs });
                }
            } catch (e) { /* dir may not exist yet -> empty catalog */ }
            tracks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            sj(200, { success: true, dir: TRACKS_DIR, tracks });
            return;
        }
        if (pathname === '/api/playlist/file' && req.method === 'GET') {
            const raw = (parseReqUrl(req.url).query || {}).path || '';
            const p = path.resolve(String(raw));
            const rootReal = path.resolve(TRACKS_DIR);
            if (!(p === rootReal || p.startsWith(rootReal + path.sep))) { sj(403, { error: 'forbidden' }); return; }
            let st; try { st = fs.statSync(p); } catch { st = null; }
            if (!st || !st.isFile()) { sj(404, { error: 'not found' }); return; }
            const ct = AUDIO_CT[path.extname(p).toLowerCase()] || 'application/octet-stream';
            const range = req.headers.range;
            if (range) {
                const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
                let start = m[1] ? parseInt(m[1], 10) : 0;
                let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
                if (isNaN(start)) start = 0;
                if (isNaN(end) || end >= st.size) end = st.size - 1;
                if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
                res.writeHead(206, { 'Content-Type': ct, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache' });
                fs.createReadStream(p, { start, end }).pipe(res);
            } else {
                res.writeHead(200, { 'Content-Type': ct, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
                fs.createReadStream(p).pipe(res);
            }
            return;
        }
        sj(404, { error: 'unknown playlist route' });
        return;
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        getTermimg,
        anyStudio,
        anyPlaylist,
    ];

    return function apiMedia(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
