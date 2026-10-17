// ============================================================================
// TermFocus -- terminal freeze / focus controller
// ----------------------------------------------------------------------------
// Every terminal-output element in TSRCT is refreshed by replacing its whole
// text on a poll (tmux capture-pane). Because the captured window scrolls (old
// lines fall off the top, new ones arrive at the bottom), the text physically
// shifts under whoever is trying to read it -- you lose the line you were on.
//
// TermFocus gates every write. When an element is FROZEN the latest output is
// buffered but NOT painted, so the snapshot holds dead still: you can scroll,
// select and read freely. Resume repaints the latest buffer and snaps to the
// live tail.
//
// Usage at a write site (replaces `el.textContent = output`):
//     TermFocus.write(el, output, isHtml)
// The element auto-attaches on first write -- no per-element setup needed, so
// this covers the main panes AND dynamically-created split/combined panels.
//
// Freeze triggers: a manual [FREEZE] toggle, scrolling up, or selecting text.
// Auto-freeze (scroll/selection) auto-resumes when you scroll back to bottom;
// a manual freeze stays until you press LIVE / tap the pill.
// ============================================================================
(function () {
    'use strict';

    // Per-element state. WeakMap keyed by the DOM node, so a recreated panel
    // (same id, new node) gets fresh state and its old state is GC'd.
    const states = new WeakMap();

    const BOTTOM_SLOP = 40; // px tolerance for "at bottom"

    function atBottom(el) {
        return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP;
    }

    function apply(el, content, isHtml) {
        if (isHtml) el.innerHTML = content;
        else el.textContent = content;
    }

    function scrollToBottom(el, st) {
        st.programmatic = true;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => { st.programmatic = false; });
    }

    // ---- UI (lives in the element's PARENT so content writes can't wipe it) --
    function buildUI(el, st) {
        const host = el.parentElement;
        if (!host) return;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'tf-toggle';
        toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleFreeze(el); });

        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'tf-pill';
        pill.addEventListener('click', (e) => { e.stopPropagation(); resume(el); });

        host.appendChild(toggle);
        host.appendChild(pill);
        st.toggle = toggle;
        st.pill = pill;
        renderUI(el, st);
    }

    function renderUI(el, st) {
        if (st.toggle) {
            st.toggle.textContent = st.frozen ? 'LIVE' : 'FREEZE';
            st.toggle.classList.toggle('frozen', st.frozen);
        }
        if (st.pill) {
            st.pill.classList.toggle('visible', st.frozen);
            const n = st.updates;
            const label = n > 0 ? ('FROZEN - ' + n + ' new - tap to resume')
                                : ('FROZEN - tap to resume');
            st.pill.textContent = label;
        }
        el.classList.toggle('tf-frozen', st.frozen);
    }

    // ---- freeze / resume -----------------------------------------------------
    function freeze(el, manual) {
        const st = states.get(el);
        if (!st) return;
        if (!st.frozen) {
            st.frozen = true;
            st.updates = 0;
            // snapshot what's currently shown so buffered diffs are counted
            st.buffered = st.lastContent;
            st.bufferedHtml = st.lastHtml;
        }
        if (manual) st.manual = true;
        renderUI(el, st);
    }

    function resume(el) {
        const st = states.get(el);
        if (!st) return;
        st.frozen = false;
        st.manual = false;
        if (st.buffered != null) {
            apply(el, st.buffered, st.bufferedHtml);
            st.lastContent = st.buffered;
            st.lastHtml = st.bufferedHtml;
        }
        st.updates = 0;
        scrollToBottom(el, st);
        renderUI(el, st);
    }

    function toggleFreeze(el) {
        const st = states.get(el);
        if (!st) { attach(el); }
        const s = states.get(el);
        if (s.frozen) resume(el);
        else freeze(el, true);
    }

    // ---- attach --------------------------------------------------------------
    function attach(el, opts) {
        if (!el || states.has(el)) return;
        const st = {
            frozen: false,
            manual: false,
            buffered: null,
            bufferedHtml: false,
            updates: 0,
            lastContent: el.textContent || '',
            lastHtml: false,
            programmatic: false,
            toggle: null,
            pill: null
        };
        states.set(el, st);

        // Freeze is BUTTON-ONLY by design: scrolling or selecting text never
        // freezes the pane. The user toggles it explicitly via the .tf-toggle
        // control (or window.TermFocus.toggle). This keeps behavior predictable
        // -- the pane never freezes out from under you unexpectedly.

        buildUI(el, st);
        return st;
    }

    // ---- the gated writer ----------------------------------------------------
    // Returns true if painted, false if buffered (frozen).
    function write(el, content, isHtml) {
        if (!el) return false;
        if (content == null) return false;
        let st = states.get(el);
        if (!st) st = attach(el, null) || states.get(el);

        if (st.frozen) {
            if (content !== st.buffered) st.updates++;
            st.buffered = content;
            st.bufferedHtml = !!isHtml;
            renderUI(el, st);
            return false;
        }

        const wasAtBottom = atBottom(el);
        apply(el, content, isHtml);
        st.lastContent = content;
        st.lastHtml = !!isHtml;
        st.buffered = content;
        st.bufferedHtml = !!isHtml;
        if (wasAtBottom) scrollToBottom(el, st);
        return true;
    }

    function isFrozen(el) {
        const st = states.get(el);
        return !!(st && st.frozen);
    }

    window.TermFocus = { attach, write, freeze, resume, toggle: toggleFreeze, isFrozen };
})();
