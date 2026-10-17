#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/check-handlers.js — every inline handler name must resolve globally.
//
// Run: node scripts/check-handlers.js        (exit 0 = clean, 1 = dead handlers)
//      node scripts/check-handlers.js -v     (also list what each file exports)
//
// THE DEFECT CLASS THIS CLOSES
// TSRCT binds behavior through inline attributes (onclick=, onchange=, ...).
// Most JS files are IIFE-wrapped, so a function is private unless it appears in
// the file's explicit window.* export block. The block is written by hand, and
// it reliably covers the handlers in index.html while forgetting the handlers a
// module writes into its OWN generated HTML -- those are the same kind of call
// site, just harder to see. The result is a button that silently does nothing:
// no build error, no console error until someone clicks it.
// The 2026-08-14 audit found 8 of these by hand. This is that check, automated.
//
// WHAT COUNTS AS "RESOLVES"
// An inline handler runs in global scope, so a name resolves if it is either:
//   (a) assigned onto window/globalThis anywhere, or
//   (b) declared at the top level of a CLASSIC, non-IIFE script (a top-level
//       const/let/class is not on window, but it IS in the global lexical
//       environment, which inline handlers can see).
// Neither applies inside an IIFE, and nothing applies inside type="module" --
// remote-desktop.js is a module, so only its explicit window.rd* lines count.
//
// This is deliberately a STATIC check: no browser, no server, no auth. It runs
// in a second and can gate a commit. It errs toward reporting: a name it cannot
// prove resolvable is listed, so a false positive costs you a glance, while a
// miss costs a dead button.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('-v');

// Names an inline handler can use without anyone declaring them.
const BUILTINS = new Set([
    // language + control flow that can appear before a paren
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete',
    'void', 'in', 'of', 'do', 'else', 'try', 'function', 'await', 'yield',
    // the handler's own scope
    'event', 'this', 'arguments',
    // globals
    'window', 'document', 'globalThis', 'self', 'navigator', 'location', 'history',
    'console', 'Math', 'JSON', 'Date', 'Object', 'Array', 'String', 'Number',
    'Boolean', 'RegExp', 'Error', 'Promise', 'Map', 'Set', 'Symbol', 'BigInt',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
    'decodeURIComponent', 'encodeURI', 'decodeURI', 'alert', 'confirm', 'prompt',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
    'fetch', 'FormData', 'Blob', 'File', 'FileReader', 'URL', 'Image', 'Audio',
    'localStorage', 'sessionStorage', 'CustomEvent', 'Event', 'Intl', 'structuredClone',
    'queueMicrotask', 'AbortController', 'IntersectionObserver', 'MutationObserver',
    'ResizeObserver', 'Notification', 'WebSocket', 'EventSource', 'Worker',
]);

// Blank out comments and string/template literals so brace counting and
// identifier scanning cannot be fooled by text inside them. Keeps offsets and
// newlines intact so reported line numbers stay correct.
function blankLiterals(src) {
    let out = '';
    let i = 0;
    const keep = (ch) => (ch === '\n' ? '\n' : ' ');
    while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (c === '/' && n === '/') {
            while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
        } else if (c === '/' && n === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end === -1 ? src.length : end + 2;
            for (; i < stop; i++) out += keep(src[i]);
        } else if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            out += quote; i++;
            while (i < src.length) {
                if (src[i] === '\\') { out += '  '; i += 2; continue; }
                if (src[i] === quote) { out += quote; i++; break; }
                out += keep(src[i]); i++;
            }
        } else {
            out += c; i++;
        }
    }
    return out;
}

// Declarations sitting at brace depth 0 of a classic script.
function topLevelDeclarations(src) {
    const clean = blankLiterals(src);
    const names = [];
    let depth = 0;
    const re = /([{}])|(?:^|[^\w$.])(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*))/g;
    let m;
    while ((m = re.exec(clean))) {
        if (m[1] === '{') { depth++; continue; }
        if (m[1] === '}') { depth = Math.max(0, depth - 1); continue; }
        if (depth === 0) names.push(m[2] || m[3] || m[4]);
    }
    return names;
}

const jsFiles = fs
    .readdirSync(path.join(ROOT, 'src/js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => 'src/js/' + f);
const SOURCES = ['src/index.html', ...jsFiles];

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── is this file scope-isolated? ─────────────────────────────────────────
// An IIFE or an ES module keeps its top-level declarations private, so only
// explicit window.* assignments from it are global.
function isScopeIsolated(rel, src) {
    // type="module" is declared at the call site, in index.html
    if (MODULE_SCRIPTS.has('/' + rel)) return true;
    const head = src
        .split('\n')
        .filter((l) => {
            const t = l.trim();
            return t && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')
                && t !== "'use strict';" && t !== '"use strict";';
        })
        .slice(0, 3)
        .join(' ');
    return /^\(\s*(async\s+)?(function|\()/.test(head.trim());
}

const html = read('src/index.html');
const MODULE_SCRIPTS = new Set(
    [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1])
        .concat([...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*type="module"/g)].map((m) => m[1]))
);

// ── 1. the global name set ───────────────────────────────────────────────
const globals = new Map(); // name -> source file

function addGlobal(name, file) {
    if (!globals.has(name)) globals.set(name, file);
}

for (const rel of jsFiles) {
    const src = read(rel);
    const isolated = isScopeIsolated(rel, src);

    // (a) explicit window/globalThis assignments -- always global
    for (const m of src.matchAll(/(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=/g)) {
        addGlobal(m[1], rel);
    }
    // window.foo ||= / ??= and defineProperty
    for (const m of src.matchAll(/(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*(?:\|\||\?\?)=/g)) {
        addGlobal(m[1], rel);
    }
    for (const m of src.matchAll(/defineProperty\(\s*(?:window|globalThis)\s*,\s*['"]([A-Za-z_$][\w$]*)['"]/g)) {
        addGlobal(m[1], rel);
    }
    // Object.assign(window, { a, b, c: fn, 'd': fn })
    for (const m of src.matchAll(/Object\.assign\(\s*(?:window|globalThis)\s*,\s*\{/g)) {
        const start = m.index + m[0].length - 1;
        let depth = 0, end = start;
        for (let i = start; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        const body = src.slice(start + 1, end);
        for (const k of body.matchAll(/(?:^|[,{\s])['"]?([A-Za-z_$][\w$]*)['"]?\s*(?::|,|$)/gm)) {
            addGlobal(k[1], rel);
        }
    }

    // (b) top-level declarations, only in a classic non-IIFE script.
    // Must be BRACE-DEPTH 0, not column 0: app.js is a bare classic script whose
    // whole body is indented 8 spaces (it used to live inline in index.html), so
    // an indentation heuristic silently drops every global it defines.
    if (!isolated) {
        for (const d of topLevelDeclarations(src)) addGlobal(d, rel);
    }
}

// ── 2. every inline handler call site ────────────────────────────────────
// Strip string literals and ${...} interpolation from a handler body first, so
// text inside a quoted argument cannot masquerade as an identifier.
function identifiersCalledIn(body) {
    const cleaned = stripInterpolations(body)
        // A handler built by JS string CONCATENATION -- e.g.
        //   'onclick="codemapRegen(\'' + esc(s.name) + '\')"'
        // -- puts render-time code inside the captured attribute value. Those
        // names run in module scope when the HTML is BUILT, not in global scope
        // when the user clicks, so they must not be treated as call sites.
        .replace(/['"]\s*\+[\s\S]*?\+\s*['"]/g, "''")
        // a trailing concat with no closing quote: ' + expr
        .replace(/['"]\s*\+[\s\S]*$/g, "''")
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/&quot;(?:(?!&quot;).)*&quot;/g, ' ')
        .replace(/&#39;(?:(?!&#39;).)*&#39;/g, ' ');
    const names = new Set();
    // a call: NAME( ... ) or NAME.prop.prop( ... ) -- the ROOT is what must exist
    for (const m of cleaned.matchAll(/([A-Za-z_$][\w$]*)\s*(?:\.\s*[\w$]+\s*)*\(/g)) {
        const root = m[1];
        // skip a method call on something already qualified: `.foo(`
        const before = cleaned.slice(Math.max(0, m.index - 1), m.index);
        if (before === '.') continue;
        names.add(root);
    }
    return names;
}

// `${...}` in a template literal is render-time code, and it nests -- a lazy
// [^}]* stops at the first inner brace and leaks the rest into the scan.
function stripInterpolations(s) {
    let out = '', i = 0;
    while (i < s.length) {
        if (s[i] === '$' && s[i + 1] === '{') {
            let depth = 0;
            while (i < s.length) {
                if (s[i] === '{') depth++;
                else if (s[i] === '}') { depth--; if (depth === 0) { i++; break; } }
                i++;
            }
            out += ' ';
        } else {
            out += s[i]; i++;
        }
    }
    return out;
}

const HANDLER_ATTR = /\bon([a-z]{3,})\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
const callSites = []; // {file, line, attr, name}

for (const rel of SOURCES) {
    const src = read(rel);
    const lineOf = (idx) => src.slice(0, idx).split('\n').length;
    for (const m of src.matchAll(HANDLER_ATTR)) {
        const attr = 'on' + m[1];
        const body = m[2] ?? m[3] ?? m[4] ?? '';
        if (!body.trim()) continue;
        for (const name of identifiersCalledIn(body)) {
            if (BUILTINS.has(name)) continue;
            callSites.push({ file: rel, line: lineOf(m.index), attr, name });
        }
    }
}

// The global name set, for anything else that needs to know whether a name
// resolves — scripts/check-ui.js asks it whether the buttons the ASSISTANT
// presses still exist. Exported rather than reimplemented: a second copy of
// these rules would drift, and the subtle half (brace-depth-zero declarations
// in a classic script) is exactly the half a copy gets wrong.
module.exports = { globals };
if (require.main !== module) return;

// ── 3. report ────────────────────────────────────────────────────────────
const unresolved = callSites.filter((c) => !globals.has(c.name));
const byName = new Map();
for (const c of unresolved) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
}

const distinct = new Set(callSites.map((c) => c.name));
console.log(
    `[check-handlers] ${callSites.length} inline handler call sites, ` +
    `${distinct.size} distinct names, ${globals.size} global names available`
);

if (VERBOSE) {
    const perFile = new Map();
    for (const [n, f] of globals) perFile.set(f, (perFile.get(f) || 0) + 1);
    for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(n).padStart(4)}  ${f}`);
    }
}

if (byName.size === 0) {
    console.log('[check-handlers] OK — every inline handler name resolves in global scope');
    process.exit(0);
}

console.error(`\n[check-handlers] ${byName.size} name(s) referenced by an inline handler but never exported:\n`);
for (const [name, sites] of [...byName].sort()) {
    console.error(`  ${name}()`);
    for (const s of sites.slice(0, 4)) {
        console.error(`      ${s.file}:${s.line}  (${s.attr})`);
    }
    if (sites.length > 4) console.error(`      ... and ${sites.length - 4} more call site(s)`);
}
console.error(
    `\n  These are dead controls: clicking them throws ReferenceError.\n` +
    `  Fix by adding the name to its module's window.* export block --\n` +
    `  the block usually covers index.html and forgets module-generated HTML.\n`
);
process.exit(1);
