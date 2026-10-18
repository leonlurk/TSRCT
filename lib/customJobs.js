'use strict';
// lib/customJobs.js - automations a person adds from the Automations tab.
//
// The built-in jobs are written in code (lib/automations.js). These are data:
// at a time of day, on the days chosen, do ONE of two things:
//   session - open a new Claude Code session in a project folder and give it a
//             prompt ("run the tests and tell me what failed"). The session is
//             an ordinary visible one: its permission questions reach the
//             approver like any other, and it can be opened and stopped;
//   script  - run a script file from the projects folder, argv only, no shell.
// They go through the same scheduler as the built-in jobs, so they get the same
// card, history, missed-run alert and switch.
//
// Limits, checked on create AND before every run: the folder or the script must
// be inside PROJECTS_ROOT, and nothing may name a restricted project. Stored in
// .tsrct/custom-automations.json.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const restrictedGuard = require('./dispatcher/restrictedGuard');
const { stateFile } = require('./stateFile');

const FILE = process.env.CUSTOM_AUTOMATIONS_FILE || stateFile('custom-automations.json', '.tsrct-custom-automations.json');
const MAX_JOBS = 20;
const SCRIPT_TIMEOUT_MS = 15 * 60 * 1000;

let deps = { scheduler: null, spawn: null, sessionExists: () => false, runScript: null };
function configure(d) { deps = { ...deps, ...(d || {}) }; }

function load() {
    try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function save(list) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

// Inside PROJECTS_ROOT, after resolving `..` and symlinks of the parts that exist.
function inside(p) {
    const root = path.resolve(paths.PROJECTS_ROOT);
    let real = path.resolve(String(p || ''));
    try { real = fs.realpathSync(real); } catch { /* checked for existence below */ }
    return real !== root && real.startsWith(root + path.sep) ? real : null;
}

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'job';

function validate(input) {
    const j = input || {};
    const title = String(j.title || '').trim().slice(0, 60);
    if (!title) return { error: 'give it a name' };
    const at = String(j.at || '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return { error: 'the time must be HH:MM, 24h' };
    const days = Array.isArray(j.days) ? [...new Set(j.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
    const out = { title, at, days, kind: j.kind };
    if (j.kind === 'session') {
        const cwd = inside(j.cwd);
        if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { error: 'the folder must be one of your project folders' };
        const prompt = String(j.prompt || '').trim().slice(0, 4000);
        if (!prompt) return { error: 'say what the session should do' };
        Object.assign(out, { cwd, prompt });
    } else if (j.kind === 'script') {
        const file = inside(j.file);
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return { error: 'the script must be a file inside your projects folder' };
        out.file = file;
    } else {
        return { error: 'kind must be session or script' };
    }
    if (restrictedGuard.mentionsRestricted(out.title, out.cwd, out.prompt, out.file)) return { error: 'that names a restricted project, so TSRCT will not automate it' };
    return { job: out };
}

async function runOne(job) {
    // Checked again at run time: a folder can be renamed or a restriction added.
    const again = validate(job);
    if (again.error) throw new Error(again.error);
    if (job.kind === 'script') {
        const r = await deps.runScript({ file: job.file, cwd: path.dirname(job.file), timeoutMs: SCRIPT_TIMEOUT_MS });
        if (r.timedOut) throw new Error('stopped after 15 min without finishing');
        if (r.error) throw new Error(r.error);
        if (r.code !== 0) throw new Error(`the script ended with code ${r.code}`);
        return { summary: 'Script finished' };
    }
    let name = `auto-${slug(job.title)}`.slice(0, 40);
    for (let n = 2; deps.sessionExists(name) && n < 50; n++) name = `auto-${slug(job.title)}-${n}`.slice(0, 44);
    const r = await deps.spawn({ name, cwd: job.cwd, prompt: job.prompt });
    if (!r || !r.ok) throw new Error((r && r.error) || 'the session did not start');
    return { summary: `Opened ${r.session || name}` };
}

function registerOne(job) {
    if (!deps.scheduler) return;
    deps.scheduler.register({
        name: job.id, at: job.at, days: job.days, window: 2,
        description: job.title,
        run: () => runOne(job),
    });
}

function create(input) {
    const v = validate(input);
    if (v.error) return { ok: false, error: v.error };
    const list = load();
    if (list.length >= MAX_JOBS) return { ok: false, error: `at most ${MAX_JOBS} of your own automations` };
    let id = `my-${slug(v.job.title)}`;
    for (let n = 2; list.some(j => j.id === id); n++) id = `my-${slug(v.job.title)}-${n}`;
    const job = { id, ...v.job, created: Date.now() };
    list.push(job);
    save(list);
    registerOne(job);
    return { ok: true, id };
}

function remove(id) {
    const list = load();
    const i = list.findIndex(j => j.id === id);
    if (i === -1) return { ok: false, error: 'only your own automations can be deleted' };
    list.splice(i, 1);
    save(list);
    if (deps.scheduler && deps.scheduler.unregister) deps.scheduler.unregister(id);
    return { ok: true };
}

function registerAll(scheduler) {
    if (scheduler) deps.scheduler = scheduler;
    for (const job of load()) {
        try { registerOne(job); } catch (e) { console.error(`[automations] could not register ${job.id}: ${e.message}`); }
    }
}

// What the Automations tab draws, in the catalogue's shape.
function items() {
    return load().map(j => ({
        id: j.id, kind: 'job', group: 'mine', title: j.title, custom: true,
        blurb: j.kind === 'session' ? `Opens a Claude Code session in ${path.basename(j.cwd)}: "${j.prompt.slice(0, 120)}"` : `Runs ${path.relative(paths.PROJECTS_ROOT, j.file)}`,
    }));
}

module.exports = { configure, create, remove, registerAll, items, validate, FILE, MAX_JOBS };
