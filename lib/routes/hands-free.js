'use strict';
// hands-free (HF) sessions and their conversations.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (dispatcher) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    // ═══════════════════════════════════════════════════════════════════
    // HANDS-FREE API ENDPOINTS
    // ═══════════════════════════════════════════════════════════════════

    // Start new HF session
    function postHfStart(req, res, pathname, auth) {
        const { HFSession, MAX_HF_SESSIONS, NOT_MINE, generateHFSessionId, getSessionPwd, hfSessions } = S;
        if (!(pathname === '/api/hf/start' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { cwd, name, resume, systemPrompt, allowedTools } = JSON.parse(body || '{}');

                // Check max sessions limit
                if (hfSessions.size >= MAX_HF_SESSIONS) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Max sessions (${MAX_HF_SESSIONS}) reached` }));
                    return;
                }

                // SecretCo fail-closed: a primed non-Bedrock session must never be pointed
                // at an SecretCo tree (it would read SecretCo content into the public API).
                const startCwd = cwd || getSessionPwd();
                if (S.dispatcher && S.dispatcher.restrictedGuard && S.dispatcher.restrictedGuard.mentionsRestricted(startCwd)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'SecretCo is Bedrock-only; cannot open a session there', code: 'RESTRICTED_PROJECT' }));
                    return;
                }

                const sessionId = name || generateHFSessionId();

                // Check if session already exists
                if (hfSessions.has(sessionId)) {
                    const existing = hfSessions.get(sessionId);
                    // Update resume if provided
                    if (resume) {
                        existing.conversationId = resume;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, session: existing.getInfo(), existing: true }));
                    return;
                }

                // Create session with optional resume + optional priming (advisor).
                const session = new HFSession(sessionId, startCwd, resume, { systemPrompt, allowedTools });
                hfSessions.set(sessionId, session);


                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, session: session.getInfo() }));
            } catch (e) {
                console.error(`[HF] Start error: ${e.message || e}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }


    // List HF sessions
    function getHfSessions(req, res, pathname, auth) {
        const { NOT_MINE, hfSessions } = S;
        if (!(pathname === '/api/hf/sessions' && req.method === 'GET')) return NOT_MINE;
        const sessions = Array.from(hfSessions.values()).map(s => s.getInfo());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions }));
        return;
    }


    // List Claude conversations (from ~/.claude/projects/)
    function getConversations(req, res, pathname, auth) {
        const { NOT_MINE, parseReqUrl } = S;
        if (!(pathname === '/api/conversations' && req.method === 'GET')) return NOT_MINE;
        try {
            const homeDir = require('os').homedir();
            const claudeDir = require('path').join(homeDir, '.claude', 'projects');
            const fsModule = require('fs');
            const pathModule = require('path');

            // Get optional project filter from query params
            const parsedUrl = parseReqUrl(req.url);
            // url.parse with true already decodes, don't double-decode
            const projectFilter = parsedUrl.query.project || null;

            const conversations = [];

            if (fsModule.existsSync(claudeDir)) {
                // Read all project directories
                const projects = fsModule.readdirSync(claudeDir);

                for (const project of projects.slice(0, 30)) {
                    const projectPath = pathModule.join(claudeDir, project);
                    const stat = fsModule.statSync(projectPath);
                    if (stat.isDirectory()) {
                        // If project filter is set, check if this project matches
                        // Project dirs are encoded paths like "-home-you-PROJECTS-TSRCT"
                        if (projectFilter) {
                            // Convert path like /mnt/c/Users/... to -mnt-c-Users-...
                            const encodedFilter = projectFilter.replace(/\//g, '-');
                            // Check if project dir matches (could start with - or not depending on OS)
                            const projectLower = project.toLowerCase();
                            const filterLower = encodedFilter.toLowerCase();
                            const filterNoLeadingDash = filterLower.replace(/^-/, '');

                            const matches = projectLower === filterLower ||
                                            projectLower === filterNoLeadingDash ||
                                            projectLower.endsWith(filterLower) ||
                                            projectLower.endsWith(filterNoLeadingDash);

                            if (!matches) {
                                continue; // Skip non-matching projects
                            }
                        }

                        // Read conversation files in this project
                        const files = fsModule.readdirSync(projectPath)
                            .filter(f => f.endsWith('.jsonl'));

                        for (const file of files) {
                            const convId = file.replace('.jsonl', '');
                            const filePath = pathModule.join(projectPath, file);
                            const fileStat = fsModule.statSync(filePath);

                            // Try to read content to get a better preview
                            let preview = '';
                            let firstUserMessage = '';
                            try {
                                const content = fsModule.readFileSync(filePath, 'utf8');
                                const lines = content.split('\n').slice(0, 20);
                                for (const line of lines) {
                                    if (!line.trim()) continue;
                                    try {
                                        const json = JSON.parse(line);
                                        // Look for summary
                                        if (json.type === 'summary' && json.summary) {
                                            preview = json.summary.substring(0, 80);
                                            break;
                                        }
                                        // Or first user message
                                        if (json.type === 'human' && json.message?.content && !firstUserMessage) {
                                            const text = typeof json.message.content === 'string'
                                                ? json.message.content
                                                : json.message.content[0]?.text || '';
                                            firstUserMessage = text.substring(0, 80).replace(/\n/g, ' ');
                                        }
                                    } catch (e) {}
                                }
                                if (!preview && firstUserMessage) {
                                    preview = firstUserMessage;
                                }
                            } catch (e) {}

                            // Format date nicely
                            const mtime = fileStat.mtime;
                            const now = new Date();
                            const diffDays = Math.floor((now - mtime) / (1000 * 60 * 60 * 24));
                            let dateStr;
                            if (diffDays === 0) {
                                dateStr = 'Hoy ' + mtime.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
                            } else if (diffDays === 1) {
                                dateStr = 'Ayer';
                            } else if (diffDays < 7) {
                                dateStr = `Hace ${diffDays} días`;
                            } else {
                                dateStr = mtime.toLocaleDateString('es', { day: 'numeric', month: 'short' });
                            }

                            conversations.push({
                                id: convId,
                                project: project,
                                date: dateStr,
                                mtime: mtime.getTime(),
                                preview: preview || 'Sin resumen',
                                path: filePath
                            });
                        }
                    }
                }
            }

            // Sort by modification time descending (most recent first)
            conversations.sort((a, b) => b.mtime - a.mtime);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ conversations: conversations.slice(0, 15) }));
        } catch (e) {
            console.error(`[API] Conversations error: ${e.message || e}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ conversations: [] }));
        }
        return;
    }


    // Send message to HF session
    function postHfSend(req, res, pathname, auth) {
        const { NOT_MINE, hfSessions } = S;
        if (!(pathname === '/api/hf/send' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { id, message } = JSON.parse(body);
                const session = hfSessions.get(id);

                if (!session) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Session not found' }));
                    return;
                }

                if (!message || !message.trim()) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Message is required' }));
                    return;
                }

                // Respond immediately - results come via SSE
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, processing: true }));

                // Send async - updates come via SSE
                try {
                    await session.send(message.trim());
                } catch (sendErr) {
                    console.error(`[HF] Send error: ${sendErr.message || sendErr}`);
                    session.emitSSE({ type: 'error', message: sendErr.message });
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }


    // SSE stream for HF session output
    // Note: EventSource doesn't support headers, so we accept token via query param
    function getRoute(req, res, pathname, auth) {
        const { NOT_MINE, hfSSEClients, hfSessions, isAuthorized, parseReqUrl } = S;
    const hfOutputMatch = pathname.match(/^\/api\/hf\/output\/([^/]+)$/);
        if (!(hfOutputMatch && req.method === 'GET')) return NOT_MINE;
        const urlObj = parseReqUrl(req.url);
        const queryToken = urlObj.query.token;

        // Verify auth from query param (EventSource can't send headers)
        if (!isAuthorized(queryToken, req) && !isAuthorized(auth, req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }

        const sessionId = decodeURIComponent(hfOutputMatch[1]);
        const session = hfSessions.get(sessionId);

        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
            return;
        }

        // Set up SSE
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Add client to SSE set
        if (!hfSSEClients.has(sessionId)) {
            hfSSEClients.set(sessionId, new Set());
        }
        hfSSEClients.get(sessionId).add(res);

        // Send initial state
        res.write(`data: ${JSON.stringify({ type: 'connected', session: session.getInfo() })}\n\n`);

        // Check for buffered response (within last 5 minutes)
        if (session.lastAssistantDone && (Date.now() - session.lastAssistantDone.timestamp) < 300000) {
            res.write(`data: ${JSON.stringify(session.lastAssistantDone.data)}\n\n`);
        }

        // Keep alive - every 15 seconds for mobile stability
        const keepAlive = setInterval(() => {
            try {
                res.write(': keepalive\n\n');
            } catch (e) {
                clearInterval(keepAlive);
            }
        }, 15000);

        // Handle client disconnect
        req.on('close', () => {
            clearInterval(keepAlive);
            const clients = hfSSEClients.get(sessionId);
            if (clients) {
                clients.delete(res);
            }
        });

        return;
    }


    // Stop HF session
    function postRoute(req, res, pathname, auth) {
        const { NOT_MINE, hfSessions } = S;
    const hfStopMatch = pathname.match(/^\/api\/hf\/stop\/([^/]+)$/);
        if (!(hfStopMatch && req.method === 'POST')) return NOT_MINE;
        const sessionId = decodeURIComponent(hfStopMatch[1]);
        const session = hfSessions.get(sessionId);

        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
            return;
        }

        session.stop();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }


    // Respond to permission in HF session
    function postRoute2(req, res, pathname, auth) {
        const { NOT_MINE, hfSessions } = S;
    const hfPermMatch = pathname.match(/^\/api\/hf\/permission\/([^/]+)$/);
        if (!(hfPermMatch && req.method === 'POST')) return NOT_MINE;
        const sessionId = decodeURIComponent(hfPermMatch[1]);
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { decision } = JSON.parse(body);
                const session = hfSessions.get(sessionId);

                if (!session) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Session not found' }));
                    return;
                }

                session.respondPermission(decision);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, decision }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }


    // Get HF session info
    function getRoute2(req, res, pathname, auth) {
        const { NOT_MINE, hfSessions } = S;
    const hfInfoMatch = pathname.match(/^\/api\/hf\/info\/([^/]+)$/);
        if (!(hfInfoMatch && req.method === 'GET')) return NOT_MINE;
        const sessionId = decodeURIComponent(hfInfoMatch[1]);
        const session = hfSessions.get(sessionId);

        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session: session.getInfo(), messages: session.messages.slice(-20) }));
        return;
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        postHfStart,
        getHfSessions,
        getConversations,
        postHfSend,
        getRoute,
        postRoute,
        postRoute2,
        getRoute2,
    ];

    return function apiHandsFree(req, res, pathname, auth) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname, auth);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
