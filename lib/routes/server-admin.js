'use strict';
// Vault reset and server restart.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (TMUX_SESSION) is read as S.<name>, never
// copied, so a route never acts on a stale one.
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');

module.exports = (S) => {
    // ═══════════════════════════════════════════════════════════════════
    // END OF HANDS-FREE API ENDPOINTS
    // ═══════════════════════════════════════════════════════════════════

    // Reset vault cycle for a session
    function postVaultReset(req, res, pathname) {
        const { NOT_MINE, vaultHeaderSentTo } = S;
        if (!(pathname === '/api/vault/reset' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session } = JSON.parse(body);
                const target = session || S.TMUX_SESSION;
                vaultHeaderSentTo.delete(target);
                console.log(`[VAULT] Cycle reset for session: ${target}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, session: target }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }


    // Remote restart. Body {splash:true} + a LOCAL (non-tunnel) caller with the
    // Windows launcher present -> hand off to launch-tsrct.ps1 so Leon's branded
    // native splash tracks the REAL boot and opens a fresh app window ('relaunch').
    // Otherwise (mobile/remote, or no launcher) -> plain in-place re-spawn.
    function postRestart(req, res, pathname) {
        const { NOT_MINE, findPowershell, fs, isRemoteRequest, path, toWindowsPath } = S;
        if (!(pathname === '/api/restart' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
            let wantSplash = false;
            try { wantSplash = !!JSON.parse(body || '{}').splash; } catch (e) {}
            const launcherUnix = path.join(ROOT_DIR, 'launch-tsrct.ps1');
            // psBin must be resolved BEFORE committing to 'relaunch': if PowerShell
            // cannot be found we must fall back to a plain respawn, because this
            // process exits either way and a failed hand-off leaves TSRCT down.
            const psBin = findPowershell();
            const winLauncher = (wantSplash && !isRemoteRequest(req) && psBin && fs.existsSync(launcherUnix))
                ? toWindowsPath(launcherUnix) : null;
            const mode = winLauncher ? 'relaunch' : 'respawn';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, mode }));
            console.log(`[SERVER] Remote restart requested (mode=${mode}).`);
            setTimeout(() => {
                const { spawn: sp } = require('child_process');
                // Plain re-spawn with a small startup delay so the port frees first.
                const respawn = () => {
                    const child = sp('sh', ['-c', `sleep 1 && ${process.argv[0]} ${process.argv.slice(1).join(' ')}`], {
                        detached: true, stdio: 'inherit', cwd: ROOT_DIR
                    });
                    child.unref();
                };
                if (winLauncher) {
                    // The launcher's idempotency check ("already online?") would just
                    // flash if it saw THIS process still on the port — so the detached
                    // PowerShell first waits for the port to CLOSE (we exit below),
                    // then runs the launcher, which reboots the server + shows the splash.
                    // Run the launcher through Start-Process, never directly. Spawned
                    // directly, WSL keeps an /init wrapper alive for as long as the
                    // server the launcher starts is running — one leftover per
                    // restart, six found on 2026-09-22 (and reproduced). Start-Process
                    // gives it its own process, so this outer PowerShell exits at once.
                    // -File plus a switch, NEVER -EncodedCommand or an inline script:
                    // the encoded form was quarantined by Defender as
                    // Trojan:Win32/Commando.A!ml the first time it ran (2026-09-22).
                    // The wait for the port lives in the launcher (-WaitPortFree).
                    const outer = `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${winLauncher}"','-WaitPortFree'`;
                    try {
                        const child = sp(psBin, ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', outer], {
                            detached: true, stdio: 'ignore'
                        });
                        child.on('error', () => {}); // async; the existsSync check above is the real guard
                        child.unref();
                    } catch (e) {
                        console.log('[SERVER] launcher hand-off failed, falling back to respawn.');
                        respawn();
                    }
                } else {
                    respawn();
                }
                // Kill this process so the port is freed before the new one binds.
                process.exit(0);
            }, 300);
        });
        return;
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        postVaultReset,
        postRestart,
    ];

    return function apiServerAdmin(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
