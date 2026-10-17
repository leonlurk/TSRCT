// terminal-images.js -- render image file paths found in terminal output as
// actual inline images (chat-style), on both the mobile and PC terminals.
//
// Why this exists: Claude Code (and you) reference images by path in the pane.
// This scans the captured frame, and where a real image path appears it splices
// an <img> next to the path text so you see the picture in the flow.
//
// Features:
//  - Detects absolute (/), home (~/) and relative (./) image paths; handles
//    spaces (e.g. "Captura de pantalla ....png"); comma-separates multi-attach.
//  - Consecutive images (the "[Images attached: a, b, c]" block) collapse into a
//    CAROUSEL: one image shown, prev/next arrows + counter.
//  - Click any image to open a full-screen LIGHTBOX (click / Esc to close).
//  - Per-frame DEDUPE: the same path (your echo + Claude's Read line) renders the
//    image only once; repeats stay as plain path text.
//  - Images load as AUTHED blobs (GET /api/termimg) -> object URLs, cached per
//    path, so the 5s poll never refetches and unchanged frames never repaint.
//  - Fail-closed: if a file doesn't resolve server-side, the <img> is dropped and
//    the original path text stays -- identical to the pre-feature behaviour.
//
// Design notes / honest limit: the pane is a fixed-width TUI. A path longer than
// the row WRAPS across two rows and cannot be reassembled -- those won't render.
// (~/.tmux.conf default-size is widened to 140 cols to minimise this.)
//
// Exposes window.TermImg = { write(el, rawText), hydrate(el) }.
(function () {
    'use strict';

    // Extension-anchored path matcher. Starts at an absolute (/), home (~/) or
    // relative (./) root, allows spaces, and is bounded on both sides by a
    // delimiter -- INCLUDING comma, so "a.png, b.png" splits into two paths
    // instead of matching as one over-long span.
    var IMG_RE = /(^|[\s"'`(<\[|,])((?:\/|~\/|\.\/)[^\n"'`<>|,]*?\.(?:png|jpe?g|gif|webp|bmp|svg))(?=$|[\s"'`)>\]|,])/gim;

    var cache = new Map();       // path -> objectURL | 'PENDING' | 'FAIL'
    var lastRaw = new WeakMap(); // el -> last raw text (skip repaint == no flicker)
    var wired = new WeakSet();   // el -> click delegation attached
    var carouselIdx = new Map(); // carousel key -> active index (survives repaint)

    function esc(s) {
        return (typeof escapeHtml === 'function')
            ? escapeHtml(s)
            : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ---- detection + grouping -------------------------------------------------

    function detect(raw) {
        var hits = [], m;
        IMG_RE.lastIndex = 0;
        while ((m = IMG_RE.exec(raw))) {
            var lead = m[1] || '';
            var p = m[2];
            var start = m.index + lead.length;
            hits.push({ start: start, end: start + p.length, path: p });
        }
        return hits;
    }

    // Coalesce hits separated only by commas/whitespace into one carousel group.
    function group(raw, hits) {
        var groups = [], cur = null;
        for (var i = 0; i < hits.length; i++) {
            var h = hits[i];
            if (cur && /^[\s,]*$/.test(raw.slice(cur.end, h.start))) {
                cur.paths.push(h.path); cur.end = h.end; continue;
            }
            if (cur) groups.push(cur);
            cur = { start: h.start, end: h.end, paths: [h.path] };
        }
        if (cur) groups.push(cur);
        return groups;
    }

    // ---- html builders --------------------------------------------------------

    function imgTag(p, extra) {
        return '<img class="term-img' + (extra || '') + '" alt="" loading="lazy" ' +
               'data-tipath="' + esc(encodeURIComponent(p)) + '">';
    }

    function blockHtml(p) {
        return '<span class="term-img-block">' +
                   '<span class="term-img-path">' + esc(p) + '</span>' +
                   imgTag(p, '') +
               '</span>';
    }

    function carouselHtml(paths) {
        var key = paths.join('|');
        var idx = carouselIdx.get(key) || 0;
        if (idx >= paths.length) idx = 0;
        var slides = paths.map(function (p, i) {
            return imgTag(p, ' tic-slide' + (i === idx ? ' active' : ''));
        }).join('');
        return '<span class="term-img-carousel" data-idx="' + idx + '" data-key="' + esc(key) + '">' +
                   '<span class="term-img-path tic-path">' + esc(paths[idx]) + '</span>' +
                   '<span class="tic-viewport">' + slides + '</span>' +
                   '<span class="tic-bar">' +
                       '<button class="tic-nav tic-prev" type="button" aria-label="prev">&#8249;</button>' +
                       '<span class="tic-count">' + (idx + 1) + '/' + paths.length + '</span>' +
                       '<button class="tic-nav tic-next" type="button" aria-label="next">&#8250;</button>' +
                   '</span>' +
               '</span>';
    }

    function buildHtml(raw) {
        var hits = detect(raw);
        if (!hits.length) return { html: esc(raw), found: false };
        var groups = group(raw, hits);
        var out = '', cursor = 0, found = false, seen = Object.create(null);
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            out += esc(raw.slice(cursor, g.start));
            var fresh = g.paths.filter(function (p) { return !seen[p]; });
            if (fresh.length) {
                fresh.forEach(function (p) { seen[p] = true; });
                out += (fresh.length === 1) ? blockHtml(fresh[0]) : carouselHtml(fresh);
                found = true;
            } else {
                out += esc(raw.slice(g.start, g.end)); // whole group already shown -> plain text
            }
            cursor = g.end;
        }
        out += esc(raw.slice(cursor));
        return { html: found ? out : esc(raw), found: found };
    }

    // ---- image hydration (authed blob -> object URL, cached) ------------------

    function hydrate(el) {
        if (!el) return;
        var imgs = el.querySelectorAll('img.term-img[data-tipath]');
        for (var i = 0; i < imgs.length; i++) {
            (function (img) {
                if (img.getAttribute('data-tidone')) return;
                var p;
                try { p = decodeURIComponent(img.getAttribute('data-tipath')); } catch (e) { return; }
                var c = cache.get(p);
                if (c === 'FAIL') { dropImg(img); return; }
                if (typeof c === 'string') { img.src = c; img.setAttribute('data-tidone', '1'); return; }
                if (c === 'PENDING') return;
                cache.set(p, 'PENDING');
                var auth = (typeof token !== 'undefined' && token) ? { Authorization: token } : {};
                fetch('/api/termimg?path=' + encodeURIComponent(p), { headers: auth })
                    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
                    .then(function (b) {
                        var u = URL.createObjectURL(b);
                        cache.set(p, u);
                        img.src = u;
                        img.setAttribute('data-tidone', '1');
                    })
                    .catch(function () { cache.set(p, 'FAIL'); dropImg(img); });
            })(imgs[i]);
        }
    }

    function dropImg(img) {
        var block = img.closest ? img.closest('.term-img-block, .term-img-carousel') : null;
        // Inside a carousel a single failed slide just vanishes; a lone block loses
        // its image but keeps the path caption (== pre-feature behaviour).
        if (img.parentNode) img.parentNode.removeChild(img);
        if (block) block.classList.add('term-img-missing');
    }

    // ---- interaction: carousel nav + lightbox (event delegation, wired once) --

    function ensureDelegation(el) {
        if (!el || wired.has(el)) return;
        wired.add(el);
        el.addEventListener('click', function (e) {
            var nav = e.target.closest && e.target.closest('.tic-nav');
            if (nav) { e.preventDefault(); e.stopPropagation(); navCarousel(nav); return; }
            var img = e.target.closest && e.target.closest('.term-img');
            if (img && img.src) { openLightbox(img.src); }
        });
    }

    function navCarousel(navBtn) {
        var car = navBtn.closest('.term-img-carousel');
        if (!car) return;
        var slides = car.querySelectorAll('.tic-slide');
        if (!slides.length) return;
        var idx = parseInt(car.getAttribute('data-idx'), 10) || 0;
        idx = (idx + (navBtn.classList.contains('tic-next') ? 1 : -1) + slides.length) % slides.length;
        car.setAttribute('data-idx', idx);
        for (var i = 0; i < slides.length; i++) slides[i].classList.toggle('active', i === idx);
        var cnt = car.querySelector('.tic-count');
        if (cnt) cnt.textContent = (idx + 1) + '/' + slides.length;
        var cap = car.querySelector('.tic-path');
        if (cap) { try { cap.textContent = decodeURIComponent(slides[idx].getAttribute('data-tipath')); } catch (e) {} }
        var key = car.getAttribute('data-key');
        if (key) carouselIdx.set(key, idx);
    }

    var lb = null;
    function lightbox() {
        if (lb) return lb;
        lb = document.createElement('div');
        lb.className = 'term-img-lightbox';
        lb.innerHTML = '<img class="term-img-lightbox-img" alt="">';
        lb.addEventListener('click', close);
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
        document.body.appendChild(lb);
        return lb;
        function close() { if (lb) lb.classList.remove('open'); }
    }
    function openLightbox(src) {
        var l = lightbox();
        l.querySelector('.term-img-lightbox-img').src = src;
        l.classList.add('open');
    }

    // ---- keeping the bottom while images are on screen -------------------------
    // Every changed frame (a working session changes every poll) rebuilt the
    // innerHTML, so each <img> was a NEW node with zero height until it decoded:
    // the pane scrolled to a bottom that was one image too short, then the image
    // came back and pushed the tail out of view. You could not stay at the bottom
    // while a screenshot was on screen (2026-10-05). Two fixes:
    //  1. the already-loaded <img> nodes are moved into the new frame, so they keep
    //     their size and the frame never collapses;
    //  2. a pane pinned to the bottom stays pinned when a first-time image loads
    //     (growth fires no scroll event, so `pinned` still says where you were).

    var pinned = new WeakMap(); // el -> was the user at the bottom (last scroll)
    var SLOP = 40;
    function isAtBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < SLOP; }

    function trackPin(el) {
        if (pinned.has(el)) return;
        pinned.set(el, true);
        el.addEventListener('scroll', function () { pinned.set(el, isAtBottom(el)); }, { passive: true });
    }

    function harvest(el) {
        var keep = new Map();
        var imgs = el.querySelectorAll('img.term-img[data-tidone]');
        for (var i = 0; i < imgs.length; i++) keep.set(imgs[i].getAttribute('data-tipath'), imgs[i]);
        return keep;
    }

    function reuse(el, keep) {
        if (!keep.size) return;
        var imgs = el.querySelectorAll('img.term-img[data-tipath]');
        for (var i = 0; i < imgs.length; i++) {
            var old = keep.get(imgs[i].getAttribute('data-tipath'));
            if (!old) continue;
            old.className = imgs[i].className; // carousel .active comes from the new frame
            imgs[i].parentNode.replaceChild(old, imgs[i]);
        }
    }

    function stickOnLoad(el) {
        var imgs = el.querySelectorAll('img.term-img[data-tipath]:not([data-tidone])');
        for (var i = 0; i < imgs.length; i++) {
            imgs[i].addEventListener('load', function () {
                if (pinned.get(el) !== false && !(window.TermFocus && TermFocus.isFrozen(el))) {
                    el.scrollTop = el.scrollHeight;
                }
            }, { once: true });
        }
    }

    // ---- entry point ----------------------------------------------------------

    function write(el, raw) {
        if (!el) return;
        raw = raw || '';
        ensureDelegation(el);
        trackPin(el);
        if (lastRaw.get(el) === raw) { hydrate(el); return; } // unchanged frame
        lastRaw.set(el, raw);
        var built = buildHtml(raw);
        var keep = harvest(el);
        var painted;
        if (window.TermFocus && typeof TermFocus.write === 'function') {
            painted = TermFocus.write(el, built.html, true);
        } else {
            el.innerHTML = built.html;
            painted = true;
        }
        if (painted) {
            reuse(el, keep);
            if (pinned.get(el) !== false) el.scrollTop = el.scrollHeight;
        }
        stickOnLoad(el);
        hydrate(el);
    }

    window.TermImg = { write: write, hydrate: hydrate };
})();
