#!/usr/bin/env node
// No emojis in code, comments or UI (CLAUDE.md "Code Style"): text symbols such
// as [*] [+] [!] [img] instead. Until 2026-10-24 the rule was only written down,
// and five emojis had shipped (the gallery's shield was a "known violation" since
// August). An emoji here is what Unicode draws as a colour picture by default
// (Emoji_Presentation), what a U+FE0F forces into one, or anything in the U+1F000
// picture block (the shield is text-style on paper and a picture on every screen). Text-style symbols stay:
// Claude Code's own ❯ ✻ ✢ ✳ (lib/paneShape.js has to match them), ✕, ⚠, box-drawing.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EMOJI = /[\p{Emoji_Presentation}\u{FE0F}\u{1F000}-\u{1FAFF}]/u;

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(js|mjs|css|html|sh|ps1)$/.test(f) && !f.includes('vendor/') && fs.existsSync(path.join(ROOT, f)));

let hits = 0;
for (const f of files) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        if (EMOJI.test(line)) { hits++; console.log(`  [x] ${f}:${i + 1} has an emoji: use a text symbol ([*] [+] [!] [img])`); }
    });
}
console.log(`check-emoji: ${files.length} files, ${hits} emoji line(s)${hits ? ' FAILED' : ''}`);
process.exit(hits ? 1 : 0);
