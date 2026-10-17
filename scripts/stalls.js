#!/usr/bin/env node
// Read back logs/stalls.jsonl (lib/stallWatch.js): how often the server froze,
// for how long, and which program it was waiting on.
// Usage: node scripts/stalls.js [hours=24]
'use strict';
const fs = require('fs');
const { LOG } = require('../lib/stallWatch');

const hours = Number(process.argv[2] || 24);
const since = Date.now() - hours * 3600e3;
let rows = [];
try {
    rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter(r => r && Date.parse(r.at) >= since);
} catch (e) { /* no log yet */ }

if (!rows.length) { console.log(`no freezes over ${hours}h (log: ${LOG})`); process.exit(0); }

const total = rows.reduce((a, r) => a + r.stalledMs, 0);
const worst = rows.reduce((a, r) => (r.stalledMs > a.stalledMs ? r : a));
console.log(`${rows.length} freezes over ${hours}h, ${(total / 1000).toFixed(1)}s in all, worst ${worst.stalledMs}ms at ${worst.at}`);

// Blame by program: the slowest call inside each freeze.
const by = {};
rows.forEach(r => {
    const c = r.calls && r.calls[0];
    const k = c ? c.cmd : '(no slow child process: JS work)';
    by[k] = by[k] || { n: 0, ms: 0, reqs: {} };
    by[k].n++; by[k].ms += r.stalledMs;
    const q = (c && c.req) || r.req || '-';
    by[k].reqs[q] = (by[k].reqs[q] || 0) + 1;
});
Object.entries(by).sort((a, b) => b[1].ms - a[1].ms).forEach(([k, v]) => {
    const reqs = Object.entries(v.reqs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([q, n]) => `${q} x${n}`).join(', ');
    console.log(`  ${k}: ${v.n}x, ${(v.ms / 1000).toFixed(1)}s  [${reqs}]`);
});
