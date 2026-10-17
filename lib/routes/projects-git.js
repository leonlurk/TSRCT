'use strict';
// Hands-on, plain-brief, projects, the git panel, project context, usage.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (TMUX_SESSION, dispatcher) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    function getHandsonPlan(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, handson, jsonResp, parseReqUrl } = S;
        if (!(pathname === '/api/handson/plan' && req.method === 'GET')) return NOT_MINE;
        const hoCwd = String((parseReqUrl(req.url).query || {}).cwd || '').trim();
        if (!hoCwd) return jsonResp(res, 400, { error: 'cwd required' });
        if (restrictedGuard.mentionsRestricted(hoCwd)) return jsonResp(res, 403, { error: 'Access denied (SecretCo)' });
        const plan = handson.getPlan(hoCwd);
        if (!plan) return jsonResp(res, 404, { error: 'no plan for this project' });
        jsonResp(res, 200, plan);
    }

    function postHandsonProgress(req, res, pathname) {
        const { NOT_MINE, restrictedGuard, handson, jsonResp } = S;
        if (!((pathname === '/api/handson/progress' || pathname === '/api/handson/step-done') && req.method === 'POST')) return NOT_MINE;
        let hoBody = '';
        req.on('data', (c) => { hoBody += c; if (hoBody.length > 512 * 1024) req.destroy(); });
        req.on('end', () => {
            let p;
            try { p = JSON.parse(hoBody || '{}'); } catch { return jsonResp(res, 400, { error: 'invalid JSON body' }); }
            const hoCwd = String(p.cwd || '').trim();
            if (!hoCwd) return jsonResp(res, 400, { error: 'cwd required' });
            if (restrictedGuard.mentionsRestricted(hoCwd)) return jsonResp(res, 403, { error: 'Access denied (SecretCo)' });
            const r = pathname === '/api/handson/progress'
                ? handson.saveProgress(hoCwd, p)
                : handson.recordStepDone(hoCwd, Number(p.stepIndex) || 0, p.lines, new Date().toISOString());
            jsonResp(res, r.ok ? 200 : 404, r);
        });
    // ── [PB] PLAIN BRIEF: the toggle ────────────────────────────────────────
    // This server only ever WRITES the flag. The enforcement lives in two Claude
    // Code hooks that read `data/plain-brief.json` straight off disk, so the rule
    // survives a restart of this process and applies to prompts Leon types
    // directly into the pane -- not just the ones sent through TSRCT.
    }

    function getPlainbrief(req, res, pathname) {
        const { NOT_MINE, jsonResp, parseReqUrl, plainBrief } = S;
        if (!(pathname === '/api/plainbrief' && req.method === 'GET')) return NOT_MINE;
        const pbQ = parseReqUrl(req.url).query || {};
        const pbSession = String(pbQ.session || '').trim();
        jsonResp(res, 200, pbSession
            ? plainBrief.get(pbSession)
            : plainBrief.getState());
    }

    function postPlainbriefToggle(req, res, pathname) {
        const { NOT_MINE, jsonResp, plainBrief } = S;
        if (!(pathname === '/api/plainbrief/toggle' && req.method === 'POST')) return NOT_MINE;
        let pbBody = '';
        req.on('data', (c) => { pbBody += c; if (pbBody.length > 8 * 1024) req.destroy(); });
        req.on('end', () => {
            let p;
            try { p = JSON.parse(pbBody || '{}'); } catch { return jsonResp(res, 400, { error: 'invalid JSON body' }); }
            const pbSession = String(p.session || '').trim();
            if (!pbSession) return jsonResp(res, 400, { error: 'session required' });
            // `on` absent means "flip it"; an explicit boolean means "set it",
            // which is what a second window needs so two toggles cannot race
            // into opposite states.
            const r = (typeof p.on === 'boolean')
                ? plainBrief.set(pbSession, p.on, p.cap)
                : plainBrief.toggle(pbSession, p.cap);
            if (r.ok) console.log(`[PB] ${pbSession}: ${r.on ? 'ON' : 'OFF'}${r.on ? ` (cap ${r.cap})` : ''}`);
            jsonResp(res, r.ok ? 200 : 400, r);
        });
    }

    function postCwd(req, res, pathname) {
        const { NOT_MINE, PROJECTS_ROOT, fs, getSessionPwd, path } = S;
        if (!(pathname === '/api/cwd' && req.method === 'POST')) return NOT_MINE;
        // Change working directory.
        // SECURITY: chdir mutates PROCESS-GLOBAL state that other routes read, so the
        // target is validated and contained instead of being handed to chdir raw.
        // Callers are the project switcher (main.js switchProject), which only ever
        // passes a directory from GET /api/projects -- i.e. under PROJECTS or HOME.
        // NOTE: the old code destructured `const { path }`, shadowing the path module
        // inside this handler; the field is read as `target` so path.* stays usable.
        // Audit 2026-08-14.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { path: target } = JSON.parse(body);
                // Reject empty explicitly: path.resolve('') returns process.cwd(),
                // which is inside PROJECTS, so an empty body would pass containment
                // and report success for a no-op.
                const raw = String(target || '').trim();
                if (!raw) throw new Error('path required');
                const resolved = path.resolve(raw);
                const home = process.env.HOME || process.env.USERPROFILE || '';
                const roots = [path.resolve(PROJECTS_ROOT)];
                if (home) roots.push(path.resolve(home));
                const contained = roots.some(r => resolved === r || resolved.startsWith(r + path.sep));
                if (!contained) throw new Error('path not allowed');
                if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
                    throw new Error('not a directory');
                }
                S.dispatcher.restrictedGuard.assertNotRestricted('cwd', resolved);
                process.chdir(resolved);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, cwd: getSessionPwd() }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function getProjects(req, res, pathname) {
        const { NOT_MINE, PROJECTS_ROOT } = S;
        if (!(pathname === '/api/projects' && req.method === 'GET')) return NOT_MINE;
        // List recent projects (directories with .git or package.json)
        try {
            const pathModule = require('path');
            const fsModule = require('fs');
            const cwd = process.cwd();
            const parentDir = pathModule.dirname(cwd);
            const grandParentDir = pathModule.dirname(parentDir);
            const home = process.env.HOME || process.env.USERPROFILE;

            // Priority: parent dir (siblings), grandparent (cousins), then common locations
            const searchPaths = [
                parentDir,           // Sibling projects (most useful)
                grandParentDir,      // Cousin projects
                cwd,                 // Subdirectories of current
                `${home}/projects`,
                `${home}/Projects`,
                `${home}/code`,
                `${home}/Desktop/PROYECTOS`,
                PROJECTS_ROOT
            ];

            const projects = [];
            const seen = new Set();

            // Add current directory first
            const cwdHasGit = fsModule.existsSync(`${cwd}/.git`);
            const cwdHasPkg = fsModule.existsSync(`${cwd}/package.json`);
            projects.push({
                path: cwd,
                name: pathModule.basename(cwd),
                current: true,
                hasGit: cwdHasGit,
                hasPkg: cwdHasPkg
            });
            seen.add(cwd);

            // Search for projects in each path
            for (const searchPath of searchPaths) {
                if (!searchPath || seen.has(searchPath + '_searched')) continue;
                seen.add(searchPath + '_searched');

                try {
                    const dirs = fsModule.readdirSync(searchPath, { withFileTypes: true });
                    for (const dir of dirs) {
                        if (!dir.isDirectory() || dir.name.startsWith('.') || dir.name === 'node_modules') continue;

                        const fullPath = pathModule.join(searchPath, dir.name);
                        if (seen.has(fullPath)) continue;

                        try {
                            const hasGit = fsModule.existsSync(`${fullPath}/.git`);
                            const hasPkg = fsModule.existsSync(`${fullPath}/package.json`);
                            if (hasGit || hasPkg) {
                                projects.push({ path: fullPath, name: dir.name, hasGit, hasPkg });
                                seen.add(fullPath);
                            }
                        } catch {}

                        if (projects.length >= 20) break;
                    }
                } catch {}

                if (projects.length >= 20) break;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ projects }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ projects: [{ path: process.cwd(), name: require('path').basename(process.cwd()), current: true }] }));
        }
    }

    function getGitStatus(req, res, pathname) {
        const { NOT_MINE, execSync, gitCwd } = S;
        if (!(pathname === '/api/git/status' && req.method === 'GET')) return NOT_MINE;
        // Get git status
        try {
            const gitPwd = gitCwd(res, { op: 'status' });
            if (!gitPwd) return;
            const status = execSync('git status --short 2>/dev/null || echo "Not a git repo"', { encoding: 'utf8', cwd: gitPwd });
            const branch = execSync('git branch --show-current 2>/dev/null || echo "N/A"', { encoding: 'utf8', cwd: gitPwd }).trim();
            const lastCommit = execSync('git log -1 --oneline 2>/dev/null || echo "No commits"', { encoding: 'utf8', cwd: gitPwd }).trim();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status, branch, lastCommit }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'Not a git repository', branch: 'N/A', lastCommit: 'N/A' }));
        }
    }

    function getGitLog(req, res, pathname) {
        const { NOT_MINE, execFileSync, gitCwd, parseReqUrl } = S;
        if (!(pathname === '/api/git/log' && req.method === 'GET')) return NOT_MINE;
        // Get commit history
        const urlObj = parseReqUrl(req.url);
        const limit = parseInt(urlObj.query.limit) || 20;
        const session = urlObj.query.session || S.TMUX_SESSION;
        const gitPwd = gitCwd(res, { session, op: 'log' });
        if (!gitPwd) return;
        try {
            // Use ASCII delimiter (0x1E - record separator) to avoid conflicts with commit messages
            let log = '';
            try { log = execFileSync('git', ['log', '--pretty=format:%h\x1e%an\x1e%ar\x1e%d\x1e%s', '-n', String(limit)], { encoding: 'utf8', cwd: gitPwd, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { log = ''; }
            const commits = log.trim().split('\n').filter(l => l).map(line => {
                const parts = line.split('\x1e');
                if (parts.length >= 5) {
                    return {
                        hash: parts[0],
                        author: parts[1],
                        date: parts[2],
                        refs: parts[3].trim().replace(/^\(|\)$/g, ''),
                        message: parts.slice(4).join(' ')
                    };
                }
                return { hash: '', author: '', date: '', refs: '', message: line };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, commits, cwd: gitPwd, session }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, commits: [], error: e.message, cwd: gitPwd, session }));
        }
    }

    function getGitBranches(req, res, pathname) {
        const { NOT_MINE, execSync, gitCwd, parseReqUrl } = S;
        if (!(pathname === '/api/git/branches' && req.method === 'GET')) return NOT_MINE;
        // Get all branches
        const urlObj = parseReqUrl(req.url);
        const session = urlObj.query.session || S.TMUX_SESSION;
        const gitPwd = gitCwd(res, { session, op: 'branches' });
        if (!gitPwd) return;
        try {
            const current = execSync('git branch --show-current 2>/dev/null', { encoding: 'utf8', cwd: gitPwd }).trim();
            const all = execSync('git branch 2>/dev/null || echo ""', { encoding: 'utf8', cwd: gitPwd });
            const branches = all.trim().split('\n').filter(l => l).map(line => {
                return line.replace(/^\*?\s+/, '').trim();
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, current, branches, cwd: gitPwd, session }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, current: '', branches: [], error: e.message, cwd: gitPwd, session }));
        }
    }

    function getGitStash(req, res, pathname) {
        const { NOT_MINE, execSync, gitCwd, parseReqUrl } = S;
        if (!(pathname === '/api/git/stash' && req.method === 'GET')) return NOT_MINE;
        // Get stash list
        const urlObj = parseReqUrl(req.url);
        const session = urlObj.query.session || S.TMUX_SESSION;
        const gitPwd = gitCwd(res, { session, op: 'stash' });
        if (!gitPwd) return;
        try {
            const stash = execSync('git stash list 2>/dev/null || echo ""', { encoding: 'utf8', cwd: gitPwd });
            const stashes = stash.trim().split('\n').filter(l => l).map(line => {
                const match = line.match(/^(stash@\{(\d+)\}):\s+(.*)$/);
                if (match) {
                    return { id: match[1], index: parseInt(match[2]), message: match[3] };
                }
                return { id: line, index: 0, message: line };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, stashes, cwd: gitPwd, session }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, stashes: [], error: e.message, cwd: gitPwd, session }));
        }
    }

    function getGitDiff(req, res, pathname) {
        const { NOT_MINE, execFileSync, gitCwd, parseReqUrl } = S;
        if (!(pathname === '/api/git/diff' && req.method === 'GET')) return NOT_MINE;
        // Get diff (optional: between two commits)
        const urlObj = parseReqUrl(req.url);
        const session = urlObj.query.session || S.TMUX_SESSION;
        const gitPwd = gitCwd(res, { session, op: 'diff' });
        if (!gitPwd) return;
        try {
            const commit = urlObj.query.commit || urlObj.query.from || '';
            const to = urlObj.query.to || '';
            let gitArgs = ['diff'];
            if (commit && to) {
                gitArgs = ['diff', `${commit}..${to}`];
            } else if (commit) {
                // Show what changed in this commit
                gitArgs = ['show', '--stat', commit];
            }
            let diff = '';
            try { diff = execFileSync('git', gitArgs, { encoding: 'utf8', cwd: gitPwd, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { diff = ''; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, diff: diff.trim() }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, diff: '', error: e.message }));
        }
    }

    function postGitCheckout(req, res, pathname) {
        const { NOT_MINE, execFileSync, gitCwd } = S;
        if (!(pathname === '/api/git/checkout' && req.method === 'POST')) return NOT_MINE;
        // Switch branch
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { branch, session } = JSON.parse(body);
                if (!branch || /[;&|`$]/.test(branch)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid branch name' }));
                    return;
                }
                const gitPwd = gitCwd(res, { session, op: 'checkout' });
                if (!gitPwd) return;
                execFileSync('git', ['checkout', branch], { encoding: 'utf8', cwd: gitPwd, stdio: ['pipe', 'pipe', 'pipe'] });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, branch }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function postGitStashSave(req, res, pathname) {
        const { NOT_MINE, execFileSync, gitCwd } = S;
        if (!(pathname === '/api/git/stash/save' && req.method === 'POST')) return NOT_MINE;
        // Save to stash
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { message, session } = JSON.parse(body);
                const gitPwd = gitCwd(res, { session, op: 'stash/save' });
                if (!gitPwd) return;
                execFileSync('git', message ? ['stash', 'push', '-m', message] : ['stash'], { encoding: 'utf8', cwd: gitPwd });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function postGitStashPop(req, res, pathname) {
        const { NOT_MINE, execFileSync, gitCwd } = S;
        if (!(pathname === '/api/git/stash/pop' && req.method === 'POST')) return NOT_MINE;
        // Pop from stash
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { index, session } = JSON.parse(body);
                const gitPwd = gitCwd(res, { session, op: 'stash/pop' });
                if (!gitPwd) return;
                execFileSync('git', index !== undefined ? ['stash', 'pop', `stash@{${index}}`] : ['stash', 'pop'], { encoding: 'utf8', cwd: gitPwd });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });

    // ==============================================
    // GIT DESKTOP ENDPOINTS
    // ==============================================
    }

    function postGitInit(req, res, pathname) {
        const { NOT_MINE, execSync, gitCwd } = S;
        if (!(pathname === '/api/git/init' && req.method === 'POST')) return NOT_MINE;
        // Initialize git repo
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { cwd } = JSON.parse(body);
                if (!cwd) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'cwd required' }));
                    return;
                }
                if (!gitCwd(res, { cwd, op: 'init' })) return;   // SecretCo contract
                execSync('git init', { encoding: 'utf8', cwd });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postGitRemoteAdd(req, res, pathname) {
        const { NOT_MINE, execFileSync, execSync, gitCwd } = S;
        if (!(pathname === '/api/git/remote/add' && req.method === 'POST')) return NOT_MINE;
        // Add remote origin
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { cwd, url } = JSON.parse(body);
                if (!cwd || !url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'cwd and url required' }));
                    return;
                }
                if (!gitCwd(res, { cwd, op: 'remote/add' })) return;   // SecretCo contract
                // Check if origin exists
                try {
                    execSync('git remote get-url origin', { encoding: 'utf8', cwd, stdio: 'pipe' });
                    // Origin exists, update it
                    execFileSync('git', ['remote', 'set-url', 'origin', url], { encoding: 'utf8', cwd });
                } catch {
                    // Origin doesn't exist, add it
                    execFileSync('git', ['remote', 'add', 'origin', url], { encoding: 'utf8', cwd });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function getGitRemoteInfo(req, res, pathname) {
        const { NOT_MINE, execSync, gitCwd, parseReqUrl, redactRemoteUrl } = S;
        if (!(pathname === '/api/git/remote/info' && req.method === 'GET')) return NOT_MINE;
        // Get remote info
        const urlObj = parseReqUrl(req.url);
        const cwd = urlObj.query.cwd;
        if (!cwd) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cwd required' }));
            return;
        }
        if (!gitCwd(res, { cwd, op: 'remote/info' })) return;   // SecretCo contract
        try {
            const remoteUrl = execSync('git remote get-url origin 2>/dev/null || echo ""', { encoding: 'utf8', cwd }).trim();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, url: redactRemoteUrl(remoteUrl) }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, url: '' }));
        }
        return;
    }

    function getGitChangedFiles(req, res, pathname) {
        const { NOT_MINE, execFileSync, execSync, gitCwd, parseReqUrl } = S;
        if (!(pathname === '/api/git/changed-files' && req.method === 'GET')) return NOT_MINE;
        // Get list of changed files
        const urlObj = parseReqUrl(req.url);
        const cwd = urlObj.query.cwd;
        const subdir = urlObj.query.subdir || '.';
        if (!cwd) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cwd required' }));
            return;
        }
        if (!gitCwd(res, { cwd, op: 'changed-files' })) return;   // SecretCo contract
        try {
            // Get the actual git root directory
            const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', cwd }).trim();

            // Calculate the relative path from gitRoot to cwd (for filtering)
            const path = require('path');
            const relativeCwd = path.relative(gitRoot, cwd);

            // Decode git's porcelain path quoting: paths with spaces/non-ASCII come wrapped
            // in double quotes and C-escaped (e.g. "weird-\303\261.txt"). Return the real path
            // so it displays correctly AND can be staged without shell-quoting breakage.
            const gitUnquotePath = (p) => {
                p = p.trim();
                if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') {
                    const inner = p.slice(1, -1);
                    const bytes = [];
                    for (let i = 0; i < inner.length; i++) {
                        if (inner[i] === '\\') {
                            const n = inner[i + 1];
                            if (n === 'n') { bytes.push(10); i++; }
                            else if (n === 't') { bytes.push(9); i++; }
                            else if (n === 'r') { bytes.push(13); i++; }
                            else if (n >= '0' && n <= '7') { bytes.push(parseInt(inner.substr(i + 1, 3), 8)); i += 3; }
                            else { bytes.push(inner.charCodeAt(i + 1)); i++; }  // \" \\ etc.
                        } else {
                            bytes.push(inner.charCodeAt(i));
                        }
                    }
                    return Buffer.from(bytes).toString('utf8');
                }
                return p;
            };

            // Get all changed files from git root
            let statusOutput = '';
            try { statusOutput = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd: gitRoot, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { statusOutput = ''; }
            let files = statusOutput.trim().split('\n').filter(l => l).map(line => {
                // git status --porcelain format: XY PATH  (PATH may be quoted; renames are "old -> new")
                const statusPart = line.substring(0, 2);
                let filePart = line.substring(2).trimStart();
                if (/[RC]/.test(statusPart) && filePart.includes(' -> ')) {
                    filePart = filePart.split(' -> ').pop();  // keep the rename destination
                }
                return { status: statusPart.trim() || '?', file: gitUnquotePath(filePart) };
            });

            // If cwd is a subdirectory, filter to only show files in that subdirectory
            if (relativeCwd && relativeCwd !== '.') {
                const prefix = relativeCwd + '/';
                files = files.filter(f => f.file.startsWith(prefix) || f.file === relativeCwd);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, files, gitRoot }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, files: [] }));
        }
        return;
    }

    function postGitAdd(req, res, pathname) {
        const { NOT_MINE, execFileSync, execSync, gitCwd } = S;
        if (!(pathname === '/api/git/add' && req.method === 'POST')) return NOT_MINE;
        // Git add - supports single path or array of paths
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { cwd, path: addPath, paths } = JSON.parse(body);
                if (!cwd) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'cwd required' }));
                    return;
                }
                if (!gitCwd(res, { cwd, op: 'add' })) return;   // SecretCo contract

                // Get the actual git root directory to avoid path issues
                const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', cwd }).trim();

                // Support array of paths or single path. Use execFileSync (arg array, no shell)
                // so paths with spaces/quotes/unicode are passed to git literally. -A stages
                // modifications, additions AND deletions for the given path.
                const addOne = (p) => {
                    try {
                        execFileSync('git', ['add', '-A', '--', p], { encoding: 'utf8', cwd: gitRoot, stdio: ['pipe', 'pipe', 'pipe'] });
                    } catch (err) {
                        // A path whose deletion is ALREADY staged (git status shows "D "
                        // in the first column) no longer exists in the working tree or as
                        // an index blob, so `git add` fails with "pathspec ... did not match
                        // any files". That path is already staged for commit -- skip it
                        // instead of aborting the whole commit.
                        const msg = (err.stderr ? err.stderr.toString() : '') + (err.message || '');
                        if (!/did not match any files/i.test(msg)) throw err;
                    }
                };
                if (paths && Array.isArray(paths) && paths.length > 0) {
                    // Add multiple specific files
                    for (const p of paths) addOne(p);
                } else {
                    addOne(addPath || '.');
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postGitCommit(req, res, pathname) {
        const { NOT_MINE, execFileSync, execSync, gitCwd } = S;
        if (!(pathname === '/api/git/commit' && req.method === 'POST')) return NOT_MINE;
        // Git commit
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { cwd, message } = JSON.parse(body);
                if (!cwd || !message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'cwd and message required' }));
                    return;
                }
                if (!gitCwd(res, { cwd, op: 'commit' })) return;   // SecretCo contract
                // Get the actual git root directory
                const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', cwd }).trim();
                execFileSync('git', ['commit', '-m', message], { encoding: 'utf8', cwd: gitRoot });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postGitPush(req, res, pathname) {
        const { NOT_MINE, gitCwd, spawnSync } = S;
        if (!(pathname === '/api/git/push' && req.method === 'POST')) return NOT_MINE;
        // Git push
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { cwd, branch, setUpstream } = JSON.parse(body);
                if (!cwd) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'cwd required' }));
                    return;
                }
                if (!gitCwd(res, { cwd, op: 'push' })) return;   // SecretCo contract
                let pushArgs = ['push'];
                if (setUpstream && branch) {
                    pushArgs = ['push', '-u', 'origin', branch];
                } else if (branch) {
                    pushArgs = ['push', 'origin', branch];
                }
                // git push writes its summary to stderr; merge both streams (the
                // old code used "2>&1"). spawnSync passes argv with no shell.
                const pushRes = spawnSync('git', pushArgs, { encoding: 'utf8', cwd, maxBuffer: 1024 * 1024 });
                const output = ((pushRes.stdout || '') + (pushRes.stderr || '')).trim();
                if (pushRes.status !== 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: output || 'git push failed' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, output }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function postGitCredentials(req, res, pathname) {
        const { NOT_MINE, execFileSync, execSync, gitCwd } = S;
        if (!(pathname === '/api/git/credentials' && req.method === 'POST')) return NOT_MINE;
        // Store git credentials in local config (repo-specific, not global)
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { cwd, username, token } = JSON.parse(body);
                if (!cwd || !username || !token) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'cwd, username and token required' }));
                    return;
                }
                if (!gitCwd(res, { cwd, op: 'credentials' })) return;   // SecretCo contract
                // Get current remote URL
                let remoteUrl = '';
                try {
                    remoteUrl = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf8', cwd }).trim();
                } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'No remote origin configured' }));
                    return;
                }
                // Convert https URL to include credentials
                // https://github.com/user/repo.git -> https://<username>:<token>@github.com/user/repo.git
                // Also handles re-setting credentials when URL already has stale creds embedded
                if (remoteUrl.startsWith('https://')) {
                    const cleanUrl = remoteUrl.replace(/^https:\/\/[^@\/]+@/, 'https://');
                    const urlWithCreds = cleanUrl.replace('https://', `https://${username}:${token}@`);
                    execFileSync('git', ['remote', 'set-url', 'origin', urlWithCreds], { encoding: 'utf8', cwd });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Only HTTPS remotes supported for credential storage' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    function getGitInfo(req, res, pathname) {
        const { NOT_MINE, gitCwd, gitOut, parseReqUrl, redactRemoteUrl } = S;
        if (!(pathname === '/api/git/info' && req.method === 'GET')) return NOT_MINE;
        // Get comprehensive git info for a directory
        const urlObj = parseReqUrl(req.url);
        const cwd = urlObj.query.cwd;
        if (!cwd) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cwd required' }));
            return;
        }
        if (!gitCwd(res, { cwd, op: 'info' })) return;   // SecretCo contract
        // Async and in parallel (2026-10-08): seven sync git calls in a row on
        // /mnt/c measured 1.3s with the whole server frozen for all of it.
        (async () => {
        try {
            const isRepo = (await gitOut(cwd, ['rev-parse', '--git-dir'])) !== null;

            if (!isRepo) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, isRepo: false }));
                return;
            }

            const [branchOut, branchesOut, remoteOut, statusOut, lastOut, upstreamOut] = await Promise.all([
                gitOut(cwd, ['branch', '--show-current']),
                gitOut(cwd, ['branch']),
                gitOut(cwd, ['remote', 'get-url', 'origin']),
                gitOut(cwd, ['status', '--porcelain']),
                gitOut(cwd, ['log', '-1', '--format=%h %s']),
                gitOut(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}']),
            ]);
            const branch = (branchOut || '').trim();
            const branches = (branchesOut || '').trim().split('\n').filter(l => l).map(l => l.replace(/^\*?\s+/, '').trim());
            const remoteUrl = (remoteOut || '').trim();
            const changedCount = (statusOut || '').trim().split('\n').filter(l => l).length;
            const lastCommit = (lastOut || '').trim();
            const hasUpstream = upstreamOut !== null;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                isRepo: true,
                branch,
                branches,
                remoteUrl: redactRemoteUrl(remoteUrl),
                changedCount,
                lastCommit,
                hasUpstream
            }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        })();
        return;
    }

    function getProjectContext(req, res, pathname) {
        const { NOT_MINE, execSync } = S;
        if (!(pathname === '/api/project-context' && req.method === 'GET')) return NOT_MINE;
        // Get comprehensive project context
        try {
            const cwd = process.cwd();
            const pathModule = require('path');
            const fsModule = require('fs');
            const projectName = pathModule.basename(cwd);

            // Git info
            let branch = 'N/A', lastCommit = 'N/A', gitStatus = '';
            try {
                branch = execSync('git branch --show-current 2>/dev/null', { encoding: 'utf8', cwd }).trim() || 'N/A';
                lastCommit = execSync('git log -1 --format="%h %s" 2>/dev/null', { encoding: 'utf8', cwd }).trim() || 'N/A';
                gitStatus = execSync('git status --short 2>/dev/null | head -10', { encoding: 'utf8', cwd }).trim();
            } catch {}

            // File tree (limited depth)
            let tree = [];
            function walkDir(dir, depth = 0, prefix = '') {
                if (depth > 2 || tree.length > 50) return;
                const ignore = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'coverage', '.cache', 'vendor'];
                try {
                    const items = fsModule.readdirSync(dir, { withFileTypes: true })
                        .filter(i => !ignore.includes(i.name) && !i.name.startsWith('.'))
                        .sort((a, b) => {
                            if (a.isDirectory() && !b.isDirectory()) return -1;
                            if (!a.isDirectory() && b.isDirectory()) return 1;
                            return a.name.localeCompare(b.name);
                        })
                        .slice(0, 15);

                    items.forEach((item, i) => {
                        const isLast = i === items.length - 1;
                        const line = prefix + (isLast ? '└── ' : '├── ') + item.name + (item.isDirectory() ? '/' : '');
                        tree.push(line);
                        if (item.isDirectory() && depth < 2) {
                            walkDir(pathModule.join(dir, item.name), depth + 1, prefix + (isLast ? '    ' : '│   '));
                        }
                    });
                } catch {}
            }
            walkDir(cwd);

            // README preview
            let readme = '';
            const readmeFiles = ['README.md', 'readme.md', 'README', 'README.txt'];
            for (const f of readmeFiles) {
                const p = pathModule.join(cwd, f);
                if (fsModule.existsSync(p)) {
                    try {
                        const content = fsModule.readFileSync(p, 'utf8');
                        readme = content.substring(0, 500);
                        if (content.length > 500) readme += '\n...';
                    } catch {}
                    break;
                }
            }

            // Package info
            let packageInfo = null;
            try {
                const pkgPath = pathModule.join(cwd, 'package.json');
                if (fsModule.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fsModule.readFileSync(pkgPath, 'utf8'));
                    packageInfo = {
                        name: pkg.name || projectName,
                        version: pkg.version || '0.0.0',
                        description: pkg.description || '',
                        scripts: Object.keys(pkg.scripts || {}).slice(0, 8),
                        deps: Object.keys(pkg.dependencies || {}).length,
                        devDeps: Object.keys(pkg.devDependencies || {}).length
                    };
                }
            } catch {}

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                projectName,
                path: cwd,
                branch,
                lastCommit,
                gitStatus,
                tree: tree.join('\n'),
                readme,
                packageInfo
            }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    }

    function getUsageDay(req, res, pathname) {
        const { NOT_MINE, parseReqUrl, usage } = S;
        if (!(pathname === '/api/usage/day' && req.method === 'GET')) return NOT_MINE;
        // What today actually cost, read off the Claude Code transcripts. ON
        // DEMAND ONLY — this walks up to ~150 MB of JSON, so it runs when the
        // panel's [refresh] is clicked and at no other time. There is deliberately
        // no timer, here or in lib/usage.js. SecretCo transcripts are excluded inside
        // the module, at the one place that enumerates files.
        try {
            const qDay = ((parseReqUrl(req.url).query || {}).day || '').trim();
            const day = /^\d{4}-\d{2}-\d{2}$/.test(qDay) ? qDay : usage.todayKey();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(usage.scan(day)));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message, day: usage.todayKey() }));
        }
        return;
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        getHandsonPlan,
        postHandsonProgress,
        getPlainbrief,
        postPlainbriefToggle,
        postCwd,
        getProjects,
        getGitStatus,
        getGitLog,
        getGitBranches,
        getGitStash,
        getGitDiff,
        postGitCheckout,
        postGitStashSave,
        postGitStashPop,
        postGitInit,
        postGitRemoteAdd,
        getGitRemoteInfo,
        getGitChangedFiles,
        postGitAdd,
        postGitCommit,
        postGitPush,
        postGitCredentials,
        getGitInfo,
        getProjectContext,
        getUsageDay,
    ];

    return function apiProjectsGit(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
