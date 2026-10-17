#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/check-assets.js — service-worker asset consistency check.
//
// Run: node scripts/check-assets.js        (exit 0 = clean, 1 = drift)
//
// TSRCT has no build step, so the sw.js precache list is maintained by hand and
// drifts silently in both directions:
//   - an entry whose file was deleted   -> before 2026-08-14 that aborted the
//     whole SW install (cache.addAll is atomic); now it only degrades, but it
//     is still wrong and it is still invisible in the browser.
//   - a file index.html hard-links that is NOT in the list -> the "offline"
//     shell is a fiction that happens to work via the runtime cache.put.
//   - a room CSS file nothing precaches -> that room is not offline-safe.
//
// This is the cheap half of the testing story. The other half (asserting every
// inline onclick= name is exported on window) is the next one to write.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const sw = read('sw.js');
const cacheName = (sw.match(/CACHE_NAME\s*=\s*'([^']+)'/) || [])[1] || '(unknown)';
const start = sw.indexOf('const ASSETS_TO_CACHE');
const assets = new Function(
    sw.slice(start, sw.indexOf('];', start) + 2) + '; return ASSETS_TO_CACHE;'
)();

const html = read('src/index.html');
const hardLinked = [
    ...[...html.matchAll(/<link[^>]+href="(\/src\/[^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<script[^>]*src="(\/src\/[^"]+)"/g)].map((m) => m[1]),
];
const roomCss = fs
    .readdirSync(path.join(ROOT, 'src/css/rooms'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => '/src/css/rooms/' + f);

const inList = new Set(assets);
const problems = [];

for (const url of assets) {
    if (url === '/') continue; // served from src/index.html
    if (!fs.existsSync(path.join(ROOT, url))) {
        problems.push(`precached but MISSING ON DISK: ${url}`);
    }
}
for (const url of hardLinked) {
    if (!inList.has(url)) problems.push(`hard-linked in index.html but NOT precached: ${url}`);
}
for (const url of roomCss) {
    if (!inList.has(url)) problems.push(`room CSS not precached (room is not offline-safe): ${url}`);
}

console.log(`[check-assets] ${cacheName} — ${assets.length} precached entries`);
if (problems.length === 0) {
    console.log('[check-assets] OK — list, disk and index.html agree');
    process.exit(0);
}
for (const p of problems) console.error('  [!] ' + p);
console.error(`[check-assets] ${problems.length} problem(s). Fix sw.js ASSETS_TO_CACHE and bump CACHE_NAME.`);
process.exit(1);
