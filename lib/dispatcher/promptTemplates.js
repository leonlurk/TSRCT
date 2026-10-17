// Per-project skeletons + few-shot exemplars for composePrompt.
// Picked by inspecting the project's vault page tags + name to choose an archetype.

const paths = require('../paths');
const projectsCtx = require('./projectContext');

// ── Archetype definitions ──────────────────────────────────────────────
// Each archetype provides:
//   - skeleton:    sections the composed prompt should include
//   - conventions: project-specific rules Claude should respect
//   - exemplar:    one input → ideal-prompt pair Hermes can imitate
// ─────────────────────────────────────────────────────────────────────────

const ARCHETYPES = {
    SALESFORCE: {
        name: 'salesforce',
        skeleton: [
            '# Goal (one sentence)',
            '# Context (repo path, package namespace, sandbox vs prod, related metadata)',
            '# Steps (numbered, concrete actions)',
            '# SOQL/Apex considerations (governor limits, bulk patterns, test classes)',
            '# Validation (which tests must pass, deploy target)',
            '# Constraints (do not touch X, do not run on prod)',
        ],
        conventions: [
            'All SOQL must be in DataStore.cls (never inline in controllers).',
            'New methods need a matching test class with ≥75% coverage.',
            'NEVER deploy to a production org without explicit user confirmation.',
            'Respect namespace prefixes (acme__ / app__) where applicable.',
            'Honor bulk patterns — no SOQL/DML inside loops.',
        ],
        exemplar: {
            input: 'podes revisar el sync de clickup en probill? hay tickets duplicados arrancá por el último mes',
            sender: 'Sam',
            prompt: `# Goal
Investigate and resolve duplicate ClickUp time-entry ingestion in the Probill managed package for the last 30 days.

# Context
- Repo: ${paths.PROJECTS_ROOT}/Probill (force-app/main/default/)
- Subsystems likely involved: FieldMapper.cls (ID matching), ClickUpChainedSyncQueueable, Worklog__c (UNIQUE_External_Worklog_ID__c)
- Last related change: dedup logic touched in May 2026 (check git log)

# Steps
1. SOQL: SELECT Id, External_Worklog_ID__c, COUNT(Id) FROM Worklog__c WHERE CreatedDate = LAST_30_DAYS GROUP BY Id HAVING COUNT(Id) > 1
2. Inspect FieldMapper.cls to see which key drives upsert (ID-only by spec — confirm no name fallback re-introduced).
3. If dedup gap found: propose a one-time cleanup VF page or anonymous Apex (do NOT run unattended).
4. Add a regression test in WorklogSyncHelperTest covering the duplicate scenario.

# Constraints
- DO NOT modify production data without my explicit confirmation.
- Stay within AppUtils.PACKAGE_QUALIFIER conventions.
- All new SOQL goes in DataStore.cls.

# Output expected
A short report with: the SOQL output (first 20 rows), root cause, proposed patch (diff or file list), and test class additions.`,
        },
    },

    TSRCT_FRONTEND: {
        name: 'tsrct-frontend',
        skeleton: [
            '# Goal',
            '# Context (which module, mobile vs desktop entry point)',
            '# Steps',
            '# CSS/JS conventions to respect',
            '# Verification (manual test path)',
        ],
        conventions: [
            'No emojis in code or UI — use [*] [+] [-] [!] etc.',
            'Mobile-first CSS; desktop-only rules go in desktop.css with .pc-mode and @media (min-width: 900px).',
            'No frameworks; vanilla JS only. camelCase functions, UPPER_SNAKE constants.',
            'No inline styles, no !important.',
            'Any new room CSS file must be added to sw.js ASSETS_TO_CACHE and CACHE_NAME bumped.',
        ],
        exemplar: {
            input: 'hay un bug en el modo VR de iphone, el zoom no se aplica cuando rotás horizontal',
            sender: 'Ravi',
            prompt: `# Goal
Fix VR-mode zoom persistence on iPhone when device rotates from portrait to landscape.

# Context
- Module: VR Cardboard Mode in TSRCT (Canvas 2D stereo split)
- Entry: src/js/remote-desktop.js (VR controls block — search "zoom" + "deviceorientation")
- Symptom: orientationchange handler resets zoom to 1.0 instead of preserving the user's last value.

# Steps
1. Locate the orientationchange handler in remote-desktop.js (likely inside the VR canvas init).
2. Add a persistent variable (module-scope, not per-frame) for current zoom.
3. On orientationchange, recompute canvas dimensions but read zoom from the persistent variable instead of resetting.
4. Verify there's no implicit "reset on resize" elsewhere overriding it.

# CSS/JS conventions
- No emojis. camelCase: \`vrCurrentZoom\`. No global pollution — keep inside the VR IIFE.
- No inline styles; if you need transition CSS, add to /src/css/rooms/room-remote.css.

# Verification
- Open TSRCT on iPhone, enter VR mode.
- Set zoom to 1.8 via the zoom button.
- Rotate device portrait→landscape→portrait. Zoom must stay 1.8 throughout.
- Sanity check: vrCurrentZoom persists across calls to the orientation handler.

# Output expected
The diff to remote-desktop.js + verification screenshot description.`,
        },
    },

    MARKETING_CONTENT: {
        name: 'marketing-content',
        skeleton: [
            '# Goal',
            '# Target (audience, channel)',
            '# Tone / voice constraints',
            '# Format expected',
            '# ACME context to weave in',
        ],
        conventions: [
            'Voice: confident, technical, never salesy. ACME is a Salesforce consultancy, not an agency.',
            'Always include 1 concrete ACME case study (Probill, wineries, HARBOR, Content Factory) when relevant.',
            'No emojis. Bullets fine. Short paragraphs.',
        ],
        exemplar: {
            input: 'armame un post de linkedin sobre por qué hay que sacar a los implementadores del flujo de billing',
            sender: 'Sam',
            prompt: `# Goal
Draft a single LinkedIn post (250-400 words) arguing that implementation partners (ACME) shouldn't be billing chokepoints for their clients.

# Target
- Audience: Salesforce-using SMB founders/COOs evaluating Probill.
- Channel: LinkedIn personal post (the founder's profile).

# Tone / voice
- Confident, slightly contrarian. First-person plural ("we at ACME have seen…").
- One concrete number or anecdote. No buzzwords ("transformative", "leverage", "synergy" — banned).

# Format expected
- Hook line (1 sentence, scroll-stopper).
- 3-4 short paragraphs.
- Closing line that invites comments without a CTA-y "DM me".

# ACME context to weave in
- Probill reduced manual billing time for [client name redacted if unsure] from X to Y.
- The Content Factory model: ACME builds the system, the client owns the flow.

# Output expected
The post text only. No preamble, no "Here's your post:".`,
        },
    },

    WINERY_RECON: {
        name: 'winery-recon',
        skeleton: [
            '# Goal',
            '# Context (which org, X3 vs SF source-of-truth)',
            '# Reconciliation pattern reference',
            '# Steps',
            '# Validation',
        ],
        conventions: [
            'X3 is source of truth for financials. SF is source of truth for CRM/sales operations.',
            'All custom Apex must respect the post-X3 monitor pattern (see [[Winery Reconciliation Pattern]]).',
            'Date timezone: orgs use America/Los_Angeles unless noted otherwise.',
        ],
        exemplar: {
            input: 'lilypad leap está con desbalance en accounting integration de mayo',
            sender: 'Alex',
            prompt: `# Goal
Identify and reconcile the May 2026 imbalance in Lilypad Leap's Accounting_Integration__c records.

# Context
- Org: frogsleap-prod (alias). Auth user: service@example.com. TZ: America/Los_Angeles.
- Source of truth: X3 ERP for financial figures; SF should match.
- Pattern: see [[Winery Reconciliation Pattern]] (post-X3 monitor + reprocessing flow).

# Steps
1. Pull SF totals for May: SELECT SUM(Total__c) FROM Accounting_Integration__c WHERE PostingDate__c >= 2026-05-01 AND PostingDate__c <= 2026-05-31
2. Pull X3 totals for the same period (via X3 query or finance file).
3. Diff. Identify which Accounting_Integration__c records are missing / extra / mismatched.
4. For each anomaly, classify: source-side gap (X3 missing entry) vs SF-side gap (failed sync) vs timing (timezone boundary).
5. Propose reprocessing batch (do NOT execute without confirmation).

# Validation
- After reprocess: SF totals must match X3 within $0.01.
- No duplicate Accounting_Integration_Line__c rows created.

# Output expected
A 1-page report: totals diff, per-anomaly classification, proposed reprocess plan with sample anonymous Apex.`,
        },
    },

    GENERIC: {
        name: 'generic',
        skeleton: [
            '# Goal',
            '# Context',
            '# Steps',
            '# Constraints',
            '# Output expected',
        ],
        conventions: [
            'Be specific. Reference file paths when known.',
            'Flag ambiguity instead of guessing.',
            'No destructive operations without explicit confirmation.',
        ],
        exemplar: {
            input: 'agrega un script que me notifique cuando termine un build',
            sender: 'Sam',
            prompt: `# Goal
Add a script that pushes a notification when a build completes (success or failure).

# Context
- Repo: not named in the request — confirm the target repo with the sender before writing files (do NOT assume a path).
- Existing notif infra: ntfy via NTFY_TOPIC env var (see notify.sh).

# Steps
1. Create scripts/notify-on-build.sh that takes \`--success\` / \`--failure\` flags.
2. Source NTFY_TOPIC from .env or env var.
3. POST to ntfy with title "Build done" / "Build failed" + commit SHA + duration.
4. Wire into the build entry point (npm run build hook or similar).

# Constraints
- chmod +x the new script.
- No external dependencies (use curl, already available).

# Output expected
The script content + the one-line wiring change to the build command.`,
        },
    },
};

// ── Project → archetype mapping ────────────────────────────────────────
const PROJECT_TO_ARCHETYPE = {
    'Probill': 'SALESFORCE',
    'Probill-Ledgerly': 'SALESFORCE',
    'Ledgerly': 'SALESFORCE',
    'Admin Center': 'SALESFORCE',
    'billy-ai-probill': 'SALESFORCE',
    'probill-ai': 'SALESFORCE',
    'law-firms': 'SALESFORCE',
    'HARBOR': 'SALESFORCE',
    'Lilypad-Leap': 'WINERY_RECON',
    'Rossowine': 'WINERY_RECON',
    'C7-Reconciliation': 'WINERY_RECON',
    'winery-recon': 'WINERY_RECON',
    'TSRCT': 'TSRCT_FRONTEND',
    'marketing-stack': 'MARKETING_CONTENT',
    'mrktng': 'MARKETING_CONTENT',
    'ai-agency-course': 'MARKETING_CONTENT',
};

function archetypeFor(projectName) {
    if (!projectName) return ARCHETYPES.GENERIC;
    const key = PROJECT_TO_ARCHETYPE[projectName];
    if (key && ARCHETYPES[key]) return ARCHETYPES[key];
    // Heuristic: any project whose vault page mentions "Apex" → SALESFORCE; mentions "vanilla" → TSRCT.
    const proj = projectsCtx.getProjectByName?.(projectName);
    const desc = (proj?.description || '').toLowerCase();
    if (/apex|salesforce|managed package|soql/.test(desc)) return ARCHETYPES.SALESFORCE;
    if (/vanilla|mobile-first|terminal/.test(desc)) return ARCHETYPES.TSRCT_FRONTEND;
    return ARCHETYPES.GENERIC;
}

function renderSkeleton(arch) {
    return arch.skeleton.map(s => `  - ${s}`).join('\n');
}

function renderConventions(arch) {
    return arch.conventions.map(c => `  - ${c}`).join('\n');
}

function renderExemplar(arch) {
    return `Input from ${arch.exemplar.sender}: "${arch.exemplar.input}"\n\nIdeal composed_prompt:\n${arch.exemplar.prompt}`;
}

function buildFewShotBlock(archetype) {
    const a = archetype || ARCHETYPES.GENERIC;
    return [
        `## EXAMPLE — archetype: ${a.name}`,
        `Skeleton sections this archetype expects:`,
        renderSkeleton(a),
        '',
        `Conventions for this archetype (Claude must respect):`,
        renderConventions(a),
        '',
        renderExemplar(a),
    ].join('\n');
}

// Build the complete few-shot block: target archetype's example + 2 GENERIC contrast examples
// for diversity. Keeps total tokens reasonable.
// Only the matching archetype is shown. Showing multiple confuses 8B models
// — they tend to average styles and pick the most generic skeleton.
function buildAllFewShot(targetArchetypeKey) {
    return buildFewShotBlock(archetypeFor(targetArchetypeKey));
}

module.exports = {
    ARCHETYPES,
    archetypeFor,
    buildFewShotBlock,
    buildAllFewShot,
};
