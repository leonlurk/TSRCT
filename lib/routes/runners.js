'use strict';
// Runners, and git rollback.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (none here) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    function getRunnerList(req, res, pathname) {
        const { NOT_MINE, TMUX_TIMEOUT_MS, execSync } = S;
        if (!(pathname === '/api/runner/list' && req.method === 'GET')) return NOT_MINE;
        // List all runner sessions (those starting with "run-")
        try {
            const output = execSync('tmux list-sessions -F "#{session_name}"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: TMUX_TIMEOUT_MS });
            const sessions = output.trim().split('\n')
                .filter(name => name.startsWith('run-'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessions }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessions: [] }));
        }
        return;
    }

    function getRunnerBrowse(req, res, pathname) {
        const { NOT_MINE, execSync, fs, parseReqUrl, path } = S;
        if (!(pathname === '/api/runner/browse' && req.method === 'GET')) return NOT_MINE;
        // Browse directories for runner
        const urlObj = parseReqUrl(req.url);
        let dir = urlObj.query.dir || '~';

        try {
            // Expand ~ to home directory (try multiple methods for WSL compatibility)
            let homeDir = process.env.HOME || process.env.USERPROFILE || '/home';

            // On WSL, try to get the Linux home
            if (dir === '~' || dir.startsWith('~/')) {
                try {
                    homeDir = execSync('echo $HOME', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                } catch (e) {
                    // Fallback to process.env
                }
            }

            const expandedDir = dir.replace(/^~/, homeDir);
            const resolvedDir = path.resolve(expandedDir);

            // Check if directory exists
            if (!fs.existsSync(resolvedDir)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    current: homeDir,
                    parent: path.dirname(homeDir),
                    directories: [],
                    error: 'Directory not found, showing home'
                }));
                return;
            }

            // Get directory contents
            const items = fs.readdirSync(resolvedDir, { withFileTypes: true });

            const directories = items
                .filter(item => {
                    try {
                        return item.isDirectory() && !item.name.startsWith('.');
                    } catch (e) {
                        return false;
                    }
                })
                .map(item => ({
                    name: item.name,
                    path: path.join(resolvedDir, item.name)
                }))
                .sort((a, b) => a.name.localeCompare(b.name))
                .slice(0, 50); // Limit to 50 items

            // Get parent directory
            const parent = path.dirname(resolvedDir);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                current: resolvedDir,
                parent: parent !== resolvedDir ? parent : null,
                directories
            }));
        } catch (e) {
            // Fallback: try current working directory
            const cwd = process.cwd();
            try {
                const items = fs.readdirSync(cwd, { withFileTypes: true });
                const directories = items
                    .filter(item => item.isDirectory() && !item.name.startsWith('.'))
                    .map(item => ({ name: item.name, path: path.join(cwd, item.name) }))
                    .slice(0, 50);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    current: cwd,
                    parent: path.dirname(cwd),
                    directories,
                    note: 'Showing current directory'
                }));
            } catch (e2) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    current: '/',
                    parent: null,
                    directories: [],
                    error: e.message
                }));
            }
        }
        return;
    }

    function postRunnerStart(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, sessionEnvArgs, tmux } = S;
        if (!(pathname === '/api/runner/start' && req.method === 'POST')) return NOT_MINE;
        // Start a new runner session (mini terminal)
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session, cwd } = JSON.parse(body);

                if (!session) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Session name required' }));
                    return;
                }

                // SECRETCO: a runner is an interactive shell in an arbitrary cwd under the
                // SHARED $HOME, so an SecretCo working directory puts a non-Bedrock `claude`
                // one command away. /api/hf/start has been guarded since it was written;
                // this is its unguarded twin. (Audit 2026-08-15.)
                if (restrictedGuard.mentionsRestricted(session, cwd)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: new restrictedGuard.RestrictedProjectError('runner').message,
                        code: 'RESTRICTED_PROJECT',
                    }));
                    return;
                }
                const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, '');
                const safeCwd = (cwd || '~').replace(/"/g, '\\"').replace(/^~/, process.env.HOME || '/home');

                // Kill existing session if any
                try {
                    tmux(['kill-session', '-t', safeSession], { soft: true });
                } catch (e) {}

                // Create new session at directory (no command - user controls it)
                try {
                    tmux(['new-session', '-d', '-s', safeSession, '-c', safeCwd, ...sessionEnvArgs(safeSession)]);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, session: safeSession }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to start: ' + e.message }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postRunnerSend(req, res, pathname) {
        const { NOT_MINE, tmux } = S;
        if (!(pathname === '/api/runner/send' && req.method === 'POST')) return NOT_MINE;
        // Send a command or control key to the runner session
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session, cmd, ctrl } = JSON.parse(body);
                const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, '');

                try {
                    if (ctrl) {
                        // Send control key (e.g., C-c for Ctrl+C)
                        const safeKey = ctrl.replace(/[^a-z]/gi, '');
                        tmux(['send-keys', '-t', safeSession, `C-${safeKey}`]);
                    } else if (cmd) {
                        // Send regular command
                        tmux(['send-keys', '-t', safeSession, cmd, 'Enter']);
                    } else {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Command or ctrl key required' }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to send: ' + e.message }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postRunnerSendKey(req, res, pathname) {
        const { NOT_MINE, tmux } = S;
        if (!(pathname === '/api/runner/send-key' && req.method === 'POST')) return NOT_MINE;
        // Send a special key (arrows, PgUp, etc.) to the runner session
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session, key } = JSON.parse(body);
                const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, '');

                try {
                    // tmux key names for special keys
                    tmux(['send-keys', '-t', safeSession, ...String(key).trim().split(/\s+/)]);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to send key: ' + e.message }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postRunnerSendChar(req, res, pathname) {
        const { NOT_MINE, tmux } = S;
        if (!(pathname === '/api/runner/send-char' && req.method === 'POST')) return NOT_MINE;
        // Send a single character to the runner session (for nano typing)
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session, char } = JSON.parse(body);
                const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, '');

                try {
                    tmux(['send-keys', '-t', safeSession, '-l', char]);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to send char: ' + e.message }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postRunnerSendText(req, res, pathname) {
        const { NOT_MINE, fs, path, tmux } = S;
        if (!(pathname === '/api/runner/send-text' && req.method === 'POST')) return NOT_MINE;
        // Send text (for paste) to the runner session - line by line with Enter
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session, text } = JSON.parse(body);
                const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, '');

                try {
                    // Normalize line endings and remove ALL carriage returns
                    const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '');

                    // Use tmux buffer method - more reliable for special characters
                    const fs = require('fs');
                    const os = require('os');
                    const path = require('path');

                    // Write to temp file
                    const tmpFile = path.join(os.tmpdir(), `tmux-bulk-${Date.now()}.txt`);
                    fs.writeFileSync(tmpFile, cleanText, 'utf8');

                    // Load into tmux buffer and paste
                    tmux(['load-buffer', '-b', 'bulk', tmpFile]);
                    tmux(['paste-buffer', '-b', 'bulk', '-t', safeSession]);
                    tmux(['delete-buffer', '-b', 'bulk']);

                    // Clean up temp file
                    fs.unlinkSync(tmpFile);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to send text: ' + e.message }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postRunnerReadFile(req, res, pathname) {
        const { NOT_MINE, tmux } = S;
        if (!(pathname === '/api/runner/read-file' && req.method === 'POST')) return NOT_MINE;
        // Capture screen content from tmux (works even inside nano)
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session } = JSON.parse(body);
                const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, '');

                try {
                    // Capture entire pane content (including scrollback)
                    let output = tmux(['capture-pane', '-t', safeSession, '-p', '-S', '-']);

                    // Check if this looks like nano output
                    const lines = output.split('\n');
                    let content = output;

                    // Detect nano: first line usually has "GNU nano" or "nano X.X"
                    // Last lines have the help bar with ^G ^O ^W etc.
                    const firstLine = lines[0] || '';
                    const isNano = firstLine.includes('GNU nano') || firstLine.includes('nano ');

                    if (isNano) {
                        // Strip nano UI elements
                        // Find where content starts (after the header line with filename)
                        // Find where content ends (before the status/help lines)
                        let startIdx = 1; // Skip the "GNU nano X.X filename" header
                        let endIdx = lines.length;

                        // Find the footer (lines with ^G Help, ^X Exit, etc.)
                        for (let i = lines.length - 1; i >= 0; i--) {
                            const line = lines[i];
                            if (line.includes('^G') && line.includes('^O') && line.includes('^X')) {
                                endIdx = i;
                                break;
                            }
                            // Also check for the shortcut bar at bottom
                            if (line.includes('Help') && line.includes('Exit') && line.includes('Save')) {
                                endIdx = i;
                                break;
                            }
                        }

                        // Also skip any status line right before footer (like "[ Read X lines ]")
                        if (endIdx > 0) {
                            const statusLine = lines[endIdx - 1] || '';
                            if (statusLine.match(/^\[.*\]$/) || statusLine.includes('Read') && statusLine.includes('lines')) {
                                endIdx--;
                            }
                        }

                        // Extract content
                        content = lines.slice(startIdx, endIdx).join('\n').trimEnd();
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, content }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to capture screen: ' + e.message }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postRunnerStop(req, res, pathname) {
        const { NOT_MINE, tmux } = S;
        if (!(pathname === '/api/runner/stop' && req.method === 'POST')) return NOT_MINE;
        // Send Ctrl+C to stop the runner process
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session } = JSON.parse(body);
                const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, '');

                try {
                    tmux(['send-keys', '-t', safeSession, 'C-c']);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to stop: ' + e.message }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postRunnerKill(req, res, pathname) {
        const { NOT_MINE, tmux } = S;
        if (!(pathname === '/api/runner/kill' && req.method === 'POST')) return NOT_MINE;
        // Kill the runner session completely
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { session } = JSON.parse(body);
                const safeSession = session.replace(/[^a-zA-Z0-9_-]/g, '');

                try {
                    tmux(['kill-session', '-t', safeSession], { soft: true });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true })); // Already killed
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function getRunnerOutput(req, res, pathname) {
        const { NOT_MINE, parseReqUrl, tmux } = S;
        if (!(pathname === '/api/runner/output' && req.method === 'GET')) return NOT_MINE;
        // Get runner output
        const urlObj = parseReqUrl(req.url);
        const session = ((urlObj.query.session || '') + '').replace(/[^a-zA-Z0-9_-]/g, '');

        if (!session) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session required' }));
            return;
        }

        try {
            // Check if session exists
            try {
                tmux(['has-session', '-t', session]);
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ output: '', running: false }));
                return;
            }

            // Get last 50 lines of output
            const output = tmux(['capture-pane', '-t', session, '-p', '-S', '-50'], { soft: true });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: output.trim(), running: true }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: '', running: false, error: e.message }));
        }
        return;
    }

    function postRunnerExport(req, res, pathname) {
        const { NOT_MINE, fs, path } = S;
        if (!(pathname === '/api/runner/export' && req.method === 'POST')) return NOT_MINE;
        // Export runner output to markdown file in runner's cwd
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { filename, content, cwd } = JSON.parse(body);

                if (!filename || !content || !cwd) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'filename, content, and cwd required' }));
                    return;
                }

                // Sanitize filename (allow alphanumeric, dash, underscore, dot)
                const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
                const filePath = path.join(cwd, safeFilename);

                // Write file
                fs.writeFileSync(filePath, content, 'utf8');

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, path: filePath }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postGitRollback(req, res, pathname) {
        const { NOT_MINE, execFileSync, execSync, gitCwd } = S;
        if (!(pathname === '/api/git/rollback' && req.method === 'POST')) return NOT_MINE;
        // Rollback last change (git checkout -- . or git reset)
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { type, commit, session } = JSON.parse(body);
                const gitPwd = gitCwd(res, { session, op: 'rollback' });
                if (!gitPwd) return;
                let result;

                // Reset to specific commit (from TIME CHAMBER)
                if (commit) {
                    if (!/^[a-f0-9]+$/i.test(commit)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid commit hash' }));
                        return;
                    }
                    result = execFileSync('git', ['reset', '--hard', commit], { encoding: 'utf8', cwd: gitPwd, stdio: ['pipe', 'pipe', 'pipe'] });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: `Reset to ${commit}`, result }));
                } else if (type === 'uncommitted') {
                    // Discard uncommitted changes
                    result = execSync('git checkout -- . 2>&1', { encoding: 'utf8', cwd: gitPwd });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Uncommitted changes discarded', result }));
                } else if (type === 'lastcommit') {
                    // Undo last commit (keep changes staged)
                    result = execSync('git reset --soft HEAD~1 2>&1', { encoding: 'utf8', cwd: gitPwd });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Last commit undone (changes kept)', result }));
                } else if (type === 'hard') {
                    // Hard reset to last commit (destructive)
                    result = execSync('git reset --hard HEAD 2>&1', { encoding: 'utf8', cwd: gitPwd });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Hard reset to HEAD', result }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid rollback type' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });

    // ═══════════════════════════════════════════════════════════════════
    // VNC REMOTE DESKTOP API ENDPOINTS
    // ═══════════════════════════════════════════════════════════════════
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        getRunnerList,
        getRunnerBrowse,
        postRunnerStart,
        postRunnerSend,
        postRunnerSendKey,
        postRunnerSendChar,
        postRunnerSendText,
        postRunnerReadFile,
        postRunnerStop,
        postRunnerKill,
        getRunnerOutput,
        postRunnerExport,
        postGitRollback,
    ];

    return function apiRunners(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
