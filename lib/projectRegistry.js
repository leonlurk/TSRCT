'use strict';
// ── projectRegistry.js — "which folder is this project in?" ─────────────────
//
// WHY THIS EXISTS: nothing in TSRCT could answer that. The vault knows what a
// project IS (lib/dispatcher/projectContext.js reads vault/projects/*.md), tmux
// knows where a LIVE session happens to be (getSessionPwd), and the allowlist
// knows which roots are permissible — but no file mapped a project NAME to a
// working directory. A morning routine that is handed {"project":"TSRCT"} and
// has to open a session there needs exactly that mapping, and guessing it at the
// call site is how two callers end up guessing differently.
//
// Three sources, most trusted first:
//   1. an explicit override, saved by Leon           (config: project_dirs)
//   2. `path:` in the project's vault frontmatter    (projectContext)
//   3. a directory under PROJECTS_ROOT whose name matches by slug
//
// Two hard rules, both fail-closed:
//   - the directory must be inside the allowlist (same roots as the dispatcher's
//     tmuxAdapter, same env var), and it must exist;
//   - SecretCo/SecretCoSandbox is refused outright. That contract is Bedrock-only, and a
//     registry that can name the folder is one step from a routine opening a
//     session in it. The guard is required STANDALONE, never through the
//     dispatcher, so this cannot silently depend on an optional subsystem.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const PROJECTS_ROOT = paths.PROJECTS_ROOT;
// Same default and same env var as lib/dispatcher/tmuxAdapter.js: one allowlist,
// two readers. If they ever disagree, a session that the registry approves would
// be refused at creation — confusing, and only visible at 6am.
const ALLOWED_CWD_ROOTS = (process.env.DISPATCHER_CWD_ROOTS ||
    [paths.PROJECTS_ROOT, paths.HOME].join(',')).split(',').map(s => s.trim()).filter(Boolean);

let deps = { getConfig: null, setConfig: null, projectContext: null };

function configure(injected) {
    deps = { ...deps, ...(injected || {}) };
}

function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isAllowed(dir) {
    if (!dir) return false;
    const abs = path.resolve(dir);
    return ALLOWED_CWD_ROOTS.some(root => abs === root || abs.startsWith(root + '/'));
}

// May a spawned session answer Claude's "do you trust this folder?" with yes?
// Only a real folder INSIDE PROJECTS_ROOT (which he trusts as a whole) and never
// SecretCo. Asked per subfolder all the same, and the morning routine opened
// sessions that sat on that question (2026-09-23). realpath, so a symlink inside
// PROJECTS cannot carry the yes somewhere else.
function mayAutoTrust(dir) {
    let real, root;
    try { real = fs.realpathSync(String(dir || '')); root = fs.realpathSync(PROJECTS_ROOT); } catch { return false; }
    if (!real.startsWith(root + '/')) return false;
    if (restrictedGuard.mentionsRestricted(real, path.basename(real))) return false;
    return isDir(real);
}

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ── overrides ────────────────────────────────────────────────────────────────
function overrides() {
    try {
        const raw = deps.getConfig && deps.getConfig('project_dirs');
        const o = raw ? JSON.parse(raw) : {};
        return (o && typeof o === 'object') ? o : {};
    } catch { return {}; }
}

function setPath(name, dir) {
    const key = slugify(name);
    if (!key) return { ok: false, error: 'project name required' };
    const abs = dir ? path.resolve(dir) : '';
    if (abs) {
        if (!isAllowed(abs)) return { ok: false, error: `outside the allowed roots: ${abs}` };
        if (!isDir(abs)) return { ok: false, error: `not a directory: ${abs}` };
        if (restrictedGuard.mentionsRestricted(abs, name)) return { ok: false, error: new restrictedGuard.RestrictedProjectError('project registry').message };
    }
    const o = overrides();
    if (abs) o[key] = abs; else delete o[key];
    if (deps.setConfig) deps.setConfig('project_dirs', JSON.stringify(o));
    return { ok: true, project: key, cwd: abs || null };
}

// ── the scan ─────────────────────────────────────────────────────────────────
// Directories under PROJECTS_ROOT, indexed by slug. Re-read on demand rather
// than cached forever (a new project folder should not need a restart to be
// findable), but held for a few seconds: list() resolves every key, and every
// resolve used to readdir the whole tree again - over /mnt/c, that adds up.
//
// One level down too, but only inside a CONTAINER (2026-10-05): "abrime una
// sesion en mi aplicacion personal de corredor" was personal/runner-app, which
// did not exist for anything here. A container is a folder that is not a
// project itself (no README, CLAUDE.md, package.json, .git, sfdx-project.json,
// pyproject.toml at its root); its project-looking children are named
// `<container>-<child>` (personal-runner-app, the shape personal-factory already
// had). A real project's own subfolders (marketing-stack/frontend) stay its parts.
const MARKERS = ['README.md', 'CLAUDE.md', 'package.json', '.git', 'sfdx-project.json', 'pyproject.toml', 'requirements.txt', 'index.html'];
function looksLikeProject(dir) {
    return MARKERS.some(m => { try { return fs.existsSync(path.join(dir, m)); } catch { return false; } });
}
// A child with nothing but a README that is an Obsidian note (frontmatter
// first) is a section of a knowledge base - acmecloudco-brain/advisors,
// implementor-brain/playbooks - not something he opens a session in.
function looksLikeChildProject(dir) {
    if (MARKERS.filter(m => m !== 'README.md').some(m => { try { return fs.existsSync(path.join(dir, m)); } catch { return false; } })) return true;
    try { return !/^---\s*\n/.test(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').slice(0, 10)); } catch { return false; }
}
const SCAN_MS = 5000;
let scanned = { root: '', at: 0, map: null };
function scanDirs(root = PROJECTS_ROOT) {
    if (scanned.map && scanned.root === root && Date.now() - scanned.at < SCAN_MS) return scanned.map;
    const out = new Map();
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const abs = path.join(root, e.name);
        if (restrictedGuard.mentionsRestricted(abs, e.name)) continue;      // never indexed
        out.set(slugify(e.name), abs);
        if (looksLikeProject(abs)) continue;
        let kids = [];
        try { kids = fs.readdirSync(abs, { withFileTypes: true }); } catch { kids = []; }
        for (const k of kids) {
            if (!k.isDirectory() || /^[._]/.test(k.name) || k.name === 'node_modules') continue;
            const kabs = path.join(abs, k.name);
            if (restrictedGuard.mentionsRestricted(kabs, k.name) || !looksLikeChildProject(kabs)) continue;
            const key = slugify(`${e.name}-${k.name}`);
            if (!out.has(key)) out.set(key, kabs);
        }
    }
    scanned = { root, at: Date.now(), map: out };
    return out;
}

// What a folder IS, in one line. His vault note first - written in his words,
// "## What It Is" - then the folder's own README / CLAUDE.md: the title and the
// first real sentence. Cached by path + mtime, so asking twice reads nothing.
const about = new Map();
function summarize(raw, fromVault) {
    let body = String(raw || '').replace(/^---\n[\s\S]*?\n---\n/, '');
    if (fromVault) {
        // Only the section written for this. A note without it starts with
        // whatever was pasted first (a transcript path, a prompt, a story).
        const m = /##\s*What It Is\s*\n([\s\S]*?)(\n##\s|$)/i.exec(body);
        if (!m) return '';
        body = m[1];
    }
    const lines = body.split('\n').map(l => l.trim());
    const title = fromVault ? '' : ((lines.find(l => /^#\s/.test(l)) || '').replace(/^#+\s*/, '')).replace(/[*`_]/g, '').trim();
    // The paragraph, joined, so a sentence wrapped over two lines is not cut in half.
    const start = lines.findIndex(l => l && !/^[#>|`\-*!<[=]/.test(l) && !/^\d+\./.test(l) && !/^tags:/.test(l) && l.length > 20);
    if (start < 0) return title;
    let para = '';
    for (let i = start; i < lines.length && lines[i]; i++) para += (para ? ' ' : '') + lines[i];
    para = para.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`_]/g, '');
    const first = (para.match(/^.*?[.!?](\s|$)/) || [para])[0].trim().slice(0, 160);
    return [title && title.length < 60 ? title : '', first].filter(Boolean).join(' - ');
}
function readSummary(fp, fromVault) {
    let st;
    try { st = fs.statSync(fp); } catch { return null; }
    const hit = about.get(fp);
    if (hit && hit.mtime === st.mtimeMs) return hit.text;
    let raw = '';
    try { raw = fs.readFileSync(fp, 'utf8').slice(0, 6000); } catch { return null; }
    const text = summarize(raw, fromVault);
    about.set(fp, { mtime: st.mtimeMs, text });
    return text;
}
// vault/projects/**/*.md, by the folder it names (`path:` in its frontmatter)
// and by its own name. Rebuilt with the scan.
function vaultNotes(root) {
    const byPath = new Map(), byName = new Map();
    const dir = path.join(root, 'vault', 'projects');
    const walk = (d) => {
        let es = [];
        try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of es) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!e.name.endsWith('.md') || restrictedGuard.mentionsRestricted(p, e.name)) continue;
            byName.set(slugify(e.name.replace(/\.md$/, '')), p);
            let head = '';
            try { head = fs.readFileSync(p, 'utf8').slice(0, 600); } catch { head = ''; }
            const m = /^path:\s*(.+)$/m.exec(head);
            if (m) byPath.set(path.resolve(m[1].trim().replace(/^["']|["']$/g, '')), p);
        }
    };
    walk(dir);
    return { byPath, byName };
}
function describe(dir, key, notes) {
    const note = (notes && (notes.byPath.get(dir) || notes.byName.get(key) || notes.byName.get(slugify(path.basename(dir))))) || '';
    if (note) { const t = readSummary(note, true); if (t) return t; }
    for (const f of ['README.md', 'CLAUDE.md']) {
        const t = readSummary(path.join(dir, f), false);
        if (t) return t;
    }
    return '';
}

// Every folder he has, in plain words, for the voice: "- key (where): what it is".
// Handed to the hidden Haiku brain when it starts, so "mi app de correr" or "lo
// de los abogados" can be matched by meaning instead of by a folder name.
function mapText(root = PROJECTS_ROOT) {
    const lines = [];
    const notes = vaultNotes(root);
    const dirs = scanDirs(root);
    for (const [key, abs] of dirs) {
        const kids = [...dirs].filter(([, v]) => v.startsWith(abs + path.sep)).map(([k]) => k);
        const hasNote = notes.byPath.has(abs) || notes.byName.has(key);
        // env/, files/, images/ are not places he works in.
        if (!looksLikeProject(abs) && !kids.length && !hasNote) continue;
        const rel = path.relative(root, abs).split(path.sep).join('/');
        // A container is described by what it holds, never by a note that
        // happens to point at it (personal/ was reading as a money dashboard).
        const what = kids.length && !looksLikeProject(abs)
            ? `carpeta que agrupa: ${kids.join(', ')}`
            : describe(abs, key, notes);
        const line = `- ${key} (${rel})${what ? `: ${what}` : ''}`;
        if (!restrictedGuard.mentionsRestricted(line)) lines.push(line);
    }
    return lines.join('\n');
}

function vaultPaths() {
    const out = new Map();
    const pc = deps.projectContext;
    if (!pc || typeof pc.getProjects !== 'function') return out;
    let list = [];
    try { list = pc.getProjects() || []; } catch { return out; }
    for (const p of list) {
        if (!p || !p.name) continue;
        if (restrictedGuard.mentionsRestricted(p.path || '', p.name)) continue;
        if (p.path) out.set(slugify(p.name), path.resolve(p.path));
        else if (!out.has(slugify(p.name))) out.set(slugify(p.name), null);   // known, location unknown
    }
    return out;
}

// resolve('TSRCT') -> { project, cwd, source } | { error }
// Also accepts an absolute path, so a caller that already knows the directory
// gets the same SecretCo + allowlist + existence checks for free.
function resolve(nameOrPath) {
    const raw = String(nameOrPath || '').trim();
    if (!raw) return { error: 'no project given' };

    if (raw.startsWith('/')) {
        const abs = path.resolve(raw);
        if (restrictedGuard.mentionsRestricted(abs, raw)) return { error: new restrictedGuard.RestrictedProjectError('project registry').message };
        if (!isAllowed(abs)) return { error: `outside the allowed roots: ${abs}` };
        if (!isDir(abs)) return { error: `not a directory: ${abs}` };
        return { project: slugify(path.basename(abs)), cwd: abs, source: 'path' };
    }

    if (restrictedGuard.mentionsRestricted(raw, raw)) return { error: new restrictedGuard.RestrictedProjectError('project registry').message };
    const key = slugify(raw);
    if (!key) return { error: `cannot read a project name from ${JSON.stringify(raw)}` };

    const tries = [
        ['override', overrides()[key]],
        ['vault', vaultPaths().get(key)],
        ['scan', scanDirs().get(key)],
    ];
    for (const [source, cwd] of tries) {
        if (!cwd) continue;
        const abs = path.resolve(cwd);
        if (restrictedGuard.mentionsRestricted(abs, key)) return { error: new restrictedGuard.RestrictedProjectError('project registry').message };
        if (!isAllowed(abs)) continue;
        if (!isDir(abs)) continue;
        return { project: key, cwd: abs, source };
    }
    return { error: `no directory known for "${raw}" - set one with the project registry` };
}

// Everything the registry can name, for the UI and for a job's prompt (a model
// that is told the real list stops inventing project names).
function list() {
    const o = overrides();
    const v = vaultPaths();
    const s = scanDirs();
    const keys = new Set([...Object.keys(o), ...v.keys(), ...s.keys()]);
    const out = [];
    for (const key of keys) {
        const r = resolve(key);
        out.push({
            project: key,
            cwd: r.cwd || null,
            source: r.source || null,
            known: !r.error,
            why: r.error || '',
            inVault: v.has(key),
        });
    }
    out.sort((a, b) => (b.known - a.known) || a.project.localeCompare(b.project));
    return out;
}

module.exports = { configure, resolve, list, setPath, slugify, isAllowed, mayAutoTrust, mapText, PROJECTS_ROOT, ALLOWED_CWD_ROOTS, _scan: scanDirs, _mapText: mapText };
