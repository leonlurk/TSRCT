// ─────────────────────────────────────────────────────────────────────────
// lib/ring.js — the machine CALLING the phone, instead of leaving a note.
//
// Leon, 2026-09-19: *"que sonara y me avisara como si fuera una llamada por
// telefono hasta que yo atendiera esa notificacion"*. That is three things a
// single notification does not do, and each one is solved by a different piece:
//
//   1. IT HAS TO BE LOUD. A Web Push lands in Chrome's own notification
//      channel, so its sound is whatever Android decided for the browser — not
//      something this server can set. **ntfy can:** priority 5 (urgent) with
//      the ringtone he picks per topic inside the ntfy app, and it may override
//      silent mode when he allows it. ntfy has been in his stack since the
//      beginning and was switched off in 2026-05-27 for lack of a use; this is
//      the use.
//   2. IT HAS TO KEEP RINGING. Neither ntfy nor Web Push repeats by itself, so
//      the repeat lives HERE: the same alert is re-sent every RING_EVERY_MS,
//      up to RING_MAX times, and the loop is a real timer on the server rather
//      than a promise chain that a restart would lose.
//   3. IT HAS TO STOP WHEN HE ANSWERS. That is what makes it a call and not an
//      alarm. The PWA calls `/api/ring/ack` the moment it opens from the alert
//      (and TALK acks too), which cancels the remaining rings. If nobody
//      answers, it gives up after RING_MAX instead of ringing all morning.
//
// Both channels go out on every ring, on purpose: ntfy is the one that makes
// noise, Web Push is the one that opens TSRCT on the right screen with one tap.
//
// SecretCo: this is content leaving the machine through TWO third parties (ntfy
// and Google). Both senders guard themselves — push.send() refuses outright,
// ntfyPush.send() redacts — and this module refuses BEFORE either, so a ring is
// never started for something it could not finish sending.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const restrictedGuard = require('./dispatcher/restrictedGuard');

const RING_EVERY_MS = Number(process.env.RING_EVERY_MS || 40000);
const RING_MAX = Number(process.env.RING_MAX || 5);
// ntfy priority 5 = "urgent": the app's loudest, and the one that can be given
// its own ringtone and a Do-Not-Disturb exception per topic.
const RING_PRIORITY = process.env.RING_PRIORITY || '5';

let deps = { push: null, ntfy: null, url: '' };
function configure(d) { deps = { ...deps, ...(d || {}) }; }

// One call at a time. A second thing worth ringing about while the first is
// still ringing replaces it — two overlapping rings on one phone is noise, not
// urgency, and the newer reason is the one he needs.
let current = null;      // { id, title, body, url, kind, sent, max, timer, startedAt, ackedAt }

function stop(reason) {
    if (!current) return null;
    if (current.timer) clearTimeout(current.timer);
    const done = { ...current, timer: undefined, stoppedAt: Date.now(), reason };
    current = null;
    return done;
}

async function fire(call) {
    call.sent += 1;
    call.lastAt = Date.now();
    const openUrl = (deps.url || '') + (call.url || '/');
    const nth = call.sent > 1 ? ` (${call.sent}/${call.max})` : '';
    const results = {};

    // The loud half.
    if (deps.ntfy) {
        try {
            results.ntfy = await deps.ntfy.send({
                title: `${call.title}${nth}`,
                body: call.body,
                priority: RING_PRIORITY,
                tags: ['phone'],
                // Tapping "ANSWER" opens TSRCT straight at the screen that
                // speaks -- the same URL the Web Push carries.
                actions: [{ action: 'view', label: 'ANSWER', url: openUrl }],
            });
        } catch (e) { results.ntfy = `error: ${e.message}`; }
    }

    // The half that opens the app on the right screen.
    if (deps.push) {
        try {
            const r = await deps.push.send({
                title: call.title,
                body: call.body,
                url: call.url || '/',
                kind: call.kind || 'ring',
                // One tag, so ring 4 REPLACES ring 3 in the shade instead of
                // stacking five identical cards he then has to dismiss.
                tag: `ring-${call.id}`,
            });
            results.push = r && r.ok ? `sent to ${r.sent}` : (r && (r.error || 'not sent'));
        } catch (e) { results.push = `error: ${e.message}`; }
    }

    if (!current || current.id !== call.id) return results;   // answered mid-send
    if (call.sent >= call.max) {
        console.log(`[ring] nobody answered after ${call.sent} rings - giving up`);
        stop('unanswered');
        return results;
    }
    call.timer = setTimeout(() => { fire(call).catch(() => {}); }, RING_EVERY_MS);
    if (call.timer.unref) call.timer.unref();
    return results;
}

// { title, body, url, kind, max? } — starts ringing and returns once the FIRST
// ring is out; the rest happen on the timer.
async function start({ title, body, url, kind, max } = {}) {
    const t = String(title || 'TSRCT');
    const b = String(body || '');
    // Fail closed, before anything leaves.
    restrictedGuard.assertNotRestricted('phone ring', t, b, String(url || ''));
    if (!deps.ntfy && !deps.push) return { ok: false, error: 'no way to reach the phone is configured' };
    stop('replaced');
    const call = {
        id: Date.now().toString(36),
        title: t,
        body: b,
        url: url || '/',
        kind: kind || 'ring',
        sent: 0,
        max: Math.max(1, Number(max || RING_MAX)),
        startedAt: Date.now(),
        timer: null,
    };
    current = call;
    const results = await fire(call);
    return {
        ok: true,
        id: call.id,
        rings: call.max,
        everyMs: RING_EVERY_MS,
        priority: RING_PRIORITY,
        results,
    };
}

// "I picked up." Called by the PWA when it opens from the alert, and by TALK.
function ack(who) {
    const done = stop(`answered by ${who || 'the phone'}`);
    if (done) console.log(`[ring] answered after ${done.sent} ring(s) - the rest are cancelled`);
    return { ok: true, wasRinging: !!done, rings: done ? done.sent : 0 };
}

function status() {
    return {
        ringing: !!current,
        id: current ? current.id : null,
        title: current ? current.title : '',
        sent: current ? current.sent : 0,
        max: current ? current.max : RING_MAX,
        everyMs: RING_EVERY_MS,
        priority: RING_PRIORITY,
        channels: { ntfy: !!deps.ntfy, push: !!deps.push },
    };
}

module.exports = { configure, start, ack, status, stop, RING_EVERY_MS, RING_MAX };
