'use strict';
// ── pcDirect.js — the PC without the mouse ──────────────────────────────────
//
// WHY (2026-10-10). Leon: a session finishes a document, Tesla tells him, and
// he says "buscalo y abrilo, o ponelo en tal lugar". Then, as the rule for
// everything: "la misma logica que aplique en toda tarea en general que se
// pueda hacer mas rapido o eficiente evitando el uso fisico del mouse".
//
// So the mouse (lib/desk.js, do_on_pc) is the LAST resort. What has a direct
// path takes it here, with no screenshot and no model in between:
//   - which files a session just wrote: read from its own transcript (the
//     Write/Edit calls), never searched for;
//   - open a file, a folder, a link or an app by name (Windows opens it in its
//     own default program; an app already open is brought forward instead);
//   - move a file into a folder (asks first, in lib/actions.js).
//
// SecretCo: a path or a session that names it is refused before anything is
// read or opened (the SecretCoSandbox folder is never touched from here).

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { execFile } = require('child_process');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const ROOT = path.join(__dirname, '..');
const OPEN_SCRIPT = path.join(ROOT, 'scripts', 'desk', 'open.ps1');
const WIN_HOME = paths.WIN_HOME;
const DISTRO = process.env.WSL_DISTRO_NAME || 'Ubuntu';
const TAIL_BYTES = 2 * 1024 * 1024;
const PS = [
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',
].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;

let deps = {
    transcriptFor: null,   // (session) => { file, cwd } (lib/progressReport.js)
    focus: null,           // (name) => desk.act({op:'focus', window:name})
    resolveProject: null,  // (spoken) => { project, cwd } (lib/projectRegistry.js)
    mediaKey: null,        // (key, times) => desk.act({op:'media', ...})
};
function configure(d) { deps = { ...deps, ...(d || {}) }; }

function refuseRestricted(what, ...texts) {
    restrictedGuard.assertNotRestricted(what, ...texts);
}

// ── which files did this session write? ─────────────────────────────────────
// The transcript's tool calls name every file Claude wrote or edited, with the
// time. The tail is enough: what he asks about is what was JUST made.
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
function filesFromTranscript(text, cwd) {
    const seen = new Map();
    for (const line of String(text || '').split('\n')) {
        let r = null;
        try { r = JSON.parse(line); } catch { continue; }
        const parts = r && r.message && Array.isArray(r.message.content) ? r.message.content : [];
        for (const c of parts) {
            if (c.type !== 'tool_use' || !WRITES.has(c.name) || !c.input) continue;
            const p = c.input.file_path || c.input.notebook_path;
            if (!p) continue;
            const abs = path.isAbsolute(p) ? p : path.join(cwd || '/', p);
            seen.set(abs, { path: abs, at: Date.parse(r.timestamp) || 0, how: c.name === 'Write' ? 'created' : 'edited' });
        }
    }
    return [...seen.values()].sort((a, b) => b.at - a.at);
}

function sessionFiles(session, { sinceMs = 6 * 3600 * 1000, max = 8, now = Date.now() } = {}) {
    refuseRestricted('tesla session files', session);
    const t = deps.transcriptFor ? deps.transcriptFor(session) : null;
    if (!t || !t.file) return [];
    refuseRestricted('tesla session files', t.cwd);
    let text = '';
    try {
        const size = fs.statSync(t.file).size;
        const fd = fs.openSync(t.file, 'r');
        const len = Math.min(size, TAIL_BYTES);
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, size - len);
        fs.closeSync(fd);
        text = b.toString('utf8');
    } catch { return []; }
    return filesFromTranscript(text, t.cwd)
        .filter(f => now - f.at < sinceMs && !restrictedGuard.mentionsRestricted(f.path) && fs.existsSync(f.path))
        .slice(0, max);
}

// For the brain's per-turn context: one line it can act on ("abrilo").
function filesLine(session, opts) {
    let files = [];
    try { files = sessionFiles(session, opts); } catch { return ''; }
    if (!files.length) return '';
    const ago = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'recien' : `hace ${m} min`; };
    return `ARCHIVOS QUE ${session} ESCRIBIO (lo mas nuevo primero; para abrir o mover uno usa su ruta tal cual):\n`
        + files.map(f => `- ${f.path} (${f.how === 'created' ? 'creado' : 'editado'} ${ago(f.at)})`).join('\n');
}

// ── paths between WSL and Windows ───────────────────────────────────────────
function toWindows(p) {
    const s = String(p || '');
    const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(s);
    if (m) return `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}`;
    if (s.startsWith('/')) return `\\\\wsl.localhost\\${DISTRO}${s.replace(/\//g, '\\')}`;
    return s;
}
function fromWindows(p) {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(p || ''));
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : String(p || '');
}

// His words for the usual places, and his projects, to a folder.
const PLACES = {
    descargas: 'Downloads', downloads: 'Downloads',
    escritorio: 'Desktop', desktop: 'Desktop',
    documentos: 'Documents', documents: 'Documents', 'mis documentos': 'Documents',
    imagenes: 'Pictures', fotos: 'Pictures', pictures: 'Pictures',
};
function resolveFolder(spoken) {
    const raw = String(spoken || '').trim();
    if (!raw) throw new Error('falta a que carpeta');
    const flat = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^(la|el|mi|mis) (carpeta (de )?)?/, '').trim();
    if (PLACES[flat]) return path.join(WIN_HOME, PLACES[flat]);
    const p = fromWindows(raw);
    if (path.isAbsolute(p)) return p;
    if (deps.resolveProject) {
        const r = deps.resolveProject(raw);
        if (r && r.cwd) return r.cwd;
    }
    throw new Error(`no se que carpeta es "${raw}"`);
}

function runOpen(args) {
    return new Promise((resolve, reject) => {
        if (!PS) return reject(new Error('PowerShell not found (not WSL?)'));
        execFile(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', toWindows(OPEN_SCRIPT), ...args],
            { encoding: 'utf8', timeout: 20000, windowsHide: true },
            (err, stdout, stderr) => {
                if (err) return reject(new Error(String(stderr || err.message).split('\n')[0].slice(0, 200)));
                resolve(String(stdout || ''));
            });
    });
}

// open({ path }) a file or folder; open({ path, reveal: true }) shows it in its folder.
async function openPath({ path: p, reveal } = {}) {
    const local = fromWindows(String(p || '').trim());
    if (!local) throw new Error('falta que archivo');
    refuseRestricted('tesla open file', local);
    if (!fs.existsSync(local)) throw new Error(`no existe ${local}`);
    await runOpen(reveal ? ['-Reveal', toWindows(local)] : ['-Target', toWindows(local)]);
    return { opened: local, reveal: !!reveal };
}

async function openUrl(url) {
    const u = String(url || '').trim();
    if (!/^https?:\/\/[^\s"']+$/i.test(u)) throw new Error('eso no es una direccion web');
    refuseRestricted('tesla open url', u);
    await runOpen(['-Target', u]);
    return { opened: u };
}

// Links INTO an app (2026-10-11, TESLA-PC-PATHS.md phase 7): only these schemes,
// each with its own shape. whatsapp://send never carries text= (that would put
// words he did not write into a chat).
const URI_SCHEMES = [
    /^ms-settings:[a-z0-9-]*$/i,
    /^spotify:(search|track|album|playlist|artist):[\w%.~-]+$/i,
    /^slack:\/\/(channel|user|open)(\?[\w=&%-]+)?$/i,
    /^whatsapp:\/\/send\?phone=\d{6,15}$/i,
    /^vscode:\/\/file\/[^\s"'<>|]+$/i,
];
async function openUri(uri) {
    const u = String(uri || '').trim();
    if (!URI_SCHEMES.some(re => re.test(u))) throw new Error('ese link no esta en la lista de los que abro');
    refuseRestricted('tesla open uri', decodeURIComponent(u));
    await runOpen(['-Target', u]);
    return { opened: u };
}

// An app: already open -> brought forward (lib/desk.js focus); else launched
// from the Start menu's own list (Get-StartApps), never by clicking.
async function openApp(name) {
    const n = String(name || '').trim();
    if (!n || n.length > 60) throw new Error('falta que programa');
    refuseRestricted('tesla open app', n);
    if (deps.focus) {
        try { const r = await deps.focus(n); return { app: n, how: 'focused', front: r && r.front }; } catch (e) {
            if (e.code === 'DESK_REFUSED') throw e;   // he has the mouse, or it is SecretCo work
        }
    }
    const out = await runOpen(['-App', n]);
    const m = /^L\|(.+)$/m.exec(out);
    if (!m) throw new Error(`no encuentro un programa llamado ${n}`);
    return { app: m[1].trim(), how: 'launched' };
}

// Music and volume with the keyboard's media keys (Tesla review #11): no screen,
// no window, no model. "al maximo" is 50 steps up (Windows goes 2 per press).
const MEDIA = {
    play: ['playpause', 1], pausa: ['playpause', 1], pause: ['playpause', 1], playpause: ['playpause', 1],
    siguiente: ['nexttrack', 1], next: ['nexttrack', 1], anterior: ['prevtrack', 1], previous: ['prevtrack', 1],
    subir: ['volumeup', 5], bajar: ['volumedown', 5], maximo: ['volumeup', 50], max: ['volumeup', 50],
    minimo: ['volumedown', 50], silencio: ['volumemute', 1], mute: ['volumemute', 1],
};
async function media(what, times) {
    const k = String(what || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    // Tesla review #16: the brain sent "play/pausa" and it was "no se que tecla es", twice.
    // Any word of it that names a key will do.
    const hit = MEDIA[k] || k.split(/[^a-z]+/).filter(Boolean).map(w => MEDIA[w]).find(Boolean);
    if (!hit) {
        const e = new Error(`no se que tecla es "${what}" (play, pausa, siguiente, anterior, subir, bajar, maximo, silencio)`);
        e.soft = true;                       // said as it is, not "se rompio algo"
        throw e;
    }
    if (!deps.mediaKey) throw new Error('no puedo tocar el teclado desde aca');
    await deps.mediaKey(hit[0], Number(times) || hit[1]);
    return { key: hit[0], times: Number(times) || hit[1] };
}

// Moves a file into a folder. Never overwrites; across drives it copies then
// deletes the original only once the copy is the same size.
function moveFile({ path: from, to }) {
    const src = fromWindows(String(from || '').trim());
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error(`no encuentro el archivo ${from}`);
    const dir = resolveFolder(to);
    refuseRestricted('tesla move file', src, dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`no existe la carpeta ${dir}`);
    const dest = path.join(dir, path.basename(src));
    if (fs.existsSync(dest)) throw new Error(`ya hay un ${path.basename(src)} en ${dir}; no lo piso`);
    try {
        fs.renameSync(src, dest);
    } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        if (fs.statSync(dest).size !== fs.statSync(src).size) throw new Error('la copia no salio igual; deje el original');
        fs.unlinkSync(src);
    }
    return { from: src, to: dest };
}

module.exports = { configure, sessionFiles, filesLine, openPath, openUrl, openUri, openApp, moveFile, resolveFolder, media,
    _filesFromTranscript: filesFromTranscript, _toWindows: toWindows, _fromWindows: fromWindows };
