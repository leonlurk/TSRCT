'use strict';
// routes handed to the dispatcher and NULL, and /images/.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (dispatcher) is read as S.<name>, never
// copied, so a route never acts on a stale one.
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');

module.exports = (S) => {
    // ═══════════════════════════════════════════════════════════════════
    // DISPATCHER API (Phase 1)
    // ═══════════════════════════════════════════════════════════════════
    function anyDispatcher(req, res, pathname) {
        const { NOT_MINE, handleDispatcherRoute } = S;
        if (!(S.dispatcher && (pathname.startsWith('/api/dispatcher/') || pathname.startsWith('/api/tower/') || pathname === '/api/webhook/clickup'))) return NOT_MINE;
        handleDispatcherRoute(req, res, pathname).catch(err => {
            if (!res.writableEnded) {
                res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            console.error('[dispatcher] route error:', err.message);
        });
        return;
    }


    // ═══════════════════════════════════════════════════════════════════
    // NULL ENGINE (LURK mode) — /api/null/tts, /chat, /lines, /power
    // ═══════════════════════════════════════════════════════════════════
    function anyNull(req, res, pathname) {
        const { NOT_MINE, handleNullRoute } = S;
        if (!(pathname.startsWith('/api/null/'))) return NOT_MINE;
        handleNullRoute(req, res, pathname).catch(err => {
            if (!res.writableEnded) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            console.error('[null] route error:', err.message);
        });
        return;
    }


    // Serve uploaded images (no auth - browser img tags can't send headers)
    function getRoute(req, res, pathname) {
        const { NOT_MINE, UPLOADS_IMAGES, fs, path } = S;
        if (!(pathname.startsWith('/images/') && req.method === 'GET')) return NOT_MINE;
        const filename = decodeURIComponent(pathname.substring(8)); // Remove '/images/'
        // Security: only allow image files, prevent path traversal
        if (!/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(filename) || filename.includes('..') || filename.includes('/')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }

        // Check centralized images dir first, then the repo dir for legacy uploads.
        // SECURITY: this route is PUBLIC (no auth -- <img> tags cannot send headers).
        // The legacy fallback used to be `process.cwd()`, which POST /api/cwd can
        // move anywhere, so an authorized chdir turned this into an unauthenticated
        // read of any image-named file on the box. __dirname is fixed at boot and is
        // what cwd actually was when the legacy uploads were written. Audit 2026-08-14.
        let filepath = path.join(UPLOADS_IMAGES, filename);
        if (!fs.existsSync(filepath)) {
            filepath = path.join(ROOT_DIR, filename);
        }
        if (!fs.existsSync(filepath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        const ext = path.extname(filename).toLowerCase();
        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp'
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const imageData = fs.readFileSync(filepath);

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': imageData.length,
            'Cache-Control': 'public, max-age=86400' // Cache for 1 day
        });
        res.end(imageData);
        return;
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        anyDispatcher,
        anyNull,
        getRoute,
    ];

    return function apiDelegated(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
