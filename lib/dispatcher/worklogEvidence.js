// Worklogs [?] — "where did this suggestion come from?"
//
// The analyst cites its own evidence (why + quotes) when it proposes a worklog, but a
// model can misquote. So before the modal shows a quote, this module goes back to the
// file it names and checks the text is really there: vault notes by content, session
// transcripts line by line (also recovering the real time of that line). Slack and
// Calendar quotes cannot be re-read from here and are labelled as not checked.
//
// Independently of the model, it also searches that day's own prompts, session titles
// and vault notes for the entry's words, so an entry with no (or bad) citations still
// shows Leon something to jog his memory.
//
// SECRETCO: an SecretCo entry returns nothing; paths/lines/notes that mention SecretCo are
// never opened or returned.

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');
const readline = require('readline');
const restrictedGuard = require('./restrictedGuard');
const hours = require('./hoursEstimator');

const VAULT_ROOT = paths.VAULT_ROOT;
const SESSIONS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const TZ_MS = 3 * 3600 * 1000;

const STOP = new Set(('para with from that this have what como pero esta este esto todo todos with into over sobre desde hasta cuando donde porque tambien fixed added updated '
    + 'review daily meeting work session sessions test tests testing done then than they them their there were will your nuestro nuestra hacer hecho').split(' '));

function fold(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
// Letters and digits only: survives JSON escaping, markdown, line wraps and punctuation.
function squash(s) {
    return fold(String(s || '')
        .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\[nrt"\\]/g, ' ')).replace(/[^a-z0-9]+/g, '');
}
function keywords(...texts) {
    const out = new Set();
    for (const t of texts) for (const w of fold(t).split(/[^a-z0-9]+/)) if (w.length >= 4 && !STOP.has(w)) out.add(w);
    return Array.from(out).slice(0, 20);
}
const hhmm = (ms) => new Date(ms - TZ_MS).toISOString().slice(11, 16);

// Only files inside the vault or the session logs, never SecretCo.
function safePath(ref) {
    const raw = String(ref || '').split(' @')[0].trim();
    if (!raw.startsWith('/') || restrictedGuard.mentionsRestricted(raw)) return null;
    const p = path.resolve(raw);
    const inside = [VAULT_ROOT, SESSIONS_ROOT].some(root => p.startsWith(root + path.sep));
    if (!inside) return null;
    try { if (!fs.statSync(p).isFile()) return null; } catch { return null; }
    return p;
}

async function findInSession(file, needle, workDate) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    let fallback = null;
    for await (const line of rl) {
        if (!squash(line).includes(needle)) continue;
        const m = /"timestamp":"([^"]+)"/.exec(line);
        const ms = m ? Date.parse(m[1]) : NaN;
        const at = isFinite(ms) ? { time: hhmm(ms), date: new Date(ms - TZ_MS).toISOString().slice(0, 10) } : {};
        if (!workDate || at.date === workDate) { rl.close(); return { found: true, ...at }; }
        if (!fallback) fallback = { found: true, ...at, other_day: true };
    }
    return fallback || { found: false };
}

async function checkItem(item, workDate) {
    const out = { source: item.source, ref: item.ref, quote: item.quote, status: 'not_checked' };
    if (!['vault', 'session'].includes(item.source)) return out;
    const p = safePath(item.ref);
    const needle = squash(item.quote).slice(0, 80);
    if (!p || needle.length < 12) { out.status = p ? 'too_short' : 'no_file'; return out; }
    out.file = p;
    try {
        if (p.endsWith('.jsonl')) {
            const r = await findInSession(p, needle, workDate);
            out.status = r.found ? (r.other_day ? 'found_other_day' : 'found') : 'not_found';
            if (r.time) out.time = r.time;
            if (r.date) out.found_date = r.date;
        } else {
            const st = fs.statSync(p);
            if (st.size > 3 * 1024 * 1024) { out.status = 'not_checked'; return out; }
            out.status = squash(fs.readFileSync(p, 'utf8')).includes(needle) ? 'found' : 'not_found';
        }
    } catch { out.status = 'no_file'; }
    return out;
}

// The day's own traces that share words with the entry (model-independent).
async function autoMatches(row) {
    const kw = keywords(row.comment, row.task_name, row.project);
    const proj = fold(row.project).replace(/[^a-z0-9]+/g, '');
    const result = { keywords: kw, prompts: [], notes: [] };
    if (!kw.length || !/^\d{4}-\d\d-\d\d$/.test(row.work_date || '')) return result;
    const score = (text) => { const f = fold(text); return kw.reduce((a, w) => a + (f.includes(w) ? 1 : 0), 0); };

    const [day] = await hours.scanDays([row.work_date]);
    const cands = [];
    for (const p of (day && day.projects) || []) {
        const sameProj = proj && fold(p.name).replace(/[^a-z0-9]+/g, '').includes(proj.slice(0, 8));
        for (const t of p.titles) { const s = score(t) + (sameProj ? 1 : 0); if (s) cands.push({ score: s + 0.5, project: p.name, kind: 'title', text: t }); }
        for (const x of p.prompts) {
            const s = score(x.text) + (sameProj ? 1 : 0);
            if (s) cands.push({ score: s, project: p.name, kind: 'prompt', time: `${String(Math.floor(x.min / 60)).padStart(2, '0')}:${String(x.min % 60).padStart(2, '0')}`, text: x.text });
        }
    }
    // One shared word ("other", "reply") is noise; ask for two unless the entry has almost no words.
    const minScore = kw.length <= 2 ? 1 : 2;
    result.prompts = cands.filter(c => c.score >= minScore).sort((a, b) => b.score - a.score).slice(0, 5);

    const notesDir = path.join(VAULT_ROOT, 'sessions');
    let names = [];
    try { names = fs.readdirSync(notesDir).filter(n => n.startsWith(row.work_date) && n.endsWith('.md') && !restrictedGuard.mentionsRestricted(n)); } catch {}
    const lines = [];
    for (const n of names) {
        let text = '';
        try { text = fs.readFileSync(path.join(notesDir, n), 'utf8'); } catch { continue; }
        for (const l of text.split('\n')) {
            const t = l.trim();
            if (t.length < 12 || restrictedGuard.mentionsRestricted(t)) continue;
            const s = score(t);
            if (s >= 2 || (s >= 1 && kw.length <= 2)) lines.push({ score: s, note: n.replace(/\.md$/, ''), text: t.slice(0, 300) });
        }
    }
    result.notes = lines.sort((a, b) => b.score - a.score).slice(0, 4);
    return result;
}

async function explain(row) {
    if (restrictedGuard.mentionsRestricted(row.project, row.task_name, row.comment)) {
        return { secretco: true, why: 'Trabajo de SecretCo: su contenido no se lee desde acá (solo Bedrock).', evidence: [], auto: { keywords: [], prompts: [], notes: [] } };
    }
    let cited = [];
    try { cited = row.evidence_json ? JSON.parse(row.evidence_json) : []; } catch { cited = []; }
    const evidence = [];
    for (const item of cited.slice(0, 6)) evidence.push(await checkItem(item, row.work_date));
    const auto = await autoMatches(row);
    return { why: row.why || null, evidence, auto };
}

module.exports = { explain, squash, keywords };
