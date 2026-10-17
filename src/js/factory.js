// ─────────────────────────────────────────────────────────────────────────
// FACTORY — the desktop tab for the software factory.
//
// Four zones, in TSRCT's own words:
//   [~] RUN         the researcher, live: phase, apps, counters, the wire
//   [*] CANDIDATES  ranked problems with the reasons, pick or drop each one
//   [>] BUILDS      what was picked, which tmux session is building it
//   [i] RUNS        one row per research day
//
// Everything here is drawn from GET /api/factory/state. The panel draws; the
// server watches the factory repo. The HUD is a stage, not a workspace: the
// only inputs are pick, drop, build, pull, run.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const hdrs = () => ({ Authorization: (typeof token !== 'undefined' ? token : '') || '' });
    const esc = s => (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s);
    const note = (m, t) => { if (typeof toast === 'function') toast(m, t || 'success'); };

    let st = null;
    let fetchedAt = 0;
    let err = null;
    let poll = null, tickTimer = null, refs = 0;
    // Wire bookkeeping: the feed is appended to, never rebuilt, so a line that
    // was typed in stays exactly where it was.
    let wireRun = null, wireCount = 0;
    let lastQuoteKey = '', lastFindings = 0;
    const open = { why: new Set(), ev: new Set() };
    let showDead = false;
    // The moment [RUN NOW, CLOUD] was pressed in this tab. The server's own
    // cloudFire record arrives with the next poll; this covers the seconds before.
    let fireAt = null;
    const LAUNCH_GIVE_UP_MS = 10 * 60 * 1000;

    const PHASES = [
        ['starting', 'SHELF'], ['reading', 'READ'], ['clustering', 'CLUSTER'],
        ['checking', 'CHECK'], ['writing', 'WRITE'], ['pushing', 'PUSH'], ['done', 'DONE'],
    ];

    // ── skeleton (built once) ────────────────────────────────────────────
    function skeleton() {
        const root = $('pc-factory-body');
        if (!root || root.dataset.built) return;
        root.dataset.built = '1';
        root.innerHTML = `
        <div class="fx">
          <div class="fx-hud" id="fx-hud">
            <div class="fx-scan"></div>
            <div class="fx-hud-left">
              <div class="fx-status">
                <span class="fx-word" id="fx-word">IDLE</span>
                <span class="fx-sub" id="fx-sub"></span>
              </div>
              <div class="fx-steps" id="fx-steps"></div>
              <div class="fx-next" id="fx-next"></div>
              <div class="fx-actions">
                <button class="fx-act" onclick="fxPull(this)">[PULL]</button>
                <button class="fx-act" id="fx-cloud-btn" onclick="fxRunCloud(this)">[RUN NOW, CLOUD]</button>
                <button class="fx-act" id="fx-run-btn" onclick="fxRun(this)">[RUN NOW, LOCAL]</button>
              </div>
            </div>
            <div class="fx-hud-mid">
              <div class="fx-ring-wrap">
                <svg class="fx-ring" viewBox="0 0 120 120">
                  <circle class="fx-ring-bg" cx="60" cy="60" r="52"></circle>
                  <circle class="fx-ring-fg" id="fx-ring-fg" cx="60" cy="60" r="52"></circle>
                </svg>
                <div class="fx-ring-text"><span id="fx-ring-n">0/0</span><span class="fx-ring-label">APPS</span></div>
              </div>
              <div class="fx-counters">
                <div class="fx-counter"><span class="fx-c-val" id="fx-c-reviews" data-v="0">0</span><span class="fx-c-label">REVIEWS READ</span></div>
                <div class="fx-counter"><span class="fx-c-val fx-c-amber" id="fx-c-quotes" data-v="0">0</span><span class="fx-c-label">QUOTES KEPT</span></div>
                <div class="fx-counter"><span class="fx-c-val fx-c-neon" id="fx-c-findings" data-v="0">0</span><span class="fx-c-label">FINDINGS</span></div>
              </div>
            </div>
            <div class="fx-hud-right">
              <div class="fx-wire-head"><span class="fx-zone-title">[&gt;] WIRE</span><span class="fx-zone-sub" id="fx-wire-from"></span></div>
              <div class="fx-wire" id="fx-wire"><div class="fx-line fx-dim">no run on the wire</div></div>
              <div class="fx-url" id="fx-url"></div>
            </div>
            <div class="fx-capture" id="fx-capture"></div>
            <div class="fx-stamp" id="fx-stamp"></div>
          </div>
          <div class="fx-zone fx-cands" id="fx-cands"></div>
          <div class="fx-zone fx-builds" id="fx-builds"></div>
          <div class="fx-zone fx-runs" id="fx-runs"></div>
        </div>`;
    }

    // ── fetch ────────────────────────────────────────────────────────────
    async function load() {
        try {
            const r = await fetch('/api/factory/state', { headers: hdrs() });
            if (!r.ok) throw new Error('server answered ' + r.status);
            st = await r.json();
            fetchedAt = Date.now();
            err = null;
        } catch (e) { err = e.message || String(e); }
    }

    async function post(url, body) {
        const r = await fetch(url, { method: 'POST', headers: { ...hdrs(), 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
    }

    // ── small draw helpers ───────────────────────────────────────────────
    function animateNumber(el, to) {
        if (!el) return;
        const from = Number(el.dataset.v || 0);
        to = Number(to) || 0;
        if (from === to) { el.textContent = String(to); return; }
        el.dataset.v = String(to);
        const t0 = performance.now(), dur = 500;
        el.classList.add('fx-c-tick');
        const step = (t) => {
            const k = Math.min(1, (t - t0) / dur);
            const e = 1 - Math.pow(1 - k, 3);
            el.textContent = String(Math.round(from + (to - from) * e));
            if (k < 1) requestAnimationFrame(step); else setTimeout(() => el.classList.remove('fx-c-tick'), 200);
        };
        requestAnimationFrame(step);
    }

    function fmtCountdown(iso) {
        const ms = Date.parse(iso || '') - Date.now();
        if (!Number.isFinite(ms)) return '';
        const s = Math.max(0, Math.floor(ms / 1000));
        const p = n => String(n).padStart(2, '0');
        return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
    }

    function fmtClock(ts) {
        const d = new Date(ts); if (isNaN(d)) return '';
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    function ago(ts) {
        const t = typeof ts === 'number' ? ts : Date.parse(ts || '');
        if (!Number.isFinite(t)) return '';
        const m = Math.round((Date.now() - t) / 60000);
        if (m < 1) return 'now'; if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60); return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
    }

    // Between the click and the run's first line on the wire there are two
    // silent stretches: the ~15 s call that asks the cloud, then 1-2 min while
    // the cloud provisions the researcher. Both used to look like nothing.
    // Returns null when not launching, else { stage, since }.
    function launching() {
        if (!st) return null;
        if (st.liveActive || (st.localRun && st.localRun.active)) return null;
        const recent = t => Number.isFinite(t) && (Date.now() - t) < LAUNCH_GIVE_UP_MS;
        const fire = st.cloudFire || null;
        const firedAt = fire ? Date.parse(fire.startedAt) : NaN;
        if (recent(firedAt)) {
            if (fire.active) return { stage: 'asking', since: firedAt };
            if (!fire.ok) return null;   // the cloud said no; the toast said why
            // once a live file newer than the click exists, that run is the answer
            const liveStart = st.live ? Date.parse(st.live.startedAt || '') : NaN;
            if (Number.isFinite(liveStart) && liveStart >= firedAt - 60000) return null;
            return { stage: 'waiting', since: Date.parse(fire.finishedAt) || firedAt };
        }
        if (fireAt && recent(fireAt)) return { stage: 'asking', since: fireAt };
        return null;
    }

    // ── [~] RUN — the HUD ────────────────────────────────────────────────
    function drawHud() {
        const hud = $('fx-hud'); if (!hud) return;
        const live = st.live || null;
        const active = !!st.liveActive || !!(st.localRun && st.localRun.active);
        const phase = live ? live.phase : null;
        const launch = active ? null : launching();

        hud.classList.toggle('fx-live', active);
        hud.classList.toggle('fx-launching', !!launch);
        hud.classList.toggle('fx-done', !active && !launch && phase === 'done');

        // status word
        const word = $('fx-word'), sub = $('fx-sub');
        if (active) {
            word.textContent = 'LIVE';
            sub.textContent = (live && live.category ? live.category : 'reading') + (st.liveFrom === 'local' ? ' - on this laptop' : ' - in the cloud');
        } else if (launch) {
            word.textContent = 'LAUNCHING';
            sub.textContent = launch.stage === 'asking'
                ? 'asking the cloud to start the researcher (about 15 s)'
                : 'the cloud said yes - it is setting up the researcher, first line in 1-2 min';
        } else if (phase === 'done') {
            word.textContent = 'DONE';
            sub.textContent = `${live.category || ''} - ${live.run || ''}${live.result && live.result.note ? ' - ' + live.result.note : ''}`;
        } else {
            word.textContent = st.available ? 'IDLE' : 'NO LINK';
            sub.textContent = st.available ? 'waiting for the next shelf' : (st.lastError || 'factory not found');
        }

        // steps
        const stepsEl = $('fx-steps');
        const idx = PHASES.findIndex(p => p[0] === phase);
        stepsEl.innerHTML = PHASES.map((p, i) => {
            const cls = i < idx ? 'fx-step fx-step-done' : (i === idx ? (active ? 'fx-step fx-step-on' : 'fx-step fx-step-done') : 'fx-step');
            return `<span class="${cls}">${p[1]}</span>`;
        }).join('<span class="fx-step-gap"></span>');

        // ring + counters
        const apps = (live && live.apps) || {};
        const total = Number(apps.total) || 0, done = Number(apps.done) || 0;
        const ring = $('fx-ring-fg');
        const C = 2 * Math.PI * 52;
        const frac = launch ? 0.22 : total ? Math.min(1, done / total) : (active ? 0.08 : 0);
        ring.style.strokeDasharray = String(C);
        ring.style.strokeDashoffset = String(C * (1 - frac));
        $('fx-ring-n').textContent = launch ? '...' : total ? `${done}/${total}` : (active ? '...' : '0/0');
        animateNumber($('fx-c-reviews'), live ? live.reviewsRead : 0);
        animateNumber($('fx-c-quotes'), live ? live.quotesKept : 0);
        const nf = live && Array.isArray(live.findings) ? live.findings.length : 0;
        animateNumber($('fx-c-findings'), nf);

        // wire
        const wire = $('fx-wire');
        // Two runs on the same day are two runs (found on 2026-09-12: a blocked
        // run and its retry shared a date, and the retry inherited the old
        // lines). The start time is what makes a run itself.
        const run = live ? (live.run + '|' + (live.where || '') + '|' + (live.startedAt || '')) : null;
        if (run !== wireRun) { wire.innerHTML = ''; wireRun = run; wireCount = 0; lastQuoteKey = ''; lastFindings = 0; }
        const log = (live && Array.isArray(live.log)) ? live.log : [];
        // The researcher keeps the last 40; if it trimmed, resync from what is there.
        if (log.length < wireCount) { wire.innerHTML = ''; wireCount = 0; }
        for (let i = wireCount; i < log.length; i++) {
            const l = log[i] || {};
            const div = document.createElement('div');
            div.className = 'fx-line fx-line-new';
            div.innerHTML = `<span class="fx-line-t">${esc(fmtClock(l.at))}</span><span class="fx-line-x">${esc(l.text || '')}</span>`;
            wire.appendChild(div);
            setTimeout(() => div.classList.remove('fx-line-new'), 1200);
        }
        wireCount = log.length;
        while (wire.children.length > 60) wire.removeChild(wire.firstChild);
        if (!log.length && !wire.children.length) wire.innerHTML = '<div class="fx-line fx-dim">no run on the wire</div>';
        // one amber line at the bottom while launching; gone the moment the run writes
        let ll = wire.querySelector('.fx-launch-line');
        if (launch) {
            if (!ll) { ll = document.createElement('div'); ll.className = 'fx-line fx-launch-line'; wire.appendChild(ll); }
            ll.innerHTML = `<span class="fx-line-t">${esc(fmtClock(launch.since))}</span><span class="fx-line-x">${launch.stage === 'asking' ? 'asking the cloud to run...' : 'cloud accepted - waiting for its first line...'}</span>`;
            wire.appendChild(ll);
        } else if (ll) ll.remove();
        wire.scrollTop = wire.scrollHeight;
        $('fx-wire-from').textContent = launch ? `launching - ${ago(launch.since)}` : live ? `${live.where || 'cloud'} - ${ago(live.updatedAt || live.startedAt)}` : '';
        $('fx-url').textContent = active && apps.currentUrl ? apps.currentUrl : '';

        // capture card: the last quote kept
        const cap = $('fx-capture');
        const q = live && live.lastQuote;
        const key = q ? (q.app + '|' + (q.quote || '').slice(0, 80)) : '';
        if (!q) { cap.innerHTML = ''; cap.classList.remove('fx-cap-in'); }
        else if (key !== lastQuoteKey) {
            lastQuoteKey = key;
            cap.innerHTML = `<span class="fx-cap-tag">[CAPTURED]</span><span class="fx-cap-q">"${esc(q.quote)}"</span><span class="fx-cap-meta">${esc(q.app || '')}${q.rating ? ' - ' + q.rating + ' star' : ''}</span>`;
            cap.classList.remove('fx-cap-in'); void cap.offsetWidth; cap.classList.add('fx-cap-in');
        }

        // stamp: a finding was just written
        if (nf > lastFindings && lastFindings >= 0 && live && live.findings) {
            const f = live.findings[nf - 1] || {};
            if (lastFindings > 0 || active) stamp(`FINDING WRITTEN: ${f.id || ''}`);
        }
        lastFindings = nf;

        // countdown / next
        drawNext();
        const runBtn = $('fx-run-btn');
        if (runBtn) runBtn.disabled = !!(st.localRun && st.localRun.active) || !st.available;
        const cloudBtn = $('fx-cloud-btn');
        if (cloudBtn) cloudBtn.disabled = !st.available || !!st.liveActive || !!(st.localRun && st.localRun.active) || !!launch;
    }

    function stamp(text) {
        const el = $('fx-stamp'); if (!el) return;
        el.textContent = text;
        el.classList.remove('fx-stamp-on'); void el.offsetWidth; el.classList.add('fx-stamp-on');
        setTimeout(() => el.classList.remove('fx-stamp-on'), 1400);
    }

    function drawNext() {
        const el = $('fx-next'); if (!el || !st) return;
        const active = !!st.liveActive || !!(st.localRun && st.localRun.active);
        if (active) { el.textContent = st.localRun && st.localRun.active ? `local run - ${ago(st.localRun.startedAt)}` : ''; return; }
        const launch = launching();
        if (launch) {
            const s = Math.max(0, Math.floor((Date.now() - launch.since) / 1000));
            el.textContent = `launching for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} - the wire wakes up when the researcher writes its first line`;
            return;
        }
        const rt = st.routine || {};
        el.textContent = rt.nextRunAt ? `next cloud run in ${fmtCountdown(rt.nextRunAt)} - ${rt.human || rt.cron || ''}` : 'no schedule configured';
    }

    // ── [*] CANDIDATES ───────────────────────────────────────────────────
    function chips(c) {
        const apps = new Set((c.evidence || []).map(e => e.app).filter(Boolean)).size;
        const bits = [
            `${(c.evidence || []).length} people`, `${apps} app${apps === 1 ? '' : 's'}`,
            c.complaintType || '', (c.proposed && c.proposed.scope) || '',
        ].filter(Boolean);
        return bits.map(b => `<span class="fx-chip">${esc(b)}</span>`).join('');
    }

    function candCard(c, s) {
        const dead = !!c.dead, worth = !!c.worth;
        const cls = dead ? 'fx-card fx-card-dead' : worth ? 'fx-card fx-card-worth' : 'fx-card';
        const pct = Math.max(4, Math.min(100, Math.round((Number(c.score) || 0) / 15 * 100)));
        const why = open.why.has(c.id), ev = open.ev.has(c.id);
        const name = (c.proposed && c.proposed.name) ? c.proposed.name : '';
        return `<div class="${cls}" data-id="${esc(c.id)}">
            <div class="fx-card-score"><span class="fx-score-n">${esc(c.score)}</span><div class="fx-score-bar"><i style="width:${pct}%"></i></div>${worth ? '<span class="fx-score-tag">WORTH IT</span>' : dead ? '<span class="fx-score-tag fx-tag-dead">DEAD</span>' : ''}</div>
            <div class="fx-card-main">
              <div class="fx-card-top"><span class="fx-card-id">${esc(c.id)}</span>${name ? `<span class="fx-card-name">${esc(name)}</span>` : ''}<span class="fx-card-seen">${esc(c.lastSeen || '')}</span></div>
              <div class="fx-card-problem">${esc(c.problem || '')}</div>
              <div class="fx-card-chips">${chips(c)}</div>
              ${why ? `<div class="fx-card-why">${(c.reasons || []).map(r => `<div>- ${esc(r)}</div>`).join('')}</div>` : ''}
              ${ev ? `<div class="fx-card-ev">${(c.evidence || []).map(e => `<div class="fx-ev"><span class="fx-ev-q">"${esc(e.quote)}"</span><a class="fx-ev-a" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.app || 'open')}${e.appPrice ? ' - ' + esc(e.appPrice) : ''}${e.rating ? ' - ' + e.rating + ' star' : ''}</a></div>`).join('')}</div>` : ''}
            </div>
            <div class="fx-card-acts">
              ${!dead ? `<button class="fx-act fx-act-go" onclick="fxPick('${esc(c.id)}', this)">[PICK]</button>` : ''}
              <button class="fx-act fx-act-ghost" onclick="fxDrop('${esc(c.id)}', this)">[DROP]</button>
              <button class="fx-act fx-act-ghost" onclick="fxToggle('why','${esc(c.id)}')">${why ? '[hide why]' : '[why?]'}</button>
              <button class="fx-act fx-act-ghost" onclick="fxToggle('ev','${esc(c.id)}')">${ev ? '[hide evidence]' : '[evidence]'}</button>
            </div>
          </div>`;
    }

    function drawCands() {
        const el = $('fx-cands'); if (!el) return;
        const board = st.board || {};
        const builds = board.builds || {}, dropped = board.dropped || {};
        const all = (board.ranked || []).filter(c => !builds[c.id] && !dropped[c.id]);
        const alive = all.filter(c => !c.dead), dead = all.filter(c => c.dead);
        const worth = alive.filter(c => c.worth).length;
        let html = `<div class="fx-zone-head"><span class="fx-zone-title">[*] CANDIDATES</span><span class="fx-zone-count ${worth ? 'fx-hot' : ''}">${alive.length}</span><span class="fx-zone-sub">${worth} worth building - ${Object.keys(dropped).length} dropped${st.lastPull ? ' - pulled ' + ago(st.lastPull) : ''}</span></div>`;
        if (!alive.length) html += `<div class="fx-empty"><div class="fx-empty-mark">[ ]</div><div>nothing to pick. ${dead.length ? dead.length + ' buried below.' : 'the next shelf may bring something.'}</div></div>`;
        else html += alive.map(c => candCard(c, st)).join('');
        if (dead.length) {
            html += `<div class="fx-dead-bar"><span class="fx-zone-sub">${dead.length} buried: a vendor's bug, a support complaint, or already solved</span><button class="fx-act fx-act-ghost" onclick="fxShowDead()">${showDead ? '[hide]' : '[show]'}</button></div>`;
            if (showDead) html += dead.map(c => candCard(c, st)).join('');
        }
        el.innerHTML = html;
    }

    // ── [>] BUILDS ───────────────────────────────────────────────────────
    function drawBuilds() {
        const el = $('fx-builds'); if (!el) return;
        const builds = (st.board && st.board.builds) || {};
        const ids = Object.keys(builds);
        let html = `<div class="fx-zone-head"><span class="fx-zone-title">[&gt;] BUILDS</span><span class="fx-zone-count">${ids.length}</span><span class="fx-zone-sub">${ids.filter(i => builds[i].status === 'building').length} building</span></div>`;
        if (!ids.length) html += '<div class="fx-empty"><div class="fx-empty-mark">[ ]</div><div>nothing picked yet</div></div>';
        else html += '<div class="fx-tiles">' + ids.map(id => {
            const b = builds[id];
            const when = b.publishedAt || b.buildStartedAt || b.pickedAt;
            return `<div class="fx-tile fx-b-${esc(b.status)}">
                <div class="fx-tile-top"><span class="fx-tile-dot">${b.status === 'building' ? '[*]' : b.status === 'published' ? '[+]' : '[ ]'}</span><span class="fx-tile-id">${esc(id)}</span><span class="fx-tile-st">${esc(b.status)}</span></div>
                <div class="fx-tile-sub">${esc(ago(when))}${b.session ? ' - tmux ' + esc(b.session) : ''}</div>
                <div class="fx-tile-acts">
                  ${b.status === 'picked' ? `<button class="fx-act fx-act-go" onclick="fxBuild('${esc(id)}', this)">[BUILD]</button>` : ''}
                  ${b.session ? `<button class="fx-act" onclick="fxOpen('${esc(b.session)}')">[OPEN SESSION]</button>` : ''}
                  ${b.status !== 'published' ? '<span class="fx-tile-note">publish: from the CLI, checklist + --yes</span>' : ''}
                </div>
              </div>`;
        }).join('') + '</div>';
        el.innerHTML = html;
    }

    // ── [i] RUNS ─────────────────────────────────────────────────────────
    function drawRuns() {
        const el = $('fx-runs'); if (!el) return;
        const runs = st.runs || [];
        let html = `<div class="fx-zone-head"><span class="fx-zone-title">[i] RUNS</span><span class="fx-zone-count">${runs.length}</span><span class="fx-zone-sub">${st.routine && st.routine.human ? esc(st.routine.human) : ''}${st.routine && st.routine.model ? ' - ' + esc(st.routine.model) : ''}</span></div>`;
        if (err) html += `<div class="fx-fail">[!] NO LINK - ${esc(err)}</div>`;
        if (st.lastError) html += `<div class="fx-warn">${esc(st.lastError)}</div>`;
        if (!runs.length) html += '<div class="fx-empty"><div class="fx-empty-mark">[ ]</div><div>no research days yet</div></div>';
        else html += '<div class="fx-run-list">' + runs.slice(0, 14).map(r => `
            <div class="fx-run-row ${r.worth ? 'fx-run-worth' : ''}">
              <span class="fx-run-date">${esc(r.date)}</span>
              <span class="fx-run-cat">${esc(r.category || '?')}</span>
              <span class="fx-run-n">${r.apps || 0} apps</span>
              <span class="fx-run-n">${r.findings || 0} findings</span>
              <span class="fx-run-n ${r.worth ? 'fx-hot' : ''}">${r.worth || 0} worth</span>
              <span class="fx-run-note">${esc(r.note || '')}</span>
            </div>`).join('') + '</div>';
        el.innerHTML = html;
    }

    function render() {
        skeleton();
        if (!st) {
            const hud = $('fx-hud'); if (hud) { $('fx-word').textContent = 'NO LINK'; $('fx-sub').textContent = err || 'loading'; }
            return;
        }
        drawHud(); drawCands(); drawBuilds(); drawRuns();
        const stampEl = $('fx-stamp-time'); if (stampEl) stampEl.textContent = `updated ${Math.round((Date.now() - fetchedAt) / 1000)}s ago`;
    }

    // ── actions ──────────────────────────────────────────────────────────
    function busy(btn) { if (btn) { btn.disabled = true; btn.classList.add('fx-busy'); } }

    async function fxPull(btn) {
        busy(btn);
        try { const d = await post('/api/factory/pull'); note(`pulled: ${d.created || 0} new, ${d.updated || 0} updated`); }
        catch (e) { note('pull failed: ' + e.message, 'error'); }
        await load(); render();
    }
    async function fxRun(btn) {
        busy(btn);
        try { await post('/api/factory/run'); note('local researcher started - watch the wire'); }
        catch (e) { note('could not start: ' + e.message, 'error'); }
        await load(); render();
    }
    async function fxRunCloud(btn) {
        if (!window.confirm('Start a cloud research run now? It uses the same budget as the daily one.')) return;
        busy(btn);
        fireAt = Date.now(); render(); cadence();
        note('asking the cloud to start...');
        try { await post('/api/factory/run-cloud'); note('cloud researcher started - it shows on the wire in a minute or two'); }
        catch (e) { fireAt = null; note('cloud run did not start: ' + e.message, 'error'); }
        if (btn) btn.classList.remove('fx-busy');
        await load(); render();
    }
    async function fxPick(id, btn) {
        busy(btn);
        try { const d = await post('/api/factory/pick', { id }); note(d.ok ? 'picked ' + id : (d.out || 'refused'), d.ok ? 'success' : 'warn'); }
        catch (e) { note('pick failed: ' + e.message, 'error'); }
        await load(); render();
    }
    async function fxDrop(id, btn) {
        const reason = window.prompt('why drop ' + id + '? (kept for next time)', '');
        if (reason === null) return;
        busy(btn);
        try { await post('/api/factory/drop', { id, reason }); note('dropped ' + id); }
        catch (e) { note('drop failed: ' + e.message, 'error'); }
        await load(); render();
    }
    async function fxBuild(id, btn) {
        busy(btn);
        try { await post('/api/factory/build', { id }); note('lead session starting for ' + id + ' - it will ask you for a roster'); }
        catch (e) { note('build failed: ' + e.message, 'error'); }
        setTimeout(async () => { await load(); render(); }, 3000);
    }
    function fxOpen(session) {
        try {
            if (typeof pcSwitchSession === 'function') pcSwitchSession(session);
            if (typeof pcSwitchTab === 'function') pcSwitchTab('terminal');
        } catch (e) { console.error('[factory] open failed', e); }
    }
    function fxToggle(kind, id) {
        const s = open[kind]; if (!s) return;
        if (s.has(id)) s.delete(id); else s.add(id);
        drawCands();
    }
    function fxShowDead() { showDead = !showDead; drawCands(); }

    // ── lifecycle ────────────────────────────────────────────────────────
    function cadence() {
        if (poll) clearTimeout(poll);
        const hot = st && (st.liveActive || (st.localRun && st.localRun.active) || launching());
        poll = setTimeout(async () => { if (refs > 0) { await load(); render(); cadence(); } }, hot ? 2500 : 6000);
    }
    async function fxInit() {
        refs++;
        document.body.classList.add('fx-active');
        skeleton();
        await load(); render();
        cadence();
        if (!tickTimer) tickTimer = setInterval(drawNext, 1000);
    }
    function fxTeardown() {
        refs = Math.max(0, refs - 1);
        document.body.classList.remove('fx-active');
        if (refs === 0) {
            if (poll) clearTimeout(poll); poll = null;
            if (tickTimer) clearInterval(tickTimer); tickTimer = null;
        }
    }

    // Every name used in an inline handler above, including the ones this file
    // writes into its own HTML (CLAUDE.md; npm run check enforces it).
    Object.assign(window, { fxInit, fxTeardown, fxPull, fxRun, fxRunCloud, fxPick, fxDrop, fxBuild, fxOpen, fxToggle, fxShowDead });
})();
