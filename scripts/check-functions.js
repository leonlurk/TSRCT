#!/usr/bin/env node
// No function may be a wall of code (cleanup P2, 2026-10-17).
//
// Counts each function's OWN lines: its length minus the functions nested inside it,
// so a module wrapper (an IIFE, a route file's factory) is measured by what it holds
// directly, not by everything defined in it. Blank and comment-only lines are not
// counted. Over the ceiling is red: split the function along the steps it already has.
// Test scripts are exempt (a long list of checks is fine).
//
// usage: node scripts/check-functions.js [--top N]
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CEILING = 150;

// a tiny parser is enough to find functions: node's own, via a throwaway compile is not
// possible, so this uses the same acorn-free approach as the other checks would not
// manage; acorn is not a dependency, so we tokenize braces ourselves.
function* files(dir, re) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir + '/' + e.name;
        if (rel === 'src/js/vendor' || rel === 'lib/routes/__none__') continue;
        if (e.isDirectory()) yield* files(rel, re);
        else if (re.test(e.name)) yield rel;
    }
}

// Blank out comments, strings, template text and regex literals (same length), so
// braces and the word `function` are only ever real code.
function codeOnly(src) {
    let out = '', i = 0, prev = '';
    const n = src.length;
    const regexOk = () => /(^|[=(,:;!&|?{}\[\]+\-*%<>~^]|\breturn|\btypeof|\bcase|\bin|\bof)\s*$/.test(out.slice(-30));
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
        if (c === '/' && d === '*') { while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
        if (c === '"' || c === "'") {
            out += c; i++;
            while (i < n && src[i] !== c) { if (src[i] === '\\') { out += ' '; i++; } out += src[i] === '\n' ? '\n' : ' '; i++; }
            out += c; i++; continue;
        }
        if (c === '`') {
            out += '`'; i++;
            let depth = 0;
            while (i < n) {
                if (src[i] === '\\') { out += '  '; i += 2; continue; }
                if (depth === 0 && src[i] === '`') break;
                if (src[i] === '$' && src[i + 1] === '{') { depth++; out += '${'; i += 2; continue; }
                if (depth > 0 && src[i] === '}') { depth--; out += '}'; i++; continue; }
                if (depth > 0) { out += src[i]; i++; continue; }
                out += src[i] === '\n' ? '\n' : ' '; i++;
            }
            out += '`'; i++; continue;
        }
        if (c === '/' && regexOk()) {
            let j = i + 1, inClass = false, ok = false;
            while (j < n && src[j] !== '\n') {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
                else if (src[j] === '/' && !inClass) { ok = true; break; }
                j++;
            }
            if (ok) { out += '/' + ' '.repeat(j - i - 1) + '/'; i = j + 1; continue; }
        }
        out += c; prev = c; i++;
    }
    return out;
}

// Functions: `function name(...) {`, `name(...) {` methods are rare here; arrows with a
// block body `(...) => {`. Each one's body is its matching brace range.
function functionsIn(rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = codeOnly(src);
    const lineAt = (() => { const starts = [0]; for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1);
        return pos => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; } return lo; }; })();
    const close = new Map(); const stack = [];
    for (let k = 0; k < code.length; k++) { if (code[k] === '{') stack.push(k); else if (code[k] === '}') { const o = stack.pop(); if (o !== undefined) close.set(o, k); } }
    const fns = [];
    const re = /\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{|(?:\(([^()]|\([^()]*\))*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
    let m;
    while ((m = re.exec(code))) {
        const open = m.index + m[0].length - 1;
        if (!close.has(open)) continue;
        let name = m[1];
        if (!name) { const before = code.slice(Math.max(0, m.index - 80), m.index); const nm = before.match(/([A-Za-z_$][\w$.]*)\s*[:=]\s*(?:async\s*)?$/); name = nm ? nm[1] : '(anonymous)'; }
        fns.push({ name, open, end: close.get(open) });
    }
    // own lines: code lines in the body minus lines that belong to nested functions
    const codeLines = new Set();
    code.split('\n').forEach((l, k) => { if (l.trim()) codeLines.add(k); });
    for (const f of fns) {
        const a = lineAt(f.open), b = lineAt(f.end);
        const nested = fns.filter(g => g !== f && g.open > f.open && g.end < f.end && !fns.some(h => h !== g && h !== f && h.open > f.open && h.end < f.end && g.open > h.open && g.end < h.end));
        let own = 0;
        for (let k = a; k <= b; k++) if (codeLines.has(k) && !nested.some(g => k > lineAt(g.open) && k < lineAt(g.end))) own++;
        f.own = own; f.line = a + 1; f.file = rel;
    }
    return fns;
}

// A browser file's module wrapper - `(function () { ... })();` holding the whole file -
// is not a function in this sense: its own lines are the file's constants, state and
// export lists. It is exempt; the functions inside it are not.
function isModuleWrapper(f, rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const head = src.slice(0, f.open + 1).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim();
    return f.name === '(anonymous)' && /^(?:'use strict';\s*)?\(\s*function\s*\(\s*\)\s*\{$/.test(head);
}

const all = [];
for (const f of ['server.js', ...files('lib', /\.js$/), ...files('src/js', /\.js$/)]) all.push(...functionsIn(f).filter(fn => !isModuleWrapper(fn, f)));
all.sort((a, b) => b.own - a.own);
const over = all.filter(f => f.own > CEILING);
const topN = process.argv.includes('--top') ? +process.argv[process.argv.indexOf('--top') + 1] : 0;
for (const f of (topN ? all.slice(0, topN) : over)) console.log(`  ${f.own > CEILING ? '[x]' : '   '} ${String(f.own).padStart(4)}  ${f.file}:${f.line}  ${f.name}`);
console.log(`check-functions: ${over.length ? over.length + ' function(s) over ' + CEILING + ' own lines FAILED' : 'every function under ' + CEILING + ' own lines ok'} (${all.length} functions)`);
process.exit(over.length ? 1 : 0);
