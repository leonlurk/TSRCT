'use strict';
// the permission queue, auto-accept, terminal keys, hook events.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (TMUX_SESSION, dispatcher) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    // Permission endpoints (called by local hooks WITH the master token)
    function postPermission(req, res, pathname) {
        const { NOT_MINE, addEvent, autoAccept, autoApprovedRecent, permissionQueue, sendNtfy } = S;
        if (!(pathname === '/api/permission' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const perm = JSON.parse(body);
                perm.status = 'pending';
                perm.timestamp = Date.now();
                permissionQueue.set(perm.id, perm);
                // Decided before anyone sees it: the hook reads 'approve' on its
                // first poll, and no card or push goes out to any device.
                if (perm.session && autoAccept.has(perm.session)) {
                    perm.decision = 'approve';
                    perm.decidedAt = Date.now();
                    perm.autoApproved = true;
                    autoApprovedRecent.push({ id: perm.id, tool: perm.tool, description: perm.description, session: perm.session, at: perm.decidedAt });
                    if (autoApprovedRecent.length > 20) autoApprovedRecent.splice(0, autoApprovedRecent.length - 20);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, autoApproved: true }));
                    return;
                }
                // Autopilot (lib/planPilot.js): a session running a plan step may
                // get only what that plan's allow list names; anything else is
                // told to him, urgent, and waits for him like any card.
                if (S.planPilot && S.planPilot.allows(perm)) {
                    perm.decision = 'approve';
                    perm.decidedAt = Date.now();
                    perm.autoApproved = true;
                    perm.pilotApproved = true;
                    autoApprovedRecent.push({ id: perm.id, tool: perm.tool, description: perm.description, session: perm.session, at: perm.decidedAt, by: 'plan' });
                    if (autoApprovedRecent.length > 20) autoApprovedRecent.splice(0, autoApprovedRecent.length - 20);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, autoApproved: true }));
                    return;
                }
                if (S.planPilot) S.planPilot.onPermission(perm);
                // Also add to event queue for UI
                addEvent({ ...perm, type: 'permission', title: 'Permission Required', body: perm.description });

                // Send ntfy notification for swipe permission
                const ntfyLabels = { Bash: 'Approve Command?', Edit: 'Approve Edit?', Write: 'Approve Write?', Read: 'Approve Read?', WebFetch: 'Approve Fetch?', WebSearch: 'Approve Search?', Grep: 'Approve Grep?', Glob: 'Approve Glob?' };
                const permTitle = ntfyLabels[perm.tool] || 'Approve ' + (perm.tool || 'Tool') + '?';
                const permBody = perm.description || perm.command || perm.file || 'Permission required';
                const readOnlyTools = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
                const permTags = perm.tool === 'Bash' ? 'warning,computer' : readOnlyTools.includes(perm.tool) ? 'information_source,mag' : 'warning,pencil';
                sendNtfy(permTitle, permBody, permTags, 'high');

                // NOTE: HF sessions are NOT notified here - they are completely isolated
                // and run their own Claude process in print mode (-p) which doesn't need permissions.
                // This prevents cross-talk between tmux sessions and HF sessions.

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }


    // Get permission status (for hook polling)
    function getRoute(req, res, pathname) {
        const { NOT_MINE, permissionQueue } = S;
    const permGetMatch = pathname.match(/^\/api\/permission\/([^/]+)$/);
        if (!(permGetMatch && req.method === 'GET')) return NOT_MINE;
        const id = decodeURIComponent(permGetMatch[1]);
        const perm = permissionQueue.get(id);
        const result = perm || { decision: 'pending' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
    }


    // Approve permission
    function postRoute(req, res, pathname) {
        const { NOT_MINE, permissionQueue } = S;
    const approveMatch = pathname.match(/^\/api\/permission\/([^/]+)\/approve$/);
        if (!(approveMatch && req.method === 'POST')) return NOT_MINE;
        const id = decodeURIComponent(approveMatch[1]);
        const perm = permissionQueue.get(id);
        if (perm) {
            perm.decision = 'approve';
            perm.decidedAt = Date.now();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, decision: 'approve', found: !!perm }));
        return;
    }


    // Deny permission
    function postRoute2(req, res, pathname) {
        const { NOT_MINE, permissionQueue } = S;
    const denyMatch = pathname.match(/^\/api\/permission\/([^/]+)\/deny$/);
        if (!(denyMatch && req.method === 'POST')) return NOT_MINE;
        const id = decodeURIComponent(denyMatch[1]);
        const perm = permissionQueue.get(id);
        if (perm) {
            perm.decision = 'deny';
            perm.decidedAt = Date.now();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, decision: 'deny', found: !!perm }));
        return;
    }


    // List pending permissions
    function getPermissions(req, res, pathname) {
        const { NOT_MINE, autoAccept, autoApprovedRecent, permissionQueue, sendJson } = S;
        if (!(pathname === '/api/permissions' && req.method === 'GET')) return NOT_MINE;
        const pending = Array.from(permissionQueue.values())
            .filter(p => p.status === 'pending' && !p.decision)
            .sort((a, b) => b.timestamp - a.timestamp);
        // Polled every 500ms by pollPerms() -- 7200 requests an hour, virtually
        // all of them answering "nothing pending". The ETag turns the steady
        // state into a bodyless 304. The cadence is deliberately NOT slowed:
        // approving permissions from the phone is what TSRCT is FOR, so latency
        // here is the product, not overhead.
        // The auto list and the last minute of auto-approvals ride on the same
        // poll, so every device agrees without a second request.
        const since = Date.now() - 60000;
        sendJson(req, res, {
            permissions: pending,
            autoAccept: [...autoAccept],
            autoApproved: autoApprovedRecent.filter(a => a.at >= since),
        });
        return;
    }


    // Turn auto-accept on/off for one session, or clear it: {session, on} | {clear:true}
    function postAutoAccept(req, res, pathname) {
        const { NOT_MINE, autoAccept, saveAutoAccept } = S;
        if (!(pathname === '/api/auto-accept' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session, on, clear } = JSON.parse(body || '{}');
                if (clear) autoAccept.clear();
                else {
                    const name = String(session || '');
                    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(name)) throw new Error('invalid session name');
                    if (on) autoAccept.add(name); else autoAccept.delete(name);
                }
                saveAutoAccept();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, autoAccept: [...autoAccept] }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }


    // Debug: List ALL permissions (including decided)
    function getPermissionsDebug(req, res, pathname) {
        const { NOT_MINE, permissionQueue } = S;
        if (!(pathname === '/api/permissions/debug' && req.method === 'GET')) return NOT_MINE;
        const all = Array.from(permissionQueue.values())
            .sort((a, b) => b.timestamp - a.timestamp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: all.length, permissions: all }));
        return;
    }


    // Purge: Deny all pending permissions and clear queue
    function postPermissionsPurge(req, res, pathname) {
        const { NOT_MINE, permissionQueue } = S;
        if (!(pathname === '/api/permissions/purge' && req.method === 'POST')) return NOT_MINE;
        const pending = Array.from(permissionQueue.values())
            .filter(p => p.status === 'pending' && !p.decision);
        const count = pending.length;

        // Mark all pending as denied
        pending.forEach(p => {
            p.decision = 'deny';
            p.decidedAt = Date.now();
        });

        // Clear old decided permissions (older than 5 minutes)
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const [id, perm] of permissionQueue) {
            if (perm.decidedAt && perm.decidedAt < cutoff) {
                permissionQueue.delete(id);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, purged: count, remaining: permissionQueue.size }));
        return;
    }


    // Terminal key sender - send raw keys to tmux session AND return updated output
    function postTerminalKey(req, res, pathname) {
        const { NOT_MINE, tmux } = S;
        if (!(pathname === '/api/terminal/key' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session, key } = JSON.parse(body);
                const targetSession = session || S.TMUX_SESSION;
                const safeSession = targetSession.replace(/[^a-zA-Z0-9_-]/g, '');
                const safeKey = key.replace(/[^a-zA-Z0-9\-]/g, '');

                // Send the key
                tmux(['send-keys', '-t', safeSession, ...String(safeKey).trim().split(/\s+/)]);

                // Small delay to let tmux process the key
                const delay = ms => new Promise(r => setTimeout(r, ms));
                setTimeout(() => {
                    try {
                        // Capture updated output
                        const output = tmux(['capture-pane', '-t', safeSession, '-p', '-S', '-100']);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, key: safeKey, output }));
                    } catch (e2) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, key: safeKey }));
                    }
                }, 20);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }


    // Permission respond endpoint - no auth (for remote approve/deny)
    // Handles Claude's dropdown menu with proper key sequences
    function postPermissionRespond(req, res, pathname) {
        const { NOT_MINE, permissionQueue, tmux } = S;
        if (!(pathname === '/api/permission-respond' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { response, session } = JSON.parse(body);
                if (response !== 'y' && response !== 'n') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid response. Only y or n allowed.' }));
                    return;
                }
                const targetSession = session || S.TMUX_SESSION;
                let result;

                // A prompt that came through permission-hook.sh is answered by
                // the hook itself, and the dialog never appears. The keystroke
                // would then land in the idle composer (Enter) or cut a running
                // turn short (Escape). Keys are only for prompts the hook never saw.
                const now = Date.now();
                const viaHook = Array.from(permissionQueue.values())
                    .some(p => p.session === targetSession && p.decidedAt && now - p.decidedAt < 5000);
                if (viaHook) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, action: response === 'y' ? 'approve' : 'deny', key: null, viaHook: true }));
                    return;
                }

                if (response === 'y') {
                    // Approve: Just press Enter (first option is usually allow)
                    tmux(['send-keys', '-t', targetSession, 'Enter']);
                    result = { success: true, action: 'approve', key: 'Enter' };
                } else {
                    // Deny: Send Escape to cancel/dismiss the permission prompt
                    tmux(['send-keys', '-t', targetSession, 'Escape']);
                    result = { success: true, action: 'deny', key: 'Escape' };
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }


    // Event endpoint - no auth (for hooks)
    function postEvent(req, res, pathname) {
        const { NOT_MINE, addEvent } = S;
        if (!(pathname === '/api/event' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const event = JSON.parse(body);
                addEvent(event);
                // Phase 2: feed hook events into the dispatcher so session_states stays fresh.
                if (S.dispatcher && S.dispatcher.eventConsumer) {
                    try { S.dispatcher.eventConsumer.ingest(event); }
                    catch (e) { console.warn('[dispatcher] eventConsumer.ingest failed:', e.message); }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        postPermission,
        getRoute,
        postRoute,
        postRoute2,
        getPermissions,
        postAutoAccept,
        getPermissionsDebug,
        postPermissionsPurge,
        postTerminalKey,
        postPermissionRespond,
        postEvent,
    ];

    return function apiPermissions(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
