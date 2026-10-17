#!/usr/bin/env node
// One-time extraction of Leon's outgoing Slack messages into voice_messages.
//
// Uses SLACK_USER_TOKEN (xoxp-) with search:read scope to fetch the last N
// messages Leon SENT (search.messages?query=from:@me). For each, resolves the
// recipient (the DM peer or channel name) so draftEngine can filter retrieval
// by "who Leon was talking to".
//
// Run with:
//   node scripts/extract-voice-corpus.js [--limit 500] [--since 2026-01-01]
//
// Idempotent: voice_messages has UNIQUE(sender_id, timestamp, channel) so
// re-running won't dupe.

const path = require('path');
const fs = require('fs');
const https = require('https');

// Load .env the same way server.js does.
try {
    const envPath = path.join(__dirname, '..', '.env');
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
} catch (e) {
    console.error('failed to load .env:', e.message);
}

const db = require('../lib/dispatcher/db');

const TOKEN = process.env.SLACK_USER_TOKEN;
const LEON_ID = process.env.LEON_SLACK_USER_ID;

if (!TOKEN || !TOKEN.startsWith('xoxp-')) {
    console.error('SLACK_USER_TOKEN missing or not a user token (xoxp-)');
    process.exit(1);
}
if (!LEON_ID) {
    console.error('LEON_SLACK_USER_ID missing');
    process.exit(1);
}

// ── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name, def) {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const LIMIT = Number(argVal('limit', 500));
const SINCE = argVal('since', '2026-01-01'); // ISO date

console.log(`extract limit=${LIMIT}, since=${SINCE}`);

// ── Slack API helper ────────────────────────────────────────────────────
function slack(method, params = {}) {
    return new Promise((resolve, reject) => {
        const qs = Object.entries(params)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        const reqPath = `/api/${method}${qs ? '?' + qs : ''}`;
        const req = https.request({
            host: 'slack.com',
            path: reqPath,
            method: 'GET',
            headers: { Authorization: `Bearer ${TOKEN}` },
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (!json.ok) return reject(new Error(`${method}: ${json.error || 'unknown'}`));
                    resolve(json);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => req.destroy(new Error('slack timeout')));
        req.end();
    });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Caches ──────────────────────────────────────────────────────────────
const userCache = new Map();   // userId -> { id, name, real_name }
const channelCache = new Map(); // channelId -> { id, name, is_im, peer? }

async function getUser(userId) {
    if (userCache.has(userId)) return userCache.get(userId);
    try {
        const { user } = await slack('users.info', { user: userId });
        const u = { id: user.id, name: user.profile.display_name || user.profile.real_name || user.name, real_name: user.profile.real_name };
        userCache.set(userId, u);
        return u;
    } catch {
        userCache.set(userId, { id: userId, name: userId, real_name: userId });
        return userCache.get(userId);
    }
}

async function getChannel(channelId) {
    if (channelCache.has(channelId)) return channelCache.get(channelId);
    try {
        const { channel } = await slack('conversations.info', { channel: channelId });
        const c = { id: channel.id, name: channel.name || null, is_im: !!channel.is_im, is_mpim: !!channel.is_mpim, is_private: !!channel.is_private };
        // For DMs, peer = the other user
        if (channel.is_im) {
            try {
                const { members } = await slack('conversations.members', { channel: channelId, limit: 5 });
                const others = (members || []).filter(m => m !== LEON_ID);
                if (others[0]) {
                    const peer = await getUser(others[0]);
                    c.peer = peer;
                }
            } catch {}
        }
        channelCache.set(channelId, c);
        return c;
    } catch {
        channelCache.set(channelId, { id: channelId, name: null, is_im: false });
        return channelCache.get(channelId);
    }
}

// ── Sanitize Slack markup ───────────────────────────────────────────────
function strip(text) {
    return String(text || '')
        .replace(/<@U[A-Z0-9]+>/g, '')
        .replace(/<#C[A-Z0-9]+\|[^>]+>/g, '')
        .replace(/<(https?:\/\/[^>|]+)(\|[^>]+)?>/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function looksLikeUseful(text) {
    const s = String(text || '').trim();
    if (!s || s.length < 4) return false;
    if (/^https?:\/\//i.test(s)) return false;
    if (/^\//.test(s)) return false;
    if (/^[\s\p{Emoji}\p{P}]+$/u.test(s)) return false;
    return true;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
    db.init();
    console.log(`my user id: ${LEON_ID}`);

    // search.messages with user-token can take "from:<my_user_id>". The web UI
    // uses "from:@me" but the API needs the user ref. We use "from:<@user_id>".
    const query = `from:<@${LEON_ID}> after:${SINCE}`;
    const PAGE_SIZE = 100;
    const pages = Math.ceil(LIMIT / PAGE_SIZE);

    let inserted = 0, skipped = 0, processed = 0;
    const recipientStats = {};

    for (let page = 1; page <= pages; page++) {
        let r;
        try {
            r = await slack('search.messages', {
                query, count: PAGE_SIZE, page,
                sort: 'timestamp', sort_dir: 'desc',
            });
        } catch (e) {
            console.error(`search page ${page} failed:`, e.message);
            break;
        }
        const matches = r.messages?.matches || [];
        if (!matches.length) {
            console.log(`page ${page}: no more results, stopping`);
            break;
        }
        console.log(`page ${page}/${pages}: ${matches.length} messages`);

        for (const m of matches) {
            processed++;
            const cleanText = strip(m.text);
            if (!looksLikeUseful(cleanText)) { skipped++; continue; }

            const channelId = m.channel?.id;
            if (!channelId) { skipped++; continue; }

            const channel = await getChannel(channelId);
            // recipient: DM peer name, or channel name, or 'group'
            let recipientId, recipientLabel;
            if (channel.is_im && channel.peer) {
                recipientId = channel.peer.id;
                recipientLabel = channel.peer.name;
            } else if (channel.is_mpim) {
                recipientId = `mpim:${channelId}`;
                recipientLabel = `mpim:${channelId.slice(-6)}`;
            } else {
                recipientId = `channel:${channelId}`;
                recipientLabel = channel.name ? `#${channel.name}` : `channel:${channelId.slice(-6)}`;
            }
            recipientStats[recipientLabel] = (recipientStats[recipientLabel] || 0) + 1;

            try {
                db.insertVoiceMessage({
                    text: cleanText,
                    channel: channel.name || channelId,
                    recipient_id: recipientId,
                    sender_id: LEON_ID,
                    timestamp: Math.floor(Number(m.ts) * 1000),
                    is_seed: 1,
                    weight: 3.0, // between live (1) and manual seed channel (5)
                });
                inserted++;
            } catch (e) {
                skipped++;
            }
            if (inserted >= LIMIT) break;
        }
        if (inserted >= LIMIT) break;
        // Slack rate-limit on Tier 3 = 50 rpm; be polite.
        await sleep(1300);
    }

    console.log('\n=== DONE ===');
    console.log(`processed: ${processed}`);
    console.log(`inserted:  ${inserted}`);
    console.log(`skipped:   ${skipped}`);
    console.log('\ntop recipients:');
    const sorted = Object.entries(recipientStats).sort((a, b) => b[1] - a[1]).slice(0, 15);
    sorted.forEach(([name, n]) => console.log(`  ${String(n).padStart(4)}  ${name}`));
    const stats = db.getVoiceStats();
    console.log(`\nvoice_messages total now: ${stats.total} (embedded: ${stats.embedded})`);
    console.log('\nthe voiceEmbeddings worker will pick these up automatically on next server tick.');
    console.log('to force embed now: restart server.js — it kicks off an immediate batch.');
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
