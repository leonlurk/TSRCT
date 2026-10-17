'use strict';
// ── deskShortcuts.js — named shortcuts, routines and links into apps ────────
//
// WHY (2026-10-11, TESLA-PC-PATHS.md phases 6-7). The keyboard is faster than
// the mouse, and a link straight into a screen is faster than both: "abri la
// configuracion de sonido" is one link, "anda al canal de soporte en slack" is
// Ctrl+K + the name + Enter, "mostrame el escritorio" is Win+D. Every one of
// them is a ROW in a table here - data, not code - so the list can grow at each
// /tesla-review without touching the logic.
//
// What she may NOT do from a sentence: send free keys. Only a named row runs;
// his words choose the row, never the keys. A routine types at most one short
// name he said (a channel, a file name) into a window code just brought forward
// and checked, and never presses Enter in a box that sends.
//
// risk: 'harmless' runs at once; 'ask' needs his yes (lib/actions.js asks);
// there is no 'never' row because those simply are not in the table.

const path = require('path');
const desk = require('./desk');
const restrictedGuard = require('./dispatcher/restrictedGuard');

let deps = {
    act: (req) => desk.act(req),                     // lib/desk.js act (focus/key/type)
    list: null,                                      // lib/deskWindows.js list
    bringForward: null,                              // (hwnd) => deskWindows apply front
    openUrl: null,                                   // (uri) => open.ps1 -Target
    exec: null,                                      // (file, args) => run a Windows program
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    direct: false,                                   // true only in server.js: he asked by voice
};
function configure(d) { deps = { ...deps, ...(d || {}) }; }

class Soft extends Error { constructor(m) { super(m); this.soft = true; } }
const flat = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// ── the table ───────────────────────────────────────────────────────────────
// app: null = Windows itself (goes to whatever is in front, which is fine for
// Win+ keys); a name = that app is brought forward first and checked.
// avoid: a title that must NOT be the target (TSRCT is a Chrome window too: a
// Ctrl+W meant for a tab must never close TSRCT).
const SHORTCUTS = [
    // Windows
    { name: 'escritorio', says: ['mostrame el escritorio', 'mostra el escritorio', 'ir al escritorio', 'ver el escritorio', 'escritorio limpio'], keys: 'win+d', risk: 'harmless' },
    { name: 'minimizar todo', says: ['minimiza todo', 'minimizar todo', 'esconde todo', 'baja todo'], keys: 'win+m', risk: 'harmless' },
    { name: 'restaurar todo', says: ['restaura todo', 'volve a abrir todo', 'subi todo de nuevo', 'restaurar todo'], keys: 'win+shift+m', risk: 'harmless' },
    { name: 'vista de tareas', says: ['vista de tareas', 'todas las ventanas', 'mostrame las ventanas', 'ver las ventanas'], keys: 'win+tab', risk: 'harmless' },
    { name: 'portapapeles', says: ['portapapeles', 'historial del portapapeles', 'lo que copie'], keys: 'win+v', risk: 'harmless' },
    { name: 'recorte', says: ['captura de pantalla', 'recorte de pantalla', 'sacar una captura', 'hacer un recorte', 'screenshot'], keys: 'win+shift+s', risk: 'harmless' },
    { name: 'explorador', says: ['explorador de archivos', 'abri el explorador', 'mis archivos'], keys: 'win+e', risk: 'harmless' },
    { name: 'configuracion', says: ['configuracion de windows', 'abri la configuracion', 'ajustes de windows'], keys: 'win+i', risk: 'harmless' },
    { name: 'notificaciones', says: ['notificaciones de windows', 'centro de notificaciones', 'mostrame las notificaciones'], keys: 'win+n', risk: 'harmless' },
    { name: 'ajustes rapidos', says: ['ajustes rapidos', 'wifi y bluetooth rapido', 'panel rapido'], keys: 'win+a', risk: 'harmless' },
    { name: 'emojis', says: ['emojis', 'panel de emojis', 'emoticones'], keys: 'win+period', risk: 'harmless' },
    { name: 'administrador de tareas', says: ['administrador de tareas', 'task manager', 'que esta consumiendo'], keys: 'ctrl+shift+esc', risk: 'harmless' },
    { name: 'nuevo escritorio virtual', says: ['nuevo escritorio virtual', 'crea un escritorio virtual', 'otro escritorio virtual'], keys: 'win+ctrl+d', risk: 'harmless' },
    { name: 'escritorio virtual siguiente', says: ['escritorio virtual siguiente', 'siguiente escritorio', 'pasa al otro escritorio', 'escritorio de la derecha'], keys: 'win+ctrl+right', risk: 'harmless' },
    { name: 'escritorio virtual anterior', says: ['escritorio virtual anterior', 'escritorio anterior', 'escritorio de la izquierda', 'volve al escritorio anterior'], keys: 'win+ctrl+left', risk: 'harmless' },
    { name: 'cerrar escritorio virtual', says: ['cerra este escritorio virtual', 'cerrar escritorio virtual'], keys: 'win+ctrl+f4', risk: 'ask' },
    { name: 'fijar arriba', says: ['siempre arriba', 'fijala arriba', 'fijalo arriba', 'que quede encima'], keys: 'win+ctrl+t', risk: 'harmless', needs: 'PowerToys' },
    { name: 'buscar en windows', says: ['buscar en windows', 'busqueda de windows', 'abri inicio'], keys: 'win+s', risk: 'harmless' },
    // Chrome (never the TSRCT window)
    { name: 'pestana nueva', says: ['pestana nueva', 'nueva pestana', 'abri una pestana'], app: 'chrome', avoid: 'TSRCT', keys: 'ctrl+t', risk: 'harmless' },
    { name: 'reabrir pestana', says: ['reabri la pestana', 'volve a abrir la pestana', 'la pestana que cerre', 'recupera la pestana'], app: 'chrome', avoid: 'TSRCT', keys: 'ctrl+shift+t', risk: 'harmless' },
    { name: 'cerrar pestana', says: ['cerra la pestana', 'cerra esta pestana', 'cerrar pestana'], app: 'chrome', avoid: 'TSRCT', keys: 'ctrl+w', risk: 'harmless' },
    { name: 'pestana siguiente', says: ['pestana siguiente', 'siguiente pestana', 'pasa de pestana'], app: 'chrome', avoid: 'TSRCT', keys: 'ctrl+tab', risk: 'harmless' },
    { name: 'pestana anterior', says: ['pestana anterior', 'volve a la pestana anterior'], app: 'chrome', avoid: 'TSRCT', keys: 'ctrl+shift+tab', risk: 'harmless' },
    { name: 'recargar pagina', says: ['recarga la pagina', 'refresca la pagina', 'actualiza la pagina', 'recargar'], app: 'chrome', avoid: 'TSRCT', keys: 'f5', risk: 'harmless' },
    { name: 'historial', says: ['historial del navegador', 'historial de chrome'], app: 'chrome', avoid: 'TSRCT', keys: 'ctrl+h', risk: 'harmless' },
    { name: 'descargas del navegador', says: ['descargas de chrome', 'descargas del navegador', 'lo que baje'], app: 'chrome', avoid: 'TSRCT', keys: 'ctrl+j', risk: 'harmless' },
    // Spotify
    { name: 'spotify aleatorio', says: ['aleatorio', 'modo aleatorio', 'shuffle', 'mezcla las canciones'], app: 'spotify', keys: 'ctrl+s', risk: 'harmless' },
    { name: 'spotify repetir', says: ['repeti la cancion', 'modo repetir', 'en repeticion'], app: 'spotify', keys: 'ctrl+r', risk: 'harmless' },
    // Slack
    { name: 'slack no leidos', says: ['no leidos de slack', 'lo que no lei en slack', 'mensajes sin leer de slack'], app: 'slack', keys: 'ctrl+shift+a', risk: 'harmless' },
    { name: 'slack mensajes directos', says: ['mensajes directos de slack', 'los privados de slack', 'dms de slack'], app: 'slack', keys: 'ctrl+shift+k', risk: 'harmless' },
    { name: 'slack menciones', says: ['menciones de slack', 'donde me nombraron en slack', 'actividad de slack'], app: 'slack', keys: 'ctrl+shift+m', risk: 'harmless' },
    // Outlook
    { name: 'outlook correo', says: ['correo de outlook', 'bandeja de outlook'], app: 'outlook', keys: 'ctrl+1', risk: 'harmless' },
    { name: 'outlook calendario', says: ['calendario de outlook', 'agenda de outlook'], app: 'outlook', keys: 'ctrl+2', risk: 'harmless' },
    // VS Code
    { name: 'vscode comandos', says: ['paleta de comandos', 'comandos de vs code'], app: 'code', keys: 'ctrl+shift+p', risk: 'harmless' },
    { name: 'vscode terminal', says: ['terminal de vs code', 'abri la terminal de code'], app: 'code', keys: 'ctrl+backtick', risk: 'harmless' },
    // Any window
    { name: 'cerrar ventana', says: ['cerra la ventana', 'cerrala', 'cerra esta ventana', 'cerrar ventana'], keys: 'alt+f4', risk: 'ask', front: true },
];

// Routines: a few fixed steps around ONE short thing he named.
// {focus} the app, {keys} fixed, {type} what he said (<= 60 chars), {wait} ms.
const ROUTINES = [
    { name: 'slack ir a', says: ['anda al canal', 'abri el canal', 'abri el chat con', 'anda al chat con', 'abrime el canal', 'llevame al canal'], app: 'slack', arg: 'canal o persona',
        steps: [{ keys: 'ctrl+k' }, { wait: 350 }, { type: true }, { wait: 700 }, { keys: 'enter' }] },
    { name: 'vscode abrir archivo', says: ['abri el archivo en code', 'busca el archivo en vs code'], app: 'code', arg: 'nombre de archivo',
        steps: [{ keys: 'ctrl+p' }, { wait: 300 }, { type: true }, { wait: 600 }, { keys: 'enter' }] },
    { name: 'chrome buscar en la pagina', says: ['busca en la pagina', 'encontra en la pagina'], app: 'chrome', avoid: 'TSRCT', arg: 'que buscar',
        steps: [{ keys: 'ctrl+f' }, { wait: 250 }, { type: true }] },
];

// Straight links into a screen: no window to find, no key to press.
const SETTINGS = {
    sonido: 'sound', audio: 'sound', volumen: 'sound', parlantes: 'sound', microfono: 'sound',
    pantalla: 'display', monitores: 'display', resolucion: 'display', brillo: 'display', escala: 'display',
    bluetooth: 'bluetooth', auriculares: 'bluetooth', wifi: 'network-wifi', internet: 'network', red: 'network', vpn: 'network-vpn',
    notificaciones: 'notifications', 'no molestar': 'notifications',
    bateria: 'batterysaver', energia: 'powersleep', suspension: 'powersleep',
    aplicaciones: 'appsfeatures', programas: 'appsfeatures', inicio: 'startupapps', 'apps de inicio': 'startupapps', predeterminadas: 'defaultapps',
    impresoras: 'printers', mouse: 'mousetouchpad', teclado: 'typing', idioma: 'regionlanguage', hora: 'dateandtime', fecha: 'dateandtime',
    fondo: 'personalization-background', colores: 'colors', 'modo oscuro': 'colors', tema: 'themes',
    actualizaciones: 'windowsupdate', 'windows update': 'windowsupdate', almacenamiento: 'storagesense', disco: 'storagesense',
    privacidad: 'privacy', camara: 'privacy-webcam', cuentas: 'yourinfo', 'acerca de': 'about', 'mi pc': 'about',
};

// ── matching his words ──────────────────────────────────────────────────────
function score(t, phrases) {
    let best = 0;
    for (const p of phrases) {
        const f = flat(p);
        if (t === f) return 100;
        if (t.includes(f)) best = Math.max(best, 50 + f.length);
    }
    return best;
}
// The best row for what he said, or null.
function findShortcut(text) {
    const t = flat(text);
    if (!t) return null;
    let best = null, bestScore = 0;
    for (const row of SHORTCUTS) {
        const s = Math.max(score(t, row.says), t === flat(row.name) ? 100 : 0);
        if (s > bestScore) { best = row; bestScore = s; }
    }
    return best;
}
function findRoutine(text) {
    const t = flat(text);
    let best = null, bestScore = 0;
    for (const r of ROUTINES) {
        const s = Math.max(score(t, r.says), t === flat(r.name) ? 100 : 0);
        if (s > bestScore) { best = r; bestScore = s; }
    }
    return best;
}
function settingsPage(text) {
    const t = flat(text).replace(/^(la |el |los |las )?(configuracion|ajustes|config)( de| del)?( la| el)? ?/, '').trim();
    if (!t) return 'home';
    if (SETTINGS[t]) return SETTINGS[t];
    const hit = Object.keys(SETTINGS).sort((a, b) => b.length - a.length).find(k => t.includes(k));
    return hit ? SETTINGS[hit] : null;
}

// ── running ─────────────────────────────────────────────────────────────────
// Brings the app's front-most window forward (never one whose title matches
// `avoid`) and returns it; Soft when the app has no window.
async function target(app, avoid) {
    if (!deps.list || !deps.bringForward) throw new Error('no puedo mover ventanas desde aca');
    const { windows } = await deps.list({ fresh: true });
    const a = flat(app);
    const av = avoid ? flat(avoid) : '';
    // A visible window before a minimized one (measured 2026-10-11: Ctrl+T went
    // to a minimized Gmail window instead of the open claude.ai one).
    const fits = windows.filter(w => !w.restricted && flat(w.process).includes(a) && !(av && flat(w.title).includes(av)));
    const win = fits.find(w => w.state !== 'min') || fits[0];
    if (!win) throw new Soft(`no tengo ${app} abierto${avoid ? ` (aparte de ${avoid})` : ''}`);
    await deps.bringForward(win.hwnd);
    await deps.sleep(250);
    return win;
}
// The window in front after an act must be the one we brought: else stop.
function checkFront(front, app, avoid) {
    const f = flat(front);
    if (!f.includes(flat(app))) throw new Soft(`no quedo ${app} adelante, asi que no toco nada`);
    if (avoid && f.includes(flat(avoid))) throw new Soft(`adelante quedo ${avoid}, asi que no toco nada`);
}

async function pressShortcut(rowOrName) {
    const row = typeof rowOrName === 'object' ? rowOrName : (SHORTCUTS.find(r => flat(r.name) === flat(rowOrName)) || findShortcut(rowOrName));
    if (!row) throw new Soft('no tengo un atajo para eso');
    const t0 = Date.now();
    if (row.app) await target(row.app, row.avoid);
    if (row.front) {
        // A key that closes: never on TSRCT, where she lives, nor his terminal.
        // The first window of the list is the one in front (z-order).
        const { windows } = await deps.list({ fresh: true });
        const top = windows.find(w => w.state !== 'min');
        if (!top || top.restricted || /tsrct/i.test(top.title) || /windowsterminal|wsl|ubuntu/i.test(top.process)) throw new Soft(`adelante esta ${top ? (top.restricted ? 'algo que no toco' : top.title || top.process) : 'nada'}; no lo cierro`);
    }
    const r = await deps.act({ op: 'key', keys: row.keys, fast: true, direct: deps.direct !== false });
    if (row.app && !/^(alt\+tab|win)/.test(row.keys)) { try { checkFront(r.front, row.app, row.avoid); } catch { /* the key is pressed already; front may legitimately change (a closed tab) */ } }
    desk.logDesk({ kind: 'shortcut', name: row.name, keys: row.keys, app: row.app || '', ms: Date.now() - t0 });
    return { name: row.name, keys: row.keys, front: r.front };
}

async function runRoutine(routineOrName, what) {
    const r = typeof routineOrName === 'object' ? routineOrName : (ROUTINES.find(x => flat(x.name) === flat(routineOrName)) || findRoutine(routineOrName));
    if (!r) throw new Soft('no tengo una rutina para eso');
    const arg = String(what || '').replace(/\s+/g, ' ').trim();
    if (r.steps.some(s => s.type) && !arg) throw new Soft(`${r.arg}?`);
    if (arg.length > 60) throw new Soft('ese nombre es muy largo');
    restrictedGuard.assertNotRestricted('tesla routine', arg);
    const t0 = Date.now();
    await target(r.app, r.avoid);
    let front = '';
    for (const s of r.steps) {
        if (s.wait) { await deps.sleep(s.wait); continue; }
        const res = s.type ? await deps.act({ op: 'type', text: arg, fast: true, direct: deps.direct !== false }) : await deps.act({ op: 'key', keys: s.keys, fast: true, direct: deps.direct !== false });
        front = res.front || '';
        // Every keystroke must land in the app we brought forward.
        checkFront(front, r.app, r.avoid);
    }
    desk.logDesk({ kind: 'routine', name: r.name, argLength: arg.length, ms: Date.now() - t0 });
    return { name: r.name, what: arg, front };
}

async function openSettings(what) {
    const page = settingsPage(what);
    if (!page) throw new Soft(`no conozco esa parte de la configuracion; tengo ${['sonido', 'pantalla', 'bluetooth', 'wifi', 'notificaciones', 'bateria', 'aplicaciones', 'actualizaciones'].join(', ')} y mas`);
    if (!deps.openUrl) throw new Error('no puedo abrir links desde aca');
    await deps.openUrl(page === 'home' ? 'ms-settings:' : `ms-settings:${page}`);
    desk.logDesk({ kind: 'settings', page });
    return { page };
}

// Spotify opens straight on its search results for that text.
async function spotifySearch(query) {
    const q = String(query || '').replace(/\s+/g, ' ').trim();
    if (!q) throw new Soft('que busco en spotify?');
    if (q.length > 100) throw new Soft('es muy largo para buscar');
    if (!deps.openUrl) throw new Error('no puedo abrir links desde aca');
    await deps.openUrl(`spotify:search:${encodeURIComponent(q)}`);
    desk.logDesk({ kind: 'spotify-search', length: q.length });
    return { query: q };
}

async function lockPc() {
    if (!deps.exec) throw new Error('no puedo bloquear desde aca');
    await deps.exec('/mnt/c/Windows/System32/rundll32.exe', ['user32.dll,LockWorkStation']);
    desk.logDesk({ kind: 'lock' });
    return { locked: true };
}

// What the brain and the `hands` worker are told: names and words only.
function catalogue() {
    return {
        shortcuts: SHORTCUTS.map(r => ({ name: r.name, app: r.app || 'windows', risk: r.risk })),
        routines: ROUTINES.map(r => ({ name: r.name, app: r.app, arg: r.arg })),
        settings: [...new Set(Object.keys(SETTINGS))],
    };
}

module.exports = { configure, _flat: flat, SHORTCUTS, ROUTINES, SETTINGS, findShortcut, findRoutine, settingsPage, pressShortcut, runRoutine, openSettings, spotifySearch, lockPc, catalogue };
