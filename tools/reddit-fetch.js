#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// reddit-fetch.js — reads threads Syften already delivered. Nothing else.
//
// 🔴 THIS IS NOT A CRAWLER, AND THE DIFFERENCE IS THE WHOLE POINT.
// It opens a list of urls handed to it on stdin and stops. It does not search,
// does not list a subreddit, does not follow a single link off the page, and
// cannot discover a post nobody paid Syften to find. The daily list is ~20
// links — fewer pages than Leon opens by hand reading the same feed.
//
// 🔴 IT CANNOT WRITE. Enforced, not promised: every non-GET request is aborted
// at the network layer, and any navigation toward login/submit/vote is refused.
// There is no session and no cookie — measured 2026-09-01, four real thread
// urls returned HTTP 200 with full text while plain curl got 403 on the same
// links, so the logged-out browser is enough and `u/leonbuilds` is never
// touched by this.
//
// Runs as a CHILD PROCESS on purpose. Chrome is the heaviest thing on an 11 GB
// laptop; isolated here it can hang, leak or crash without taking the TSRCT
// server with it. One browser, one page, one url at a time — never a burst.
//
// Contract: JSON job on stdin -> JSON result on stdout. stderr is progress.
//   in : {"urls":[...], "gapMs":6000, "max":25, "timeoutMs":45000}
//   out: {"ok":true,"pages":[{url,ok,status,...}],"stopped":<reason|null>}
//   progress (stderr, one per line, before AND after each page):
//        [reddit-fetch] 2/7 opening https://www.reddit.com/r/…
//        [reddit-fetch] 2/7 done ok 4310ms
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const path = require('path');
const paths = require('../lib/paths');

// puppeteer-core is not a TSRCT dependency: this reuses the install that already
// drives every screenshot on this machine, so nothing new is added to the tree.
const PUP = process.env.PUPPETEER_CORE_PATH
    || path.join(paths.HEADLESS_DIR, 'node_modules/puppeteer-core');
const CHROME = process.env.CHROME_SHELL_PATH
    || path.join(paths.HEADLESS_DIR, 'chs/chrome-headless-shell-linux64/chrome-headless-shell');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Reddit answers a rate problem with a block page rather than a 429. Seeing it
// means STOP the whole run — pushing past it is what turns a slow reader into
// a banned one.
const BLOCK_RE = /blocked by network security|whoa there|too many requests|rate ?limit/i;
// Age-gated rooms demand a login. We skip them instead. Logging in is the one
// thing this tool must never learn to do.
const GATE_RE = /mature content|log in to confirm your age|nsfw/i;
// Anything that could change state, even by accident.
const WRITE_PATH_RE = /\/(login|register|submit|api\/(vote|comment|submit|save|subscribe)|settings)\b/i;

function readStdin() {
    return new Promise((resolve, reject) => {
        let raw = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', c => { raw += c; });
        process.stdin.on('end', () => {
            try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); }
        });
        process.stdin.on('error', reject);
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The progress stream. One line per event on stderr, in a shape the parent can
// parse without guessing:  [reddit-fetch] 2/7 opening https://…
// stdout stays exactly one JSON blob — mixing progress into it would break the
// caller's JSON.parse, which is why this goes to stderr and not to stdout.
function say(n, total, stage, detail) {
    try { process.stderr.write(`[reddit-fetch] ${n}/${total} ${stage} ${detail || ''}\n`); }
    catch { /* a closed pipe must never stop the read */ }
}

// Pull the thread apart into the things that decide "is this worth answering".
// Runs inside the page. Selector-first with a text fallback, because Reddit
// renames its custom elements and a reader that dies on a rename is a reader
// that silently returns nothing.
function extract() {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const bodyText = document.body ? document.body.innerText : '';

    const postEl = document.querySelector('shreddit-post');
    const commentEls = [...document.querySelectorAll('shreddit-comment')];

    const comments = commentEls.slice(0, 12).map(el => ({
        author: el.getAttribute('author') || '',
        score: Number(el.getAttribute('score') || 0),
        depth: Number(el.getAttribute('depth') || 0),
        text: clean((el.innerText || '').slice(0, 700)),
    })).filter(c => c.text);

    const declared = postEl ? Number(postEl.getAttribute('comment-count') || 0) : 0;

    return {
        title: clean(postEl?.getAttribute('post-title') || document.title.split(' : ')[0]),
        subreddit: clean(postEl?.getAttribute('subreddit-prefixed-name') || ''),
        author: clean(postEl?.getAttribute('author') || ''),
        createdAt: postEl?.getAttribute('created-timestamp') || '',
        score: Number(postEl?.getAttribute('score') || 0),
        commentCount: declared || commentEls.length,
        commentsRead: comments.length,
        flair: clean(postEl?.getAttribute('post-flair-text') || ''),
        // A locked or archived thread cannot be replied to. Reading one is work
        // with no possible outcome, so it is reported and dropped upstream.
        //
        // Read the POST's own attribute and only when it says something. The
        // first version asked `document.querySelector('[locked]')`, which is
        // true on every thread on Reddit: each comment carries a
        // <shreddit-comment-badges locked=""> whose attribute is present and
        // empty. It called a live 12-comment thread locked and would have
        // thrown away good leads silently. Attribute PRESENCE is not a value.
        locked: (() => {
            const v = postEl?.getAttribute('locked');
            if (v !== null && v !== undefined && v !== 'false' && v !== '') return true;
            return /this (thread|post) (is|has been) (locked|archived)/i.test(bodyText);
        })(),
        body: clean((postEl?.innerText || bodyText).slice(0, 4000)),
        comments,
        gated: /mature content|log in to confirm your age/i.test(bodyText),
        blocked: /blocked by network security|whoa there|too many requests/i.test(bodyText),
        chars: bodyText.length,
    };
}

async function main() {
    const job = await readStdin();
    const urls = Array.isArray(job.urls) ? job.urls.filter(u => /^https?:\/\//i.test(u)) : [];
    const gapMs = Math.max(3000, Number(job.gapMs) || 6000);   // floor of 3s, never faster
    const max = Math.min(Number(job.max) || 25, 40);           // hard ceiling
    const timeoutMs = Number(job.timeoutMs) || 45000;

    if (!urls.length) { process.stdout.write(JSON.stringify({ ok: true, pages: [], stopped: null })); return; }

    let puppeteer;
    try { puppeteer = require(PUP); }
    catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: `puppeteer-core not found at ${PUP} — set PUPPETEER_CORE_PATH`, pages: [] }));
        return;
    }

    const browser = await puppeteer.launch({
        executablePath: CHROME,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=en-US',
            '--blink-settings=imagesEnabled=false'],
    });

    const pages = [];
    let stopped = null;

    try {
        const page = await browser.newPage();
        await page.setUserAgent(UA);
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.setViewport({ width: 1280, height: 900 });

        // The read-only guarantee, enforced at the wire. Also drops images,
        // fonts and media — a third of the bytes and none of the meaning, and
        // this laptop has 11 GB.
        await page.setRequestInterception(true);
        page.on('request', r => {
            const u = r.url();
            if (r.method() !== 'GET') return r.abort();
            if (WRITE_PATH_RE.test(u)) return r.abort();
            if (['image', 'media', 'font'].includes(r.resourceType())) return r.abort();
            return r.continue();
        });

        const list = urls.slice(0, max);
        for (const url of list) {
            const started = Date.now();
            // Announced BEFORE the page load, not after. A line that only exists
            // once the page is done cannot tell "still loading number 3" apart
            // from "died on number 3", which is the whole reason the caller is
            // watching this stream.
            say(pages.length + 1, list.length, 'opening', url);
            try {
                const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
                await sleep(2500);   // let the comment elements hydrate
                const d = await page.evaluate(extract);
                const status = resp ? resp.status() : 0;

                if (d.blocked || BLOCK_RE.test(d.body || '')) {
                    // Stop the entire run. Continuing after a block is what turns
                    // "reads slowly" into "is banned".
                    pages.push({ url, ok: false, status, skipped: 'blocked' });
                    stopped = 'reddit returned a block page — run halted, nothing retried';
                    // No `break` here: fall through so the halt is ANNOUNCED on
                    // the progress stream before the loop exits below. A run that
                    // stops without saying why looks identical to a crash.
                } else if (d.gated || GATE_RE.test(d.title || '')) {
                    pages.push({ url, ok: false, status, skipped: 'age-gated — needs a login, so it is skipped' });
                } else if (status >= 400) {
                    pages.push({ url, ok: false, status, skipped: `http ${status}` });
                } else {
                    pages.push({ url, ok: true, status, ms: Date.now() - started, ...d });
                }
            } catch (e) {
                pages.push({ url, ok: false, status: 0, skipped: e.message.slice(0, 160) });
            }
            const last = pages[pages.length - 1] || {};
            say(pages.length, list.length, 'done',
                `${last.ok ? 'ok' : (last.skipped || 'failed')} ${Date.now() - started}ms`);
            if (stopped) break;
            await sleep(gapMs);
        }
    } catch (e) {
        stopped = 'browser error: ' + e.message.slice(0, 200);
    } finally {
        try { await browser.close(); } catch { /* already gone */ }
    }

    process.stdout.write(JSON.stringify({ ok: true, pages, stopped }));
}

main().catch(e => {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message, pages: [] }));
    process.exit(1);
});
