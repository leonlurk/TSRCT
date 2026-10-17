'use strict';
// ─────────────────────────────────────────────────────────────────────────
// lib/spotify.js — music that actually PLAYS (2026-10-14).
//
// His words: "no le da play a musica random en spotify cuando le pido que me
// sorprenda o algo, me obliga a tocar play a mi". Every "poneme X en spotify"
// ran spotify_search, which opens the results page and nothing more, and Tesla
// said "Ahi esta." while the room stayed silent.
//
// The Spotify app on his PC ships its own command line, spotify_cli.exe (an app
// alias in WindowsApps): search, play <uri>, shuffle, now-playing. One search
// (~1.2 s), one play, and a read-back of what is REALLY playing - no mouse, no
// screenshot, no model. What to play:
//   - an artist he named (the first artist's name is his words)  -> the artist, shuffled
//   - a song he named (a track whose name starts with his words) -> that song
//   - anything else - a genre, a mood, "algo para concentrarme"  -> a playlist of it, shuffled
//   - nothing, or "sorprendeme"                                    -> a pick from SURPRISE, never a question
// SecretCo: the query is refused before Spotify is touched.
// ─────────────────────────────────────────────────────────────────────────
const os = require('os');
const path = require('path');
const paths = require('./paths');
const { execFile } = require('child_process');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const CLI = process.env.SPOTIFY_CLI || (paths.WIN_HOME ? path.join(paths.WIN_HOME, 'AppData/Local/Microsoft/WindowsApps/spotify_cli.exe') : '');

// What a "sorprendeme" draws from: wide on purpose, and the last few are not repeated.
const SURPRISE = [
    'neo soul', 'bossa nova', 'jazz clasico', 'funk 70s', 'drum and bass liquido', 'lo-fi hip hop', 'afrobeat',
    'french house', 'nu jazz', 'trip hop', 'soul clasico', 'chillwave', 'disco 70s', 'latin jazz', 'acid jazz',
    'downtempo', 'city pop japones', 'rock alternativo 90s', 'reggae roots', 'synthwave', 'cumbia psicodelica',
    'jazz fusion', 'deep house', 'motown', 'indie folk', 'rock nacional argentino', 'ethio jazz', 'tango electronico',
];
// A request with no music in it: "algo", "musica", "sorprendeme", "cualquier cosa".
const NOTHING_NAMED = /^(?:(?:algo|alguna|algun|un poco de|musica|musiquita|cualquier cosa|lo que sea|lo que quieras|random|aleatorio|al azar|sorprendeme|sorprendeme con algo|lo que se te ocurra|elegi vos|vos elegi)\s*)*$/;

let deps = {
    run: (args) => new Promise((resolve, reject) => execFile(CLI, [...args, '--format', 'json'],
        // A Windows exe started from a Linux folder warns about the UNC path; /tmp is quiet.
        { timeout: 20000, windowsHide: true, cwd: os.tmpdir() }, (e, out, err) => e ? reject(new Error(String(err || e.message).trim().slice(0, 200))) : resolve(String(out || '')))),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    random: Math.random,
};
function configure(d) { deps = { ...deps, ...d }; }

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const recent = [];

// Every error here is a sentence for him (lib/actions.js: `soft` is said as it
// is). Without it a closed Spotify reached him as "se rompio algo de mi lado".
function said(msg) { const e = new Error(msg); e.soft = true; return e; }

// Tesla review #16 (2026-10-14): "poneme algo de Bad Omen" failed twice because
// the Spotify APP was closed - the CLI answers "Spotify desktop client is not
// running" to everything, and search() read that as "no results". The CLI can
// launch it (`open`); the client then needs a few seconds before it answers.
const NOT_RUNNING = /not running/i;
let opening = null;
async function cli(args) {
    try { return await deps.run(args); } catch (e) {
        if (!NOT_RUNNING.test(e.message)) throw e;
    }
    if (!opening) {
        opening = (async () => {
            try { await deps.run(['open']); } catch (e) { if (!NOT_RUNNING.test(e.message)) throw said(`no pude abrir Spotify: ${e.message}`); }
            for (let i = 0; i < 15; i++) {
                await deps.sleep(1000);
                try { await deps.run(['status']); return; } catch (e) { if (!NOT_RUNNING.test(e.message)) return; }
            }
            throw said('Spotify estaba cerrado y no termino de abrir: abrilo y probamos de nuevo');
        })().finally(() => { opening = null; });
    }
    await opening;
    try { return await deps.run(args); } catch (e) {
        if (NOT_RUNNING.test(e.message)) throw said('Spotify estaba cerrado y no termino de abrir: abrilo y probamos de nuevo');
        throw e;
    }
}

function surprise() {
    const fresh = SURPRISE.filter(g => !recent.includes(g));
    const pick = fresh[Math.floor(deps.random() * fresh.length)] || SURPRISE[0];
    recent.push(pick);
    if (recent.length > 6) recent.shift();
    return pick;
}

async function search(q, type) {
    const args = ['search', q, '--limit', '5'];
    if (type) args.push('--type', type);
    const out = await cli(args);            // a closed Spotify is opened, never read as "no results"
    try { return JSON.parse(out) || {}; } catch { return {}; }
}

// The search results -> the one thing to play.
async function choose(q) {
    const n = norm(q);
    const all = await search(q);
    // "Bad Omen" is the band Bad Omens: a name he says one or two letters short still counts.
    const artist = (all.artists || []).find(a => norm(a.name) === n)
        || (n.length > 3 && (all.artists || []).find(a => { const m = norm(a.name); return m.startsWith(n) && m.length - n.length <= 2; }));
    if (artist) return { uri: artist.uri, kind: 'artist', name: artist.name, shuffle: true };
    // A song named WITH its band, either order: "linkin park given up", "given up
    // de linkin park". Every word he said is in the title or the artist (2026-10-14:
    // Given Up was Spotify's first result and a playlist played instead).
    const words = n.split(' ').filter(w => w && !/^(de|del|by|of|la|el|the|cancion|tema)$/.test(w));
    const covers = (t) => { const have = new Set(norm(`${t.name} ${(t.artists || []).join(' ')}`).split(' ')); return words.length >= 2 && words.every(w => have.has(w)); };
    const track = (all.tracks || []).find(t => n.length > 3 && norm(t.name).startsWith(n))
        || (all.tracks || []).find(covers);
    if (track) return { uri: track.uri, kind: 'track', name: `${track.name} - ${(track.artists || []).join(', ')}`, shuffle: false };
    const album = (all.albums || []).find(a => n.length > 3 && norm(a.name) === n);
    if (album) return { uri: album.uri, kind: 'album', name: album.name, shuffle: false };
    const lists = await search(q, 'playlist');
    const pl = (lists.playlists || [])[0];
    if (pl) return { uri: pl.uri, kind: 'playlist', name: pl.name, shuffle: true };
    const any = (all.tracks || [])[0];
    if (any) return { uri: any.uri, kind: 'track', name: `${any.name} - ${(any.artists || []).join(', ')}`, shuffle: false };
    return null;
}

// His taste (lib/tasteBrain.js) answers "sorprendeme" and a bare moment ("para
// correr", "algo chill"); a name he said is still played as he said it. An empty
// pool answers null and the old behaviour stands.
function fromTaste(q) {
    const nothing = NOTHING_NAMED.test(norm(q));
    let brain;
    try { brain = deps.taste || require('./tasteBrain'); } catch { return null; }
    const moment = nothing ? null : brain.momentOf(q);
    if (!nothing && !moment) return null;
    try { return brain.pick({ moment }); } catch { return null; }
}

async function playMusic(query) {
    let q = String(query || '').replace(/\s+/g, ' ').trim();
    if (q.length > 100) q = q.slice(0, 100);
    restrictedGuard.assertNotRestricted('tesla music', q);
    const taste = fromTaste(q);
    if (taste) q = taste.query;
    else if (NOTHING_NAMED.test(norm(q))) q = surprise();
    const pick = await choose(q);
    if (!pick) throw said(`no encontre nada para "${q}" en Spotify`);
    await cli(['play', pick.uri]);
    if (pick.shuffle) { try { await cli(['shuffle', 'on']); } catch { /* playing anyway */ } }
    // Read back what is REALLY playing: "listo" over silence is what he complained about.
    let now = null;
    for (let i = 0; i < 4; i++) {
        await deps.sleep(700);
        try { now = (JSON.parse(await deps.run(['now-playing'])) || {}).currently_playing || null; } catch { now = null; }
        if (now && now.is_playing) break;
    }
    if (!now || !now.is_playing) throw said(`le di play a ${pick.name} pero Spotify no arranco: fijate si esta abierto`);
    const playing = String(now.description || pick.name);
    // Remembered either way, so "me gusta esto" always has something to point at.
    try { (deps.taste || require('./tasteBrain')).played(taste || { query: q }, playing); } catch { /* music plays anyway */ }
    return { query: q, kind: pick.kind, picked: pick.name, playing, why: taste ? taste.why : '' };
}

module.exports = { configure, playMusic, NOTHING_NAMED, SURPRISE, _norm: norm };
