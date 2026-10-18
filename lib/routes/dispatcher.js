'use strict';
// The dispatcher's routes (/api/dispatcher/*, /api/tower/*): codemap and session
// states. Moved out of server.js (cleanup P2,
// 2026-10-17); it is reached through the delegated group, after the auth gate. Values
// the server changes over time are read as S.<name> (dispatcher).

module.exports = (S) => {

    // ── Codemap (repo-map MAP.md control surface) ──────────────────────
    // Browser receives metadata ONLY (counts/age/drift + project name) — never code.
    async function getCodemapSessions(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/codemap/sessions' && req.method === 'GET')) return NOT_MINE;
        const eng = S.dispatcher.codemapEngine;
        return jsonResp(res, 200, {
            genmap_ok: eng.genmapAvailable(),
            autopilot: eng.getAutopilot(),
            sessions: eng.listSessionMaps(),
        });
    }

    async function postCodemapRegenerate(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/codemap/regenerate' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        try {
            const map = S.dispatcher.codemapEngine.regenerate(body.session);
            return jsonResp(res, 200, { ok: true, session: body.session, map });
        } catch (e) {
            const secretco = e && e.code === 'RESTRICTED_PROJECT';
            return jsonResp(res, secretco ? 403 : 500, { ok: false, secretco: !!secretco, error: e.message });
        }
    }

    async function postCodemapPrime(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody, sendToTmuxSession } = S;
        if (!(pathname === '/api/dispatcher/codemap/prime' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        try {
            const r = S.dispatcher.codemapEngine.prime(body.session, sendToTmuxSession);
            return jsonResp(res, r && r.success ? 200 : 400, r);
        } catch (e) {
            const secretco = e && e.code === 'RESTRICTED_PROJECT';
            return jsonResp(res, secretco ? 403 : 500, { success: false, secretco: !!secretco, error: e.message });
        }
    }

    async function postCodemapAutopilot(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/codemap/autopilot' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        const autopilot = S.dispatcher.codemapEngine.setAutopilot(!!body.enabled);
        return jsonResp(res, 200, { ok: true, autopilot });
    }


    // ── GET /api/dispatcher/session-states (Phase 2) ──
    async function getSessionStates(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/session-states' && req.method === 'GET')) return NOT_MINE;
        // core.getSessions() was a one-line wrapper over this; the wrapper died
        // with the Slack pipeline, the tmux adapter did not.
        const live = S.dispatcher.tmux.listSessions();
        const states = S.dispatcher.db.getAllSessionStates();
        const stateByName = Object.fromEntries(states.map(s => [s.name, s]));
        const merged = live.map(s => {
            const st = stateByName[s.name];
            return {
                name: s.name,
                cwd: s.cwd,
                attached: s.attached,
                state: st ? st.state : 'unknown',
                reason: st ? st.reason : null,
                last_activity: st ? st.last_activity : null,
                current_task_id: st ? st.current_task_id : null,
                updated_at: st ? st.updated_at : null,
            };
        });
        return jsonResp(res, 200, { sessions: merged });
    }

    // ── GET /api/dispatcher/session-events?since=<id> — state transitions for audio alerts ──
    // Lightweight feed of session state-change events (type 'state') so the frontend
    // can announce "session finished / needs you" by voice when TSRCT is unfocused.
    async function getSessionEvents(req, res, pathname) {
        const { NOT_MINE, jsonResp, parseReqUrl } = S;
        const parsed = parseReqUrl(req.url);
        const query = parsed.query || {};
        if (!(pathname === '/api/dispatcher/session-events' && req.method === 'GET')) return NOT_MINE;
        if (!S.dispatcher.activityLog) return jsonResp(res, 200, { events: [], latest: 0 });
        const since = parseInt(query.since) || 0;
        const events = S.dispatcher.activityLog.getSince(since, ['state']);
        return jsonResp(res, 200, { events, latest: S.dispatcher.activityLog.latestId() });
    }

    // ── GET /api/dispatcher/session/:name/capture — last N lines from tmux ──
    async function getRoute(req, res, pathname) {
        const { NOT_MINE, jsonResp, parseReqUrl } = S;
        const parsed = parseReqUrl(req.url);
        const query = parsed.query || {};
        const m = pathname.match(/^\/api\/dispatcher\/session\/([^/]+)\/capture$/);
        if (!(m && req.method === 'GET')) return NOT_MINE;
            const lines = Math.min(Number(query.lines) || 60, 300);
            const out = S.dispatcher.tmux.captureSession(decodeURIComponent(m[1]), lines);
            return jsonResp(res, 200, { name: m[1], capture: out });
    }

    // ── POST /api/dispatcher/context/preview (debug: see what contextBuilder returns) ──
    async function postContextPreview(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/context/preview' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        // SecretCo (found 2026-09-24): this returned the project's vault note and
        // decisions IN the HTTP response for any name, "SecretCoSandbox" included.
        if (restrictedGuard.mentionsRestricted(String(body.project || ''))) return jsonResp(res, 403, { error: new restrictedGuard.RestrictedProjectError('context preview').message });
        const ctx = S.dispatcher.contextBuilder.buildContext(body.project);
        if (restrictedGuard.mentionsRestricted(ctx)) return jsonResp(res, 403, { error: new restrictedGuard.RestrictedProjectError('context preview').message });
        return jsonResp(res, 200, { project: body.project, length: ctx.length, context: ctx });
    }

    // ── GET /api/tower/state — kept ONLY for stale cached PWAs ──
    // TOWER and its engine are gone (2026-09-19). A phone still running the old
    // bundle polls this every few seconds; an empty answer stops it quietly,
    // where a 404 would fill the log with noise until it reloads.
    async function getTowerState(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/tower/state' && req.method === 'GET')) return NOT_MINE;
        return jsonResp(res, 200, { retired: true, zones: {}, sessions: [], activity: [] });
    }

    // ── POST /api/tower/activity/clear — wipe the live Hermes feed ──
    async function postTowerActivityClear(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/tower/activity/clear' && req.method === 'POST')) return NOT_MINE;
        S.dispatcher.activityLog.clear();
        return jsonResp(res, 200, { cleared: true });
    }

    const ROUTES = [
        getCodemapSessions,
        postCodemapRegenerate,
        postCodemapPrime,
        postCodemapAutopilot,
        getSessionStates,
        getSessionEvents,
        getRoute,
        postContextPreview,
        getTowerState,
        postTowerActivityClear,
    ];

    return async function handleDispatcherRoute(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = await route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        const { jsonResp } = S;
        return jsonResp(res, 404, { error: 'unknown dispatcher route' });
    };
};
