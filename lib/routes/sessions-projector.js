'use strict';
// Project registry, sessions, the projector, UI layout.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (TMUX_SESSION, dispatcher, sessionsVersion) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    function getProjectsRegistry(req, res, pathname) {
        const { NOT_MINE, projectRegistry } = S;
        if (!(pathname === '/api/projects/registry' && req.method === 'GET')) return NOT_MINE;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects: projectRegistry.list(), roots: projectRegistry.ALLOWED_CWD_ROOTS }));
        return;
    }

    function postProjectsRegistry(req, res, pathname) {
        const { NOT_MINE, projectRegistry } = S;
        if (!(pathname === '/api/projects/registry' && req.method === 'POST')) return NOT_MINE;
        // { project, cwd } — pin a project to a folder, or clear it with cwd:''.
        // The registry itself refuses SecretCo and anything outside the allowed roots.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const p = JSON.parse(body || '{}');
                const out = projectRegistry.setPath(p.project, p.cwd || '');
                res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(out));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postSessionWeightThresholds(req, res, pathname) {
        const { NOT_MINE, sessionWeight } = S;
        if (!(pathname === '/api/session/weight/thresholds' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { warn, urgent } = JSON.parse(body || '{}');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(sessionWeight.setThresholds(warn, urgent)));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function getProjectorSources(req, res, pathname) {
        const { NOT_MINE, SERVER_SESSION, isHiddenSession, projector, sendJson, tmux } = S;
        if (!(pathname === '/api/projector/sources' && req.method === 'GET')) return NOT_MINE;
        // The PROJECTOR window's dropdown: every session he could pick, each with
        // its separate browser or null. lib/projector.js drops SecretCo, hidden
        // sessions and runners itself, and prunes a source whose browser died.
        let names = [];
        try { names = tmux(['list-sessions', '-F', '#{session_name}']).trim().split('\n').filter(Boolean).filter(n => !isHiddenSession(n) && n !== SERVER_SESSION); } catch {}
        sendJson(req, res, { success: true, sessions: projector.sourcesFor(names) });
    }

    function getProjectorStream(req, res, pathname) {
        const { NOT_MINE, isAuthorized, parseReqUrl, projector } = S;
        if (!(pathname === '/api/projector/stream' && req.method === 'GET')) return NOT_MINE;
        const q = parseReqUrl(req.url).query || {};
        const qToken = q.token;
        if (!isAuthorized(qToken, req)) { res.writeHead(401); res.end(); return; }
        // Live frames of one session's browser. EventSource cannot send headers,
        // so the token check above is this route's own (listed in isSSERequest).
        // Frames flow only while this request is open: closing the window, or
        // picking another session (the page closes this stream and opens a new
        // one), stops the screencast once no other window watches it.
        const session = String(q.session || '');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        let closed = false, busy = false, stop = () => {};
        const send = (ev) => {
            if (closed) return;
            // A slow link (phone over Tailscale) must not pile frames up in
            // memory: while the last frame is still in the socket, skip the next.
            if (ev.kind === 'frame' && busy) return;
            const ok = res.write(`data: ${JSON.stringify(ev)}\n\n`);
            if (!ok && ev.kind === 'frame') { busy = true; res.once('drain', () => { busy = false; }); }
            if (ev.kind !== 'frame') { closed = true; stop(); try { res.end(); } catch {} }
        };
        const keepAlive = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 20000);
        req.on('close', () => { closed = true; clearInterval(keepAlive); stop(); });
        projector.watch(session, send).then(fn => { stop = fn; if (closed) fn(); })
            .catch(e => send({ kind: 'error', why: e.message }));
    }

    function postProjectorInput(req, res, pathname) {
        const { NOT_MINE, projector, readBody, sendJson } = S;
        if (!(pathname === '/api/projector/input' && req.method === 'POST')) return NOT_MINE;
        // His clicks and keys into the projected page (CDP Input on THAT page,
        // never the real cursor). The body can be a password: never logged.
        readBody(req).then(raw => {
            let b = {};
            try { b = JSON.parse(raw || '{}'); } catch {}
            return projector.input(String(b.session || ''), b);
        }).then(r => sendJson(req, res, r, r.ok ? 200 : 409))
            .catch(e => sendJson(req, res, { ok: false, error: e.message }, 500));
    }

    function getSessionsVersion(req, res, pathname) {
        const { NOT_MINE, sendJson } = S;
        if (!(pathname === '/api/sessions/version' && req.method === 'GET')) return NOT_MINE;
        // Cheap "did the list change?" for the PC sidebar's 1 s check. No tmux call.
        sendJson(req, res, { v: S.sessionsVersion });
    }

    function getSessions(req, res, pathname) {
        const { NOT_MINE, SERVER_SESSION, TMUX_TIMEOUT_MS, ensureSessionHooks, execSync, isHiddenSession } = S;
        if (!(pathname === '/api/sessions' && req.method === 'GET')) return NOT_MINE;
        // List all tmux sessions (excluding runners which start with "run-")
        ensureSessionHooks();
        try {
            const output = execSync('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: TMUX_TIMEOUT_MS });
            const sessions = output.trim().split('\n').filter(Boolean)
                .map(line => {
                    const [name, windows, attached] = line.split('|');
                    return {
                        name,
                        windows: parseInt(windows) || 1,
                        attached: attached === '1',
                        current: name === S.TMUX_SESSION,
                        protected: SERVER_SESSION && name === SERVER_SESSION
                    };
                })
                .filter(s => !s.name.startsWith('run-') && !isHiddenSession(s.name)); // runners + las de Ro + Tesla
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessions, current: S.TMUX_SESSION, serverSession: SERVER_SESSION }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessions: [], current: S.TMUX_SESSION, serverSession: SERVER_SESSION, error: 'No tmux sessions found' }));
        }
    }

    function getUiLayout(req, res, pathname) {
        const { NOT_MINE, parseReqUrl, uiLayout } = S;
        if (!(pathname === '/api/ui/layout' && req.method === 'GET')) return NOT_MINE;
        // The desktop layout of one window role, from THIS Linux boot only
        // (lib/uiLayout.js): a fresh window after a TSRCT restart seeds itself here.
        const out = uiLayout.read(String(parseReqUrl(req.url).query.role || 'full'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
    }

    function postUiLayout(req, res, pathname) {
        const { NOT_MINE, uiLayout } = S;
        if (!(pathname === '/api/ui/layout' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 400 * 1024) req.destroy(); });
        req.on('end', () => {
            let out;
            try {
                const parsed = JSON.parse(body || '{}');
                out = uiLayout.write(String(parsed.role || 'full'), parsed.values || {});
            } catch (e) { out = { ok: false, error: e.message }; }
            res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));
        });
    }

    function getSessionsGroups(req, res, pathname) {
        const { NOT_MINE } = S;
        if (!(pathname === '/api/sessions/groups' && req.method === 'GET')) return NOT_MINE;
        // Desktop session grouping. Stored in the DURABLE `config` table so groups
        // survive PWA refreshes AND server restarts (they live in WSL2 with the sessions).
        try {
            const raw = S.dispatcher && S.dispatcher.db ? S.dispatcher.db.getConfig('pc_session_groups') : null;
            let data = { groups: [], assignments: {} };
            if (raw) { try { data = JSON.parse(raw); } catch {} }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ groups: [], assignments: {}, error: e.message }));
        }
    }

    function postSessionsGroups(req, res, pathname) {
        const { NOT_MINE } = S;
        if (!(pathname === '/api/sessions/groups' && req.method === 'POST')) return NOT_MINE;
        // Full-replace write-through of the grouping structure.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const clean = {
                    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
                    assignments: (parsed.assignments && typeof parsed.assignments === 'object') ? parsed.assignments : {},
                };
                if (S.dispatcher && S.dispatcher.db) {
                    S.dispatcher.db.setConfig('pc_session_groups', JSON.stringify(clean));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function getSession(req, res, pathname) {
        const { NOT_MINE, sessionExists } = S;
        if (!(pathname === '/api/session' && req.method === 'GET')) return NOT_MINE;
        // Get current session name
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session: S.TMUX_SESSION, exists: sessionExists() }));
    }

    function postSessionKill(req, res, pathname) {
        const { NOT_MINE, SERVER_SESSION, pickInitialSession, tmux } = S;
        if (!(pathname === '/api/session/kill' && req.method === 'POST')) return NOT_MINE;
        // Kill a tmux session
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { name } = JSON.parse(body);
                if (!name) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Session name required' }));
                    return;
                }
                const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
                if (safeName !== name) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid session name' }));
                    return;
                }
                // Protect the session where server is running
                if (SERVER_SESSION && safeName === SERVER_SESSION) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Cannot kill server session. Run server outside tmux or use another session.' }));
                    return;
                }
                try {
                    tmux(['kill-session', '-t', safeName]);
                    // If we killed the current session, fall back to the first real
                    // remaining session, or '' (no target) — never a phantom 'claude'.
                    if (S.TMUX_SESSION === safeName) {
                        S.TMUX_SESSION = pickInitialSession();
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, killed: safeName, current: S.TMUX_SESSION }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to kill session' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postSessionNew(req, res, pathname) {
        const { NOT_MINE, sessionEnvArgs, tmux } = S;
        if (!(pathname === '/api/session/new' && req.method === 'POST')) return NOT_MINE;
        // Create a new tmux session
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { name } = JSON.parse(body);
                const safeName = (name || 'claude-' + Date.now()).replace(/[^a-zA-Z0-9_-]/g, '');
                try {
                    tmux(['new-session', '-d', '-s', safeName, ...sessionEnvArgs(safeName)]);
                    S.TMUX_SESSION = safeName;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, session: safeName }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to create session: ' + e.message }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postSession(req, res, pathname) {
        const { NOT_MINE, tmux } = S;
        if (!(pathname === '/api/session' && req.method === 'POST')) return NOT_MINE;
        // Switch to a different session
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session } = JSON.parse(body);
                if (!session) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Session name required' }));
                    return;
                }
                // Verify session exists (sanitize to prevent command injection)
                const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, '');
                if (safeSession !== session) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid session name' }));
                    return;
                }
                try {
                    tmux(['has-session', '-t', safeSession]);
                    S.TMUX_SESSION = safeSession;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, session: S.TMUX_SESSION }));
                } catch {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Session not found' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;

    // ═══════════════════════════════════════════════════════════════════
    // RUNNER API (Mini Terminals)
    // ═══════════════════════════════════════════════════════════════════
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        getProjectsRegistry,
        postProjectsRegistry,
        postSessionWeightThresholds,
        getProjectorSources,
        getProjectorStream,
        postProjectorInput,
        getSessionsVersion,
        getSessions,
        getUiLayout,
        postUiLayout,
        getSessionsGroups,
        postSessionsGroups,
        getSession,
        postSessionKill,
        postSessionNew,
        postSession,
    ];

    return function apiSessionsProjector(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
