'use strict';
// ── deskWindows.js — windows, layouts, workspaces and zones without the mouse ──
//
// WHY (2026-10-11). Leon: "windows 11 no viene con apps eficientes que te
// permiten guardar sets de ventanas y configuraciones que hacen la navegacion
// muy rapida? podriamos combinar esto con tesla?" and then "te autorizo a
// construir todos los shortcuts y workflows". The plan is TESLA-PC-PATHS.md.
//
// Everything here is ONE short PowerShell or PowerToys call, no screenshot and
// no model: "Spotify a la derecha del monitor" is ~1 s instead of a minute of
// look-click-look. What it covers:
//   - list()              monitors (with their work area) and the open windows
//   - place()             one window into a slot: halves, thirds, quarters,
//                         max/min, centered, or the other monitor
//   - solo()              minimize everything except one window (and TSRCT)
//   - layouts             Tesla's own saved arrangements ("guarda como esta ahora
//                         como foco", "volve a foco"), plus starter ones written
//                         as app + slot so they work before he saves anything
//   - workspaces          PowerToys Workspaces he saved in its editor, launched
//                         by name with its own launcher
//   - zones               FancyZones' layout per monitor, through its own CLI
//
// Safety. A window that IS SecretCo work (lib/desk.js titleIsRestrictedWork) is never
// listed by name, moved, saved into a layout or minimized: windows.ps1 checks
// the same pattern on the window it is about to touch, in the same run. When he
// asks by voice the move is `direct` (he just spoke, so his hand on the mouse is
// expected); when the `hands` worker runs it, the 3-minute "he took the mouse"
// pause of lib/desk.js applies.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { execFile } = require('child_process');
const desk = require('./desk');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'desk', 'windows.ps1');
const LAYOUTS_FILE = process.env.DESK_LAYOUTS_FILE || path.join(ROOT, '.tsrct', 'desk-layouts.json');
const WIN_HOME = paths.WIN_HOME;
const PT_APP = process.env.POWERTOYS_DIR || path.join(WIN_HOME, 'AppData', 'Local', 'PowerToys');
const PT_DATA = path.join(WIN_HOME, 'AppData', 'Local', 'Microsoft', 'PowerToys');
const WORKSPACES_FILE = process.env.PT_WORKSPACES_FILE || path.join(PT_DATA, 'Workspaces', 'workspaces.json');
const MONITORS_TTL_MS = 30 * 60 * 1000;
const LIST_TTL_MS = 3000;

let deps = {
    openApp: null,      // (name) => pcDirect.openApp: launch an app that is not open
    runPs: (script, args) => desk.runPs(script, args),
    exec: (file, args) => new Promise((resolve, reject) => execFile(file, args, { encoding: 'utf8', timeout: 15000, windowsHide: true },
        (err, out, errOut) => err ? reject(new Error(String(errOut || err.message).split('\n')[0].slice(0, 200))) : resolve(String(out || '')))),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
};
function configure(d) { deps = { ...deps, ...(d || {}) }; }

class Soft extends Error { constructor(m) { super(m); this.soft = true; } }

const flat = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// ── the list ────────────────────────────────────────────────────────────────
function parseList(out) {
    const monitors = [];
    const windows = [];
    const rect = (s) => { const [x, y, w, h] = String(s).split(',').map(Number); return { x, y, w, h }; };
    for (const line of String(out || '').split(/\r?\n/)) {
        const p = line.trim().split('|');
        if (p[0] === 'M' && p.length >= 6) monitors.push({ n: Number(p[1]), device: p[2], bounds: rect(p[3]), work: rect(p[4]), primary: p[5] === '1' });
        if (p[0] === 'W' && p.length >= 7) {
            // A title may itself hold no '|' (windows.ps1 strips them), so the fields are fixed.
            const [, hwnd, proc, title, r, mon, state] = p;
            const restricted = desk.titleIsRestrictedWork(`${proc}: ${title}`);
            windows.push({ hwnd, process: proc, title: restricted ? '[restringido]' : title, ...rect(r), screen: Number(mon) || 0, state, restricted });
        }
    }
    return { monitors, windows };
}

let cache = null;
async function list({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < LIST_TTL_MS) return cache.value;
    const value = parseList(await deps.runPs(SCRIPT, ['-Op', 'list']));
    cache = { at: Date.now(), value };
    const st = desk.readState();
    st.monitors = value.monitors;
    st.monitorsAt = Date.now();
    desk.writeState(st);
    return value;
}
async function monitors() {
    const st = desk.readState();
    if (Array.isArray(st.monitors) && st.monitors.length && Date.now() - (st.monitorsAt || 0) < MONITORS_TTL_MS) return st.monitors;
    return (await list({ fresh: true })).monitors;
}

// ── slots ───────────────────────────────────────────────────────────────────
// A slot is a fraction of the monitor's WORK AREA (the screen minus the taskbar).
const SLOTS = {
    left: [0, 0, 1 / 2, 1], right: [1 / 2, 0, 1 / 2, 1], top: [0, 0, 1, 1 / 2], bottom: [0, 1 / 2, 1, 1 / 2],
    tl: [0, 0, 1 / 2, 1 / 2], tr: [1 / 2, 0, 1 / 2, 1 / 2], bl: [0, 1 / 2, 1 / 2, 1 / 2], br: [1 / 2, 1 / 2, 1 / 2, 1 / 2],
    third1: [0, 0, 1 / 3, 1], third2: [1 / 3, 0, 1 / 3, 1], third3: [2 / 3, 0, 1 / 3, 1],
    'twothirds-left': [0, 0, 2 / 3, 1], 'twothirds-right': [1 / 3, 0, 2 / 3, 1],
    center: [0.15, 0.1, 0.7, 0.8],
};
const STATE_SLOTS = new Set(['max', 'min', 'restore']);
function slotRect(work, slot) {
    const f = SLOTS[slot];
    if (!f) throw new Error(`no conozco el lugar "${slot}"`);
    // Edges rounded from the fractions, so two halves meet exactly with no gap.
    const x0 = work.x + Math.round(work.w * f[0]);
    const y0 = work.y + Math.round(work.h * f[1]);
    const x1 = work.x + Math.round(work.w * (f[0] + f[2]));
    const y1 = work.y + Math.round(work.h * (f[1] + f[3]));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// His words -> a slot. Longest phrases first; null when he named no place.
const SLOT_WORDS = [
    [/\b(arriba a la izquierda|esquina (superior )?izquierda( de arriba)?|izquierda arriba)\b/, 'tl'],
    [/\b(arriba a la derecha|esquina (superior )?derecha( de arriba)?|derecha arriba)\b/, 'tr'],
    [/\b(abajo a la izquierda|esquina inferior izquierda|izquierda abajo)\b/, 'bl'],
    [/\b(abajo a la derecha|esquina inferior derecha|derecha abajo)\b/, 'br'],
    [/\bdos tercios\b.*\bizquierd/, 'twothirds-left'], [/\bdos tercios\b.*\bderech/, 'twothirds-right'],
    [/\btercio\b.*\bizquierd|\bizquierd\w*\b.*\btercio\b/, 'third1'], [/\btercio\b.*\b(centro|medio|central)\b/, 'third2'], [/\btercio\b.*\bderech|\bderech\w*\b.*\btercio\b/, 'third3'],
    [/\b(maximiz\w*|pantalla completa|toda la pantalla|todo el monitor|agrandal\w*|en grande)\b/, 'max'],
    [/\b(minimiz\w*|escondel\w*|escond\w*|ocultal\w*)\b/, 'min'],
    [/\b(restaur\w*)\b/, 'restore'],
    [/\b(centrad\w*|al centro|en el centro|al medio)\b/, 'center'],
    [/\bizquierd\w*\b/, 'left'], [/\bderech\w*\b/, 'right'],
    [/\b(arriba|mitad de arriba|mitad superior)\b/, 'top'], [/\b(abajo|mitad de abajo|mitad inferior)\b/, 'bottom'],
];
// Which monitor. The laptop is the primary one (screen 1 today); "el monitor",
// "el samsung", "el externo" is the other. "el otro" is relative to the window.
const SCREEN_WORDS = [
    [/\b((al|el|del|en el) otro( monitor)?|(la|a la|en la) otra( pantalla)?|cambiala de monitor|cambialo de monitor|de monitor)\b/, 'other'],
    [/\b(notebook|laptop|la compu|pantalla principal|monitor principal|principal|monitor (1|uno)|pantalla (1|uno)|primer monitor)\b/, 'primary'],
    [/\b(samsung|externo|monitor externo|segundo monitor|monitor (2|dos)|pantalla (2|dos)|el monitor|al monitor|del monitor)\b/, 'secondary'],
];
function parseWhere(text) {
    const t = flat(text);
    let slot = null, screen = null;
    for (const [re, s] of SLOT_WORDS) if (re.test(t)) { slot = s; break; }
    for (const [re, s] of SCREEN_WORDS) if (re.test(t)) { screen = s; break; }
    return { slot, screen };
}
function pickMonitor(mons, which, current) {
    if (!mons.length) throw new Error('no veo ningun monitor');
    if (which === undefined || which === null || which === '') return mons.find(m => m.n === current) || mons.find(m => m.primary) || mons[0];
    const n = Number(which);
    if (n) { const m = mons.find(x => x.n === n); if (!m) throw new Soft(`no hay un monitor ${n}; tenes ${mons.length}`); return m; }
    if (which === 'primary') return mons.find(m => m.primary) || mons[0];
    if (which === 'secondary') return mons.find(m => !m.primary) || mons[0];
    if (which === 'other') return mons.find(m => m.n !== current) || mons[0];
    throw new Error(`no se que monitor es "${which}"`);
}

// Pure: what to send windows.ps1 for one window. `win` is its current place when
// known (needed to move it to the other monitor keeping its shape).
function planPlace(mons, { window: name, slot, screen }, win) {
    const target = pickMonitor(mons, screen, win && win.screen);
    if (slot === 'min' || slot === 'restore') return { match: name, state: slot, front: slot === 'restore' };
    if (slot === 'max') return { match: name, state: 'max', front: true, ...centerOf(target.work) };
    if (slot) return { match: name, front: true, ...slotRect(target.work, slot) };
    // No slot: the same shape, on the other monitor.
    if (!win) throw new Error('para cambiarla de monitor necesito saber donde esta');
    if (win.state === 'max') return { match: name, state: 'max', front: true, ...centerOf(target.work) };
    const from = (mons.find(m => m.n === win.screen) || target).work;
    const fx = (win.x - from.x) / from.w, fy = (win.y - from.y) / from.h;
    const fw = Math.min(1, win.w / from.w), fh = Math.min(1, win.h / from.h);
    const w = Math.round(target.work.w * fw), h = Math.round(target.work.h * fh);
    const x = target.work.x + Math.max(0, Math.min(target.work.w - w, Math.round(target.work.w * fx)));
    const y = target.work.y + Math.max(0, Math.min(target.work.h - h, Math.round(target.work.h * fy)));
    return { match: name, front: true, x, y, w, h };
}
function centerOf(work) { return slotRect(work, 'center'); }

// Mouse pause for the worker; a voice request is direct.
function gate(direct) {
    if (direct) return;
    if (desk.restrictedPaneRecently()) throw new desk.DeskRefused('TSRCT showed the SecretCo session in the last couple of minutes, so I do not touch the PC');
    const st = desk.readState();
    if (st.humanAt && Date.now() - st.humanAt < desk.HUMAN_PAUSE_MS) throw new desk.DeskRefused('Leon took the mouse, so I stopped. He has the wheel now');
}

function findWindow(windows, name) {
    const n = flat(name);
    if (!n) return null;
    const ok = windows.filter(w => !w.restricted);
    return ok.find(w => flat(w.process) === n) || ok.find(w => flat(w.process).includes(n)) || ok.find(w => flat(w.title).includes(n)) || null;
}

async function apply(moves) {
    const b64 = Buffer.from(JSON.stringify(moves), 'utf8').toString('base64');
    const out = String(await deps.runPs(SCRIPT, ['-Op', 'apply', '-Text', b64, '-Deny', `(?i)${desk.DENY_SOURCE}`]));
    cache = null;
    return out.split(/\r?\n/).filter(l => l.startsWith('P|')).map(l => {
        const [, how, a, b, r] = l.trim().split('|');
        if (how === 'ok') { const [x, y, w, h] = String(r || '').split(',').map(Number); return { ok: true, process: a, title: desk.titleIsRestrictedWork(`${a}: ${b}`) ? '' : b, x, y, w, h }; }
        return { ok: false, how, what: how === 'deny' ? '' : a };
    });
}

// place({window, where, slot, screen, direct}) - "where" is his words, or give slot/screen.
async function place({ window: name, where, slot, screen, direct = false } = {}) {
    const n = String(name || '').trim();
    if (!n || n.length > 60) throw new Error('falta que ventana');
    restrictedGuard.assertNotRestricted('tesla place window', n);
    gate(direct);
    const said = where ? parseWhere(where) : { slot: null, screen: null };
    const s = slot || said.slot;
    const sc = screen || said.screen;
    if (!s && !sc) throw new Soft('a donde la pongo? (izquierda, derecha, arriba, grande, el otro monitor...)');
    const needWin = !s || sc === 'other' || !sc;
    const t0 = Date.now();
    let win = null, mons;
    if (needWin) {
        const l = await list({ fresh: true });
        mons = l.monitors;
        win = findWindow(l.windows, n);
        if (!win) throw new Soft(`no veo ninguna ventana de ${n} abierta`);
    } else mons = await monitors();
    const move = planPlace(mons, { window: win ? win.hwnd : n, slot: s, screen: sc }, win);
    if (win) { move.hwnd = win.hwnd; delete move.match; }
    const [r] = await apply([move]);
    desk.logDesk({ kind: 'place', window: n, slot: s || 'same', screen: sc || '', direct, ms: Date.now() - t0, ok: !!(r && r.ok), why: r && !r.ok ? r.how : undefined });
    if (!r || !r.ok) {
        if (r && r.how === 'deny') throw new desk.DeskRefused('that window is SecretCo work, so I do not touch it');
        throw new Soft(`no veo ninguna ventana de ${n} abierta`);
    }
    return { window: r.process, slot: s || 'same', screen: sc || '', rect: { x: r.x, y: r.y, w: r.w, h: r.h } };
}

// Several at once: "spotify a la izquierda y chrome a la derecha".
async function placeMany(items, { direct = false } = {}) {
    const done = [];
    const failed = [];
    for (const it of items) {
        try { done.push(await place({ ...it, direct })); } catch (e) { if (e.code === 'DESK_REFUSED') throw e; failed.push({ window: it.window, why: e.message }); }
    }
    return { done, failed };
}

// Minimize everything except `keep` (and TSRCT itself, which is where she lives).
async function solo({ keep, direct = false } = {}) {
    const k = String(keep || '').trim();
    if (!k) throw new Error('falta cual dejo');
    restrictedGuard.assertNotRestricted('tesla solo window', k);
    gate(direct);
    const b64 = Buffer.from(JSON.stringify({ keep: [k, 'TSRCT'] }), 'utf8').toString('base64');
    const out = String(await deps.runPs(SCRIPT, ['-Op', 'solo', '-Text', b64, '-Deny', `(?i)${desk.DENY_SOURCE}`]));
    cache = null;
    const m = /^S\|(\d+)/m.exec(out);
    const n = m ? Number(m[1]) : 0;
    desk.logDesk({ kind: 'solo', keep: k, minimized: n, direct });
    try { await place({ window: k, slot: 'restore', direct: true }); } catch { /* it may already be in front */ }
    return { keep: k, minimized: n };
}

// ── layouts: Tesla's own saved arrangements ─────────────────────────────────
// A layout is a list of { app, title, screen (monitor device), slot | rect, state }.
// The STARTERS are written as app + slot, so "modo trabajo" does something useful
// before he saves anything; "guarda como esta ahora como trabajo" replaces one.
// The guesses are his everyday apps (the windows open on 2026-10-11: Chrome with
// TSRCT and claude.ai, ClickUp, Slack, Notepad, Spotify) - say so when used.
const STARTERS = {
    trabajo: { starter: true, windows: [
        { app: 'chrome', title: 'TSRCT', screen: 'primary', slot: 'max' },
        { app: 'clickup', screen: 'secondary', slot: 'left' },
        { app: 'slack', screen: 'secondary', slot: 'right' },
    ] },
    // Not "foco": "modo foco" is TSRCT's own focus mode (check-talk).
    concentracion: { starter: true, solo: 'TSRCT', windows: [
        { app: 'chrome', title: 'TSRCT', screen: 'primary', slot: 'max' },
    ] },
    comunicacion: { starter: true, windows: [
        { app: 'slack', screen: 'secondary', slot: 'left' },
        { app: 'whatsapp', screen: 'secondary', slot: 'right' },
    ] },
    musica: { starter: true, windows: [
        { app: 'spotify', screen: 'secondary', slot: 'right' },
    ] },
};

function readLayouts() {
    try { return JSON.parse(fs.readFileSync(LAYOUTS_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeLayouts(all) {
    fs.mkdirSync(path.dirname(LAYOUTS_FILE), { recursive: true });
    fs.writeFileSync(LAYOUTS_FILE, JSON.stringify(all, null, 1));
}
function layoutKey(name) {
    return flat(name).replace(/^(el |la |modo |setup de |setup |layout |disposicion )+/, '').replace(/[^a-z0-9 ]/g, '').trim();
}
function allLayouts() {
    return { ...STARTERS, ...readLayouts() };
}
function listLayouts() {
    return Object.entries(allLayouts()).map(([name, l]) => ({ name, starter: !!l.starter, apps: (l.windows || []).map(w => w.app) }));
}

// The stable part of a title: "Spotify Premium - Some Song" -> "Spotify Premium";
// a browser keeps its page name, which is what tells two Chrome windows apart.
function titlePattern(proc, title) {
    const t = String(title || '');
    const parts = t.split(/ [-|–—] /).map(s => s.trim()).filter(Boolean);
    if (/chrome|msedge|firefox/i.test(proc) && parts.length >= 2) return parts[0].slice(0, 40);
    return parts.length ? parts[parts.length - 1].slice(0, 40) : '';
}

async function saveLayout({ name, overwrite = false } = {}) {
    const key = layoutKey(name);
    if (!key) throw new Error('falta el nombre');
    restrictedGuard.assertNotRestricted('tesla save layout', key);
    const saved = readLayouts();
    if (saved[key] && !overwrite) { const e = new Soft(`ya hay uno que se llama ${key}`); e.exists = true; throw e; }
    const l = await list({ fresh: true });
    const byN = Object.fromEntries(l.monitors.map(m => [m.n, m]));
    const windows = l.windows
        .filter(w => !w.restricted && w.state !== 'min' && !/^(TextInputHost|ApplicationFrameHost|SystemSettings|ShellExperienceHost)$/i.test(w.process))
        .map(w => {
            const m = byN[w.screen];
            const rel = m ? { fx: (w.x - m.work.x) / m.work.w, fy: (w.y - m.work.y) / m.work.h, fw: w.w / m.work.w, fh: w.h / m.work.h } : null;
            return { app: w.process, title: titlePattern(w.process, w.title), screen: m ? m.device : '', state: w.state, rel };
        });
    if (!windows.length) throw new Soft('no hay ventanas abiertas para guardar');
    saved[key] = { savedAt: new Date().toISOString(), windows };
    writeLayouts(saved);
    desk.logDesk({ kind: 'layout-save', name: key, windows: windows.length });
    return { name: key, windows: windows.length };
}

function deleteLayout(name) {
    const key = layoutKey(name);
    const saved = readLayouts();
    if (!saved[key]) throw new Soft(STARTERS[key] ? `${key} es uno de los de fabrica, no se borra (lo podes pisar guardando otro con ese nombre)` : `no tengo uno que se llame ${key}`);
    delete saved[key];
    writeLayouts(saved);
    return { name: key };
}

// Best match for a spoken name among names; null or an ambiguity list.
function matchName(spoken, names) {
    const k = layoutKey(spoken);
    if (!k) return { hit: null, options: [] };
    if (names.includes(k)) return { hit: k, options: [] };
    const pre = names.filter(n => n.startsWith(k) || k.startsWith(n));
    if (pre.length === 1) return { hit: pre[0], options: [] };
    const words = new Set(k.split(' '));
    const share = names.filter(n => n.split(' ').some(w => w.length >= 4 && words.has(w)));
    if (share.length === 1) return { hit: share[0], options: [] };
    return { hit: null, options: pre.length ? pre : share };
}

async function restoreLayout({ name, direct = false } = {}) {
    const all = allLayouts();
    const { hit, options } = matchName(name, Object.keys(all));
    if (!hit) throw new Soft(options.length ? `cual: ${options.join(' o ')}?` : `no tengo uno que se llame ${layoutKey(name)}; tengo ${Object.keys(all).join(', ')}`);
    gate(direct);
    const lay = all[hit];
    const t0 = Date.now();
    if (lay.solo) { try { await solo({ keep: lay.solo, direct: true }); } catch { /* best effort */ } }
    let l = await list({ fresh: true });
    const missing = [];
    const moves = [];
    const usedHwnd = new Set();
    for (const w of lay.windows || []) {
        if (restrictedGuard.mentionsRestricted(`${w.app} ${w.title || ''}`)) continue;
        const pick = (wins) => wins.filter(x => !x.restricted && !usedHwnd.has(x.hwnd) && flat(x.process).includes(flat(w.app)))
            .sort((a, b) => (w.title && flat(b.title).includes(flat(w.title)) ? 1 : 0) - (w.title && flat(a.title).includes(flat(w.title)) ? 1 : 0))[0];
        let win = pick(l.windows);
        if (!win && deps.openApp) {
            // Not open: launch it and wait for its window, one at a time, max 8 s.
            try {
                await deps.openApp(w.app);
                for (let i = 0; i < 16 && !win; i++) { await deps.sleep(500); l = await list({ fresh: true }); win = pick(l.windows); }
            } catch { /* reported below */ }
        }
        if (!win) { missing.push(w.app); continue; }
        usedHwnd.add(win.hwnd);
        const mon = l.monitors.find(m => m.device === w.screen) || (w.screen === 'primary' || w.screen === 'secondary' || w.screen === 'other' ? pickMonitor(l.monitors, w.screen, win.screen) : null)
            || l.monitors.find(m => m.primary) || l.monitors[0];
        if (w.slot) {
            const mv = planPlace(l.monitors, { window: win.hwnd, slot: w.slot, screen: mon.n }, win);
            moves.push({ ...mv, hwnd: win.hwnd, match: undefined, front: false });
        } else if (w.rel) {
            const r = { x: mon.work.x + Math.round(w.rel.fx * mon.work.w), y: mon.work.y + Math.round(w.rel.fy * mon.work.h), w: Math.round(w.rel.fw * mon.work.w), h: Math.round(w.rel.fh * mon.work.h) };
            moves.push({ hwnd: win.hwnd, ...r, state: w.state === 'max' ? 'max' : undefined, front: false });
        }
    }
    const res = moves.length ? await apply(moves) : [];
    // The first window of the layout ends in front.
    if (moves[0]) { try { await apply([{ hwnd: moves[0].hwnd, state: 'front', front: true }]); } catch { /* fine */ } }
    const placed = res.filter(r => r.ok).length;
    desk.logDesk({ kind: 'layout-restore', name: hit, starter: !!lay.starter, placed, missing, ms: Date.now() - t0, direct });
    return { name: hit, starter: !!lay.starter, placed, missing };
}

// ── PowerToys Workspaces ────────────────────────────────────────────────────
// He saves them in the PowerToys editor; we read the file the editor writes and
// start a set with PowerToys' own launcher. The launcher's arguments are what the
// editor's "desktop shortcut" uses: the workspace id, then 1 (launched from a
// shortcut). VERIFY the first time one exists (TESLA-PC-PATHS.md, phase 3).
function readWorkspaces() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8')); } catch { return []; }
    const arr = Array.isArray(raw) ? raw : (raw.workspaces || []);
    return arr.map(w => ({ id: w.id, name: String(w.name || ''), apps: (w.applications || []).map(a => String(a.application || a['application-path'] || '').replace(/\.exe$/i, '')) }))
        .filter(w => w.id && w.name && !restrictedGuard.mentionsRestricted(`${w.name} ${w.apps.join(' ')}`));
}
async function openWorkspace({ name } = {}) {
    const all = readWorkspaces();
    if (!all.length) throw new Soft('todavia no guardaste ningun workspace en PowerToys');
    const byKey = Object.fromEntries(all.map(w => [layoutKey(w.name), w]));
    const { hit, options } = matchName(name, Object.keys(byKey));
    if (!hit) throw new Soft(options.length ? `cual: ${options.join(' o ')}?` : `no hay un workspace ${layoutKey(name)}; tenes ${all.map(w => w.name).join(', ')}`);
    const ws = byKey[hit];
    const exe = path.join(PT_APP, 'PowerToys.WorkspacesLauncher.exe');
    if (!fs.existsSync(exe)) throw new Soft('no encuentro el lanzador de PowerToys Workspaces');
    const t0 = Date.now();
    await deps.exec(exe, [ws.id, '1']);
    desk.logDesk({ kind: 'workspace', name: ws.name, ms: Date.now() - t0 });
    return { name: ws.name, apps: ws.apps };
}

// "modo X" / "arma X": a PowerToys workspace wins over a layout of the same name.
async function arrange({ name, direct = false } = {}) {
    const ws = readWorkspaces();
    const wsKeys = ws.map(w => layoutKey(w.name));
    if (matchName(name, wsKeys).hit) return { how: 'workspace', ...(await openWorkspace({ name })) };
    return { how: 'layout', ...(await restoreLayout({ name, direct })) };
}
function arrangeNames() {
    return [...new Set([...readWorkspaces().map(w => layoutKey(w.name)), ...Object.keys(allLayouts())])];
}

// ── FancyZones ──────────────────────────────────────────────────────────────
const ZONE_WORDS = [
    [/\b(sin zonas|ninguna|nada|vacio|blank)\b/, 'blank'],
    [/\b(prioridad|uno grande al medio|grande al medio|priority)\b/, 'priority-grid'],
    [/\b(grilla|cuadricula|cuadros|grid)\b/, 'grid'],
    [/\b(columnas|columns)\b/, 'columns'],
    [/\b(filas|rows)\b/, 'rows'],
    [/\b(foco|focus)\b/, 'focus'],
];
function zoneTemplate(text) {
    const t = flat(text);
    for (const [re, z] of ZONE_WORDS) if (re.test(t)) return z;
    return null;
}
async function setZones({ layout, screen } = {}) {
    const tpl = zoneTemplate(layout) || (/^[a-z-]+$/.test(String(layout || '')) ? String(layout) : null);
    if (!tpl) throw new Soft('que forma: columnas, filas, grilla, prioridad, foco o sin zonas?');
    const exe = path.join(PT_APP, 'FancyZonesCLI.exe');
    if (!fs.existsSync(exe)) throw new Soft('no encuentro FancyZones');
    const args = ['set-layout', tpl];
    // Measured 2026-10-11: with PowerToys closed the CLI only says "FancyZones is
    // not running". That is a sentence for him, not a crash.
    const fz = async (a) => {
        let out;
        try { out = await deps.exec(exe, a); } catch (e) { out = e.message; }
        if (/not running/i.test(out)) throw new Soft('PowerToys esta cerrado; abrilo (o decime "abri powertoys") y lo hago');
        if (/^error/im.test(out)) throw new Soft(`FancyZones dijo: ${out.split('\n')[0].slice(0, 120)}`);
        return out;
    };
    if (screen) {
        // FancyZones numbers monitors its own way (the Samsung is 5, not 2): map by device.
        const mons = await monitors();
        const m = pickMonitor(mons, screen);
        const num = fancyZonesNumber(await fz(['get-monitors']), m);
        if (num) args.push('--monitor', String(num));
    }
    const out = await fz(args);
    desk.logDesk({ kind: 'zones', layout: tpl, screen: screen || 'all' });
    return { layout: tpl, out: out.trim().slice(0, 200) };
}
// get-monitors prints one block per monitor (measured 2026-10-11, v0.100.2):
//   Monitor 2:\n  Monitor: SAM707B ... Position: (-1920, 368) ...
// Its own names (SAM707B) are not Windows' (\\.\DISPLAY5), so a monitor is
// matched by its top-left corner. Returns the number for --monitor, or null.
function fancyZonesNumber(out, mon) {
    const parts = String(out || '').split(/^Monitor (\d+):\s*$/m);
    for (let i = 1; i < parts.length; i += 2) {
        const pos = /Position:\s*\((-?\d+),\s*(-?\d+)\)/.exec(parts[i + 1] || '');
        if (pos && Number(pos[1]) === mon.bounds.x && Number(pos[2]) === mon.bounds.y) return Number(parts[i]);
    }
    return null;
}

module.exports = { configure, list, monitors, place, placeMany, solo, saveLayout, restoreLayout, deleteLayout, listLayouts, arrange, arrangeNames,
    readWorkspaces, openWorkspace, setZones, parseWhere, zoneTemplate, layoutKey, matchName, STARTERS,
    _parseList: parseList, _slotRect: slotRect, _planPlace: planPlace, _pickMonitor: pickMonitor, _titlePattern: titlePattern,
    _fancyZonesNumber: fancyZonesNumber, LAYOUTS_FILE, WORKSPACES_FILE };
