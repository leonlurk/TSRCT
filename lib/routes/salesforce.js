'use strict';
// Salesforce CLI: orgs and workspaces.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (none here) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    function getSfOrgs(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, sfRun } = S;
        if (!(pathname === '/api/sf/orgs' && req.method === 'GET')) return NOT_MINE;
        // List all authenticated SF orgs
        (async () => {
        try {
            const r = await sfRun(['org', 'list', '--json'], 30000);
            if (r.err) { r.err.stdout = r.stdout; throw r.err; }
            const data = JSON.parse(r.stdout);
            // SECRETCO: never list an SecretCo org. Same data-minimization posture as the
            // codemap session list -- if it is not offered, it cannot be picked, and
            // the UI has no path to authenticate or query it.
            if (data && data.result) {
                for (const k of ['nonScratchOrgs', 'scratchOrgs', 'sandboxes', 'devHubs', 'other']) {
                    if (Array.isArray(data.result[k])) {
                        data.result[k] = data.result[k].filter(o => !restrictedGuard.mentionsRestricted(
                            o && o.alias, o && o.username, o && o.instanceUrl
                        ));
                    }
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // Try to parse JSON from stderr/stdout even on non-zero exit
            try {
                const parsed = JSON.parse(e.stdout || e.stderr || '{}');
                res.end(JSON.stringify(parsed));
            } catch (_) {
                res.end(JSON.stringify({ error: e.message, result: { nonScratchOrgs: [], scratchOrgs: [] } }));
            }
        }
        })();
    }

    function getSfWorkspaces(req, res, pathname) {
        const { NOT_MINE, sfLoadWorkspaces } = S;
        if (!(pathname === '/api/sf/workspaces' && req.method === 'GET')) return NOT_MINE;
        // List workspaces
        const config = sfLoadWorkspaces();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
    }

    function postSfWorkspaces(req, res, pathname) {
        const { NOT_MINE, sfLoadWorkspaces, sfSaveWorkspaces } = S;
        if (!(pathname === '/api/sf/workspaces' && req.method === 'POST')) return NOT_MINE;
        // Create or update workspace
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const ws = JSON.parse(body);
                if (!ws.id || !ws.name) throw new Error('id and name required');
                const config = sfLoadWorkspaces();
                const idx = config.workspaces.findIndex(w => w.id === ws.id);
                const entry = {
                    id: ws.id,
                    name: ws.name,
                    theme: ws.theme || 'default',
                    projectPath: ws.projectPath || '',
                    orgs: ws.orgs || [],
                    soqlBookmarks: ws.soqlBookmarks || [],
                    extensions: ws.extensions || {}
                };
                if (idx >= 0) {
                    config.workspaces[idx] = entry;
                } else {
                    config.workspaces.push(entry);
                }
                sfSaveWorkspaces(config);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, workspace: entry }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function deleteSfWorkspaces(req, res, pathname) {
        const { NOT_MINE, sfLoadWorkspaces, sfSaveWorkspaces } = S;
        if (!(pathname.match(/^\/api\/sf\/workspaces\/([^/]+)$/) && req.method === 'DELETE')) return NOT_MINE;
        const wsId = decodeURIComponent(pathname.match(/^\/api\/sf\/workspaces\/([^/]+)$/)[1]);
        const config = sfLoadWorkspaces();
        config.workspaces = config.workspaces.filter(w => w.id !== wsId);
        sfSaveWorkspaces(config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    }

    function postSfWorkspaces2(req, res, pathname) {
        const { NOT_MINE, sfAlias, sfLoadWorkspaces, sfSaveWorkspaces } = S;
        if (!(pathname.match(/^\/api\/sf\/workspaces\/([^/]+)\/orgs$/) && req.method === 'POST')) return NOT_MINE;
        // Add org to workspace
        const wsId = decodeURIComponent(pathname.match(/^\/api\/sf\/workspaces\/([^/]+)\/orgs$/)[1]);
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { alias: rawAlias } = JSON.parse(body);
                if (!rawAlias) throw new Error('alias required');
                const alias = sfAlias(res, rawAlias, 'workspace add-org');
                if (!alias) return;
                const config = sfLoadWorkspaces();
                const ws = config.workspaces.find(w => w.id === wsId);
                if (!ws) throw new Error('workspace not found');
                if (!ws.orgs.includes(alias)) ws.orgs.push(alias);
                sfSaveWorkspaces(config);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, orgs: ws.orgs }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function deleteSfWorkspaces2(req, res, pathname) {
        const { NOT_MINE, sfLoadWorkspaces, sfSaveWorkspaces } = S;
        if (!(pathname.match(/^\/api\/sf\/workspaces\/([^/]+)\/orgs\/([^/]+)$/) && req.method === 'DELETE')) return NOT_MINE;
        // Remove org from workspace
        const m = pathname.match(/^\/api\/sf\/workspaces\/([^/]+)\/orgs\/([^/]+)$/);
        const wsId = decodeURIComponent(m[1]);
        const alias = decodeURIComponent(m[2]);
        const config = sfLoadWorkspaces();
        const ws = config.workspaces.find(w => w.id === wsId);
        if (ws) {
            ws.orgs = ws.orgs.filter(o => o !== alias);
            sfSaveWorkspaces(config);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    }

    function postSfQuery(req, res, pathname) {
        const { NOT_MINE, sfAlias, sfRun } = S;
        if (!(pathname === '/api/sf/query' && req.method === 'POST')) return NOT_MINE;
        // SOQL query
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { alias, query } = JSON.parse(body);
                if (!alias || !query) throw new Error('alias and query required');
                // Sanitize + SecretCo contract (responds 403 and returns null)
                const safeAlias = sfAlias(res, alias, 'query');
                if (!safeAlias) return;
                const r = await sfRun(['data', 'query', '-o', safeAlias, '-q', query, '--json'], 120000);
                if (r.err) { r.err.stdout = r.stdout; throw r.err; }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(r.stdout);
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                try {
                    res.end(e.stdout || e.stderr || JSON.stringify({ error: e.message }));
                } catch (_) {
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
    }

    function postSfApexRun(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, crypto, fs, resolveWithinProjects, sfAlias, sfRun } = S;
        if (!(pathname === '/api/sf/apex/run' && req.method === 'POST')) return NOT_MINE;
        // Apex execute
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { alias, code, filePath } = JSON.parse(body);
                if (!alias) throw new Error('alias required');
                const safeAlias = sfAlias(res, alias, 'apex run');
                if (!safeAlias) return;
                let apexFile;
                let tempFile = null;
                if (filePath) {
                    // Run from a file on disk. `sf apex run -f` sends the file's
                    // CONTENTS to the org, so an uncontained path here is an
                    // arbitrary file read exfiltrated into Salesforce. Confine it.
                    apexFile = resolveWithinProjects(filePath);
                    if (!apexFile) throw new Error('filePath must be inside PROJECTS');
                    restrictedGuard.assertNotRestricted('sf apex run', apexFile);
                } else if (code) {
                    // Run inline apex via a temp file. These used to be left behind
                    // in /tmp forever, accumulating Apex source; the finally below
                    // removes it on every path including the error one.
                    tempFile = apexFile = `/tmp/sf_apex_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.apex`;
                    fs.writeFileSync(apexFile, code, { mode: 0o600 });
                } else {
                    throw new Error('code or filePath required');
                }
                let out;
                try {
                    const r = await sfRun(['apex', 'run', '-o', safeAlias, '-f', apexFile, '--json'], 120000);
                    if (r.err) { r.err.stdout = r.stdout; throw r.err; }
                    out = r.stdout;
                } finally {
                    if (tempFile) { try { fs.unlinkSync(tempFile); } catch {} }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(out);
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                try {
                    res.end(e.stdout || e.stderr || JSON.stringify({ error: e.message }));
                } catch (_) {
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
        });
    }

    function getSfOrg(req, res, pathname) {
        const { NOT_MINE, sfAlias, sfRun } = S;
        if (!(pathname.match(/^\/api\/sf\/org\/([^/]+)\/health$/) && req.method === 'GET')) return NOT_MINE;
        // Org health check
        const alias = sfAlias(res, decodeURIComponent(pathname.match(/^\/api\/sf\/org\/([^/]+)\/health$/)[1]), 'org health');
        if (!alias) return;
        (async () => {
        try {
            const r = await sfRun(['org', 'display', '-o', alias, '--json'], 15000);
            if (r.err) throw r.err;
            const data = JSON.parse(r.stdout);
            const connected = data.result && data.result.connectedStatus === 'Connected';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ alias, connected, details: data.result || {} }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ alias, connected: false, error: e.message }));
        }
        })();
    }

    function postSfOrg(req, res, pathname) {
        const { NOT_MINE, sfAlias, sfRun } = S;
        if (!(pathname.match(/^\/api\/sf\/org\/([^/]+)\/open$/) && req.method === 'POST')) return NOT_MINE;
        // Open org in browser (returns URL)
        const alias = sfAlias(res, decodeURIComponent(pathname.match(/^\/api\/sf\/org\/([^/]+)\/open$/)[1]), 'org open');
        if (!alias) return;
        (async () => {
        try {
            const r = await sfRun(['org', 'open', '-o', alias, '--url-only', '--json'], 15000);
            if (r.err) throw r.err;
            const data = JSON.parse(r.stdout);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, url: data.result?.url || data.result }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        })();
    }

    function postSfOrg2(req, res, pathname) {
        const { NOT_MINE, sfAlias, spawn } = S;
        if (!(pathname.match(/^\/api\/sf\/org\/([^/]+)\/login$/) && req.method === 'POST')) return NOT_MINE;
        // Login org via browser OAuth (non-blocking spawn)
        const alias = sfAlias(res, decodeURIComponent(pathname.match(/^\/api\/sf\/org\/([^/]+)\/login$/)[1]), 'org login');
        if (!alias) return;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const opts = body ? JSON.parse(body) : {};
                // --browser chrome: `sf org login web` ignores $BROWSER. It opens the URL
                // through PowerShell `Start`, which asks Windows for the default browser,
                // and that answer came back Edge (2026-09-21) even though the registry
                // says ChromeHTML. Naming the browser skips that lookup.
                const args = ['org', 'login', 'web', '--alias', alias, '--browser', 'chrome'];
                if (opts.instanceUrl) {
                    let iu = String(opts.instanceUrl).trim();
                    if (iu && !/^https?:\/\//i.test(iu)) iu = 'https://' + iu;
                    args.push('-r', iu);
                }

                const browserBin = process.env.BROWSER
                    || `${process.env.HOME || ''}/.local/bin/wslopen`;
                console.log(`[sf-login] alias=${alias} args=${JSON.stringify(args)} BROWSER=${browserBin}`);

                const child = spawn('sf', args, {
                    cwd: process.env.HOME || '/tmp',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, BROWSER: browserBin }
                });
                child.stdout.on('data', d => console.log(`[sf-login:${alias}] ${d.toString().trim()}`));
                child.stderr.on('data', d => console.log(`[sf-login:${alias}:err] ${d.toString().trim()}`));
                child.on('error', err => console.log(`[sf-login:${alias}:spawn-error] ${err.message}`));
                child.on('exit', (code, sig) => console.log(`[sf-login:${alias}:exit] code=${code} sig=${sig}`));

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: `Login started for ${alias} - browser should open` }));
            } catch (e) {
                console.log(`[sf-login:error] ${e.message}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        getSfOrgs,
        getSfWorkspaces,
        postSfWorkspaces,
        deleteSfWorkspaces,
        postSfWorkspaces2,
        deleteSfWorkspaces2,
        postSfQuery,
        postSfApexRun,
        getSfOrg,
        postSfOrg,
        postSfOrg2,
    ];

    return function apiSalesforce(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
