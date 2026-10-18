// ─────────────────────────────────────────────────────────────────────────
// lib/gpu.js — real-time NVIDIA GPU telemetry.
//
// One structured nvidia-smi query, parsed into a compact JSON sample. Tesla
// checks free VRAM with it before loading the local model. All
// argv-exec (no shell), fail-soft: if nvidia-smi is missing or errors, returns
// { available:false } instead of throwing.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { execFile } = require('child_process');

const QUERY = [
    'utilization.gpu',
    'memory.used',
    'memory.total',
    'temperature.gpu',
    'power.draw',
    'power.limit',
    'clocks.sm',
    'name',
].join(',');

// Parse one nvidia-smi CSV value; "[N/A]" / "" → null. Laptop GPUs frequently
// report power.limit as [N/A].
function num(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s === '[N/A]' || s.toLowerCase() === 'n/a') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

// Resolve to a sample object. Never rejects.
function sample() {
    return new Promise((resolve) => {
        execFile(
            'nvidia-smi',
            [`--query-gpu=${QUERY}`, '--format=csv,noheader,nounits'],
            { timeout: 4000 },
            (err, stdout) => {
                if (err || !stdout) {
                    resolve({ available: false, error: err ? err.message : 'no output' });
                    return;
                }
                // First GPU line only (single-GPU box).
                const line = String(stdout).trim().split('\n')[0] || '';
                const p = line.split(',').map((x) => x.trim());
                const memUsed = num(p[1]);
                const memTotal = num(p[2]);
                const powerLimit = num(p[5]);
                const power = num(p[4]);
                resolve({
                    available: true,
                    util: num(p[0]),               // %
                    memUsed,                       // MiB
                    memTotal,                      // MiB
                    memPct: (memUsed != null && memTotal) ? Math.round((memUsed / memTotal) * 100) : null,
                    temp: num(p[3]),               // C
                    power,                         // W
                    powerLimit,                    // W (often null on laptop GPUs)
                    powerPct: (power != null && powerLimit) ? Math.round((power / powerLimit) * 100) : null,
                    clock: num(p[6]),              // MHz
                    name: (p[7] || '').replace(/^NVIDIA\s+/, '') || 'GPU',
                    at: Date.now(),
                });
            },
        );
    });
}

module.exports = { sample };
