'use strict';
// Session actions, automations, scheduler, morning, push, ring.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (none here) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    function postSessionWeight(req, res, pathname) {
        const { NOT_MINE, sessionWeight } = S;
        if (!(pathname === '/api/session/weight' && req.method === 'POST')) return NOT_MINE;
        // Ingest from the Stop hook (~/.claude/hooks/session-weight.sh). One row
        // per session per turn; the hook reads the transcript, so this costs no
        // tokens. Always 200 — a warning system must never break a turn.
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 32 * 1024) req.destroy(); });
        req.on('end', () => {
            try {
                const row = sessionWeight.record(JSON.parse(body || '{}'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: !!row, ctx: row ? row.ctx : 0 }));
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    function getSessionWeights(req, res, pathname) {
        const { NOT_MINE, isHiddenSession, sessionWeight, tmux } = S;
        if (!(pathname === '/api/session/weights' && req.method === 'GET')) return NOT_MINE;
        // Read model for the UI badge + warning bar.
        try {
            let live = null;
            try {
                live = tmux(['list-sessions', '-F', '#{session_name}'])
                    .trim().split('\n').filter(Boolean)
                    .filter(n => !isHiddenSession(n));   // las de Ro (y Tesla) no son carga de Leon
            } catch { live = null; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(sessionWeight.all(live)));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ thresholds: sessionWeight.thresholds(), sessions: [], error: e.message }));
        }
        return;
    }

    function postSessionWeightSnooze(req, res, pathname) {
        const { NOT_MINE, sessionWeight } = S;
        if (!(pathname === '/api/session/weight/snooze' && req.method === 'POST')) return NOT_MINE;
        // "Dame 5 minutos" — silence the nag, keep the badge honest.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session, minutes } = JSON.parse(body || '{}');
                const safe = String(session || '').replace(/[^a-zA-Z0-9_-]/g, '');
                if (!safe) throw new Error('session required');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(sessionWeight.snooze(safe, minutes)));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postSessionHandoff(req, res, pathname) {
        const { NOT_MINE, SERVER_SESSION, restrictedGuard, getSessionPwd, sessionWeight, tmux } = S;
        if (!(pathname === '/api/session/handoff' && req.method === 'POST')) return NOT_MINE;
        // One click: /compact the heavy session, read its summary off disk (free),
        // open a fresh session in the SAME directory primed with that summary, and
        // only THEN retire the old one. Fails closed: no summary => nothing killed.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const safe = String(parsed.session || '').replace(/[^a-zA-Z0-9_-]/g, '');
                if (!safe || safe !== String(parsed.session || '')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid session name' }));
                    return;
                }
                if (SERVER_SESSION && safe === SERVER_SESSION) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Cannot hand off the server session' }));
                    return;
                }
                try { tmux(['has-session', '-t', safe]); }
                catch {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `no such session: ${safe}` }));
                    return;
                }
                // SecretCo contract: the handoff pastes a compact summary between
                // panes. Local-only, but the boundary is cheapest to hold by not
                // crossing it — the weight hook already skips SecretCo panes, so this
                // is the second layer, not the only one.
                const cwd = getSessionPwd(safe);
                if (restrictedGuard.mentionsRestricted(cwd, safe)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: new restrictedGuard.RestrictedProjectError('session handoff').message }));
                    return;
                }
                const out = sessionWeight.startHandoff(safe, { killOld: parsed.killOld !== false });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ...out, session: safe }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function getAutomations(req, res, pathname) {
        const { NOT_MINE, automations, jsonResp } = S;
        if (!(pathname === '/api/automations' && req.method === 'GET')) return NOT_MINE;
        // Every automation as a card. Touches systemctl and schtasks.exe, both cached.
        automations.list().then(r => jsonResp(res, 200, r)).catch(e => jsonResp(res, 500, { error: e.message }));
        return;
    }

    function getAutomationsAlerts(req, res, pathname) {
        const { NOT_MINE, automations, jsonResp } = S;
        if (!(pathname === '/api/automations/alerts' && req.method === 'GET')) return NOT_MINE;
        // The tab button's red number: no process spawned, safe to poll.
        jsonResp(res, 200, { alerts: automations.alertCount() });
        return;
    }

    function postAutomations(req, res, pathname) {
        const { NOT_MINE, automations, jsonResp, readBody } = S;
        if (!(pathname.startsWith('/api/automations/') && req.method === 'POST')) return NOT_MINE;
        // /set { id, on } · /run { id } · /time { id, at: 'HH:MM' }
        // /create { title, at, days, kind: session|script, cwd, prompt, file } · /delete { id }
        const op = pathname.slice('/api/automations/'.length);
        readBody(req).then(async (raw) => {
            let p = {};
            try { p = JSON.parse(raw || '{}'); } catch { return jsonResp(res, 400, { error: 'bad JSON' }); }
            const id = String(p.id || '');
            let out;
            if (op === 'set') out = await automations.setEnabled(id, !!p.on);
            else if (op === 'run') out = await automations.runNow(id);
            else if (op === 'time') out = await automations.setTime(id, String(p.at || ''));
            else if (op === 'create') out = require('../customJobs').create(p);
            else if (op === 'delete') out = require('../customJobs').remove(id);
            else return jsonResp(res, 404, { error: 'unknown action' });
            if (out.ok) console.log(`[automations] ${op} ${id}${op === 'set' ? (p.on ? ' ON' : ' OFF') : ''}`);
            jsonResp(res, out.ok ? 200 : 400, out);
        }).catch(e => jsonResp(res, 500, { error: e.message }));
        return;
    }

    function getScheduler(req, res, pathname) {
        const { NOT_MINE, morningRoutine, scheduler } = S;
        if (!(pathname === '/api/scheduler' && req.method === 'GET')) return NOT_MINE;
        // Every job, plus what the morning routine did last time it ran.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobs: scheduler.list(), morning: morningRoutine.loadState() }));
        return;
    }

    function postSchedulerJob(req, res, pathname) {
        const { NOT_MINE, scheduler } = S;
        if (!(pathname === '/api/scheduler/job' && req.method === 'POST')) return NOT_MINE;
        // { name, at?: 'HH:MM', enabled?: bool, clearToday?: bool }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const p = JSON.parse(body || '{}');
                const name = String(p.name || '');
                let out = { ok: true };
                if (p.at !== undefined) out = scheduler.setTime(name, p.at);
                if (out.ok && p.enabled !== undefined) out = scheduler.setEnabled(name, !!p.enabled);
                if (out.ok && p.clearToday) out = scheduler.clearToday(name);
                res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(out.ok ? { ...out, job: scheduler.view(name) } : out));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postSchedulerRun(req, res, pathname) {
        const { NOT_MINE, morningRoutine, scheduler } = S;
        if (!(pathname === '/api/scheduler/run' && req.method === 'POST')) return NOT_MINE;
        // { name, dryRun?: bool } — run it now. Answers immediately: these jobs
        // take minutes (a headless Claude run plus session boots), and an HTTP
        // request that waits for that is a request that times out.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const p = JSON.parse(body || '{}');
                const name = String(p.name || '');
                if (!scheduler.view(name)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `unknown job: ${name}` }));
                    return;
                }
                if (name === 'morning-routine' && p.dryRun) {
                    // A dry run must not consume the day, so it bypasses the
                    // scheduler's bookkeeping and calls the routine directly.
                    setImmediate(() => morningRoutine.run({ manual: true, dryRun: true })
                        .catch(e => console.error('[morning] dry run failed:', e.message)));
                } else {
                    setImmediate(() => scheduler.runJob(name, { manual: true })
                        .catch(e => console.error(`[scheduler] ${name} failed:`, e.message)));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ started: true, name, dryRun: !!p.dryRun }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postMorningSpoken(req, res, pathname) {
        const { NOT_MINE, jsonResp, morningRoutine } = S;
        if (!(pathname === '/api/morning/spoken' && req.method === 'POST')) return NOT_MINE;
        // What to SAY, and in which voice. The written brief is English and the
        // House voice is Spanish, so the local model rewrites it first; when it
        // is not available this answers with the English text and lets the
        // caller use the default voice rather than failing.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const p = JSON.parse(body || '{}');
                const r = await morningRoutine.spokenBrief({ force: !!p.force });
                jsonResp(res, 200, r);
            } catch (e) {
                jsonResp(res, 400, { error: e.message });
            }
        });
        return;
    }

    function postMorningStop(req, res, pathname) {
        const { NOT_MINE, jsonResp, morningRoutine } = S;
        if (!(pathname === '/api/morning/stop' && req.method === 'POST')) return NOT_MINE;
        // The panel's [x] STOP: cancels the Claude question, or stops opening
        // more sessions (the ones already open stay open).
        const out = morningRoutine.stop();
        jsonResp(res, out.ok ? 200 : 400, out);
        return;
    }

    function postMorningOpen(req, res, pathname) {
        const { NOT_MINE, morningRoutine } = S;
        if (!(pathname === '/api/morning/open' && req.method === 'POST')) return NOT_MINE;
        // { sessions?: [name|project] } — open the sessions from the plan that is
        // ALREADY on disk. This is the "accept" the dry run never had: re-running
        // would spend another headless Claude job and could answer differently,
        // so what he approved is what opens. The validation is synchronous (there
        // is no plan / one is already running); the spawning is not.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const p = JSON.parse(body || '{}');
                const only = Array.isArray(p.sessions) ? p.sessions.map(s => String(s)) : null;
                const out = morningRoutine.startOpen({ only });
                res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: out.ok, error: out.error, started: !!out.started, planned: out.planned }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function getPushStatus(req, res, pathname) {
        const { NOT_MINE, push } = S;
        if (!(pathname === '/api/push/status' && req.method === 'GET')) return NOT_MINE;
        // The public half of the VAPID pair (the browser needs it to subscribe)
        // plus which devices are currently woken. No secret leaves here.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(push.status()));
        return;
    }

    function postPushSubscribe(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, jsonResp, push } = S;
        if (!((pathname === '/api/push/subscribe' || pathname === '/api/push/unsubscribe'
                || pathname === '/api/push/test') && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const p = JSON.parse(body || '{}');
                if (pathname === '/api/push/subscribe') {
                    return jsonResp(res, 200, push.subscribe(p.subscription, p.label));
                }
                if (pathname === '/api/push/unsubscribe') {
                    return jsonResp(res, 200, push.unsubscribe(String(p.endpoint || '')));
                }
                // A notification leaves this machine carrying real detail, so it
                // is a content egress. This check is the belt; the one that
                // matters is inside push.send(), where every caller passes.
                const title = String(p.title || 'TSRCT');
                const text = String(p.body || 'test notification');
                restrictedGuard.assertNotRestricted('push notification', title, text);
                const r = await push.send({ title, body: text, url: p.url || '/', tag: p.tag || 'tsrct-test' });
                return jsonResp(res, r.ok ? 200 : 503, r);
            } catch (e) {
                jsonResp(res, 400, { error: e.message });
            }
        });
        return;
    }

    function getRingStatus(req, res, pathname) {
        const { NOT_MINE, ring } = S;
        if (!(pathname === '/api/ring/status' && req.method === 'GET')) return NOT_MINE;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ring.status()));
        return;
    }

    function postRingStart(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, jsonResp, ring } = S;
        if (!((pathname === '/api/ring/start' || pathname === '/api/ring/ack'
                || pathname === '/api/ring/stop') && req.method === 'POST')) return NOT_MINE;
        // start -> ring the phone until it is answered (see lib/ring.js)
        // ack   -> "I picked up": the PWA calls this when it opens from the
        //          alert, and that is what makes it a call instead of an alarm
        // stop  -> hang up from the machine's side
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const p = JSON.parse(body || '{}');
                if (pathname === '/api/ring/ack') return jsonResp(res, 200, ring.ack(p.who));
                if (pathname === '/api/ring/stop') { ring.stop('stopped by hand'); return jsonResp(res, 200, { ok: true }); }
                const r = await ring.start({
                    title: p.title || 'TSRCT is calling',
                    body: p.body || 'Open TSRCT',
                    url: p.url || '/?speak=morning',
                    kind: p.kind || 'ring',
                    max: p.max,
                });
                return jsonResp(res, r.ok ? 200 : 503, r);
            } catch (e) {
                jsonResp(res, e instanceof restrictedGuard.RestrictedProjectError ? 403 : 400, { ok: false, error: e.message });
            }
        });
        return;
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        postSessionWeight,
        getSessionWeights,
        postSessionWeightSnooze,
        postSessionHandoff,
        getAutomations,
        getAutomationsAlerts,
        postAutomations,
        getScheduler,
        postSchedulerJob,
        postSchedulerRun,
        postMorningSpoken,
        postMorningStop,
        postMorningOpen,
        getPushStatus,
        postPushSubscribe,
        getRingStatus,
        postRingStart,
    ];

    return function apiSessionsJobs(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
