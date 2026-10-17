// Phase 3: assign 0-100 urgency score per task for cockpit BURNING ordering.
//
// Score = baseSender + deadlineBoost + projectWeight + ageDecay
//   - baseSender:    Sam/Alex/Ravi (configurable) → +30
//   - deadlineBoost: "today"/"now"/"asap"/"EOD" mentions → +40
//   - projectWeight: client projects > personal → +10/0
//   - ageDecay:      stale tasks decay  → -5/hr after 6h

const URGENT_PATTERNS = [
    [/\b(now|asap|ya|urgent|urgente)\b/i, 50],
    [/\b(today|hoy|EOD|end of day)\b/i, 40],
    [/\bbefore (noon|monday|tomorrow|mañana)\b/i, 30],
    [/\btomorrow\b|\bmañana\b/i, 20],
    [/\b(this week|esta semana)\b/i, 10],
];

const CLIENT_PROJECT_NAMES = new Set([
    'Probill', 'Probill-Ledgerly', 'Lilypad-Leap', 'Rossowine',
    'HARBOR', 'C7-Reconciliation', 'law-firms', 'winery-recon',
]);

const PERSONAL_PROJECT_NAMES = new Set([
    'TSRCT', 'marketing-stack', 'mrktng', 'ai-agency-course', 'clickup-tool',
]);

function getTrackedSenderWeights() {
    return {
        // Default — overrideable via DB config.
        'Sam': 35,
        'Alex': 30,
        'Ravi': 30,
    };
}

function senderScore(senderName) {
    if (!senderName) return 0;
    const weights = getTrackedSenderWeights();
    const key = Object.keys(weights).find(k => senderName.toLowerCase().includes(k.toLowerCase()));
    return key ? weights[key] : 0;
}

function projectScore(project) {
    if (!project) return 0;
    if (CLIENT_PROJECT_NAMES.has(project)) return 15;
    if (PERSONAL_PROJECT_NAMES.has(project)) return 5;
    return 0;
}

function deadlineScore(text) {
    if (!text) return 0;
    let max = 0;
    for (const [re, val] of URGENT_PATTERNS) {
        if (re.test(text) && val > max) max = val;
    }
    return max;
}

function ageDecay(createdAt) {
    if (!createdAt) return 0;
    const hours = (Date.now() - createdAt) / 3600000;
    if (hours < 6) return 0;
    return -Math.min(20, (hours - 6) * 5);
}

function confidenceBoost(task) {
    // Less confident classification = lower priority (it might be dismissed)
    const cp = task.project_confidence || 0;
    if (cp < 0.5) return -10;
    if (cp > 0.9) return 5;
    return 0;
}

function scoreTask(task) {
    if (!task) return 0;
    let score = 0;
    score += senderScore(task.sender);
    score += deadlineScore(task.raw_text || '');
    score += projectScore(task.project);
    score += ageDecay(task.created_at);
    score += confidenceBoost(task);
    return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = { scoreTask, senderScore, deadlineScore, projectScore };
