// ─────────────────────────────────────────────────────────────────────────
// syften-daily.js — the once-a-day pass over what Syften brought in.
//
//   new Syften mentions  ->  drop the provably dead  ->  read each thread
//   ->  one `claude -p` verdict  ->  a short list Leon answers by hand.
//
// 🔴 Leon writes. This never posts, never drafts in his name, never touches an
// account. It hands him threads and a reason. The division is the one that has
// worked since 08-24: the facts are mine, the words are his.
//
// Why a scoring pass AND a Claude pass, when the scorer already ranks:
// keyword+room cannot read a thread. Measured 2026-09-01: "$200 to spend at
// Sephora" scores 10 — right room, right filter, and it is somebody asking how
// to spend a gift card, not somebody whose skin is stripped. So the scorer is
// used only to drop what is PROVABLY dead (rooms that have never produced a
// good hit, job ads, cross-post campaigns — 40% of matches, measured, with
// zero good hits among them). Everything else goes to Claude, because a
// borderline lead silently binned by my arithmetic is the expensive mistake
// and nobody would ever see it.
//
// Volume: ~27 matches/day, ~20 threads after merging. That is fewer pages than
// reading the same feed by hand.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { spawn } = require('child_process');

const triage = require('./syften-triage');

const STATE = path.join(__dirname, '..', 'data', 'syften-daily.json');
const FETCHER = path.join(__dirname, '..', 'tools', 'reddit-fetch.js');
const LIBPATH = process.env.CHROME_LIBPATH || path.join(paths.HEADLESS_DIR, 'libs/usr/lib/x86_64-linux-gnu');

// Ceilings, not targets. A day that somehow delivers 300 matches must not turn
// into 300 page loads: it stops at MAX_READ and says so.
const MAX_READ = 25;
const GAP_MS = 6000;
const CLAUDE_TIMEOUT_MS = 6 * 60 * 1000;

// Nothing is binned for scoring low. A lead is dropped unseen ONLY when the
// scorer raised a flag — a room that has never once matched for a good reason,
// a job ad, or one account broadcasting into three of our rooms. That is
// positive evidence of death; a low score is merely absence of evidence.
//
// The first dry run got this wrong and it is worth keeping written down: a
// threshold of 0 threw away r/Software_Finder, "PM tool with resource planning
// built in", whose only sin was being an unknown room on an old post. A number
// cannot tell those two cases apart. A reason can.
function isDead(i) { return !!(i.flags && (i.flags.badRoom || i.flags.jobAd || i.flags.broadcast)); }

// ── live progress ────────────────────────────────────────────────────────
// A full run is up to 25 page loads six seconds apart and then a `claude -p`
// call: minutes of complete silence. Measured 2026-09-02: Leon started a run
// and had no way to tell a 20-millisecond "nothing new today" from a browser
// that had hung — the panel showed the same nothing in both cases. So every
// phase writes down where it is, and the panel reads it.
//
// Deliberately in memory and never in the state file: this answers "is it
// alive RIGHT NOW", and a restart kills the run, so a progress row that
// survived a restart would be a lie.
let progress = null;

function setProgress(p) { progress = p ? { ...p, at: Date.now() } : null; }

// The estimate is measured, not assumed. Before the first page comes back
// there is nothing to measure, so this returns null and the panel says
// "still measuring" rather than inventing a number.
function etaSeconds(startedMs, done, total) {
    if (!done || done >= total) return null;
    const per = (Date.now() - startedMs) / done;
    return Math.max(0, Math.round(((total - done) * per) / 1000));
}

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
    catch { return { lastRun: null, seen: [], runs: [] }; }
}
function saveState(s) {
    try {
        fs.mkdirSync(path.dirname(STATE), { recursive: true });
        fs.writeFileSync(STATE, JSON.stringify({
            lastRun: s.lastRun,
            seen: (s.seen || []).slice(-3000),
            // Only the newest few runs keep their leads. The verdicts are what
            // Leon acts on, so they have to survive a restart — but keeping 30
            // days of thread bodies would turn a state file into an archive.
            runs: (s.runs || []).slice(0, 30).map((r, i) => (i < 3 ? r : { ...r, leads: undefined })),
        }, null, 1));
    } catch (e) { /* a state write failure must not lose the run's output */ }
}

// ── step 1: what is new and plausibly alive ──────────────────────────────
function pick(items, state, opts) {
    const o = opts || {};
    const seen = new Set(state.seen || []);
    const scored = triage.triage(items, { limit: 999 });
    const all = [...scored.shortlist, ...scored.rest];

    const fresh = all.filter(i => !seen.has(i.id));
    const dead = fresh.filter(isDead);
    const alive = fresh.filter(i => !isDead(i))
        // Only Reddit for now: it is the one source that produced a
        // conversation, and it is the only page shape the reader understands.
        .filter(i => /^https?:\/\/(www\.)?reddit\.com\//i.test(i.url || ''))
        .sort((a, b) => b.score - a.score)
        .slice(0, o.max || MAX_READ);

    return { alive, dead, freshTotal: fresh.length, counts: scored.counts };
}

// ── step 2: read the threads ─────────────────────────────────────────────
function fetchThreads(urls, opts, onProgress) {
    const o = opts || {};
    return new Promise((resolve) => {
        if (!urls.length) return resolve({ ok: true, pages: [], stopped: null });
        const child = spawn(process.execPath, [FETCHER], {
            env: { ...process.env, LD_LIBRARY_PATH: LIBPATH },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '', err = '', tail = '';
        child.stdout.on('data', c => { out += c; });
        child.stderr.on('data', c => {
            // Capped: only the last few KB can ever be needed, and an unbounded
            // buffer on a channel the child controls is how a reader becomes a
            // memory leak on an 11 GB laptop.
            err = (err + c).slice(-4000);
            // Split on newlines and keep the unfinished last piece: a chunk can
            // arrive cut in half, and half a line parses as nothing.
            const lines = (tail + c).split('\n');
            tail = lines.pop();
            for (const ln of lines) {
                const m = ln.match(/^\[reddit-fetch\] (\d+)\/(\d+) (opening|done)\s*(.*)$/);
                if (m && typeof onProgress === 'function') {
                    try {
                        onProgress({
                            n: Number(m[1]), total: Number(m[2]),
                            stage: m[3], detail: (m[4] || '').trim(),
                        });
                    } catch { /* a broken listener must not stop the read */ }
                }
            }
        });
        child.on('error', e => resolve({ ok: false, error: e.message, pages: [] }));
        child.on('close', () => {
            try { resolve(JSON.parse(out)); }
            catch { resolve({ ok: false, error: 'fetcher returned no JSON: ' + err.slice(-300), pages: [] }); }
        });
        child.stdin.write(JSON.stringify({
            urls, gapMs: o.gapMs || GAP_MS, max: o.max || MAX_READ,
        }));
        child.stdin.end();
    });
}

// ── step 3: the verdict ──────────────────────────────────────────────────
// The rules are Leon's own, learned the expensive way, and they are in the
// prompt because a model that does not know them returns twenty "yes".
function buildPrompt(leads) {
    const blocks = leads.map((l, n) => {
        const c = (l.page.comments || []).slice(0, 6)
            .map(x => `    - ${x.author || 'someone'} (${x.score}): ${x.text.slice(0, 300)}`).join('\n');
        return [
            `### LEAD ${n + 1}`,
            `room: ${l.page.subreddit || l.item.community}`,
            `title: ${l.page.title}`,
            `author: ${l.page.author}  |  score: ${l.page.score}  |  comments: ${l.page.commentCount}`,
            `age: ${l.item.ageHours === null ? 'unknown' : l.item.ageHours + 'h'}`,
            `matched our keyword: ${(l.item.filters || []).join(', ') || l.item.filter || '?'}`,
            `url: ${l.page.url}`,
            `post:\n    ${(l.page.body || '').slice(0, 1800)}`,
            c ? `existing replies:\n${c}` : 'existing replies: none',
        ].join('\n');
    }).join('\n\n');

    return `You are triaging Reddit threads that a monitoring tool surfaced for two businesses.

WHO IS ASKING
- AcmeCloudCo (ACME): Salesforce and ClickUp consulting. The wedge is billing
  and invoicing out of ClickUp, unbilled hours, profit per client. Leon builds
  this; he can speak to it first-hand.
- Verde Soap (PV): handcrafted olive-oil castile soap, sold as a body wash.
  The angle is skin that feels stripped, tight or dried out by ordinary body
  wash. NOT the "18-in-1, clean your sink with it" fight — that is Dr Bronner's
  ground and we do not enter it.

THE RULES, which are the ones that matter more than fit:
1. If the topic would not genuinely interest Leon, it is a NO. He does not
   comment to be seen commenting.
2. He answers with a measured number or first-hand experience, never an
   opinion. If he has nothing concrete to add, it is a NO however good the fit.
3. A thread already carrying a good answer to the same question is a NO.
4. Never a product pitch. The comment has to stand on its own with the product
   removed; if it cannot, it is a NO.
5. A person with a problem is a YES. A survey, a "what are you building"
   roundup, a job ad or somebody farming leads is a NO — even in a perfect room.

For EACH lead below return one object. Be hard to please: on a normal day one
or two are worth answering and the rest are not. Saying no is the useful answer.

Return ONLY a JSON array, no prose, no markdown fence:
[{"lead":1,"verdict":"yes"|"no","brand":"ACME"|"PV"|"none","why":"<max 25 words, plain>","angle":"<if yes: what Leon actually knows that answers it, max 30 words; else null>"}]

${blocks}`;
}

function runClaude(prompt, cwd) {
    return new Promise((resolve) => {
        const child = spawn('claude', ['-p', prompt], {
            cwd: cwd || path.join(__dirname, '..'),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '', err = '';
        const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, CLAUDE_TIMEOUT_MS);
        child.stdout.on('data', c => { out += c; });
        child.stderr.on('data', c => { err += c; });
        child.on('error', e => { clearTimeout(killer); resolve({ ok: false, error: e.message }); });
        child.on('close', () => {
            clearTimeout(killer);
            // Tolerate a fence or a sentence around the array: the run is worth
            // keeping even when the model decorates its answer.
            const m = out.match(/\[[\s\S]*\]/);
            if (!m) return resolve({ ok: false, error: 'no JSON array in claude output', raw: out.slice(0, 400), stderr: err.slice(-300) });
            try { resolve({ ok: true, verdicts: JSON.parse(m[0]), raw: out }); }
            catch (e) { resolve({ ok: false, error: 'bad JSON from claude: ' + e.message, raw: out.slice(0, 400) }); }
        });
    });
}

// ── the run ──────────────────────────────────────────────────────────────
async function run(items, opts) {
    const o = opts || {};
    const state = loadState();
    const started = new Date().toISOString();
    setProgress({ phase: 'picking', startedAt: started, text: 'sorting what Syften brought in' });

    const sel = pick(items || [], state, o);
    if (!sel.alive.length) {
        const run = { started, finished: new Date().toISOString(), read: 0, worth: 0, leads: [],
            note: sel.freshTotal ? `${sel.freshTotal} new, all of them provably dead` : 'nothing new since the last run' };
        state.lastRun = run.finished; state.runs = [run, ...(state.runs || [])];
        saveState(state);
        return { ok: true, ...run, leads: [], dropped: sel.dead.length };
    }

    // Open the THREAD, not the comment permalink Syften handed us.
    const readStarted = Date.now();
    const total = sel.alive.length;
    setProgress({
        phase: 'reading', startedAt: started, done: 0, total, etaSec: null,
        text: `opening ${total} thread${total === 1 ? '' : 's'}, one at a time`,
    });
    const fetched = await fetchThreads(sel.alive.map(i => i.readUrl || i.url), o, (p) => {
        // "opening 3" means two are finished; "done 3" means three are. The
        // panel counts finished pages, so an opening line reports n-1.
        const done = p.stage === 'done' ? p.n : p.n - 1;
        setProgress({
            phase: 'reading', startedAt: started, done, total: p.total || total,
            etaSec: etaSeconds(readStarted, done, p.total || total),
            url: p.stage === 'opening' ? p.detail : undefined,
            text: `reading thread ${Math.min(p.n, p.total || total)} of ${p.total || total}`,
        });
    });
    const byUrl = new Map((fetched.pages || []).map(p => [p.url, p]));
    const leads = sel.alive
        .map(item => ({ item, page: byUrl.get(item.readUrl || item.url) }))
        .filter(l => l.page && l.page.ok && !l.page.locked);

    // Mark everything we looked at as seen, including what we could not read —
    // otherwise a permanently broken url is retried every single day.
    state.seen = [...(state.seen || []), ...sel.alive.map(i => i.id), ...sel.dead.map(i => i.id)];

    let verdicts = [], claudeErr = null;
    if (leads.length) {
        // No percentage here on purpose: Claude answers when it answers, and a
        // bar that crawls to 90% and sits there is worse than a clock.
        setProgress({
            phase: 'thinking', startedAt: started, done: leads.length, total: leads.length,
            text: `read ${leads.length} thread${leads.length === 1 ? '' : 's'} — asking Claude which are worth answering`,
        });
        const r = await runClaude(buildPrompt(leads), o.cwd);
        if (r.ok) verdicts = r.verdicts; else claudeErr = r.error;
    }

    const merged = leads.map((l, n) => {
        const v = verdicts.find(x => Number(x.lead) === n + 1) || null;
        return {
            url: l.page.url,
            room: l.page.subreddit || l.item.community,
            title: l.page.title,
            comments: l.page.commentCount,
            ageHours: l.item.ageHours,
            score: l.item.score,
            filters: l.item.filters,
            verdict: v ? v.verdict : null,
            brand: v ? v.brand : null,
            why: v ? v.why : null,
            angle: v ? v.angle : null,
        };
    });

    const worth = merged.filter(m => m.verdict === 'yes');
    const finished = new Date().toISOString();
    const runRec = {
        started, finished,
        leads: merged,
        newMentions: sel.freshTotal,
        droppedAsDead: sel.dead.length,
        read: leads.length,
        unreadable: sel.alive.length - leads.length,
        worth: worth.length,
        halted: fetched.stopped || null,
        claudeErr,
    };
    state.lastRun = finished;
    state.runs = [runRec, ...(state.runs || [])];
    saveState(state);

    return { ok: true, ...runRec, leads: merged, worth };
}

function lastRuns(n) {
    const s = loadState();
    const runs = (s.runs || []).slice(0, n || 10);
    const latest = runs[0] || null;
    return {
        lastRun: s.lastRun,
        running,
        // Where the run is right now, or null when nothing is running. This is
        // the difference between "it finished in 20ms because there was nothing
        // new" and "it is stuck", which used to look identical.
        progress,
        scheduledHour: Number.isInteger(Number(process.env.SYFTEN_DAILY_HOUR))
            ? Number(process.env.SYFTEN_DAILY_HOUR) : null,
        // The panel wants one answer, not a history: the last run's verdicts,
        // the ones worth answering first.
        latest,
        leads: latest ? (latest.leads || []).slice().sort((a, b) => {
            const av = a.verdict === 'yes' ? 0 : 1, bv = b.verdict === 'yes' ? 0 : 1;
            return av !== bv ? av - bv : (b.score || 0) - (a.score || 0);
        }) : [],
        runs: runs.map(r => ({ ...r, leads: undefined })),
    };
}

// ── the schedule ─────────────────────────────────────────────────────────
// OFF unless SYFTEN_DAILY_HOUR is set. Deliberately opt-in: this opens real
// pages on a real site, and a restart should never quietly begin doing that on
// Leon's behalf because a commit landed. One line in .env turns it on.
//
// Guarded against the two ways a daily timer misbehaves: it will not run twice
// in one day (the state file remembers), and it will not run at all while a run
// is already going.
let dailyTimer = null;
let running = false;

function sameDay(a, b) {
    return a && b && new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

async function runOnce(getItems, opts) {
    if (running) return { ok: false, error: 'a run is already in progress' };
    running = true;
    // The clear lives in `finally`, not at the end of run(): a run that throws
    // would otherwise leave the panel showing "reading 4 of 12" forever.
    try { return await run(getItems(), opts); }
    finally { running = false; setProgress(null); }
}

function startDaily(getItems, onDone) {
    const hour = Number(process.env.SYFTEN_DAILY_HOUR);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { started: false, reason: 'SYFTEN_DAILY_HOUR not set — daily read is off' };
    if (dailyTimer) clearInterval(dailyTimer);
    const tick = async () => {
        const now = new Date();
        // `>=`, not `===`. This runs on a laptop, not a server: matching the
        // hour exactly means a machine that was closed at 09:00 and opened at
        // 11:00 silently skips the whole day. Past the hour and not yet run
        // today is the condition that actually means "owed a run".
        if (now.getHours() < hour) return;
        const s = loadState();
        if (sameDay(s.lastRun, now.toISOString())) return;   // already ran today
        const r = await runOnce(getItems, {});
        if (typeof onDone === 'function') { try { onDone(r); } catch { /* never break the timer */ } }
    };
    // Checked every 10 minutes rather than scheduled to the second: a laptop
    // that was asleep at the appointed minute would otherwise skip the day.
    dailyTimer = setInterval(() => { tick().catch(() => {}); }, 10 * 60 * 1000);
    if (dailyTimer.unref) dailyTimer.unref();
    return { started: true, hour };
}

function stopDaily() { if (dailyTimer) { clearInterval(dailyTimer); dailyTimer = null; } }

module.exports = { run, runOnce, lastRuns, pick, buildPrompt, isDead, startDaily, stopDaily, MAX_READ };
