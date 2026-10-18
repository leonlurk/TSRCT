'use strict';
// Status, pane output, events, audit.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (TMUX_SESSION) is read as S.<name>, never
// copied, so a route never acts on a stale one.
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');

module.exports = (S) => {
    function routeStatus(req, res, pathname) {
        const { NOT_MINE, REMOTE_URL, detectProject, getLatestActivity, getRecentOutput, getSessionPwd, parseReqUrl, sendJson, sessionExists } = S;
        if (!(pathname === '/api/status')) return NOT_MINE;
        // Detect project for the requested session
        const urlObj = parseReqUrl(req.url);
        const targetSession = urlObj.query.session || S.TMUX_SESSION;
        const cwd = getSessionPwd(targetSession);
        const detectedProject = detectProject(cwd);
        // `output` is OPT-IN (`?output=1`). It used to ship unconditionally: a
        // full 1000-row pane capture, on an endpoint the 5s mobile poll hits
        // every cycle purely to read `sessionExists` + `project`. That was a
        // SECOND copy of a terminal the poller never renders -- measured at
        // 15-56 KB per call against live sessions, i.e. about half of the
        // ~39 MB/hour the phone spent with the app merely open.
        // The three callers that genuinely need it (first paint in connect(),
        // the no-session panel fallback, the restart splash) pass ?output=1.
        const body = {
            sessionExists: sessionExists(targetSession),
            latestActivity: getLatestActivity(),
            project: detectedProject || null,
            cwd: cwd,
            // The Tailscale hostname. The Cloudflare tunnel it replaced was deleted
            // 2026-09-22; the field keeps its old name so the PC sidebar is unchanged.
            tunnel: REMOTE_URL || null
        };
        if (urlObj.query.output === '1') body.output = getRecentOutput();
        sendJson(req, res, body);
    }

    function routeOutput(req, res, pathname) {
        const { NOT_MINE, parseReqUrl, sendJson, tmux } = S;
        if (!(pathname === '/api/output')) return NOT_MINE;
        // Get output from a specific tmux session
        const urlObj = parseReqUrl(req.url);
        const session = urlObj.query.session;
        let output = '';
        try {
            const targetSession = session || S.TMUX_SESSION;
            const safeName = targetSession.replace(/[^a-zA-Z0-9_-]/g, '');
            output = tmux(['capture-pane', '-t', safeName, '-p', '-S', '-1000']);
            // Claude's TUI runs in a tall (1000-row) window and bottom-anchors its
            // prompt, so a short conversation leaves huge blank regions — at the top,
            // in the middle (banner up top + prompt at bottom), or trailing. Collapse
            // any run of 2+ blank lines down to a single one and strip the leading /
            // trailing blanks, so the terminal is fully dynamic: it shows only the real
            // content, however much there is, growing toward 1000 as the transcript
            // fills. Normal single-line spacing between messages is preserved.
            output = output.replace(/[ \t]+$/gm, '');   // drop right-pad spaces
            const _src = output.split('\n');
            const _out = [];
            let _blank = 0;
            for (const _ln of _src) {
                if (_ln === '') { _blank++; if (_blank <= 1) _out.push(''); }
                else { _blank = 0; _out.push(_ln); }
            }
            while (_out.length && _out[0] === '') _out.shift();
            while (_out.length && _out[_out.length - 1] === '') _out.pop();
            output = _out.join('\n') + '\n';
        } catch (e) {
            output = 'Session not found or no output';
        }
        // sendJson, not res.end: this is the single biggest thing the phone
        // downloads. gzip takes a live capture from ~38 KB to ~13 KB, and an
        // UNCHANGED pane answers 304 with no body at all -- which is most polls,
        // because the 5s cadence far outruns how often the terminal actually
        // moves. fetch() revalidates and returns the cached body transparently,
        // so no caller changes.
        sendJson(req, res, { output, session: session || S.TMUX_SESSION });
    }

    function routeEvents(req, res, pathname) {
        const { NOT_MINE, getEvents, parseReqUrl } = S;
        if (!(pathname === '/api/events')) return NOT_MINE;
        const urlObj = parseReqUrl(req.url);
        const since = parseInt(urlObj.query.since) || 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: getEvents(since) }));
    }

    function routeAuditHistory(req, res, pathname) {
        const { NOT_MINE, fs, path } = S;
        if (!(pathname === '/api/audit/history')) return NOT_MINE;
        // Durable weekly security-audit history, parsed from logs/security-audit.log.
        // (The event queue is ephemeral/capped; this file survives restarts.)
        try {
            const logPath = path.join(ROOT_DIR, 'logs', 'security-audit.log');
            const exists = fs.existsSync(logPath);
            const entries = [];
            if (exists) {
                const lines = fs.readFileSync(logPath, 'utf8').split('\n');
                for (const line of lines) {
                    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
                    if (!m) continue;
                    const text = m[2];
                    if (!/vulnerabilit/i.test(text)) continue; // skip "posted"/"unreachable" bookkeeping
                    entries.push({ ts: m[1], text, ok: text.includes('[*]') });
                }
                entries.reverse(); // newest first
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ exists, entries: entries.slice(0, 100) }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    }

    function postAuditRun(req, res, pathname) {
        const { NOT_MINE, path, spawn } = S;
        if (!(pathname === '/api/audit/run' && req.method === 'POST')) return NOT_MINE;
        // On-demand security audit — runs scripts/weekly-audit.sh, responds when it finishes.
        const scriptPath = path.join(ROOT_DIR, 'scripts', 'weekly-audit.sh');
        try {
            const proc = spawn('bash', [scriptPath], { cwd: ROOT_DIR });
            let done = false;
            const finish = (code) => {
                if (done) return; done = true;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: code === 0, code }));
            };
            proc.on('close', finish);
            proc.on('error', (err) => {
                if (done) { return; } done = true;
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            });
            setTimeout(() => finish(-1), 60000); // safety cap so the request never hangs
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        routeStatus,
        routeOutput,
        routeEvents,
        routeAuditHistory,
        postAuditRun,
    ];

    return function apiStatusFeeds(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
