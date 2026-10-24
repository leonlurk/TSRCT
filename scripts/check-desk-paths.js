#!/usr/bin/env node
// scripts/check-desk-paths.js — windows, modes and shortcuts without the mouse
// (lib/deskWindows.js + lib/deskShortcuts.js, 2026-10-11, TESLA-PC-PATHS.md).
//
// No real screen: windows.ps1 and the Windows programs are faked. What it pins:
// the slot math on HIS two monitors (the Samsung sits LEFT of the laptop at a
// negative x), his words to a place, an SecretCo window never moved or saved, the
// named shortcuts being the only keys a sentence can reach, the routines typing
// only into the app they brought forward, and the sentences routed in code.
'use strict';
process.env.WIN_HOME = '/mnt/c/Users/you';   // the Windows side these checks describe
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-desk-paths-'));
process.env.DESK_SEEN_FILE = path.join(tmp, 'seen');
process.env.DESK_STATE_FILE = path.join(tmp, 'state.json');
process.env.DESK_LOG_DIR = path.join(tmp, 'log');
process.env.DESK_LAYOUTS_FILE = path.join(tmp, 'layouts.json');
process.env.PT_WORKSPACES_FILE = path.join(tmp, 'workspaces.json');
const dw = require(path.join(ROOT, 'lib/deskWindows.js'));
const sc = require(path.join(ROOT, 'lib/deskShortcuts.js'));
const desk = require(path.join(ROOT, 'lib/desk.js'));

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log('  [x] ' + label); } };

// His real list, measured 2026-10-11 (titles shortened).
const LIST = [
    'M|1|\\\\.\\DISPLAY1|0,0,2560,1600|0,0,2560,1528|1',
    'M|2|\\\\.\\DISPLAY5|-1920,368,1920,1080|-1920,368,1920,1032|0',
    'W|111|chrome|TSRCT|0,0,2560,1528|1|max',
    'W|222|Notepad|pv-geo-mail-draft-2026-10.txt: Bloc de notas|7,0,2547,1522|1|normal',
    'W|333|Code|main.cls - SecretCoSandbox - Visual Studio Code|0,0,1280,1528|1|normal',
    'W|444|Slack|Sam Bechara (DM) - Acme Cloud Co - Slack|-1920,368,960,1032|2|normal',
    'W|555|chrome|Facturacion del mes pasado - Claude - Google Chrome|0,0,2560,1528|1|max',
].join('\r\n');

async function main() {
    // ── the list ──
    const l = dw._parseList(LIST);
    ok(l.monitors.length === 2 && l.monitors[1].work.x === -1920 && l.monitors[1].work.h === 1032, 'monitors keep the negative x and the work area without the taskbar');
    const ank = l.windows.find(w => w.hwnd === '333');
    ok(ank.restricted && ank.title === '[restringido]' && !JSON.stringify(l).includes('SecretCoSandbox'), 'an SecretCo work window is listed without its title');

    // ── slots on his monitors ──
    const lap = l.monitors[0].work, sam = l.monitors[1].work;
    const L = dw._slotRect(sam, 'left'), R = dw._slotRect(sam, 'right');
    ok(L.x === -1920 && L.w === 960 && R.x === -960 && R.w === 960 && R.h === 1032 && R.y === 368, 'halves of the Samsung meet exactly at its middle, below nothing (y 368)');
    const t = ['third1', 'third2', 'third3'].map(s => dw._slotRect(lap, s));
    ok(t[0].x === 0 && t[0].x + t[0].w === t[1].x && t[1].x + t[1].w === t[2].x && t[2].x + t[2].w === 2560, 'thirds leave no gap and end at the edge');
    ok(dw._slotRect(lap, 'br').y === 764 && dw._slotRect(lap, 'br').x === 1280, 'a corner is a quarter');

    // ── his words ──
    const w = (s) => dw.parseWhere(s);
    ok(w('pone spotify a la derecha del monitor').slot === 'right' && w('pone spotify a la derecha del monitor').screen === 'secondary', '"a la derecha del monitor" = right half of the Samsung');
    ok(w('pasa el chrome al otro monitor').screen === 'other' && !w('pasa el chrome al otro monitor').slot, '"al otro monitor" keeps its shape');
    ok(w('mandalo arriba a la izquierda').slot === 'tl', '"arriba a la izquierda" is a corner, not the top half');
    ok(w('maximizala en la notebook').slot === 'max' && w('maximizala en la notebook').screen === 'primary', '"en la notebook" is the laptop');
    ok(w('el tercio de la derecha').slot === 'third3' && w('dos tercios a la izquierda').slot === 'twothirds-left', 'thirds by name');

    // moving to the other monitor keeps the shape and stays inside it
    const slack = l.windows.find(x => x.process === 'Slack');
    const mv = dw._planPlace(l.monitors, { window: '444', screen: 'other' }, slack);
    ok(mv.x === 0 && mv.w === 1280 && mv.h === 1528, 'the left half of the Samsung becomes the left half of the laptop');

    // ── place, with windows.ps1 faked ──
    const calls = [];
    dw.configure({ runPs: async (script, args) => {
        calls.push(args);
        if (args[1] === 'list') return LIST;
        if (args[1] === 'apply') {
            const moves = JSON.parse(Buffer.from(args[3], 'base64').toString('utf8'));
            return moves.map(m => m.hwnd === '333' ? 'P|deny|Code: x' : `P|ok|Notepad|t|${m.x || 0},${m.y || 0},${m.w || 0},${m.h || 0}`).join('\n');
        }
        if (args[1] === 'solo') return 'S|3';
        return '';
    }, sleep: async () => {} });
    const r = await dw.place({ window: 'notepad', where: 'a la derecha del monitor', direct: true });
    ok(r.rect.x === -960 && r.rect.w === 960, 'place sends the Samsung right half');
    const applyArgs = calls.find(a => a[1] === 'apply');
    ok(applyArgs && applyArgs.includes('-Deny') && new RegExp(applyArgs[applyArgs.indexOf('-Deny') + 1].replace(/^\(\?i\)/, ''), 'i')   /* (?i) is .NET's flag */.test('Code: secretco-sandbox - main.js'), 'windows.ps1 gets the restricted-project pattern, and it matches a window open on the sandbox folder');
    let refused = null;
    try { await dw.place({ window: 'code', where: 'a la izquierda', direct: true }); } catch (e) { refused = e; }
    ok(refused && !/SecretCoSandbox/.test(refused.message), 'the SecretCo VS Code window is never found by name (it is listed as restricted)');
    let ankName = null;
    try { await dw.place({ window: 'secretco', where: 'izquierda', direct: true }); } catch (e) { ankName = e; }
    ok(ankName && ankName.code === 'RESTRICTED_PROJECT', 'a request naming SecretCo is refused before anything runs');
    let noPlace = null;
    try { await dw.place({ window: 'notepad', where: 'por ahi', direct: true }); } catch (e) { noPlace = e; }
    ok(noPlace && noPlace.soft && /a donde/.test(noPlace.message), 'no place in the sentence is a question for him, not a crash');

    // the worker stops when he has the mouse; his voice does not
    desk.writeState({ humanAt: Date.now() });
    let stopped = null;
    try { await dw.place({ window: 'notepad', slot: 'left' }); } catch (e) { stopped = e; }
    ok(stopped && stopped.code === 'DESK_REFUSED', 'the worker does not move windows while he holds the mouse');
    let byVoice = null;
    try { byVoice = await dw.place({ window: 'notepad', slot: 'left', direct: true }); } catch (e) { byVoice = e; }
    ok(byVoice && byVoice.rect, 'but a move he asked for by voice runs');
    desk.writeState({});

    // ── layouts ──
    const saved = await dw.saveLayout({ name: 'modo prueba' });
    const file = JSON.parse(fs.readFileSync(process.env.DESK_LAYOUTS_FILE, 'utf8'));
    ok(saved.name === 'prueba' && file.prueba, '"modo prueba" is saved as prueba');
    ok(!JSON.stringify(file).includes('SecretCoSandbox') && !file.prueba.windows.some(x => x.app === 'Code'), 'an SecretCo window is never saved into a layout');
    let again = null;
    try { await dw.saveLayout({ name: 'prueba' }); } catch (e) { again = e; }
    ok(again && again.exists, 'saving over an existing name needs overwrite (the action asks him)');
    ok(dw.listLayouts().some(x => x.name === 'trabajo' && x.starter) && !dw.listLayouts().some(x => x.name === 'foco'), 'starter modes exist, and none is called "foco" (TSRCT\'s focus mode)');
    const rest = await dw.restoreLayout({ name: 'prueba', direct: true });
    ok(rest.placed >= 1 && rest.missing.length === 0, 'restoring places the saved windows');
    ok(dw.matchName('el modo trabaj', ['trabajo', 'musica']).hit === 'trabajo', 'a half-heard name still finds its mode');

    // ── PowerToys workspaces ──
    fs.writeFileSync(process.env.PT_WORKSPACES_FILE, JSON.stringify({ workspaces: [
        { id: '{A}', name: 'Clientes', applications: [{ application: 'chrome.exe' }] },
        { id: '{B}', name: 'SecretCo review', applications: [{ application: 'Code.exe' }] },
    ] }));
    const ws = dw.readWorkspaces();
    ok(ws.length === 1 && ws[0].name === 'Clientes', 'a workspace naming SecretCo is never listed');
    ok(dw.arrangeNames().includes('clientes') && dw.arrangeNames().includes('trabajo'), 'arrange knows the workspaces and the layouts');

    // ── FancyZones ──
    const fz = 'Monitor 1:\n  Position: (0, 0)\n\nMonitor 2:\n  Monitor: SAM707B\n  Position: (-1920, 368)\n';
    ok(dw._fancyZonesNumber(fz, l.monitors[1]) === 2 && dw._fancyZonesNumber(fz, l.monitors[0]) === 1, 'the Samsung is FancyZones monitor 2, matched by position (measured)');
    ok(dw.zoneTemplate('ponelo en columnas') === 'columns' && dw.zoneTemplate('sin zonas') === 'blank' && dw.zoneTemplate('prioridad') === 'priority-grid', 'zone words');
    dw.configure({ exec: async () => { throw new Error('Error: FancyZones is not running. Start PowerToys (FancyZones) and retry.'); } });
    process.env.POWERTOYS_DIR = tmp;
    let fzOff = null;
    try { await dw.setZones({ layout: 'columnas' }); } catch (e) { fzOff = e; }
    ok(fzOff && fzOff.soft, 'PowerToys closed (or missing) is a sentence for him');

    // ── shortcuts ──
    ok(sc.findShortcut('mostrame el escritorio').keys === 'win+d', '"mostrame el escritorio" = Win+D');
    ok(sc.findShortcut('cerra la pestana').avoid === 'TSRCT', 'closing a tab never targets the TSRCT window');
    ok(sc.findShortcut('cerra la ventana').risk === 'ask', 'closing a window asks');
    ok(sc.SHORTCUTS.every(r => /^[a-z0-9]+(\+[a-z0-9]+){0,3}$/.test(r.keys)), 'every row is a key combo act.ps1 accepts');
    const actPs = fs.readFileSync(path.join(ROOT, 'scripts/desk/act.ps1'), 'utf8');
    const named = new Set(['ctrl', 'shift', 'alt', 'win', 'enter', 'tab', 'esc', 'right', 'left', 'f4', 'f5', 'period', 'backtick']);
    ok(sc.SHORTCUTS.every(r => r.keys.split('+').every(k => /^[a-z0-9]$/.test(k) || /^f\d+$/.test(k) || (named.has(k) && new RegExp(`\\b${k} = 0x`).test(actPs) || ['ctrl', 'shift', 'alt', 'win', 'enter', 'tab', 'esc', 'right', 'left'].includes(k)))), 'every key name exists in act.ps1');
    const seen = new Map();
    let dup = '';
    for (const r of sc.SHORTCUTS) for (const p of r.says) { if (seen.has(p) && seen.get(p) !== r.name) dup = p; seen.set(p, r.name); }
    ok(!dup, `no phrase points at two shortcuts${dup ? ` ("${dup}")` : ''}`);

    // pressing: the app is brought forward first, the TSRCT chrome is skipped
    const acts = [];
    const fronts = [];
    sc.configure({
        list: async () => dw._parseList(LIST),
        bringForward: async (hwnd) => fronts.push(hwnd),
        act: async (req) => { acts.push(req); return { front: 'chrome: Facturacion del mes pasado - Claude - Google Chrome' }; },
        sleep: async () => {}, direct: true,
    });
    await sc.pressShortcut(sc.findShortcut('pestana nueva'));
    ok(fronts[0] === '555' && acts[0].keys === 'ctrl+t' && acts[0].fast === true, 'Ctrl+T goes to the claude.ai Chrome window, never the TSRCT one');
    // a routine stops if the key would land in the wrong window
    sc.configure({ act: async (req) => { acts.push(req); return { front: 'Notepad: draft.txt' }; } });
    let wrong = null;
    try { await sc.runRoutine('slack ir a', 'soporte'); } catch (e) { wrong = e; }
    ok(wrong && wrong.soft && !acts.some(a => a.op === 'type'), 'if Slack is not in front after Ctrl+K, nothing is typed');
    let blank = null;
    try { await sc.runRoutine('slack ir a', ''); } catch (e) { blank = e; }
    ok(blank && blank.soft, 'a routine with nothing to type asks what');
    ok(sc.settingsPage('la configuracion de sonido') === 'sound' && sc.settingsPage('bluetooth') === 'bluetooth' && sc.settingsPage('') === 'home', 'settings pages');

    // the fast key path in lib/desk.js: no look needed, still stops the worker
    const T = Date.now();
    let fast = null;
    try { fast = desk._planAct({}, { op: 'key', keys: 'win+d', fast: true, direct: true }, T); } catch (e) { fast = e; }
    ok(Array.isArray(fast) && fast.includes('win+d'), 'a table shortcut needs no fresh look');
    let fastWorker = null;
    try { fastWorker = desk._planAct({ humanAt: T - 1000 }, { op: 'key', keys: 'win+d', fast: true }, T); } catch (e) { fastWorker = e; }
    ok(fastWorker && fastWorker.code === 'DESK_REFUSED', 'but the worker still stops when he holds the mouse');
    let freeKeys = null;
    try { freeKeys = desk._planAct({}, { op: 'key', keys: 'win+d' }, T); } catch (e) { freeKeys = e; }
    ok(freeKeys && freeKeys.code === 'DESK_REFUSED', 'a key that is not from the table still needs a look first');

    // ── links ──
    const pc = require(path.join(ROOT, 'lib/pcDirect.js'));
    let badUri = null;
    try { await pc.openUri('whatsapp://send?phone=5491100000000&text=hola'); } catch (e) { badUri = e; }
    ok(badUri && /lista/.test(badUri.message), 'a WhatsApp link never carries a text he did not write');
    let other = null;
    try { await pc.openUri('file:///C:/Windows/System32/cmd.exe'); } catch (e) { other = e; }
    ok(other, 'schemes outside the list are refused');

    // ── his sentences, routed in code ──
    const u = require(path.join(ROOT, 'lib/understand.js'));
    const route = (s) => { const r = u.parse(s, { layouts: ['trabajo', 'musica', 'clientes'] }); return r ? r.name : null; };
    const want = {
        'pone spotify a la derecha': 'arrange_window', 'pasa el chrome al otro monitor': 'arrange_window', 'maximiza el excel': 'arrange_window',
        'modo trabajo': 'arrange', 'armame el setup de musica': 'arrange', 'guarda las ventanas como clientes': 'save_layout',
        'mostrame el escritorio': 'press_shortcut', 'reabri la pestana': 'press_shortcut', 'abri la configuracion de sonido': 'windows_settings',
        'busca bad bunny en spotify': 'spotify_search', 'dejame solo el slack': 'solo_window',
    };
    for (const [s, a] of Object.entries(want)) ok(route(s) === a, `"${s}" -> ${a} (got ${route(s)})`);
    ok(route('modo foco') === 'focus_mode', '"modo foco" stays TSRCT\'s focus mode');
    ok(route('pasale a tsrct que lo ponga a la derecha') === 'say_to_session', 'a message to a session is not a window move');
    ok(route('cerrala') !== 'press_shortcut', 'a shortcut that asks is never reached by code from a bare word');

    // ── the catalogue ──
    const actions = require(path.join(ROOT, 'lib/actions.js'));
    const names = actions.manifest().map(a => a.name);
    for (const n of ['arrange_window', 'solo_window', 'arrange', 'save_layout', 'press_shortcut', 'pc_routine', 'windows_settings', 'spotify_search', 'list_windows', 'set_zones', 'lock_pc'])
        ok(names.includes(n) && actions.speaksPlain(n), `${n} exists and answers in one short line`);
    actions.configure({ deskWindows: dw, deskShortcuts: sc });
    const lock = await actions.run('lock_pc', {}, {});
    ok(lock.needsConfirm, 'locking the PC asks');
    const close = await actions.run('press_shortcut', { name: 'cerra la ventana' }, {});
    ok(close.needsConfirm, 'closing a window asks');
    const over = await actions.run('save_layout', { name: 'prueba' }, {});
    ok(over.needsConfirm && /piso prueba/.test(over.says), 'saving over an existing mode asks "piso X"');

    // ── music that actually PLAYS (2026-10-14) ──
    // His words: "no le da play a musica random en spotify cuando le pido que me
    // sorprenda o algo, me obliga a tocar play a mi". Every "poneme X en spotify"
    // ran spotify_search (opens the results page) and said "Ahi esta." - nothing
    // played. Spotify ships its own CLI (spotify_cli.exe: search, play, shuffle,
    // now-playing); lib/spotify.js drives it, so no mouse and no screenshot.
    let sp = null;
    try { sp = require(path.join(ROOT, 'lib/spotify.js')); } catch (e) { ok(false, 'lib/spotify.js loads: ' + e.message); }
    if (sp) {
        const FIX = {
            sade: { artists: [{ uri: 'spotify:artist:SADE', name: 'Sade' }], tracks: [{ uri: 'spotify:track:SMOOTH', name: 'Smooth Operator', artists: ['Sade'] }], albums: [], playlists: [] },
            'smooth operator': { artists: [], tracks: [{ uri: 'spotify:track:SMOOTH', name: 'Smooth Operator - Single Version', artists: ['Sade'] }], albums: [], playlists: [] },
            'lo-fi': { artists: [], tracks: [{ uri: 'spotify:track:RANDOM', name: 'Some Song', artists: ['X'] }], albums: [], playlists: [] },
            'lo-fi#playlist': { playlists: [{ uri: 'spotify:playlist:LOFI', name: 'chill lofi', author: 'Spotify' }] },
        };
        let calls = [], playing = true;
        sp.configure({
            // His real taste file stays out of the test (lib/tasteBrain.js); the old list is what is checked here.
            taste: { momentOf: () => null, pick: () => null, played: () => {} },
            sleep: async () => {},
            run: async (args) => {
                calls.push(args.join(' '));
                if (args[0] === 'search') {
                    const q = args[1].toLowerCase(), pl = args.includes('playlist');
                    const hit = FIX[q + (pl ? '#playlist' : '')] || (pl ? { playlists: [{ uri: 'spotify:playlist:ANY', name: q + ' mix' }] } : { artists: [], tracks: [], albums: [], playlists: [] });
                    return JSON.stringify(hit);
                }
                if (args[0] === 'now-playing') return JSON.stringify({ currently_playing: { description: 'Smooth Operator — Sade', is_playing: playing } });
                return '';
            },
        });
        const r1 = await sp.playMusic('sade');
        ok(calls.includes('play spotify:artist:SADE'), `"sade" plays the artist (calls: ${calls.join(' | ')})`);
        ok(calls.includes('shuffle on'), 'an artist or a playlist is played shuffled, not always the same first song');
        ok(r1 && /Smooth Operator/.test(r1.playing), 'it says what is ACTUALLY playing (read back from Spotify)');
        calls = [];
        await sp.playMusic('smooth operator');
        ok(calls.includes('play spotify:track:SMOOTH'), `a song name plays that song (calls: ${calls.join(' | ')})`);
        calls = [];
        await sp.playMusic('lo-fi');
        ok(calls.includes('play spotify:playlist:LOFI'), `a genre or a mood plays a playlist of it (calls: ${calls.join(' | ')})`);
        calls = [];
        const r4 = await sp.playMusic('sorprendeme');
        ok(calls.some(c => /^play spotify:/.test(c)) && r4 && r4.query && r4.query !== 'sorprendeme', `"sorprendeme" picks something itself and plays it (query ${r4 && r4.query})`);
        calls = [];
        await sp.playMusic('');
        ok(calls.some(c => /^play spotify:/.test(c)), 'nothing named = a surprise too, never a question');
        calls = [];
        let refused = null;
        try { await sp.playMusic('secretco playlist'); } catch (e) { refused = e; }
        ok(refused && !calls.length, 'an SecretCo word is refused before Spotify is touched');
        playing = false;
        let silent = null;
        try { await sp.playMusic('sade'); } catch (e) { silent = e; }
        ok(silent && /no (arranco|suena)/i.test(silent.message), 'if Spotify does not start playing, she says so instead of "listo"');
        playing = true;

        // Tesla review #16 (2026-10-14, 17:05): "poneme algo de Bad Omen en spotify" ->
        // "No pude: se rompio algo de mi lado", twice. Reproduced: the Spotify app was
        // CLOSED, the CLI answers "Spotify desktop client is not running" to every
        // search, and search() swallowed that into "no results".
        let open = false;
        calls = [];
        sp.configure({
            run: async (args) => {
                calls.push(args.join(' '));
                if (args[0] === 'open') { open = true; return ''; }
                if (!open) throw new Error('Spotify desktop client is not running');
                if (args[0] === 'status') return JSON.stringify({ running: true });
                if (args[0] === 'search') {
                    const pl = args.includes('playlist');
                    return JSON.stringify(pl ? { playlists: [] } : { artists: [{ uri: 'spotify:artist:BADOMENS', name: 'Bad Omens' }], tracks: [], albums: [], playlists: [] });
                }
                if (args[0] === 'now-playing') return JSON.stringify({ currently_playing: { description: 'Just Pretend — Bad Omens', is_playing: true } });
                return '';
            },
        });
        let closedErr = null, r5 = null;
        try { r5 = await sp.playMusic('Bad Omen'); } catch (e) { closedErr = e; }
        ok(calls.includes('open'), `Spotify closed: she opens it herself (calls: ${calls.join(' | ')}; ${closedErr && closedErr.message})`);
        ok(r5 && calls.includes('play spotify:artist:BADOMENS'), '"Bad Omen" plays the band Bad Omens (one letter short of the name is still the artist)');
        // Spotify will not open at all: one sentence that says so, never "se rompio algo".
        calls = [];
        sp.configure({ run: async (args) => { calls.push(args.join(' ')); throw new Error('Spotify desktop client is not running'); } });
        let neverErr = null;
        try { await sp.playMusic('sade'); } catch (e) { neverErr = e; }
        ok(neverErr && neverErr.soft && /spotify/i.test(neverErr.message) && /abr|abier/i.test(neverErr.message), `Spotify that will not open is said in words (${neverErr && neverErr.message})`);
        // Nothing found is a sentence for him, not a crash.
        sp.configure({ run: async (args) => { calls.push(args.join(' ')); return args[0] === 'search' ? JSON.stringify({ artists: [], tracks: [], albums: [], playlists: [] }) : ''; } });
        let noneErr = null;
        try { await sp.playMusic('qwzxv'); } catch (e) { noneErr = e; }
        ok(noneErr && noneErr.soft, 'nothing found is said as it is ("no encontre..."), not "se rompio algo de mi lado"');
        // 2026-10-14 21:58: "pone linkin park - given up" -> "Suena Stained". Spotify's
        // FIRST track was Given Up by Linkin Park; it was skipped because its title does
        // not start with "linkin park given up", and a playlist played instead.
        calls = [];
        sp.configure({
            run: async (args) => {
                calls.push(args.join(' '));
                if (args[0] === 'search') return JSON.stringify(args.includes('playlist')
                    ? { playlists: [{ uri: 'spotify:playlist:LPMIX', name: 'Linkin Park Mix' }] }
                    : { artists: [], albums: [], tracks: [
                        { uri: 'spotify:track:GIVENUP', name: 'Given Up', artists: ['Linkin Park'] },
                        { uri: 'spotify:track:FAINT', name: 'Faint', artists: ['Linkin Park'] }] });
                if (args[0] === 'now-playing') return JSON.stringify({ currently_playing: { description: 'Given Up — Linkin Park', is_playing: true } });
                return '';
            },
        });
        await sp.playMusic('Linkin Park Given Up');
        ok(calls.includes('play spotify:track:GIVENUP'), `"band + song" plays that song (calls: ${calls.join(' | ')})`);
        calls = [];
        await sp.playMusic('given up de linkin park');
        ok(calls.includes('play spotify:track:GIVENUP'), `"song de band" plays that song (calls: ${calls.join(' | ')})`);
        // Put the first fixture back for the actions checks below.
        sp.configure({
            run: async (args) => {
                if (args[0] === 'search') { const q = args[1].toLowerCase(), pl = args.includes('playlist'); return JSON.stringify(FIX[q + (pl ? '#playlist' : '')] || { artists: [], tracks: [], albums: [], playlists: [] }); }
                if (args[0] === 'now-playing') return JSON.stringify({ currently_playing: { description: 'Smooth Operator — Sade', is_playing: true } });
                return '';
            },
        });
    }
    {
        // 23:55: "pero no le diste play" -> media {what:"play/pausa"} -> "no se que tecla es", twice.
        const pd = require(path.join(ROOT, 'lib/pcDirect.js'));
        const pressed = [];
        pd.configure({ mediaKey: async (k, n) => { pressed.push(k); } });
        let mErr = null;
        try { await pd.media('play/pausa'); } catch (e) { mErr = e; }
        ok(!mErr && pressed[0] === 'playpause', `"play/pausa" is the play key (${mErr && mErr.message})`);
        let bad = null;
        try { await pd.media('xyz'); } catch (e) { bad = e; }
        ok(bad && bad.soft, 'an unknown key is a sentence for him, not "se rompio algo"');
    }
    {
        const a = require(path.join(ROOT, 'lib/actions.js'));
        const m = a.manifest().find(x => x.name === 'play_music');
        ok(m && a.speaksPlain('play_music'), 'play_music exists and answers in one short line');
        if (m && sp) {
            a.configure({ spotify: sp });
            const r = await a.run('play_music', { query: 'sade' }, {});
            ok(r && !r.needsConfirm, 'music is never a question: it plays at once');
            ok(r && r.value && /Smooth Operator/.test(r.value.plain || ''), `she names what is playing (got ${r && r.value && r.value.plain})`);
        }
        const pm = (s) => { const r = u.parse(s, { layouts: [] }); return r ? r.name + (r.args && r.args.query !== undefined ? ':' + r.args.query : '') : null; };
        for (const [s, want] of [
            ['me pones un poco de sade en spotify', 'play_music:sade'],
            ['poneme algo de lo-fi en spotify por favor', 'play_music:lo fi'],
            ['pone un poco de sade en spotify por favor', 'play_music:sade'],
            ['pone algo en spotify sorprendeme', 'play_music:'],
            ['poneme musica', 'play_music:'],
        ]) ok(pm(s) === want, `"${s}" -> ${want} (got ${pm(s)})`);
        ok(route('busca bad bunny en spotify') === 'spotify_search', 'searching (to look at the results) stays spotify_search');
        ok(route('abri spotify') === 'open_app' && route('pone spotify a la derecha') === 'arrange_window', 'opening and placing Spotify are unchanged');
        const brainSrc = fs.readFileSync(path.join(ROOT, 'lib/haikuBrain.js'), 'utf8');
        ok(/nunca digas que ya suena/i.test(brainSrc), 'asked again for a song, she plays it again: she never says it is already playing');
        ok(/play_music/.test(brainSrc) && /sorprend/.test(brainSrc), 'the brain plays music with play_music and picks by itself on "sorprendeme"');
    }

    // ── the skills her worker reads ──
    const skillDir = path.join(ROOT, 'tesla-skills');
    const skills = fs.existsSync(skillDir) ? fs.readdirSync(skillDir).filter(d => fs.existsSync(path.join(skillDir, d, 'SKILL.md'))) : [];
    ok(skills.length >= 5, `the PC skills exist (${skills.length})`);
    const recipes = fs.readFileSync(path.join(ROOT, 'lib/actions.js'), 'utf8');
    ok(/tesla-skills/.test(recipes), 'do_on_pc and look_at_screen point the worker at the skills');
    const scMd = fs.existsSync(path.join(skillDir, 'pc-shortcuts', 'SKILL.md')) ? fs.readFileSync(path.join(skillDir, 'pc-shortcuts', 'SKILL.md'), 'utf8') : '';
    const missing = [...sc.SHORTCUTS, ...sc.ROUTINES].filter(r => !scMd.includes(`\`${r.name}\``)).map(r => r.name);
    ok(!missing.length, `the shortcuts skill lists every row of the table (missing: ${missing.join(', ')})`);
    const hands = fs.readFileSync(path.join(ROOT, 'lib/teslaHands.js'), 'utf8');
    ok(/'windows', 'place', 'solo', 'layout', 'zones', 'shortcut', 'routine', 'settings', 'spotify'/.test(hands) && /tesla-skills/.test(hands), 'the worker may run the new commands and read its skills without a permission card');
    for (const d of skills) {
        const md = fs.readFileSync(path.join(skillDir, d, 'SKILL.md'), 'utf8');
        ok(/^---\nname: /.test(md) && /\ndescription: /.test(md), `${d}: has a name and a description`);
        ok(!/secretco/i.test(md), `${d}: never names the restricted project (the hands guard refuses a screen that does)`);
    }
}

main().catch(e => { fail++; console.log('  [x] threw: ' + e.stack); }).finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (fail) { console.error(`[check-desk-paths] ${fail} failure(s) of ${pass + fail}`); process.exit(1); }
    console.log(`[check-desk-paths] ${pass}/${pass}`);
    process.exit(0);
});
