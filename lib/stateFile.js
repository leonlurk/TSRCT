// lib/stateFile.js - one home for TSRCT's runtime state: <repo>/.tsrct/ (gitignored
// as a whole directory, see .gitignore).
//
// Nine modules used to keep .tsrct-<name>.json at the repo root, next to .tsrct/
// and data/ (cleanup P3 #15). stateFile(name, legacy) returns .tsrct/<name> and,
// the first time, moves the old root file there, so nothing already saved is lost.
// If BOTH exist, the one written last wins and the other goes: the running server
// is the old code until TSRCT restarts, and it keeps writing the root file after
// a check has already moved it. It never creates a file.
// The launcher's own files (.tsrct-boot.log, .tsrct-boot.lock, .tsrct-appid) stay
// at the root on purpose: PowerShell and bash read them before node is up.
'use strict';

const fs = require('fs');
const path = require('path');

let root = path.join(__dirname, '..');
// Only the SERVER moves files. Anything else that loads these modules (the checks,
// the pre-commit hook, a script) uses the copy that exists and moves nothing: the
// suite once moved three files out from under the running server (2026-10-16).
let migrate = !!(require.main && path.basename(require.main.filename) === 'server.js');

function configure(opts = {}) {
    if (opts.root) root = opts.root;
    if (opts.migrate !== undefined) migrate = !!opts.migrate;
}

function stateFile(name, legacy) {
    const dir = path.join(root, '.tsrct');
    const file = path.join(dir, name);
    if (!migrate) {
        const old = legacy && path.join(root, legacy);
        return old && !fs.existsSync(file) && fs.existsSync(old) ? old : file;
    }
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the caller's write reports it */ }
    if (legacy) {
        const old = path.join(root, legacy);
        try {
            if (fs.existsSync(old)) {
                const newer = !fs.existsSync(file) || fs.statSync(old).mtimeMs > fs.statSync(file).mtimeMs;
                if (newer) fs.renameSync(old, file);
                else fs.unlinkSync(old);
            }
        } catch (e) {
            console.error(`[stateFile] could not move ${legacy} into .tsrct/: ${e.message}`);
        }
    }
    return file;
}

module.exports = { stateFile, configure };
