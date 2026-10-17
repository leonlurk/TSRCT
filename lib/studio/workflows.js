// ─────────────────────────────────────────────────────────────────────────
// lib/studio/workflows.js — ComfyUI API-graph builders for the Studio.
//
// Pure { mode, params } -> graph functions. They mirror Leon's proven CLI
// scripts (personal/lurk/tools/flux_gen.py, wan_animate.py) and EXTEND them with
// capability the scripts lack: Flux dev (quality) + FluxGuidance, LoRA stacking,
// Flux Redux (style-from-reference), img2img + inpaint, upscale, and a raw
// custom-graph passthrough (the uncapped escape hatch). Hardware-tuned defaults
// (8 GB RTX 5060) live here. Image inputs are filenames already staged in
// ~/ComfyUI/input (the route stages uploads via comfy.stageInput).
// ─────────────────────────────────────────────────────────────────────────
'use strict';

// Model filenames on the box (defaults; the UI overrides from /api/studio/models).
const M = {
    FLUX_SCHNELL: 'flux1-schnell-Q4_K_S.gguf',
    FLUX_DEV: 'flux1-dev-Q4_K_S.gguf',
    FLUX_T5: 't5-v1_1-xxl-encoder-Q4_K_M.gguf',
    FLUX_CLIP_L: 'clip_l.safetensors',
    FLUX_VAE: 'ae.safetensors',
    FLUX_REDUX: 'flux1-redux-dev.safetensors',
    REDUX_CLIPVISION: 'sigclip_vision_patch14_384.safetensors',
    WAN_UNET: 'Wan2.2-TI2V-5B-Q5_K_M.gguf',
    WAN_CLIP: 'umt5-xxl-encoder-Q5_K_M.gguf',
    WAN_VAE: 'wan2.2_vae.safetensors',
    UPSCALE: '4x_foolhardy_Remacri.pth',
};

const WAN_NEG_DEFAULT = 'blurry, low quality, distorted, deformed, watermark, text, caption, '
    + 'jpeg artifacts, overexposed, static, still, flicker, harsh cut';

const toInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const toFloat = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const clampSeed = (v) => { let n = toInt(v, 0); return n < 0 ? 0 : n; };

// Append a model-only LoRA chain; returns the final model ref. loras=[{name,weight}].
function loraChain(g, startRef, loras, nextId) {
    let ref = startRef;
    (loras || []).forEach((l) => {
        if (!l || !l.name) return;
        const id = String(nextId());
        g[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ref, lora_name: l.name, strength_model: toFloat(l.weight, 1.0) } };
        ref = [id, 0];
    });
    return ref;
}

// FLUX still — schnell(fast)/dev(quality) + LoRA rack + Redux + img2img/inpaint.
function flux(p) {
    const isDev = p.model === 'dev';
    const width = toInt(p.width, 1024), height = toInt(p.height, 1024);
    const batch = Math.max(1, Math.min(toInt(p.batch, 1), 9));
    const g = {
        '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: p.unet || (isDev ? M.FLUX_DEV : M.FLUX_SCHNELL) } },
        '2': { class_type: 'DualCLIPLoaderGGUF', inputs: { clip_name1: p.t5 || M.FLUX_T5, clip_name2: p.clip_l || M.FLUX_CLIP_L, type: 'flux' } },
        '3': { class_type: 'VAELoader', inputs: { vae_name: p.vae || M.FLUX_VAE } },
        '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.prompt || '' } },
        '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.negative || '' } },
        '6': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: batch } },
    };
    let id = 100; const nextId = () => id++;
    const modelRef = loraChain(g, ['1', 0], p.loras, nextId);

    let posRef = ['4', 0];
    if (isDev) {
        const gid = String(nextId());
        g[gid] = { class_type: 'FluxGuidance', inputs: { conditioning: posRef, guidance: toFloat(p.guidance, 3.5) } };
        posRef = [gid, 0];
    }
    if (p.style_image) { // Flux Redux — style/composition from a reference image
        const cv = String(nextId());
        g[cv] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: p.redux_clipvision || M.REDUX_CLIPVISION } };
        const li = String(nextId());
        g[li] = { class_type: 'LoadImage', inputs: { image: p.style_image } };
        const enc = String(nextId());
        g[enc] = { class_type: 'CLIPVisionEncode', inputs: { clip_vision: [cv, 0], image: [li, 0], crop: 'center' } };
        const sm = String(nextId());
        g[sm] = { class_type: 'StyleModelLoader', inputs: { style_model_name: p.redux || M.FLUX_REDUX } };
        const ap = String(nextId());
        g[ap] = { class_type: 'StyleModelApply', inputs: { conditioning: posRef, style_model: [sm, 0], clip_vision_output: [enc, 0], strength: toFloat(p.style_strength, 1.0), strength_type: 'multiply' } };
        posRef = [ap, 0];
    }

    let latentRef = ['6', 0];
    if (p.init_image) { // img2img
        const li = String(nextId());
        g[li] = { class_type: 'LoadImage', inputs: { image: p.init_image } };
        const enc = String(nextId());
        g[enc] = { class_type: 'VAEEncode', inputs: { pixels: [li, 0], vae: ['3', 0] } };
        latentRef = [enc, 0];
        if (p.mask_image) { // inpaint
            const mk = String(nextId());
            g[mk] = { class_type: 'LoadImageMask', inputs: { image: p.mask_image, channel: 'red' } };
            const sm = String(nextId());
            g[sm] = { class_type: 'SetLatentNoiseMask', inputs: { samples: latentRef, mask: [mk, 0] } };
            latentRef = [sm, 0];
        }
    }

    const ks = String(nextId());
    g[ks] = { class_type: 'KSampler', inputs: {
        model: modelRef, positive: posRef, negative: ['5', 0], latent_image: latentRef,
        seed: clampSeed(p.seed), steps: toInt(p.steps, isDev ? 20 : 4), cfg: toFloat(p.cfg, 1.0),
        sampler_name: p.sampler || 'euler', scheduler: p.scheduler || 'simple',
        denoise: p.init_image ? toFloat(p.denoise, 0.7) : 1.0 } };
    const dec = String(nextId());
    g[dec] = { class_type: 'VAEDecode', inputs: { samples: [ks, 0], vae: ['3', 0] } };
    const save = String(nextId());
    g[save] = { class_type: 'SaveImage', inputs: { images: [dec, 0], filename_prefix: p.prefix || 'leonlurk_studio' } };
    return g;
}

// WAN 2.2 — still -> short motion clip. + LoRA rack.
function wan(p) {
    if (!p.image) throw new Error('animate needs a source image');
    const width = toInt(p.width, 480), height = toInt(p.height, 832);
    let length = toInt(p.length, 49);
    if ((length - 1) % 4 !== 0) length = Math.round((length - 1) / 4) * 4 + 1; // Wan requires 4n+1
    const g = {
        '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: p.unet || M.WAN_UNET } },
        '2': { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: p.clip || M.WAN_CLIP, type: 'wan' } },
        '3': { class_type: 'VAELoader', inputs: { vae_name: p.vae || M.WAN_VAE } },
        '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.prompt || '' } },
        '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: p.negative || WAN_NEG_DEFAULT } },
        '7': { class_type: 'LoadImage', inputs: { image: p.image } },
    };
    let id = 100; const nextId = () => id++;
    const modelRef = loraChain(g, ['1', 0], p.loras, nextId);
    const ms = String(nextId());
    g[ms] = { class_type: 'ModelSamplingSD3', inputs: { model: modelRef, shift: toFloat(p.shift, 8.0) } };
    const lat = String(nextId());
    g[lat] = { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['3', 0], width, height, length, batch_size: 1, start_image: ['7', 0] } };
    const ks = String(nextId());
    g[ks] = { class_type: 'KSampler', inputs: {
        model: [ms, 0], positive: ['5', 0], negative: ['6', 0], latent_image: [lat, 0],
        seed: clampSeed(p.seed), steps: toInt(p.steps, 20), cfg: toFloat(p.cfg, 5.0),
        sampler_name: p.sampler || 'euler', scheduler: p.scheduler || 'simple', denoise: 1.0 } };
    const dec = String(nextId());
    g[dec] = { class_type: 'VAEDecode', inputs: { samples: [ks, 0], vae: ['3', 0] } };
    const cv = String(nextId());
    g[cv] = { class_type: 'CreateVideo', inputs: { images: [dec, 0], fps: toFloat(p.fps, 24) } };
    const sv = String(nextId());
    g[sv] = { class_type: 'SaveVideo', inputs: { video: [cv, 0], filename_prefix: p.prefix || 'leonlurk_motion', format: 'mp4', codec: 'h264' } };
    return g;
}

// UPSCALE — 4x via ESRGAN-family model.
function upscale(p) {
    if (!p.image) throw new Error('upscale needs a source image');
    return {
        '1': { class_type: 'LoadImage', inputs: { image: p.image } },
        '2': { class_type: 'UpscaleModelLoader', inputs: { model_name: p.model || M.UPSCALE } },
        '3': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
        '4': { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: p.prefix || 'leonlurk_upscale' } },
    };
}

// CUSTOM — run any ComfyUI API-JSON verbatim (never caps the hardware).
function custom(p) {
    if (!p || !p.rawGraph || typeof p.rawGraph !== 'object' || Array.isArray(p.rawGraph)) {
        throw new Error('custom mode needs a rawGraph object (ComfyUI API-format JSON)');
    }
    return p.rawGraph;
}

function build(mode, params) {
    switch (mode) {
        case 'flux': return flux(params || {});
        case 'wan': return wan(params || {});
        case 'upscale': return upscale(params || {});
        case 'custom': return custom(params || {});
        default: throw new Error('unknown mode: ' + mode);
    }
}

module.exports = { build, flux, wan, upscale, custom, MODELS: M, WAN_NEG_DEFAULT };
