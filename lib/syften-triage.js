// ─────────────────────────────────────────────────────────────────────────
// syften-triage.js — decides which Syften mentions are worth Leon's time.
//
// Syften's job ends at "this post matched a keyword". That is not the same
// question as "is this worth answering", and the gap is expensive: measured
// 2026-08-31 over 227 matches, 40% were junk that no keyword change could fix
// and 14% were the SAME url billed to several filters.
//
// So the rrestrictedg happens here, not there. Two rules from that measurement:
//
//   1. A filter's precision is read in the COMMUNITY it lands in, never in how
//      the phrase sounds. `"forgot to bill"` sounds like the highest-intent
//      term in the set; its 9 matches were r/Seattle, r/askatherapist and
//      r/paralegal. That is why ROOMS carry more weight here than keywords.
//   2. If the topic does not interest you, you do not comment (Leon, 08-24).
//      A shortlist that hands back twenty "maybe" is the same as no shortlist,
//      so this scores to a SHORTLIST, and unknown rooms stay neutral rather
//      than being flattered into it.
//
// Every score carries its reasons, because a rrestrictedg you cannot audit gets
// ignored the first time it is wrong.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

// ── rooms, from measurement only ─────────────────────────────────────────
// These are the communities where matches ACTUALLY landed between 22-Aug and
// 01-Sep. Nothing here is guessed: a room nobody has seen yet scores 0, which
// is the honest answer, and it shows up in the reasons as "unknown room".
const GOOD_ROOMS = new Set([
    // ACME — real business / buyer rooms
    'r/smallbusiness_us', 'r/smallbusiness', 'r/agency', 'r/crm', 'r/digitalmarketing',
    'r/freelancers', 'r/freelanceuk', 'r/freelancing', 'r/remotework', 'r/clickup',
    'r/bookkeepingjobs', 'r/micro_saas', 'r/sideproject', 'r/copywriting',
    'r/softwaresworthpaying', 'r/timetrackingsoftware', 'r/accounting', 'r/msp',
    // ACME — a competitor's own subreddit is where its unhappy users complain
    'r/harvestapp', 'r/clockify', 'r/breezepm', 'r/asana', 'r/netsuite', 'r/erpkit',
    // PV — skincare rooms with real sufferers
    'r/skincareaddiction', 'r/skincareaddicts', 'r/sensitiveskinsurvival',
    'r/asianbeauty', 'r/sephora', 'r/makeup', 'r/euroskincare', 'r/koreanskincare',
    'r/eczema', 'r/hidradenitis', 'r/beauty', 'r/soap', 'r/pregnant',
]);

// Rooms a match has already been proven to land in for the WRONG reason. Each
// one cost us a real match at least once.
const BAD_ROOMS = new Set([
    // "agency" = government / nursing, not marketing
    'r/askconservatives', 'r/travelnursing', 'r/graphic_design', 'r/washingtondc',
    // "forgot to bill" = an everyday sentence
    'r/seattle', 'r/askatherapist', 'r/paralegal', 'r/southindia_', 'r/indiatech',
    'r/indianfocus', 'r/repairshopowners', 'r/hookit', 'r/lawfirm',
    // product names with a much bigger life elsewhere
    'r/maidyiff', 'r/myhomeworkdone', 'r/barefootshoestalk', 'r/rucking',
    'r/physicaltherapy', 'r/indiangaming', 'r/mildlyinfuriating', 'r/mountaindew',
    'r/medicalmedium', 'r/perfumes', 'r/craftfairs', 'r/blacklgbt', 'r/13or30',
    'r/glp1researchtalk', 'r/hyprland', 'r/fightgear', 'r/cleaningtips',
    'r/mulund', 'r/askanything', 'r/chatgpt', 'r/workonlineindia', 'r/mongolia',
    'r/askvenezuela', 'r/dkstartup', 'r/zzpnederland', 'r/keito', 'r/toboddah',
]);

// ── sources ──────────────────────────────────────────────────────────────
// Reddit is where every usable lead of the measured set came from. Bluesky and
// Mastodon produced matches but not one conversation, so they are ranked down
// rather than dropped — "never seen a good one" is not "cannot have one".
const BACKEND_SCORE = {
    'reddit': 2,
    'hacker news': 1, 'hackernews': 1, 'hn': 1,
    'indie hackers': 1, 'indiehackers': 1,
    'lobsters': 1, 'stack exchange': 1, 'stackexchange': 1,
    'product hunt': 0, 'producthunt': 0, 'forums': 0, 'newsletters': 0,
    'bluesky': -2, 'mastodon': -2, 'steemit': -2,
};

// ── filters, from measurement only ───────────────────────────────────────
// Precision actually observed, 22-Aug → 01-Sep. Anything not listed is a
// filter we have no verdict on yet and scores 0.
const FILTER_SCORE = {
    // clean: every match landed in a room we would want to be in
    '"strips my skin"': 3,          // 7 of 7 real skincare rooms
    '"stripped my skin"': 3,        // 2 of 2
    'soap "dries my skin"': 3,      // 3, incl. the best loose lead of the set
    'scoro': 3,                     // 11, mostly real business rooms
    '"profit per client"': 3,       // 7, freelancer rooms
    '"can\'t pronounce" skincare': 2,
    '"can\'t pronounce" soap': 2,
    '"body wash" "dries my skin"': 2,
    // the wedge: it produces, but a lot of it was never Reddit
    'clickup billing': 1,
    'clickup invoicing': 1,
    'clickup quickbooks': 1,
    'harvest invoicing': 1,         // value is r/HarvestApp specifically
    'clockify invoice': 1,
    'toggl invoice': 1,
    // on-message but barely tested
    '"unbilled hours"': 0,
    '"client profitability"': 0,
    // brand terms: rare by definition, and every one matters
    'acmecloudco': 4,
    '"acme cloud co"': 4,
    '"verde soap"': 4,
    'verdesoap': 4,
};

// A post that ASKS is answerable; a post that states is not an opening.
const ASKING = /\?|\b(anyone|anybody|any one|recommend|suggestions?|advice|help|how do|how does|how can|how are|how is|what do you|what are you|which one|which is|looking for|alternative to|better than|struggling|frustrated|hate|tired of|sick of|any tips|thoughts on)\b/i;

// A person with a problem asks once. Someone who posts the same question into
// five rooms in two days is running a campaign — a survey, lead farming, or the
// exact thing we are doing. Found on the first real run: `Specialist_Roof2124`
// posted "freelancers with 3+ regular clients…" into r/Freelancers (twice),
// r/freelanceuk, r/freelancing and r/remotework, and it took HALF the shortlist.
const BROADCAST_ROOMS = 3;

// Job boards ride on the same words we buy. "[For Hire] Bookkeeper | QuickBooks
// & Xero" hits three of our filters and is nobody to talk to.
const JOB_AD = /^\s*\[?\s*(for\s*hire|hiring|hire\s*me|job|paid|task)\b|\bfor\s*hire\b|\bwe\s*are\s*hiring\b/i;

function norm(s) { return String(s || '').trim().toLowerCase(); }

// Same thread reached by two different-looking links is one thread.
//
// On Reddit that mostly means COMMENT PERMALINKS. Syften hands us a separate
// link per matching comment, so one busy thread arrived three times — the post
// plus two comments under it — and would have cost three page loads out of a
// budget of 25 to read the same page. Everything under /comments/<id>/ folds
// into that id.
function canonUrl(u) {
    let s = norm(u);
    if (!s) return '';
    s = s.split('#')[0].split('?')[0];
    s = s.replace(/^https?:\/\//, '').replace(/^(www|old|new|np)\./, '');
    s = s.replace(/\/+$/, '');
    const m = s.match(/^(reddit\.com\/r\/[^/]+\/comments\/[^/]+)/);
    return m ? m[1] : s;
}

// The url we should actually open: the thread, never a comment permalink.
function threadUrl(u) {
    const c = canonUrl(u);
    return /^reddit\.com\/r\//.test(c) ? `https://www.${c}/` : u;
}

// Titles differ slightly between rooms ("have you actually calculated…" vs
// "anyone actually calculated…"), so compare on the durable words only.
function titleKey(t) {
    return norm(t).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
        .filter(w => w.length > 3).slice(0, 8).join(' ');
}

// Reddit threads go cold fast: a first comment on a three-day-old post is read
// by nobody. This is the one signal that DECAYS, so the shortlist reshuffles
// itself over a day without anyone touching it.
function freshnessScore(ts) {
    const t = Date.parse(ts || '');
    if (!Number.isFinite(t)) return { score: 0, reason: null, ageH: null };
    const ageH = (Date.now() - t) / 3600000;
    if (ageH <= 6) return { score: 3, reason: 'under 6h old', ageH };
    if (ageH <= 24) return { score: 2, reason: 'under a day old', ageH };
    if (ageH <= 3 * 24) return { score: 0, reason: null, ageH };
    if (ageH <= 7 * 24) return { score: -2, reason: 'over 3 days old', ageH };
    return { score: -4, reason: 'over a week old — cold', ageH };
}

// ── merge duplicates ─────────────────────────────────────────────────────
// One url billed to four filters is ONE thread to read, not four rows. The
// measured cost was 31 extra matches over 187 unique urls (14%), and in the
// feed it reads as spam, which is worse than the quota it spent.
function mergeByUrl(items) {
    const byUrl = new Map();
    for (const it of items) {
        const key = canonUrl(it.url) || it.id;
        const prev = byUrl.get(key);
        if (!prev) {
            byUrl.set(key, { ...it, filters: it.filter ? [it.filter] : [], dupes: 1 });
            continue;
        }
        prev.dupes++;
        if (it.filter && !prev.filters.includes(it.filter)) prev.filters.push(it.filter);
        // keep the earliest timestamp we saw for the thread
        if (it.ts && (!prev.ts || it.ts < prev.ts)) prev.ts = it.ts;
        // keep the longest body — different filters can carry different excerpts
        if ((it.text || '').length > (prev.text || '').length) prev.text = it.text;
    }
    return [...byUrl.values()];
}

// Collapse one author's cross-post into a single row and mark how wide it went.
// Kept rather than dropped: the widest broadcast in the set was still a real
// question, just not a real person to answer — that is a judgement for the
// shortlist, not something to delete behind Leon's back.
function collapseBroadcasts(items) {
    const groups = new Map();
    for (const it of items) {
        const a = norm(it.author);
        const k = a ? `${a}|${titleKey(it.title)}` : `@${it.id}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
    }
    const out = [];
    for (const g of groups.values()) {
        if (g.length === 1) { out.push({ ...g[0], broadcastRooms: 1, broadcastIn: [] }); continue; }
        // keep the copy in the best room, so the one we show is the one worth opening
        const rooms = [...new Set(g.map(x => x.community).filter(Boolean))];
        const pick = g.slice().sort((a, b) => {
            const ga = GOOD_ROOMS.has(norm(a.community)) ? 1 : 0;
            const gb = GOOD_ROOMS.has(norm(b.community)) ? 1 : 0;
            if (ga !== gb) return gb - ga;
            return String(b.ts || '').localeCompare(String(a.ts || ''));
        })[0];
        const filters = [...new Set(g.flatMap(x => x.filters || []))];
        out.push({ ...pick, filters, broadcastRooms: rooms.length, broadcastIn: rooms });
    }

    // Second pass, by AUTHOR alone. The same person reworded the question for
    // r/remotework ("anyone actually calculated…" instead of "freelancers with
    // 3+ regular clients…") and slipped past the title match. If one account
    // reaches three of our rooms inside two days, it is a campaign whatever it
    // calls itself — we only ever see them because they hit our keywords.
    const byAuthor = new Map();
    for (const it of out) {
        const a = norm(it.author);
        if (!a || a === '[deleted]') continue;
        if (!byAuthor.has(a)) byAuthor.set(a, []);
        byAuthor.get(a).push(it);
    }
    for (const posts of byAuthor.values()) {
        if (posts.length < 2) continue;
        const times = posts.map(p => Date.parse(p.ts || '')).filter(Number.isFinite);
        const spanH = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 3600000 : 0;
        if (spanH > 48) continue;
        const rooms = [...new Set(posts.flatMap(p => p.broadcastIn.length ? p.broadcastIn : [p.community]).filter(Boolean))];
        if (rooms.length < BROADCAST_ROOMS) continue;
        for (const p of posts) { p.broadcastRooms = rooms.length; p.broadcastIn = rooms; }
    }
    return out;
}

// ── score one lead ───────────────────────────────────────────────────────
function scoreOne(it) {
    const reasons = [];
    // Dropping a lead is decided by these, never by the score. A low score is
    // "we have no reason to think this is good"; a flag is "we have positive
    // evidence it is dead". Only the second one may bin something unseen.
    const flags = { badRoom: false, jobAd: false, broadcast: false };
    let score = 0;

    const room = norm(it.community);
    if (room && GOOD_ROOMS.has(room)) { score += 4; reasons.push(`${it.community} is a room we want to be in`); }
    else if (room && BAD_ROOMS.has(room)) { score -= 5; flags.badRoom = true; reasons.push(`${it.community} has only ever matched by accident`); }
    else if (room) { reasons.push(`${it.community} — unknown room, no verdict yet`); }
    else { score -= 1; reasons.push('no community on the item'); }

    const be = norm(it.backend);
    const bs = BACKEND_SCORE[be];
    if (typeof bs === 'number') {
        score += bs;
        if (bs < 0) reasons.push(`${it.backend} has never produced a conversation`);
    }

    // Best of the filters that hit it — a thread caught by one good filter and
    // three noisy ones is still a good thread.
    let best = 0, bestName = null;
    for (const f of (it.filters || [])) {
        const fs = FILTER_SCORE[norm(f)] ?? FILTER_SCORE[f];
        if (typeof fs === 'number' && fs > best) { best = fs; bestName = f; }
    }
    if (best > 0) { score += best; reasons.push(`\`${bestName}\` is a filter that has paid off`); }

    const hay = `${it.title || ''} ${it.text || ''}`;
    if (ASKING.test(hay)) { score += 3; reasons.push('the post is asking, not stating'); }
    else reasons.push('nobody is asking anything here');

    const fr = freshnessScore(it.ts);
    score += fr.score;
    if (fr.reason) reasons.push(fr.reason);

    // A thread found by four keywords at once is usually a "what are you
    // building" roundup, not a person with a problem. Measured: two r/micro_saas
    // threads collected 5 matches each.
    if ((it.dupes || 1) >= 3) { score -= 2; reasons.push(`${it.dupes} filters hit it — usually a roundup thread, not a person`); }

    if ((it.broadcastRooms || 1) >= BROADCAST_ROOMS) {
        score -= 6; flags.broadcast = true;
        reasons.push(`same author posted this in ${it.broadcastRooms} rooms — a campaign, not a person`);
    } else if ((it.broadcastRooms || 1) > 1) {
        score -= 2;
        reasons.push(`also posted in ${it.broadcastIn.join(', ')}`);
    }

    if (JOB_AD.test(it.title || '')) { score -= 6; flags.jobAd = true; reasons.push('it is a job ad, not somebody with a problem'); }

    if (norm(it.type) === 'comment') { score -= 1; reasons.push('it is a comment, not a post'); }

    return {
        ...it, score, reasons, flags,
        dead: flags.badRoom || flags.jobAd || flags.broadcast,
        readUrl: threadUrl(it.url),
        ageHours: fr.ageH === null ? null : Math.round(fr.ageH),
    };
}

// ── public surface ───────────────────────────────────────────────────────
// WORTH is deliberately high. The failure this exists to prevent is a list of
// twenty maybes, which is what the raw feed already is.
const WORTH = 7;

function triage(items, opts) {
    const o = opts || {};
    const limit = o.limit || 8;
    const scored = collapseBroadcasts(mergeByUrl(items || [])).map(scoreOne).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(b.ts || '').localeCompare(String(a.ts || ''));
    });
    const shortlist = scored.filter(i => i.score >= WORTH).slice(0, limit);
    return {
        shortlist,
        rest: scored.filter(i => !shortlist.includes(i)),
        counts: {
            raw: (items || []).length,
            unique: scored.length,
            merged: (items || []).length - scored.length,
            worth: shortlist.length,
        },
        threshold: WORTH,
    };
}

module.exports = { triage, scoreOne, mergeByUrl, canonUrl, threadUrl, WORTH, GOOD_ROOMS, BAD_ROOMS, FILTER_SCORE };
