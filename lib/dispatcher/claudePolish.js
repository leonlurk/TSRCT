// Optional Lever 6: ship the Hermes-composed prompt to Claude (Anthropic API)
// for a final polish pass. Only runs if ANTHROPIC_API_KEY is set AND the task
// is marked critical (e.g., client project, high stakes).
//
// Cost: ~$0.01-0.05 per polish (Sonnet-priced input ~3k tokens / output ~1k).

const https = require('https');
const restrictedGuard = require('./restrictedGuard');

const MODEL = process.env.CLAUDE_POLISH_MODEL || 'claude-sonnet-4-5';
const MAX_TOKENS = 2000;

function isEnabled() {
    return !!process.env.ANTHROPIC_API_KEY;
}

// Decide if a task warrants the polish step.
function shouldPolish({ task }) {
    if (!isEnabled()) return false;
    if (!task) return false;
    // SecretCo is contract-bound to AWS Bedrock — its content must NEVER reach the
    // public Anthropic API. Never polish SecretCo tasks.
    if (restrictedGuard.taskIsRestricted(task)) return false;
    // Client projects always get polish.
    const clientProjects = new Set([
        'Probill', 'Probill-Ledgerly', 'Lilypad-Leap', 'Rossowine',
        'HARBOR', 'C7-Reconciliation', 'law-firms', 'winery-recon',
    ]);
    if (clientProjects.has(task.project)) return true;
    // Or if the task is high confidence + decent length (worth investing in).
    if ((task.project_confidence || 0) >= 0.8 && (task.composed_prompt || '').length > 800) return true;
    return false;
}

async function polish({ task, draft }) {
    // Hard stop: never ship SecretCo content to api.anthropic.com (Bedrock-only contract).
    restrictedGuard.assertNotRestricted('claude-polish (api.anthropic.com)',
        task && task.project, task && task.raw_text, task && task.composed_prompt, draft);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('no ANTHROPIC_API_KEY');

    const system = `You are a senior engineer reviewing a prompt that will be pasted directly into a Claude Code terminal session.

The prompt was drafted by a small local model based on a Slack/ClickUp request from a sender. Your job is to make the prompt SIGNIFICANTLY more useful with minimal length increase:

- Replace every vague step with a concrete action (file path, function name, command, query).
- If the original references a project, weave in any project-specific conventions the small model missed.
- Tighten language. Cut fluff. Keep section headings consistent.
- DO NOT add new tasks the original sender didn't request. Only sharpen what's there.
- If the original is already strong, return it nearly unchanged with minor edits.
- Output ONLY the improved prompt — no preamble, no explanation, no "Here's the improved version:".

Stay under 3000 characters total. Match the existing section structure.`;

    const userMsg = [
        `Project: ${task.project || '(unknown)'}`,
        `Sender: ${task.sender || '(unknown)'}`,
        `Original sender message: """${(task.raw_text || '').slice(0, 800)}"""`,
        '',
        'Draft prompt to polish:',
        '"""',
        draft,
        '"""',
    ].join('\n');

    const body = JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: userMsg }],
    });

    return new Promise((resolve, reject) => {
        const req = https.request({
            host: 'api.anthropic.com',
            port: 443,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': apiKey,
                'Anthropic-Version': '2023-06-01',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(buf);
                    if (parsed.error) return reject(new Error(parsed.error.message || 'Anthropic API error'));
                    const text = (parsed.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
                    if (!text) return reject(new Error('empty polish response'));
                    resolve({ polished: text, usage: parsed.usage });
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('claude polish timeout')));
        req.write(body);
        req.end();
    });
}

module.exports = { isEnabled, shouldPolish, polish };
