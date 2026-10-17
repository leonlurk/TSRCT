#!/usr/bin/env node
'use strict';
// The `hands` worker's only way to see and touch the PC. Prints JSON.
//   node scripts/desk.js look   [--screen N]
//   node scripts/desk.js click  --screen N --x X --y Y      (also: double, right, move)
//   node scripts/desk.js scroll --screen N --x X --y Y --amount -5   (negative = down)
//   node scripts/desk.js drag   --screen N --x X --y Y --to-x X2 --to-y Y2   (press, travel, release; same screen)
//   node scripts/desk.js type   --text "hola"                (or --text-file F)
//   node scripts/desk.js key    --keys ctrl+s                (enter, win, alt+tab, ...)
//   node scripts/desk.js focus  --window spotify             (an open app: restore + bring forward)
//   node scripts/desk.js open   --path P | --reveal P | --app NAME | --url URL   (no mouse: lib/pcDirect.js)
// Windows, modes and shortcuts without the mouse (2026-10-11, lib/deskWindows.js + lib/deskShortcuts.js):
//   node scripts/desk.js windows                                  (open windows + monitors, no screenshot)
//   node scripts/desk.js place    --window spotify --where "a la derecha del monitor"   (or --slot right --screen 2)
//   node scripts/desk.js solo     --window excel                  (minimize all the others)
//   node scripts/desk.js layout   --list | --save NAME | --restore NAME | --delete NAME
//   node scripts/desk.js zones    --layout columns [--screen 2]
//   node scripts/desk.js shortcut --name "pestana nueva"          (only named ones; --list shows them)
//   node scripts/desk.js routine  --name "slack ir a" --what "soporte"
//   node scripts/desk.js settings --page sonido   |   spotify --query "bad bunny"   (results page only)
//   node scripts/desk.js music --query "sade"     (PLAYS it: artist, song, genre, mood; no query = a surprise)
// X/Y are pixels of THAT screen's PNG from the latest look (full size).
// Every action looks again afterwards (--no-look to skip) so the result is seen.
// Every capture and every input goes through lib/desk.js's checks; a refusal
// prints {ok:false, refused:"..."} and exits 3, and there is nothing else to try.

const fs = require('fs');
const desk = require('../lib/desk');

function opts(rest) {
    const o = {};
    for (let i = 0; i < rest.length; i++) {
        if (!rest[i].startsWith('--')) continue;
        const k = rest[i].slice(2);
        const v = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
        o[k] = v;
    }
    return o;
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const o = opts(rest);
    const acts = ['click', 'double', 'right', 'move', 'scroll', 'drag', 'type', 'key', 'focus', 'media'];
    const paths = ['windows', 'place', 'solo', 'layout', 'zones', 'shortcut', 'routine', 'settings', 'spotify', 'music'];
    if (cmd !== 'look' && cmd !== 'open' && !acts.includes(cmd) && !paths.includes(cmd)) {
        console.log('usage: node scripts/desk.js look|click|double|right|move|scroll|drag|type|key|focus|open|media|windows|place|solo|layout|zones|shortcut|routine|settings|spotify|music (see the top of this file)');
        process.exit(2);
    }
    const str = (v) => (v === true || v === undefined ? '' : String(v));
    try {
        if (paths.includes(cmd)) {
            // The worker is NOT direct: the "he took the mouse" pause applies to it.
            const { deskWindows: dw, deskShortcuts: sc } = require('../lib/deskWire').wire();
            let r;
            if (cmd === 'windows') r = await dw.list({ fresh: true });
            else if (cmd === 'place') r = await dw.place({ window: str(o.window), where: str(o.where), slot: str(o.slot) || undefined, screen: str(o.screen) || undefined });
            else if (cmd === 'solo') r = await dw.solo({ keep: str(o.window) });
            else if (cmd === 'layout') r = o.save ? await dw.saveLayout({ name: str(o.save), overwrite: !!o.overwrite }) : o.restore ? await dw.restoreLayout({ name: str(o.restore) })
                : o.delete ? dw.deleteLayout(str(o.delete)) : { layouts: dw.listLayouts(), workspaces: dw.readWorkspaces() };
            else if (cmd === 'zones') r = await dw.setZones({ layout: str(o.layout), screen: str(o.screen) || undefined });
            else if (cmd === 'shortcut') {
                if (o.list) r = sc.catalogue();
                else {
                    const row = sc.findShortcut(str(o.name));
                    // The worker gets only the harmless rows; the rest need his yes, by voice.
                    if (!row) throw Object.assign(new Error(`no shortcut named "${str(o.name)}" (--list)`), {});
                    if (row.risk !== 'harmless') throw Object.assign(new Error(`"${row.name}" needs Leon's yes: ask him (RESULTADO ok:false with the question)`), {});
                    r = await sc.pressShortcut(row);
                }
            } else if (cmd === 'routine') r = await sc.runRoutine(str(o.name), str(o.what));
            else if (cmd === 'settings') r = await sc.openSettings(str(o.page));
            else if (cmd === 'spotify') r = await sc.spotifySearch(str(o.query));
            else if (cmd === 'music') r = await require('../lib/spotify').playMusic(str(o.query));
            console.log(JSON.stringify({ ok: true, did: cmd, ...r }, null, 1));
            return;
        }
        // focus on an app with no window ("no open window matches Spotify", review #11)
        // launches it instead, which brings an already-running app forward.
        if (cmd === 'focus') {
            const pc = require('../lib/pcDirect');
            pc.configure({ focus: (name) => desk.act({ op: 'focus', window: name }) });
            const r = await pc.openApp(o.window === true ? '' : o.window);
            await new Promise(res => setTimeout(res, Number(o.wait) || 900));
            const after = o['no-look'] ? null : await desk.look({});
            console.log(JSON.stringify({ ok: true, did: 'focus', how: r.how, front: r.front || '', ...(after || {}) }, null, 1));
            return;
        }
        if (cmd === 'open') {
            const pc = require('../lib/pcDirect');
            pc.configure({ focus: (name) => desk.act({ op: 'focus', window: name }) });
            const r = o.url ? await pc.openUrl(o.url) : o.app ? await pc.openApp(o.app) : await pc.openPath({ path: o.path || o.reveal, reveal: !!o.reveal });
            console.log(JSON.stringify({ ok: true, did: 'open', ...r }, null, 1));
            return;
        }
        if (cmd === 'look') {
            console.log(JSON.stringify({ ok: true, ...(await desk.look({ screen: o.screen })) }, null, 1));
            return;
        }
        const text = o['text-file'] ? fs.readFileSync(String(o['text-file']), 'utf8') : (o.text === true ? '' : o.text);
        const did = await desk.act({ op: cmd, screen: o.screen, x: o.x, y: o.y, toX: o['to-x'], toY: o['to-y'], amount: o.amount, text, keys: o.keys, times: o.times, window: o.window === true ? '' : o.window });
        let after = null;
        if (!o['no-look']) {
            await new Promise(r => setTimeout(r, Number(o.wait) || 700));
            after = await desk.look({});
        }
        console.log(JSON.stringify({ ok: true, did: cmd, front: did.front, ...(after || {}) }, null, 1));
    } catch (e) {
        const refused = e.code === 'DESK_REFUSED' || e.code === 'RESTRICTED_PROJECT';
        console.log(JSON.stringify({ ok: false, refused: refused ? e.message : '', error: refused ? '' : e.message }));
        process.exit(refused ? 3 : 1);
    }
}
main();
