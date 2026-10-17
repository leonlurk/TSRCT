/* ==============================================
   TSRCT - HANDS ON (v0)
   The inverse of HANDS FREE: that one is zero-touch by voice, this one is
   all-touch. Claude does NOT write the code -- it publishes a PLAN, and TSRCT
   makes Leon type it, line by line, over ghost text, with a plain-language
   reason beside every line.

   Three rules this file exists to enforce:
     1. The plan is DATA, never scraped prose. It arrives as JSON (steps ->
        lines -> {text, why}) or it does not arrive at all.
     2. Checking what you typed NEVER calls a model. It is a character compare
        in the browser -- instant, and it works with everything switched off.
        (TOWER lesson: never make the valuable part depend on the model.)
     3. The tmux session IS the project selector. Each session is already open
        in its own directory, so switching session re-roots the tree and the
        plan. There is no separate project picker.

   Phase 3B convention: IIFE-wrapped, explicit window.* export block at the
   bottom covering every name reachable from generated onclick HTML.
   ============================================== */
(function () {
'use strict';

// ── state ───────────────────────────────────────────────────────────────────
const HO = {
    plan: null,
    stepIndex: 0,
    lineIndex: 0,
    typed: [],          // committed text, one entry per line of the current step
    revealed: [],       // was that line revealed with Tab instead of typed?
    doneSteps: [],      // which steps are finished (kept, not derived — see lib/handson.js)
    publishedAt: null,  // when Claude published this plan; null for the sample
    saveTimer: null,
    ghost: true,        // ghost visible. Off = the v3 difficulty dial.
    session: null,
    pending: null,      // a differing session seen ONCE; needs a second sample
    cwd: null,
    project: null,
    tree: null,         // { path: {directories, files, open} }
    treeRoot: null,
    tally: { typed: 0, revealed: 0 },
    watchId: null,
    mounted: false,
    termHome: null,     // where .pc-terminal-wrap lived before we borrowed it
};

// ── the v0 sample lesson ────────────────────────────────────────────────────
// v0 ships a hand-written plan so the TYPING can be judged today, before any
// backend exists. If GET /api/handson/plan answers, that wins. The lesson is a
// real TSRCT-shaped module (IIFE + explicit window export) so the patterns you
// type here are the patterns the repo actually uses. `demo-` prefixed: typing
// the whole thing changes nothing in the app.
const SAMPLE_PLAN = {
    id: 'sample',
    title: 'UPTIME CHIP - a seconds counter in the header',
    sample: true,
    steps: [
        {
            file: 'src/js/demo-uptime.js',
            action: 'create',
            anchor: 'new file',
            note: 'the box the counter lives in',
            lines: [
                { text: '(function () {',                            why: 'opens a box. what is inside does not mix with the rest.' },
                { text: "    'use strict';",                          why: 'strict mode. mistakes complain instead of slipping past.' },
                { text: '',                                           why: '' },
                { text: '    let seconds = 0;',                       why: 'keeps a number. starts at 0.' },
                { text: '',                                           why: '' },
                { text: '    function tick() {',                      why: 'names a block of work. it does not run yet.' },
                { text: '        seconds += 1;',                      why: '+1 to the number.' },
                { text: '    }',                                      why: 'closes the block.' },
                { text: '',                                           why: '' },
                { text: '    setInterval(tick, 1000);',               why: 'every 1000 milliseconds = 1 second, run tick.' },
                { text: '})();',                                      why: 'closes the box and runs it once.' },
            ],
        },
        {
            file: 'src/js/demo-uptime.js',
            action: 'edit',
            anchor: 'inside tick(), after seconds += 1;',
            note: 'make the number show',
            lines: [
                { text: '        const el = document.getElementById(\'demo-uptime\');', why: 'finds the label called demo-uptime on the screen.' },
                { text: '        if (!el) return;',                   why: 'if it is not there, stop here. without this it crashes.' },
                { text: '        el.textContent = seconds + \'s\';',  why: 'writes the number inside that label.' },
            ],
        },
        {
            file: 'src/css/demo.css',
            action: 'create',
            anchor: 'new file',
            note: 'make it look like TSRCT, not like any page',
            lines: [
                { text: '.demo-uptime {',                             why: 'from here on, rules for anything called demo-uptime.' },
                { text: '    font-family: var(--mono);',              why: 'the system font. it does not pick a new one.' },
                { text: '    font-size: 0.66rem;',                    why: 'small. density is the look.' },
                { text: '    color: var(--cyan);',                    why: 'cyan = a value the system worked out itself.' },
                { text: '    border-left: 3px solid var(--cyan);',    why: 'the 3px bar on the left. the house mark.' },
                { text: '    padding: 2px 8px;',                      why: 'space inside the border. 2 top and bottom, 8 on the sides.' },
                { text: '}',                                          why: 'closes the rules.' },
            ],
        },
    ],
};

// ── small helpers ───────────────────────────────────────────────────────────
function esc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(s ?? ''));
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function prefGet(k, d) {
    if (typeof window.pcPrefGet === 'function') return window.pcPrefGet(k, 'window', d);
    try { return sessionStorage.getItem(k) ?? d; } catch { return d; }
}
function prefSet(k, v) {
    if (typeof window.pcPrefSet === 'function') return window.pcPrefSet(k, v, 'window');
    try { sessionStorage.setItem(k, v); } catch { /* private mode */ }
}
function sound(name) { if (typeof window.playSound === 'function') window.playSound(name); }
function $id(id) { return document.getElementById(id); }

function hoStep()  { return HO.plan?.steps?.[HO.stepIndex] || null; }
function hoLines() { return hoStep()?.lines || []; }
function hoLine()  { return hoLines()[HO.lineIndex] || null; }
function hoStepDone() { return HO.lineIndex >= hoLines().length; }
function hoBase(p) { return String(p || '').split('/').pop(); }

// ── mount / unmount ─────────────────────────────────────────────────────────
// The terminal is BORROWED, not rebuilt. The repo already carries three
// duplicated terminal implementations; a fourth is not a feature. We move the
// live .pc-terminal-wrap node into our right column and put it back on the way
// out -- same node, so every handler, id lookup and poller keeps working.
function hoInit() {
    const panel = $id('pc-handson-panel');
    if (!panel) return;
    HO.mounted = true;
    HO.ghost = prefGet('hoGhost', '1') !== '0';

    const body = $id('pc-handson-body');
    if (body && !body.dataset.built) {
        body.innerHTML = `
            <div class="ho-col ho-files">
                <div class="ho-col-head">
                    <span class="ho-col-title">[F] FILES</span>
                    <span class="ho-project" id="ho-project">-</span>
                </div>
                <div class="ho-tree" id="ho-tree"><div class="ho-empty">reading...</div></div>
            </div>
            <div class="ho-col ho-work">
                <div class="ho-col-head">
                    <span class="ho-col-title">[H] HANDS ON</span>
                    <span class="ho-lesson" id="ho-lesson">-</span>
                    <span class="ho-progress" id="ho-progress"></span>
                    <button class="ho-act" id="ho-ghost-btn" onclick="hoToggleGhost()" title="Ghost off = only the explanation is left and you produce the line yourself">[G]</button>
                    <button class="ho-act" onclick="hoPrevStep()" title="Previous step">[&lt;]</button>
                    <button class="ho-act" onclick="hoNextStep()" title="Next step">[&gt;]</button>
                    <button class="ho-act" onclick="hoReload()" title="Reload the plan">[~]</button>
                </div>
                <div class="ho-step" id="ho-step"></div>
            </div>
            <div class="ho-col ho-term" id="ho-term-slot">
                <div class="ho-col-head">
                    <span class="ho-col-title">[&gt;] CLAUDE</span>
                    <span class="ho-session" id="ho-session">-</span>
                </div>
            </div>`;
        body.dataset.built = '1';
    }

    hoBorrowTerminal();
    hoResolveProject().then(hoLoadPlan).then(hoRender);

    if (!HO.watchId) HO.watchId = setInterval(hoWatchSession, 3000);
}

function hoTeardown() {
    HO.mounted = false;
    if (HO.watchId) { clearInterval(HO.watchId); HO.watchId = null; }
    hoReturnTerminal();
}

function hoBorrowTerminal() {
    const wrap = document.querySelector('.pc-terminal-wrap');
    const slot = $id('ho-term-slot');
    if (!wrap || !slot || wrap.parentElement === slot) return;
    HO.termHome = { parent: wrap.parentElement, next: wrap.nextSibling };
    slot.appendChild(wrap);
    wrap.classList.add('ho-borrowed');
    // pcSwitchTab hid it on the way in; we are the ones showing it now.
    wrap.classList.remove('hidden');
}

function hoReturnTerminal() {
    const wrap = document.querySelector('.pc-terminal-wrap');
    if (!wrap || !HO.termHome) return;
    wrap.classList.remove('ho-borrowed');
    HO.termHome.parent.insertBefore(wrap, HO.termHome.next);
    HO.termHome = null;
    // Leave visibility to pcSwitchTab: it decides main vs split right after us.
}

// ── project = session ───────────────────────────────────────────────────────
async function hoResolveProject() {
    const s = (typeof window.getCurrentTargetSession === 'function')
        ? window.getCurrentTargetSession() : '';
    HO.session = s || null;
    const sEl = $id('ho-session');
    if (sEl) sEl.textContent = s || 'no session';

    if (!s) { HO.cwd = null; HO.project = null; return; }
    try {
        const r = await fetch('/api/cwd?session=' + encodeURIComponent(s));
        const d = await r.json();
        HO.cwd = d.cwd || null;
    } catch { HO.cwd = null; }
    HO.project = HO.cwd ? hoBase(HO.cwd) : null;
    const pEl = $id('ho-project');
    if (pEl) pEl.textContent = HO.project || 'no cwd';
}

function hoWatchSession() {
    // Belt: hoTeardown() clears this, but a path that re-mounts a surface
    // WITHOUT going through pcSwitchTab (a window-role swap, pcExpandToScreen)
    // would leave it ticking against a panel nobody is looking at. Ask the DOM
    // instead of trusting a flag, and shut down for real if it is not on screen.
    const panel = $id('pc-handson-panel');
    if (!HO.mounted || !panel || panel.classList.contains('hidden')) {
        if (HO.watchId) { clearInterval(HO.watchId); HO.watchId = null; }
        return;
    }
    const s = (typeof window.getCurrentTargetSession === 'function')
        ? window.getCurrentTargetSession() : '';
    const seen = s || null;
    if (seen === HO.session) { HO.pending = null; return; }

    // HYSTERESIS, and it is not optional. `homeSession` legitimately FLAPS in
    // split view: every permission that arrives from another panel rewrites it,
    // so in Leon's real console it bounced tsrct -> reddit -> piel-3 -> tsrct
    // within seconds. Acting on a single differing sample meant throwing away
    // and re-fetching the whole tree plus the plan every 3 seconds, forever.
    // One differing sample is noise; two in a row is a switch.
    if (HO.pending !== seen) { HO.pending = seen; return; }
    HO.pending = null;
    hoSwitchProject();
}

// Switching tmux switches project -- but only if the DIRECTORY actually moved.
// Two sessions can share a cwd, and a session rename is not a new project;
// rebuilding on the name instead of the path is how the churn above got in.
async function hoSwitchProject() {
    const before = HO.cwd;
    await hoResolveProject();
    if (HO.cwd === before) { hoRenderLesson(); return; }
    HO.tree = null;
    HO.treeRoot = null;
    await hoLoadPlan();
    hoRender();
}

// ── plan ────────────────────────────────────────────────────────────────────
async function hoLoadPlan() {
    let plan = null;
    if (HO.cwd) {
        try {
            const r = await fetch('/api/handson/plan?cwd=' + encodeURIComponent(HO.cwd));
            if (r.ok) {
                const d = await r.json();
                if (d && Array.isArray(d.steps) && d.steps.length) plan = d;
            }
        } catch { /* no plan published for this project — the sample carries it */ }
    }
    HO.plan = plan || SAMPLE_PLAN;
    HO.publishedAt = plan ? plan.publishedAt : null;
    HO.doneSteps = [];
    HO.tally = { typed: 0, revealed: 0 };
    hoResetStep(0);

    // Pick the lesson back up where it was left. A plan lives on disk precisely
    // so a restart does not cost you the half you already typed.
    const p = plan && plan.progress;
    if (p) {
        HO.doneSteps = Array.isArray(p.doneSteps) ? p.doneSteps.slice() : [];
        HO.tally = { typed: Number(p.tally?.typed) || 0, revealed: Number(p.tally?.revealed) || 0 };
        hoResetStep(Number(p.stepIndex) || 0);
        HO.typed = Array.isArray(p.typed) ? p.typed.slice() : [];
        HO.revealed = Array.isArray(p.revealed) ? p.revealed.slice() : [];
        HO.lineIndex = Math.min(Number(p.lineIndex) || 0, hoLines().length);
    }
}

function hoResetStep(i) {
    HO.stepIndex = Math.max(0, Math.min(i, (HO.plan?.steps?.length || 1) - 1));
    HO.lineIndex = 0;
    HO.typed = [];
    HO.revealed = [];
}

// Progress is written back debounced: one POST per pause, not one per line.
// The sample plan is never persisted — it belongs to no project.
function hoSaveProgress() {
    if (!HO.cwd || HO.plan?.sample) return;
    clearTimeout(HO.saveTimer);
    HO.saveTimer = setTimeout(() => {
        fetch('/api/handson/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cwd: HO.cwd,
                stepIndex: HO.stepIndex, lineIndex: HO.lineIndex,
                typed: HO.typed, revealed: HO.revealed,
                doneSteps: HO.doneSteps, tally: HO.tally,
            }),
        }).catch(() => { /* a lost progress write costs a re-type, never a crash */ });
    }, 600);
}

// The loop back to Claude. It carries what Leon ACTUALLY typed, so the case
// where he wrote something different but valid is visible instead of silently
// overwritten — that divergence is the reason this is a conversation and not a
// dictation.
function hoReportStepDone() {
    if (!HO.cwd || HO.plan?.sample) return;
    fetch('/api/handson/step-done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: HO.cwd, stepIndex: HO.stepIndex, lines: HO.typed }),
    }).catch(() => {});
}

// ── render ──────────────────────────────────────────────────────────────────
function hoRender() {
    hoRenderLesson();
    hoRenderStep();
    hoRenderTree();
}

function hoRenderLesson() {
    const l = $id('ho-lesson');
    if (l) l.textContent = (HO.plan?.title || '-') + (HO.plan?.sample ? '  [sample]' : '');
    const g = $id('ho-ghost-btn');
    if (g) g.classList.toggle('off', !HO.ghost);
    const p = $id('ho-progress');
    if (p && HO.plan) {
        const n = HO.plan.steps.length;
        p.textContent = `step ${HO.stepIndex + 1}/${n} · line ${Math.min(HO.lineIndex + 1, hoLines().length)}/${hoLines().length} · typed ${HO.tally.typed} · revealed ${HO.tally.revealed}`;
    }
}

function hoRenderStep() {
    const host = $id('ho-step');
    const step = hoStep();
    if (!host) return;
    if (!step) { host.innerHTML = '<div class="ho-empty">no plan</div>'; return; }

    const lines = step.lines;
    let rows = '';
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const num = `<span class="ho-gut">${i + 1}</span>`;
        const why = `<div class="ho-why">${esc(ln.why || '')}</div>`;
        if (i < HO.lineIndex) {
            const cls = HO.revealed[i] ? 'ho-ch-rev' : 'ho-ch-ok';
            rows += `<div class="ho-row done">${num}<div class="ho-cell"><div class="ho-static ${cls}">${esc(HO.typed[i] ?? ln.text)}</div></div>${why}</div>`;
        } else if (i === HO.lineIndex) {
            rows += `<div class="ho-row active" id="ho-active">${num}` +
                `<div class="ho-cell">` +
                    `<div class="ho-mirror" id="ho-mirror"></div>` +
                    `<input class="ho-typed" id="ho-typed" type="text" spellcheck="false" autocomplete="off"` +
                    ` oninput="hoOnType()" onkeydown="hoOnKey(event)">` +
                `</div>${why}</div>`;
        } else {
            const ghost = HO.ghost ? `<div class="ho-static ho-ch-ghost">${esc(ln.text)}</div>` : `<div class="ho-static ho-ch-hidden">·</div>`;
            rows += `<div class="ho-row">${num}<div class="ho-cell">${ghost}</div>${why}</div>`;
        }
    }

    const done = hoStepDone();
    host.innerHTML = `
        <div class="ho-step-head">
            <span class="ho-step-action ${step.action === 'create' ? 'create' : 'edit'}">${esc((step.action || 'edit').toUpperCase())}</span>
            <span class="ho-step-file">${esc(step.file || '')}</span>
            <span class="ho-step-anchor">${esc(step.anchor || '')}</span>
        </div>
        <div class="ho-step-note">${esc(step.note || '')}</div>
        <div class="ho-rows">${rows}</div>
        ${done ? `<div class="ho-done">
            <span class="ho-done-tag">STEP DONE</span>
            <button class="ho-act big" onclick="hoNextStep()">[&gt;] NEXT STEP</button>
         </div>` : `<div class="ho-hint">
            <span><kbd>enter</kbd> confirma la linea</span>
            <span><kbd>tab</kbd> te la muestra entera</span>
            <span><button class="ho-act" onclick="hoSkipLine()">[skip]</button> saltea</span>
         </div>`}
        ${hoRailHtml()}`;

    if (!done) {
        const input = $id('ho-typed');
        if (input) {
            input.value = (hoLine()?.text.match(/^\s*/) || [''])[0]; // indent is given, not typed
            hoPaintActive();
            input.focus();
            const end = input.value.length;
            input.setSelectionRange(end, end);
        }
        $id('ho-active')?.scrollIntoView({ block: 'nearest' });
    }
    hoRenderLesson();
}

// The plan as a whole, under the step. It fills what used to be dead space at
// the bottom of a short step, and it answers the question the step view cannot:
// where am I in the lesson, and what is still coming.
function hoRailHtml() {
    const steps = HO.plan?.steps || [];
    if (steps.length < 2) return '';
    const age = HO.publishedAt ? hoAgo(HO.publishedAt) : null;
    let rows = '';
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const isNow = i === HO.stepIndex;
        const isDone = !!HO.doneSteps[i];
        const mark = isDone ? '[x]' : (isNow ? '[>]' : '[ ]');
        rows += `<div class="ho-rail-row${isNow ? ' now' : ''}${isDone ? ' done' : ''}" onclick="hoGoToStep(${i})">` +
                `<span class="ho-rail-n">${i + 1}</span>` +
                `<span class="ho-rail-mark">${mark}</span>` +
                `<span class="ho-rail-file">${esc(s.file || '')}</span>` +
                `<span class="ho-rail-note">${esc(s.note || '')}</span>` +
                `</div>`;
    }
    const doneCount = HO.doneSteps.filter(Boolean).length;
    return `<div class="ho-rail">
        <div class="ho-rail-head">
            <span class="ho-rail-title">[=] PLAN</span>
            <span class="ho-rail-sub">${doneCount}/${steps.length} pasos${
                HO.plan?.sample ? ' &middot; leccion de ejemplo' : (age ? ' &middot; publicado ' + esc(age) : '')}</span>
        </div>${rows}</div>`;
}

function hoAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'recien';
    if (m < 60) return `hace ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h}h`;
    return `hace ${Math.floor(h / 24)}d`;
}

// The whole check: a character compare in the browser. No model, no round trip.
function hoPaintActive() {
    const mirror = $id('ho-mirror');
    const input = $id('ho-typed');
    if (!mirror || !input) return;
    const expected = hoLine()?.text ?? '';
    const typed = input.value;
    const n = Math.max(typed.length, HO.ghost ? expected.length : typed.length);
    let html = '';
    for (let i = 0; i < n; i++) {
        const t = typed[i];
        const e = expected[i];
        if (t === undefined) html += `<span class="ho-ch-ghost">${esc(e)}</span>`;
        else if (t === e)    html += `<span class="ho-ch-ok">${esc(t)}</span>`;
        else                 html += `<span class="ho-ch-bad">${esc(t)}</span>`;
    }
    mirror.innerHTML = html || '&nbsp;';
}

function hoOnType() { hoPaintActive(); }

function hoOnKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); hoCommitLine(); return; }
    if (e.key === 'Tab')   { e.preventDefault(); hoReveal(); return; }
}

function hoCommitLine() {
    const input = $id('ho-typed');
    if (!input) return;
    const expected = (hoLine()?.text ?? '').replace(/\s+$/, '');
    const typed = input.value.replace(/\s+$/, '');
    if (typed !== expected) {
        const row = $id('ho-active');
        row?.classList.remove('wrong');
        void row?.offsetWidth;          // restart the animation
        row?.classList.add('wrong');
        sound('error');
        return;
    }
    HO.typed[HO.lineIndex] = input.value;
    if (!HO.revealed[HO.lineIndex]) HO.tally.typed++;
    HO.lineIndex++;
    sound('tap');
    if (hoStepDone()) {
        sound('approve');
        HO.doneSteps[HO.stepIndex] = true;
        hoReportStepDone();
    }
    hoSaveProgress();
    hoRenderStep();
}

function hoReveal() {
    const input = $id('ho-typed');
    if (!input) return;
    input.value = hoLine()?.text ?? '';
    // Count the LINE, not the keypress: hitting Tab twice on the same line is
    // one line you did not earn, and the tally is the only honest record of it.
    if (!HO.revealed[HO.lineIndex]) {
        HO.revealed[HO.lineIndex] = true;
        HO.tally.revealed++;
    }
    hoPaintActive();
    hoRenderLesson();   // the counter has to tick on the press, not on the commit
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
}

function hoSkipLine() {
    if (hoStepDone()) return;
    HO.typed[HO.lineIndex] = hoLine()?.text ?? '';
    if (!HO.revealed[HO.lineIndex]) {
        HO.revealed[HO.lineIndex] = true;
        HO.tally.revealed++;
    }
    HO.lineIndex++;
    if (hoStepDone()) { HO.doneSteps[HO.stepIndex] = true; hoReportStepDone(); }
    hoSaveProgress();
    hoRenderStep();
}

function hoGoToStep(i) {
    if (!HO.plan) return;
    const n = HO.plan.steps.length;
    const target = Math.max(0, Math.min(Number(i) || 0, n - 1));
    if (target === HO.stepIndex) return;
    hoResetStep(target);
    hoSaveProgress();
    hoRender();
}

function hoNextStep() { hoGoToStep(HO.stepIndex + 1); }
function hoPrevStep() { hoGoToStep(HO.stepIndex - 1); }

function hoToggleGhost() {
    HO.ghost = !HO.ghost;
    prefSet('hoGhost', HO.ghost ? '1' : '0');
    hoRenderStep();
}

function hoReload() {
    hoResolveProject().then(hoLoadPlan).then(hoRender);
}

function hoJumpToFile(file) {
    if (!HO.plan) return;
    const i = HO.plan.steps.findIndex(s => s.file === file);
    if (i < 0 || i === HO.stepIndex) return;
    hoResetStep(i);
    hoRender();
}

// ── file tree ───────────────────────────────────────────────────────────────
async function hoRenderTree() {
    const host = $id('ho-tree');
    if (!host) return;
    if (!HO.cwd) { host.innerHTML = '<div class="ho-empty">no cwd for this session</div>'; return; }
    if (!HO.tree) {
        HO.tree = {};
        HO.treeRoot = HO.cwd;
        await hoTreeLoad(HO.cwd);
    }
    host.innerHTML = hoTreeHtml(HO.treeRoot, 0) || '<div class="ho-empty">empty</div>';
}

async function hoTreeLoad(dir) {
    if (HO.tree[dir]) return HO.tree[dir];
    try {
        const r = await fetch('/api/files/browse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dir }),
        });
        const d = await r.json();
        HO.tree[dir] = d.success
            ? { directories: d.directories || [], files: d.files || [], open: true }
            : { directories: [], files: [], open: true, error: d.error || 'denied' };
    } catch {
        HO.tree[dir] = { directories: [], files: [], open: true, error: 'unreachable' };
    }
    return HO.tree[dir];
}

// Files the plan touches are marked, and clicking one jumps to its step -- the
// tree is how you see WHERE the thing you are typing is going to live.
function hoPlanFiles() {
    const out = new Set();
    for (const s of (HO.plan?.steps || [])) if (s.file) out.add(s.file);
    return out;
}

function hoTreeHtml(dir, depth) {
    const node = HO.tree[dir];
    if (!node) return '';
    const planFiles = hoPlanFiles();
    const rel = (p) => (HO.treeRoot && p.startsWith(HO.treeRoot + '/')) ? p.slice(HO.treeRoot.length + 1) : p;
    let html = '';
    if (node.error) return `<div class="ho-empty">${esc(node.error)}</div>`;

    for (const name of node.directories) {
        const full = dir + '/' + name;
        const sub = HO.tree[full];
        const open = sub && sub.open;
        html += `<div class="ho-node dir" style="padding-left:${depth * 12}px" onclick="hoTreeToggle('${esc(full)}')">` +
                `<span class="ho-node-mark">${open ? '[-]' : '[+]'}</span>${esc(name)}/</div>`;
        if (open) html += hoTreeHtml(full, depth + 1);
    }
    for (const name of node.files) {
        const full = dir + '/' + name;
        const r = rel(full);
        const inPlan = planFiles.has(r);
        const isCurrent = hoStep()?.file === r;
        html += `<div class="ho-node file${inPlan ? ' in-plan' : ''}${isCurrent ? ' current' : ''}" ` +
                `style="padding-left:${depth * 12 + 14}px"` +
                `${inPlan ? ` onclick="hoJumpToFile('${esc(r)}')"` : ''}>` +
                `${esc(name)}${inPlan ? '<span class="ho-node-tag">plan</span>' : ''}</div>`;
    }

    // A file the plan CREATES does not exist on disk yet, so it can never show
    // up from a directory listing. Show it anyway, marked new -- otherwise the
    // tree quietly disagrees with the step you are looking at.
    if (depth === 0) {
        const listed = new Set();
        const walk = (d) => {
            const n = HO.tree[d]; if (!n) return;
            for (const f of n.files) listed.add(rel(d + '/' + f));
            for (const s of n.directories) walk(d + '/' + s);
        };
        walk(HO.treeRoot);
        for (const f of planFiles) {
            if (listed.has(f)) continue;
            const isCurrent = hoStep()?.file === f;
            html += `<div class="ho-node file in-plan new${isCurrent ? ' current' : ''}" onclick="hoJumpToFile('${esc(f)}')">` +
                    `${esc(f)}<span class="ho-node-tag">new</span></div>`;
        }
    }
    return html;
}

async function hoTreeToggle(dir) {
    const node = HO.tree[dir];
    if (node) node.open = !node.open;
    else await hoTreeLoad(dir);
    hoRenderTree();
}

// ── exports ─────────────────────────────────────────────────────────────────
// Every name below is reached from an inline onclick, either in desktop.js's
// panel markup or in the HTML this file generates. scripts/check-handlers.js
// enforces that this block stays complete.
Object.assign(window, {
    hoInit, hoTeardown,
    hoOnType, hoOnKey, hoSkipLine, hoNextStep, hoPrevStep,
    hoToggleGhost, hoReload, hoJumpToFile, hoTreeToggle, hoGoToStep,
});
window.HandsOn = HO;

})();
