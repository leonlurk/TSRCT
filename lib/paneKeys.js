'use strict';
// ── paneKeys.js — keys and names for MANY sessions, through server.js's tmux ─
//
// The assistant's bulk actions (2026-09-24: "frena todas", "compacta todas",
// "renombra esa a creators") press keys in panes it did not open. Everything
// goes through the argv choke point server.js hands in; nothing here builds a
// shell string. Refused here as well as in the gate: SecretCo, Tesla's hidden
// brains, and TSRCT's own session for a rename.

const restrictedGuard = require('./dispatcher/restrictedGuard');

let deps = { tmux: null, serverSession: () => '' };
function configure(d) { deps = { ...deps, ...(d || {}) }; }

const NAME = /^[A-Za-z0-9._@-]{1,64}$/;

function check(session, op) {
    const s = String(session || '');
    if (!NAME.test(s)) throw new Error(`"${s}" no es un nombre de sesion`);
    if (s.startsWith('tesla-')) throw new Error('esa sesion es mia, no se toca');
    restrictedGuard.assertNotRestricted(`pane keys (${op})`, s);
    return s;
}

// `literal` types the text as-is ("/compact"); otherwise they are key names.
function press(session, keys, { literal } = {}) {
    const s = check(session, 'press');
    const list = (Array.isArray(keys) ? keys : [keys]).map(String).filter(Boolean);
    if (!list.length) return false;
    deps.tmux(['send-keys', '-t', `=${s}:`, ...(literal ? ['-l'] : []), ...list]);
    return true;
}

function rename(from, to) {
    const a = check(from, 'rename');
    const b = check(to, 'rename');
    const own = deps.serverSession ? deps.serverSession() : '';
    if (own && a === own) return { ok: false, error: 'esa es la sesion donde corre TSRCT, no la renombro' };
    deps.tmux(['rename-session', '-t', `=${a}`, b]);
    return { ok: true, from: a, to: b };
}

module.exports = { configure, press, rename };
