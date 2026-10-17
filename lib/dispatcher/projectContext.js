// Reads the Obsidian vault project pages to provide Hermes with real project context.
// Cached in-memory; refresh() to reload after edits.

const fs = require('fs');
const path = require('path');
const paths = require('../paths');

const VAULT_PROJECTS = process.env.VAULT_PROJECTS_DIR || path.join(paths.VAULT_ROOT, 'projects');

const HINTS_PATH = path.join(__dirname, 'projectHints.json');

let cache = null;

function loadHints() {
    try {
        const raw = fs.readFileSync(HINTS_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        console.warn(`[projectContext] could not load projectHints.json: ${e.message}`);
        return {};
    }
}

function slugify(name) {
    return name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function parseFrontmatter(text) {
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    m[1].split('\n').forEach(line => {
        const kv = line.match(/^([^:]+):\s*(.*)$/);
        if (kv) meta[kv[1].trim()] = kv[2].trim();
    });
    return { meta, body: m[2] };
}

function extractDescription(body) {
    const m = body.match(/##\s*What It Is\s*\n+([\s\S]*?)(?=\n##\s|\n$)/i);
    if (m) return m[1].trim().split('\n')[0].slice(0, 400);
    const para = body.split('\n\n').find(p => p.trim() && !p.startsWith('#'));
    return para ? para.trim().slice(0, 400) : '';
}

function load() {
    const projects = [];
    if (!fs.existsSync(VAULT_PROJECTS)) {
        console.warn(`[projectContext] vault projects dir not found: ${VAULT_PROJECTS}`);
        return projects;
    }
    const hints = loadHints();
    const files = fs.readdirSync(VAULT_PROJECTS).filter(f => f.endsWith('.md'));
    for (const file of files) {
        try {
            const raw = fs.readFileSync(path.join(VAULT_PROJECTS, file), 'utf8');
            const { meta, body } = parseFrontmatter(raw);
            const name = path.basename(file, '.md');
            let description = extractDescription(body);
            const hint = hints[name] && hints[name].hint;
            if (hint) {
                description = description
                    ? `${description}\n[Disambiguation] ${hint}`
                    : `[Disambiguation] ${hint}`;
            }
            projects.push({
                name,
                slug: slugify(name),
                path: meta.path || null,
                status: meta.status || null,
                description,
                // Optional explicit session pin from projectHints.json — when this
                // session is live, the dispatcher routes here instead of trusting
                // Hermes's fuzzy session match.
                pinned_session: (hints[name] && hints[name].session) || null,
                session_alias: `cc-${slugify(name)}`,
            });
        } catch (e) {
            console.error(`[projectContext] failed to parse ${file}:`, e.message);
        }
    }
    return projects;
}

function getProjects() {
    if (!cache) cache = load();
    return cache;
}

function refresh() {
    cache = load();
    return cache;
}

function getProjectByName(name) {
    if (!name) return null;
    const norm = name.toLowerCase();
    return getProjects().find(p =>
        p.name.toLowerCase() === norm || p.slug === slugify(name)
    );
}

module.exports = { getProjects, refresh, getProjectByName, slugify };
