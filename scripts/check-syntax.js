#!/usr/bin/env node
// Every .js file in the repo must PARSE (cleanup P4 #19).
//
// The other checks require only the files they test, so a syntax error in a
// browser file or an untested lib module was found by a restart or a blank page.
// Parsing never runs anything: plain scripts go through vm.Script, and the ES
// modules (import/export, top-level await) through `node --check` on stdin.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['lib', 'scripts', 'src/js'];
const SKIP = new Set(['src/js/vendor']);   // minified third-party code

function* jsFiles(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir + '/' + e.name;
        if (SKIP.has(rel)) continue;
        if (e.isDirectory()) yield* jsFiles(rel);
        else if (/\.(c?js|mjs)$/.test(e.name)) yield rel;
    }
}

const files = ['server.js', 'sw.js', ...DIRS.flatMap(d => [...jsFiles(d)])];
const bad = [];
let modules = 0;
for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Node files parse inside node's own CommonJS wrapper (a top-level `return`
    // is legal there); browser files (src/js, sw.js) as plain scripts.
    const browser = rel.startsWith('src/') || rel === 'sw.js';
    const code = browser ? src
        : '(function (exports, require, module, __filename, __dirname) {' + src.replace(/^#!.*/, '') + '\n})';
    try {
        new vm.Script(code, { filename: rel });
    } catch (e) {
        if (!(e instanceof SyntaxError)) { bad.push(`${rel}: ${e.message}`); continue; }
        // An ES module does not parse as a script; let node judge it AS A MODULE.
        // `node --check file.js` is no use here: on a .js file with module syntax
        // it exits 0 even when the file is broken (measured, node 24).
        const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: src, encoding: 'utf8' });
        modules++;
        if (r.status !== 0) bad.push(`${rel}: ${(r.stderr || '').split('\n').find(l => /Error/.test(l)) || e.message}`);
    }
}

for (const b of bad) console.log('  FAIL ' + b);
console.log(`check-syntax: ${files.length - bad.length}/${files.length} files parse (${modules} as ES modules)`);
process.exit(bad.length ? 1 : 0);
