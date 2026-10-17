#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/check-projector-live.js — the projector CLI against a REAL headless
// browser and a fixture page that copies what went wrong on the ShopLine
// course (2026-10-12):
//   - `click css=textarea` picked the Academy's hidden "Chat with Instructor"
//     box instead of the visible answer box;
//   - `click text=OK, let's go` clicked the middle of the modal (the container
//     whose text includes the label) instead of the button;
//   - `find` returned [] for fields inside iframes (same- and cross-origin);
//   - there was no way to upload a file (the Theme Importer's <input type=file>,
//     possibly hidden behind a button or inside a shadow root).
//
// NOT part of `npm run check`: it starts a browser (~200 MB for ~20 s).
// Run: node scripts/check-projector-live.js   (exit 0 = clean, 1 = a check failed)
// It uses its own throwaway tmux session `projcheck` and closes everything.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawnSync, execFile } = require('child_process');

const CLI = path.join(__dirname, 'projector.js');
const SESSION = 'projcheck';
let failed = 0, passed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.error(`  [!] ${name}${detail ? ' -- ' + String(detail).slice(0, 300) : ''}`);
}
// Async on purpose: the fixture server lives in THIS process, and a spawnSync
// would block it from answering the very browser the command is driving.
function cli(...args) {
    return new Promise(resolve => execFile(process.execPath, [CLI, ...args, '--session', SESSION], { encoding: 'utf8', timeout: 100000 },
        (e, out, err) => resolve({ ok: !e, out: (out || '').trim(), err: (err || '').trim() })));
}
const marks = async () => { const r = await cli('read'); const m = r.out.match(/MARKS:\[([^\]]*)\]/); return m ? m[1] : ''; };

// Cross-origin frame: served on "localhost" (::1) while the page is on 127.0.0.1.
const OTHER = (port) => `
<!doctype html><body style="margin:0">
<label>Work email <input id="em" placeholder="Work email"></label>
<button onclick="parent.postMessage('xo-click','*')">Create account</button>
<script>em.addEventListener('input',()=>parent.postMessage('xo-typed:'+em.value,'*'))</script>
</body>`;

const PAGE = (port) => `
<!doctype html><html><head><style>
 body{margin:0;font:14px sans-serif;height:1400px}
 #chat{position:fixed;right:20px;bottom:20px;width:260px;height:80px;visibility:hidden}
 #answer{position:absolute;left:40px;top:120px;width:400px;height:60px}
 #modal{position:absolute;left:440px;top:260px;width:400px;height:260px;border:1px solid #888;background:#eee}
 #modal button{position:absolute;left:150px;bottom:20px}
 #up{position:absolute;left:40px;top:560px}
 iframe{position:absolute;width:420px;height:120px;border:0}
</style></head><body>
<div id="marks">MARKS:[]</div>
<textarea id="chat" placeholder="Chat with Instructor"></textarea>
<textarea id="answer" placeholder="Your answer"></textarea>
<div id="modal" role="dialog" tabindex="-1" onclick="mark('modal-body')">
  <h2>Welcome to the Theme Developer course</h2><p>Ready when you are.</p>
  <button onclick="event.stopPropagation();mark('ok-button')"><span>OK, let's go</span> <small>(opens lesson 1)</small></button>
</div>
<input type="file" id="hiddenfile" style="display:none" onchange="mark('file:'+this.files[0].name+':'+this.files[0].size)">
<button id="up" onclick="hiddenfile.click()">Upload theme</button>
<iframe style="left:40px;top:640px" srcdoc="<body style='margin:0'><input id=sf placeholder='Setup search'><button onclick=&quot;parent.mark('same-click')&quot;>Save settings</button></body>"></iframe>
<iframe style="left:40px;top:780px" src="http://localhost:${port}/other"></iframe>
<div id="host" style="position:absolute;left:600px;top:560px"></div>
<script>
 const got = [];
 function mark(s){ got.push(s); document.getElementById('marks').textContent = 'MARKS:[' + got.join(',') + ']'; }
 answer.addEventListener('input', () => mark('answer:' + answer.value));
 chat.addEventListener('input', () => mark('chat:' + chat.value));
 addEventListener('message', e => mark(String(e.data)));
 const sr = host.attachShadow({ mode: 'open' });
 sr.innerHTML = '<label>Theme zip <input type="file" id="shadowfile"></label>';
 sr.getElementById('shadowfile').addEventListener('change', e => mark('shadowfile:' + e.target.files[0].name));
</script></body></html>`;

(async () => {
    const server = http.createServer((req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(PAGE(other.address().port));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    // The cross-origin frame comes from "localhost" (::1 on this machine), a different site.
    const other = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(OTHER()); });
    await new Promise(r => other.listen(0, '::1', r));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'projcheck-'));
    const zip = path.join(tmp, 'corporate-theme.zip');
    fs.writeFileSync(zip, Buffer.alloc(1234, 7));
    spawnSync('tmux', ['new-session', '-d', '-s', SESSION, 'sleep 600']);

    try {
        const st = await cli('start');
        check('the browser starts', st.ok, st.err || st.out);
        const op = await cli('open', `http://127.0.0.1:${port}/`);
        check('the fixture opens', op.ok, op.err);
        await new Promise(r => setTimeout(r, 1200));

        // 2. css= prefers the visible element
        const c1 = await cli('click', 'css=textarea');
        check('click css=textarea runs', c1.ok, c1.err);
        await cli('type', 'hello');
        const m1 = await marks();
        check('css= picks the VISIBLE textarea, not the hidden chat box', /answer:hello/.test(m1) && !/chat:/.test(m1), m1);

        // 3. text= prefers the innermost clickable (the button, not the modal)
        const c2 = await cli('click', "text=OK, let's go");
        check("click text=OK, let's go runs", c2.ok, c2.err);
        const m2 = await marks();
        check('text= clicks the button, not the middle of the modal', /ok-button/.test(m2) && !/modal-body/.test(m2), m2);

        // find inside iframes
        const f1 = await cli('find', 'Setup search');
        let rows = []; try { rows = JSON.parse(f1.out); } catch {}
        check('find sees a field inside a same-origin iframe', rows.length > 0, f1.out || f1.err);
        const f2 = await cli('find', 'Work email');
        let rows2 = []; try { rows2 = JSON.parse(f2.out); } catch {}
        check('find sees a field inside a cross-origin iframe', rows2.length > 0, f2.out || f2.err);
        const c3 = await cli('click', 'text=Save settings');
        check('text= clicks inside a same-origin iframe', c3.ok && /same-click/.test((await marks())), c3.err || (await marks()));
        const c4 = await cli('click', 'text=Create account');
        check('text= clicks inside a cross-origin iframe', c4.ok && /xo-click/.test((await marks())), c4.err || (await marks()));
        if (rows2[0]) {
            await cli('click', String(rows2[0].x), String(rows2[0].y));
            await cli('type', 'a@example.com');
            check('find x,y of a cross-origin field is where the field is (typing lands)', /xo-typed:a@b\.co/.test((await marks())), (await marks()));
        }

        // 1. upload
        check('the CLI has an upload command', !/^usage:/.test((await cli('upload')).out));
        const u1 = await cli('upload', 'text=Upload theme', zip);
        check('upload through a button that opens a hidden file input', u1.ok && /file:corporate-theme\.zip:1234/.test((await marks())), (u1.err || u1.out) + ' ' + (await marks()));
        const u2 = await cli('upload', 'css=#shadowfile', zip);
        check('upload into a file input inside a shadow root', u2.ok && /shadowfile:corporate-theme\.zip/.test((await marks())), (u2.err || u2.out) + ' ' + (await marks()));
        const u3 = await cli('upload', 'text=Upload theme', '/nonexistent/x.zip');
        check('upload of a missing file is refused', !u3.ok);
        const u4 = await cli('upload', 'text=Upload theme', path.join(tmp, 'secretco-export.zip'));
        check('upload of an SecretCo file is refused', !u4.ok && /secretco/i.test(u4.err), u4.err);

        // download
        const dl = await cli('download', `http://127.0.0.1:${port}/theme.zip`);
        const saved = (dl.out.match(/(\/\S+)$/) || [])[1];
        check('download saves into a known folder and prints the path', dl.ok && saved && fs.existsSync(saved), dl.err || dl.out);
        if (saved) { try { fs.unlinkSync(saved); } catch {} }
        check('download refuses an SecretCo url', !(await cli('download', 'https://secretco-sandbox.my.salesforce.com/x.zip')).ok);
    } finally {
        await cli('stop');
        spawnSync('tmux', ['kill-session', '-t', '=' + SESSION]);
        server.close(); other.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(path.join(require('../lib/projector').dir(), 'profiles', SESSION), { recursive: true, force: true }); } catch {}
    }
    if (failed) { console.error(`[check-projector-live] ${failed} failed, ${passed} passed`); process.exit(1); }
    console.log(`[check-projector-live] OK -- ${passed} checks`);
})();
