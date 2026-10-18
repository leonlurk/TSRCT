'use strict';
// lib/owner.js - who TSRCT works for: the name Tesla and every background job
// call the person at the keyboard.
//
// OWNER_NAME in .env (npm run setup asks for it). Without it, the login name of
// this machine, capitalised, so Tesla never calls anyone by somebody else's name.
// Every prompt reads it from here; scripts/check-persona.js fails if a line of
// code spells a name instead.
const os = require('os');

function loginName() {
    try {
        const u = os.userInfo().username || '';
        return u ? u.charAt(0).toUpperCase() + u.slice(1) : 'User';
    } catch { return 'User'; }
}

const NAME = String(process.env.OWNER_NAME || '').trim() || loginName();

// OWNER_LANG: the language Tesla speaks until the person speaks another one
// (es | en; Spanish when unset, the language TSRCT was built in).
const LANG = /^en/i.test(String(process.env.OWNER_LANG || '')) ? 'en' : 'es';
const LANG_NAME = LANG === 'en' ? 'English' : 'Spanish';

module.exports = { NAME, UPPER: NAME.toUpperCase(), LANG, LANG_NAME };
