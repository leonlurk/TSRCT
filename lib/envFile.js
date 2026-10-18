'use strict';
// lib/envFile.js — read a .env file into { KEY: value }. Zero dependencies.
//
// One reader for the server and the installer. The rules a hand-written .env
// needs (scripts/check-setup.js runs them on the real .env.example):
//   - `# ...` on its own line is a comment;
//   - `KEY=value   # note`: a # AFTER whitespace starts a comment, so the note is
//     not part of the value (the old reader kept it: BIND_HOST became
//     "127.0.0.1 # keep it local; ...");
//   - a # with no space before it is part of the value (tokens, colours);
//   - "double" or 'single' quotes keep everything inside them, # included;
//   - an `export ` in front is allowed.
function parseValue(raw) {
    const v = raw.trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) return v.slice(1, v.indexOf(q, 1));
    const hash = v.search(/(^|\s)#/);
    return (hash === -1 ? v : v.slice(0, hash)).trim();
}

function parse(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        if (m) out[m[1]] = parseValue(m[2]);
    }
    return out;
}

module.exports = { parse, parseValue };
