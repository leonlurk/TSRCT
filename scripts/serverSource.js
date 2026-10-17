// The server's code as TEXT, for the checks that read it: server.js first, then every
// route group cut out of it into lib/routes/ (cleanup P2 #9, 2026-10-17). A check that
// read server.js alone after the move found nothing - and a guard check that finds
// nothing passes, which is why check-restricted now also has a floor.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = function serverSource() {
    const dir = path.join(ROOT, 'lib', 'routes');
    const routes = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort() : [];
    return [path.join(ROOT, 'server.js'), ...routes.map(f => path.join(dir, f))]
        .map(f => fs.readFileSync(f, 'utf8')).join('\n');
};
