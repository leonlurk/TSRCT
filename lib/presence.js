// Presence: was Leon there, minute by minute? (2026-10-11)
//
// Hours Recall counts Leon's time, not an agent's. His messages prove he was there
// (lib/dispatcher/hoursEstimator.js), but supervising a long automatic run often
// means watching without writing: "estuve aca, eso cuenta como trabajo". Two cheap
// signals cover that, and nothing else is recorded:
//   - input: his mouse/keyboard on the PC was used in that minute (Windows'
//     GetLastInputInfo, polled by ONE long-lived PowerShell, every 30 s). Tesla's
//     own clicks also reset it, so minutes with a Tesla desk act are taken out
//     when the day is read (see presentMinutes).
//   - view: a TSRCT window (PC or phone) was visible that minute (the page posts
//     POST /api/presence/beat while document.visibilityState is 'visible').
// Stored as minute numbers of the local (UTC-3) day in .tsrct/presence/<date>.json.
// No window titles, no keys, no screen - only "a minute with a sign of him".

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..', '.tsrct', 'presence');
const DESK_LOG_DIR = path.join(__dirname, '..', 'logs', 'tesla', 'desk');
const TZ_MS = 3 * 3600 * 1000;
const DAY_MS = 86400000;
const POLL_S = 30;
const IDLE_OK_MS = 60 * 1000;   // input in the last minute = present this minute

const localDate = (ms) => new Date(ms - TZ_MS).toISOString().slice(0, 10);
const minuteOf = (ms) => Math.floor(((ms - TZ_MS) % DAY_MS) / 60000);

const pending = {};   // date -> { input:Set, view:Set }
let dirty = false;
let proc = null, flushTimer = null, lastInputAt = 0;

function mark(kind, ms = Date.now()) {
    const d = localDate(ms);
    const day = pending[d] || (pending[d] = load(d));
    const before = day[kind].size;
    day[kind].add(minuteOf(ms));
    if (day[kind].size !== before) dirty = true;
}

function load(date) {
    try {
        const o = JSON.parse(fs.readFileSync(path.join(DIR, `${date}.json`), 'utf8'));
        return { input: new Set(o.input || []), view: new Set(o.view || []) };
    } catch { return { input: new Set(), view: new Set() }; }
}

function flush() {
    if (!dirty) return;
    dirty = false;
    try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
    for (const [d, day] of Object.entries(pending)) {
        const body = JSON.stringify({ input: [...day.input].sort((a, b) => a - b), view: [...day.view].sort((a, b) => a - b) });
        try { fs.writeFileSync(path.join(DIR, `${d}.json`), body); } catch {}
    }
    const today = localDate(Date.now());
    for (const d of Object.keys(pending)) if (d < today) delete pending[d];
}

// One PowerShell for the whole run (a spawn per poll would cost ~0.5 s of CPU each).
const PS = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class TsrctIdle {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  public static uint Ms() { var l = new LII(); l.cbSize = 8; GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.dwTime; }
}
'@
while ($true) { [Console]::Out.WriteLine("I|" + [TsrctIdle]::Ms()); [Console]::Out.Flush(); Start-Sleep -Seconds ${POLL_S} }
`;

function start() {
    if (proc) return true;
    try {
        proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { proc = null; return false; }
    let buf = '';
    proc.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            const m = /^I\|(\d+)/.exec(line);
            if (!m) continue;
            const idle = Number(m[1]);
            if (idle <= IDLE_OK_MS) { const at = Date.now() - idle; mark('input', at); mark('input'); lastInputAt = at; }
        }
    });
    proc.on('exit', () => { proc = null; });
    flushTimer = setInterval(flush, 60 * 1000);
    if (flushTimer.unref) flushTimer.unref();
    return true;
}

function stop() {
    if (proc) { try { proc.kill(); } catch {} proc = null; }
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    flush();
}

function beat() { mark('view'); return { ok: true }; }

// Minutes Tesla touched the PC that day (the act and the minute after): her clicks
// reset Windows' idle clock, so they must not read as Leon.
function teslaMinutes(date) {
    const out = new Set();
    try {
        for (const line of fs.readFileSync(path.join(DESK_LOG_DIR, `${date}.jsonl`), 'utf8').split('\n')) {
            if (!line.includes('"kind":"act"')) continue;
            let o; try { o = JSON.parse(line); } catch { continue; }
            const ms = Date.parse(o.at || o.ts || '');
            if (!isFinite(ms) || localDate(ms) !== date) continue;
            const m = minuteOf(ms); out.add(m); out.add(m + 1);
        }
    } catch {}
    return out;
}

// The minutes of `date` with a sign of Leon: TSRCT visible, or PC input that was not Tesla.
function presentMinutes(date) {
    const day = pending[date] || load(date);
    const tesla = teslaMinutes(date);
    const out = new Set(day.view);
    for (const m of day.input) if (!tesla.has(m)) out.add(m);
    return out;
}

function status() {
    return { running: !!proc, lastInputAt, summary: proc ? 'Watching for your mouse/keyboard and TSRCT on screen' : 'Stopped' };
}

module.exports = { start, stop, beat, presentMinutes, status, _teslaMinutes: teslaMinutes, _mark: mark, DIR };
