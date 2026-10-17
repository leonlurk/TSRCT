/* ==============================================
   TSRCT - Desktop sessions: the sidebar, the split view (combined terminals) and drag and drop
   ============================================== */
// Moved out of desktop.js (cleanup P2 #11, 2026-10-17). These three share six mutable values (the sidebar HTML, live names, drag state, group index), so they moved TOGETHER and the state never crosses files. Loads BEFORE desktop.js; see desktop-git.js.
(function () {

// ==============================================
// SESSIONS
// ==============================================

// ── Session attention ───────────────────────────────────────────────────────
// The dispatcher already derives a state per session (waiting_input / failed /
// working) and until now only session-voice consumed it. A long tmux list is
// unreadable in name order; ordered by who is WAITING FOR YOU it becomes a work
// queue. Degrades silently: if the dispatcher is off, every rank is equal and
// the list keeps its previous order.
const ATTENTION_RANK = { waiting_input: 0, failed: 0, working: 1 };
let pcStatesAt = 0;            // last /api/dispatcher/session-states fetch
const PC_STATES_EVERY_MS = 6000;

function pcSessionRank(name) {
    const st = Desktop.sessionStates[name];
    const r = ATTENTION_RANK[st];
    return r === undefined ? 2 : r;
}

async function pcRefreshSessionStates() {
    try {
        const r = await fetch('/api/dispatcher/session-states', {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        if (!r.ok) return;
        const d = await r.json();
        const map = {};
        (d.sessions || []).forEach(s => { if (s && s.name) map[s.name] = s.state; });
        Desktop.sessionStates = map;
    } catch (e) { /* dispatcher off -> no ordering, no error */ }
}

function pcUpdateRailBadge() {
    const el = document.getElementById('pc-rail-badge-sessions');
    if (!el) return;
    const n = pcLiveSessionNames.filter(n2 => pcSessionRank(n2) === 0).length;
    el.textContent = n > 9 ? '9+' : String(n);
    el.classList.toggle('hidden', n === 0);
}

// Filter box: typing narrows the list. Kept OUT of the 3s rebuild by the focus
// guard in refreshPCSessions -- the same bug that ate the inline group rename.
function pcSessionFilterInput() {
    pcSessionFilter = (document.getElementById('pc-session-filter')?.value || '').toLowerCase();
    refreshPCSessions();
}
let pcSessionFilter = '';
let pcSessionsSeq = 0;     // newest refreshPCSessions call; older answers do not paint
let pcSessionsHtml = '';   // what the sidebar holds now; '' forces the next repaint
let pcSessionsVersion = null;
let pcSessionsFullAt = 0;

// Every second: has the session list changed? The server's counter moves when a
// tmux hook reports a session opened, closed or renamed, so this is one tiny 304
// with no tmux call. The full list is fetched when it moves, and every 6 s anyway
// (attention states, window counts, and a tmux server that came back without hooks).
async function pcSessionsTick() {
    if (!Desktop.isPC) return;
    let changed = false;
    if (!document.hidden) {
        try {
            const r = await fetch('/api/sessions/version', {
                headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
            });
            if (r.ok) {
                const v = (await r.json()).v;
                changed = pcSessionsVersion !== null && v !== pcSessionsVersion;
                pcSessionsVersion = v;
            }
        } catch (e) { /* server restarting -> the 6 s refresh covers it */ }
    }
    if (changed || Date.now() - pcSessionsFullAt >= 6000) {
        pcSessionsFullAt = Date.now();
        refreshPCSessions();
    }
}

async function refreshPCSessions() {
    if (!Desktop.isPC) return;

    const container = document.getElementById('pc-sessions');
    if (!container) return;

    // Don't rebuild the sidebar while renaming a group inline (blows away the input)
    // or mid manual group-drag (would drop the drag source out from under the mouse).
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('pc-group-name-input')) return;
    // The filter box must survive the background refresh while it has focus.
    const keepFilter = ae && ae.id === 'pc-session-filter';
    if (pcSidebarDrag && pcSidebarDrag.active) return;

    // Several callers fire this at once (the 1 s check, a kill, a rename). Only
    // the newest call may paint, or an older answer that lands last puts a
    // just-closed session back on the list.
    const seq = ++pcSessionsSeq;
    let html;
    try {
        const res = await fetch('/api/sessions', {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();
        if (seq !== pcSessionsSeq) return;

        // Workspace filter: this window renders only the sessions it may see.
        // Home (opened alone) sees everything no live sibling has taken; a
        // window opened beside one sees only the sessions it created itself.
        const visibleSessions = window.tsrctFilterSessions
            ? window.tsrctFilterSessions(data.sessions || [])
            : (data.sessions || []);
        pcLiveSessionNames = visibleSessions.map(s => s.name);
        // Built from the UNFILTERED list: the split groups and the focus-mode counts
        // must not change because the filter box has text in it.
        pcGroupIndex = pcBuildGroupIndex(visibleSessions);
        pcSplitGroupsPrune(pcLiveSessionNames);

        // Attention states change slower than the list: at most every 6 s.
        if (Date.now() - pcStatesAt >= PC_STATES_EVERY_MS) {
            pcStatesAt = Date.now();
            await pcRefreshSessionStates();
            if (seq !== pcSessionsSeq) return;
            pcSyncAttentionFromStates();
        }
        pcUpdateRailBadge();

        if (visibleSessions.length > 0) {
            // Adopt the first real session when nothing is selected (or the selected
            // one died) — no hardcoded 'claude'. Respects an existing valid choice.
            let current = (typeof homeSession !== 'undefined' ? homeSession : null);
            if (!current || !pcLiveSessionNames.includes(current)) {
                // Shared picker: prefers a session no OTHER live TSRCT window is
                // showing. Was `pcLiveSessionNames[0]`, which made every window
                // converge on the same session -- the PC-mode half of the mirror.
                current = (window.pickSessionForThisWindow
                    ? window.pickSessionForThisWindow(pcLiveSessionNames)
                    : pcLiveSessionNames[0]) || null;
                if (typeof homeSession !== 'undefined') homeSession = current;
            }
            const combineMode = Desktop.combined.sessions.length > 0 || document.body.classList.contains('pc-combine-mode');

            // Filter, then order by attention. Sort is stable in modern JS, so
            // sessions of equal rank keep the server's order (no jitter).
            let shown = visibleSessions;
            if (pcSessionFilter) {
                shown = shown.filter(s =>
                    s.name.toLowerCase().includes(pcSessionFilter) ||
                    (s.cwd || '').toLowerCase().includes(pcSessionFilter));
            }
            shown = shown.slice().sort((a, b) => pcSessionRank(a.name) - pcSessionRank(b.name));

            html = shown.length
                ? pcRenderSessionsGrouped(shown, current)
                : `<div class="pc-session-empty">No session matches "${escapeHtml(pcSessionFilter)}"</div>`;
        } else {
            // No sessions: behave like the runners panel — empty state, create on demand.
            // No phantom 'claude' row (that's what left a zombie session lying around).
            pcLiveSessionNames = [];
            if (typeof homeSession !== 'undefined') homeSession = null;
            html = (window.tsrctIsHome && !window.tsrctIsHome())
                ? `<div class="pc-session-empty">New workspace &mdash; click [+] to create a session.<br><span style="opacity:.6">Sessions from the other window stay in that window.</span></div>`
                : `<div class="pc-session-empty">No sessions &mdash; click [+] to create one</div>`;
        }

        // Repaint only when something changed. Rebuilding an identical sidebar
        // every few seconds made it flicker and swallowed a click that landed
        // mid-rebuild (2026-10-05).
        if (html !== pcSessionsHtml || !container.childElementCount) {
            pcSessionsHtml = html;
            container.innerHTML = html;
            if (keepFilter) document.getElementById('pc-session-filter')?.focus();

            // The sidebar DOM was rebuilt — if split view is active, redraw the cables so
            // they track any group collapse/expand (hidden items anchor to their header).
            if (Desktop.combined.enabled && typeof pcCombineRenderCables === 'function') {
                requestAnimationFrame(pcCombineRenderCables);
            }
        }

        // Update combine controls visibility
        pcCombineUpdateControls();
    } catch (e) {
        console.error('[PC] Failed to refresh sessions:', e);
    }
}

async function pcCreateSession() {
    const name = prompt('Session name (leave empty for auto):');
    if (name === null) return; // cancelled

    try {
        const res = await fetch('/api/session/new', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ name: name || '' })
        });
        const data = await res.json();

        if (data.success) {
            // Switch to the new session -- and claim it for THIS window, so it
            // appears here and disappears from the other one.
            if (window.tsrctOwnSession) window.tsrctOwnSession(data.session);
            if (typeof homeSession !== 'undefined') homeSession = data.session;
            document.getElementById('pc-session-name')?.textContent && (document.getElementById('pc-session-name').textContent = data.session);

            if (typeof toast === 'function') toast('Created: ' + data.session, 'success');
            refreshPCSessions();

            // Clear terminal
            const terminal = document.getElementById('pc-terminal');
            if (terminal) terminal.innerHTML = '<div class="pc-output">> New session: ' + data.session + '</div>';
        } else {
            if (typeof toast === 'function') toast(data.error || 'Failed to create session', 'error');
        }
    } catch (e) {
        console.error('[PC] Failed to create session:', e);
        if (typeof toast === 'function') toast('Error creating session', 'error');
    }
}

async function pcKillSession(name) {
    if (!confirm(`Kill session "${name}"?`)) return;

    try {
        const res = await fetch('/api/session/kill', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({ name })
        });
        const data = await res.json();

        if (data.success) {
            if (typeof toast === 'function') toast('Killed: ' + name, 'error');
            refreshPCSessions();
        } else {
            if (typeof toast === 'function') toast(data.error || 'Failed to kill session', 'error');
        }
    } catch (e) {
        console.error('[PC] Failed to kill session:', e);
        if (typeof toast === 'function') toast('Error killing session', 'error');
    }
}

async function fetchOutput() {
    try {
        const session = (typeof homeSession !== 'undefined' && homeSession) || 'claude';
        const res = await fetch(`/api/output?session=${encodeURIComponent(session)}`, {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();
        if (data.output) {
            const mobile = document.getElementById('terminal');
            const pc = document.getElementById('pc-terminal');
            if (mobile) {
                if (window.TermImg) TermImg.write(mobile, data.output);
                else if (window.TermFocus) TermFocus.write(mobile, data.output, false);
                else mobile.textContent = data.output;
            }
            if (pc) {
                if (window.TermImg) TermImg.write(pc, data.output);
                else if (window.TermFocus) TermFocus.write(pc, data.output, true);
                else { pc.innerHTML = data.output; if (!Desktop.userScrolled) pc.scrollTop = pc.scrollHeight; }
            }
        }
    } catch (e) {
        console.error('[PC] fetchOutput error:', e);
    }
}

function pcSwitchSession(name) {
    if (typeof homeSession !== 'undefined') homeSession = name;

    document.getElementById('home-session-label')?.textContent && (document.getElementById('home-session-label').textContent = name);
    document.getElementById('pc-session-name')?.textContent && (document.getElementById('pc-session-name').textContent = name);

    fetchOutput();
    refreshPCSessions();
    pcUpdateAutoAcceptBtn(); // Update auto-accept state for new session
    // [PB] is per session too, so the button has to follow the switch or it
    // reports the state of the session you just left.
    if (typeof refreshPlainBrief === 'function') refreshPlainBrief();
    if (typeof toast === 'function') toast(`→ ${name}`, 'success');
}

// Get list of session names from sidebar
function pcGetSessionList() {
    const items = document.querySelectorAll('#pc-sessions .pc-session-item');
    return Array.from(items).map(item => {
        const span = item.querySelector('span');
        return span ? span.textContent.trim() : null;
    }).filter(Boolean);
}

// Cycle to next/previous session
function pcCycleSession(direction) {
    const sessions = pcGetSessionList();
    if (sessions.length < 2) return;

    const current = (typeof homeSession !== 'undefined' && homeSession) || 'claude';
    const currentIndex = sessions.indexOf(current);

    let newIndex;
    if (currentIndex === -1) {
        newIndex = 0;
    } else if (direction > 0) {
        newIndex = (currentIndex + 1) % sessions.length;
    } else {
        newIndex = (currentIndex - 1 + sessions.length) % sessions.length;
    }

    pcSwitchSession(sessions[newIndex]);
}

// Jump to session by index (1-based)
function pcJumpToSession(index) {
    const sessions = pcGetSessionList();
    if (index > 0 && index <= sessions.length) {
        pcSwitchSession(sessions[index - 1]);
    }
}

// ==============================================
// COMBINED TERMINALS (Split View with Cables)
// ==============================================

// Toggle combine mode (show/hide checkboxes)
function pcCombineToggleMode() {
    document.body.classList.toggle('pc-combine-mode');
    if (typeof toast === 'function') {
        const mode = document.body.classList.contains('pc-combine-mode');
        toast(mode ? 'Select sessions to combine' : 'Combine mode off', 'info');
    }
}

// Toggle a session in the combined list
function pcCombineToggleSession(name) {
    // The checkboxes ARE the manual group (''). Hand the folder group its layout back
    // before taking the panels over, or switching to it later loses the arrangement.
    if (Desktop.combined.groupId !== '') {
        pcSplitGroupCapture();
        Desktop.combined.groupId = '';
    }
    const idx = Desktop.combined.sessions.indexOf(name);
    if (idx === -1) {
        Desktop.combined.sessions.push(name);
    } else {
        // Remove from combined
        Desktop.combined.sessions.splice(idx, 1);
    }

    // Update checkbox state
    const item = document.querySelector(`.pc-session-item[data-session="${name}"]`);
    if (item) {
        const checkbox = item.querySelector('.pc-combine-check');
        if (checkbox) checkbox.checked = Desktop.combined.sessions.includes(name);
        item.classList.toggle('combined', Desktop.combined.sessions.includes(name));
    }

    pcCombineUpdateControls();

    // If split view is active, update it
    if (Desktop.combined.enabled) {
        pcCombineRender();
    }

    pcSplitSave();
}

// Update combine controls visibility and count
function pcCombineUpdateControls() {
    const controls = document.getElementById('pc-combine-controls');
    const countEl = document.getElementById('pc-combine-count');

    if (controls && countEl) {
        const count = Desktop.combined.sessions.length;
        countEl.textContent = count;

        // Show controls if any sessions selected
        if (count > 0) {
            controls.classList.remove('hidden');
        } else {
            controls.classList.add('hidden');
        }
    }
}

// ---- Split view persistence ----
const SPLIT_STORAGE_KEY = 'tsrct_split_state';
const SPLIT_IDENTITY_KEY = 'tsrct_split_identity';

// Panel identity: aliases and colors (persisted separately from layout)
// aliases: session -> display name. colors: session -> hex. meanings: hex -> label
// (what a color CODES for, e.g. "#ff4444" -> "blocked"). All persisted together.
const pcPanelIdentity = { aliases: {}, colors: {}, meanings: {} };
// Names of sessions that currently exist (refreshed by refreshPCSessions). The
// legend counts only these so dead sessions don't inflate the tally.
let pcLiveSessionNames = [];

// Preset colors for panel borders
const PC_PANEL_COLORS = [
    null,       // default (cyan when active, border when inactive)
    '#00ff41',  // green
    '#ff4444',  // red
    '#ff8c00',  // orange
    '#00a8ff',  // blue
    '#9b59b6',  // purple
    '#e91e63',  // pink
    '#ffeb3b',  // yellow
    '#00bcd4',  // teal
    '#ff6b6b',  // coral
];

function pcIdentityLoad() {
    try {
        const raw = localStorage.getItem(SPLIT_IDENTITY_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            pcPanelIdentity.aliases = data.aliases || {};
            pcPanelIdentity.colors = data.colors || {};
            pcPanelIdentity.meanings = data.meanings || {};
        }
    } catch(e) {}
}

function pcIdentitySave() {
    try {
        localStorage.setItem(SPLIT_IDENTITY_KEY, JSON.stringify(pcPanelIdentity));
    } catch(e) {}
}

function pcSplitSave() {
    const state = {
        sessions: Desktop.combined.sessions.slice(),
        activeIndex: Desktop.combined.activeIndex,
        enabled: Desktop.combined.enabled,
        groupId: Desktop.combined.groupId,
        bounds: Desktop.combined.panelBounds ? Desktop.combined.panelBounds.map(b => ({...b})) : null
    };
    try { localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
    if (window.pcLayout) window.pcLayout.mirror();
    // Every existing call site (resize, focus, rename, add/remove panel) already
    // funnels here, so hanging the split-group snapshot off this one function is what
    // keeps a new call site from being forgotten.
    pcSplitGroupCapture();
}

function pcSplitLoad() {
    try {
        const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
}

// ==============================================
// PER-FOLDER SPLIT GROUPS
// A split group is "the panels for this folder": which sessions, which one has focus,
// and the layout you dragged them into. Any folder holding 2+ living tmux can arm one,
// and the chip bar above the terminal switches between them with a single click.
//
// Storage is sessionStorage, NOT localStorage or the server config table, and the set
// is pruned against the live tmux list on every sidebar refresh. So a group outlives a
// PWA reload but never outlives the sessions it points at — which is the whole ask.
// '' is the manual checkbox selection, so it rides the same machinery as the folders.
// ==============================================
const SPLIT_GROUPS_KEY = 'tsrct_split_groups';

function pcSplitGroupsLoad() {
    try {
        const raw = sessionStorage.getItem(SPLIT_GROUPS_KEY);
        const d = raw ? JSON.parse(raw) : null;
        Desktop.splitGroups = (d && typeof d === 'object') ? d : {};
    } catch (e) { Desktop.splitGroups = {}; }
}

function pcSplitGroupsSave() {
    try { sessionStorage.setItem(SPLIT_GROUPS_KEY, JSON.stringify(Desktop.splitGroups)); } catch (e) {}
    if (window.pcLayout) window.pcLayout.mirror();
}

// The folder's CURRENT name, never a copy stored at arming time — renaming a folder
// has to rename its chip.
function pcSplitGroupName(gid) {
    if (gid === '' || gid == null) return 'selection';
    const g = pcGroupFind(gid);
    return (g && g.name) ? g.name : 'group';
}

// Snapshot what is on screen into whichever split group owns it.
function pcSplitGroupCapture() {
    const gid = Desktop.combined.groupId;
    if (gid == null) return;
    if (Desktop.combined.sessions.length < 2) {
        if (Desktop.splitGroups[gid]) { delete Desktop.splitGroups[gid]; pcSplitGroupsSave(); pcRenderSplitChips(); }
        return;
    }
    Desktop.splitGroups[gid] = {
        sessions: Desktop.combined.sessions.slice(),
        activeIndex: Desktop.combined.activeIndex,
        bounds: Desktop.combined.panelBounds ? Desktop.combined.panelBounds.map(b => ({...b})) : null
    };
    pcSplitGroupsSave();
    pcRenderSplitChips();
}

// Drop dead sessions from every group, then drop any group left with fewer than two
// panels. If the group currently on screen changed underneath us, the split follows —
// a killed tmux must not leave a panel polling a name that no longer exists.
function pcSplitGroupsPrune(liveNames) {
    const live = new Set(liveNames || []);
    // A session mid-handoff is gone from tmux before its successor's name reaches
    // this page; keep its panel so pcSessionSucceeded can swap it in place.
    if (window.SessionWeight && typeof SessionWeight.handingOff === 'function') {
        SessionWeight.handingOff().forEach(n => live.add(n));
    }
    let changed = false;
    Object.keys(Desktop.splitGroups).forEach(gid => {
        const e = Desktop.splitGroups[gid] || {};
        const before = e.sessions || [];
        const kept = before.filter(n => live.has(n));
        if (kept.length !== before.length) {
            changed = true;
            e.sessions = kept;
            e.bounds = null;                 // the saved layout was for a different panel count
            if ((e.activeIndex || 0) >= kept.length) e.activeIndex = 0;
        }
        if (kept.length < 2) { delete Desktop.splitGroups[gid]; changed = true; }
    });
    if (!changed) return;
    pcSplitGroupsSave();

    const gid = Desktop.combined.groupId;
    if (gid != null) {
        const cur = Desktop.splitGroups[gid];
        if (!cur) {
            // Clear the owner FIRST: pcCombineDisable saves, and a save would re-create
            // the group we just pruned, dead session names and all.
            Desktop.combined.groupId = null;
            if (Desktop.combined.enabled) pcCombineDisable();
        } else if (cur.sessions.join('|') !== Desktop.combined.sessions.join('|')) {
            Desktop.combined.sessions = cur.sessions.slice();
            Desktop.combined.activeIndex = Math.min(Desktop.combined.activeIndex, cur.sessions.length - 1);
            Desktop.combined.panelBounds = null;
            if (Desktop.combined.enabled) { pcCombineRender(); pcSplitSave(); }
        }
    }
    pcRenderSplitChips();
}

// Put the sidebar checkboxes in sync with Desktop.combined.sessions. Was inlined in
// three places that each did it slightly differently.
function pcSyncCombineChecks() {
    document.querySelectorAll('.pc-session-item').forEach(item => {
        const on = Desktop.combined.sessions.includes(item.dataset.session);
        const cb = item.querySelector('.pc-combine-check');
        if (cb) cb.checked = on;
        item.classList.toggle('combined', on);
    });
    pcCombineUpdateControls();
}

// Bring a split group on screen. Saves the outgoing group's layout first, so
// switching back and forth is lossless.
function pcSplitGroupActivate(gid) {
    const e = Desktop.splitGroups[gid];
    if (!e || (e.sessions || []).length < 2) {
        if (typeof toast === 'function') toast('that split group is gone', 'warning');
        pcRenderSplitChips();
        return;
    }
    if (Desktop.combined.enabled && Desktop.combined.groupId !== gid) pcSplitSave();

    Desktop.combined.groupId = gid;
    Desktop.combined.sessions = e.sessions.slice();
    Desktop.combined.activeIndex = Math.min(e.activeIndex || 0, e.sessions.length - 1);
    Desktop.combined.panelBounds = (e.bounds && e.bounds.length === e.sessions.length)
        ? e.bounds.map(b => ({...b})) : null;
    pcSyncCombineChecks();

    if (Desktop.combined.enabled) {
        pcCombineRender();
        pcSplitSave();
    } else {
        // pcCombineEnable(true) re-reads the layout out of localStorage, so write the
        // state we just built BEFORE handing over or it restores the previous group's.
        pcSplitSave();
        pcCombineEnable(true);
    }
    pcRenderSplitChips();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
}

// Arm (or re-arm) a folder's split and show it.
function pcFolderSplit(gid) {
    const names = pcGroupLiveSessions(gid);
    if (names.length < 2) {
        if (typeof toast === 'function') toast('need 2+ live sessions in this folder', 'warning');
        return;
    }
    const prev = Desktop.splitGroups[gid];
    const same = prev && (prev.sessions || []).join('|') === names.join('|');
    if (!same) {
        // Re-arming a folder whose membership changed starts from a fresh layout;
        // an unchanged one keeps the panes exactly where you dragged them.
        Desktop.splitGroups[gid] = { sessions: names, activeIndex: 0, bounds: null };
        pcSplitGroupsSave();
    }
    pcSplitGroupActivate(gid);
}

// Disarm a folder's split. Only leaves single view if that folder is what is showing.
function pcFolderUnsplit(gid) {
    if (Desktop.combined.groupId === gid && Desktop.combined.enabled) pcCombineDisable();
    delete Desktop.splitGroups[gid];      // after disable — pcCombineDisable re-captures it
    if (Desktop.combined.groupId === gid) Desktop.combined.groupId = null;
    pcSplitGroupsSave();
    pcRenderSplitChips();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
}

function pcRenderSplitChips() {
    const el = document.getElementById('pc-split-chips');
    if (!el) return;
    const ids = Object.keys(Desktop.splitGroups)
        .filter(gid => (Desktop.splitGroups[gid].sessions || []).length >= 2);
    if (!ids.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');

    const chips = ids.map(gid => {
        const e = Desktop.splitGroups[gid];
        const active = Desktop.combined.enabled && Desktop.combined.groupId === gid;
        return `<button class="pc-split-chip ${active ? 'active' : ''}"
                    onclick="pcSplitGroupActivate('${gid}')"
                    title="${escapeHtml(e.sessions.join(' · '))}">${escapeHtml(pcSplitGroupName(gid))}<span class="pc-split-chip-n">${e.sessions.length}</span></button>`;
    }).join('');

    el.innerHTML = chips +
        `<button class="pc-split-chip pc-split-chip-single ${Desktop.combined.enabled ? '' : 'active'}"
                 onclick="pcCombineDisable()" title="Back to one terminal">[single]</button>` +
        `<button class="pc-split-chip pc-progress-btn ${pcProgress.busy ? 'running' : ''}"
                 onclick="pcProgressOpen()" title="Progress report of the tab on screen: what got done, what is pending, and what was asked of you that no session touched">[R] report</button>`;
}

// ==============================================
// PROGRESS REPORT ([R] on the tab bar, 2026-10-06)
// Reads today's conversation of every session in the tab on screen, checks it
// against ClickUp / Slack / Gmail / calendar / vault, and gives back the Slack
// update ("Tasks nailed today: / Pending:") ready to copy, plus what was asked
// and nobody touched. The server does the work (lib/progressReport.js); this is
// the button and the window. The panel colour goes along as a hint only: the
// conversation decides what is done.
// ==============================================
const pcProgress = { busy: false, reports: {}, timer: null, open: false, wasBusy: false };

// What [R] covers: the tab of panels on screen, or in [single] the one tmux
// session in the terminal. The single report is filed under its own name so it
// never overwrites a tab's report.
function pcProgressScope() {
    if (Desktop.combined.enabled && Desktop.combined.sessions.length) {
        return { group: pcSplitGroupName(Desktop.combined.groupId), sessions: Desktop.combined.sessions.slice() };
    }
    const one = (typeof homeSession !== 'undefined' && homeSession) || '';
    return one ? { group: `single: ${one}`, sessions: [one] } : { group: '', sessions: [] };
}

function pcProgressGroup() { return pcProgressScope().group; }

async function pcProgressFetch() {
    try {
        const r = await fetch('/api/progress', { headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') || '' } });
        if (!r.ok) return;
        const d = await r.json();
        pcProgress.busy = !!d.busy;
        pcProgress.reports = d.reports || {};
    } catch (e) { /* offline: keep what we have */ }
    if (pcProgress.wasBusy && !pcProgress.busy && typeof toast === 'function') toast('[R] Progress report ready', 'info', false);
    pcProgress.wasBusy = pcProgress.busy;
    if (pcProgress.busy && !pcProgress.timer) {
        pcProgress.timer = setInterval(pcProgressFetch, 4000);
    } else if (!pcProgress.busy && pcProgress.timer) {
        clearInterval(pcProgress.timer); pcProgress.timer = null;
    }
    document.querySelectorAll('.pc-progress-btn').forEach(b => b.classList.toggle('running', pcProgress.busy));
    if (pcProgress.open) pcProgressRender();
}

function pcProgressOpen() {
    let ov = document.getElementById('pc-progress-overlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'pc-progress-overlay';
        ov.className = 'pc-progress-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) pcProgressClose(); });
        document.body.appendChild(ov);
    }
    ov.classList.remove('hidden');
    pcProgress.open = true;
    pcProgressRender();
    pcProgressFetch();
}

function pcProgressClose() {
    const ov = document.getElementById('pc-progress-overlay');
    if (ov) ov.classList.add('hidden');
    pcProgress.open = false;
}

async function pcProgressRun() {
    const scope = pcProgressScope();
    const group = scope.group;
    if (!group) { if (typeof toast === 'function') toast('[!] Pick a session or a tab of panels first', 'error', false); return; }
    pcIdentityLoad();
    const sessions = scope.sessions.map(name => {
        const color = pcPanelIdentity.colors[name] || '';
        return { name, color, meaning: color ? (pcPanelIdentity.meanings[color] || '') : '', state: Desktop.sessionStates[name] || '' };
    });
    try {
        const r = await fetch('/api/progress/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': (typeof token !== 'undefined' ? token : '') || '' },
            body: JSON.stringify({ group, sessions })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok && typeof toast === 'function') toast(`[!] ${d.error || 'could not start the report'}`, 'error', false);
    } catch (e) {
        if (typeof toast === 'function') toast('[!] Server not reachable', 'error', false);
    }
    pcProgressFetch();
}

async function pcProgressStop() {
    try {
        await fetch('/api/progress/stop', { method: 'POST', headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') || '' } });
    } catch (e) {}
    pcProgressFetch();
}

function pcProgressCopy() {
    const ta = document.getElementById('pc-progress-slack');
    if (!ta) return;
    const done = () => { if (typeof toast === 'function') toast('[+] Copied, paste it in Slack', 'info', false); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ta.value).then(done).catch(() => { ta.select(); document.execCommand('copy'); done(); });
    } else { ta.select(); document.execCommand('copy'); done(); }
}

function pcProgressRender() {
    const ov = document.getElementById('pc-progress-overlay');
    if (!ov) return;
    const group = pcProgressGroup();
    const rep = group ? pcProgress.reports[group] : null;
    const esc = (s) => escapeHtml(String(s == null ? '' : s));
    const when = (ms) => ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const list = (title, items, fmt) => items && items.length
        ? `<div class="pc-progress-sec"><div class="pc-progress-h">${title}</div><ul>${items.map(i => `<li>${fmt(i)}</li>`).join('')}</ul></div>` : '';

    let body = '';
    if (!group) {
        body = `<div class="pc-progress-note">Pick a session or open one of your panel tabs first. The report covers what is on screen.</div>`;
    } else if (rep && rep.phase === 'running') {
        const secs = Math.round((Date.now() - (rep.startedAt || Date.now())) / 1000);
        body = `<div class="pc-progress-note">[*] Reading ${(rep.sessions || []).length} sessions, then ClickUp, Slack, Gmail, calendar and the vault... ${Math.floor(secs / 60)}m ${secs % 60}s</div>
                <div class="pc-progress-actions"><button class="pc-progress-act" onclick="pcProgressStop()">[x] stop</button></div>`;
    } else if (rep && rep.phase === 'done') {
        const slack = String(rep.slack || '');
        body = `<div class="pc-progress-sec">
                    <div class="pc-progress-h">SLACK MESSAGE <span class="pc-progress-sub">(you can edit it before copying)</span></div>
                    <textarea id="pc-progress-slack" class="pc-progress-slack" rows="${Math.min(16, slack.split('\n').length + 1)}">${esc(slack)}</textarea>
                    <div class="pc-progress-actions"><button class="pc-progress-act primary" onclick="pcProgressCopy()">[copy]</button></div>
                </div>` +
            list('ASKED OF YOU, NO SESSION TOUCHED IT', rep.askedNotWorked, i => `${esc(i.item)} <span class="pc-progress-sub">${esc(i.source)}${i.who ? ' · ' + esc(i.who) : ''}${i.due ? ' · due ' + esc(i.due) : ''}</span>`) +
            list('DONE, NOBODY ASKED', rep.workedNotAsked, i => esc(i)) +
            list('YOUR COLOUR VS THE CONVERSATION', rep.markMismatch, i => `<b>${esc(i.session)}</b>: ${esc(i.note)}`) +
            list('COULD NOT READ', rep.unread, i => esc(i)) +
            list('SESSIONS LEFT OUT', rep.skipped, i => `${esc(i.session)}: ${esc(i.why)}`) +
            `<div class="pc-progress-note">Read ${(rep.read || []).length} sessions · finished ${when(rep.finishedAt)}</div>`;
    } else if (rep && rep.phase === 'failed') {
        body = `<div class="pc-progress-note err">[!] ${esc(rep.error || 'failed')}</div>` +
            list('SESSIONS LEFT OUT', rep.skipped, i => `${esc(i.session)}: ${esc(i.why)}`);
    } else {
        const n = pcProgressScope().sessions.length;
        body = `<div class="pc-progress-note">Reads today's conversation of ${n === 1 ? 'this session' : `the ${n} sessions in this tab`} and checks it against ClickUp, Slack, Gmail, calendar and the vault. Takes a few minutes.</div>`;
    }

    const canRun = group && !pcProgress.busy;
    // Keep an edit he is making to the Slack text across the 4 s refresh.
    const prev = document.getElementById('pc-progress-slack');
    const keep = prev && document.activeElement === prev && rep && rep.phase === 'done' ? prev.value : null;
    if (keep !== null) return;
    ov.innerHTML = `<div class="pc-progress-box">
        <div class="pc-progress-top">
            <span>[R] PROGRESS · ${esc(group || 'no tab')}</span>
            <span>
                ${canRun ? `<button class="pc-progress-act" onclick="pcProgressRun()">${rep ? '[>] run again' : '[>] run'}</button>` : ''}
                <button class="pc-progress-act" onclick="pcProgressClose()">[x]</button>
            </span>
        </div>
        <div class="pc-progress-body">${body}</div>
    </div>`;
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pcProgress.open) pcProgressClose(); });
// A report started in another window, or before a reload, still lights the button.
setTimeout(pcProgressFetch, 3000);

// ==============================================
// SESSION GROUPING (desktop sidebar)
// Groups organize sessions visually (e.g. several sessions of one project) and
// drill down (collapse). Server-persisted via /api/sessions/groups (durable config)
// so they survive PWA refreshes AND server restarts. Assignment = drag & drop.
// Cable-safe: a session whose item is hidden in a collapsed group anchors its
// split-view cable to the GROUP HEADER instead of (0,0) — see pcCableAnchor().
// ==============================================

let pcDragSession = null;       // session name currently being dragged
let pcGroupsSaveTimer = null;

async function pcGroupsLoad() {
    try {
        const r = await fetch('/api/sessions/groups', {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') || '' }
        });
        if (!r.ok) return;
        const d = await r.json();
        Desktop.groups = {
            groups: Array.isArray(d.groups) ? d.groups : [],
            assignments: (d.assignments && typeof d.assignments === 'object') ? d.assignments : {}
        };
        if (typeof refreshPCSessions === 'function') refreshPCSessions();
    } catch (e) { /* offline / not ready — keep whatever we have */ }
}

function pcGroupsSave() {
    if (pcGroupsSaveTimer) clearTimeout(pcGroupsSaveTimer);
    pcGroupsSaveTimer = setTimeout(() => {
        fetch('/api/sessions/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': (typeof token !== 'undefined' ? token : '') || '' },
            body: JSON.stringify(Desktop.groups)
        }).catch(() => {});
    }, 250);
}

function pcGroupFind(id) {
    return (Desktop.groups.groups || []).find(g => g.id === id) || null;
}

function pcGroupCreate(name) {
    const raw = (name != null) ? name : (typeof prompt === 'function' ? prompt('New group name:', 'Group') : 'Group');
    if (raw == null) return null; // cancelled
    const clean = String(raw).trim() || 'Group';
    const id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    Desktop.groups.groups.push({ id, name: clean, collapsed: false });
    pcGroupsSave();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
    return id;
}

function pcGroupRename(id) {
    const g = pcGroupFind(id);
    if (!g) return;
    const nm = (typeof prompt === 'function') ? prompt('Rename group:', g.name || '') : null;
    if (nm == null) return;
    g.name = String(nm).trim() || g.name;
    pcGroupsSave();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
}

function pcGroupDelete(id) {
    const g = pcGroupFind(id);
    if (!g) return;
    if (typeof confirm === 'function' &&
        !confirm(`Delete group "${g.name}"? Its contents move up one level — sessions stay alive.`)) return;
    const parent = g.parent || null;   // where this group's contents move to
    // Sub-groups adopt this group's parent (or become top-level).
    (Desktop.groups.groups || []).forEach(x => { if (x.parent === id) x.parent = parent; });
    // Member sessions move to the parent group (or become ungrouped).
    const a = Desktop.groups.assignments || {};
    Object.keys(a).forEach(k => { if (a[k] === id) { if (parent) a[k] = parent; else delete a[k]; } });
    // Remove the group itself.
    Desktop.groups.groups = (Desktop.groups.groups || []).filter(x => x.id !== id);
    pcGroupsSave();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
    if (Desktop.combined.enabled && typeof pcCombineRenderCables === 'function') requestAnimationFrame(pcCombineRenderCables);
}

function pcGroupToggleCollapse(id) {
    const g = pcGroupFind(id);
    if (!g) return;
    g.collapsed = !g.collapsed;
    pcGroupsSave();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
    // Collapse/expand changes item visibility → cables must re-anchor.
    if (Desktop.combined.enabled && typeof pcCombineRenderCables === 'function') requestAnimationFrame(pcCombineRenderCables);
}

// ---- drag & drop ----
// A drag is either a SESSION (pcDragSession) or a GROUP (pcDragGroup) — never both.
let pcDragGroup = null;

function pcGroupDragStart(e, name) {
    pcDragSession = name;
    pcDragGroup = null;
    try { e.dataTransfer.setData('text/plain', name); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
    if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.add('pc-dragging');
    // Reveal drop affordances (ungroup hint, target rings) only while dragging.
    document.body.classList.add('pc-dragging-session');
}
// Dragging a GROUP by its header — to nest it inside another group (or out to top level).
// Kept structurally IDENTICAL to pcGroupDragStart (which works): no stopPropagation, and
// only the drag source (currentTarget) is mutated — never an ancestor, which can abort
// the native drag in Chromium if changed synchronously inside dragstart.
function pcGroupHeaderDragStart(e, groupId) {
    pcDragGroup = groupId;
    pcDragSession = null;
    try { e.dataTransfer.setData('text/plain', 'group:' + groupId); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
    if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.add('pc-dragging');
    document.body.classList.add('pc-dragging-session');
}
function pcGroupDragEnd(e) {
    pcDragSession = null;
    pcDragGroup = null;
    document.body.classList.remove('pc-dragging-session');
    document.querySelectorAll('.pc-drop-active, .pc-drop-target').forEach(el => el.classList.remove('pc-drop-active', 'pc-drop-target'));
    document.querySelectorAll('.pc-dragging').forEach(el => el.classList.remove('pc-dragging'));
}
function pcGroupDragOver(e) {
    e.preventDefault();
    e.stopPropagation();   // nested groups: only the innermost target highlights
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.add('pc-drop-active');
}
function pcGroupDragLeave(e) {
    // Only clear when the pointer actually left the drop zone (not just entered a child).
    if (e.currentTarget && !e.currentTarget.contains(e.relatedTarget)) {
        e.currentTarget.classList.remove('pc-drop-active');
    }
}
function pcGroupDrop(e, groupId) {
    e.preventDefault();
    e.stopPropagation();   // nested groups: don't also fire ancestor drop handlers
    if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.remove('pc-drop-active');
    document.body.classList.remove('pc-dragging-session');

    // A group was dropped → (re)parent it. groupId '' means top level.
    if (pcDragGroup) {
        const dg = pcDragGroup; pcDragGroup = null;
        pcGroupSetParent(dg, groupId || null);
        return;
    }

    const name = pcDragSession || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
    pcDragSession = null;
    if (!name || String(name).startsWith('group:')) return;
    const assign = Desktop.groups.assignments || (Desktop.groups.assignments = {});
    if (groupId) assign[name] = groupId; else delete assign[name];
    pcGroupsSave();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
}

// Re-parent a group, rejecting cycles (a group can't nest into itself or a descendant).
function pcGroupSetParent(childId, newParentId) {
    const child = pcGroupFind(childId);
    if (!child) { if (typeof toast === 'function') toast('group not found', 'error'); return; }
    if (childId === newParentId) {
        if (typeof toast === 'function') toast('drop it onto a DIFFERENT group to nest', 'warn');
        return;
    }
    if ((child.parent || null) === (newParentId || null)) {
        if (typeof toast === 'function') toast(newParentId ? 'already in that group' : '"' + child.name + '" is already top-level', 'warn');
        return;
    }
    if (newParentId) {
        let p = newParentId; const seen = new Set();
        while (p) {
            if (p === childId) {
                if (typeof toast === 'function') toast('can\'t nest a group inside its own sub-group', 'warn');
                return;
            }
            if (seen.has(p)) break; seen.add(p);
            const pg = pcGroupFind(p);
            p = pg ? pg.parent : null;
        }
    }
    child.parent = newParentId || null;
    if (typeof toast === 'function') {
        const parent = newParentId ? pcGroupFind(newParentId) : null;
        toast(parent ? `nested "${child.name}" into "${parent.name}"` : `"${child.name}" moved to top level`, 'success');
    }
    pcGroupsSave();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
    if (Desktop.combined.enabled && typeof pcCombineRenderCables === 'function') requestAnimationFrame(pcCombineRenderCables);
}

// ── Unified manual (mouse-based) sidebar drag — sessions AND groups ─────────
// Native HTML5 DnD proved unreliable here: the browser fired dragstart but REJECTED
// the drop (dragend, never drop). So ALL sidebar dragging is hand-rolled —
// mousedown → mousemove (5px threshold) → mouseup, with elementFromPoint hit-testing.
// Drop targets: another session, a group, or the ungrouped zone (= pull out to top).
let pcPendingRenameId = null;
// ==============================================
// RAIL + PANEL
// The sidebar used to stack all five sections at once in a fixed 220px column,
// so a long tmux session list pushed Git/SF/Notes out of sight and there was no
// way to widen or hide anything. Now: a permanent 44px rail of icons, ONE panel
// open at a time, draggable width, collapsible to rail-only. The section markup
// is untouched -- only its container changed -- so every existing handler
// (refreshPCSessions, git, sf, notes) keeps working.
// ==============================================
const SIDEBAR_MIN_W = 180, SIDEBAR_MAX_W = 520, SIDEBAR_RAIL_W = 44;

function pcSidebarApplyWidth(px) {
    const w = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, Math.round(px)));
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    return w;
}

function pcSidebarSetCollapsed(on, opts) {
    const sidebar = document.querySelector('.pc-sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('rail-only', !!on);
    if (on) {
        document.documentElement.style.setProperty('--sidebar-w', SIDEBAR_RAIL_W + 'px');
    } else {
        pcSidebarApplyWidth(parseInt(pcPrefGet('pc_sidebar_w', 'window', '260'), 10) || 260);
    }
    if (!opts || !opts.silent) pcPrefSet('pc_sidebar_collapsed', on ? '1' : '0', 'window');
    // Width changed -> every cable anchor moved.
    if (Desktop.combined.enabled && typeof pcCombineRenderCables === 'function') {
        requestAnimationFrame(pcCombineRenderCables);
    }
}

function pcSidebarToggleCollapse() {
    const sidebar = document.querySelector('.pc-sidebar');
    pcSidebarSetCollapsed(!(sidebar && sidebar.classList.contains('rail-only')));
}

function pcRailSelect(panel, opts) {
    const sidebar = document.querySelector('.pc-sidebar');
    if (!sidebar) return;
    const collapsed = sidebar.classList.contains('rail-only');
    const current = pcPrefGet('pc_sidebar_panel', 'window', 'sessions');

    // Clicking the icon of the panel already open closes the panel (VS Code).
    if (!collapsed && current === panel && !(opts && opts.force)) {
        pcSidebarSetCollapsed(true);
        return;
    }

    pcPrefSet('pc_sidebar_panel', panel, 'window');
    sidebar.querySelectorAll('.pc-rail-item[data-panel]').forEach(b => {
        b.classList.toggle('active', b.dataset.panel === panel);
    });
    sidebar.querySelectorAll('.pc-sidebar-section[data-panel]').forEach(sec => {
        sec.classList.toggle('hidden', sec.dataset.panel !== panel);
    });

    // SF loads its module on first click of its section; opening it from the rail
    // has to trigger the same lazy load or the panel shows "Click to load".
    if (panel === 'sf' && typeof pcSfLazyInit === 'function') pcSfLazyInit();

    // Usage measures ONCE on its first open and never again on its own — every
    // later open just re-renders. Opening the panel must not be a way to start a
    // 150 MB scan by accident, and neither must reloading the PWA with the panel
    // left open, which is why the boot restore below passes `restoring`.
    if (panel === 'usage' && window.Usage) window.Usage.onOpen(opts);

    if (collapsed) pcSidebarSetCollapsed(false);
    else if (Desktop.combined.enabled && typeof pcCombineRenderCables === 'function') {
        requestAnimationFrame(pcCombineRenderCables);
    }
}

// Drag-to-resize. Hand-rolled for the same reason the sidebar drag is
// (2026-07-13: the browser refused HTML5 drops on group headers), and because a
// pointer drag needs no drag image here anyway.
let pcSidebarResize = null;

function pcSidebarResizeStart(e) {
    e.preventDefault();
    const sidebar = document.querySelector('.pc-sidebar');
    if (!sidebar || sidebar.classList.contains('rail-only')) return;
    pcSidebarResize = { startX: e.clientX, startW: sidebar.getBoundingClientRect().width, raf: 0, last: 0 };
    document.body.classList.add('pc-resizing');
    document.addEventListener('mousemove', pcSidebarResizeMove, true);
    document.addEventListener('mouseup', pcSidebarResizeEnd, true);
}

function pcSidebarResizeMove(e) {
    const r = pcSidebarResize;
    if (!r) return;
    r.last = r.startW + (e.clientX - r.startX);
    if (r.raf) return;               // coalesce to one write per frame
    r.raf = requestAnimationFrame(() => {
        r.raf = 0;
        if (pcSidebarResize) pcSidebarApplyWidth(pcSidebarResize.last);
    });
}

function pcSidebarResizeEnd() {
    document.removeEventListener('mousemove', pcSidebarResizeMove, true);
    document.removeEventListener('mouseup', pcSidebarResizeEnd, true);
    document.body.classList.remove('pc-resizing');
    const r = pcSidebarResize;
    pcSidebarResize = null;
    if (!r) return;
    if (r.raf) cancelAnimationFrame(r.raf);
    const w = pcSidebarApplyWidth(r.last);
    pcPrefSet('pc_sidebar_w', w, 'window');
    if (Desktop.combined.enabled && typeof pcCombineRenderCables === 'function') {
        requestAnimationFrame(pcCombineRenderCables);
    }
}

// Double-click the handle resets to the viewport's default width.
function pcSidebarResizeReset() {
    document.documentElement.style.removeProperty('--sidebar-w');
    pcPrefSet('pc_sidebar_w', null, 'window');
    if (Desktop.combined.enabled && typeof pcCombineRenderCables === 'function') {
        requestAnimationFrame(pcCombineRenderCables);
    }
}

// Restore this window's own sidebar layout. Per-window on purpose: two monitors
// of different sizes want different widths, and a second window should not
// inherit the first one's panel.
function pcSidebarInitLayout() {
    const saved = parseInt(pcPrefGet('pc_sidebar_w', 'window', ''), 10);
    if (saved) pcSidebarApplyWidth(saved);
    // `restoring` marks this as the boot path, not a click: a panel that measures
    // or loads on open must not do it just because the window came back.
    pcRailSelect(pcPrefGet('pc_sidebar_panel', 'window', 'sessions'), { force: true, restoring: true });
    if (pcPrefGet('pc_sidebar_collapsed', 'window', '0') === '1') {
        pcSidebarSetCollapsed(true, { silent: true });
    }
}

let pcSidebarDrag = null;             // { kind:'session'|'group', id, startX, startY, active, ghost }
let pcSidebarSuppressClick = false;   // swallow the click that follows a real drag

function pcSidebarDragStart(e, kind, id) {
    if (e.button !== 0) return;       // left button only
    // Never hijack the interactive controls inside an item/header.
    if (e.target.closest && e.target.closest(
        '.pc-group-del, .pc-group-name-input, .pc-session-kill, .pc-combine-check, .pc-session-color')) return;
    // Stop the browser from starting a text selection on press-drag (click/dblclick
    // still fire, so switch-session / collapse / rename all keep working).
    e.preventDefault();
    pcSidebarDrag = { kind, id, startX: e.clientX, startY: e.clientY, active: false, ghost: null };
    document.addEventListener('mousemove', pcSidebarDragMove, true);
    document.addEventListener('mouseup', pcSidebarDragEnd, true);
}

function pcSidebarDropTarget(x, y) {
    const el = document.elementFromPoint(x, y);   // ghost is pointer-events:none → ignored
    if (!el) return null;
    const sess = el.closest('.pc-session-item');
    if (sess && sess.dataset.session) return { type: 'session', name: sess.dataset.session, el: sess };
    const grp = el.closest('.pc-group');
    if (grp && grp.dataset.groupId) return { type: 'group', groupId: grp.dataset.groupId, el: grp };
    const uz = el.closest('.pc-ungrouped-zone');
    if (uz) return { type: 'ungrouped', el: uz };
    return null;
}

function pcSidebarDragMove(e) {
    const d = pcSidebarDrag;
    if (!d) return;
    if (!d.active) {
        if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 5) return;
        d.active = true;              // crossed the threshold → it's a real drag
        document.body.classList.add('pc-dragging-session', 'pc-manual-dragging');
        const label = d.kind === 'group' ? ((pcGroupFind(d.id) || {}).name || 'group') : d.id;
        const ghost = document.createElement('div');
        ghost.className = 'pc-group-drag-ghost';
        ghost.textContent = label;
        document.body.appendChild(ghost);
        d.ghost = ghost;
        const src = d.kind === 'group'
            ? document.querySelector(`.pc-group[data-group-id="${d.id}"]`)
            : document.querySelector(`.pc-session-item[data-session="${d.id}"]`);
        if (src) src.classList.add('pc-dragging');
    }
    if (d.ghost) {
        d.ghost.style.left = (e.clientX + 12) + 'px';
        d.ghost.style.top = (e.clientY + 12) + 'px';
    }
    document.querySelectorAll('.pc-drop-active, .pc-drop-target').forEach(el => el.classList.remove('pc-drop-active', 'pc-drop-target'));
    const tgt = pcSidebarDropTarget(e.clientX, e.clientY);
    if (tgt && tgt.el) tgt.el.classList.add(tgt.type === 'session' ? 'pc-drop-target' : 'pc-drop-active');
    e.preventDefault();               // suppress text selection while dragging
}

async function pcSidebarDragEnd(e) {
    document.removeEventListener('mousemove', pcSidebarDragMove, true);
    document.removeEventListener('mouseup', pcSidebarDragEnd, true);
    const d = pcSidebarDrag;
    pcSidebarDrag = null;
    if (!d) return;
    // CRITICAL: hit-test the drop target BEFORE tearing down drag state. Removing
    // `pc-dragging-session` collapses the drophint + the ungrouped zone's min-height,
    // which would shift the layout and move the target out from under the cursor.
    // (The ghost is pointer-events:none, so it never interferes with elementFromPoint.)
    const tgt = d.active ? pcSidebarDropTarget(e.clientX, e.clientY) : null;

    document.body.classList.remove('pc-dragging-session', 'pc-manual-dragging');
    document.querySelectorAll('.pc-drop-active, .pc-drop-target').forEach(el => el.classList.remove('pc-drop-active', 'pc-drop-target'));
    if (d.ghost) d.ghost.remove();
    const src = d.kind === 'group'
        ? document.querySelector(`.pc-group[data-group-id="${d.id}"]`)
        : document.querySelector(`.pc-session-item[data-session="${d.id}"]`);
    if (src) src.classList.remove('pc-dragging');
    if (!d.active) return;            // no movement → a plain click; let onclick handle it
    pcSidebarSuppressClick = true;
    setTimeout(() => { pcSidebarSuppressClick = false; }, 0);

    if (!tgt) { if (typeof toast === 'function') toast('drop onto a session, a group, or the top area', 'warn'); return; }

    // Dragging a GROUP → nest / un-nest it.
    if (d.kind === 'group') {
        const parentId = tgt.type === 'group' ? tgt.groupId
                       : tgt.type === 'session' ? ((Desktop.groups.assignments || {})[tgt.name] || null)
                       : null;        // ungrouped zone → top level
        pcGroupSetParent(d.id, parentId);
        return;
    }

    // Dragging a SESSION → move it between groups / the ungrouped zone.
    const assign = Desktop.groups.assignments || (Desktop.groups.assignments = {});
    if (tgt.type === 'ungrouped') {
        if (!assign[d.id]) { if (typeof toast === 'function') toast(`"${d.id}" is already ungrouped`, 'warn'); return; }
        delete assign[d.id];
        if (typeof toast === 'function') toast(`pulled "${d.id}" out to top level`, 'success');
    } else if (tgt.type === 'group') {
        if (assign[d.id] === tgt.groupId) { if (typeof toast === 'function') toast('already in that group', 'warn'); return; }
        assign[d.id] = tgt.groupId;
        const g = pcGroupFind(tgt.groupId);
        if (typeof toast === 'function') toast(`moved "${d.id}" into "${g ? g.name : 'group'}"`, 'success');
    } else { // tgt.type === 'session'
        if (tgt.name === d.id) return;               // dropped on itself
        const targetGid = assign[tgt.name];
        if (targetGid) {
            if (assign[d.id] === targetGid) { if (typeof toast === 'function') toast('already grouped together', 'warn'); return; }
            assign[d.id] = targetGid;                // join the target session's group
            const g = pcGroupFind(targetGid);
            if (typeof toast === 'function') toast(`grouped "${d.id}" with "${tgt.name}"`, 'success');
        } else {
            // both ungrouped → auto-create a group with both, open inline rename
            const id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            Desktop.groups.groups.push({ id, name: 'New group', collapsed: false });
            assign[tgt.name] = id;
            assign[d.id] = id;
            pcPendingRenameId = id;
            if (typeof toast === 'function') toast('new group created', 'success');
        }
    }
    pcGroupsSave();
    if (typeof refreshPCSessions === 'function') await refreshPCSessions();
    if (pcPendingRenameId) { const rid = pcPendingRenameId; pcPendingRenameId = null; pcGroupStartRename(rid); }
}

// Session item click — switch session, unless a drag just happened.
// Clicking a row means "show me THIS session", so a split on screen steps aside. Nothing
// is lost: pcCombineDisable saves the layout into its group on the way out, so the chip
// above the terminal brings the whole split back — panels, focus and divider — in one
// click. The three ways in and the one way out stay symmetric: chip / folder [Split] /
// [Split] button open a group, a session row opens a session.
function pcSidebarItemClick(e, name) {
    if (pcSidebarSuppressClick) { pcSidebarSuppressClick = false; return; }
    if (Desktop.combined.enabled) { pcCombineDisable(name); return; }
    if (typeof pcSwitchSession === 'function') pcSwitchSession(name);
}

// Group header click: collapse/expand, unless a drag just happened or the click hit
// the name (rename target) or the delete button.
function pcGroupHeaderClick(e, id) {
    if (pcSidebarSuppressClick) { pcSidebarSuppressClick = false; return; }
    if (e.target.closest && e.target.closest('.pc-group-name, .pc-group-name-input, .pc-group-del')) return;
    pcGroupToggleCollapse(id);
}

// Inline rename — replaces the name label with a focused input (no native prompt).
function pcGroupStartRename(id) {
    const g = pcGroupFind(id);
    if (!g) return;
    const groupEl = document.querySelector(`.pc-group[data-group-id="${id}"]`);
    const nameEl = groupEl ? groupEl.querySelector(':scope > .pc-group-header > .pc-group-name') : null;
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'pc-group-name-input';
    input.type = 'text';
    input.value = g.name || '';
    input.spellcheck = false;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
        if (done) return; done = true;
        if (save) { const v = input.value.trim(); if (v) g.name = v; }
        pcGroupsSave();
        pcSessionsHtml = '';   // the input replaced a node by hand; an unchanged name must still repaint
        if (typeof refreshPCSessions === 'function') refreshPCSessions();
    };
    input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
}

// ---- rendering ----
function pcRenderSessionItem(s, current) {
    const isActive = s.name === current;
    const isSelected = Desktop.combined.sessions.includes(s.name);
    let status = 'idle';
    if (s.hasPermissionRequest) status = 'perm';
    else if (s.isWorking) status = 'working';

    const isProtected = s.protected || s.name === 'server' || s.name.startsWith('run-');
    const killBtn = isProtected ? '' : `<button class="pc-session-kill" onclick="event.stopPropagation(); pcKillSession('${s.name}')" title="Kill session">[x]</button>`;

    const checkbox = `<input type="checkbox" class="pc-combine-check"
        ${isSelected ? 'checked' : ''}
        onclick="event.stopPropagation(); pcCombineToggleSession('${s.name}')"
        title="Select for split view">`;

    const ucolor = pcPanelIdentity.colors[s.name] || null;
    const meaning = ucolor ? (pcPanelIdentity.meanings[ucolor] || '') : '';
    const chipTitle = ucolor ? (meaning ? meaning + ' — click to change' : 'click to set meaning/color') : 'click to assign a color';
    const colorChip = `<span class="pc-session-color ${ucolor ? '' : 'empty'}"
        style="${ucolor ? `background:${ucolor};` : ''}"
        title="${escapeHtml(chipTitle)}"
        onclick="event.stopPropagation(); pcSidebarColorMenu('${s.name}', this)"></span>`;
    const accent = ucolor ? `border-left:3px solid ${ucolor};` : '';
    const gid = (Desktop.groups.assignments || {})[s.name] || '';

    return `
        <div class="pc-session-item ${isActive ? 'active' : ''} ${isSelected ? 'combined' : ''}"
             data-session="${s.name}" data-status="${status}" data-group="${gid}"
             data-attention="${Desktop.sessionStates[s.name] || ''}"
             onmousedown="pcSidebarDragStart(event,'session','${s.name}')"
             style="${accent}"
             onclick="pcSidebarItemClick(event,'${s.name}')"
             title="Drag onto a session/group to group · drag to the top to ungroup">
            ${checkbox}
            <div class="dot ${status}"></div>
            ${colorChip}
            <span>${s.name}${window.SessionWeight ? window.SessionWeight.badge(s.name) : ''}</span>
            ${killBtn}
        </div>
    `;
}

// The folder index, rebuilt from the LIVE session list on every refresh — never from
// the filtered one, so typing in the filter box can't silently shrink a folder's split.
let pcGroupIndex = null;

function pcBuildGroupIndex(sessions) {
    const G = Desktop.groups || (Desktop.groups = { groups: [], assignments: {} });
    const groups = Array.isArray(G.groups) ? G.groups : [];
    const assign = G.assignments || {};
    const groupIds = new Set(groups.map(g => g.id));

    // Live sessions per group; the rest are ungrouped.
    const sessionsOf = {}; groups.forEach(g => { sessionsOf[g.id] = []; });
    const ungrouped = [];
    sessions.forEach(s => {
        const gid = assign[s.name];
        if (gid && groupIds.has(gid)) sessionsOf[gid].push(s);
        else ungrouped.push(s);
    });

    // Child groups per parent; a group with no valid parent is top-level.
    const childrenOf = {}; groups.forEach(g => { childrenOf[g.id] = []; });
    const topGroups = [];
    groups.forEach(g => {
        const p = g.parent;
        if (p && groupIds.has(p) && p !== g.id) childrenOf[p].push(g);
        else topGroups.push(g);
    });

    return { groups, groupIds, sessionsOf, childrenOf, topGroups, ungrouped };
}

// Living sessions in a folder's WHOLE subtree, depth-first. Note this is a different
// number from the header count, which is members+sub-folders by design: "Marketing 3"
// means three sub-folders, and may hold exactly one actual tmux. Focus mode and the
// per-folder split both need the real one.
function pcGroupLiveSessions(gid, ix, seen) {
    ix = ix || pcGroupIndex;
    if (!ix) return [];
    seen = seen || new Set();
    if (seen.has(gid)) return [];       // corrupt parent cycle
    seen.add(gid);
    let out = (ix.childrenOf[gid] || []).reduce(
        (acc, cg) => acc.concat(pcGroupLiveSessions(cg.id, ix, seen)), []);
    return out.concat((ix.sessionsOf[gid] || []).map(s => s.name));
}

function pcGroupLiveCount(gid, ix) {
    return pcGroupLiveSessions(gid, ix).length;
}

function pcRenderSessionsGrouped(sessions, current) {
    const ix = pcBuildGroupIndex(sessions);
    const hasGroups = ix.groups.length > 0;
    let html = '';

    // Ungrouped zone — the drop target that pulls a session/group out to top level.
    // (Manual drag hit-tests this by elementFromPoint; no native DnD handlers.)
    html += `<div class="pc-ungrouped-zone" data-group="">`;
    html += ix.ungrouped.map(s => pcRenderSessionItem(s, current)).join('');
    if (hasGroups && !Desktop.focusMode) {
        html += `<div class="pc-group-drophint">drop here to pull out to top level</div>`;
    }
    html += `</div>`;

    // Recursive group tree (groups can contain sub-groups).
    const visited = new Set();
    ix.topGroups.forEach(g => { html += pcRenderGroupTree(g, current, ix, [], visited); });
    // Fallback: if a corrupt parent-cycle left any group unrendered, surface it at top
    // level so its sessions never silently disappear.
    ix.groups.forEach(g => { if (!visited.has(g.id)) html += pcRenderGroupTree(g, current, ix, [], visited); });

    return html;
}

// `chain` = the ancestor folders whose own header was folded away by focus mode; they
// come back as the breadcrumb on this folder's header, so no context is lost.
function pcRenderGroupTree(g, current, ix, chain, visited) {
    if (visited.has(g.id)) return '';   // guard against a corrupt parent cycle
    visited.add(g.id);

    const focus = !!Desktop.focusMode;
    const childGroups = ix.childrenOf[g.id] || [];
    const members = ix.sessionsOf[g.id] || [];
    const live = pcGroupLiveCount(g.id, ix);
    let shownChildren = childGroups;

    if (focus) {
        if (live === 0) return '';                       // nothing alive under here
        shownChildren = childGroups.filter(cg => pcGroupLiveCount(cg.id, ix) > 0);
        // A folder holding nothing but ONE live sub-folder is a step on a path, not a
        // level worth its own row: fold it into the next header's breadcrumb.
        if (members.length === 0 && shownChildren.length === 1) {
            return pcRenderGroupTree(shownChildren[0], current, ix, chain.concat(g), visited);
        }
    }

    const collapsed = !!g.collapsed;
    const count = members.length + childGroups.length;   // count includes sub-groups
    // The breadcrumb is the folded ancestors + this folder; each part stays individually
    // renameable-by-identity, so the cable anchor can still find any of them.
    const crumb = chain.map(a => `<span class="pc-group-crumb">${escapeHtml(a.name || 'Group')}</span>`).join('');
    const nm = escapeHtml(g.name || 'Group');
    // A folded ancestor still has to be findable by pcCableAnchor — it has no element
    // of its own any more, so this header answers for the whole chain.
    const chainAttr = chain.length ? ` data-chain="${chain.map(a => a.id).join(' ')}"` : '';

    // Per-folder split: any folder with 2+ living tmux under it can arm its own group.
    const isActiveSplit = Desktop.combined.enabled && Desktop.combined.groupId === g.id;
    const armed = !!Desktop.splitGroups[g.id];
    const splitBtns = live >= 2
        ? `<button class="pc-group-split ${isActiveSplit ? 'active' : ''}"
                   onclick="event.stopPropagation(); pcFolderSplit('${g.id}')"
                   title="Split this folder's ${live} sessions">[Split]</button>` +
          (armed ? `<button class="pc-group-split"
                   onclick="event.stopPropagation(); pcFolderUnsplit('${g.id}')"
                   title="Drop this folder's split group">[Unsplit]</button>` : '')
        : '';

    // Sub-groups render first, then this group's own sessions.
    const childHtml = shownChildren.map(cg => pcRenderGroupTree(cg, current, ix, [], visited)).join('');
    const memberHtml = members.map(s => pcRenderSessionItem(s, current)).join('');
    const bodyInner = (childHtml + memberHtml) ||
        (focus ? '' : '<div class="pc-group-empty">drop a session or group here</div>');

    return `
      <div class="pc-group ${collapsed ? 'collapsed' : ''} ${isActiveSplit ? 'split-active' : ''}" data-group-id="${g.id}"${chainAttr}>
        <div class="pc-group-header" data-group-id="${g.id}"
             onmousedown="pcSidebarDragStart(event,'group','${g.id}')"
             onclick="pcGroupHeaderClick(event,'${g.id}')">
          <span class="pc-group-chevron">${collapsed ? '▸' : '▾'}</span>
          <span class="pc-group-name" ondblclick="event.stopPropagation(); pcGroupStartRename('${g.id}')"
                title="Drag to nest · double-click to rename">${crumb}${nm}</span>
          <span class="pc-group-count">${focus ? live : count}</span>
          ${splitBtns}
          <button class="pc-group-del" onclick="event.stopPropagation(); pcGroupDelete('${g.id}')" title="Delete group (contents move up)">&times;</button>
        </div>
        <div class="pc-group-body">${bodyInner}</div>
      </div>`;
}

// Focus mode: prune the tree to the folders that hold a living tmux, and fold every
// single-child step into one breadcrumb line. A view mode — it touches no group data,
// so turning it off restores the tree exactly.
function pcToggleFocusMode() {
    Desktop.focusMode = !Desktop.focusMode;
    pcApplyFocusMode();
    pcPrefSet('pcFocusMode', Desktop.focusMode ? '1' : '', 'window');
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
}

function pcApplyFocusMode() {
    document.body.classList.toggle('pc-focus-sessions', !!Desktop.focusMode);
    const btn = document.getElementById('pc-focus-btn');
    if (btn) btn.classList.toggle('active', !!Desktop.focusMode);
    // Folded/hidden headers move every anchor point in the sidebar.
    if (Desktop.combined.enabled && typeof pcCombineRenderCables === 'function') {
        requestAnimationFrame(pcCombineRenderCables);
    }
}

// Cable anchor: prefer the visible session item; if it is hidden inside a collapsed
// group, anchor to that group's header instead so the cable never snaps to (0,0).
function pcCableAnchor(session) {
    const item = document.querySelector(`.pc-session-item[data-session="${session}"]`);
    if (item && item.offsetParent !== null) return item;
    // Walk UP the group tree to the nearest VISIBLE ancestor header (a nested group
    // inside a collapsed parent is itself hidden, so keep climbing).
    let gid = (Desktop.groups.assignments || {})[session];
    const seen = new Set();
    while (gid && !seen.has(gid)) {
        seen.add(gid);
        // In focus mode a folder can have been folded into a descendant's breadcrumb and
        // have no element of its own — `data-chain` is how that header answers for it.
        const groupEl = document.querySelector(`.pc-group[data-group-id="${gid}"]`)
            || document.querySelector(`.pc-group[data-chain~="${gid}"]`);
        const hdr = groupEl ? groupEl.querySelector(':scope > .pc-group-header') : null;
        if (hdr && hdr.offsetParent !== null) return hdr;
        const g = pcGroupFind(gid);
        gid = g ? g.parent : null;
    }
    // Nothing in the session list is visible -- the Sessions panel is closed, or the
    // whole sidebar is collapsed to the rail. Anchor to the rail's Sessions icon,
    // which is the one element that is ALWAYS on screen. Cables then converge on it
    // instead of vanishing (or snapping to 0,0), and the geometry stays honest at any
    // sidebar width. This is why the rail exists as a permanent element.
    const railItem = document.querySelector('.pc-rail-item[data-panel="sessions"]');
    if (railItem && railItem.offsetParent !== null) return railItem;
    return null;
}

// ---- Absolute positioning layout ----
// Each panel has bounds {x, y, w, h} as percentages (0-100)
const PC_PANEL_GAP = 2; // px gap between panels

// Every row fills the full width (2026-10-05, Leon: "que los paneles no se
// organicen asi desperdiciando espacio" - 13 panels on a 4x4 grid left three
// empty cells in the last row). Rows are chosen for the screen's shape: the
// count whose panels come closest to a terminal-ish 1.8:1, then the panels are
// spread 4,3,3,3 (the fuller rows on top), each row split evenly.
const PC_PANEL_ASPECT = 1.8;
function pcRowsFor(count, aspect) {
    let best = 1, bestDiff = Infinity;
    for (let r = 1; r <= count; r++) {
        const perRow = Math.ceil(count / r);
        if (Math.ceil(count / perRow) < r) continue;         // a row would be empty
        const cell = (aspect / perRow) * r;                   // width/height of one panel
        const diff = Math.abs(Math.log(cell / PC_PANEL_ASPECT));
        if (diff < bestDiff) { bestDiff = diff; best = r; }
    }
    return best;
}
function pcInitBounds(count) {
    if (count <= 0) return [];
    const grid = document.getElementById('pc-combined-grid');
    const rect = grid ? grid.getBoundingClientRect() : null;
    const aspect = rect && rect.height > 50 ? rect.width / rect.height : 16 / 9;
    const rows = pcRowsFor(count, aspect);
    const base = Math.floor(count / rows), extra = count % rows;
    const bounds = [];
    for (let r = 0; r < rows; r++) {
        const n = base + (r < extra ? 1 : 0);
        for (let c = 0; c < n; c++) bounds.push({ x: c * 100 / n, y: r * 100 / rows, w: 100 / n, h: 100 / rows });
    }
    return bounds;
}
// How much of the grid the panels cover, in %: a saved layout with holes in
// it (an old 4x4 with an empty corner) is re-tiled instead of kept.
function pcBoundsCoverage(bounds) {
    return (bounds || []).reduce((s, b) => s + (b.w * b.h) / 100, 0);
}
// Double-click on any panel edge: everything back to an even tiling.
function pcRetile() {
    Desktop.combined.panelBounds = pcInitBounds(Desktop.combined.sessions.length);
    pcUpdatePanelPositions();
    pcSplitSave();
    setTimeout(pcCombineRenderCables, 50);
}

function pcUpdatePanelPositions() {
    const bounds = Desktop.combined.panelBounds;
    if (!bounds) return;
    const g = PC_PANEL_GAP;
    bounds.forEach((b, idx) => {
        const panel = document.getElementById('pc-combined-panel-' + idx);
        if (!panel) return;
        panel.style.left = `calc(${b.x}% + ${g}px)`;
        panel.style.top = `calc(${b.y}% + ${g}px)`;
        panel.style.width = `calc(${b.w}% - ${g * 2}px)`;
        panel.style.height = `calc(${b.h}% - ${g * 2}px)`;
    });
}

// Find all panel indices that share an edge with panel idx in the given direction
function pcFindNeighbors(idx, dir) {
    const bounds = Desktop.combined.panelBounds;
    if (!bounds) return [];
    const a = bounds[idx];
    const eps = 1.5; // tolerance in %
    const neighbors = [];

    for (let i = 0; i < bounds.length; i++) {
        if (i === idx) continue;
        const b = bounds[i];
        // Vertical overlap helper
        const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        // Horizontal overlap helper
        const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);

        if (dir === 'right' && Math.abs((a.x + a.w) - b.x) < eps && yOverlap > eps) {
            neighbors.push(i);
        } else if (dir === 'left' && Math.abs(a.x - (b.x + b.w)) < eps && yOverlap > eps) {
            neighbors.push(i);
        } else if (dir === 'bottom' && Math.abs((a.y + a.h) - b.y) < eps && xOverlap > eps) {
            neighbors.push(i);
        } else if (dir === 'top' && Math.abs(a.y - (b.y + b.h)) < eps && xOverlap > eps) {
            neighbors.push(i);
        }
    }
    return neighbors;
}

// Edge resize: drag a panel edge, affecting only it and its direct neighbors
function pcEdgeResizeStart(e, idx, dir) {
    e.preventDefault();
    e.stopPropagation();

    const grid = document.getElementById('pc-combined-grid');
    if (!grid) return;
    const bounds = Desktop.combined.panelBounds;
    if (!bounds) return;

    // THE WHOLE LINE moves (2026-10-05, "para acomodar los tamanos se me complica,
    // habria que hacerlo mas flexible"). Dragging one panel's edge used to move
    // only the panels touching THAT panel, so the panels above and below kept the
    // old edge, the line broke into steps, and the next drag found no neighbour.
    // Now: every panel whose edge sits on the same line, on either side, chained
    // along it from the one he grabbed, moves together.
    const isH = (dir === 'left' || dir === 'right');
    const P = isH ? 'x' : 'y', S = isH ? 'w' : 'h';           // along the drag
    const Q = isH ? 'y' : 'x', T = isH ? 'h' : 'w';           // along the line
    const a0 = bounds[idx];
    const line = (dir === 'right' || dir === 'bottom') ? a0[P] + a0[S] : a0[P];
    const eps = 1.5;
    const ends = (b) => Math.abs(b[P] + b[S] - line) < eps;     // panel before the line
    const starts = (b) => Math.abs(b[P] - line) < eps;          // panel after the line
    const before = new Set(), after = new Set();
    let lo = a0[Q], hi = a0[Q] + a0[T];
    for (let grew = true; grew;) {
        grew = false;
        bounds.forEach((b, i) => {
            if (before.has(i) || after.has(i)) return;
            if (Math.min(hi, b[Q] + b[T]) - Math.max(lo, b[Q]) <= eps) return;
            if (ends(b)) before.add(i); else if (starts(b)) after.add(i); else return;
            lo = Math.min(lo, b[Q]); hi = Math.max(hi, b[Q] + b[T]);
            grew = true;
        });
    }

    const gridRect = grid.getBoundingClientRect();
    const startPos = isH ? e.clientX : e.clientY;
    const totalSize = isH ? gridRect.width : gridRect.height;
    const snap = bounds.map(b => ({...b})); // snapshot
    const minPct = 5;
    // How far the line can go: each side keeps minPct; with nothing on one side
    // it can grow into the empty room up to the wall.
    const minDelta = before.size ? -Math.min(...[...before].map(i => snap[i][S] - minPct)) : -line;
    const maxDelta = after.size ? Math.min(...[...after].map(i => snap[i][S] - minPct)) : 100 - line;

    document.body.style.cursor = isH ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
    grid.classList.add('resizing');

    const onMove = (ev) => {
        const pos = isH ? ev.clientX : ev.clientY;
        const d = Math.max(minDelta, Math.min(maxDelta, (pos - startPos) / totalSize * 100));
        before.forEach(i => { bounds[i][S] = snap[i][S] + d; });
        after.forEach(i => { bounds[i][P] = snap[i][P] + d; bounds[i][S] = snap[i][S] - d; });
        pcUpdatePanelPositions();
    };

    const onEnd = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        grid.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        pcSplitSave();
        setTimeout(pcCombineRenderCables, 50);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
}

// Drag-to-swap panels
function pcPanelSwapStart(e, idx) {
    // Ignore if clicking buttons, input, color picker
    if (e.target.closest('.pc-rename-input, button, .pc-color-picker, .pc-panel-font, .pc-edge')) return;

    e.preventDefault();   // no text selection while dragging a panel to swap
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    let ghost = null;

    const onMove = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!dragging && Math.abs(dx) + Math.abs(dy) > 12) {
            dragging = true;
            ghost = document.createElement('div');
            ghost.className = 'pc-swap-ghost';
            const session = Desktop.combined.sessions[idx];
            ghost.textContent = pcPanelIdentity.aliases[session] || session;
            document.body.appendChild(ghost);
        }
        if (dragging && ghost) {
            ghost.style.left = (ev.clientX + 12) + 'px';
            ghost.style.top = (ev.clientY + 12) + 'px';
            // Highlight target
            document.querySelectorAll('.pc-combined-panel').forEach(p => p.classList.remove('swap-target'));
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const target = el ? el.closest('.pc-combined-panel') : null;
            if (target && parseInt(target.dataset.index) !== idx) {
                target.classList.add('swap-target');
            }
        }
    };

    const onEnd = (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        if (ghost) ghost.remove();
        document.querySelectorAll('.pc-combined-panel').forEach(p => p.classList.remove('swap-target'));

        if (dragging) {
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const target = el ? el.closest('.pc-combined-panel') : null;
            if (target) {
                const ti = parseInt(target.dataset.index);
                if (!isNaN(ti) && ti !== idx) {
                    // Swap sessions (keep bounds, swap content)
                    const s = Desktop.combined.sessions;
                    [s[idx], s[ti]] = [s[ti], s[idx]];
                    pcCombineRender();
                    pcSplitSave();
                    if (typeof toast === 'function') toast('Panels swapped', 'info');
                }
            }
        }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
}

// Enable split view
function pcCombineEnable(restoring) {
    // If no sessions selected, try restoring from saved state
    if (!restoring && Desktop.combined.sessions.length < 2) {
        const saved = pcSplitLoad();
        if (saved && saved.sessions && saved.sessions.length >= 2) {
            Desktop.combined.sessions = saved.sessions;
            Desktop.combined.activeIndex = saved.activeIndex || 0;
            pcSyncCombineChecks();
        } else {
            if (typeof toast === 'function') toast('Select at least 2 sessions', 'warning');
            return;
        }
    }
    // Reached from the sidebar [Split] button with no group in play: that is the
    // manual checkbox selection.
    if (Desktop.combined.groupId == null) Desktop.combined.groupId = '';

    Desktop.combined.enabled = true;
    if (!restoring) Desktop.combined.activeIndex = Desktop.combined.activeIndex || 0;

    // Hide normal terminal, show combined
    const terminalWrap = document.querySelector('.pc-terminal-wrap');
    const combinedWrap = document.getElementById('pc-combined-wrap');

    if (terminalWrap) terminalWrap.classList.add('hidden');
    if (combinedWrap) combinedWrap.classList.remove('hidden');

    // Restore saved bounds before render
    const savedState = pcSplitLoad();
    if (savedState && savedState.bounds && savedState.bounds.length === Desktop.combined.sessions.length) {
        Desktop.combined.panelBounds = savedState.bounds;
    }

    // Render panels and start polling
    pcCombineRender();
    pcCombineStartPolling();

    // Hide combine mode indicator
    document.body.classList.remove('pc-combine-mode');

    pcSplitSave();
    if (typeof toast === 'function') toast(`Split view: ${Desktop.combined.sessions.length} panels`, 'success');
}

// Disable split view (saves state so re-enabling restores it).
// `nextSession` = the session to land on in single view. The sidebar passes the row you
// clicked; with no argument we stay on whichever panel had focus, which is what
// [Unsplit] / [single] mean.
function pcCombineDisable(nextSession) {
    // Save state before disabling so we can restore later
    pcSplitSave();
    Desktop.combined.enabled = false;

    // Stop polling
    pcCombineStopPolling();

    // Show normal terminal, hide combined
    const terminalWrap = document.querySelector('.pc-terminal-wrap');
    const combinedWrap = document.getElementById('pc-combined-wrap');

    if (terminalWrap) terminalWrap.classList.remove('hidden');
    if (combinedWrap) combinedWrap.classList.add('hidden');

    // Land on the requested session, else on the panel that had focus.
    const landOn = nextSession
        || Desktop.combined.sessions[Desktop.combined.activeIndex]
        || Desktop.combined.sessions[0];
    if (landOn) pcSwitchSession(landOn);

    // Clear combined grid
    const grid = document.getElementById('pc-combined-grid');
    if (grid) grid.innerHTML = '';

    // Clear cables
    const cables = document.getElementById('pc-cables');
    if (cables) cables.innerHTML = '';

    // Update saved state as disabled
    pcSplitSave();
    pcRenderSplitChips();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();

    // pcSwitchSession already said `→ name`; two toasts for one click is noise.
    if (!nextSession && typeof toast === 'function') toast('Single view', 'info');
}

// Render combined panels
// Per-panel font sizes for desktop combined view
const pcPanelFontSizes = {};
const PC_FONT_SIZES = { S: 0.45, M: 0.55, L: 0.7, XL: 0.85 };

function pcSetPanelFontSize(idx, size) {
    pcPanelFontSizes[idx] = size;
    const content = document.getElementById('pc-combined-content-' + idx);
    if (content) content.style.fontSize = PC_FONT_SIZES[size] + 'rem';
    const panel = document.getElementById('pc-combined-panel-' + idx);
    if (panel) {
        panel.querySelectorAll('.pc-panel-font button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.size === size);
        });
    }
}

function pcCreateCombinedPanel(session, idx) {
    const isActive = idx === Desktop.combined.activeIndex;
    const hasAutoAccept = typeof autoAcceptSessions !== 'undefined' && autoAcceptSessions.has(session);
    const currentSize = pcPanelFontSizes[idx] || 'XL';
    const fontBtns = Object.keys(PC_FONT_SIZES).map(s =>
        `<button data-size="${s}" class="${s === currentSize ? 'active' : ''}" onclick="event.stopPropagation();pcSetPanelFontSize(${idx},'${s}')">${s}</button>`
    ).join('');

    const alias = pcPanelIdentity.aliases[session] || '';
    const displayName = alias || session;
    const panelColor = pcPanelIdentity.colors[session] || null;
    // First letter for watermark
    const initial = displayName.charAt(0).toUpperCase();

    // Color picker dots
    const colorDots = PC_PANEL_COLORS.map((c, ci) => {
        const bg = c || 'var(--border)';
        const sel = (c === panelColor) || (!c && !panelColor);
        return `<span class="pc-color-dot ${sel ? 'active' : ''}" style="background:${bg}" onclick="event.stopPropagation();pcSetPanelColor('${session}',${ci})"></span>`;
    }).join('');

    const panel = document.createElement('div');
    panel.className = `pc-combined-panel ${isActive ? 'active' : ''}`;
    panel.id = 'pc-combined-panel-' + idx;
    panel.setAttribute('data-session', session);
    panel.setAttribute('data-index', idx);
    panel.style.cssText = 'min-width:0;min-height:0;';
    if (panelColor) {
        panel.style.borderColor = panelColor;
        panel.style.setProperty('--panel-color', panelColor);
        if (isActive) {
            panel.style.boxShadow = `0 0 12px ${panelColor}40, inset 0 0 20px ${panelColor}14`;
        }
    }
    panel.onclick = () => pcCombineSetFocus(idx);
    panel.innerHTML = `
        <div class="pc-edge pc-edge-top" data-dir="top"></div>
        <div class="pc-edge pc-edge-right" data-dir="right"></div>
        <div class="pc-edge pc-edge-bottom" data-dir="bottom"></div>
        <div class="pc-edge pc-edge-left" data-dir="left"></div>
        <div class="pc-combined-topband" style="background:${panelColor || 'var(--border)'}"></div>
        <div class="pc-combined-header">
            <span class="pc-combined-name" ondblclick="event.stopPropagation();pcPanelStartRename(${idx},'${session}')" title="Double-click to rename">${displayName}</span>
            <span class="pc-combined-session-tag">${alias ? session : ''}</span>
            <span class="pc-combined-status" id="pc-combined-status-${idx}">[*]</span>
            <div class="pc-color-picker">${colorDots}</div>
            <div class="pc-panel-font">${fontBtns}</div>
            <button class="pc-combined-auto ${hasAutoAccept ? 'active' : ''}"
                    id="pc-combined-auto-${idx}"
                    onclick="event.stopPropagation(); pcCombineToggleAutoAccept('${session}', ${idx})"
                    title="Toggle auto-accept for ${session}">${hasAutoAccept ? '[A*]' : '[A]'}</button>
            <button class="pc-combined-close" onclick="event.stopPropagation(); pcCombineRemovePanel(${idx})" title="Remove panel">[x]</button>
        </div>
        <div class="pc-combined-body">
            <span class="pc-combined-watermark">${initial}</span>
            <div class="pc-combined-content" id="pc-combined-content-${idx}" style="font-size:${PC_FONT_SIZES[currentSize]}rem">
                Loading...
            </div>
        </div>
    `;

    // Edge resize handles
    panel.querySelectorAll('.pc-edge').forEach(handle => {
        handle.addEventListener('mousedown', (ev) => pcEdgeResizeStart(ev, idx, handle.dataset.dir));
        handle.addEventListener('dblclick', (ev) => { ev.preventDefault(); ev.stopPropagation(); pcRetile(); });
        handle.title = 'Drag to resize - double-click to even everything out';
    });

    // Header drag for swap
    const header = panel.querySelector('.pc-combined-header');
    if (header) {
        header.addEventListener('mousedown', (ev) => pcPanelSwapStart(ev, idx));
    }

    return panel;
}

// Rename panel (visual alias only)
function pcPanelStartRename(idx, session) {
    const panel = document.getElementById('pc-combined-panel-' + idx);
    if (!panel) return;
    const nameEl = panel.querySelector('.pc-combined-name');
    if (!nameEl) return;

    const current = pcPanelIdentity.aliases[session] || session;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pc-rename-input';
    input.value = current;
    input.onclick = (e) => e.stopPropagation();

    const finish = () => {
        const val = input.value.trim();
        if (val && val !== session) {
            pcPanelIdentity.aliases[session] = val;
        } else {
            delete pcPanelIdentity.aliases[session];
        }
        pcIdentitySave();
        pcCombineRender();
        pcSplitSave();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(); }
        if (e.key === 'Escape') { e.preventDefault(); pcCombineRender(); }
        e.stopPropagation();
    });
    input.addEventListener('blur', finish);

    nameEl.replaceWith(input);
    input.focus();
    input.select();
}

// Assign (or clear, when colorIdx maps to null) a session's identity color. Shared
// by the split-view color dots and the sidebar chip so both stay in sync. Repaints
// the split panels, the sidebar (chip + accent), and the legend.
function pcAssignSessionColor(session, colorIdx) {
    const color = PC_PANEL_COLORS[colorIdx] || null;
    if (color) pcPanelIdentity.colors[session] = color;
    else delete pcPanelIdentity.colors[session];
    pcIdentitySave();
    if (typeof pcCombineRender === 'function') pcCombineRender();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
    pcRenderLegend();
}
// Split-view color dots call this (kept for the existing onclick).
function pcSetPanelColor(session, colorIdx) { pcAssignSessionColor(session, colorIdx); }

// ---- Sidebar color chip: inline palette popover + meaning legend ----
// Open a small floating palette anchored to the clicked chip. Picking a swatch
// assigns the color to that session (and thus its split panel too).
function pcSidebarColorMenu(session, anchorEl) {
    const existing = document.getElementById('pc-color-popover');
    if (existing) { existing.remove(); if (existing.dataset.session === session) return; }
    const pop = document.createElement('div');
    pop.id = 'pc-color-popover';
    pop.className = 'pc-color-popover';
    pop.dataset.session = session;
    pop.innerHTML = PC_PANEL_COLORS.map((c, ci) => {
        const cur = pcPanelIdentity.colors[session] || null;
        const sel = (c === cur) || (!c && !cur);
        const mean = c ? (pcPanelIdentity.meanings[c] || '') : 'none';
        const bg = c || 'transparent';
        return `<span class="pc-color-dot ${sel ? 'active' : ''} ${c ? '' : 'empty'}"
            style="background:${bg}" title="${escapeHtml(mean)}"
            onclick="event.stopPropagation(); pcAssignSessionColor('${session}', ${ci}); pcCloseColorPopover();"></span>`;
    }).join('');
    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    pop.style.left = Math.round(r.left) + 'px';
    pop.style.top = Math.round(r.bottom + 4) + 'px';
    // Close on the next outside click.
    setTimeout(() => {
        document.addEventListener('click', pcCloseColorPopover, { once: true });
    }, 0);
}
function pcCloseColorPopover() {
    const pop = document.getElementById('pc-color-popover');
    if (pop) pop.remove();
}

// Toggle the legend panel (define what each color codes for).
function pcToggleLegend() {
    const el = document.getElementById('pc-color-legend');
    if (!el) return;
    el.classList.toggle('hidden');
    if (!el.classList.contains('hidden')) pcRenderLegend();
}
// Render the legend: every non-null palette color with an editable meaning label
// and a count of sessions currently using it.
function pcRenderLegend() {
    const el = document.getElementById('pc-color-legend');
    if (!el || el.classList.contains('hidden')) return;
    // Count only sessions that currently exist (not every color ever assigned).
    const usage = {};
    for (const sess of pcLiveSessionNames) {
        const c = pcPanelIdentity.colors[sess];
        if (c) usage[c] = (usage[c] || 0) + 1;
    }
    const rows = PC_PANEL_COLORS.filter(Boolean).map(c => {
        const mean = pcPanelIdentity.meanings[c] || '';
        const n = usage[c] || 0;
        return `<div class="pc-legend-row">
            <span class="pc-legend-swatch" style="background:${c}"></span>
            <input class="pc-legend-input" value="${escapeHtml(mean)}" placeholder="meaning..."
                   onclick="event.stopPropagation()"
                   onchange="pcSetColorMeaning('${c}', this.value)">
            <span class="pc-legend-count" title="sessions using this color">${n ? n : ''}</span>
        </div>`;
    }).join('');
    el.innerHTML = `<div class="pc-legend-title">COLOR LEGEND</div>${rows}`;
}
// Set/clear what a color means; refresh chips (tooltips) live.
function pcSetColorMeaning(hex, text) {
    const v = (text || '').trim();
    if (v) pcPanelIdentity.meanings[hex] = v;
    else delete pcPanelIdentity.meanings[hex];
    pcIdentitySave();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
}

// Absolute positioning layout: each panel resizes independently
// ---- Session attention glow ----
// When a session finishes / needs input while TSRCT is FOCUSED, SessionVoice calls
// these instead of speaking: the split panel for that session pulses in its assigned
// color (the same one picked via the color dots) so you can see which screen needs you.
// Glow clears when you focus that panel or it resumes working.
const pcAttentionSessions = new Set();

function pcApplyAttention(session) {
    const panel = document.querySelector(`.pc-combined-panel[data-session="${session}"]`);
    if (!panel) return;
    // If it's the panel you're already focused on, no need to nag.
    if (panel.classList.contains('active')) {
        const st = Desktop.sessionStates[session];
        if (PC_ATTENTION_STATES.has(st)) pcAttentionAck.set(session, st);
        pcClearAttention(session);
        return;
    }
    panel.style.boxShadow = '';            // let the pulse animation own the glow
    panel.classList.add('needs-attention');
}

function pcGlowAttention(session) {
    if (!session) return;
    pcAttentionSessions.add(session);
    pcApplyAttention(session);
}

function pcClearAttention(session) {
    if (!session) return;
    pcAttentionSessions.delete(session);
    const panel = document.querySelector(`.pc-combined-panel[data-session="${session}"]`);
    if (panel) panel.classList.remove('needs-attention');
}

// The glow used to come ONLY from SessionVoice's transition events, so it needed
// [V] on AND the window focused at the instant of the change; miss either and the
// panel stayed dark while the sidebar (which reads the live state) turned amber
// (2026-10-06). Now the panels read the same live state as the sidebar.
// A panel you focused while it was waiting is acknowledged for THAT state, so it
// does not light up again every 6 s; a new state re-arms it.
const PC_ATTENTION_STATES = new Set(['waiting_input', 'failed']);
const pcAttentionAck = new Map();      // session -> state it had when you focused it

function pcSyncAttentionFromStates() {
    Desktop.combined.sessions.forEach(s => {
        const st = Desktop.sessionStates[s];
        if (PC_ATTENTION_STATES.has(st)) {
            if (pcAttentionAck.get(s) !== st) pcGlowAttention(s);
        } else {
            pcAttentionAck.delete(s);
            if (st === 'working') pcClearAttention(s);
        }
    });
}

window.pcGlowAttention = pcGlowAttention;
window.pcClearAttention = pcClearAttention;

function pcCombineRender() {
    const grid = document.getElementById('pc-combined-grid');
    if (!grid) return;

    // Load identity data (aliases, colors)
    pcIdentityLoad();

    const count = Desktop.combined.sessions.length;
    grid.setAttribute('data-count', count);
    grid.innerHTML = '';
    grid.style.cssText = 'position:relative;flex:1;min-height:0;overflow:hidden;';

    // Calculate grid dimensions for Ctrl+Arrow navigation
    const gr = grid.getBoundingClientRect();
    const numRows = count ? pcRowsFor(count, gr.height > 50 ? gr.width / gr.height : 16 / 9) : 1;
    const numCols = count ? Math.ceil(count / numRows) : 1;
    Desktop.combined.cols = numCols;
    Desktop.combined.rows = numRows;

    // Initialize bounds if needed - or if the saved ones leave a hole.
    if (!Desktop.combined.panelBounds || Desktop.combined.panelBounds.length !== count
        || pcBoundsCoverage(Desktop.combined.panelBounds) < 97) {
        Desktop.combined.panelBounds = pcInitBounds(count);
    }

    const bounds = Desktop.combined.panelBounds;
    const g = PC_PANEL_GAP;

    // Create absolutely positioned panels
    for (let idx = 0; idx < count; idx++) {
        const b = bounds[idx];
        const panel = pcCreateCombinedPanel(Desktop.combined.sessions[idx], idx);
        panel.style.position = 'absolute';
        panel.style.left = `calc(${b.x}% + ${g}px)`;
        panel.style.top = `calc(${b.y}% + ${g}px)`;
        panel.style.width = `calc(${b.w}% - ${g * 2}px)`;
        panel.style.height = `calc(${b.h}% - ${g * 2}px)`;
        grid.appendChild(panel);
    }

    // Re-apply any pending attention glows lost in the rebuild.
    pcAttentionSessions.forEach(s => pcApplyAttention(s));

    // Initial fetch for all panels
    pcCombinePollAll();

    // Render cables after a short delay
    setTimeout(pcCombineRenderCables, 50);
}

// Set focus to a panel
function pcCombineSetFocus(index) {
    if (index < 0 || index >= Desktop.combined.sessions.length) return;

    Desktop.combined.activeIndex = index;

    // Update panel active states and apply color-specific glow
    document.querySelectorAll('.pc-combined-panel').forEach((panel, i) => {
        panel.classList.toggle('active', i === index);
        if (i === index) {
            const color = panel.style.getPropertyValue('--panel-color') || null;
            if (color) {
                panel.style.boxShadow = `0 0 12px ${color}40, inset 0 0 20px ${color}14`;
            } else {
                panel.style.boxShadow = '';
            }
        } else {
            panel.style.boxShadow = '';
        }
    });

    // Focusing a panel acknowledges it — clear any attention glow.
    const focusedSession = Desktop.combined.sessions[index];
    pcClearAttention(focusedSession);
    const focusedState = Desktop.sessionStates[focusedSession];
    if (PC_ATTENTION_STATES.has(focusedState)) pcAttentionAck.set(focusedSession, focusedState);

    // Update cables
    pcCombineRenderCables();

    // Update session for input
    const session = Desktop.combined.sessions[index];
    if (typeof homeSession !== 'undefined') {
        homeSession = session;
    }

    // Update header display
    const sessionLabel = document.getElementById('pc-session-name');
    if (sessionLabel) sessionLabel.textContent = session;

    pcSplitSave();
}

// Remove a panel from combined view
// Put `newName` in the split panel that shows `oldName`, same place, same size
// (Tesla review, 2026-10-08: "abri la sesion en esta misma terminal" meant the
// panel showing creators, and nothing could change what a panel shows). With no
// split view, or `oldName` not in it, it is the plain session switch instead.
function pcCombineReplaceSession(oldName, newName) {
    if (!newName) return false;
    const c = Desktop.combined;
    const idx = c && c.enabled ? c.sessions.indexOf(oldName) : -1;
    if (idx === -1 || c.sessions.includes(newName)) {
        if (typeof window.switchSession === 'function') { window.switchSession(newName); return true; }
        return false;
    }
    c.sessions[idx] = newName;
    for (const [name, on] of [[oldName, false], [newName, true]]) {
        const item = document.querySelector(`.pc-session-item[data-session="${name}"]`);
        if (!item) continue;
        const checkbox = item.querySelector('.pc-combine-check');
        if (checkbox) checkbox.checked = on;
        item.classList.toggle('combined', on);
    }
    pcCombineUpdateControls();
    pcCombineRender();
    pcSplitSave();
    return true;
}

// A handoff (lib/sessionWeight.js) retires a session into a NEW name in the same
// directory. Everything on the desktop is keyed by name, so the new session used to
// land outside its folder, out of the split, with no colour, and the folder's split
// lost its dragged layout when the old panel was pruned. Put it where the old one was:
// same folder, same alias and colour, same panel in every split group, same size.
function pcSessionSucceeded(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    const assign = Desktop.groups.assignments || (Desktop.groups.assignments = {});
    if (assign[oldName] && !assign[newName]) {
        assign[newName] = assign[oldName];
        delete assign[oldName];
        pcGroupsSave();
    }
    let idChanged = false;
    ['aliases', 'colors'].forEach(k => {
        const m = pcPanelIdentity[k];
        if (m[oldName] != null && m[newName] == null) { m[newName] = m[oldName]; delete m[oldName]; idChanged = true; }
    });
    if (idChanged) pcIdentitySave();

    let groupsChanged = false;
    Object.values(Desktop.splitGroups || {}).forEach(e => {
        const list = e.sessions || [];
        const i = list.indexOf(oldName);
        if (i !== -1 && !list.includes(newName)) { list[i] = newName; groupsChanged = true; }
    });
    if (groupsChanged) pcSplitGroupsSave();

    // The bounds stay: same panel count, same order, so the dragged layout still fits.
    const c = Desktop.combined;
    const i = c.sessions.indexOf(oldName);
    if (i !== -1 && !c.sessions.includes(newName)) {
        c.sessions[i] = newName;
        pcSyncCombineChecks();
        if (c.enabled) pcCombineRender();
        pcSplitSave();
    }
    pcRenderSplitChips();
    if (typeof refreshPCSessions === 'function') refreshPCSessions();
}

function pcCombineRemovePanel(index) {
    if (Desktop.combined.sessions.length <= 2) {
        // Can't have less than 2, just disable
        pcCombineDisable();
        return;
    }

    const session = Desktop.combined.sessions[index];
    Desktop.combined.sessions.splice(index, 1);

    // Reset bounds so render creates fresh layout for new count
    Desktop.combined.panelBounds = null;

    // Adjust active index if needed
    if (Desktop.combined.activeIndex >= Desktop.combined.sessions.length) {
        Desktop.combined.activeIndex = Desktop.combined.sessions.length - 1;
    }

    // Update checkbox in sidebar
    const item = document.querySelector(`.pc-session-item[data-session="${session}"]`);
    if (item) {
        const checkbox = item.querySelector('.pc-combine-check');
        if (checkbox) checkbox.checked = false;
        item.classList.remove('combined');
    }

    pcCombineUpdateControls();
    pcCombineRender();
    pcSplitSave();
}

// Start polling for combined panels
function pcCombineStartPolling() {
    pcCombineStopPolling();
    Desktop.combined.pollInterval = setInterval(pcCombinePollAll, 3000);
}

// Stop polling
function pcCombineStopPolling() {
    if (Desktop.combined.pollInterval) {
        clearInterval(Desktop.combined.pollInterval);
        Desktop.combined.pollInterval = null;
    }
}

// Poll all panels for output
async function pcCombinePollAll() {
    if (!Desktop.combined.enabled) return;

    for (let i = 0; i < Desktop.combined.sessions.length; i++) {
        await pcCombinePollPanel(i);
    }
}

// Poll a single panel
async function pcCombinePollPanel(index) {
    const session = Desktop.combined.sessions[index];
    if (!session) return;

    try {
        const res = await fetch(`/api/output?session=${encodeURIComponent(session)}`, {
            headers: { 'Authorization': (typeof token !== 'undefined' ? token : '') }
        });
        const data = await res.json();

        const content = document.getElementById(`pc-combined-content-${index}`);
        if (content && data.output) {
            if (window.TermImg) {
                TermImg.write(content, data.output);
            } else if (window.TermFocus) {
                TermFocus.write(content, data.output, false);
            } else {
                const wasAtBottom = content.scrollTop >= content.scrollHeight - content.clientHeight - 50;
                content.textContent = data.output;
                if (wasAtBottom) content.scrollTop = content.scrollHeight;
            }
        }

        // Update status indicator from sidebar data
        const sidebarItem = document.querySelector(`.pc-session-item[data-session="${session}"]`);
        const statusEl = document.getElementById(`pc-combined-status-${index}`);
        if (sidebarItem && statusEl) {
            const status = sidebarItem.getAttribute('data-status') || 'idle';
            statusEl.textContent = status === 'working' ? '[~]' : status === 'perm' ? '[!]' : '[*]';
            statusEl.className = `pc-combined-status ${status}`;
        }
    } catch (e) {
        console.error(`[PC] Failed to poll panel ${index}:`, e);
    }
}

// Render SVG cables connecting sidebar items to panels
function pcCombineRenderCables() {
    const svg = document.getElementById('pc-cables');
    if (!svg || !Desktop.combined.enabled) return;

    svg.innerHTML = '';

    const svgRect = svg.getBoundingClientRect();

    Desktop.combined.sessions.forEach((session, idx) => {
        // Cable-safe: falls back to the group header when the item is collapsed away.
        const sidebarItem = pcCableAnchor(session);
        const panel = document.querySelector(`.pc-combined-panel[data-index="${idx}"]`);

        if (!sidebarItem || !panel) return;

        const start = sidebarItem.getBoundingClientRect();
        const end = panel.getBoundingClientRect();

        // Calculate coordinates relative to SVG
        const x1 = start.right - svgRect.left;
        const y1 = start.top + start.height / 2 - svgRect.top;
        const x2 = end.left - svgRect.left;
        const y2 = end.top + end.height / 2 - svgRect.top;

        // Create bezier curve path
        const midX = (x1 + x2) / 2;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`);

        // Get status for color
        const status = sidebarItem.getAttribute('data-status') || 'idle';
        const isActive = idx === Desktop.combined.activeIndex;
        path.setAttribute('class', `pc-cable ${status} ${isActive ? 'active' : ''}`);
        path.setAttribute('data-session', session);

        svg.appendChild(path);
    });
}

// Handle window resize - recalculate cables
function pcCombineOnResize() {
    if (Desktop.combined.enabled) {
        pcCombineRenderCables();
    }
}

// Initialize combined terminals
function pcCombineInit() {
    // Load panel identity (aliases, colors)
    pcIdentityLoad();
    // Split groups live in sessionStorage; a restart's new window got them back from the
    // server before this ran (src/js/layout-memory.js). The first refresh prunes
    // whatever tmux died while we were away.
    pcSplitGroupsLoad();
    Desktop.focusMode = pcPrefGet('pcFocusMode', 'window', '') === '1';
    pcApplyFocusMode();
    pcRenderSplitChips();

    // Add resize listener for cables
    window.addEventListener('resize', pcCombineOnResize);

    // Restore split state from localStorage on page load
    const saved = pcSplitLoad();
    if (saved && saved.enabled && saved.sessions && saved.sessions.length >= 2) {
        Desktop.combined.sessions = saved.sessions;
        Desktop.combined.activeIndex = saved.activeIndex || 0;
        Desktop.combined.groupId = (saved.groupId === undefined) ? '' : saved.groupId;
        // Defer enable until sessions list is rendered in sidebar
        setTimeout(() => {
            pcSyncCombineChecks();
            pcCombineEnable(true);
        }, 1500);
    }

    // Add keyboard shortcuts for panel focus
    document.addEventListener('keydown', (e) => {
        if (!Desktop.combined.enabled) return;

        // Ctrl+1-9 to focus panels by number
        if (e.ctrlKey && !e.shiftKey && !e.altKey) {
            if (e.key >= '1' && e.key <= '9') {
                const index = parseInt(e.key) - 1;
                if (index < Desktop.combined.sessions.length) {
                    e.preventDefault();
                    pcCombineSetFocus(index);
                }
            }
        }

        // Ctrl+Arrow to navigate panels spatially using bounds
        if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.startsWith('Arrow')) {
            const bounds = Desktop.combined.panelBounds;
            if (!bounds) return;
            const cur = Desktop.combined.activeIndex;
            const cb = bounds[cur];
            const cx = cb.x + cb.w / 2, cy = cb.y + cb.h / 2;
            let best = -1, bestDist = Infinity;

            const dirMap = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            const dir = dirMap[e.key];
            if (!dir) return;

            bounds.forEach((b, i) => {
                if (i === cur) return;
                const bx = b.x + b.w / 2, by = b.y + b.h / 2;
                const dx = bx - cx, dy = by - cy;
                // Only consider panels in the correct direction
                if (dir[0] < 0 && dx >= 0) return;
                if (dir[0] > 0 && dx <= 0) return;
                if (dir[1] < 0 && dy >= 0) return;
                if (dir[1] > 0 && dy <= 0) return;
                const dist = Math.abs(dx) + Math.abs(dy);
                if (dist < bestDist) { bestDist = dist; best = i; }
            });

            if (best >= 0) {
                e.preventDefault();
                e.stopPropagation();
                pcCombineSetFocus(best);
                return;
            }
        }

        // Escape to exit split view
        if (e.key === 'Escape' && Desktop.combined.enabled) {
            e.preventDefault();
            pcCombineDisable();
        }
    });
}


// ==============================================
// DRAG & DROP
// ==============================================

function initDragAndDrop() {
    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', handleDrop);
}

function createDropOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'pc-drop-overlay';
    overlay.id = 'pc-drop-overlay';
    overlay.innerHTML = `
        <div class="pc-drop-content">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span>Drop files here</span>
            <small>Images, code, text files</small>
        </div>
    `;
    document.body.appendChild(overlay);
}

function handleDragEnter(e) {
    if (!Desktop.isPC) return;
    // Only react to EXTERNAL file drags. Internal session-group dragging sets
    // pcDragSession and carries no "Files" type — never darken the app for it.
    const types = e.dataTransfer && e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
    if (pcDragSession || !types.includes('Files')) return;
    e.preventDefault();
    document.getElementById('pc-drop-overlay')?.classList.add('active');
}

function handleDragLeave(e) {
    if (!Desktop.isPC || e.relatedTarget) return;
    document.getElementById('pc-drop-overlay')?.classList.remove('active');
}

async function handleDrop(e) {
    if (!Desktop.isPC) return;
    e.preventDefault();
    document.getElementById('pc-drop-overlay')?.classList.remove('active');

    // An internal session/group drag that reached the document = dropped in dead space
    // (missed every group). Tell the user where to aim instead of failing silently.
    if (pcDragGroup || pcDragSession) {
        if (typeof toast === 'function') toast('drop it directly onto a group\'s header bar', 'warn');
        pcDragGroup = null; pcDragSession = null;
        document.body.classList.remove('pc-dragging-session');
        return;
    }

    const files = e.dataTransfer.files;
    if (!files.length) return;

    const images = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (images.length && typeof uploadImages === 'function') {
        const input = document.getElementById('gallery-input');
        if (input) {
            const dt = new DataTransfer();
            images.forEach(f => dt.items.add(f));
            input.files = dt.files;
            uploadImages(input);
        }
        return;
    }

    const textFile = Array.from(files).find(f =>
        f.type.startsWith('text/') ||
        f.name.match(/\.(txt|md|json|js|ts|py|rb|go|rs|java|c|cpp|h|css|html|xml|yaml|yml)$/i)
    );

    if (textFile) {
        const text = await textFile.text();
        const input = document.getElementById('pc-input');
        if (input) {
            input.value = `Analyze this file (${textFile.name}):\n\`\`\`\n${text.substring(0, 3000)}\n\`\`\``;
            input.focus();
        }
    }
}

window.pcSwitchSession = pcSwitchSession;
window.pcGetSessionList = pcGetSessionList;
window.pcCycleSession = pcCycleSession;
window.pcJumpToSession = pcJumpToSession;
window.pcCombineToggleMode = pcCombineToggleMode;
window.pcCombineToggleSession = pcCombineToggleSession;
window.pcCombineUpdateControls = pcCombineUpdateControls;
window.pcCombineEnable = pcCombineEnable;
window.pcCombineDisable = pcCombineDisable;
window.pcCombineRender = pcCombineRender;
window.pcCombineSetFocus = pcCombineSetFocus;
window.pcCombineRemovePanel = pcCombineRemovePanel;
window.pcCombineReplaceSession = pcCombineReplaceSession;
window.pcSessionSucceeded = pcSessionSucceeded;
window.pcCombineInit = pcCombineInit;
window.pcToggleFocusMode = pcToggleFocusMode;
window.pcFolderSplit = pcFolderSplit;
window.pcFolderUnsplit = pcFolderUnsplit;
window.pcSplitGroupActivate = pcSplitGroupActivate;
window.pcProgressOpen = pcProgressOpen;
window.pcProgressClose = pcProgressClose;
window.pcProgressRun = pcProgressRun;
window.pcProgressStop = pcProgressStop;
window.pcProgressCopy = pcProgressCopy;
window.pcPanelStartRename = pcPanelStartRename;
window.pcSetPanelColor = pcSetPanelColor;
window.pcAssignSessionColor = pcAssignSessionColor;
window.pcSidebarColorMenu = pcSidebarColorMenu;
window.pcCloseColorPopover = pcCloseColorPopover;
window.pcGroupDelete = pcGroupDelete;
window.pcGroupToggleCollapse = pcGroupToggleCollapse;
window.pcGroupHeaderClick = pcGroupHeaderClick;
window.pcGroupStartRename = pcGroupStartRename;
window.pcSessionFilterInput = pcSessionFilterInput;
window.pcRailSelect = pcRailSelect;
window.pcSidebarToggleCollapse = pcSidebarToggleCollapse;
window.pcSidebarResizeStart = pcSidebarResizeStart;
window.pcSidebarResizeReset = pcSidebarResizeReset;
window.pcSidebarDragStart = pcSidebarDragStart;
window.pcSidebarItemClick = pcSidebarItemClick;
window.pcGroupsLoad = pcGroupsLoad;
window.pcToggleLegend = pcToggleLegend;
window.pcSetColorMeaning = pcSetColorMeaning;
window.pcEdgeResizeStart = pcEdgeResizeStart;
window.pcPanelSwapStart = pcPanelSwapStart;

// were in desktop.js's "Public API gap" block: generated onclick HTML and other files
Object.assign(window, {
    pcCreateSession, refreshPCSessions, pcCombineToggleMode, pcSetPanelFontSize, pcKillSession,
    // were private; desktop.js calls them (initDesktopMode, buildPCLayout, the 1 s tick)
    pcSidebarInitLayout, initDragAndDrop, pcSessionsTick, createDropOverlay,
});

})();
