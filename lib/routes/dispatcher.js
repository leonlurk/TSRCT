'use strict';
const path = require('path');
const paths = require('../paths');
// The dispatcher's routes (/api/dispatcher/*, /api/tower/*): codemap, session states,
// ClickUp, inbox, worklogs, hours, digest, notes. Moved out of server.js (cleanup P2,
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

    // ═══ Productivity Dashboard (Increment 1) — ClickUp tasks + analysis ═══
    // ── GET /api/dispatcher/clickup/tasks — assigned tasks + analysis state ──
    async function getClickupTasks(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/clickup/tasks' && req.method === 'GET')) return NOT_MINE;
        const analyzing = new Set(S.dispatcher.clickupAnalyst.analyzingRowIds());
        const tasks = S.dispatcher.db.getAllClickupTasks().map(t => {
            let analysis = null;
            if (t.analysis_json) { try { analysis = JSON.parse(t.analysis_json); } catch {} }
            return { ...t, analysis, analyzing: analyzing.has(t.id) };
        });
        return jsonResp(res, 200, { tasks, token_configured: !!S.dispatcher.clickupSync.getToken() });
    }

    // ── POST /api/dispatcher/clickup/tasks/sync — manual REST poll ──
    async function postClickupTasksSync(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/clickup/tasks/sync' && req.method === 'POST')) return NOT_MINE;
        try {
            const r = await S.dispatcher.clickupSync.syncOnce();
            return jsonResp(res, 200, { ok: true, ...r });
        } catch (e) {
            return jsonResp(res, 400, { error: e.message });
        }
    }

    // ── GET/POST /api/dispatcher/clickup/config — the ClickUp API token ──
    async function getClickupConfig(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/clickup/config' && req.method === 'GET')) return NOT_MINE;
        // Never return the token itself; just whether one is set, where it came
        // from, and a masked fingerprint so Leon can tell WHICH token is live.
        return jsonResp(res, 200, {
            ...S.dispatcher.clickupSync.tokenInfo(),
            user_id: process.env.CLICKUP_USER_ID || null,
            workspace_name: S.dispatcher.clickupSync.WORKLOG_TEAM_NAME,
        });
    }

    async function postClickupConfig(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/clickup/config' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        const tok = (body.token || '').trim();
        if (!tok) return jsonResp(res, 400, { error: 'token required' });
        // Verify BEFORE storing: a bad token must not replace a working one, and
        // its failures downstream read as "no access to this task", not "bad token".
        let check;
        try { check = await S.dispatcher.clickupSync.verifyToken(tok); }
        catch (e) { return jsonResp(res, 400, { error: e.message }); }

        S.dispatcher.db.setConfig('clickup_api_token', tok);
        S.dispatcher.clickupSync.resetCaches(); // team/task caches belong to the old token

        // Re-resolve the worklog workspace with the NEW token. Worklogs go to exactly
        // one workspace; if this token can't see it, say so now instead of at CREATE.
        const warnings = [];
        let worklogTeam = null;
        try {
            const teamId = await S.dispatcher.clickupSync.getTeamId(tok);
            const hit = check.workspaces.find(w => w.id === String(teamId));
            worklogTeam = { id: String(teamId), name: hit ? hit.name : S.dispatcher.clickupSync.WORKLOG_TEAM_NAME };
        } catch (e) { warnings.push(e.message); }

        const envUser = process.env.CLICKUP_USER_ID || null;
        if (envUser && String(envUser) !== check.user.id) {
            warnings.push(`CLICKUP_USER_ID is ${envUser} but this token belongs to ${check.user.id} (${check.user.username || 'unknown'}) — task sync and worklog history filter by the env id, so update it or unset it.`);
        }
        return jsonResp(res, 200, {
            ok: true,
            ...S.dispatcher.clickupSync.tokenInfo(),
            user: check.user,
            workspaces: check.workspaces,
            worklog_team: worklogTeam,
            warnings,
        });
    }

    // ── POST /api/dispatcher/clickup/analyze-bulk — analyze all assigned tasks ──
    async function postClickupAnalyzeBulk(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/clickup/analyze-bulk' && req.method === 'POST')) return NOT_MINE;
        const rows = S.dispatcher.db.getAllClickupTasks();
        const out = S.dispatcher.clickupAnalyst.submitBulk(rows);
        return jsonResp(res, 200, { ok: true, submitted: out.filter(o => o.queued).length, results: out });
    }

    // ── GET /api/dispatcher/clickup/analyst-activity — live step feed (what it's doing now) ──
    async function getClickupAnalystActivity(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/clickup/analyst-activity' && req.method === 'GET')) return NOT_MINE;
        return jsonResp(res, 200, S.dispatcher.clickupAnalyst.getActivitySteps());
    }

    // ── POST /api/dispatcher/clickup/tasks/map-bulk { ids:[], session } — map a group at once ──
    async function postClickupTasksMapBulk(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/clickup/tasks/map-bulk' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        const ids = Array.isArray(body.ids) ? body.ids : [];
        const session = String(body.session || '').trim() || null;
        let mapped = 0;
        for (const id of ids) {
            const row = S.dispatcher.db.getClickupTask(Number(id));
            if (row) { S.dispatcher.db.setClickupMappedSession(row.id, session); mapped++; }
        }
        return jsonResp(res, 200, { ok: true, mapped, session });
    }

    // ── POST /api/dispatcher/clickup/analyze-group { session } — analyze every task in a session cluster ──
    async function postClickupAnalyzeGroup(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/clickup/analyze-group' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        const session = String(body.session || '').trim();
        if (!session) return jsonResp(res, 400, { error: 'session required' });
        const rows = S.dispatcher.db.getAllClickupTasks().filter(t => t.mapped_session === session);
        const out = S.dispatcher.clickupAnalyst.submitBulk(rows);
        return jsonResp(res, 200, { ok: true, submitted: out.filter(o => o.queued).length, results: out });
    }

    // ── POST /api/dispatcher/clickup/task/:id/map { session } — map a tmux session ──
    async function postRoute(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        const mm = pathname.match(/^\/api\/dispatcher\/clickup\/task\/(\d+)\/map$/);
        if (!(mm && req.method === 'POST')) return NOT_MINE;
            const body = JSON.parse((await readBody(req)) || '{}');
            const row = S.dispatcher.db.getClickupTask(Number(mm[1]));
            if (!row) return jsonResp(res, 404, { error: 'task not found' });
            const session = String(body.session || '').trim() || null;
            S.dispatcher.db.setClickupMappedSession(row.id, session);
            return jsonResp(res, 200, { ok: true, id: row.id, mapped_session: session, cwd: session ? S.dispatcher.clickupAnalyst.sessionCwd(session) : null });
    }

    // ── POST /api/dispatcher/clickup/task/:id/propose — analyst proposes the interpretation ──
    async function postRoute2(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        const pm = pathname.match(/^\/api\/dispatcher\/clickup\/task\/(\d+)\/propose$/);
        if (!(pm && req.method === 'POST')) return NOT_MINE;
            const row = S.dispatcher.db.getClickupTask(Number(pm[1]));
            if (!row) return jsonResp(res, 404, { error: 'task not found' });
            const r = S.dispatcher.clickupAnalyst.submitProposeInterpretation(row);
            return jsonResp(res, 200, { ok: true, id: row.id, ...r });
    }

    // ── POST /api/dispatcher/clickup/task/:id/interpretation { interpretation } ──
    async function postRoute3(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        const im = pathname.match(/^\/api\/dispatcher\/clickup\/task\/(\d+)\/interpretation$/);
        if (!(im && req.method === 'POST')) return NOT_MINE;
            const body = JSON.parse((await readBody(req)) || '{}');
            const row = S.dispatcher.db.getClickupTask(Number(im[1]));
            if (!row) return jsonResp(res, 404, { error: 'task not found' });
            S.dispatcher.db.setClickupInterpretation(row.id, String(body.interpretation || ''));
            return jsonResp(res, 200, { ok: true, id: row.id });
    }

    // ── POST /api/dispatcher/clickup/task/:id/analyze — analyze one task ──
    async function postRoute4(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        const am = pathname.match(/^\/api\/dispatcher\/clickup\/task\/(\d+)\/analyze$/);
        if (!(am && req.method === 'POST')) return NOT_MINE;
            const row = S.dispatcher.db.getClickupTask(Number(am[1]));
            if (!row) return jsonResp(res, 404, { error: 'task not found' });
            const r = S.dispatcher.clickupAnalyst.submitRow(row);
            return jsonResp(res, 200, { ok: true, id: row.id, ...r });
    }

    // ═══ Productivity Dashboard — unified Inbox ("where I stand") ═══
    // NOTE: namespaced under /clickup/ to avoid colliding with the dispatcher's
    // own /api/dispatcher/inbox (the pending_review task queue) defined earlier.
    // ── GET /api/dispatcher/clickup/inbox — the feed, each item flagged seen/unread ──
    async function getClickupInbox(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/clickup/inbox' && req.method === 'GET')) return NOT_MINE;
        const seen = S.dispatcher.db.getInboxSeen();
        const items = S.dispatcher.db.getInboxItems().map(it => ({ ...it, seen: !!seen[it.item_key] }));
        const counts = { mention: 0, comment: 0, assigned: 0, status: 0, due: 0, unread: 0 };
        for (const it of items) {
            if (it.seen) continue;
            counts.unread++;
            if (it.kind === 'overdue' || it.kind === 'due') counts.due++;
            else if (counts[it.kind] != null) counts[it.kind]++;
        }
        return jsonResp(res, 200, { items, counts, token_configured: !!S.dispatcher.clickupSync.getToken() });
    }

    // ── POST /api/dispatcher/clickup/inbox/refresh — force a poll (rebuilds the feed) ──
    async function postClickupInboxRefresh(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/clickup/inbox/refresh' && req.method === 'POST')) return NOT_MINE;
        try {
            const r = await S.dispatcher.clickupSync.syncOnce();
            return jsonResp(res, 200, { ok: true, ...r });
        } catch (e) { return jsonResp(res, 400, { error: e.message }); }
    }

    // ── POST /api/dispatcher/clickup/inbox/seen { item_key } — mark one item seen ──
    async function postClickupInboxSeen(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/clickup/inbox/seen' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        if (!body.item_key) return jsonResp(res, 400, { error: 'item_key required' });
        S.dispatcher.clickupSync.markInboxSeen(String(body.item_key));
        return jsonResp(res, 200, { ok: true });
    }

    // ── POST /api/dispatcher/clickup/inbox/seen-all — clear the whole feed ──
    async function postClickupInboxSeenAll(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/clickup/inbox/seen-all' && req.method === 'POST')) return NOT_MINE;
        S.dispatcher.clickupSync.markAllInboxSeen();
        return jsonResp(res, 200, { ok: true });
    }


    // ═══ Productivity Dashboard (Increment 2) — worklogs ═══
    // ── POST /api/dispatcher/worklogs/generate { range_start, range_end, hours_hint } ──
    async function postWorklogsGenerate(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/worklogs/generate' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        if (!body.range_start || !body.range_end) return jsonResp(res, 400, { error: 'range_start and range_end required (YYYY-MM-DD)' });
        const r = await S.dispatcher.worklogEngine.generate({
            range_start: String(body.range_start).slice(0, 10),
            range_end: String(body.range_end).slice(0, 10),
            hours_hint: String(body.hours_hint || '').slice(0, 2000),
        });
        return jsonResp(res, 200, { ok: true, ...r });
    }

    // ── HOURS RECALL: scan sessions -> per-day activity + calibrated estimate ──
    // POST /api/dispatcher/hours/scan { range_start, range_end } (async; poll GET)
    async function postHoursScan(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/hours/scan' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        const re = /^\d{4}-\d\d-\d\d$/;
        if (!re.test(body.range_start || '') || !re.test(body.range_end || '')) return jsonResp(res, 400, { error: 'range_start and range_end required (YYYY-MM-DD)' });
        if (body.range_start > body.range_end) return jsonResp(res, 400, { error: 'range_start is after range_end' });
        return jsonResp(res, 200, { ok: true, ...S.dispatcher.hoursEstimator.startScan({ range_start: body.range_start, range_end: body.range_end }) });
    }

    // GET /api/dispatcher/hours — scan + ask-Claude state
    async function getHours(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/hours' && req.method === 'GET')) return NOT_MINE;
        return jsonResp(res, 200, S.dispatcher.hoursEstimator.state());
    }

    // POST /api/dispatcher/hours/ask { note? } — analyst job over the last scan
    async function postHoursAsk(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/hours/ask' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        return jsonResp(res, 200, { ok: true, ...S.dispatcher.hoursEstimator.askClaude({ note: String(body.note || '').slice(0, 1000) }) });
    }

    async function postHoursAskCancel(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/hours/ask/cancel' && req.method === 'POST')) return NOT_MINE;
        return jsonResp(res, 200, { ok: true, ...S.dispatcher.hoursEstimator.cancelAsk() });
    }

    // ── POST /api/dispatcher/worklogs/cancel { batch_id? } — kill the running job ──
    // batch_id is optional: omitting it cancels whatever the engine last started,
    // which is what the dashboard button sends when its state has drifted.
    async function postWorklogsCancel(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/worklogs/cancel' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = S.dispatcher.worklogEngine.cancel(body.batch_id ? String(body.batch_id).slice(0, 64) : null);
        return jsonResp(res, 200, { ok: true, ...r });
    }

    // ── GET /api/dispatcher/worklogs — latest batch proposals + generating state ──
    async function getWorklogs(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/worklogs' && req.method === 'GET')) return NOT_MINE;
        return jsonResp(res, 200, S.dispatcher.worklogEngine.state());
    }

    // ── POST /api/dispatcher/worklog/:id — edit a proposal ──
    async function postRoute5(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        const wm = pathname.match(/^\/api\/dispatcher\/worklog\/(\d+)$/);
        if (!(wm && req.method === 'POST')) return NOT_MINE;
            const body = JSON.parse((await readBody(req)) || '{}');
            const row = S.dispatcher.db.getWorklogProposal(Number(wm[1]));
            if (!row) return jsonResp(res, 404, { error: 'proposal not found' });
            if (row.status === 'created') return jsonResp(res, 400, { error: 'already created in ClickUp; cannot edit' });
            const taskId = body.task_id != null ? String(body.task_id).trim() : row.task_id;
            S.dispatcher.db.updateWorklogProposal(row.id, {
                task_id: taskId,
                task_name: body.task_name != null ? body.task_name : row.task_name,
                hours: body.hours != null ? body.hours : row.hours,
                comment: body.comment != null ? body.comment : row.comment,
                billable: body.billable != null ? body.billable : row.billable,
                project: body.project != null ? body.project : row.project,
            });
            // new_task: an object turns "create this task first" on (or edits it), null turns it off.
            if (body.new_task !== undefined) {
                let lists = [];
                try { lists = await S.dispatcher.clickupSync.listCatalogue(); } catch {}
                const nt = body.new_task ? S.dispatcher.worklogEngine.cleanNewTask(body.new_task, lists) : null;
                if (body.new_task && !nt) return jsonResp(res, 400, { error: 'the new task needs a name' });
                // No list picked yet: start from the list of the task he is replacing, if active.
                if (nt && !nt.list_id && !body.new_task.list_id && taskId) {
                    try {
                        const h = await S.dispatcher.clickupSync.taskHealth(taskId);
                        if (h.list_id && lists.some(l => l.list_id === h.list_id)) nt.list_id = h.list_id;
                    } catch {}
                }
                S.dispatcher.db.setWorklogNewTask(row.id, nt);
            }
            // A new task id is re-checked at once, so an archived pick turns red while he looks.
            let task = null;
            if ((taskId || '') !== (row.task_id || '')) task = await S.dispatcher.worklogEngine.checkRow(S.dispatcher.db.getWorklogProposal(row.id));
            return jsonResp(res, 200, { ok: true, id: row.id, task });
    }

    // ── GET /api/dispatcher/worklog/:id/evidence — the [?] modal: why + checked quotes ──
    async function getRoute2(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        const wm = pathname.match(/^\/api\/dispatcher\/worklog\/(\d+)\/evidence$/);
        if (!(wm && req.method === 'GET')) return NOT_MINE;
            const row = S.dispatcher.db.getWorklogProposal(Number(wm[1]));
            if (!row) return jsonResp(res, 404, { error: 'proposal not found' });
            try {
                const r = await require('./lib/dispatcher/worklogEvidence').explain(row);
                return jsonResp(res, 200, { ok: true, id: row.id, work_date: row.work_date, project: row.project, comment: row.comment, hours: row.hours, ...r });
            } catch (e) { return jsonResp(res, 500, { error: e.message }); }
    }

    // ── POST /api/dispatcher/worklog/:id/dismiss ──
    async function postRoute6(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        const wm = pathname.match(/^\/api\/dispatcher\/worklog\/(\d+)\/dismiss$/);
        if (!(wm && req.method === 'POST')) return NOT_MINE;
            const row = S.dispatcher.db.getWorklogProposal(Number(wm[1]));
            if (!row) return jsonResp(res, 404, { error: 'proposal not found' });
            S.dispatcher.db.markWorklogDismissed(row.id);
            return jsonResp(res, 200, { ok: true });
    }

    // ── POST /api/dispatcher/worklogs/create { batch_id } — the EXPLICIT create GATE ──
    // Idempotent: only 'proposed'/'failed' rows are posted; a 'created' row is never
    // re-fired (clickup_time_entry_id is the guard). Transient 502s retried in createTimeEntry.
    async function postWorklogsCreate(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/worklogs/create' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        const batchId = body.batch_id;
        if (!batchId) return jsonResp(res, 400, { error: 'batch_id required' });
        const rows = S.dispatcher.db.getWorklogProposalsByBatch(batchId);
        let created = 0, failed = 0, skipped = 0, tasksCreated = 0;
        // Two rows asking for the same new task (same list + name) get ONE task.
        const madeTasks = new Map();
        for (let row of rows) {
            if (row.status === 'created' || row.status === 'dismissed') { skipped++; continue; }
            // "Create this task first": the task is made, written onto the row, and the
            // suggestion cleared BEFORE the time entry — so a retry after a failed
            // time entry logs on that task instead of creating a second one.
            if (row.new_task_json) {
                let nt = null;
                try { nt = JSON.parse(row.new_task_json); } catch {}
                if (!nt || !nt.list_id) { S.dispatcher.db.markWorklogFailed(row.id, 'new task: pick a list first'); failed++; continue; }
                const key = `${nt.list_id}|${String(nt.name || '').trim().toLowerCase()}`;
                try {
                    let t = madeTasks.get(key);
                    if (!t) {
                        t = await S.dispatcher.clickupSync.createTask({ listId: nt.list_id, name: nt.name, description: nt.description });
                        madeTasks.set(key, t);
                        tasksCreated++;
                        console.log(`[worklog] created ClickUp task ${t.id} "${t.name}" in list ${t.list.list} for row ${row.id}`);
                    }
                    S.dispatcher.db.updateWorklogProposal(row.id, { ...row, task_id: t.id, task_name: t.name });
                    S.dispatcher.db.setWorklogNewTask(row.id, null);
                    S.dispatcher.db.setWorklogTaskState(row.id, 'live', null);
                    row = S.dispatcher.db.getWorklogProposal(row.id);
                } catch (e) {
                    S.dispatcher.db.markWorklogFailed(row.id, `could not create the task: ${e.message}`);
                    failed++;
                    continue;
                }
            }
            if (!row.task_id) { S.dispatcher.db.markWorklogFailed(row.id, 'no task_id set'); failed++; continue; }
            // Archived or deleted tasks are BLOCKED; closed ones only carried a warning.
            // Asked fresh here, not from the stored state: it may have changed since.
            try {
                const h = await S.dispatcher.clickupSync.taskHealth(row.task_id);
                S.dispatcher.db.setWorklogTaskState(row.id, h.state, h.reason);
                if (S.dispatcher.worklogEngine.BLOCKING.has(h.state)) {
                    S.dispatcher.db.markWorklogFailed(row.id, `task ${row.task_id} is not usable (${h.reason}) - pick a live task or create a new one`);
                    failed++;
                    continue;
                }
            } catch (e) {
                S.dispatcher.db.markWorklogFailed(row.id, `could not check the task in ClickUp: ${e.message}`);
                failed++;
                continue;
            }
            // SecretCo: hours are loggable, but never let an AI-derived SecretCo comment post.
            //
            // This comment used to describe a check that DID NOT EXIST in the code --
            // found by the 2026-08-14 audit, which is why the rule now is: never read a
            // guard comment as evidence the guard is there, check the call. Implemented
            // 2026-08-15. The comment text is what an LLM wrote; the hours are Leon's
            // own figure, so the entry still posts, with a neutral description.
            let comment = row.comment || '';
            if (restrictedGuard.mentionsRestricted(comment)) {
                console.warn(`[worklog] SecretCo comment neutralized on row ${row.id}`);
                comment = '(logged via TSRCT)';
            }
            const dateMs = new Date(`${row.work_date}T12:00:00-03:00`).getTime();
            try {
                const r = await S.dispatcher.clickupSync.createTimeEntry({
                    taskId: row.task_id,
                    dateMs: isNaN(dateMs) ? Date.now() : dateMs,
                    durationMs: Math.round((Number(row.hours) || 0) * 3600 * 1000),
                    billable: !!row.billable,
                    description: comment,
                });
                S.dispatcher.db.markWorklogCreated(row.id, r.id);
                created++;
            } catch (e) {
                S.dispatcher.db.markWorklogFailed(row.id, e.message);
                failed++;
            }
        }
        return jsonResp(res, 200, { ok: true, created, failed, skipped, tasks_created: tasksCreated });
    }

    // ── GET /api/dispatcher/clickup/task-lookup?id=... — validate/paste a task id ──
    // Says whether the task is usable too (live / closed / archived / gone).
    async function getClickupTaskLookup(req, res, pathname) {
        const { NOT_MINE, jsonResp, parseReqUrl } = S;
        const parsed = parseReqUrl(req.url);
        const query = parsed.query || {};
        if (!(pathname === '/api/dispatcher/clickup/task-lookup' && req.method === 'GET')) return NOT_MINE;
        const id = (query.id || '').trim();
        if (!id) return jsonResp(res, 400, { error: 'id required' });
        try {
            const h = await S.dispatcher.clickupSync.taskHealth(id);
            if (h.state === 'gone') return jsonResp(res, 404, { error: 'task not found', state: 'gone' });
            return jsonResp(res, 200, { ok: true, task: { id, name: h.name, status: h.status, state: h.state, reason: h.reason, list: h.list_name } });
        } catch (e) { return jsonResp(res, 400, { error: e.message }); }
    }

    // ── GET /api/dispatcher/clickup/lists — active lists, for "create a task here" ──
    async function getClickupLists(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/clickup/lists' && req.method === 'GET')) return NOT_MINE;
        try { return jsonResp(res, 200, { ok: true, lists: await S.dispatcher.clickupSync.listCatalogue() }); }
        catch (e) { return jsonResp(res, 400, { error: e.message, lists: [] }); }
    }


    // ═══ Productivity Dashboard (Increment 3) — vault digest + note routing ═══
    // ── POST /api/dispatcher/digest/generate ──
    async function postDigestGenerate(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/digest/generate' && req.method === 'POST')) return NOT_MINE;
        // Pass today's local (UTC-3) date so the agent scopes to the right day.
        const today = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
        const id = S.dispatcher.digestEngine.generateDigest(today);
        return jsonResp(res, 200, { ok: true, id });
    }

    // ── GET /api/dispatcher/digest — latest digest ──
    async function getDigest(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/digest' && req.method === 'GET')) return NOT_MINE;
        return jsonResp(res, 200, { digest: S.dispatcher.db.getLatestVaultDigest() });
    }

    // ── POST /api/dispatcher/notes/route { note } — route a meeting note ──
    async function postNotesRoute(req, res, pathname) {
        const { NOT_MINE, jsonResp, readBody } = S;
        if (!(pathname === '/api/dispatcher/notes/route' && req.method === 'POST')) return NOT_MINE;
        const body = JSON.parse((await readBody(req)) || '{}');
        const note = String(body.note || '').trim();
        if (!note) return jsonResp(res, 400, { error: 'note required' });
        const id = S.dispatcher.digestEngine.routeNote(note);
        return jsonResp(res, 200, { ok: true, id });
    }

    // ── GET /api/dispatcher/notes — recent routing proposals ──
    async function getNotes(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/dispatcher/notes' && req.method === 'GET')) return NOT_MINE;
        return jsonResp(res, 200, { notes: S.dispatcher.db.getNoteRoutes() });
    }

    // ── POST /api/dispatcher/note/:id/approve { path?, content? } — WRITE to the vault ──
    async function postRoute7(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, fs, jsonResp, path, readBody } = S;
        const nm = pathname.match(/^\/api\/dispatcher\/note\/(\d+)\/approve$/);
        if (!(nm && req.method === 'POST')) return NOT_MINE;
            const body = JSON.parse((await readBody(req)) || '{}');
            const row = S.dispatcher.db.getNoteRoute(Number(nm[1]));
            if (!row) return jsonResp(res, 404, { error: 'note not found' });
            // Allow Leon's edits to the proposed path/content before writing.
            const relPath = String(body.path != null ? body.path : (row.proposed_path || '')).trim();
            const content = String(body.content != null ? body.content : (row.proposed_content || ''));
            if (!relPath || !content) return jsonResp(res, 400, { error: 'path and content required' });
            // SecretCo guard: never write SecretCo content through this path.
            if (S.restrictedGuard.mentionsRestricted(relPath, content, row.note_text)) {
                return jsonResp(res, 403, { error: 'SecretCo is Bedrock-only; route manually', code: 'RESTRICTED_PROJECT' });
            }
            // Containment guard: the resolved path MUST stay inside the vault.
            const VAULT_ROOT = paths.VAULT_ROOT;
            const resolved = path.resolve(VAULT_ROOT, relPath);
            if (resolved !== VAULT_ROOT && !resolved.startsWith(VAULT_ROOT + path.sep)) {
                return jsonResp(res, 400, { error: 'path escapes the vault' });
            }
            if (!/\.md$/i.test(resolved)) return jsonResp(res, 400, { error: 'destination must be a .md file' });
            try {
                fs.mkdirSync(path.dirname(resolved), { recursive: true });
                if (fs.existsSync(resolved)) {
                    // Append to existing project/state file with a separator.
                    fs.appendFileSync(resolved, `\n\n${content.trim()}\n`);
                } else {
                    fs.writeFileSync(resolved, `${content.trim()}\n`);
                }
                // Persist any edits Leon made, then mark written.
                S.dispatcher.db.updateNoteRouteProposal(row.id, { path: relPath, content });
                S.dispatcher.db.markNoteRouteWritten(row.id);
                return jsonResp(res, 200, { ok: true, written: relPath });
            } catch (e) {
                return jsonResp(res, 500, { error: `write failed: ${e.message}` });
            }
    }

    // ── POST /api/dispatcher/note/:id/dismiss ──
    async function postRoute8(req, res, pathname) {
        const { NOT_MINE, jsonResp } = S;
        const nm = pathname.match(/^\/api\/dispatcher\/note\/(\d+)\/dismiss$/);
        if (!(nm && req.method === 'POST')) return NOT_MINE;
            const row = S.dispatcher.db.getNoteRoute(Number(nm[1]));
            if (!row) return jsonResp(res, 404, { error: 'note not found' });
            S.dispatcher.db.markNoteRouteDismissed(row.id);
            return jsonResp(res, 200, { ok: true });
    }

    // Tried in this order, the order the routes were always matched in.
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
        getClickupTasks,
        postClickupTasksSync,
        getClickupConfig,
        postClickupConfig,
        postClickupAnalyzeBulk,
        getClickupAnalystActivity,
        postClickupTasksMapBulk,
        postClickupAnalyzeGroup,
        postRoute,
        postRoute2,
        postRoute3,
        postRoute4,
        getClickupInbox,
        postClickupInboxRefresh,
        postClickupInboxSeen,
        postClickupInboxSeenAll,
        postWorklogsGenerate,
        postHoursScan,
        getHours,
        postHoursAsk,
        postHoursAskCancel,
        postWorklogsCancel,
        getWorklogs,
        postRoute5,
        getRoute2,
        postRoute6,
        postWorklogsCreate,
        getClickupTaskLookup,
        getClickupLists,
        postDigestGenerate,
        getDigest,
        postNotesRoute,
        getNotes,
        postRoute7,
        postRoute8,
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
