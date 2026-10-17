#!/usr/bin/env node
// A colour that IS a palette token must be written as the token (cleanup P3 #17).
//
// variables.css defines the palette once (--neon #00ff41, --cyan #00d4ff, ...) and the
// navy theme and eye-protect mode redefine those tokens. A rule that hard-codes
// #00ff41 instead of var(--neon) looks the same in green and ignores both themes:
// that is why CLAUDE.md measured the navy theme as "only ~60% real".
// Exempt: variables.css itself, rules that only apply under a theme, and a value
// two tokens share (which token was meant cannot be known).
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const norm = v => v.toLowerCase().replace(/\s+/g, '');

// the default palette: the first block of variables.css
const vars = fs.readFileSync(path.join(ROOT, 'src/css/variables.css'), 'utf8');
const first = vars.slice(vars.indexOf('{') + 1, vars.indexOf('}'));
const byValue = new Map();
for (const m of first.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const v = norm(m[2]);
    if (!/^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/.test(v)) continue;
    byValue.set(v, byValue.has(v) ? null : m[1]);       // null = ambiguous
}
const TOKEN_OF = new Map([...byValue].filter(([, t]) => t));

function* cssFiles(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir + '/' + e.name;
        if (e.isDirectory()) yield* cssFiles(rel);
        else if (e.name.endsWith('.css') && rel !== 'src/css/variables.css') yield rel;
    }
}

const THEMED = /theme-navy|eye-protect/;
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
// Every place a token's value is hard-coded: file, line, literal, token.
function findLiterals(src) {
    const out = [];
    const re = /([^{}]*)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
        if (THEMED.test(m[1]) || m[1].trim().startsWith('@')) continue;
        const bodyStart = m.index + m[1].length + 1;
        // A custom property (--x: ...) is resolved where it is USED, so --x: var(--cyan)
        // picks up a room's own --cyan and is not the same as --x: #00d4ff. Measured
        // 2026-10-17: rooms-base.css's --room-* turned navy in the NULL and Catalog rooms.
        // blanked to spaces (same length), so the offsets below still point into src
        const decls = m[2].replace(/(^|;)\s*--[\w-]+\s*:[^;]*/g, (d) => d.replace(/[^\n]/g, ' '));
        for (const c of decls.matchAll(COLOR)) {
            const token = TOKEN_OF.get(norm(c[0]));
            if (token) out.push({ at: bodyStart + c.index, literal: c[0], token });
        }
    }
    return out;
}

module.exports = { findLiterals, TOKEN_OF };
if (require.main !== module) return;

let total = 0;
for (const f of cssFiles('src/css')) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const h of findLiterals(src)) {
        if (total < 15) console.log(`  [x] ${f}:${src.slice(0, h.at).split('\n').length} ${h.literal} is ${h.token}: write var(${h.token}) so the themes reach it`);
        total++;
    }
}
if (total > 15) console.log(`  ... and ${total - 15} more`);
console.log(`check-colors: ${total ? total + ' hard-coded palette colour(s) FAILED' : 'every palette colour goes through its token ok'} (${TOKEN_OF.size} tokens)`);
process.exit(total ? 1 : 0);
