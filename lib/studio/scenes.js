// ─────────────────────────────────────────────────────────────────────────
// lib/studio/scenes.js — project-based AI video editor (the Studio "Scenes" tab).
//
// Assembles short AI clips into a longer video with ffmpeg (CPU — GPU-light, no
// ComfyUI needed). Project-based ("like Premiere for AI video"): each project is
// a folder with project.json + rendered exports, so a story is built over many
// sessions. Reuses the proven assembly patterns from Leon's PIEL scripts:
// per-clip normalize (scale/pad→1080x1920, fps, setsar), ffprobe durations, a
// cumulative-offset xfade chain, and the concat demuxer for hard cuts.
//
// Security: projects/audio/exports are confined to PROJECTS_ROOT; clips may also
// come from the ComfyUI output/motion dirs. Everything argv-exec (no shell).
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const PROJECTS_ROOT = paths.PROJECTS_ROOT;
const SCENES_BASE_DEFAULT = path.join(PROJECTS_ROOT, 'personal/lurk/scenes');
const COMFY_DIR = path.join(os.homedir(), 'ComfyUI');
const CLIP_SOURCES = [
    path.join(COMFY_DIR, 'output'),
    path.join(PROJECTS_ROOT, 'personal/lurk/assets/motion'),
];
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv', '.gif'];

// ── path safety ──────────────────────────────────────────────────────────
function underRoot(p, root) {
    const r = path.resolve(root), f = path.resolve(p);
    return f === r || f.startsWith(r + path.sep);
}
function safeProjectPath(p) {
    const resolved = path.resolve(String(p || ''));
    return underRoot(resolved, PROJECTS_ROOT) ? resolved : null;
}
// ── what counts as a scenes project ──────────────────────────────────────
// The presence of project.json is NOT proof that a directory is a project:
// saveProject used to create one in ANY existing directory under PROJECTS, so a
// caller could plant the very file deleteProject accepted as evidence and then
// have it rmSync that directory (the TSRCT repo included). The file must now
// PARSE as a scenes project, and a code tree is never one. Audit 2026-08-14.
function readProjectFile(dir) {
    const pj = path.join(dir, 'project.json');
    if (!fs.existsSync(pj)) return null;
    try { return JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { return null; }
}
function looksLikeProject(data) {
    return !!data && Array.isArray(data.shots) && !!data.out && typeof data.out === 'object';
}
function isCodeTree(dir) {
    return ['.git', 'package.json', 'node_modules'].some((m) => fs.existsSync(path.join(dir, m)));
}

// A clip may live under PROJECTS or under a ComfyUI source dir.
function safeClipPath(p) {
    const resolved = path.resolve(String(p || ''));
    if (underRoot(resolved, PROJECTS_ROOT)) return resolved;
    if (CLIP_SOURCES.some((d) => underRoot(resolved, d))) return resolved;
    return null;
}

// ── ffprobe / ffmpeg helpers ───────────────────────────────────────────────
function probeDuration(clip) {
    try {
        const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1', clip], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const d = parseFloat(out.trim());
        return Number.isFinite(d) ? d : 0;
    } catch { return 0; }
}
function ffmpegSync(args) { execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'ignore'] }); }

// First-frame thumbnail (cached under the scenes base .thumbs by content key).
function thumbFor(clip) {
    const resolved = safeClipPath(clip);
    if (!resolved || !fs.existsSync(resolved)) return null;
    const dir = path.join(SCENES_BASE_DEFAULT, '.thumbs');
    fs.mkdirSync(dir, { recursive: true });
    const key = crypto.createHash('md5').update(resolved).digest('hex').slice(0, 16);
    const out = path.join(dir, key + '.jpg');
    if (!fs.existsSync(out)) {
        try { ffmpegSync(['-i', resolved, '-frames:v', '1', '-vf', 'scale=240:-1', out]); }
        catch { return null; }
    }
    return fs.existsSync(out) ? out : null;
}

// ── clip library ────────────────────────────────────────────────────────────
function listClips(projectPath) {
    const dirs = [...CLIP_SOURCES];
    if (projectPath) { const pp = safeProjectPath(projectPath); if (pp) dirs.push(pp); }
    const seen = new Set(); const clips = [];
    for (const dir of dirs) {
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isFile() || e.name.startsWith('.')) continue;
            if (!VIDEO_EXT.includes(path.extname(e.name).toLowerCase())) continue;
            const full = path.join(dir, e.name);
            if (seen.has(e.name)) continue; seen.add(e.name);   // dedup by name (motion is a copy of output)
            let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch {}
            clips.push({ path: full, name: e.name, source: dir === CLIP_SOURCES[0] ? 'comfy' : (dir === CLIP_SOURCES[1] ? 'motion' : 'project'), mtime });
        }
    }
    clips.sort((a, b) => b.mtime - a.mtime);
    for (const c of clips) c.duration = probeDuration(c.path);
    return clips;
}

// ── project I/O ───────────────────────────────────────────────────────────
function blankProject(name) {
    return {
        name, character: { lora: '', refs: [], note: '' },
        shots: [], audio: null, titles: [],
        out: { w: 1080, h: 1920, fps: 24, look: false },
        exports: [], updated: 0,
    };
}
function listProjects(base) {
    const root = safeProjectPath(base || SCENES_BASE_DEFAULT) || SCENES_BASE_DEFAULT;
    let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const pj = path.join(root, e.name, 'project.json');
        if (!fs.existsSync(pj)) continue;
        let data = {}; try { data = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch {}
        out.push({ name: e.name, path: path.join(root, e.name), shots: (data.shots || []).length, updated: data.updated || 0 });
    }
    out.sort((a, b) => b.updated - a.updated);
    return out;
}
function createProject(base, name) {
    // An explicitly-given base must be under PROJECTS (don't silently fall back).
    if (base && !safeProjectPath(base)) throw new Error('folder must be under /PROJECTS');
    const root = safeProjectPath(base || SCENES_BASE_DEFAULT) || SCENES_BASE_DEFAULT;
    const safe = String(name || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '_').replace(/\s+/g, '_').slice(0, 60);
    if (!safe) throw new Error('invalid project name');
    const dir = path.join(root, safe);
    if (!safeProjectPath(dir)) throw new Error('path not allowed');
    if (fs.existsSync(dir)) throw new Error('a project with that name exists');
    fs.mkdirSync(dir, { recursive: true });
    const data = blankProject(safe); data.updated = Date.now();
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(data, null, 2));
    return { path: dir, project: data };
}
function loadProject(projectPath) {
    const dir = safeProjectPath(projectPath); if (!dir) throw new Error('path not allowed');
    const pj = path.join(dir, 'project.json');
    if (!fs.existsSync(pj)) throw new Error('project not found');
    return JSON.parse(fs.readFileSync(pj, 'utf8'));
}
function saveProject(projectPath, data) {
    const dir = safeProjectPath(projectPath); if (!dir) throw new Error('path not allowed');
    if (!fs.existsSync(dir)) throw new Error('project not found');
    // Save UPDATES an existing project; it must never CREATE project.json in a
    // directory that is not already one. That was the primitive that made
    // deleteProject dangerous (createProject is the only path that creates).
    if (!looksLikeProject(readProjectFile(dir))) throw new Error('not a project');
    const clean = { ...data, updated: Date.now() };
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(clean, null, 2));
    return clean;
}
function deleteProject(projectPath) {
    const dir = safeProjectPath(projectPath); if (!dir) throw new Error('path not allowed');
    // Three independent conditions, because this ends in a recursive rmSync:
    // inside PROJECTS but never PROJECTS_ROOT itself, not a code tree, and a
    // project.json that actually PARSES as a scenes project.
    if (dir === path.resolve(PROJECTS_ROOT)) throw new Error('not a project');
    if (isCodeTree(dir)) throw new Error('not a project');
    if (!looksLikeProject(readProjectFile(dir))) throw new Error('not a project');
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
}

// ── render pipeline (async job) ─────────────────────────────────────────────
const jobs = new Map(); // jobId -> {status, step, pct, exportPath, error}

function ffmpegAsync(args, onLine) {
    return new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', ['-y', '-hide_banner', ...args]);
        let err = '';
        p.stdout.on('data', (d) => { if (onLine) String(d).split('\n').forEach(onLine); });
        p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
        p.on('error', reject);
        p.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.split('\n').filter(Boolean).slice(-3).join(' '))));
    });
}

function vf(project) {
    // titles + cinematic look, as a single -vf chain (applied in the finish pass)
    const parts = [];
    const look = project.out && project.out.look;
    if (look) {
        // soft bloom (blend a blurred copy is heavy in one -vf; approximate with unsharp
        // negative + gentle glow via gblur mixed) → keep it simple + safe: grain + vignette + navy grade.
        parts.push('gblur=sigma=1.2:steps=1');                          // subtle diffusion glow
        parts.push('curves=blue=0/0.03 0.5/0.55 1/1:red=0/0 0.5/0.46 1/0.96'); // gentle navy grade
        parts.push('noise=alls=8:allf=t');                             // fine film grain
        parts.push('vignette=PI/5');                                   // soft vignette
    }
    (project.titles || []).forEach((t) => {
        if (!t.text) return;
        const txt = String(t.text).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "’");
        const x = t.x != null ? t.x : '(w-text_w)/2';
        const y = t.y != null ? t.y : 'h*0.82';
        const en = (t.start != null && t.end != null) ? `:enable='between(t,${t.start},${t.end})'` : '';
        parts.push(`drawtext=text='${txt}':fontcolor=white:fontsize=54:borderw=3:bordercolor=black@0.6:x=${x}:y=${y}${en}`);
    });
    return parts.join(',');
}

async function render(projectPath, jobId) {
    const dir = safeProjectPath(projectPath);
    const project = loadProject(dir);
    const W = project.out.w || 1080, H = project.out.h || 1920, FPS = project.out.fps || 24;
    const shots = (project.shots || []).filter((s) => s.clip);
    if (!shots.length) throw new Error('no shots in the timeline');
    const work = path.join(dir, '.work'); fs.mkdirSync(work, { recursive: true });
    const set = (o) => { jobs.set(jobId, { ...(jobs.get(jobId) || {}), ...o }); };

    // 1) normalize each shot → same W×H×fps codec
    const norm = [];
    for (let i = 0; i < shots.length; i++) {
        const s = shots[i]; const clip = safeClipPath(s.clip);
        if (!clip || !fs.existsSync(clip)) throw new Error('clip not found: ' + s.clip);
        set({ status: 'running', step: `normalizing ${i + 1}/${shots.length}`, pct: Math.round((i / shots.length) * 60) });
        const inS = Math.max(0, parseFloat(s.in) || 0);
        const outS = parseFloat(s.out);
        const dur = (Number.isFinite(outS) && outS > inS) ? (outS - inS) : null;
        const tmp = path.join(work, `n${i}.mp4`);
        const args = [];
        if (inS > 0) args.push('-ss', String(inS));
        args.push('-i', clip);
        if (dur) args.push('-t', String(dur));
        args.push('-an', '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,fps=${FPS},setsar=1,format=yuv420p`,
            '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', tmp);
        await ffmpegAsync(args);
        norm.push(tmp);
    }

    // 2) assemble → assembled.mp4 (concat demuxer if all cuts, else xfade chain)
    set({ step: 'assembling', pct: 65 });
    const fades = shots.map((s) => s.transition === 'crossfade' ? Math.max(0.1, parseFloat(s.fadeDur) || 0.35) : 0);
    // fade for boundary i is between shot i-1 and shot i → use fades[i] (i>=1)
    const assembled = path.join(work, 'assembled.mp4');
    const anyFade = fades.slice(1).some((f) => f > 0);
    if (!anyFade) {
        const listFile = path.join(work, 'list.txt');
        fs.writeFileSync(listFile, norm.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
        await ffmpegAsync(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', assembled]);
    } else {
        const durs = norm.map((f) => probeDuration(f));
        const fc = []; let prev = '[0:v]'; let cum = durs[0];
        for (let i = 1; i < norm.length; i++) {
            const f = fades[i] > 0 ? fades[i] : 0.04;
            const off = Math.max(0, cum - f);
            const label = i < norm.length - 1 ? `[x${i}]` : '[out]';
            fc.push(`${prev}[${i}:v]xfade=transition=fade:duration=${f}:offset=${off.toFixed(3)}${label}`);
            prev = label; cum = cum + durs[i] - f;
        }
        const inputs = norm.flatMap((f) => ['-i', f]);
        await ffmpegAsync([...inputs, '-filter_complex', fc.join(';'), '-map', '[out]',
            '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', assembled]);
    }

    // 3) finish: titles + look + audio → export
    set({ step: 'finishing', pct: 85 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportPath = path.join(dir, `export_${stamp}.mp4`);
    const filter = vf(project);
    const audio = project.audio && project.audio.path ? safeClipPath(project.audio.path) || safeProjectPath(project.audio.path) : null;
    const hasAudio = audio && fs.existsSync(audio);
    if (!filter && !hasAudio) {
        fs.copyFileSync(assembled, exportPath);
    } else {
        const args = ['-i', assembled];
        if (hasAudio) {
            const off = Math.max(0, parseFloat(project.audio.offset) || 0);
            if (off > 0) args.push('-ss', String(off));
            args.push('-i', audio);
        }
        if (filter) args.push('-vf', filter);
        args.push('-map', '0:v');
        if (hasAudio) args.push('-map', '1:a', '-c:a', 'aac', '-shortest');
        args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', exportPath);
        await ffmpegAsync(args);
    }

    // record + cleanup
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    project.exports = [{ path: exportPath, at: Date.now() }, ...(project.exports || [])].slice(0, 20);
    saveProject(dir, project);
    set({ status: 'done', step: 'done', pct: 100, exportPath });
    return exportPath;
}

function startRender(projectPath) {
    const jobId = 'scene-' + crypto.randomBytes(4).toString('hex');
    jobs.set(jobId, { status: 'running', step: 'starting', pct: 0 });
    render(projectPath, jobId).catch((e) => jobs.set(jobId, { ...(jobs.get(jobId) || {}), status: 'error', error: e.message }));
    return jobId;
}
function renderStatus(jobId) { return jobs.get(jobId) || null; }

module.exports = {
    PROJECTS_ROOT, SCENES_BASE_DEFAULT, safeClipPath, safeProjectPath,
    listClips, thumbFor, listProjects, createProject, loadProject, saveProject, deleteProject,
    startRender, renderStatus,
};
