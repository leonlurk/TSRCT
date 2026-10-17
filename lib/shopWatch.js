'use strict';
// ── shopWatch.js — the Verde Soap card-testing watch ──────────────────────
//
// WHY THIS EXISTS (2026-10-05): PV was hit by card testing on Aug 22 and again
// Sep 9-21 (~1,440 abandoned checkouts, peak 46 an hour, 1,222 of them the same
// $14.99 Lavender 16oz). Login-to-pay was switched on as the cure and Sam wants
// it off. This loop is the smoke alarm that lets it stay off: every 30 minutes
// it runs marketing-stack/scripts/pv-card-testing-watch.py over the last hour
// and, when an hour looks like a burst, drops an event into Notifs and rings the
// phone.
//
// It reads the store through Shopify CLI's stored login,
// so it works only while TSRCT runs and only while that login is valid. A failed
// run is said out loud (red card, one phone push) rather than read as "quiet".

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const shellJob = require('./shellJob');
const { stateFile } = require('./stateFile');

const PROJECTS = paths.PROJECTS_ROOT;
const SCRIPT = path.join(PROJECTS, 'marketing-stack', 'scripts', 'pv-card-testing-watch.py');
const STATE_FILE = stateFile('shopwatch.json', '.tsrct-shopwatch.json');
const EVERY_MS = 30 * 60 * 1000;
const QUIET_AFTER_ALERT_MS = 3 * 60 * 60 * 1000;   // one burst = one alert, not six
const TIMEOUT_MS = 3 * 60 * 1000;
const MAX_HISTORY = 20;

let timer = null;
let busy = false;
let deps = { addEvent: null, push: null };

function load() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function save(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { console.error('[shopwatch] could not write state:', e.message); }
}

// The CLI prints boxes around its errors; keep the sentence that says why.
function reason(tail) {
    const t = String(tail || '').replace(/[│╭╮╰╯─]+/g, ' ').replace(/\s+/g, ' ');
    if (/ACCESS_DENIED|Access denied/i.test(t)) return 'Shopify refused the read (missing permission). Run: shopify store auth --store 9c84df-f4.myshopify.com --scopes read_orders,read_customers,write_content,write_online_store_navigation,write_products';
    if (/auth|log ?in|token|expired|unauthori/i.test(t)) return 'Shopify login expired. Run: shopify store auth --store 9c84df-f4.myshopify.com --scopes read_orders,read_customers,write_content,write_online_store_navigation,write_products';
    const m = /RuntimeError:\s*(.{0,160})/.exec(t);
    return m ? m[1].trim() : 'the check failed (see logs)';
}

async function tick() {
    if (busy) return;
    busy = true;
    const s = load();
    try {
        if (!fs.existsSync(SCRIPT)) throw new Error('script not found: ' + SCRIPT);
        // shellJob only runs `bash <file>`; `bash -c 'exec python3 "$0"' <path>`
        // keeps it argv-only (the path is $0, never spliced into the string)
        // and still gets its timeout and process-group kill.
        const r = await shellJob.runScript({
            file: '-c', args: ['exec python3 "$0" --hours 1', SCRIPT],
            cwd: path.dirname(SCRIPT), timeoutMs: TIMEOUT_MS,
        });
        if (r.timedOut) throw new Error('stopped after 3 min without finishing');
        const line = String(r.tail).split('\n').reverse().find(l => l.startsWith('RESULT '));
        if (!line) throw new Error(reason(r.tail));
        const out = JSON.parse(line.slice(7));
        s.lastRun = Date.now();
        s.lastError = '';
        s.failStreak = 0;
        s.lastSummary = `${out.abandoned} abandoned checkout(s) in the last hour`;
        if (out.flagged && out.flagged.length) {
            const why = out.flagged.map(f => f.why.join('; ')).join(' | ');
            s.lastSummary = 'POSSIBLE CARD TESTING: ' + why;
            s.history = [{ at: Date.now(), why }].concat(s.history || []).slice(0, MAX_HISTORY);
            if (Date.now() - (s.lastAlertAt || 0) > QUIET_AFTER_ALERT_MS) {
                s.lastAlertAt = Date.now();
                alert('PV: possible card testing', why + '. Normal is 0-2 abandoned checkouts a day. Check Shopify > Pedidos abandonados.');
            }
        }
    } catch (e) {
        s.lastRun = Date.now();
        s.lastError = String(e.message || e).slice(0, 300);
        s.failStreak = (s.failStreak || 0) + 1;
        // The second failure in a row reaches the phone, as automations do:
        // a watch that silently stopped is worse than no watch.
        if (s.failStreak === 2) alert('PV card watch is not running', s.lastError);
    } finally {
        save(s);
        busy = false;
    }
}

function alert(title, body) {
    try { if (deps.addEvent) deps.addEvent({ type: 'shop_alert', title, body }); } catch { /* best effort */ }
    try { if (deps.push) deps.push({ title, body, priority: 'high', tags: ['warning'] }); } catch { /* best effort */ }
}

function start({ addEvent, push } = {}) {
    deps = { addEvent: addEvent || deps.addEvent, push: push || deps.push };
    if (timer) return;
    setTimeout(tick, 60 * 1000).unref?.();          // first check a minute after boot
    timer = setInterval(tick, EVERY_MS);
    timer.unref?.();
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

function status() {
    const s = load();
    return {
        lastRun: s.lastRun || 0,
        error: s.lastError || '',
        warn: /CARD TESTING/.test(s.lastSummary || '') ? s.lastSummary : '',
        summary: s.lastSummary || 'Not run yet',
    };
}

function snapshot() {
    const s = load();
    return {
        on: !!timer, running: busy, every: '30 min',
        lastRun: s.lastRun || 0, lastError: s.lastError || '', lastSummary: s.lastSummary || '',
        lastAlertAt: s.lastAlertAt || 0, history: s.history || [],
    };
}

module.exports = { start, stop, tick, status, snapshot, reason, STATE_FILE };
