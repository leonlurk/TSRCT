// ─────────────────────────────────────────────────────────────────────────
// studio.js — Generative AI Studio (local ComfyUI control room).
//
// A dual-surface module (desktop tab #pc-studio-body + mobile room .studio-mount,
// the lurk.js pattern). Wraps Leon's local ComfyUI (Flux + Wan 2.2 + LoRAs, 8 GB
// RTX 5060) in a friendly UI: launch/stop ComfyUI, live GPU telemetry, a tailored
// form per mode (still / animate / style / restyle / upscale / custom) with a
// Simple⇄Advanced toggle, LoRA rack, hardware-aware VRAM predictor + presets,
// live progress + preview + output gallery, and an embedded read-only Claude
// advisor that knows this UI and recommends exact field values.
//
// All GPU/ComfyUI work is proxied through the TSRCT server (/api/studio/*), so it
// works identically on desktop and phone. NOTHING generates until the user hits
// Generate. No emojis (text symbols per repo rule).
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const AUTH = () => (typeof token !== 'undefined' ? token : '') || '';
    const jhead = () => ({ 'Content-Type': 'application/json', Authorization: AUTH() });
    const thead = () => ({ Authorization: AUTH() });
    const esc = (s) => (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s);
    const note = (m, t) => { if (typeof toast === 'function') toast(m, t || 'success'); };
    const $ = (id) => document.getElementById(id);

    // ── state ────────────────────────────────────────────────────────────────
    const S = {
        mounted: null,          // container element currently mounted into
        comfy: null,            // last status {running, ...}
        gpu: null,              // last GPU sample
        gpuES: null,            // GPU SSE
        models: null,           // dropdown data
        mode: 'still',          // ui mode
        advanced: false,
        vramMode: 'normal',
        params: {},             // per-mode form values: params[mode] = {...}
        loras: {},              // per-mode lora rack: loras[mode] = [{name,weight}]
        job: null,              // {promptId, step, total, previewURL, running}
        jobES: null,
        outputs: [],            // gallery items
        advisor: { id: null, cwd: window.TSRCT_PROJECTS_ROOT, messages: [], es: null, attach: [], sendSettings: true, busy: false },
        booting: false,
        scene: { base: window.TSRCT_PROJECTS_ROOT + '/scenes', path: null, project: null, projects: [], clips: [], render: null, poll: null, saveT: null, picking: false },
    };

    // ── mode + field specs (single source; the advisor primer references these) ─
    const MODES = [
        { key: 'still', label: 'Still', sub: 'Flux image', backend: 'flux' },
        { key: 'animate', label: 'Animate', sub: 'Wan 2.2 video', backend: 'wan' },
        { key: 'restyle', label: 'Restyle', sub: 'img2img / inpaint', backend: 'flux' },
        { key: 'upscale', label: 'Upscale', sub: '4x model', backend: 'upscale' },
        { key: 'custom', label: 'Custom', sub: 'API-JSON', backend: 'custom' },
        { key: 'scenes', label: 'Scenes', sub: 'video editor', backend: null },
    ];
    const SIZE_PRESETS = [
        { label: '1:1 1024', w: 1024, h: 1024 }, { label: '9:16 TikTok', w: 768, h: 1344 },
        { label: '16:9', w: 1344, h: 768 }, { label: '4:5', w: 896, h: 1152 },
    ];
    const WAN_SIZE_PRESETS = [
        { label: '9:16 480x832', w: 480, h: 832 }, { label: '1:1 704', w: 704, h: 704 }, { label: '16:9 832x480', w: 832, h: 480 },
    ];
    // field: {k,label,type,def,min,max,step,adv,hint,opts}
    function fields(mode) {
        const common = (extra) => [
            { k: 'prompt', label: 'Prompt', type: 'textarea', def: '' },
            { k: 'negative', label: 'Negative', type: 'textarea', def: '' },
            ...extra,
            { k: 'seed', label: 'Seed', type: 'seed', def: 420720 },
        ];
        if (mode === 'still' || mode === 'restyle') {
            const f = common([
                { k: 'size', label: 'Size', type: 'size', def: SIZE_PRESETS[0] },
                { k: 'model', label: 'Quality', type: 'select', def: 'schnell', opts: [['schnell', 'Fast (4 steps)'], ['dev', 'Quality (~20)']], hint: 'schnell = fast for your 8 GB; dev = sharper, slower' },
                { k: 'steps', label: 'Steps', type: 'int', def: 4, min: 1, max: 50, hint: 'schnell: 4. dev: 28-35 for realism (slower)' },
                { k: 'guidance', label: 'Guidance', type: 'float', def: 3.5, min: 0, max: 10, step: 0.1, hint: 'dev only. LOWER = more photographic/real (try ~2). 3.5 default = more "AI" look' },
                { k: 'sampler', label: 'Sampler', type: 'select', def: 'euler', opts: 'samplers', adv: true },
                { k: 'scheduler', label: 'Scheduler', type: 'select', def: 'simple', opts: 'schedulers', adv: true },
                { k: 'unet_override', label: 'Model override', type: 'select', def: '', opts: 'unet', adv: true, hint: 'auto = schnell/dev by Quality; or pick a realism finetune you dropped in models/unet' },
                { k: 'batch', label: 'Batch', type: 'int', def: 1, min: 1, max: 9 },
            ]);
            // Still: optional reference image (Flux Redux) so you can guide the look
            // with a picture in addition to the text prompt — leave empty for pure text.
            if (mode === 'still') f.splice(2, 0,
                { k: 'style_ref', label: 'Reference image (optional)', type: 'image', def: null, hint: 'guides the look via Flux Redux — leave empty for pure text-to-image' },
                { k: 'style_strength', label: 'Reference strength', type: 'float', def: 1.0, min: 0, max: 2, step: 0.05, adv: true });
            if (mode === 'restyle') f.splice(2, 0, { k: 'init', label: 'Source image', type: 'image', def: null },
                { k: 'mask', label: 'Mask (inpaint, optional)', type: 'image', def: null, adv: true, hint: 'white = repaint, black = keep' },
                { k: 'denoise', label: 'Change amount', type: 'float', def: 0.7, min: 0.1, max: 1, step: 0.05, hint: 'higher = more different from source' });
            return f;
        }
        if (mode === 'animate') {
            return common([
                { k: 'image', label: 'Source still', type: 'image', def: null, hint: 'the image Wan will bring to life' },
                { k: 'size', label: 'Size', type: 'size', def: WAN_SIZE_PRESETS[0], presets: WAN_SIZE_PRESETS },
                { k: 'length', label: 'Duration', type: 'select', def: 49, opts: 'duration', hint: 'longer = more time + VRAM. ~2s is the sweet spot on 8 GB' },
                { k: 'steps', label: 'Steps', type: 'int', def: 25, min: 4, max: 40, hint: 'more = smoother/sharper, slower. 25-30 is a good spot' },
                { k: 'fps', label: 'FPS', type: 'int', def: 24, min: 8, max: 30, adv: true },
                { k: 'cfg', label: 'CFG', type: 'float', def: 5.0, min: 1, max: 10, step: 0.5, adv: true, hint: 'how hard it follows the prompt (~5)' },
                { k: 'shift', label: 'Shift', type: 'float', def: 8.0, min: 1, max: 12, step: 0.5, adv: true },
            ]);
        }
        if (mode === 'upscale') {
            return [
                { k: 'image', label: 'Source image', type: 'image', def: null },
                { k: 'model', label: 'Upscale model', type: 'select', def: null, opts: 'upscale' },
            ];
        }
        if (mode === 'custom') {
            return [{ k: 'rawGraph', label: 'ComfyUI API-JSON', type: 'json', def: '' }];
        }
        return [];
    }

    // ── presets (tailored to Leon) ─────────────────────────────────────────────
    const NAVY = 'Album cover art for techno artist leonlurk. Deep navy blue and near-black nocturnal palette, cinematic minimal, a monolithic abstract geometric form emerging from dark fog, faint electric cyan rim light, volumetric haze, high contrast, subtle film grain, moody hypnotic dark-techno aesthetic, no text, no watermark, ultra detailed, 4k';
    const PRESETS = [
        { mode: 'still', label: 'Photo-real', set: { model: 'dev', guidance: 2.0, steps: 30, negative: 'cgi, 3d render, plastic skin, airbrushed, oversaturated, illustration, painting, cartoon, deformed, extra fingers', size: SIZE_PRESETS[0] } },
        { mode: 'still', label: 'Navy cover 1:1', set: { prompt: NAVY, size: SIZE_PRESETS[0], model: 'schnell', steps: 4 } },
        { mode: 'still', label: '9:16 TikTok still', set: { prompt: NAVY, size: SIZE_PRESETS[1], model: 'schnell', steps: 4 } },
        { mode: 'still', label: 'Claymation (clay LoRA)', set: { prompt: NAVY, size: SIZE_PRESETS[0] }, loras: [{ name: 'clay_master.safetensors', weight: 0.9 }] },
        { mode: 'still', label: 'Pili character', set: { prompt: 'pili_char, ' + NAVY, size: SIZE_PRESETS[1] }, loras: [{ name: 'pili_char.safetensors', weight: 0.9 }] },
        { mode: 'animate', label: 'Best 9:16 (~2s)', set: { size: WAN_SIZE_PRESETS[0], length: 49, steps: 30, cfg: 5, shift: 8, fps: 24, prompt: 'cinematic subtle motion, slow gentle camera push-in, soft parallax, smooth, natural movement, no sudden changes' } },
        { mode: 'animate', label: 'Quick test (~1s)', set: { size: WAN_SIZE_PRESETS[0], length: 25, steps: 20, cfg: 5, shift: 8, fps: 24 } },
        { mode: 'animate', label: 'Drop-fuse push-in', set: { prompt: 'cinematic slow push-in through a navy-blue brutalist monolith, drifting volumetric fog, pulsing cyan rim light, hypnotic dark-techno, smooth camera motion, film grain, no text', size: WAN_SIZE_PRESETS[0], length: 49, steps: 30, cfg: 5, shift: 8 } },
    ];

    // ── param helpers ──────────────────────────────────────────────────────────
    function P() { if (!S.params[S.mode]) seedDefaults(S.mode); return S.params[S.mode]; }
    function L() { if (!S.loras[S.mode]) S.loras[S.mode] = []; return S.loras[S.mode]; }
    function seedDefaults(mode) {
        const p = {};
        fields(mode).forEach((f) => { p[f.k] = (f.type === 'size') ? f.def : f.def; });
        S.params[mode] = p;
    }

    // ── network ──────────────────────────────────────────────────────────────
    async function jget(path) { const r = await fetch(path, { headers: thead() }); return r.json(); }
    async function jpost(path, body) { const r = await fetch(path, { method: 'POST', headers: jhead(), body: JSON.stringify(body || {}) }); return r.json(); }

    async function refreshStatus() {
        try { const d = await jget('/api/studio/status'); S.comfy = d.comfy || null; }
        catch { S.comfy = null; }
        renderHeader();
    }
    async function loadModels() {
        try { const d = await jget('/api/studio/models'); if (d.success) { S.models = d.models; renderForm(); } } catch {}
    }

    function startGpuStream() {
        stopGpuStream();
        try {
            const es = new EventSource('/api/studio/gpu/stream?token=' + encodeURIComponent(AUTH()));
            es.onmessage = (e) => { try { S.gpu = JSON.parse(e.data); renderGpu(); } catch {} };
            es.onerror = () => {};
            S.gpuES = es;
        } catch {}
    }
    function stopGpuStream() { if (S.gpuES) { try { S.gpuES.close(); } catch {} S.gpuES = null; } }

    // ── ComfyUI launcher ───────────────────────────────────────────────────────
    async function comfyStart() {
        if (S.booting) return;
        S.booting = true; renderHeader();
        note('Starting ComfyUI…', 'success');
        try {
            const d = await jpost('/api/studio/comfy/start', { vramMode: S.vramMode });
            if (d.timeout) note('ComfyUI slow to start — check again', 'error');
            else note(d.already ? 'ComfyUI already running' : 'ComfyUI started', 'success');
        } catch (e) { note('Start failed: ' + e.message, 'error'); }
        S.booting = false;
        await refreshStatus(); await loadModels();
    }
    async function comfyStop() {
        if (!confirm('Stop ComfyUI? Any running generation on the box will be killed.')) return;
        try { await jpost('/api/studio/comfy/stop', {}); note('ComfyUI stopped', 'success'); } catch (e) { note('Stop failed: ' + e.message, 'error'); }
        await refreshStatus();
    }

    // ── generate ───────────────────────────────────────────────────────────────
    function buildParams() {
        const p = P(), out = {};
        const list = fields(S.mode);
        list.forEach((f) => {
            const v = p[f.k];
            if (f.type === 'size') { out.width = v.w; out.height = v.h; }
            else if (f.k === 'style_ref') out.style_image = v || undefined;
            else if (f.k === 'init') out.init_image = v || undefined;
            else if (f.k === 'mask') out.mask_image = v || undefined;
            else if (f.k === 'unet_override') { if (v) out.unet = v; }   // explicit checkpoint override
            else if (f.type === 'json') out.rawGraph = safeJson(v);
            else if (v !== undefined && v !== null && v !== '') out[f.k] = v;
        });
        const loras = L().filter((x) => x.name);
        if (loras.length) out.loras = loras;
        if (S.mode === 'style' && out.model !== 'dev') out.model = out.model || 'schnell';
        return out;
    }
    function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

    async function generate() {
        const mdef = MODES.find((m) => m.key === S.mode);
        if (!S.comfy || !S.comfy.running) { await comfyStart(); if (!S.comfy || !S.comfy.running) return; }
        let params;
        try { params = buildParams(); } catch (e) { return note(e.message, 'error'); }
        // stage any image params that are absolute paths (upload/browse) into ComfyUI/input
        try { await stageImages(params); } catch (e) { return note('Image staging failed: ' + e.message, 'error'); }
        note('Queuing…', 'success');
        try {
            const d = await jpost('/api/studio/generate', { mode: mdef.backend, params });
            if (!d.success) throw new Error(d.error + (d.detail ? ' — check the graph' : ''));
            S.job = { promptId: d.promptId, step: 0, total: 0, previewURL: null, running: true, mode: S.mode };
            renderRun();
            streamProgress(d.promptId);   // live step/preview (best-effort, needs ws)
            startJobWatch();              // reliable completion + elapsed timer
        } catch (e) { note('Generate failed: ' + e.message, 'error'); }
    }

    // image params may be absolute paths (from upload/omni/gallery) → stage to input/, replace with basename
    async function stageImages(params) {
        for (const key of ['image', 'style_image', 'init_image', 'mask_image']) {
            const v = params[key];
            if (v && v.startsWith('/')) {
                const d = await jpost('/api/studio/stage', { path: v });
                if (!d.success) throw new Error(d.error || 'stage failed');
                params[key] = d.name;
            }
        }
    }

    function streamProgress(promptId) {
        stopJobStream();
        const es = new EventSource('/api/studio/progress/' + encodeURIComponent(promptId) + '?token=' + encodeURIComponent(AUTH()));
        es.onmessage = (e) => {
            let d; try { d = JSON.parse(e.data); } catch { return; }
            if (!S.job) return;
            if (d.kind === 'progress') { S.job.step = d.value; S.job.total = d.max; renderRun(); }
            else if (d.kind === 'preview') { S.job.previewURL = d.dataURL; renderRun(); }
            else if (d.kind === 'executing') { renderRun(); }
            else if (d.kind === 'error') { note('Generation error: ' + d.error, 'error'); S.job.running = false; renderRun(); stopJobStream(); stopJobWatch(); }
            else if (d.kind === 'done') {
                S.job.running = false; S.job.outputs = d.outputs || []; renderRun();
                note('Done — ' + (d.outputs ? d.outputs.length : 0) + ' output(s)', 'success');
                stopJobStream(); stopJobWatch(); loadOutputs();
            }
        };
        es.onerror = () => {};
        S.jobES = es;
    }
    function stopJobStream() { if (S.jobES) { try { S.jobES.close(); } catch {} S.jobES = null; } }

    // Completion fallback: poll /result while a job runs so the result ALWAYS
    // renders without a manual refresh, even if the live progress SSE fails.
    // Also drives an elapsed-time counter so the panel never looks frozen.
    let jobPoll = null, jobT0 = 0;
    function startJobWatch() {
        stopJobWatch(); jobT0 = Date.now();
        jobPoll = setInterval(async () => {
            if (!S.job || !S.job.running) { stopJobWatch(); return; }
            S.job.elapsed = Math.round((Date.now() - jobT0) / 1000);
            renderRun();
            try {
                const d = await jget('/api/studio/result?promptId=' + encodeURIComponent(S.job.promptId));
                if (S.job && S.job.running && d.done && d.outputs && d.outputs.length) {
                    S.job.running = false; S.job.outputs = d.outputs; renderRun();
                    note('Done — ' + d.outputs.length + ' output(s)', 'success');
                    stopJobWatch(); stopJobStream(); loadOutputs();
                }
            } catch {}
        }, 2000);
    }
    function stopJobWatch() { if (jobPoll) { clearInterval(jobPoll); jobPoll = null; } }
    async function cancelJob() {
        try { await jpost('/api/studio/interrupt', {}); note('Interrupted', 'success'); } catch {}
        if (S.job) { S.job.running = false; renderRun(); }
        stopJobStream(); stopJobWatch();
    }

    async function loadOutputs() {
        try { const d = await jget('/api/studio/outputs?limit=12'); if (d.success) { S.outputs = d.outputs; renderGallery(); } } catch {}
    }
    // fetch an output (auth header) and turn into a blob URL for <img>/<video>
    async function blobFor(item) {
        const url = item.url || ('/api/studio/view?filename=' + encodeURIComponent(item.filename) + '&subfolder=' + encodeURIComponent(item.subfolder || '') + '&type=' + encodeURIComponent(item.type || 'output'));
        const r = await fetch(url, { headers: thead() });
        if (!r.ok) throw new Error('missing');   // deleted/unavailable → skip the cell
        const b = await r.blob();
        return URL.createObjectURL(b);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RENDER
    // ═══════════════════════════════════════════════════════════════════════════
    function shell() {
        const body = S.mode === 'scenes'
            ? `<div class="studio-scene" id="studio-scene"></div>`
            : `<div class="studio-body">
                 <div class="studio-pane studio-pane-form" id="studio-form"></div>
                 <div class="studio-pane studio-pane-out">
                   <div class="studio-run" id="studio-run"></div>
                   <div class="studio-gallery" id="studio-gallery"></div>
                 </div>
                 <div class="studio-pane studio-pane-adv" id="studio-advisor"></div>
               </div>`;
        return `
        <div class="studio">
          <div class="studio-topbar" id="studio-header"></div>
          <div class="studio-modes" id="studio-modes"></div>
          ${body}
        </div>`;
    }

    function renderAll() {
        const el = S.mounted; if (!el) return;
        el.innerHTML = shell();
        renderHeader(); renderGpu(); renderModes();
        if (S.mode === 'scenes') { sceneEnter(); return; }
        renderForm(); renderRun(); renderGallery(); renderAdvisor();
    }

    function renderHeader() {
        const el = $('studio-header'); if (!el) return;
        const c = S.comfy || {};
        const running = !!c.running, booting = S.booting || c.starting;
        const pill = booting ? '<span class="st-pill warm">warming up…</span>'
            : running ? `<span class="st-pill on">● RUNNING :${c.port || 8188}</span>`
            : '<span class="st-pill off">○ STOPPED</span>';
        const btn = running
            ? `<button class="st-btn danger" onclick="studioComfyStop()">Stop</button>`
            : `<button class="st-btn primary" onclick="studioComfyStart()" ${booting ? 'disabled' : ''}>Start</button>`;
        const ver = c.version ? `<span class="st-dim">v${esc(c.version)} · torch ${esc(c.torch || '')}</span>` : '';
        el.innerHTML = `
          <div class="st-hrow">
            <div class="st-hleft">${pill} ${btn}
              <select class="st-vram" onchange="studioSetVram(this.value)" title="VRAM mode on launch">
                ${[['normal', 'Normal VRAM'], ['high', 'High VRAM'], ['low', 'Low VRAM']].map(([v, l]) => `<option value="${v}" ${S.vramMode === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
              ${ver}
            </div>
            <div class="st-gpu" id="studio-gpu"></div>
          </div>`;
        renderGpu();
    }

    function bar(label, val, max, unit, warnPct) {
        const pct = (val != null && max) ? Math.min(100, Math.round((val / max) * 100)) : 0;
        const lvl = pct >= (warnPct || 90) ? 'red' : pct >= (warnPct ? warnPct - 15 : 75) ? 'amber' : 'green';
        return `<div class="st-gauge"><div class="st-gl">${label}</div>
          <div class="st-gbar"><div class="st-gfill ${lvl}" style="width:${pct}%"></div></div>
          <div class="st-gv">${val == null ? '–' : val}${unit || ''}${max ? '/' + max : ''}</div></div>`;
    }
    function renderGpu() {
        const el = $('studio-gpu'); if (!el) return;
        const g = S.gpu;
        if (!g || !g.available) { el.innerHTML = '<span class="st-dim">GPU: n/a</span>'; return; }
        el.innerHTML =
            bar('VRAM', g.memUsed, g.memTotal, '', 92) +
            `<div class="st-gauge"><div class="st-gl">GPU</div><div class="st-gbar"><div class="st-gfill ${g.util >= 90 ? 'red' : g.util >= 60 ? 'amber' : 'green'}" style="width:${g.util || 0}%"></div></div><div class="st-gv">${g.util == null ? '–' : g.util}%</div></div>` +
            `<div class="st-gstat">${g.temp == null ? '–' : g.temp}°C</div>` +
            `<div class="st-gstat">${g.power == null ? '–' : g.power.toFixed ? g.power.toFixed(0) : g.power}W</div>`;
    }

    function renderModes() {
        const el = $('studio-modes'); if (!el) return;
        el.innerHTML = MODES.map((m) =>
            `<button class="st-mode ${S.mode === m.key ? 'active' : ''}" onclick="studioSetMode('${m.key}')">
              <span class="st-mode-l">${esc(m.label)}</span><span class="st-mode-s">${esc(m.sub)}</span></button>`).join('');
    }

    function optList(spec) {
        if (Array.isArray(spec.opts)) return spec.opts;
        if (spec.opts === 'samplers') return (S.models && S.models.samplers || ['euler']).map((x) => [x, x]);
        if (spec.opts === 'schedulers') return (S.models && S.models.schedulers || ['simple']).map((x) => [x, x]);
        if (spec.opts === 'upscale') return (S.models && S.models.upscale || []).map((x) => [x, x]);
        if (spec.opts === 'duration') return [[25, '~1s (25f)'], [49, '~2s (49f)'], [73, '~3s (73f)'], [97, '~4s (97f)']];
        if (spec.opts === 'unet') {
            const pretty = (f) => /schnell/i.test(f) ? 'schnell (fast)' : /flux1-dev/i.test(f) ? 'dev (quality)' : f.replace(/\.(gguf|safetensors)$/i, '');
            const files = (S.models && S.models.unet || []).filter((f) => !/wan/i.test(f));
            return [['', 'auto (by Quality)'], ...files.map((f) => [f, pretty(f)])];
        }
        return [];
    }

    function fieldHTML(f) {
        const p = P(); const v = p[f.k];
        const advCls = f.adv ? 'adv' : '';
        const hint = f.hint ? `<div class="st-hint">${esc(f.hint)}</div>` : '';
        let inner = '';
        if (f.type === 'textarea') inner = `<textarea class="st-in" rows="${f.k === 'prompt' ? 3 : 2}" oninput="studioSet('${f.k}',this.value)" placeholder="${f.k === 'negative' ? 'things to avoid' : 'describe what you want…'}">${esc(v || '')}</textarea>`;
        else if (f.type === 'json') inner = `<textarea class="st-in mono" rows="8" oninput="studioSet('${f.k}',this.value)" placeholder='{"1":{"class_type":"...","inputs":{...}}}'>${esc(v || '')}</textarea>`;
        else if (f.type === 'int' || f.type === 'float') inner = `<input class="st-in" type="number" value="${esc(v)}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} step="${f.step || (f.type === 'int' ? 1 : 0.1)}" oninput="studioSet('${f.k}',${f.type === 'int' ? 'parseInt(this.value)' : 'parseFloat(this.value)'})">`;
        else if (f.type === 'select') {
            const opts = optList(f);
            inner = `<select class="st-in" onchange="studioSet('${f.k}',this.value)">${opts.map(([val, lab]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
        } else if (f.type === 'seed') {
            inner = `<div class="st-seedrow"><input class="st-in" type="number" value="${esc(v)}" oninput="studioSet('${f.k}',parseInt(this.value))">
              <button class="st-mini" title="Randomize" onclick="studioRandSeed()">rand</button></div>`;
        } else if (f.type === 'size') {
            const presets = f.presets || SIZE_PRESETS;
            inner = `<div class="st-sizes">${presets.map((s) => `<button class="st-chip ${v && v.w === s.w && v.h === s.h ? 'active' : ''}" onclick="studioSetSize(${s.w},${s.h})">${esc(s.label)}</button>`).join('')}
              <span class="st-sizewh">${v ? v.w + '×' + v.h : ''}</span>
              <button class="st-mini" onclick="studioCustomSize()">custom</button></div>`;
        } else if (f.type === 'image') {
            inner = `<div class="st-imgrow">
              <button class="st-mini" onclick="studioPickImage('${f.k}')">choose</button>
              <button class="st-mini" onclick="studioUploadImage('${f.k}')">upload</button>
              <span class="st-imgname">${v ? esc(String(v).split('/').pop()) : '(none)'}</span>
              ${v ? `<button class="st-mini" onclick="studioClearImage('${f.k}')">clear</button>` : ''}</div>`;
        }
        return `<div class="st-field ${advCls}"><label class="st-lab">${esc(f.label)}</label>${inner}${hint}</div>`;
    }

    function loraRackHTML() {
        if (!['still', 'style', 'restyle', 'animate'].includes(S.mode)) return '';
        const avail = (S.models && S.models.loras) || [];
        const rack = L();
        return `<div class="st-field"><label class="st-lab">LoRAs <span class="st-dim">(stack + weight)</span></label>
          <div class="st-loras">
            ${rack.map((l, i) => `<div class="st-lora">
              <select class="st-in" onchange="studioLoraName(${i},this.value)">
                <option value="">— select —</option>
                ${avail.map((n) => `<option value="${esc(n)}" ${l.name === n ? 'selected' : ''}>${esc(n.replace('.safetensors', ''))}</option>`).join('')}
              </select>
              <input class="st-lw" type="number" min="0" max="2" step="0.05" value="${esc(l.weight)}" oninput="studioLoraWeight(${i},parseFloat(this.value))" title="weight">
              <button class="st-mini" onclick="studioLoraRemove(${i})">×</button></div>`).join('')}
            <button class="st-mini add" onclick="studioLoraAdd()">+ add LoRA</button>
          </div></div>`;
    }

    // Not a hard VRAM wall: ComfyUI offloads the GGUF model to RAM, so higher
    // resolution/length mostly costs SPEED, not a crash. This is a speed + "Flux
    // sweet spot" guide, phrased so it never falsely reads as "will fail".
    function predictVram() {
        const p = P();
        if (S.mode === 'upscale' || S.mode === 'custom') return '';
        if (S.mode === 'animate') {
            const sz = p.size || WAN_SIZE_PRESETS[0];
            const load = ((sz.w * sz.h) / (480 * 832)) * ((p.length || 49) / 49);
            const lvl = load <= 1.3 ? 'safe' : load <= 2.4 ? 'tight' : 'risky';
            const label = lvl === 'safe' ? 'GOOD' : lvl === 'tight' ? 'OK' : 'HEAVY';
            const msg = lvl === 'safe' ? 'comfortable on your 8 GB'
                : lvl === 'tight' ? 'works — offloads to RAM, a bit slower' : 'heavy — much slower; keep the clip short';
            return `<div class="st-vram-pred ${lvl}">Wan load ${load.toFixed(1)}× · <b>${label}</b> <span class="st-dim">(${msg})</span></div>`;
        }
        // Flux still/restyle
        const sz = p.size || SIZE_PRESETS[0];
        const mp = (sz.w * sz.h) / (1024 * 1024);
        const lvl = mp <= 1.6 ? 'safe' : mp <= 3.2 ? 'tight' : 'risky';
        const label = lvl === 'safe' ? 'GOOD' : lvl === 'tight' ? 'OK' : 'BIG';
        const msg = lvl === 'safe' ? "Flux's sweet spot — fast on your 8 GB"
            : lvl === 'tight' ? 'works (offloads, a bit slower). For more detail, Upscale instead of going bigger'
            : 'big for Flux — slower and often not sharper; generate ~1024-1216 then Upscale';
        return `<div class="st-vram-pred ${lvl}">${mp.toFixed(1)} MP · <b>${label}</b> <span class="st-dim">(${msg})</span></div>`;
    }

    function presetsHTML() {
        const ps = PRESETS.filter((p) => p.mode === S.mode);
        if (!ps.length) return '';
        return `<div class="st-presets">${ps.map((p, i) => `<button class="st-chip preset" onclick="studioApplyPreset('${S.mode}',${i})">${esc(p.label)}</button>`).join('')}</div>`;
    }

    function renderForm() {
        const el = $('studio-form'); if (!el) return;
        const list = fields(S.mode);
        const simple = list.filter((f) => !f.adv);
        const adv = list.filter((f) => f.adv);
        el.innerHTML = `
          <div class="st-form-head">
            <div class="st-form-title">${esc(MODES.find((m) => m.key === S.mode).label)} <span class="st-dim">${esc(MODES.find((m) => m.key === S.mode).sub)}</span></div>
            <label class="st-adv-toggle"><input type="checkbox" ${S.advanced ? 'checked' : ''} onchange="studioToggleAdv(this.checked)"> Advanced</label>
          </div>
          ${presetsHTML()}
          ${simple.map(fieldHTML).join('')}
          ${loraRackHTML()}
          ${S.advanced ? `<div class="st-adv-block">${adv.map(fieldHTML).join('')}</div>` : (adv.length ? `<div class="st-dim st-advhint">+${adv.length} advanced settings (toggle Advanced)</div>` : '')}
          ${S.mode !== 'custom' && S.mode !== 'upscale' ? predictVram() : ''}
          <button class="st-generate" onclick="studioGenerate()">${S.mode === 'animate' ? 'Animate' : S.mode === 'upscale' ? 'Upscale' : 'Generate'}</button>`;
    }

    function renderRun() {
        const el = $('studio-run'); if (!el) return;
        const j = S.job;
        if (!j) { el.innerHTML = `<div class="st-run-idle st-dim">Run panel — progress + preview appear here.</div>`; return; }
        const pct = j.total ? Math.round((j.step / j.total) * 100) : (j.running ? 0 : 100);
        el.innerHTML = `
          <div class="st-run-head"><span>${j.running ? 'Generating…' : 'Finished'}</span>
            ${j.running ? `<button class="st-mini danger" onclick="studioCancel()">Cancel</button>` : ''}</div>
          <div class="st-progress"><div class="st-progress-fill" style="width:${pct}%"></div></div>
          <div class="st-run-meta st-dim">${j.total ? `step ${j.step}/${j.total}` : (j.running ? ((j.reattached ? 'reconnected' : 'working') + (j.elapsed ? ` · ${j.elapsed}s` : '…')) : 'done')} ${pct ? '· ' + pct + '%' : ''}</div>
          ${j.previewURL ? `<img class="st-preview" src="${j.previewURL}" alt="preview">` : ''}
          <div class="st-run-outputs" id="studio-run-outputs"></div>`;
        if (!j.running && j.outputs && j.outputs.length) renderJobOutputs(j.outputs);
    }
    async function renderJobOutputs(outs) {
        const el = $('studio-run-outputs'); if (!el) return;
        el.innerHTML = outs.map((_, i) => `<div class="st-out-thumb" id="st-jobout-${i}"></div>`).join('');
        for (let i = 0; i < outs.length; i++) {
            const cell = $('st-jobout-' + i); if (!cell) continue;
            try {
                const url = await blobFor(outs[i]);
                cell.innerHTML = mediaHTML(outs[i], url, 'autoplay') + outActions(outs[i]);
            } catch { cell.style.display = 'none'; }
        }
    }
    function outActions(item) {
        // pass filename + subfolder (server resolves within ComfyUI/output) — the
        // output dir is outside PROJECTS, so absolute-path ops would be rejected.
        // stopPropagation so a button tap doesn't also open the lightbox.
        const fn = encodeURIComponent(item.filename), sub = encodeURIComponent(item.subfolder || '');
        const S0 = 'event.stopPropagation();';
        const b = [];
        if (!item.isVideo) {
            b.push(`<button onclick="${S0}studioOutAnimate('${fn}','${sub}')">animate</button>`);
            b.push(`<button onclick="${S0}studioOutUpscale('${fn}','${sub}')">upscale</button>`);
        }
        b.push(`<button onclick="${S0}studioOutOpen('${fn}','${sub}')">open</button>`);
        b.push(`<button onclick="${S0}studioOutReveal('${fn}','${sub}')" title="reveal in Explorer">folder</button>`);
        b.push(`<button onclick="${S0}studioOutDelete('${fn}','${sub}')" title="delete">del</button>`);
        return `<div class="st-out-acts">${b.join('')}</div>`;
    }
    // media (img/video) markup with a click → lightbox
    function mediaHTML(item, url, opts) {
        const fn = encodeURIComponent(item.filename), sub = encodeURIComponent(item.subfolder || '');
        const click = `onclick="studioLightbox('${fn}','${sub}',${item.isVideo ? 'true' : 'false'})"`;
        return item.isVideo
            ? `<video src="${url}" loop muted playsinline ${opts || ''} ${click}></video>`
            : `<img src="${url}" ${click}>`;
    }

    async function renderGallery() {
        const el = $('studio-gallery'); if (!el) return;
        if (!S.outputs.length) { el.innerHTML = `<div class="st-gal-head st-dim">Recent outputs</div><div class="st-dim st-gal-empty">none yet — generate something.</div>`; return; }
        el.innerHTML = `<div class="st-gal-head">Recent outputs <button class="st-mini" onclick="studioRefreshOutputs()">refresh</button></div>
          <div class="st-gal-grid">${S.outputs.map((_, i) => `<div class="st-gal-cell" id="st-gal-${i}"></div>`).join('')}</div>`;
        for (let i = 0; i < S.outputs.length; i++) {
            const cell = $('st-gal-' + i); if (!cell) continue;
            try {
                const url = await blobFor(S.outputs[i]);
                cell.innerHTML = mediaHTML(S.outputs[i], url) + outActions(S.outputs[i]);
            } catch { cell.style.display = 'none'; }   // file gone → drop the cell, no broken icon
        }
    }

    // ── advisor ────────────────────────────────────────────────────────────────
    function advisorPrimer() {
        return [
            'You advise leonlurk on settings for his LOCAL ComfyUI (Flux + Wan 2.2, 8 GB RTX 5060, GGUF) inside the TSRCT Studio UI. You NEVER run tools or generate — you only tell him what to enter.',
            '',
            'OUTPUT RULES — STRICT:',
            '- Reply with ONLY a bullet list of "Field: value" for the fields to set. Nothing else.',
            '- NO intro, NO summary, NO explanations, NO rationale, NO multi-pass plans, NO notes, NO closing line. Just the bullets.',
            '- Only list fields that need a non-default value. Keep it as short as possible.',
            '- Use the EXACT field names/values from the UI below.',
            '- Only explain if he explicitly says "why" or "explain".',
            '',
            'UI — pick one Mode: Still, Animate, Restyle, Upscale, Custom.',
            'Still/Restyle fields: Prompt · Negative · Size (1:1 1024 / 9:16 TikTok / 16:9 / 4:5 / custom) · Quality (Fast=schnell 4-step / Quality=dev ~20-step) · Steps · Guidance (dev only) · Sampler · Scheduler · Batch · Seed · LoRAs (each has a weight). Still also: an optional Reference image (guides the look via Redux) + Reference strength. Restyle also: Source image + Mask (optional) + Change amount.',
            'Animate fields: Source still · Prompt · Negative · Size (9:16 480x832 / 1:1 704 / 16:9 832x480) · Frames (4n+1) · FPS · Steps · CFG · Shift · Seed · LoRAs.',
            'Upscale: Source image + Upscale model. Custom: raw ComfyUI API-JSON.',
            'His LoRAs: clay_master, clay_xc (claymation), pili_char (character). His look: deep navy + near-black, cyan rim light, cinematic, film grain, no text. Keep size/steps within 8 GB.',
            'For PHOTOREALISM: Quality=dev, Guidance ~1.8-2.5 (low=real), Steps 28-35, add a realism LoRA/finetune if present, prompt for imperfection (amateur photo, phone, film grain, skin texture), drop "cinematic/4k/masterpiece"; Negative: cgi, plastic skin, airbrushed, illustration.',
            '',
            'EXACT format to always follow:',
            '- Mode: Still',
            '- Prompt: <text>',
            '- Quality: dev',
            '- Steps: 24',
            '- Size: 9:16 TikTok',
            '- Seed: rand',
        ].join('\n');
    }
    async function advisorStart() {
        if (S.advisor.busy) return;
        S.advisor.busy = true; renderAdvisor();
        try {
            // Recreate any existing session so the CURRENT primer/cwd apply (an
            // existing session keeps its original primer — /api/hf/start returns it as-is).
            try { await jpost('/api/hf/stop/studio-advisor', {}); } catch {}
            S.advisor.messages = [];
            const d = await jpost('/api/hf/start', {
                cwd: S.advisor.cwd,
                name: 'studio-advisor',
                systemPrompt: advisorPrimer(),
                allowedTools: 'Read Grep Glob WebSearch WebFetch',
            });
            if (d.error) throw new Error(d.error);
            S.advisor.id = (d.session && d.session.id) || 'studio-advisor';
            advisorConnectSSE();
            note('Advisor ready in ' + S.advisor.cwd, 'success');
        } catch (e) { note('Advisor start failed: ' + e.message, 'error'); }
        S.advisor.busy = false; renderAdvisor();
    }
    function advisorConnectSSE() {
        if (S.advisor.es) { try { S.advisor.es.close(); } catch {} }
        const es = new EventSource('/api/hf/output/' + encodeURIComponent(S.advisor.id) + '?token=' + encodeURIComponent(AUTH()));
        let streaming = '';
        es.onmessage = (e) => {
            let d; try { d = JSON.parse(e.data); } catch { return; }
            if (d.type === 'assistant_delta') { streaming += d.text || ''; setAdvisorStreaming(streaming); }
            else if (d.type === 'assistant_done' || d.type === 'assistant') {
                const txt = (d.message || streaming || '').trim();
                if (txt) S.advisor.messages.push({ role: 'assistant', text: txt });
                streaming = ''; S.advisor.busy = false; renderAdvisor();
            } else if (d.type === 'state' && d.state === 'processing') { S.advisor.busy = true; }
        };
        es.onerror = () => {};
        S.advisor.es = es;
    }
    function setAdvisorStreaming(txt) {
        const el = $('studio-adv-stream'); if (el) { el.textContent = txt; el.scrollIntoView({ block: 'nearest' }); }
        else renderAdvisor();
    }
    async function advisorSend() {
        const inp = $('studio-adv-input'); if (!inp) return;
        let text = inp.value.trim();
        if (!text && !S.advisor.attach.length) return;
        if (!S.advisor.id) { await advisorStart(); if (!S.advisor.id) return; }
        // attachment prefix (studio-scoped buffer, mirrors buildAttachmentPrefix)
        let prefix = '';
        if (S.advisor.attach.length) prefix += '[Images attached: ' + S.advisor.attach.join(', ') + '] ';
        // current settings context
        if (S.advisor.sendSettings) prefix += settingsSnapshot();
        const full = (prefix + text).trim();
        S.advisor.messages.push({ role: 'user', text: text || '(attached image)' });
        S.advisor.attach = []; inp.value = ''; S.advisor.busy = true; renderAdvisor();
        try { await jpost('/api/hf/send', { id: S.advisor.id, message: full }); } catch (e) { note('Send failed: ' + e.message, 'error'); S.advisor.busy = false; renderAdvisor(); }
    }
    function settingsSnapshot() {
        const p = P(); const parts = [`[My current Studio state → Mode: ${S.mode}`];
        fields(S.mode).forEach((f) => {
            const v = p[f.k]; if (v == null || v === '') return;
            if (f.type === 'size') parts.push(`Size: ${v.w}x${v.h}`);
            else if (f.type === 'image') parts.push(`${f.label}: ${v ? 'set' : 'none'}`);
            else if (f.k === 'prompt') parts.push(`Prompt: "${String(v).slice(0, 120)}"`);
            else parts.push(`${f.label}: ${v}`);
        });
        const lr = L().filter((x) => x.name); if (lr.length) parts.push('LoRAs: ' + lr.map((x) => x.name.replace('.safetensors', '') + '@' + x.weight).join(', '));
        return parts.join(' · ') + ']\n';
    }

    function renderAdvisor() {
        const el = $('studio-advisor'); if (!el) return;
        if (!S.advisor.id && !S.advisor.busy) {
            el.className = 'studio-pane studio-pane-adv studio-advisor';
            el.innerHTML = `<div class="st-adv-head"><span>Ask Claude — settings advisor</span></div>
              <div class="st-adv-start">
                <div class="st-dim">Opens a read-only Claude in a folder, primed with this UI + your 8 GB hardware. It recommends exact settings — it never runs the tools.</div>
                <div class="st-adv-cwd"><label>Folder</label><input class="st-in" id="studio-adv-cwd" value="${esc(S.advisor.cwd)}" oninput="studioAdvCwd(this.value)"></div>
                <button class="st-btn primary" onclick="studioAdvisorStart()">Start advisor</button>
              </div>`;
            return;
        }
        el.className = 'studio-pane studio-pane-adv studio-advisor open';
        const msgs = S.advisor.messages.map((m) =>
            `<div class="st-msg ${m.role}"><div class="st-msg-body">${esc(m.text).replace(/\n/g, '<br>')}</div></div>`).join('');
        el.innerHTML = `
          <div class="st-adv-head"><span>Ask Claude ${S.advisor.busy ? '· thinking…' : ''}</span>
            <label class="st-adv-ctx"><input type="checkbox" ${S.advisor.sendSettings ? 'checked' : ''} onchange="studioAdvSettings(this.checked)"> send my settings</label></div>
          <div class="st-adv-msgs" id="studio-adv-msgs">${msgs}${S.advisor.busy ? '<div class="st-msg assistant"><div class="st-msg-body" id="studio-adv-stream"></div></div>' : ''}</div>
          ${S.advisor.attach.length ? `<div class="st-adv-attach">${S.advisor.attach.map((a, i) => `<span class="st-chip">${esc(a.split('/').pop())} <b onclick="studioAdvUnattach(${i})">×</b></span>`).join('')}</div>` : ''}
          <div class="st-adv-inrow">
            <button class="st-mini" onclick="studioAdvAttach()" title="attach image">+img</button>
            <textarea class="st-in" id="studio-adv-input" rows="2" placeholder="tell it what you want to create…" onkeydown="if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();studioAdvisorSend();}"></textarea>
            <button class="st-btn primary" onclick="studioAdvisorSend()">Send</button>
          </div>`;
        const mEl = $('studio-adv-msgs'); if (mEl) mEl.scrollTop = mEl.scrollHeight;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENES — project-based video editor (mode 'scenes')
    // ═══════════════════════════════════════════════════════════════════════════
    const SC = () => S.scene;
    const scProj = () => S.scene.project;

    function sceneEnter() {
        if (!S.models) loadModels();   // populate the character-LoRA dropdown (dir read, works with ComfyUI off)
        sceneLoadProjects();
        sceneLoadClips();
        renderScene();
    }
    async function sceneLoadProjects() {
        try { const d = await jget('/api/studio/scene/projects?base=' + encodeURIComponent(SC().base)); if (d.success) { SC().projects = d.projects; renderScene(); } } catch {}
    }
    async function sceneLoadClips() {
        try { const d = await jget('/api/studio/scene/clips' + (SC().path ? '?project=' + encodeURIComponent(SC().path) : '')); if (d.success) { SC().clips = d.clips; renderScene(); } } catch {}
    }
    function scheduleSave() { clearTimeout(SC().saveT); SC().saveT = setTimeout(sceneSaveNow, 700); }
    async function sceneSaveNow() {
        if (!SC().path || !scProj()) return;
        try { await jpost('/api/studio/scene/project/save', { path: SC().path, project: scProj() }); } catch {}
    }
    async function sceneNew() {
        const name = prompt('New project name:'); if (!name) return;
        try {
            const d = await jpost('/api/studio/scene/project', { base: SC().base, name });
            if (!d.success) throw new Error(d.error || 'create failed');
            SC().path = d.path; SC().project = d.project; note('Project created', 'success');
            sceneLoadProjects(); sceneLoadClips(); renderScene();
        } catch (e) { note(e.message, 'error'); }
    }
    async function sceneOpen(path) {
        try {
            const d = await jget('/api/studio/scene/project?path=' + encodeURIComponent(path));
            if (!d.success) throw new Error(d.error || 'open failed');
            SC().path = path; SC().project = d.project; SC().render = null;
            sceneLoadClips(); renderScene();
        } catch (e) { note(e.message, 'error'); }
    }
    function sceneClose() { SC().path = null; SC().project = null; SC().render = null; sceneLoadProjects(); renderScene(); }
    function sceneSetBase(v) { SC().base = String(v || '').trim() || SC().base; sceneLoadProjects(); }
    async function sceneDelete(path) {
        if (!confirm('Delete this project and its exports?')) return;
        try { await jpost('/api/studio/scene/project/delete', { path }); note('Deleted', 'success'); if (SC().path === path) sceneClose(); else sceneLoadProjects(); }
        catch (e) { note(e.message, 'error'); }
    }
    // timeline mutations
    function mut(fn) { const p = scProj(); if (!p) return; fn(p); scheduleSave(); renderScene(); }
    function sceneAddShot(clip) { mut((p) => p.shots.push({ clip, transition: p.shots.length ? 'crossfade' : 'cut', fadeDur: 0.35, in: 0, out: null })); }
    function sceneRemoveShot(i) { mut((p) => p.shots.splice(i, 1)); }
    function sceneMoveShot(i, dir) { mut((p) => { const j = i + dir; if (j < 0 || j >= p.shots.length) return; const t = p.shots[i]; p.shots[i] = p.shots[j]; p.shots[j] = t; }); }
    function sceneShotSet(i, k, v) { const p = scProj(); if (!p || !p.shots[i]) return; p.shots[i][k] = v; scheduleSave(); if (k === 'transition') renderScene(); }
    function sceneAudioSet(k, v) { mut((p) => { p.audio = p.audio || {}; p.audio[k] = v; }); }
    function sceneAudioPick() { const path = prompt('Audio file path:', (scProj().audio && scProj().audio.path) || window.TSRCT_PROJECTS_ROOT + '/'); if (path == null) return; mut((p) => { p.audio = { path: path.trim(), offset: (p.audio && p.audio.offset) || 0 }; }); }
    function sceneAudioClear() { mut((p) => { p.audio = null; }); }
    function sceneAddTitle() { mut((p) => p.titles.push({ text: 'TEXT', start: 0, end: 2, y: 'h*0.82' })); }
    function sceneTitleSet(i, k, v) { const p = scProj(); if (!p || !p.titles[i]) return; p.titles[i][k] = v; scheduleSave(); }
    function sceneRemoveTitle(i) { mut((p) => p.titles.splice(i, 1)); }
    function sceneCharSet(k, v) { mut((p) => { p.character = p.character || {}; p.character[k] = v; }); }
    function sceneOutSet(k, v) { mut((p) => { p.out = p.out || {}; p.out[k] = v; }); }
    // Bridge: jump to Still with the project's character LoRA pre-loaded (locked identity).
    function sceneClipForChar() {
        const lora = scProj() && scProj().character && scProj().character.lora;
        S.mode = 'still'; if (!S.params.still) seedDefaults('still');
        if (lora) S.loras.still = [{ name: lora, weight: 0.9 }];
        renderModes(); renderAll();
        note(lora ? 'Still ready with ' + lora.replace('.safetensors', '') : 'Switched to Still — pin a character LoRA first', lora ? 'success' : 'error');
    }
    async function sceneRender() {
        if (!scProj() || !scProj().shots.length) return note('Add clips to the timeline first', 'error');
        await sceneSaveNow();
        try {
            const d = await jpost('/api/studio/scene/render', { path: SC().path });
            if (!d.success) throw new Error(d.error || 'render failed');
            SC().render = { job: d.job, status: 'running', step: 'starting', pct: 0 };
            renderScene();
            scenePoll();
        } catch (e) { note(e.message, 'error'); }
    }
    function scenePoll() {
        clearInterval(SC().poll);
        SC().poll = setInterval(async () => {
            if (!SC().render || !SC().render.job) { clearInterval(SC().poll); return; }
            try {
                const d = await jget('/api/studio/scene/render/status?job=' + encodeURIComponent(SC().render.job));
                const st = d.status; if (!st) return;
                SC().render = { ...SC().render, ...st };
                if (st.status === 'done') { clearInterval(SC().poll); note('Render done', 'success'); sceneReloadProject(); }
                else if (st.status === 'error') { clearInterval(SC().poll); note('Render failed: ' + st.error, 'error'); }
                renderScene();
            } catch {}
        }, 1500);
    }
    async function sceneReloadProject() { if (SC().path) { try { const d = await jget('/api/studio/scene/project?path=' + encodeURIComponent(SC().path)); if (d.success) SC().project = d.project; } catch {} } renderScene(); }

    // fetch a scene file (thumb/export) with auth → blob URL, set on an element
    async function sceneBlob(url, elId, tag) {
        try {
            const r = await fetch(url, { headers: thead() }); if (!r.ok) return;
            const u = URL.createObjectURL(await r.blob());
            const el = $(elId); if (el) el.innerHTML = tag === 'video' ? `<video src="${u}" controls loop></video>` : `<img src="${u}">`;
        } catch {}
    }

    function renderScene() {
        const el = $('studio-scene'); if (!el) return;
        const p = scProj();
        if (!p) { // project list / picker
            el.innerHTML = `
              <div class="st-scene-bar"><span class="st-scene-title">Scenes — video editor</span>
                <button class="st-btn primary" onclick="sceneNew()">+ New project</button></div>
              <div class="st-scene-sec"><div class="st-scene-h">Projects folder</div>
                <div class="st-shot-row">
                  <input class="st-in" style="flex:1" value="${esc(SC().base)}" onchange="sceneSetBase(this.value)" title="any folder under /PROJECTS">
                  <button class="st-mini" onclick="sceneLoadProjects()">↻ reload</button>
                </div>
                <div class="st-dim">Any folder under /PROJECTS. New projects are created here.</div>
              </div>
              <div class="st-scene-projects">
                ${SC().projects.length ? SC().projects.map((pr) => `
                  <div class="st-proj" onclick="sceneOpen('${esc(pr.path)}')">
                    <div class="st-proj-name">${esc(pr.name)}</div>
                    <div class="st-dim">${pr.shots} shots</div>
                    <button class="st-mini" onclick="event.stopPropagation();sceneDelete('${esc(pr.path)}')">del</button>
                  </div>`).join('') : '<div class="st-dim st-scene-empty">No projects yet — create one to start building a video.</div>'}
              </div>`;
            return;
        }
        const r = SC().render;
        const sizeChip = (w, h, lbl) => `<button class="st-chip ${p.out.w === w && p.out.h === h ? 'active' : ''}" onclick="sceneOutSet('w',${w});sceneOutSet('h',${h})">${lbl}</button>`;
        el.innerHTML = `
          <div class="st-scene-bar">
            <button class="st-mini" onclick="sceneClose()">‹ projects</button>
            <span class="st-scene-title">${esc(p.name)}</span>
            <div class="st-dim">autosaves</div>
          </div>
          <div class="st-scene-grid">
            <div class="st-scene-col">
              <div class="st-scene-sec"><div class="st-scene-h">Timeline (${p.shots.length} shots)</div>
                ${p.shots.length ? p.shots.map((s, i) => `
                  <div class="st-shot">
                    <div class="st-shot-thumb" id="st-shot-th-${i}"></div>
                    <div class="st-shot-body">
                      <div class="st-shot-name">${esc((s.clip || '').split('/').pop())}</div>
                      <div class="st-shot-row">
                        <label>in</label><input class="st-lw" type="number" step="0.1" min="0" value="${esc(s.in || 0)}" oninput="sceneShotSet(${i},'in',parseFloat(this.value))">
                        <label>out</label><input class="st-lw" type="number" step="0.1" min="0" value="${s.out != null ? esc(s.out) : ''}" placeholder="end" oninput="sceneShotSet(${i},'out',this.value===''?null:parseFloat(this.value))">
                        ${i > 0 ? `<select class="st-in" style="max-width:120px" onchange="sceneShotSet(${i},'transition',this.value)"><option value="cut" ${s.transition === 'cut' ? 'selected' : ''}>cut</option><option value="crossfade" ${s.transition === 'crossfade' ? 'selected' : ''}>crossfade</option></select>` : '<span class="st-dim">first</span>'}
                        ${i > 0 && s.transition === 'crossfade' ? `<input class="st-lw" type="number" step="0.05" min="0.1" max="2" value="${esc(s.fadeDur || 0.35)}" title="fade s" oninput="sceneShotSet(${i},'fadeDur',parseFloat(this.value))">` : ''}
                      </div>
                    </div>
                    <div class="st-shot-acts">
                      <button class="st-mini" onclick="sceneMoveShot(${i},-1)">▲</button>
                      <button class="st-mini" onclick="sceneMoveShot(${i},1)">▼</button>
                      <button class="st-mini danger" onclick="sceneRemoveShot(${i})">×</button>
                    </div>
                  </div>`).join('') : '<div class="st-dim">Add clips from the library below.</div>'}
              </div>
              <div class="st-scene-sec"><div class="st-scene-h">Clip library <button class="st-mini" onclick="sceneRefreshClips()">refresh</button></div>
                <div class="st-scene-lib">
                  ${SC().clips.map((c, i) => `<div class="st-libclip" onclick="sceneAddShot('${esc(c.path)}')" title="${esc(c.name)}">
                    <div class="st-libclip-th" id="st-lib-th-${i}"></div>
                    <div class="st-libclip-name">${esc(c.name)} · ${(c.duration || 0).toFixed(1)}s</div></div>`).join('')}
                </div>
              </div>
            </div>
            <div class="st-scene-col">
              <div class="st-scene-sec"><div class="st-scene-h">Audio</div>
                ${p.audio && p.audio.path ? `<div class="st-imgrow"><span class="st-imgname">${esc(p.audio.path.split('/').pop())}</span><button class="st-mini" onclick="sceneAudioClear()">clear</button></div>
                  <div class="st-shot-row"><label>offset s</label><input class="st-lw" type="number" step="0.1" min="0" value="${esc(p.audio.offset || 0)}" oninput="sceneAudioSet('offset',parseFloat(this.value))"></div>`
                : `<button class="st-mini" onclick="sceneAudioPick()">+ add music track</button>`}
              </div>
              <div class="st-scene-sec"><div class="st-scene-h">Titles</div>
                ${(p.titles || []).map((t, i) => `<div class="st-shot-row">
                    <input class="st-in" style="flex:1" value="${esc(t.text)}" oninput="sceneTitleSet(${i},'text',this.value)">
                    <label>s</label><input class="st-lw" type="number" step="0.5" value="${esc(t.start || 0)}" oninput="sceneTitleSet(${i},'start',parseFloat(this.value))">
                    <label>e</label><input class="st-lw" type="number" step="0.5" value="${esc(t.end || 2)}" oninput="sceneTitleSet(${i},'end',parseFloat(this.value))">
                    <button class="st-mini danger" onclick="sceneRemoveTitle(${i})">×</button></div>`).join('')}
                <button class="st-mini" onclick="sceneAddTitle()">+ add title</button>
              </div>
              <div class="st-scene-sec"><div class="st-scene-h">Character (context)</div>
                <label class="st-lab">Locked LoRA</label>
                <select class="st-in" onchange="sceneCharSet('lora',this.value)"><option value="">— none —</option>
                  ${((S.models && S.models.loras) || []).map((n) => `<option value="${esc(n)}" ${p.character && p.character.lora === n ? 'selected' : ''}>${esc(n.replace('.safetensors', ''))}</option>`).join('')}</select>
                <textarea class="st-in" rows="2" placeholder="style/character notes…" oninput="sceneCharSet('note',this.value)">${esc((p.character && p.character.note) || '')}</textarea>
                <button class="st-mini" onclick="sceneClipForChar()">+ Clip for this character →</button>
              </div>
              <div class="st-scene-sec"><div class="st-scene-h">Export</div>
                <div class="st-sizes">${sizeChip(1080, 1920, '9:16')}${sizeChip(1920, 1080, '16:9')}${sizeChip(1080, 1080, '1:1')}
                  <label class="st-lab" style="margin-left:6px">fps</label><input class="st-lw" type="number" min="8" max="30" value="${esc(p.out.fps || 24)}" oninput="sceneOutSet('fps',parseInt(this.value))"></div>
                <label class="st-adv-toggle"><input type="checkbox" ${p.out.look ? 'checked' : ''} onchange="sceneOutSet('look',this.checked)"> Cinematic look (bloom + grain + vignette + navy grade)</label>
                <button class="st-generate" onclick="sceneRender()">${r && r.status === 'running' ? 'Rendering…' : 'Render video'}</button>
                ${r ? `<div class="st-progress"><div class="st-progress-fill" style="width:${r.pct || 0}%"></div></div><div class="st-run-meta st-dim">${esc(r.step || '')} ${r.pct ? '· ' + r.pct + '%' : ''}</div>` : ''}
                <div id="st-scene-result"></div>
              </div>
            </div>
          </div>`;
        // fill thumbnails (auth blob) + result video
        p.shots.forEach((s, i) => { if (s.clip) sceneBlob('/api/studio/scene/thumb?clip=' + encodeURIComponent(s.clip), 'st-shot-th-' + i, 'img'); });
        SC().clips.forEach((c, i) => sceneBlob('/api/studio/scene/thumb?clip=' + encodeURIComponent(c.path), 'st-lib-th-' + i, 'img'));
        if (r && r.status === 'done' && r.exportPath) sceneBlob('/api/studio/scene/file?path=' + encodeURIComponent(r.exportPath), 'st-scene-result', 'video');
    }
    function sceneRefreshClips() { sceneLoadClips(); }

    // ── attachments (studio-scoped upload; reuses the server /api/upload-image) ───
    // Generic upload: create a hidden file input, upload via /api/upload-image, get path.
    function uploadImageFile(cb) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = async () => {
            const file = inp.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const b64 = String(reader.result).split(',')[1] || '';  // strip data: URL prefix
                    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
                    const d = await jpost('/api/upload-image', { image: b64, format: ext });
                    if (d.success) cb(d.path); else note('Upload failed', 'error');
                } catch (e) { note('Upload failed: ' + e.message, 'error'); }
            };
            reader.readAsDataURL(file);
        };
        inp.click();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXPORTED HANDLERS (inline onclick)
    // ═══════════════════════════════════════════════════════════════════════════
    function studioSetMode(m) { S.mode = m; if (!S.params[m]) seedDefaults(m); renderAll(); }
    // Set a value WITHOUT re-rendering (re-render would drop focus mid-type). Size,
    // model, LoRAs etc. re-render via their own button handlers.
    function studioSet(k, v) { P()[k] = v; }
    function studioSetSize(w, h) { P().size = { w, h, label: w + '×' + h }; renderForm(); }
    function studioCustomSize() { const s = prompt('Width x Height (e.g. 1024x1536):', (P().size ? P().size.w + 'x' + P().size.h : '1024x1024')); if (!s) return; const m = s.match(/(\d+)\s*[x×]\s*(\d+)/); if (m) studioSetSize(parseInt(m[1]), parseInt(m[2])); }
    function studioRandSeed() { P().seed = Math.floor(Math.random() * 2147483647); renderForm(); }
    function studioToggleAdv(v) { S.advanced = v; renderForm(); }
    function studioSetVram(v) { S.vramMode = v; }
    function studioApplyPreset(mode, i) {
        const preset = PRESETS.filter((p) => p.mode === mode)[i]; if (!preset) return;
        S.mode = mode; if (!S.params[mode]) seedDefaults(mode);
        Object.assign(S.params[mode], preset.set);
        S.loras[mode] = (preset.loras || []).map((l) => ({ ...l }));
        renderModes(); renderForm(); note('Preset: ' + preset.label, 'success');
    }
    function studioLoraAdd() { L().push({ name: '', weight: 0.8 }); renderForm(); }
    function studioLoraRemove(i) { L().splice(i, 1); renderForm(); }
    function studioLoraName(i, v) { L()[i].name = v; }
    function studioLoraWeight(i, v) { L()[i].weight = v; }
    function studioPickImage(k) { studioUploadImage(k); }
    function studioUploadImage(k) { uploadImageFile((path) => { P()[k] = path; renderForm(); note('Image set', 'success'); }); }
    function studioClearImage(k) { P()[k] = null; renderForm(); }
    function studioComfyStart() { comfyStart(); }
    function studioComfyStop() { comfyStop(); }
    function studioGenerate() { generate(); }
    function studioCancel() { cancelJob(); }
    function studioRefreshOutputs() { loadOutputs(); }
    function studioOutOpen(fn, sub) {
        jpost('/api/studio/open', { filename: decodeURIComponent(fn), subfolder: decodeURIComponent(sub) })
            .then((d) => note(d.success ? 'Opened in Windows' : (d.error || 'open failed'), d.success ? 'success' : 'error'));
    }
    function studioOutReveal(fn, sub) {
        jpost('/api/studio/open', { filename: decodeURIComponent(fn), subfolder: decodeURIComponent(sub), reveal: true })
            .then((d) => note(d.success ? 'Opened folder' : (d.error || 'failed'), d.success ? 'success' : 'error'));
    }
    async function studioOutDelete(fn, sub) {
        if (!confirm('Delete this file from disk?')) return;
        try {
            const d = await jpost('/api/studio/delete', { filename: decodeURIComponent(fn), subfolder: decodeURIComponent(sub) });
            if (!d.success) throw new Error(d.error || 'delete failed');
            note('Deleted', 'success'); loadOutputs();
        } catch (e) { note(e.message, 'error'); }
    }
    // Lightbox: click a gallery/result thumb → big view + actions.
    function studioLightbox(fn, sub, isVideo) {
        const item = { filename: decodeURIComponent(fn), subfolder: decodeURIComponent(sub), isVideo };
        blobFor(item).then((url) => {
            let ov = document.getElementById('studio-lightbox');
            if (!ov) { ov = document.createElement('div'); ov.id = 'studio-lightbox'; ov.className = 'st-lightbox'; document.body.appendChild(ov); }
            const media = isVideo ? `<video src="${url}" controls autoplay loop></video>` : `<img src="${url}">`;
            const chain = isVideo ? '' : `<button onclick="studioOutAnimate('${fn}','${sub}');studioLightboxClose()">animate</button><button onclick="studioOutUpscale('${fn}','${sub}');studioLightboxClose()">upscale</button>`;
            ov.innerHTML = `<div class="st-lb-backdrop" onclick="studioLightboxClose()"></div>
              <div class="st-lb-inner">${media}
                <div class="st-lb-acts">
                  <button onclick="studioOutOpen('${fn}','${sub}')">open</button>
                  <button onclick="studioOutReveal('${fn}','${sub}')">folder</button>
                  ${chain}
                  <button class="danger" onclick="studioOutDelete('${fn}','${sub}');studioLightboxClose()">delete</button>
                  <button onclick="studioLightboxClose()">close</button>
                </div></div>`;
            ov.style.display = 'flex';
        }).catch(() => note('could not load image', 'error'));
    }
    function studioLightboxClose() { const ov = document.getElementById('studio-lightbox'); if (ov) ov.style.display = 'none'; }
    async function studioOutStage(fn, sub) {
        const d = await jpost('/api/studio/stage-out', { filename: decodeURIComponent(fn), subfolder: decodeURIComponent(sub) });
        if (!d.success) throw new Error(d.error || 'stage failed');
        return d.name; // basename already inside ComfyUI/input (generate won't re-stage a bare name)
    }
    async function studioOutAnimate(fn, sub) {
        try { const name = await studioOutStage(fn, sub); S.mode = 'animate'; if (!S.params.animate) seedDefaults('animate'); S.params.animate.image = name; renderModes(); renderForm(); note('Loaded into Animate', 'success'); }
        catch (e) { note(e.message, 'error'); }
    }
    async function studioOutUpscale(fn, sub) {
        try { const name = await studioOutStage(fn, sub); S.mode = 'upscale'; if (!S.params.upscale) seedDefaults('upscale'); S.params.upscale.image = name; renderModes(); renderForm(); note('Loaded into Upscale', 'success'); }
        catch (e) { note(e.message, 'error'); }
    }
    function studioAdvisorStart() { advisorStart(); }
    function studioAdvisorSend() { advisorSend(); }
    function studioAdvCwd(v) { S.advisor.cwd = v; }
    function studioAdvSettings(v) { S.advisor.sendSettings = v; }
    function studioAdvUnattach(i) { S.advisor.attach.splice(i, 1); renderAdvisor(); }
    function studioAdvAttach() { uploadImageFile((path) => { S.advisor.attach.push(path); renderAdvisor(); note('Attached', 'success'); }); }

    // ── lifecycle ──────────────────────────────────────────────────────────────
    function mount(el) {
        S.mounted = el;
        if (!S.params[S.mode]) seedDefaults(S.mode);
        renderAll();
        refreshStatus().then(() => {
            if (!S.comfy || !S.comfy.running) return;
            loadModels();
            // Re-attach to a generation that was in flight before this (re)load.
            if (S.comfy.runningPrompt && (!S.job || !S.job.running)) {
                S.job = { promptId: S.comfy.runningPrompt, step: 0, total: 0, previewURL: null, running: true, mode: S.mode, reattached: true };
                renderRun();
                streamProgress(S.comfy.runningPrompt);
            }
        });
        startGpuStream();
        loadOutputs();
    }
    function unmount() {
        stopGpuStream(); stopJobStream(); stopJobWatch();
        if (S.advisor.es) { try { S.advisor.es.close(); } catch {} S.advisor.es = null; }
        clearInterval(S.scene.poll); clearTimeout(S.scene.saveT);
        const lb = document.getElementById('studio-lightbox'); if (lb) lb.remove();
        S.mounted = null;
    }

    // desktop tab
    function studioInit() { const el = $('pc-studio-body'); if (el) mount(el); }
    function studioTeardown() { unmount(); }

    // mobile room registration
    if (typeof WorldManager !== 'undefined') {
        WorldManager.rooms = WorldManager.rooms || {};
        WorldManager.rooms.studio = {
            id: 'studio-room', theme: 'studio', title: 'Studio',
            onOpen: () => { const el = document.querySelector('#studio-room .studio-mount'); if (el) mount(el); },
            onClose: () => unmount(),
        };
    }

    Object.assign(window, {
        studioInit, studioTeardown,
        studioSetMode, studioSet, studioSetSize, studioCustomSize, studioRandSeed, studioToggleAdv, studioSetVram,
        studioApplyPreset, studioLoraAdd, studioLoraRemove, studioLoraName, studioLoraWeight,
        studioPickImage, studioUploadImage, studioClearImage, studioComfyStart, studioComfyStop, studioGenerate, studioCancel,
        studioRefreshOutputs, studioOutOpen, studioOutReveal, studioOutDelete, studioOutAnimate, studioOutUpscale,
        studioLightbox, studioLightboxClose,
        studioAdvisorStart, studioAdvisorSend, studioAdvCwd, studioAdvSettings, studioAdvUnattach, studioAdvAttach,
        sceneNew, sceneOpen, sceneClose, sceneSetBase, sceneDelete, sceneAddShot, sceneRemoveShot, sceneMoveShot,
        sceneLoadProjects,
        sceneShotSet, sceneAudioPick, sceneAudioSet, sceneAudioClear, sceneAddTitle, sceneTitleSet,
        sceneRemoveTitle, sceneCharSet, sceneOutSet, sceneClipForChar, sceneRender, sceneRefreshClips,
    });
})();
