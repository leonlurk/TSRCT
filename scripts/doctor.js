#!/usr/bin/env node
'use strict';
// npm run doctor — one line per part of TSRCT: working, or what is missing and
// how to fix it. Changes nothing. Exit 1 when a REQUIRED part is missing.
// --json prints the same as data.
const checks = require('./setup-checks');

const r = checks.all();
if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ core: r.core, optional: r.optional }, null, 2));
    process.exit(r.core.every(c => c.ok) ? 0 : 1);
}

function line(c) {
    const mark = c.ok ? '[*]' : '[!]';
    const how = c.ok ? '' : c.fix.cmd ? `  fix: ${c.fix.cmd.join(' ')}` : c.fix.url ? `  fix: ${c.fix.url}` : c.fix.note ? `  fix: ${c.fix.note}` : '';
    return `  ${mark} ${c.title}${c.detail ? ' - ' + c.detail : ''}${how}`;
}

console.log('\nTSRCT doctor\n\nRequired:');
r.core.forEach(c => console.log(line(c)));
console.log('\nOptional:');
r.optional.forEach(c => console.log(line(c).replace('[!]', '[-]')));
const missing = r.core.filter(c => !c.ok).length;
console.log(missing ? `\n${missing} required part(s) missing. Run: npm run setup\n` : '\nEverything required is in place. Start it with: node server.js\n');
process.exit(missing ? 1 : 0);
