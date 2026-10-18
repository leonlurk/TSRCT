'use strict';
// scripts/setup-lib.js — the installer's steps that touch files, kept apart from
// the questions so scripts/check-setup.js can run them on a temp folder.
//
// Two promises to whoever runs `npm run setup`, checked by that file:
//   - nothing they already set is overwritten (an existing BRIDGE_TOKEN, their
//     own Claude Code hooks, their other settings), and every file is backed
//     up before it is changed;
//   - nothing is guessable: the token and the ntfy topic come from crypto.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const envFile = require('../lib/envFile');

const makeToken = () => crypto.randomBytes(32).toString('base64url');
// An ntfy topic is a public name: anyone who knows it can read it.
const makeTopic = () => 'tsrct-' + crypto.randomBytes(12).toString('hex');

function backup(file) {
    if (!fs.existsSync(file)) return null;
    const to = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, to);
    return to;
}

// A value that is only the example's stand-in: empty, "change-me...", or a
// /home/you/ path. Such a value is never "kept".
const isPlaceholder = (v) => !v || /change-me/i.test(v) || /\/you(\/|$)/.test(v);

// Set KEY=value lines in a .env, in place. `keep` names keys whose existing,
// real value must win (the token). Comments and every other line stay as they are.
function writeEnv(file, values, { keep = [], backup: makeBackup = true } = {}) {
    const had = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const current = envFile.parse(had);
    const lines = had ? had.replace(/\n$/, '').split('\n') : [];
    const changed = [];
    for (const [key, value] of Object.entries(values)) {
        if (keep.includes(key) && !isPlaceholder(current[key])) continue;
        const i = lines.findIndex(l => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
        const line = `${key}=${value}`;
        if (i === -1) lines.push(line); else lines[i] = line;
        changed.push(key);
    }
    const bak = makeBackup ? backup(file) : null;
    fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { backup: bak, changed };
}

// Add TSRCT's hooks to a Claude Code settings.json next to whatever is there.
// A hook already pointing at this TSRCT is not added again.
function installHooks(settingsFile, template, tsrctDir) {
    let settings = {};
    if (fs.existsSync(settingsFile)) settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8') || '{}');
    settings.hooks = settings.hooks || {};
    // Point each hook script at THIS folder, whatever path the template carries
    // (the public one has /path/to/TSRCT, a working copy its own absolute path).
    const real = (cmd) => cmd.replace(/\S*\/(notify\.sh|permission-hook\.sh)/g, (m, script) => path.join(tsrctDir, script));
    let added = 0;
    for (const [event, groups] of Object.entries(template.hooks || {})) {
        const mine = settings.hooks[event] = settings.hooks[event] || [];
        const present = new Set(mine.flatMap(g => (g.hooks || []).map(h => h.command)));
        for (const g of groups) {
            const hooks = g.hooks.map(h => ({ ...h, command: real(h.command) })).filter(h => !present.has(h.command));
            if (hooks.length) { mine.push({ ...g, hooks }); added += hooks.length; }
        }
    }
    const bak = backup(settingsFile);
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    return { backup: bak, added };
}

// Is a program on PATH? Read the folders ourselves: no shell, nothing to inject.
function onPath(name) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir, name);
        try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
    return null;
}

module.exports = { makeToken, makeTopic, writeEnv, installHooks, onPath, backup, isPlaceholder };
