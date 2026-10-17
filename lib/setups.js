// ─────────────────────────────────────────────────────────────────────────
// lib/setups.js — A SETUP IS A SENTENCE HE ALREADY SAID THREE TIMES.
//
// His work starts by arranging a board: three sessions, each in its project,
// each primed, the brief open, the assistant watching one of them. That is
// eight buttons, and it is the same eight every morning.
//
// A setup is a NAMED LIST OF ACTIONS THAT ALREADY EXIST. There is no new power
// in this file: every step goes back through lib/actions.js, is validated
// there, and can be refused there. What it adds is that he says it once.
//
// Two rules, and both come from things that have already gone wrong here:
//
//   ONE CONFIRMATION, NAMING EVERY STEP. Not one per step — he would stop
//   listening by the third — and not none. The question says the whole board
//   out loud ("abrir tsrct, probill y harbor, y mirar tsrct"), because a
//   confirmation that names the CAPABILITY instead of the ACT is not a question
//   anybody can answer safely.
//
//   A STEP THAT FAILS STOPS THE REST. Half a board is worse than no board: he
//   would be looking at two sessions believing there are three. What ran and
//   what did not is reported in the same sentence.
//
// Saved to disk next to the scheduler's state, not in the database: db.js drops
// its tables on every boot, and a setup he recorded in September has to still
// be there in November.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const restrictedGuard = require('./dispatcher/restrictedGuard');
const { stateFile } = require('./stateFile');

const FILE = process.env.TALK_SETUPS_FILE || stateFile('setups.json', '.tsrct-setups.json');
const MAX_STEPS = 8;

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const out = {};
        for (const [name, steps] of Object.entries(raw || {})) {
            if (!Array.isArray(steps)) continue;
            // A setup is content too: it holds project and session names, and it
            // was written by this server. If anything SecretCo ever reached it, it
            // stops here rather than being replayed into an action.
            if (restrictedGuard.mentionsRestricted(name) || restrictedGuard.mentionsRestricted(JSON.stringify(steps))) continue;
            out[name] = steps.slice(0, MAX_STEPS);
        }
        return out;
    } catch { return {}; }
}

function save(all) {
    try {
        fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
        return true;
    } catch (e) {
        console.error('[setups] could not save:', e.message);
        return false;
    }
}

function names() { return Object.keys(load()); }
function get(name) { return load()[name] || null; }

// A name he spoke, flattened to something a file can hold and he can say again.
function slug(name) {
    return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40);
}

// Record what this conversation actually DID, in order, dropping the ones that
// make no sense to replay (reading a screen, asking what is open) and the
// duplicates. `did` is [{name, args}] straight from the gate — already
// validated, so a setup can only ever contain a real action with real values.
const NOT_WORTH_SAVING = new Set(['read_session', 'list_sessions', 'read_brief', 'gpu_free', 'project_status', 'save_setup', 'run_setup']);

function fromHistory(name, did) {
    const steps = [];
    for (const step of (did || [])) {
        if (NOT_WORTH_SAVING.has(step.name)) continue;
        const key = JSON.stringify(step);
        if (steps.some(s => JSON.stringify(s) === key)) continue;
        steps.push({ name: step.name, args: step.args || {} });
        if (steps.length >= MAX_STEPS) break;
    }
    if (!steps.length) return { ok: false, why: 'todavia no hice nada que valga la pena guardar' };
    const key = slug(name);
    if (!key) return { ok: false, why: 'no entendi como querias llamarlo' };
    restrictedGuard.assertNotRestricted('setups (save)', key + ' ' + JSON.stringify(steps));
    const all = load();
    all[key] = steps;
    if (!save(all)) return { ok: false, why: 'no pude guardarlo en el disco' };
    return { ok: true, setup: key, steps };
}

function forget(name) {
    const all = load();
    const key = slug(name);
    if (!all[key]) return { ok: false, why: 'no tengo ningun setup con ese nombre' };
    delete all[key];
    save(all);
    return { ok: true, setup: key };
}

module.exports = { load, save, names, get, slug, fromHistory, forget, FILE, MAX_STEPS };
