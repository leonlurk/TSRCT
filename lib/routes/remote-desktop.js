'use strict';
// VNC, audio and monitors.
// Moved out of server.js (cleanup P2 #9, 2026-10-17). server.js wires it with `S`, its
// shared state: constants and helpers are taken from S at every request, and every value
// the server changes over time (activeAudioProxy, activeVNCProxy) is read as S.<name>, never
// copied, so a route never acts on a stale one.

module.exports = (S) => {
    function getVncConfig(req, res, pathname) {
        const { NOT_MINE, readVNCConfig } = S;
        if (!(pathname === '/api/vnc/config' && req.method === 'GET')) return NOT_MINE;
        const config = readVNCConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            host: config.host,
            port: config.port,
            hasPassword: !!config.password
        }));
    }

    function postVncConfig(req, res, pathname) {
        const { NOT_MINE, readVNCConfigRaw, writeVNCConfig } = S;
        if (!(pathname === '/api/vnc/config' && req.method === 'POST')) return NOT_MINE;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const port = parseInt(data.port) || 5900;
                if (port < 1 || port > 65535) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid port' }));
                    return;
                }
                // MERGE, don't replace: rdConnect() POSTs this on every connect,
                // so a full overwrite silently drops the sibling preferences
                // (audioDevice, monitor) that other endpoints store here.
                const existing = readVNCConfigRaw();
                writeVNCConfig(Object.assign({}, existing, {
                    host: String(data.host || 'localhost'),
                    port: port,
                    password: String(data.password || '')
                }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function getVncStatus(req, res, pathname) {
        const { NOT_MINE, rdMeter, sendJson } = S;
        if (!(pathname === '/api/vnc/status' && req.method === 'GET')) return NOT_MINE;
        // Meter included so the room can show what this session has actually
        // cost. Bytes, not a guess -- the proxy counted every one of them.
        const meterSecs = Math.max(1, (Date.now() - rdMeter.since) / 1000);
        const meterTotal = rdMeter.vncDown + rdMeter.vncUp + rdMeter.audio;
        sendJson(req, res, {
            connected: S.activeVNCProxy !== null,
            audioActive: S.activeAudioProxy !== null,
            meter: {
                vnc: rdMeter.vncDown + rdMeter.vncUp,
                audio: rdMeter.audio,
                audioSaved: rdMeter.audioSilent,
                total: meterTotal,
                seconds: Math.round(meterSecs),
                mbPerHour: +((meterTotal / meterSecs) * 3600 / 1e6).toFixed(1)
            }
        });
    }

    function getVncMonitors(req, res, pathname) {
        const { NOT_MINE, readVNCConfig, readWindowsScreens } = S;
        if (!(pathname === '/api/vnc/monitors' && req.method === 'GET')) return NOT_MINE;
        // Physical monitor layout, so the client can crop the VNC framebuffer to
        // ONE screen. VNC serves the whole virtual desktop as a single ultra-wide
        // framebuffer and TightVNC has no per-monitor mode, so the crop is the
        // only way to view a single display.
        const config = readVNCConfig();
        const sel = Number.isInteger(config.monitor) ? config.monitor : -1;
        // `solo` has to come from the SERVER, not from counting screens: after a
        // PWA reload the client sees one screen and cannot tell "I collapsed it"
        // from "this machine only ever had one" — and it needs to know, or the
        // button that puts the other screen back disappears.
        const solo = config.monitorPreSolo !== undefined;
        try {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(Object.assign(readWindowsScreens(), { selected: sel, solo })));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ screens: [], virtual: null, selected: sel, solo, error: e.message }));
        }
    }

    function postVncMonitor(req, res, pathname) {
        const { NOT_MINE, readVNCConfigRaw, writeVNCConfig } = S;
        if (!(pathname === '/api/vnc/monitor' && req.method === 'POST')) return NOT_MINE;
        // Persist the selected monitor SERVER-side (not localStorage): it is a
        // property of this machine, and localStorage is origin-scoped, so it
        // would be lost on any hostname change (see the trusted-device lesson).
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const idx = parseInt(data.index);
                const config = readVNCConfigRaw();
                config.monitor = Number.isInteger(idx) && idx >= 0 ? idx : -1;
                writeVNCConfig(config);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, selected: config.monitor }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    }

    function postVncDisplay(req, res, pathname) {
        const { NOT_MINE, readVNCConfigRaw, readWindowsScreens, setDisplayTopology, soloAmbiguous, soloKept, soloModeOrder, writeVNCConfig } = S;
        if (!(pathname === '/api/vnc/display' && req.method === 'POST')) return NOT_MINE;
        // SOLO / EXTEND. See setDisplayTopology() above for why the mode is
        // tried-and-verified rather than chosen.
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            const send = (code, obj) => {
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(obj));
            };
            try {
                const data = JSON.parse(body || '{}');
                const config = readVNCConfigRaw();
                const before = readWindowsScreens(true);

                if (data.mode === 'extend') {
                    const r = await setDisplayTopology('/extend');
                    const after = readWindowsScreens(true);
                    if (config.monitorPreSolo !== undefined) {
                        config.monitor = config.monitorPreSolo;
                        delete config.monitorPreSolo;
                        writeVNCConfig(config);
                    }
                    return send(200, {
                        success: r.ok, mode: 'extend', error: r.error,
                        screens: after.screens, virtual: after.virtual,
                        selected: Number.isInteger(config.monitor) ? config.monitor : -1,
                    });
                }

                if (!before.screens.length) return send(200, { success: false, error: 'no screens reported' });
                if (before.screens.length < 2) {
                    return send(200, {
                        success: true, mode: 'solo', alreadySingle: true,
                        screens: before.screens, virtual: before.virtual, selected: -1,
                    });
                }

                // Which screen must survive: the one the client is watching.
                const sel = Number.isInteger(config.monitor) ? config.monitor : -1;
                const fallback = before.screens.find(s => s.primary) || before.screens[0];
                const keep = before.screens.find(s => s.label === String(data.keep))
                    || (sel >= 0 ? before.screens[sel] : null)
                    || fallback;

                const ambiguous = soloAmbiguous(before.screens, keep);

                const tried = [];
                for (const mode of soloModeOrder(keep)) {
                    const r = await setDisplayTopology(mode);
                    if (!r.ok) { tried.push({ mode, error: r.error }); continue; }
                    const after = readWindowsScreens(true);
                    tried.push({ mode, screens: after.screens.length });
                    if (soloKept(after.screens, keep, ambiguous)) {
                        config.monitorPreSolo = sel;
                        config.monitor = -1;   // one screen: a crop means nothing
                        writeVNCConfig(config);
                        return send(200, {
                            success: true, mode: 'solo', kept: keep.label, ambiguous, tried,
                            screens: after.screens, virtual: after.virtual, selected: -1,
                        });
                    }
                }

                // Nothing produced the screen we meant to keep — put it back.
                await setDisplayTopology('/extend');
                const back = readWindowsScreens(true);
                send(200, {
                    success: false, mode: 'solo', tried,
                    error: 'could not isolate monitor ' + keep.label + ' - reverted to extended',
                    screens: back.screens, virtual: back.virtual,
                    selected: Number.isInteger(config.monitor) ? config.monitor : -1,
                });
            } catch (e) {
                send(500, { success: false, error: e.message });
            }
        });
    }

    function getVncAudioDevices(req, res, pathname) {
        const { NOT_MINE, execSync, readVNCConfig } = S;
        if (!(pathname === '/api/vnc/audio/devices' && req.method === 'GET')) return NOT_MINE;
        // List available audio capture devices via ffmpeg
        try {
            const out = execSync('ffmpeg.exe -f dshow -list_devices true -i dummy 2>&1 || true', {
                encoding: 'utf8', timeout: 10000,
                cwd: process.env.HOME || '/tmp'
            });
            // Parse device list - lines with "DeviceName" (audio) are audio devices
            const audioDevices = [];
            const lines = out.split('\n');
            for (const line of lines) {
                if (line.includes('Alternative name')) continue;
                const match = line.match(/"([^"]+)"\s*\(audio\)/);
                if (match) {
                    audioDevices.push(match[1]);
                }
            }
            // Read saved preference
            const config = readVNCConfig();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ devices: audioDevices, selected: config.audioDevice || '' }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ devices: [], error: e.message }));
        }
    }

    function postVncAudioDevice(req, res, pathname) {
        const { NOT_MINE, readVNCConfigRaw, writeVNCConfig } = S;
        if (!(pathname === '/api/vnc/audio/device' && req.method === 'POST')) return NOT_MINE;
        // Save preferred audio device
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const config = readVNCConfigRaw();
                config.audioDevice = String(data.device || '');
                writeVNCConfig(config);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });

    // ── SF CLI Endpoints ─────────────────────────────────────────────
    }

    // Tried in this order, the order the routes were always matched in.
    const ROUTES = [
        getVncConfig,
        postVncConfig,
        getVncStatus,
        getVncMonitors,
        postVncMonitor,
        postVncDisplay,
        getVncAudioDevices,
        postVncAudioDevice,
    ];

    return function apiRemoteDesktop(req, res, pathname) {
        for (const route of ROUTES) {
            const answered = route(req, res, pathname);
            if (answered !== S.NOT_MINE) return answered;
        }
        return S.NOT_MINE;
    };
};
