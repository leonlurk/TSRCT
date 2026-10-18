'use strict';
// terminal images.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time is read as S.<name>, never
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

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        getTermimg,
    ];

    return function apiMedia(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
