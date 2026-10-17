'use strict';
// One place that connects Tesla's PC modules to each other, used by server.js
// AND by scripts/desk.js (the CLI the `hands` worker runs), so the two cannot
// drift. pcDirect opens things, deskWindows moves them, deskShortcuts presses
// named keys; all three go through lib/desk.js's log and SecretCo checks.
const desk = require('./desk');
const pcDirect = require('./pcDirect');
const deskWindows = require('./deskWindows');
const deskShortcuts = require('./deskShortcuts');
const { execFile } = require('child_process');

let wired = false;
function wire(extra = {}) {
    if (wired && !Object.keys(extra).length) return { pcDirect, deskWindows, deskShortcuts };
    wired = true;
    pcDirect.configure({
        focus: (name) => desk.act({ op: 'focus', window: name, direct: !!extra.direct }),
        mediaKey: (keys, times) => desk.act({ op: 'media', keys, times, direct: true }),
        ...(extra.pcDirect || {}),
    });
    deskWindows.configure({ openApp: (name) => pcDirect.openApp(name) });
    deskShortcuts.configure({
        direct: !!extra.direct,
        list: (o) => deskWindows.list(o),
        bringForward: async (hwnd) => {
            const b64 = Buffer.from(JSON.stringify([{ hwnd, state: 'front', front: true }]), 'utf8').toString('base64');
            await desk.runPs(require('path').join(__dirname, '..', 'scripts', 'desk', 'windows.ps1'), ['-Op', 'apply', '-Text', b64, '-Deny', `(?i)${desk.DENY_SOURCE}`]);
        },
        openUrl: (uri) => pcDirect.openUri(uri),
        exec: (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 10000, windowsHide: true }, (e) => e ? reject(e) : resolve())),
    });
    return { pcDirect, deskWindows, deskShortcuts };
}

module.exports = { wire };
