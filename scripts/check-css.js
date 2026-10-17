#!/usr/bin/env node
// No CSS rule may be DEAD (cleanup P3 #16).
//
// A selector is dead when one of its classes or ids appears nowhere in the code
// that builds the page (src/ html and js, server.js, lib/) as a whole word, and no
// string there could build it from a prefix ('au-card-' + state, `cl-dot-${c}`).
// Measured 2026-10-17: 100 such rules (~530 lines) in 9 files - the deleted TOWER
// panel, an old rooms list, an earlier git folder picker, utility classes nobody
// used. Dead rules are not harmless: they are where the next change gets made by
// mistake, and they make every search for a class lie.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function* files(dir, re) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir + '/' + e.name;
        if (rel === 'src/js/vendor') continue;
        if (e.isDirectory()) yield* files(rel, re);
        else if (re.test(e.name)) yield rel;
    }
}

const code = ['server.js', ...files('src', /\.(js|html)$/), ...files('lib', /\.js$/)]
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const words = new Set(code.match(/[A-Za-z_][\w-]*/g));
const prefixes = new Set([...code.matchAll(/([A-Za-z_][\w-]*-)(?:['"`]\s*\+|\$\{)/g)].map(m => m[1]));
const used = n => words.has(n) || [...prefixes].some(p => n.startsWith(p));
const selectorDead = s => [...s.matchAll(/[.#]([A-Za-z_][\w-]*)/g)].some(m => !used(m[1]));

// Style rules, top level and inside @media/@supports; @keyframes and the like skipped.
function rules(src) {
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
    const out = [];
    let i = 0, seg = 0;
    while (i < clean.length) {
        const c = clean[i];
        if (c === '{') {
            const pre = clean.slice(seg, i).trim();
            if (/^@(media|supports)/.test(pre)) { seg = i + 1; }
            else if (pre.startsWith('@')) {
                let d = 1, j = i + 1;
                while (d && j < clean.length) { if (clean[j] === '{') d++; else if (clean[j] === '}') d--; j++; }
                i = seg = j; continue;
            } else {
                const j = clean.indexOf('}', i);
                out.push({ sel: pre.replace(/\s+/g, ' '), line: clean.slice(0, i).split('\n').length });
                i = seg = j + 1; continue;
            }
        } else if (c === '}') seg = i + 1;
        i++;
    }
    return out;
}

const dead = [];
for (const f of files('src/css', /\.css$/)) {
    for (const r of rules(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
        const parts = r.sel.split(',').map(s => s.trim());
        if (parts.every(selectorDead)) dead.push(`${f}:${r.line} ${r.sel.slice(0, 80)}`);
    }
}
for (const d of dead.slice(0, 20)) console.log('  [x] dead rule (no page code can produce it): ' + d);
if (dead.length > 20) console.log(`  ... and ${dead.length - 20} more`);
console.log(`check-css: ${dead.length ? dead.length + ' dead rule(s) FAILED' : 'no dead rules ok'}`);
process.exit(dead.length ? 1 : 0);
