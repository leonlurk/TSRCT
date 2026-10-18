'use strict';
// ── desk.js — Tesla's eyes on the Windows desktop ───────────────────────────
//
// WHY (2026-10-10). Leon: "que de manera conversacional le pudiera pedir que
// haga cualquier cosa en mi pc ... basicamente todo lo que uno haria como
// humano", for the bigger jobs (the small ones he does with the mouse). Step
// one, agreed: Tesla can LOOK at the screen and answer, nothing more. Clicking
// and typing come later, through this same file.
//
// THE SECRETCO WALL. A screenshot goes to a Claude model on the public API, so a
// screen that shows SecretCo is a contract breach. Three layers, all before any
// file is handed out, and a refusal deletes what was captured:
//   1. TSRCT itself served an SecretCo pane in the last RESTRICTED_VIEW_MS (the pane's
//      text may never say the word; the session NAME does). The server marks
//      it (sawRestrictedPane) on a file, so the CLI the `hands` worker runs sees it.
//   2. A window that IS SecretCo work: an editor/terminal/folder window on
//      SecretCoSandbox, one named after the secretco session, their org (titleIsRestrictedWork).
//   3. Windows' own OCR (local, nothing leaves the machine) reads their org's
//      address or a prompt inside their folder on that monitor (screenSaysRestricted).
// The WORD alone never refuses (his rule, below): a mail, a chat, a folder
// listing or a Claude session that mentions them is looked at.
// What it cannot catch, said plainly: their org in a browser whose address bar
// is hidden or off screen (a Salesforce tab title does not name the org), or
// their data pasted somewhere else. Layer 3 is per monitor: a clean monitor is
// still served when the other one is refused.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const restrictedGuard = require('./dispatcher/restrictedGuard');
const { NAME: OWNER } = require('./owner');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.DESK_DIR || path.join(ROOT, '.tsrct', 'desk');
const SEEN_FILE = process.env.DESK_SEEN_FILE || path.join(ROOT, '.tsrct', 'desk-secretco-seen');
const SCRIPT = path.join(ROOT, 'scripts', 'desk', 'look.ps1');
const ACT_SCRIPT = path.join(ROOT, 'scripts', 'desk', 'act.ps1');
const RESTRICTED_VIEW_MS = Number(process.env.DESK_RESTRICTED_VIEW_MS || 2 * 60 * 1000);
const KEEP_MS = 15 * 60 * 1000;
const PS = [
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',
].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;

// WORKING in SecretCo, not the word on screen (Leon, 2026-10-10: "no deberia
// bloquearse solo porque se lea la palabra secretco en pantalla, solo si estoy en
// la org o algo de ellos; una carpeta o un mensaje que los mencione no deberia
// detenerlo"). The first version refused any monitor where OCR read the word,
// which blinded the one with a Claude session merely talking about it.
//
// So, on screen (OCR, loose because OCR misreads letters: an i read as l, 1 or j,
// an n as m, an o as 0) for every name in RESTRICTED_PROJECTS:
//   - their Salesforce org's address (a salesforce/force.com host with their
//     name, or a host listed in DESK_RESTRICTED_HOSTS);
//   - a shell prompt INSIDE their sandbox folder (working there, not a listing
//     that shows the folder's name).
const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OCR = { i: '[il1|!j]', l: '[il1|!j]', 1: '[il1|!j]', n: '[nm]', m: '[nm]', o: '[o0]', 0: '[o0]', s: '[s5]', 5: '[s5]' };
const loose = (name) => [...name].map(c => OCR[c] || ESC(c)).join('');
const NAMES = restrictedGuard.NAMES;
const LOOSE = `(?:${NAMES.map(loose).join('|')})`;
const EXTRA_HOSTS = String(process.env.DESK_RESTRICTED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ORG_HOST = new RegExp(`${LOOSE}[\\w.-]*\\.(?:[\\w-]+\\.)*(?:salesforce|force|salesforce-setup|visualforce)\\.com`, 'i');
const IN_FOLDER_PROMPT = new RegExp(`${LOOSE}-?sand(?:box)?[\\w./\\\\~-]*\\s?[$#>]`, 'i');
function screenSaysRestricted(text) {
    const s = String(text || '');
    if (ORG_HOST.test(s) || IN_FOLDER_PROMPT.test(s)) return true;
    const low = s.toLowerCase().replace(/\s+/g, '');
    return EXTRA_HOSTS.some(h => low.includes(h));
}

// In window titles: a window whose OWN subject is theirs - an editor, terminal
// or file window opened ON the SecretCoSandbox folder, a window named after the
// secretco tmux session, their org in a browser. A mail, a chat or a document
// that only names them does not count.
// ONE pattern, written so JavaScript and .NET read it the same: lib/desk.js
// checks every title with it, and act.ps1 checks the window in front with it
// in the same run as the click (a title is "<process>: <window title>").
const WORK_APPS = 'Code|Cursor|WindowsTerminal|wt|cmd|powershell|pwsh|explorer|mintty|ubuntu\\S*|wsl\\S*|idea64|notepad\\+\\+|sublime_text';
const NAME_ALT = NAMES.map(ESC).join('|');
const SANDBOX = `(?:${NAMES.map(n => ESC(n) + '-?sandbox').join('|')})`;
const THEIRS = `(?:\\b(?:${NAME_ALT})\\b|${SANDBOX})`;
const DENY_SOURCE = [
    `^\\s*(?:${WORK_APPS})\\s*:.*${SANDBOX}`,                                    // an editor/terminal/folder ON their sandbox
    `^\\s*(?:${WORK_APPS})\\s*:\\s*\\[?(?:${NAME_ALT})(?:\\]|:|\\s|$)`,             // a terminal on their tmux session
    `${THEIRS}.*(?:salesforce|force\\.com|lightning|setup)`,                 // their org in a browser
    `(?:salesforce|force\\.com|lightning|setup).*${THEIRS}`,
    ORG_HOST.source,
    IN_FOLDER_PROMPT.source,
    ...EXTRA_HOSTS.map(ESC),
].join('|');
const DENY = new RegExp(DENY_SOURCE, 'i');
function titleIsRestrictedWork(title) {
    return DENY.test(String(title || ''));
}

function toWin(p) {
    const m = String(p).match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : null;
}
function fromWin(p) {
    const m = String(p).match(/^([A-Za-z]):\\(.*)$/);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : null;
}

// Layer 1. Written at most every 10 s: the terminal polls every few seconds.
let seenWritten = 0;
function sawRestrictedPane(now = Date.now()) {
    if (now - seenWritten < 10000) return;
    seenWritten = now;
    try {
        fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
        fs.writeFileSync(SEEN_FILE, String(now));
    } catch (e) { console.warn('[desk] mark:', e.message); }
}
function restrictedPaneRecently(now = Date.now()) {
    let at = 0;
    try { at = Number(fs.readFileSync(SEEN_FILE, 'utf8')) || 0; } catch { at = 0; }
    return now - at < RESTRICTED_VIEW_MS;
}

class DeskRefused extends Error {
    constructor(msg) { super(msg); this.name = 'DeskRefused'; this.code = 'DESK_REFUSED'; }
}

function cleanup(now = Date.now()) {
    let names = [];
    try { names = fs.readdirSync(DIR); } catch { return; }
    for (const n of names) {
        const f = path.join(DIR, n);
        try {
            if (/\.staged\.png$|\.ocr\.png$/.test(n) || now - fs.statSync(f).mtimeMs > KEEP_MS) fs.unlinkSync(f);
        } catch { /* gone already */ }
    }
}

// Parses look.ps1's records. Pure, so the checks can feed it lines.
function parse(out) {
    const titles = [];
    const shots = [];
    let cursor = null;
    for (const line of String(out || '').split(/\r?\n/)) {
        if (line.startsWith('T|')) titles.push(line.slice(2).trim());
        const c = /^C\|(-?\d+)\|(-?\d+)\s*$/.exec(line);
        if (c) cursor = { x: Number(c[1]), y: Number(c[2]) };
        const m = /^S\|(\d+)\|(-?\d+)\|(-?\d+)\|(\d+)\|(\d+)\|(.+)\|([A-Za-z0-9+/=]*)$/.exec(line.trim());
        if (m) shots.push({
            screen: Number(m[1]), x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]),
            staged: fromWin(m[6]) || m[6], text: Buffer.from(m[7], 'base64').toString('utf8'),
        });
    }
    return { titles, shots, cursor };
}

// The decision, separate from the capture so it can be tested without a screen.
// Returns { shots: [kept], refused: [{screen, why}], titles }, or throws when
// nothing at all may be shown.
function judge({ titles, shots }, now = Date.now()) {
    if (restrictedPaneRecently(now)) throw new DeskRefused('TSRCT showed the SecretCo session in the last couple of minutes, so I do not look at the screen');
    if (titles.some(t => titleIsRestrictedWork(t))) throw new DeskRefused('there is an SecretCo window open on the PC (their folder, their session or their org), so I do not look at the screen');
    const kept = [];
    const refused = [];
    for (const s of shots) {
        if (screenSaysRestricted(s.text)) refused.push({ screen: s.screen, why: 'that screen shows SecretCo work (their org or their folder)' });
        else kept.push(s);
    }
    if (!kept.length) throw new DeskRefused(refused.length ? `${refused.length > 1 ? 'every screen shows' : `screen ${refused[0].screen} shows`} SecretCo work (their org or their folder), so I do not look at it` : 'nothing was captured');
    return { titles, shots: kept, refused };
}

function runPs(script, args) {
    return new Promise((resolve, reject) => {
        if (!PS) return reject(new Error('PowerShell not found (not WSL?)'));
        const file = toWin(script);
        if (!file) return reject(new Error('the desk scripts are not on a Windows drive'));
        execFile(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
        { encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
            if (err) return reject(new Error(`the PC did not answer: ${String(stderr || err.message).split('\n')[0].slice(0, 200)}`));
            resolve(stdout);
        });
    });
}

// ── the record (2026-10-10) ──────────────────────────────────────────────────
// Leon: "al igual que como se graban las interacciones con ella ... tambien se
// pueden grabar estas interacciones de desktop asi en el review podes corregir
// todo issue detectado?" Every look, act and refusal is one line in
// logs/tesla/desk/YYYY-MM-DD.jsonl (gitignored, like the conversation log), and
// the screenshots a model actually saw are KEPT for DESK_KEEP_DAYS under
// logs/tesla/desk/shots/<day>/ so a review can see what she saw. A refused
// screen was never kept. scripts/tesla-review.js reads it (--desk).
const LOG_DIR = process.env.DESK_LOG_DIR || path.join(ROOT, 'logs', 'tesla', 'desk');
const KEEP_DAYS = Number(process.env.DESK_KEEP_DAYS || 3);
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function keepShot(file) {
    try {
        const dir = path.join(LOG_DIR, 'shots', localDay());
        fs.mkdirSync(dir, { recursive: true });
        const to = path.join(dir, path.basename(file));
        fs.copyFileSync(file, to);
        return to;
    } catch (e) { console.warn('[desk] keep shot:', e.message); return ''; }
}
let pruned = 0;
function logDesk(row) {
    if (process.env.DESK_LOG === '0') return;
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(path.join(LOG_DIR, `${localDay()}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
        if (Date.now() - pruned > 3600000) {
            pruned = Date.now();
            const cut = localDay(new Date(Date.now() - KEEP_DAYS * 86400000));
            for (const d of fs.readdirSync(path.join(LOG_DIR, 'shots'))) if (d < cut) fs.rmSync(path.join(LOG_DIR, 'shots', d), { recursive: true, force: true });
        }
    } catch (e) { if (e.code !== 'ENOENT') console.warn('[desk] log:', e.message); }
}

// ── what the eyes and hands remember between two CLI runs ──
// Each `node scripts/desk.js` is its own process, so this is a file.
const STATE_FILE = process.env.DESK_STATE_FILE || path.join(ROOT, '.tsrct', 'desk-state.json');
function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeState(st) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(st));
    } catch (e) { console.warn('[desk] state:', e.message); }
}

// look({screen}) -> { shots: [{screen, x, y, w, h, file}], refused, titles }.
// screen: 0 or empty = every monitor, else 1..N as Windows numbers them.
async function look(opts = {}) {
    const t0 = Date.now();
    try {
        const r = await lookInner(opts);
        logDesk({ kind: 'look', screen: Number(opts.screen) || 0, ms: Date.now() - t0, why: opts.why || '',
            shots: r.shots.map(s => ({ screen: s.screen, w: s.w, h: s.h, kept: keepShot(s.file) })),
            refused: r.refused, windows: r.titles.length });
        return r;
    } catch (e) {
        logDesk({ kind: 'look', screen: Number(opts.screen) || 0, ms: Date.now() - t0, why: opts.why || '', refused: e.code === 'DESK_REFUSED' ? e.message : '', error: e.code === 'DESK_REFUSED' ? '' : e.message });
        throw e;
    }
}
async function lookInner({ screen } = {}) {
    if (restrictedPaneRecently()) throw new DeskRefused('TSRCT showed the SecretCo session in the last couple of minutes, so I do not look at the screen');
    fs.mkdirSync(DIR, { recursive: true });
    cleanup();
    const stamp = `${Date.now()}`;
    const raw = parse(await runPs(SCRIPT, ['-Dir', toWin(DIR), '-Stamp', stamp, '-Screen', String(Number(screen) || 0)]));
    let verdict;
    try {
        verdict = judge(raw);
    } catch (e) {
        for (const s of raw.shots) { try { fs.unlinkSync(s.staged); } catch { /* gone */ } }
        throw e;
    }
    for (const r of verdict.refused) {
        const s = raw.shots.find(x => x.screen === r.screen);
        try { fs.unlinkSync(s.staged); } catch { /* gone */ }
    }
    const shots = verdict.shots.map(s => {
        const file = s.staged.replace(/\.staged\.png$/, '.png');
        fs.renameSync(s.staged, file);
        return { screen: s.screen, x: s.x, y: s.y, w: s.w, h: s.h, file };
    });
    const now = Date.now();
    const st = readState();
    st.lastLookAt = now;
    st.looks = Object.fromEntries(shots.map(s => [s.screen, { at: now, x: s.x, y: s.y, w: s.w, h: s.h }]));
    st.lastLookRefused = verdict.refused.map(r => r.screen);
    if (raw.cursor) st.cursor = { ...raw.cursor, at: now };
    writeState(st);
    return { shots, refused: verdict.refused, titles: verdict.titles };
}

// ── the hands (step two, 2026-10-10) ────────────────────────────────────────
// Leon: "que tesla pueda realmente hacer todo lo que yo puedo hacer como humano".
// Every act is refused unless ALL of these hold, and the first two are checked
// by act.ps1 in the same run as the input, so nothing changes in between:
//   - the cursor is where Tesla left it. If not, HE moved the mouse: she stops,
//     and every act is refused for HUMAN_PAUSE_MS whatever she looks at. Taking
//     the mouse is how he takes the wheel, without saying a word.
//   - the window in front is not SecretCo work (the same DENY pattern as titles).
//   - she looked less than FRESH_MS ago and nothing SecretCo is behind TSRCT.
//   - a click lands on a monitor that was CLEAN in that latest look.
//   - typing and keys go to the window in front, which may be on a monitor she
//     was not allowed to see: only when the latest look refused nothing, or she
//     has since clicked on a clean monitor (that click put the focus there).
const FRESH_MS = Number(process.env.DESK_FRESH_MS || 60 * 1000);
const HUMAN_PAUSE_MS = Number(process.env.DESK_HUMAN_PAUSE_MS || 3 * 60 * 1000);
// drag (2026-10-11): press at x,y and release at toX,toY on the SAME monitor, so
// both ends sit on a screen that was clean in the latest look.
const COORD_OPS = new Set(['click', 'double', 'right', 'move', 'scroll', 'drag']);
const ALL_OPS = new Set([...COORD_OPS, 'type', 'key', 'focus', 'media']);
const MEDIA_KEYS = new Set(['volumeup', 'volumedown', 'volumemute', 'playpause', 'nexttrack', 'prevtrack', 'mediastop']);

// Pure: the state and the request in, the PowerShell arguments out, or a refusal.
function planAct(st, req, now = Date.now()) {
    const op = String(req.op || '');
    if (!ALL_OPS.has(op)) throw new Error(`unknown action "${op}" (click, double, right, move, scroll, drag, type, key)`);
    // `direct`: HE just asked for this one thing by voice (lib/pcDirect.js, only
    // server code sets it - the CLI the worker runs cannot). The mouse pause is
    // for her multi-step jobs; at his desk he has always just touched the mouse.
    // Nothing is seen by a model here, so only the window's own SecretCo check applies.
    // `fast` (2026-10-11): a named shortcut or routine from lib/deskShortcuts.js -
    // fixed keys from a table, never words he said - pressed into a window that
    // code just brought forward and checked. It needs no look either.
    const fastKeys = (op === 'key' || op === 'type') && req.fast === true;
    const direct = (op === 'focus' || op === 'media' || fastKeys) && req.direct === true;
    if (!direct && restrictedPaneRecently(now)) throw new DeskRefused('TSRCT showed the SecretCo session in the last couple of minutes, so I do not touch the PC');
    if (!direct && st.humanAt && now - st.humanAt < HUMAN_PAUSE_MS) throw new DeskRefused(`${OWNER} took the mouse, so I stopped. The wheel is theirs now`);
    const args = ['-Op', op];
    // focus raises a window by NAME (review 2026-10-10: Spotify was open and she
    // went to the Start menu, 22 s). It needs no fresh look - nothing is aimed at
    // a pixel - and act.ps1 checks the window it raises against DENY first.
    // Media keys go to no window and aim at no pixel: no look needed (review #11).
    if (op === 'media') {
        const k = String(req.keys || '').toLowerCase();
        if (!MEDIA_KEYS.has(k)) throw new Error(`media keys are ${[...MEDIA_KEYS].join(', ')}, not "${req.keys}"`);
        const times = Math.max(1, Math.min(60, Math.round(Number(req.times) || 1)));
        args.push('-Keys', k, '-Times', String(times));
        return args;
    }
    if (op === 'focus') {
        const name = String(req.window || '').trim();
        if (!name) throw new Error('focus needs --window <name of the app or window>');
        if (name.length > 80) throw new Error('that window name is too long');
        args.push('-Text', Buffer.from(name, 'utf8').toString('base64'), '-Deny', `(?i)${DENY_SOURCE}`);
        return args;
    }
    // A table shortcut needs no look whoever runs it (the keys are fixed); run by
    // the worker it still stopped above when he took the mouse.
    if (fastKeys) {
        if (op === 'type') {
            const text = String(req.text || '');
            if (!text || text.length > 200) throw new Error('a routine types a short name, not this');
            args.push('-Text', Buffer.from(text, 'utf8').toString('base64'));
        } else {
            const keys = String(req.keys || '').toLowerCase().replace(/\s+/g, '');
            if (!/^[a-z0-9]+(\+[a-z0-9]+){0,3}$/.test(keys)) throw new Error(`keys like "ctrl+s", not "${req.keys}"`);
            args.push('-Keys', keys);
        }
        args.push('-Deny', `(?i)${DENY_SOURCE}`);
        return args;
    }
    if (!st.lastLookAt || now - st.lastLookAt > FRESH_MS) throw new DeskRefused('I have not looked at the screen in the last minute: look first');
    if (COORD_OPS.has(op)) {
        const screen = Number(req.screen);
        const m = st.looks && st.looks[screen];
        if (!screen) throw new Error('falta --screen N (el monitor del PNG donde esta ese punto)');
        if (!m || m.at !== st.lastLookAt) throw new DeskRefused(`screen ${screen} was not part of the latest clean look, so I do not click there`);
        const px = Math.round(Number(req.x));
        const py = Math.round(Number(req.y));
        if (!(px >= 0 && py >= 0 && px < m.w && py < m.h)) throw new Error(`(${req.x}, ${req.y}) is outside screen ${screen}, which is ${m.w}x${m.h}`);
        args.push('-X', String(m.x + px), '-Y', String(m.y + py));
        if (op === 'drag') {
            const tx = Math.round(Number(req.toX));
            const ty = Math.round(Number(req.toY));
            if (!(tx >= 0 && ty >= 0 && tx < m.w && ty < m.h)) throw new Error(`drag needs --to-x/--to-y inside screen ${screen} (${m.w}x${m.h}), not (${req.toX}, ${req.toY})`);
            args.push('-X2', String(m.x + tx), '-Y2', String(m.y + ty));
        }
        if (op === 'scroll') args.push('-Amount', String(Math.max(-30, Math.min(30, Math.round(Number(req.amount) || -3)))));
    } else {
        const blind = (st.lastLookRefused || []).length && !(st.focusCleanAt > st.lastLookAt);
        if (blind) throw new DeskRefused('a screen I may not see could have the focus: click on the window first, then type');
        if (op === 'type') {
            const text = String(req.text || '');
            if (!text) throw new Error('nothing to type');
            if (text.length > 5000) throw new Error('that is more than 5000 characters to type at once');
            args.push('-Text', Buffer.from(text, 'utf8').toString('base64'));
        } else {
            const keys = String(req.keys || '').toLowerCase().replace(/\s+/g, '');
            if (!/^[a-z0-9]+(\+[a-z0-9]+){0,3}$/.test(keys)) throw new Error(`keys like "ctrl+s", "enter" or "win", not "${req.keys}"`);
            args.push('-Keys', keys);
        }
    }
    if (st.cursor && now - st.cursor.at < 10 * 60 * 1000) args.push('-ExpectX', String(st.cursor.x), '-ExpectY', String(st.cursor.y));
    args.push('-Deny', `(?i)${DENY_SOURCE}`);
    return args;
}

// act({op, screen, x, y, text, keys, amount}) -> { ok, front }
async function act(req = {}) {
    const t0 = Date.now();
    const what = { op: req.op, screen: Number(req.screen) || undefined, x: req.x !== undefined ? Number(req.x) : undefined, y: req.y !== undefined ? Number(req.y) : undefined,
        toX: req.toX !== undefined ? Number(req.toX) : undefined, toY: req.toY !== undefined ? Number(req.toY) : undefined,
        keys: req.keys || undefined, times: req.times !== undefined ? Number(req.times) : undefined, window: req.window || undefined, amount: req.amount !== undefined ? Number(req.amount) : undefined,
        text: req.text ? String(req.text).slice(0, 300) : undefined, textLength: req.text ? String(req.text).length : undefined };
    try {
        const r = await actInner(req);
        logDesk({ kind: 'act', ...what, ms: Date.now() - t0, front: r.front });
        return r;
    } catch (e) {
        logDesk({ kind: 'act', ...what, ms: Date.now() - t0, refused: e.code === 'DESK_REFUSED' ? e.message : '', error: e.code === 'DESK_REFUSED' ? '' : e.message,
            humanTook: /took the mouse/.test(e.message) || undefined });
        throw e;
    }
}
// The cursor still for STILL_MS = he let go of the mouse. A probe is one short
// PowerShell (act.ps1 -Op probe), about one a second while he moves.
const STILL_MS = Number(process.env.DESK_STILL_MS || 3000);
const MOVE_WAIT_MS = Number(process.env.DESK_MOVE_WAIT_MS || 60 * 1000);
async function waitStill(h) {
    let [lx, ly] = String(h).split('|').map(Number);
    let stillSince = Date.now();
    const until = Date.now() + MOVE_WAIT_MS;
    while (Date.now() < until) {
        await new Promise(r => setTimeout(r, 1000));
        const out = String(await runPs(ACT_SCRIPT, ['-Op', 'probe']));
        const c = (out.split(/\r?\n/).find(l => l.startsWith('C|')) || '').slice(2).split('|').map(Number);
        if (!Number.isFinite(c[0])) continue;
        if (Math.abs(c[0] - lx) > 6 || Math.abs(c[1] - ly) > 6) { lx = c[0]; ly = c[1]; stillSince = Date.now(); continue; }
        if (Date.now() - stillSince >= STILL_MS) return { x: lx, y: ly };
    }
    return null;
}

async function actInner(req = {}) {
    const st = readState();
    const args = planAct(st, req);
    const out = String(await runPs(ACT_SCRIPT, args));
    const now = Date.now();
    const line = (k) => (out.split(/\r?\n/).find(l => l.startsWith(`${k}|`)) || '').slice(2);
    if (line('H')) {
        // He moved the mouse (2026-10-11, Leon: "que eso solo interrumpa unos segundos
        // la tarea o mientras lo muevo pero que no detenga la tesla automation").
        // Wait while he moves it; once it has been still for STILL_MS, the job goes on -
        // but with a NEW look first (lastLookAt reset), because what she planned on may
        // no longer be on screen. Only if he keeps moving past MOVE_WAIT_MS is it the old
        // full stop: then he really has the wheel.
        const settled = await waitStill(line('H'));
        const fresh = readState();
        if (settled) {
            fresh.cursor = { x: settled.x, y: settled.y, at: Date.now() };
            fresh.lastLookAt = 0;
            writeState(fresh);
            throw new DeskRefused(`${OWNER} moved the mouse and stopped: look at the screen again, then continue the task`);
        }
        const [x, y] = line('H').split('|').map(Number);
        fresh.humanAt = Date.now();
        fresh.cursor = { x, y, at: Date.now() };
        writeState(fresh);
        throw new DeskRefused(`${OWNER} took the mouse, so I stopped. The wheel is theirs now`);
    }
    if (line('D')) throw new DeskRefused('that window is SecretCo work, so I do not touch it');
    if (out.split(/\r?\n/).some(l => l.startsWith('N|'))) throw new Error(`no open window matches "${req.window}": open it instead`);
    const [x, y] = (line('C') || '').split('|').map(Number);
    if (Number.isFinite(x)) st.cursor = { x, y, at: now };
    if (COORD_OPS.has(req.op) && req.op !== 'move' && req.op !== 'scroll') st.focusCleanAt = now;
    writeState(st);
    const front = line('F');
    return { ok: true, front: titleIsRestrictedWork(front) ? '(hidden)' : front };
}

module.exports = { look, act, sawRestrictedPane, restrictedPaneRecently, screenSaysRestricted, titleIsRestrictedWork, DeskRefused, DIR, DENY_SOURCE,
    // for lib/deskWindows.js: the same log, state file, PowerShell door and mouse pause
    logDesk, readState, writeState, runPs, HUMAN_PAUSE_MS,
    _parse: parse, _judge: judge, _planAct: planAct, LOG_DIR, _SEEN_FILE: SEEN_FILE };
