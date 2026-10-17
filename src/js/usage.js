/*
 * usage.js — the sidebar's [$] USAGE section: what today really cost, and how
 * much of the plan is left.
 *
 * Two different questions, two different sources, and the panel keeps them apart:
 *   1. HOW MUCH IS LEFT — the Claude.ai 5-hour and 7-day quota bars. They are
 *      what actually stops work. They arrive from the status line
 *      (scripts/statusline-usage.sh) and are only ever as fresh as the last time
 *      a Claude session rendered its status line, so the age is always shown.
 *   2. WHAT IT COST — tokens and dollars, computed from the transcripts on disk.
 *
 * ON DEMAND, ALWAYS. There is no interval in this file and there must never be
 * one: every refresh walks ~150 MB of transcripts on the server. It scans once
 * when the section is first opened and after that only when [refresh] is
 * clicked. No model is involved anywhere in this feature, so it works with
 * Ollama, Hermes and the dispatcher off — reading your own usage must never
 * cost you a turn.
 */
(function () {
    'use strict';

    const state = { data: null, loading: false, error: '', scannedAt: 0, everOpened: false };

    // The pre-handoff baseline, measured 2026-08-24 over the 16 days before the
    // first handoff ran (10,069 turns): 30% of turns and 49% of spend above 300k
    // of context. It is the ONLY reason the bucket table means anything —
    // without a before, a distribution is a shape, not a result.
    const BASELINE_300K = { turns: 0.30, cost: 0.49 };

    const usd = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const toks = n => {
        n = Number(n) || 0;
        if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
        return String(n);
    };
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
    const esc = s => (window.escapeHtml ? window.escapeHtml(String(s)) : String(s));

    function ageText(ts) {
        if (!ts) return 'never';
        const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (s < 60) return s + 's ago';
        const m = Math.round(s / 60);
        if (m < 60) return m + ' min ago';
        const h = m / 60;
        if (h < 48) return h.toFixed(1) + ' h ago';
        return Math.round(h / 24) + ' d ago';
    }

    // "resets in 2.5 h" beats a timestamp: the question behind the bar is always
    // "do I wait, or do I stop". The server hands this over already normalised to
    // epoch ms — Claude Code's own field is epoch SECONDS.
    function resetText(ms) {
        const t = Number(ms);
        if (!Number.isFinite(t) || t <= 0) return '';
        const mins = Math.round((t - Date.now()) / 60000);
        if (mins <= 0) return 'resetting';
        if (mins < 60) return 'resets in ' + mins + ' min';
        const h = mins / 60;
        if (h < 48) return 'resets in ' + h.toFixed(1) + ' h';
        return 'resets in ' + Math.round(h / 24) + ' d';
    }

    // A row with a proportional bar. The bar is scaled against the biggest row,
    // not against the total, or eight small rows all render as nothing.
    function bar(label, value, max, right, cls) {
        const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
        return `<div class="usg-row ${cls || ''}">
            <span class="usg-row-label" title="${esc(label)}">${esc(label)}</span>
            <span class="usg-row-bar"><i style="width:${w}%"></i></span>
            <span class="usg-row-val">${esc(right)}</span>
        </div>`;
    }

    // The quota bars read as a percentage of a fixed 100, never relative to each
    // other: 61% of the week is 61% of the week whatever the 5-hour bar says.
    function quotaBar(name, b) {
        if (!b) return `<div class="usg-quota"><span class="usg-quota-name">${esc(name)}</span>
            <span class="usg-note">no reading</span></div>`;
        const level = b.used >= 90 ? 'usg-q-bad' : b.used >= 70 ? 'usg-q-warn' : 'usg-q-ok';
        return `<div class="usg-quota ${level}">
            <div class="usg-quota-head">
                <span class="usg-quota-name">${esc(name)}</span>
                <span class="usg-quota-left"><b>${(100 - b.used).toFixed(0)}%</b> left</span>
            </div>
            <span class="usg-quota-track"><i style="width:${Math.max(1, Math.round(b.used))}%"></i></span>
            <div class="usg-quota-foot">
                <span>${b.used.toFixed(0)}% used</span>
                <span>${esc(resetText(b.resetsAt))}</span>
            </div>
        </div>`;
    }

    function render() {
        const el = document.getElementById('pc-usage-body');
        if (!el) return;

        if (state.loading && !state.data) {
            el.innerHTML = `<div class="usg-note">measuring the day… (the first read walks the whole transcript store)</div>`;
            return;
        }
        if (state.error && !state.data) {
            el.innerHTML = `<div class="usg-note usg-bad">could not measure: ${esc(state.error)}</div>`;
            return;
        }
        if (!state.data) {
            el.innerHTML = `<div class="usg-note">hit [refresh] to measure the day.</div>`;
            return;
        }

        const d = state.data;
        const t = d.totals || {};
        const q = d.bars || {};
        const b = d.buckets || [];
        const heavy = b[b.length - 1] || { turns: 0, cost: 0 };
        const maxProj = Math.max(...(d.byProject || []).map(x => x.cost), 0);
        const maxModel = Math.max(...(d.byModel || []).map(x => x.cost), 0);
        const maxBucket = Math.max(...b.map(x => x.cost), 0);
        const maxSess = Math.max(...(d.sessions || []).map(x => x.cost), 0);
        const maxHour = Math.max(...(d.hours || []), 0);
        const totalTokens = (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);

        const parts = [
            { k: 'cache read', v: t.costCacheRead, n: t.cacheRead, why: 'what the session CARRIES: the whole conversation re-sent every turn' },
            { k: 'cache write', v: t.costCacheWrite, n: t.cacheWrite, why: 'storing new context (1h TTL = 2x the input price)' },
            { k: 'output', v: t.costOutput, n: t.output, why: 'what Claude wrote, thinking included' },
            { k: 'input', v: t.costInput, n: t.input, why: 'fresh text that was not cached' },
        ].sort((a, b2) => b2.v - a.v);
        const maxPart = Math.max(...parts.map(p => p.v), 0);

        el.innerHTML = `
            <div class="usg-block usg-block-quota">
                <div class="usg-h">PLAN LEFT<span class="usg-h-note">the limit that stops you</span></div>
                ${quotaBar('5-hour window', q.fiveHour)}
                ${quotaBar('7-day window', q.sevenDay)}
                <div class="usg-note">${q.capturedAt
                    ? `read from the status line ${esc(ageText(q.capturedAt))} — it only updates while a Claude session is open`
                    : `no reading yet: the status line writes this on its next render. ${esc(q.reason || '')}`}</div>
            </div>

            <div class="usg-hero">
                <div class="usg-cost">${toks(totalTokens)}<span class="usg-cost-unit">tokens today</span></div>
                <div class="usg-sub">${usd(t.cost)} · ${(t.turns || 0).toLocaleString('en-US')} turns · ${d.sessionCount || 0} sessions</div>
                <div class="usg-sub usg-dim">measured ${esc(ageText(state.scannedAt))}${d.scan ? ` · ${d.scan.ms} ms · ${d.scan.files} files` : ''} · no auto-refresh</div>
                ${d.scan && d.scan.restrictedExcluded ? `<div class="usg-sub usg-dim">${d.scan.restrictedExcluded} transcript(s) excluded by the SecretCo contract (Bedrock, billed separately)</div>` : ''}
                ${d.estimatedCost > 0.005 ? `<div class="usg-sub usg-warn">${usd(d.estimatedCost)} estimated: a model is missing from the price table</div>` : ''}
            </div>

            <div class="usg-block">
                <div class="usg-h">CONTEXT WEIGHT<span class="usg-h-note">what the handoff moves</span></div>
                ${b.map(x => bar(x.key, x.cost, maxBucket,
                    `${toks(0) === '0' ? '' : ''}${x.turns} turns · ${pct(x.cost, t.cost)}%`,
                    x.key === '300k+' ? 'usg-heavy' : '')).join('')}
                <div class="usg-verdict ${pct(heavy.cost, t.cost) <= BASELINE_300K.cost * 50 ? 'usg-good' : 'usg-bad'}">
                    over 300k: <b>${pct(heavy.turns, t.turns)}% of turns, ${pct(heavy.cost, t.cost)}% of spend</b>
                    <span class="usg-dim">— before the handoff: ${Math.round(BASELINE_300K.turns * 100)}% / ${Math.round(BASELINE_300K.cost * 100)}%</span>
                </div>
            </div>

            <div class="usg-block">
                <div class="usg-h">WHERE IT GOES</div>
                ${parts.map(p => bar(p.k, p.v, maxPart, `${toks(p.n)} · ${usd(p.v)}`, '')).join('')}
                <div class="usg-note">${esc(parts[0].why)}</div>
                <div class="usg-note usg-good">the cache saved ${usd(t.cacheSaved)} today — without it those ${toks(t.cacheRead)} tokens were billed in full</div>
            </div>

            <div class="usg-block">
                <div class="usg-h">BY PROJECT</div>
                ${(d.byProject || []).slice(0, 7).map(p => bar(p.key, p.cost, maxProj, usd(p.cost), '')).join('') || '<div class="usg-note">nothing yet</div>'}
            </div>

            <div class="usg-block">
                <div class="usg-h">BY MODEL</div>
                ${(d.byModel || []).map(m => bar(m.key.replace(/^claude-/, ''), m.cost, maxModel, usd(m.cost), '')).join('')}
            </div>

            <div class="usg-block">
                <div class="usg-h">HEAVIEST SESSIONS</div>
                ${(d.sessions || []).slice(0, 6).map(s => bar(
                    s.project, s.cost, maxSess, `${usd(s.cost)} · peak ${toks(s.peakCtx)}`,
                    s.peakCtx >= 300000 ? 'usg-heavy' : '')).join('') || '<div class="usg-note">nothing yet</div>'}
            </div>

            <div class="usg-block">
                <div class="usg-h">BY HOUR</div>
                <div class="usg-hours">
                    ${(d.hours || []).map((h, i) => `<i style="height:${maxHour > 0 ? Math.max(2, Math.round((h / maxHour) * 100)) : 2}%"
                        title="${String(i).padStart(2, '0')}:00 — ${usd(h)}"></i>`).join('')}
                </div>
                <div class="usg-hours-axis"><span>00</span><span>12</span><span>23</span></div>
            </div>
        `;
    }

    async function refresh(force) {
        if (state.loading) return;
        state.loading = true;
        state.error = '';
        const btn = document.getElementById('pc-usage-refresh');
        if (btn) { btn.classList.add('working'); btn.textContent = '[…]'; }
        render();
        try {
            const r = await fetch('/api/usage/day', {
                headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') || '' }
            });
            const d = await r.json();
            if (d && d.ok) {
                state.data = d;
                // The server's own clock for when it read the disk; a scan served
                // from its cache reports the ORIGINAL time, not now — otherwise a
                // cached answer would keep claiming to be fresh.
                state.scannedAt = (d.scan && d.scan.at) || Date.now();
            } else {
                state.error = (d && d.error) || 'empty response';
            }
        } catch (e) {
            state.error = e.message;
        } finally {
            state.loading = false;
            if (btn) { btn.classList.remove('working'); btn.textContent = '[refresh]'; }
            render();
        }
    }

    // Called by pcRailSelect when the section opens. First open measures once —
    // an empty panel answers nothing — and every later open only re-renders, so
    // opening and closing the sidebar never costs a scan.
    //
    // `restoring` is the boot path: the sidebar reopens whatever section was left
    // open in this window, and that is NOT a request to measure. Reloading the PWA
    // must never start a 150 MB scan on its own; it renders the empty state and
    // waits for [refresh]. This is the difference between "on demand" and "on
    // demand, plus every time you press F5".
    function onOpen(opts) {
        if (opts && opts.restoring) { render(); return; }
        if (!state.everOpened) { state.everOpened = true; refresh(); return; }
        render();
    }

    window.Usage = { refresh, onOpen, render, _state: state };
    window.usageRefresh = () => refresh(true);

    // Paint the empty state as soon as the sidebar DOM exists. Without this the
    // section is a literal blank box until something calls in — and a blank box
    // is indistinguishable from a broken panel. render() is a no-op while the
    // element is missing, so this is safe to try before desktop.js builds it.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(render, 0));
    } else {
        setTimeout(render, 0);
    }
})();
