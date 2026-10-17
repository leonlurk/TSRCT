// Phase 4: thin wrapper around ntfy.sh for action-button pushes.
// Uses NTFY_SERVER + NTFY_TOPIC from .env (already configured for TSRCT).

const http = require('http');
const https = require('https');
const url = require('url');
const restrictedGuard = require('./restrictedGuard');

function send({ title, body, priority = 'default', tags = [], actions = [] }) {
    const topic = process.env.NTFY_TOPIC || 'claude-bridge-LURK';
    const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
    const u = new URL(`${server.replace(/\/$/, '')}/${topic}`);
    const lib = u.protocol === 'https:' ? https : http;

    // SecretCo contract: ntfy.sh is a third-party service. If anything in this push
    // (title, body, or an action's url/body) mentions SecretCo, redact it — send a
    // content-free alert and drop actions so no SecretCo data ever leaves the box.
    const actionPayload = actions.map(a => `${a.url || ''} ${a.body || ''}`).join(' ');
    if (restrictedGuard.mentionsRestricted(title, body, actionPayload)) {
        title = 'TSRCT // SecretCo task (withheld)';
        body = 'An SecretCo-related task arrived. Content withheld per the Bedrock-only ' +
            'contract. Handle it manually in the SecretCoSandbox session.';
        tags = ['lock'];
        actions = [];
    }
    const payload = String(body || '');

    return new Promise((resolve, reject) => {
        const headers = {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': Buffer.byteLength(payload),
            'Title': encodeTitle(title || 'TSRCT'),
            'Priority': priority,
        };
        if (tags.length) headers['Tags'] = tags.join(',');
        if (actions.length) headers['Actions'] = actions.map(formatAction).join('; ');

        const req = lib.request({
            host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname, method: 'POST', headers,
        }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('ntfy timeout')));
        req.write(payload);
        req.end();
    });
}

function encodeTitle(t) {
    // ntfy header values must be ASCII; transliterate accents.
    return String(t).replace(/[^\x00-\x7F]/g, '?').slice(0, 200);
}

// formatAction({ action: 'http', label: 'Send', url, method, body }) → ntfy header value
function formatAction(a) {
    const parts = [a.action || 'http', a.label, a.url];
    if (a.method) parts.push(`method=${a.method}`);
    if (a.body) parts.push(`body=${encodeURIComponent(a.body)}`);
    if (a.clear) parts.push('clear=true');
    return parts.join(', ');
}

module.exports = { send };
