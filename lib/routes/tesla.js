'use strict';
// Tesla: actions, talk, presence, TTS.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (none here) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    function getActions(req, res, pathname, isAppCall) {
        const { NOT_MINE, actions } = S;
        if (!(pathname === '/api/actions' && req.method === 'GET')) return NOT_MINE;
        // The catalogue, as the model sees it: names and plain words, nothing
        // that could be addressed directly. Also what a future MCP server would
        // publish, which is why it is a route and not an internal call.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ actions: actions.manifest() }));
        return;
    }

    function postActionsRun(req, res, pathname, isAppCall) {
        const { NOT_MINE, actions, restrictedGuard, jsonResp } = S;
        if (!(pathname === '/api/actions/run' && req.method === 'POST')) return NOT_MINE;
        // { action, args, confirm } — the same gate the spoken path uses, so a
        // button, a voice and a future agent all go through ONE validation.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const p = JSON.parse(body || '{}');
                const r = await actions.run(p.action, p.args || {}, { confirmed: !!p.confirm });
                return jsonResp(res, 200, r);
            } catch (e) {
                jsonResp(res, e instanceof restrictedGuard.RestrictedProjectError ? 403 : 400, { ok: false, error: e.message });
            }
        });
        return;
    }

    function postTalkJob(req, res, pathname, isAppCall) {
        const { NOT_MINE, restrictedGuard, jsonResp, promptWriter, talk } = S;
        if (!(pathname === '/api/talk/job' && req.method === 'POST')) return NOT_MINE;
        // His tap on a plan waiting in the orb's panel: [open] is the yes, [x]
        // drops it. The key is the only input - the folder, the session name and
        // the prompt all come from the plan the research left, never from here.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const p = JSON.parse(body || '{}');
                const key = String(p.key || '');
                if (p.op === 'drop') return jsonResp(res, 200, { ok: promptWriter.drop(key) });
                if (p.op !== 'start') return jsonResp(res, 400, { ok: false, error: 'op must be start or drop' });
                const r = await promptWriter.startTask(key);
                talk.announce(`Listo: ${r.session} esta trabajando en ${r.isNew ? `la carpeta nueva ${r.project}` : r.project}.`);
                jsonResp(res, 200, r);
            } catch (e) {
                jsonResp(res, e instanceof restrictedGuard.RestrictedProjectError ? 403 : 400, { ok: false, error: e.message });
            }
        });
        return;
    }

    function getTalkJobs(req, res, pathname, isAppCall) {
        const { NOT_MINE, parseReqUrl, talk } = S;
        if (!(pathname === '/api/talk/jobs' && req.method === 'GET')) return NOT_MINE;
        // The orb's slow poll while no conversation is on: background work and
        // what it announced. Cheap and synchronous, like status.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(talk.jobsStatus({ since: parseReqUrl(req.url).query.since })));
        return;
    }

    function getTalkStatus(req, res, pathname, isAppCall) {
        const { NOT_MINE, parseReqUrl, talk } = S;
        if (!(pathname === '/api/talk/status' && req.method === 'GET')) return NOT_MINE;
        // Cheap and synchronous: no Ollama call, nothing loaded. The panel polls
        // this, and polling must never be the thing that warms a model.
        // ?since=<id> also drains the spool: the lines the watcher wants SAID
        // when a session finishes a turn ride back on this same poll.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(talk.status({ since: parseReqUrl(req.url).query.since, client: isAppCall ? 'runner' : 'screen' })));
        return;
    }

    function postMorningOffer(req, res, pathname, isAppCall) {
        const { NOT_MINE, jsonResp, morningRoutine, talk } = S;
        if (!(pathname === '/api/morning/offer' && req.method === 'POST')) return NOT_MINE;
        // The end of the six o'clock call. The brief has just been read to him
        // over Piper (CPU, no model), and instead of the silence that used to
        // follow, the assistant offers the board the brief proposed and waits
        // for a yes. It is the ONLY place anything speaks first, it can only
        // offer an action from the catalogue, and it runs nothing: his "dale"
        // goes through the same confirmation as everything else.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const st = morningRoutine.loadState() || {};
                if (!st.plannedSessions || !st.plannedSessions.length) {
                    return jsonResp(res, 200, { ok: false, why: 'that plan names no sessions' });
                }
                jsonResp(res, 200, talk.propose('open_morning', {}));
            } catch (e) { jsonResp(res, 400, { ok: false, error: e.message }); }
        });
        return;
    }

    function postTalkDid(req, res, pathname, isAppCall) {
        const { NOT_MINE, jsonResp, teslaLog, uiActions } = S;
        if (!(pathname === '/api/talk/did' && req.method === 'POST')) return NOT_MINE;
        // The page reporting a button it was asked to press. A success is
        // silent — he watched it happen; a failure is SPOKEN, because the
        // assistant has already told him it was done.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const p = JSON.parse(body || '{}');
                if (p.ok === false) teslaLog.ui('press-failed', `${p.id}: ${p.why || ''}`);
                jsonResp(res, 200, uiActions.report(p.id, p.ok !== false, p.why));
            } catch (e) { jsonResp(res, 400, { ok: false, error: e.message }); }
        });
        return;
    }

    function postPresenceBeat(req, res, pathname, isAppCall) {
        const { NOT_MINE, jsonResp } = S;
        if (!(pathname === '/api/presence/beat' && req.method === 'POST')) return NOT_MINE;
        // A TSRCT window is visible: one "Leon was watching" minute for Hours
        // Recall (lib/presence.js). No body, nothing stored but the minute.
        req.resume();
        jsonResp(res, 200, require('../presence').beat());
        return;
    }

    function postTalkEvent(req, res, pathname, isAppCall) {
        const { NOT_MINE, jsonResp, talk, teslaLog } = S;
        if (!(pathname === '/api/talk/event' && req.method === 'POST')) return NOT_MINE;
        // What happened in the orb that the server cannot see (he cut it off,
        // asked for a repeat, the mic failed), for lib/teslaLog.js. Allowlisted
        // kinds only; anything else is dropped without an error.
        let body = '';
        req.on('data', chunk => { if (body.length < 8192) body += chunk; });
        req.on('end', () => {
            try {
                const p = JSON.parse(body || '{}');
                // A sentence the orb lost also goes to the next turn, so the
                // brain can pick up what it cut off (lib/talk.js noteLost). Only
                // the ones the page marks `lost`: "heard while it was speaking"
                // is as often its own voice coming back through the mic.
                if (p.kind === 'dropped' && p.data && p.data.lost === true && typeof talk.noteLost === 'function') talk.noteLost(p.detail);
                jsonResp(res, 200, { ok: !!teslaLog.ui(String(p.kind || ''), p.detail, p.data) });
            } catch (e) { jsonResp(res, 400, { ok: false, error: e.message }); }
        });
        return;
    }

    function postTalkOpen(req, res, pathname, isAppCall) {
        const { NOT_MINE, restrictedGuard, jsonResp, talk } = S;
        if (!((pathname === '/api/talk/open' || pathname === '/api/talk/ask'
                || pathname === '/api/talk/attach' || pathname === '/api/talk/close') && req.method === 'POST')) return NOT_MINE;
        // open   -> may the model be loaded right now, and is it already?
        // attach -> point it at a tmux session (and set the two switches:
        //           does his voice also go into that session, does it narrate
        //           finished turns by itself) without reopening anything.
        // ask    -> one turn. The reply comes back as TEXT; the panel then asks
        //           /api/tts/say for the audio, so the voice has exactly one
        //           implementation and one cache for the brief and for TALK.
        // close  -> give the memory back immediately, and stop watching.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const p = JSON.parse(body || '{}');
                if (pathname === '/api/talk/open') {
                    return jsonResp(res, 200, await talk.open({ session: p.session, watch: p.watch, toClaude: p.toClaude, live: p.live, light: !!p.light }));
                }
                if (pathname === '/api/talk/attach') {
                    return jsonResp(res, 200, talk.attach({ session: p.session, watch: p.watch, toClaude: p.toClaude, live: p.live }));
                }
                if (pathname === '/api/talk/close') return jsonResp(res, 200, await talk.close({ reason: p.reason }));
                const r = await talk.ask({ text: p.text, session: p.session, toClaude: p.toClaude, files: p.files, via: p.via === 'typed' ? 'typed' : 'voice', from: isAppCall ? 'runner' : (p.where === 'vr' ? 'vr' : '') });
                return jsonResp(res, r.ok ? 200 : 200, r);   // a refusal is an answer, not an HTTP error
            } catch (e) {
                jsonResp(res, e instanceof restrictedGuard.RestrictedProjectError ? 403 : 400, { ok: false, why: e.message });
            }
        });
        return;
    }

    function getTtsStatus(req, res, pathname, isAppCall) {
        const { NOT_MINE, tts } = S;
        if (!(pathname === '/api/tts/status' && req.method === 'GET')) return NOT_MINE;
        // What the voice can do right now, and if it cannot, WHY — the frontend
        // uses the reason to decide between "install it" and "fall back to the
        // browser's own voice".
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tts.status()));
        return;
    }

    function postTtsSay(req, res, pathname, isAppCall) {
        const { NOT_MINE, restrictedGuard, fs, speech, tts } = S;
        if (!(pathname === '/api/tts/say' && req.method === 'POST')) return NOT_MINE;
        // { text, voice? } -> audio/wav. CPU only: Piper never touches the card,
        // which is the entire reason it is here and not XTTS.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const p = JSON.parse(body || '{}');
                // SECRETCO: the WAV is an HTTP response carrying the text, so this
                // is an egress point like any other. Same treatment as the
                // hermes and voice-corpus paths: guard the CONTENT, fail closed.
                restrictedGuard.assertNotRestricted('text to speech', String(p.text || ''));
                // How it is READ, which is not how it is written: "tsrct" is
                // said teseract, 18:29 is "las seis y media", and a full path is
                // the file at the end of it. Only the voice sees this — the
                // subtitle and the log keep the real spelling.
                const r = await tts.say({ text: speech.forVoice(p.text, p.voice), voice: p.voice });
                if (!r.ok) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: r.error }));
                }
                const wav = fs.readFileSync(r.file);
                res.writeHead(200, {
                    'Content-Type': 'audio/wav',
                    'Content-Length': wav.length,
                    'X-TTS-Voice': r.voice,
                    'X-TTS-Cached': r.cached ? '1' : '0',
                    'Cache-Control': 'no-store',
                });
                res.end(wav);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        getActions,
        postActionsRun,
        postTalkJob,
        getTalkJobs,
        getTalkStatus,
        postMorningOffer,
        postTalkDid,
        postPresenceBeat,
        postTalkEvent,
        postTalkOpen,
        getTtsStatus,
        postTtsSay,
    ];

    return function apiTesla(req, res, pathname, isAppCall) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname, isAppCall);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
