#!/usr/bin/env node
// A size RATCHET for the files that were god files (cleanup P2).
//
// Each one has a ceiling. A file may shrink freely; growing past its ceiling is
// red, so the next feature goes into its own module instead of back into the
// biggest file. Lower a ceiling when a file shrinks; raising one is a decision -
// write down why next to the number.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CEILINGS = {
    'server.js': 4300,                 // route groups moved to lib/routes/ 2026-10-17
    'src/js/desktop.js': 3100,         // sessions + split view + drag and drop moved out 2026-10-17
    'src/js/remote-desktop.js': 2850,  // VR moved out 2026-10-16
    'src/js/remote-desktop-vr.js': 2450,
    'lib/talk.js': 2000,
    'src/js/main.js': 1600,            // sound, auto-accept, abbreviations moved out 2026-10-24
    'src/js/sessions.js': 1260,        // was gallery.js; the gallery itself moved to attachments.js 2026-10-24
    'src/css/desktop.css': 2100,        // split by surface 2026-10-17, same order (desktop-*.css)
};

let fail = 0;
for (const [file, max] of Object.entries(CEILINGS)) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length;
    if (lines > max) { fail++; console.log(`  [x] ${file} is ${lines} lines, ceiling ${max}: put the new code in its own module`); }
}
console.log(`check-size: ${Object.keys(CEILINGS).length - fail}/${Object.keys(CEILINGS).length} files under their ceiling${fail ? ' FAILED' : ''}`);
process.exit(fail ? 1 : 0);
