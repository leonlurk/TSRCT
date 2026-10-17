'use strict';
// ── Token usage: what today actually cost, measured from the transcripts ──────
//
// WHY THIS EXISTS: the handoff (lib/sessionWeight.js) is a bet — cap the context
// a session carries and the bill goes down. A bet you cannot read is a belief.
// This module reads the ONLY ground truth on this machine: every assistant turn
// Claude Code writes to ~/.claude/projects/<project>/<session>.jsonl carries the
// real `message.usage` the API billed. Nothing here asks a model anything and
// nothing leaves the machine, so the measurement costs zero tokens.
//
// ON DEMAND ONLY. There is no timer in this file and there must never be one:
// a full day is ~150 MB of JSON and Leon's laptop has 11 GB with five Claude
// sessions in it. The UI scans when he clicks, and the memo cache below makes
// the second click nearly free.
//
// Standalone like sessionWeight/syften/handson: a failure in here must not take
// anything else down. Every entry point returns a shape, never throws.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ── Prices, USD per 1M tokens ────────────────────────────────────────────────
// Source: the bundled `claude-api` skill's model table, read 2026-08-24. Cache
// multipliers from the same skill (shared/prompt-caching.md): a read costs 0.1x
// base input, a write 1.25x at the 5-minute TTL and 2x at the 1-hour TTL.
// THE TTL SPLIT IS NOT A DETAIL: Claude Code runs the 1h TTL, so a cache write
// here costs 2x input, not the 1.25x every tutorial quotes. Pricing an 1h write
// as 5m under-reports a heavy day by real money.
const RATES = {
    'claude-fable-5':  { in: 10, out: 50 },
    'claude-mythos-5': { in: 10, out: 50 },
    'claude-opus-5':   { in: 5,  out: 25, fast: { in: 10, out: 50 } },
    'claude-opus-4-8': { in: 5,  out: 25, fast: { in: 10, out: 50 } },
    'claude-opus-4-7': { in: 5,  out: 25 },
    'claude-opus-4-6': { in: 5,  out: 25 },
    'claude-sonnet-5': { in: 3,  out: 15 },
    'claude-sonnet-4-6': { in: 3, out: 15 },
    'claude-haiku-4-5':  { in: 1, out: 5 },
};
// A model id that is not in the table yet still has to be counted. Fall back by
// FAMILY and mark the row estimated, because silently pricing an unknown model
// at zero is how a dashboard reports a cheap day that was not cheap.
const FAMILY = [
    [/fable|mythos/, { in: 10, out: 50 }],
    [/opus/,         { in: 5,  out: 25 }],
    [/sonnet/,       { in: 3,  out: 15 }],
    [/haiku/,        { in: 1,  out: 5 }],
];
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

// Context buckets, in tokens carried into the turn. The edges are the same ones
// sessionWeight warns on, so this panel and that badge tell one story.
const BUCKETS = [
    { key: '<100k',    max: 100000 },
    { key: '100-200k', max: 200000 },
    { key: '200-300k', max: 300000 },
    { key: '300k+',    max: Infinity },
];

const MAX_RECORDS = 200000;          // a runaway-day backstop, never reached in practice
const PROBE_BYTES = 65536;           // window read per binary-search probe

let deps = { restrictedGuard: null };
function configure(injected) { deps = { ...deps, ...(injected || {}) }; }

// path -> { size, mtimeMs, dayKey, records[] }
const memo = new Map();
let scanning = false;
let last = null;                     // the last completed scan, served to late callers

// ── The Claude.ai quota bars ─────────────────────────────────────────────────
// The 5-hour and 7-day limits are what actually stop Leon working; dollars are a
// proxy for them. They are NOT on disk anywhere: Claude Code fetches them from
// its usage endpoint and holds them in memory. The one supported way to read
// them without a credential is the status line, which is handed a `rate_limits`
// block on stdin -- scripts/statusline-usage.sh persists it here.
//
// So this file is ALWAYS as old as the last status-line render. That is why the
// age travels with the value and the panel prints it: a percentage with no
// timestamp is a number you cannot act on.
const BARS_FILE = path.join(os.homedir(), '.claude', 'tsrct-rate-limits.json');

function bars() {
    try {
        const d = JSON.parse(fs.readFileSync(BARS_FILE, 'utf8'));
        const rl = d.rate_limits || {};
        // MEASURED, not assumed: Claude Code sends `resets_at` as EPOCH SECONDS
        // (1787618400), not the ISO string the changelog line suggests. Parsing it
        // as a date string yields NaN and the countdown silently renders blank —
        // caught only by running it against the real file. Accept all three shapes
        // and hand the panel one: epoch milliseconds, or 0.
        const resetMs = (v) => {
            if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
            const t = Date.parse(v || '');
            return Number.isFinite(t) ? t : 0;
        };
        const one = (k) => {
            const b = rl[k];
            if (!b || !Number.isFinite(Number(b.used_percentage))) return null;
            const used = Math.max(0, Math.min(100, Number(b.used_percentage)));
            return { used, remaining: 100 - used, resetsAt: resetMs(b.resets_at) };
        };
        return {
            ok: true,
            capturedAt: Number(d.captured_at) || 0,
            fiveHour: one('five_hour'),
            sevenDay: one('seven_day'),
        };
    } catch (e) {
        // No file yet = the status line has not run since it was configured.
        // Say that, rather than showing 0% and looking like plenty of headroom.
        return { ok: false, capturedAt: 0, fiveHour: null, sevenDay: null,
                 reason: e.code === 'ENOENT' ? 'no status-line reading yet' : e.message };
    }
}

// ── Model + money ────────────────────────────────────────────────────────────
function rateFor(model, speed) {
    const hit = RATES[model];
    if (hit) return { rate: (speed === 'fast' && hit.fast) ? hit.fast : hit, estimated: false };
    for (const [re, rate] of FAMILY) if (re.test(model || '')) return { rate, estimated: true };
    return { rate: null, estimated: true };
}

// Split by component, because "it cost $228" is a number and "$138 of it is the
// conversation being re-sent every turn" is a decision. The four parts always
// sum to the total — the panel shows them as one bar.
function costParts(rec) {
    const { rate } = rateFor(rec.model, rec.speed);
    if (!rate) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const p = {
        input: rec.input * rate.in / 1e6,
        output: rec.output * rate.out / 1e6,
        cacheRead: rec.cacheRead * rate.in * CACHE_READ_MULT / 1e6,
        cacheWrite: (rec.write5m * CACHE_WRITE_5M_MULT + rec.write1h * CACHE_WRITE_1H_MULT) * rate.in / 1e6,
    };
    p.total = p.input + p.output + p.cacheRead + p.cacheWrite;
    return p;
}

function costOf(rec) { return costParts(rec).total; }

// What the cache actually saved: those cache_read tokens, had they been sent
// cold, would have cost the full input rate instead of a tenth of it.
function cacheSavingOf(rec) {
    const { rate } = rateFor(rec.model, rec.speed);
    if (!rate) return 0;
    return rec.cacheRead * rate.in * (1 - CACHE_READ_MULT) / 1e6;
}

// ── Day boundaries (LOCAL, because "today" is Leon's day, not UTC) ───────────
function dayBounds(dayKey) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
    d.setHours(0, 0, 0, 0);
    const start = d.getTime();
    return { start, end: start + 24 * 3600 * 1000 };
}
function todayKey() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Finding where the day starts inside an append-only transcript ────────────
// Binary search over byte offsets. Reading a 30 MB file to reach the last 2 MB
// that belong to today is the difference between a click that answers and a
// click that heats the laptop. Anything unexpected falls back to offset 0 —
// slower, never wrong.
function firstTimestampAt(fd, offset, size) {
    const len = Math.min(PROBE_BYTES, size - offset);
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    const text = buf.toString('utf8');
    // Skip the partial line we almost certainly landed inside.
    let from = offset === 0 ? 0 : text.indexOf('\n') + 1;
    if (from <= 0 && offset !== 0) return null;
    while (from < text.length) {
        let nl = text.indexOf('\n', from);
        if (nl === -1) nl = text.length;
        const line = text.slice(from, nl);
        const ts = tsOf(line);
        if (ts) return { ts, offset: offset + Buffer.byteLength(text.slice(0, from), 'utf8') };
        from = nl + 1;
    }
    return null;
}

// Cheaper than JSON.parse and enough to order lines: the timestamp field.
function tsOf(line) {
    const i = line.indexOf('"timestamp":"');
    if (i === -1) return 0;
    const t = Date.parse(line.slice(i + 13, i + 37));
    return Number.isFinite(t) ? t : 0;
}

function dayStartOffset(file, size, dayStart) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const head = firstTimestampAt(fd, 0, size);
        if (!head) return 0;
        if (head.ts >= dayStart) return 0;                 // whole file is in range
        let lo = 0, hi = size, best = 0;
        for (let i = 0; i < 40 && lo < hi; i++) {
            const mid = Math.floor((lo + hi) / 2);
            const probe = firstTimestampAt(fd, mid, size);
            if (!probe) { hi = mid; continue; }
            if (probe.ts < dayStart) { best = probe.offset; lo = mid + 1; }
            else hi = mid;
        }
        return best;
    } catch (e) {
        return 0;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
}

// ── Reading one file's slice of the day ──────────────────────────────────────
function readRecords(file, dayStart, dayEnd) {
    const out = [];
    let fd = null;
    try {
        const st = fs.statSync(file);
        const start = dayStartOffset(file, st.size, dayStart);
        fd = fs.openSync(file, 'r');
        let pos = start;
        let tail = '';
        const CHUNK = 1 << 20;
        const buf = Buffer.alloc(CHUNK);
        while (pos < st.size) {
            const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
            if (n <= 0) break;
            pos += n;
            const text = tail + buf.toString('utf8', 0, n);
            const lines = text.split('\n');
            tail = lines.pop();
            for (const line of lines) takeLine(line, out, dayStart, dayEnd);
            if (out.length > MAX_RECORDS) break;
        }
        if (tail) takeLine(tail, out, dayStart, dayEnd);
    } catch (e) {
        // A transcript being written while we read it, a permission error, a
        // half-flushed line: this file contributes what it gave us and the scan
        // reports the file as unreadable rather than dying on it.
        out.unreadable = true;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
    return out;
}

function takeLine(line, out, dayStart, dayEnd) {
    // The cheap gate first: only assistant turns carry usage, and they are a
    // small minority of the lines.
    if (line.length < 40 || line.indexOf('"usage"') === -1) return;
    let d;
    try { d = JSON.parse(line); } catch { return; }
    const msg = d.message;
    if (!msg || !msg.usage) return;
    const ts = Date.parse(d.timestamp || '');
    if (!Number.isFinite(ts) || ts < dayStart || ts >= dayEnd) return;
    const u = msg.usage;
    const cc = u.cache_creation || {};
    const write1h = Number(cc.ephemeral_1h_input_tokens) || 0;
    const write5m = Number(cc.ephemeral_5m_input_tokens) || 0;
    const created = Number(u.cache_creation_input_tokens) || 0;
    out.push({
        // The dedupe key. A resumed or forked session COPIES the earlier turns
        // into its new transcript, so the same billed message really does appear
        // in more than one file — counting it twice inflates the day.
        id: msg.id || (d.requestId ? d.requestId + ':' + d.uuid : d.uuid),
        ts,
        model: msg.model || '',
        speed: u.speed || u.service_tier || '',
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        // Trust the split when it is there; fall back to the total as a 1h write
        // (Claude Code's TTL) rather than dropping it.
        write1h: (write1h || write5m) ? write1h : created,
        write5m: (write1h || write5m) ? write5m : 0,
        thinking: Number((u.output_tokens_details || {}).thinking_tokens) || 0,
        session: d.sessionId || '',
        cwd: d.cwd || '',
        sidechain: !!d.isSidechain,
    });
}

// ── The scan ─────────────────────────────────────────────────────────────────
function isRestrictedPath(p) {
    try {
        if (deps.restrictedGuard && typeof deps.restrictedGuard.mentionsRestricted === 'function') {
            return deps.restrictedGuard.mentionsRestricted(p);
        }
    } catch { /* fall through to the literal test */ }
    return /secretco/i.test(String(p || ''));
}

function projectLabel(dirName, cwd) {
    // Claude Code encodes the cwd as the directory name (/ -> -). The cwd on the
    // record is the honest source; the directory name is the fallback.
    const src = cwd || String(dirName || '').replace(/-/g, '/');
    const parts = String(src).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || 'unknown';
}

function scan(dayKey) {
    const key = /^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || '')) ? dayKey : todayKey();
    const { start, end } = dayBounds(key);
    const t0 = Date.now();

    let files = [];
    try {
        for (const dir of fs.readdirSync(PROJECTS_DIR)) {
            const full = path.join(PROJECTS_DIR, dir);
            let st;
            try { st = fs.statSync(full); } catch { continue; }
            if (!st.isDirectory()) continue;
            for (const f of fs.readdirSync(full)) {
                if (!f.endsWith('.jsonl')) continue;
                const fp = path.join(full, f);
                let fst;
                try { fst = fs.statSync(fp); } catch { continue; }
                // A file last written before the day started cannot hold a line
                // inside it. This is what keeps a 895 MB store off the hot path.
                if (fst.mtimeMs < start) continue;
                files.push({ path: fp, dir, size: fst.size, mtimeMs: fst.mtimeMs });
            }
        }
    } catch (e) {
        return { error: 'transcripts unreadable: ' + e.message, day: key, ok: false };
    }

    // SecretCo is Bedrock-only: its transcripts never enter an HTTP response, not
    // even as a project name or a token count. Excluded here, at the one place
    // that enumerates files, and the count of what was dropped is reported so
    // the total is never quietly short.
    const restrictedFiles = files.filter(f => isRestrictedPath(f.path));
    files = files.filter(f => !isRestrictedPath(f.path));

    let bytes = 0, reused = 0, unreadable = 0;
    const all = [];
    for (const f of files) {
        const cached = memo.get(f.path);
        let recs;
        if (cached && cached.dayKey === key && cached.size === f.size && cached.mtimeMs === f.mtimeMs) {
            recs = cached.records; reused++;
        } else {
            recs = readRecords(f.path, start, end);
            if (recs.unreadable) unreadable++;
            bytes += f.size - (cached && cached.dayKey === key ? cached.size : 0);
            memo.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, dayKey: key, records: recs });
        }
        for (const r of recs) {
            if (!r.dir) r.dir = f.dir;
            all.push(r);
        }
    }

    const agg = aggregate(all, key);
    agg.bars = bars();
    agg.scan = {
        at: Date.now(),
        ms: Date.now() - t0,
        files: files.length,
        filesReused: reused,
        filesUnreadable: unreadable,
        bytesRead: bytes,
        restrictedExcluded: restrictedFiles.length,
    };
    last = agg;
    return agg;
}

function aggregate(records, dayKey) {
    const seen = new Set();
    const byModel = new Map(), byProject = new Map(), bySession = new Map();
    const buckets = BUCKETS.map(b => ({ key: b.key, turns: 0, cost: 0 }));
    const hours = Array.from({ length: 24 }, () => 0);
    const t = {
        cost: 0, input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0,
        turns: 0, cacheSaved: 0, sidechainCost: 0, sidechainTurns: 0,
        costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0,
    };
    let estimatedCost = 0, peakCtx = 0;

    for (const r of records) {
        if (seen.has(r.id)) continue;                 // the resumed-transcript double count
        seen.add(r.id);
        if (isRestrictedPath(r.cwd)) continue;             // belt and braces at the record level

        const parts = costParts(r);
        const cost = parts.total;
        const ctx = r.input + r.cacheRead + r.write1h + r.write5m;
        const { estimated } = rateFor(r.model, r.speed);
        if (estimated) estimatedCost += cost;
        if (ctx > peakCtx) peakCtx = ctx;

        t.costInput += parts.input; t.costOutput += parts.output;
        t.costCacheRead += parts.cacheRead; t.costCacheWrite += parts.cacheWrite;
        t.cost += cost; t.turns++;
        t.input += r.input; t.output += r.output; t.thinking += r.thinking;
        t.cacheRead += r.cacheRead; t.cacheWrite += r.write1h + r.write5m;
        t.cacheSaved += cacheSavingOf(r);
        if (r.sidechain) { t.sidechainCost += cost; t.sidechainTurns++; }

        const bi = BUCKETS.findIndex(b => ctx < b.max);
        const b = buckets[bi === -1 ? buckets.length - 1 : bi];
        b.turns++; b.cost += cost;

        hours[new Date(r.ts).getHours()] += cost;

        bump(byModel, r.model || 'unknown', cost, r);
        bump(byProject, projectLabel(r.dir, r.cwd), cost, r);

        const s = bySession.get(r.session) || {
            session: r.session, project: projectLabel(r.dir, r.cwd),
            cost: 0, turns: 0, peakCtx: 0, first: r.ts, lastTs: r.ts,
        };
        s.cost += cost; s.turns++;
        if (ctx > s.peakCtx) s.peakCtx = ctx;
        if (r.ts < s.first) s.first = r.ts;
        if (r.ts > s.lastTs) s.lastTs = r.ts;
        bySession.set(r.session, s);

        if (!r.model) continue;
    }

    const rank = m => [...m.values()].sort((a, b) => b.cost - a.cost);
    return {
        ok: true,
        day: dayKey,
        totals: t,
        peakCtx,
        estimatedCost,
        byModel: rank(byModel),
        byProject: rank(byProject),
        sessions: rank(bySession).slice(0, 8),
        sessionCount: bySession.size,
        buckets,
        hours,
    };
}

function bump(map, key, cost, r) {
    const e = map.get(key) || { key, cost: 0, turns: 0, input: 0, output: 0, cacheRead: 0 };
    e.cost += cost; e.turns++;
    e.input += r.input; e.output += r.output; e.cacheRead += r.cacheRead;
    map.set(key, e);
}

// One scan at a time. Two clicks in a row must not put two full walks of the
// transcript store on a laptop that is already running five Claude sessions.
function scanGuarded(dayKey) {
    if (scanning) {
        return last
            ? { ...last, busy: true }
            : { ok: false, busy: true, day: dayKey || todayKey(), error: 'a scan is already running' };
    }
    scanning = true;
    try { return scan(dayKey); }
    catch (e) { return { ok: false, day: dayKey || todayKey(), error: e.message }; }
    finally { scanning = false; }
}

module.exports = {
    configure,
    scan: scanGuarded,
    bars,
    todayKey,
    lastScan: () => last,
    // exported for the test harness
    _internals: { costOf, costParts, cacheSavingOf, rateFor, aggregate, dayBounds, tsOf, RATES },
};
