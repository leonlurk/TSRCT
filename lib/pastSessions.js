// lib/pastSessions.js - where a project's last Claude conversations left off.
//
// WHY (2026-09-25): asked "where did the HARBOR session I was preparing the demo
// in end up?", Tesla had no button, and `hands` spent 3 minutes on Opus finding
// the transcript and reading it with python3. This is that, in code: no model,
// no GPU, a few file reads.
//
// Claude Code keeps one JSONL per conversation under
// ~/.claude/projects/<cwd with every non-alphanumeric char as '-'>/. For the
// newest few it returns: when, his last request, and the last finished answer.
// Tesla's own hidden sessions (the Haiku brains, `hands`) also run in project
// folders; their first message gives them away and they are skipped.
//
// SecretCo: the project name and the folder are refused before a directory is
// listed, and the assembled result is checked again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 400 * 1024;      // transcripts reach megabytes; the end is what matters
const HEAD_BYTES = 16 * 1024;
// The first message of a session TSRCT opened for itself: a `hands` task, or
// one of the prompts lib/haikuBrain.js sends (its persona is a system-prompt
// file, so it never shows up as a message).
const OURS = /TAREA DE TESLA|COMANDO DE TESLA|^(Sesion: |CONTEXTO \(datos|\(Esto no lo dijo Leon|Leon te dice|Leon te pregunta)|CONTEXTO DE FONDO \(datos para entender la pantalla/;
const RESUMED = /^This session is being continued from a previous conversation/;

function dirFor(cwd) { return path.join(ROOT, String(cwd).replace(/[^A-Za-z0-9]/g, '-')); }

function readSlice(file, from, len) {
    const fd = fs.openSync(file, 'r');
    try {
        const b = Buffer.alloc(len);
        const n = fs.readSync(fd, b, 0, len, from);
        return b.slice(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
}

function rows(text) {
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* the cut line at the start of a tail */ }
    }
    return out;
}

function textOf(m) {
    const c = m && m.content;
    if (typeof c === 'string') return c;
    return (c || []).filter(p => p && p.type === 'text').map(p => p.text || '').join(' ');
}

// What he typed, without the harness wrapping around it.
function human(r) {
    if (r.type !== 'user' || !r.message || r.isMeta) return '';
    const t = textOf(r.message).replace(/<\/?pasted_content[^>]*>/g, '').trim();
    if (!t || /^<(command|local-command|system-reminder|task-notification)/.test(t) || /^Caveat:/.test(t)) return '';
    return t;
}

function summarize(file) {
    const size = fs.statSync(file).size;
    const head = rows(readSlice(file, 0, Math.min(size, HEAD_BYTES)));
    const first = head.map(human).find(Boolean) || '';
    if (OURS.test(first)) return null;
    const tail = rows(readSlice(file, Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)));
    let asked = '', answer = '', at = '';
    for (const r of tail) {
        const h = human(r);
        // A compaction summary is not something he asked.
        if (h && !RESUMED.test(h) && !/^\/[\w-]+\s*$/.test(h)) { asked = h; at = r.timestamp || at; }
        if (r.type === 'assistant' && r.message && r.message.stop_reason === 'end_turn') {
            const t = textOf(r.message).trim();
            if (t) { answer = t; at = r.timestamp || at; }
        }
    }
    if (!asked && !answer) return null;
    const flat = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
    return { id: path.basename(file, '.jsonl'), at, asked: flat(asked, 300), answer: flat(answer, 500) };
}

// { project, cwd } -> up to `limit` conversations, newest first.
function forFolder({ project, cwd }, limit = 3) {
    restrictedGuard.assertNotRestricted('past sessions', project || '', cwd || '');
    const dir = dirFor(cwd);
    let files = [];
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
            .map(f => { const p = path.join(dir, f); return { p, t: fs.statSync(p).mtimeMs }; })
            .sort((a, b) => b.t - a.t);
    } catch { return []; }
    const out = [];
    for (const f of files) {
        if (out.length >= limit) break;
        let s = null;
        try { s = summarize(f.p); } catch { s = null; }
        if (s) out.push(s);
    }
    restrictedGuard.assertNotRestricted('past sessions (result)', JSON.stringify(out));
    return out;
}

// Which transcript is this tmux session? Claude Code writes one record per live
// process in ~/.claude/sessions, with the tmux pane it runs in.
const CLAUDE_SESSIONS = process.env.CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
function sessionRecords() {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(CLAUDE_SESSIONS).filter(f => f.endsWith('.json')); } catch { return out; }
    for (const f of files) {
        try {
            const o = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS, f), 'utf8'));
            if (o && o.sessionId && o.cwd && typeof o.tmux === 'string') out.push(o);
        } catch { /* half-written or not ours */ }
    }
    return out;
}

function transcriptFor(session, paneCwd) {
    const mine = sessionRecords()
        .filter(r => r.tmux.split(':')[0] === session)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const r of mine) {
        const file = path.join(dirFor(r.cwd), `${r.sessionId}.jsonl`);
        if (fs.existsSync(file)) return { file, cwd: r.cwd, how: 'pane' };
    }
    // Fallback: the newest conversation in the pane's folder. Marked, because
    // with several sessions in one folder it can be another session's.
    let cwd = '';
    try { cwd = paneCwd ? paneCwd(session) : ''; } catch { cwd = ''; }
    if (!cwd) return null;
    try {
        const dir = dirFor(cwd);
        const newest = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
            .map(f => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)[0];
        return newest ? { file: newest.f, cwd, how: 'folder' } : null;
    } catch { return null; }
}

module.exports = { forFolder, dirFor, transcriptFor, _summarize: summarize };
