// ─────────────────────────────────────────────────────────────────────────
// omni.js — desktop "Omni" universal file finder (the center header search bar).
//
// A VS-Code-quick-open-style bar living in the middle of the PC header. Two
// modes in one dropdown:
//   • BROWSE  — empty query: lists the current directory (dirs + files) with
//               clickable breadcrumbs, pre-navigated to /PROJECTS. Reuses the
//               existing GET-less POST /api/files/browse.
//   • SEARCH  — non-empty query: recursive fuzzy filename search across all of
//               /PROJECTS via GET /api/fs/search (server-side walk + rrestrictedg).
//
// Per-row actions make Linux files reachable from Windows:
//   open (default Windows app / Explorer for dirs), reveal-in-Explorer,
//   attach-to-input (same staged-attachment array as the paperclip), copy path,
//   rename, duplicate. All ops are confined to PROJECTS_ROOT server-side and
//   SecretCo is fail-closed (SecretCo paths never appear and every op 403s).
//
// Desktop-only. The DOM (#pc-omni) is injected by desktop.js buildPCLayout();
// this module owns the behavior. Keyboard: Ctrl/Cmd+K focus, ↑/↓ move, ↵ open /
// enter dir, → enter dir, Esc close.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const ROOT = window.TSRCT_PROJECTS_ROOT;

    let mode = 'browse';       // 'browse' | 'search'
    let cwd = ROOT;            // current dir (browse mode)
    let items = [];            // rendered rows: {name, path, isDir, rel?, isUp?}
    let sel = 0;
    let isOpen = false;
    let seq = 0;               // request sequence — drop stale search responses
    let debTimer = null;
    let bound = false;         // one-time document listeners bound

    // ── helpers ────────────────────────────────────────────────────────────
    function $id(id) { return document.getElementById(id); }
    function tokenHeaders() { return { Authorization: (typeof token !== 'undefined' ? token : '') || '' }; }
    function jsonHeaders() { return { 'Content-Type': 'application/json', Authorization: (typeof token !== 'undefined' ? token : '') || '' }; }
    function note(msg, type) { if (typeof toast === 'function') toast(msg, type || 'success'); }
    function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }
    function relOf(p) { return p && p.startsWith(ROOT) ? (p.slice(ROOT.length + 1) || '') : p; }

    const ICON_DIR = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    const ICON_FILE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    const ICON_UP = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>';

    // ── open / close ─────────────────────────────────────────────────────────
    function omniOpen() {
        if (!bound) bindGlobal();
        isOpen = true;
        const panel = $id('pc-omni-panel');
        if (panel) panel.classList.remove('hidden');
        const input = $id('pc-omni-input');
        const q = input ? input.value.trim() : '';
        if (q) doSearch(q); else browse(cwd);
        if (input) input.focus();
    }

    function omniClose() {
        isOpen = false;
        const panel = $id('pc-omni-panel');
        if (panel) panel.classList.add('hidden');
    }

    function omniToggle() {
        if (isOpen) { omniClose(); const i = $id('pc-omni-input'); if (i) i.blur(); }
        else { const i = $id('pc-omni-input'); if (i) i.focus(); omniOpen(); }
    }

    // ── data ────────────────────────────────────────────────────────────────
    async function browse(dir) {
        mode = 'browse';
        try {
            const res = await fetch('/api/files/browse', {
                method: 'POST', headers: jsonHeaders(),
                body: JSON.stringify({ path: dir || ROOT }),
            });
            const d = await res.json();
            if (!d.success) throw new Error(d.error || 'browse failed');
            cwd = d.currentPath || ROOT;
            const rows = [];
            if (d.parent) rows.push({ name: '..', path: d.parent, isDir: true, isUp: true });
            (d.directories || []).forEach(n => rows.push({ name: n, path: cwd + '/' + n, isDir: true }));
            (d.files || []).forEach(n => rows.push({ name: n, path: cwd + '/' + n, isDir: false }));
            items = rows; sel = 0; render();
        } catch (e) {
            items = []; render(e.message);
        }
    }

    async function doSearch(q) {
        mode = 'search';
        const mine = ++seq;
        try {
            const res = await fetch('/api/fs/search?q=' + encodeURIComponent(q), { headers: tokenHeaders() });
            const d = await res.json();
            if (mine !== seq) return; // a newer query already fired
            if (!d.success) throw new Error(d.error || 'search failed');
            items = (d.results || []).map(r => ({ name: r.name, path: r.path, isDir: r.isDir, rel: r.rel }));
            sel = 0; render(null, d.truncated);
        } catch (e) {
            if (mine !== seq) return;
            items = []; render(e.message);
        }
    }

    function refresh() { if (mode === 'search') { const i = $id('pc-omni-input'); doSearch(i ? i.value.trim() : ''); } else browse(cwd); }

    // ── input / keyboard ─────────────────────────────────────────────────────
    function omniOnInput() {
        const input = $id('pc-omni-input');
        const q = input ? input.value.trim() : '';
        clearTimeout(debTimer);
        if (!q) { debTimer = setTimeout(() => browse(cwd), 60); return; }
        debTimer = setTimeout(() => doSearch(q), 150);
    }

    function omniOnKeydown(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); omniClose(); const i = $id('pc-omni-input'); if (i) i.blur(); return; }
        if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); return; }
        if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); return; }
        if (ev.key === 'Enter') { ev.preventDefault(); activate(sel); return; }
        if (ev.key === 'ArrowRight') {
            const it = items[sel];
            if (it && it.isDir) { ev.preventDefault(); browseInto(it); }
            return;
        }
    }

    function move(delta) {
        if (!items.length) return;
        sel = Math.max(0, Math.min(items.length - 1, sel + delta));
        render._reselectOnly ? render._reselectOnly() : render();
        const el = document.querySelector('.pc-omni-row.sel');
        if (el) el.scrollIntoView({ block: 'nearest' });
    }

    // ── row primary action ───────────────────────────────────────────────────
    function browseInto(it) {
        const input = $id('pc-omni-input');
        if (input) input.value = '';       // leaving search → back to browse
        browse(it.isUp ? it.path : it.path);
    }

    function activate(idx) {
        const it = items[idx];
        if (!it) return;
        if (it.isDir) browseInto(it);
        else openInWindows(it.path, false);
    }

    function omniRowClick(idx) { sel = idx; activate(idx); }

    // ── secondary actions ─────────────────────────────────────────────────────
    async function openInWindows(p, reveal) {
        try {
            const res = await fetch('/api/fs/open', {
                method: 'POST', headers: jsonHeaders(),
                body: JSON.stringify({ path: p, reveal: !!reveal }),
            });
            const d = await res.json();
            if (!d.success) throw new Error(d.error || 'open failed');
            note(reveal ? 'Revealed in Explorer' : 'Opened in Windows', 'success');
        } catch (e) { note('Open failed: ' + e.message, 'error'); }
    }

    function attach(p) {
        try {
            if (typeof attachedImages !== 'undefined' && !attachedImages.includes(p)) attachedImages.push(p);
            (window.pcUpdateAttachIndicator || window.updateAttachmentIndicator || function () {})();
            note('Attached to input', 'success');
        } catch (e) { note('Attach failed: ' + e.message, 'error'); }
    }

    function copyPath(p) {
        const done = () => note('Path copied', 'success');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(p).then(done).catch(() => fallbackCopy(p, done));
        } else fallbackCopy(p, done);
    }
    function fallbackCopy(text, cb) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy');
            document.body.removeChild(ta); cb();
        } catch (e) { note('Copy failed', 'error'); }
    }

    async function renameItem(it) {
        const next = window.prompt('Rename to:', it.name);
        if (next == null) return;
        const name = next.trim();
        if (!name || name === it.name) return;
        try {
            const res = await fetch('/api/fs/rename', {
                method: 'POST', headers: jsonHeaders(),
                body: JSON.stringify({ path: it.path, newName: name }),
            });
            const d = await res.json();
            if (!d.success) throw new Error(d.error || 'rename failed');
            note('Renamed to ' + d.name, 'success');
            refresh();
        } catch (e) { note('Rename failed: ' + e.message, 'error'); }
    }

    async function duplicate(it) {
        try {
            const res = await fetch('/api/fs/copy', {
                method: 'POST', headers: jsonHeaders(),
                body: JSON.stringify({ path: it.path }),
            });
            const d = await res.json();
            if (!d.success) throw new Error(d.error || 'copy failed');
            note('Duplicated → ' + d.name, 'success');
            refresh();
        } catch (e) { note('Duplicate failed: ' + e.message, 'error'); }
    }

    // Dispatch from row action buttons (event.stopPropagation keeps the row's
    // own primary click from also firing).
    function omniAct(action, idx, ev) {
        if (ev) ev.stopPropagation();
        const it = items[idx];
        if (!it) return;
        switch (action) {
            case 'open': openInWindows(it.path, false); break;
            case 'reveal': openInWindows(it.path, true); break;
            case 'attach': attach(it.path); break;
            case 'copy': copyPath(it.path); break;
            case 'rename': renameItem(it); break;
            case 'dup': duplicate(it); break;
            case 'enter': browseInto(it); break;
        }
    }

    // ── render ────────────────────────────────────────────────────────────────
    function crumbHTML() {
        const rel = relOf(cwd);
        const segs = rel ? rel.split('/') : [];
        let html = `<span class="pc-omni-crumb" onclick="omniCrumb(-1)">PROJECTS</span>`;
        let acc = ROOT;
        segs.forEach((s, i) => {
            acc += '/' + s;
            html += `<span class="pc-omni-crumb-sep">/</span>` +
                `<span class="pc-omni-crumb" onclick="omniCrumb(${i})" data-path="${esc(acc)}">${esc(s)}</span>`;
        });
        return html;
    }

    function rowActionsHTML(it, idx) {
        const b = [];
        b.push(`<button title="Open in Windows" onclick="omniAct('open',${idx},event)">open</button>`);
        if (it.isDir) {
            if (!it.isUp) b.push(`<button title="Enter folder" onclick="omniAct('enter',${idx},event)">enter</button>`);
        } else {
            b.push(`<button title="Reveal in Explorer" onclick="omniAct('reveal',${idx},event)">win</button>`);
            b.push(`<button title="Attach to input" onclick="omniAct('attach',${idx},event)">+</button>`);
        }
        if (!it.isUp) {
            b.push(`<button title="Copy path" onclick="omniAct('copy',${idx},event)">copy</button>`);
            b.push(`<button title="Rename" onclick="omniAct('rename',${idx},event)">ren</button>`);
            if (!it.isDir) b.push(`<button title="Duplicate" onclick="omniAct('dup',${idx},event)">dup</button>`);
        }
        return `<div class="pc-omni-actions">${b.join('')}</div>`;
    }

    function labelHTML(it) {
        if (mode === 'search' && it.rel) {
            const slash = it.rel.lastIndexOf('/');
            const dir = slash >= 0 ? it.rel.slice(0, slash + 1) : '';
            const base = slash >= 0 ? it.rel.slice(slash + 1) : it.rel;
            return `<span class="pc-omni-name">${esc(base)}</span>` +
                (dir ? `<span class="pc-omni-dir">${esc(dir)}</span>` : '');
        }
        return `<span class="pc-omni-name">${esc(it.name)}${it.isDir && !it.isUp ? '/' : ''}</span>`;
    }

    function render(err, truncated) {
        const crumbs = $id('pc-omni-crumbs');
        const list = $id('pc-omni-results');
        const foot = $id('pc-omni-foot');
        if (crumbs) { crumbs.innerHTML = mode === 'browse' ? crumbHTML() : ''; crumbs.style.display = mode === 'browse' ? '' : 'none'; }
        if (!list) return;

        if (err) { list.innerHTML = `<div class="pc-omni-empty" style="color:var(--red)">${esc(err)}</div>`; if (foot) foot.textContent = ''; return; }
        if (!items.length) {
            const input = $id('pc-omni-input');
            const q = input ? input.value.trim() : '';
            list.innerHTML = `<div class="pc-omni-empty">${q ? 'No matches for “' + esc(q) + '”' : 'Empty folder'}</div>`;
            if (foot) foot.textContent = '';
            return;
        }

        list.innerHTML = items.map((it, i) => {
            const icon = it.isUp ? ICON_UP : (it.isDir ? ICON_DIR : ICON_FILE);
            return `<div class="pc-omni-row ${i === sel ? 'sel' : ''} ${it.isDir ? 'is-dir' : ''}" data-i="${i}" onclick="omniRowClick(${i})">
                <span class="pc-omni-ic">${icon}</span>
                <span class="pc-omni-label">${labelHTML(it)}</span>
                ${rowActionsHTML(it, i)}
            </div>`;
        }).join('');

        if (foot) {
            const hint = ' up/dn move · enter ' + (mode === 'search' ? 'open' : 'open/enter dir') + ' · esc close';
            foot.textContent = truncated ? (items.length + '+ results (narrow the search) · ' + hint) : (items.length + ' items · ' + hint);
        }
    }

    // Lightweight re-highlight without rebuilding the list (used by arrow nav).
    render._reselectOnly = function () {
        document.querySelectorAll('.pc-omni-row').forEach(el => {
            el.classList.toggle('sel', Number(el.dataset.i) === sel);
        });
    };

    function omniCrumb(i) {
        const input = $id('pc-omni-input');
        if (input) input.value = '';
        if (i < 0) { browse(ROOT); return; }
        const rel = relOf(cwd).split('/').slice(0, i + 1).join('/');
        browse(ROOT + '/' + rel);
    }

    // ── init / global listeners ───────────────────────────────────────────────
    function bindGlobal() {
        if (bound) return;
        bound = true;
        // click-away closes the panel
        document.addEventListener('mousedown', (e) => {
            if (!isOpen) return;
            const omni = $id('pc-omni');
            if (omni && !omni.contains(e.target)) omniClose();
        });
        // Ctrl/Cmd+K focuses the finder (only in PC mode)
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
                if (!document.body.classList.contains('pc-mode')) return;
                e.preventDefault();
                omniToggle();
            }
        });
    }

    function omniInit() {
        bindGlobal();
        // reset to a clean state each (re)build of the PC layout
        mode = 'browse'; cwd = ROOT; items = []; sel = 0; isOpen = false;
        const input = $id('pc-omni-input');
        if (input) input.value = '';
    }

    // ── exports (called from inline handlers injected by desktop.js) ──────────
    Object.assign(window, {
        omniInit, omniOpen, omniClose, omniToggle,
        omniOnInput, omniOnKeydown, omniRowClick, omniAct, omniCrumb,
    });
})();
