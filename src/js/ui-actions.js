// ─────────────────────────────────────────────────────────────────────────
// src/js/ui-actions.js — THE HAND INSIDE THE PAGE.
//
// The server half of this is lib/uiActions.js. It declares what the assistant
// may press, validates the arguments and queues a press; this file is what
// actually presses it, and it is deliberately the dumber of the two:
//
//   IT HAS ITS OWN ALLOWLIST. A press only runs if its name is a key of
//   HANDLERS here. A name arriving over the wire can never become a call to an
//   arbitrary global, whatever the server said — and scripts/check-ui.js fails
//   the build if the two lists stop agreeing.
//
//   IT KNOWS WHICH SKIN IS ON. The same sentence means two different controls:
//   on the desktop "pasame a tareas" is pcSwitchTab('tasks'), on the phone the
//   tasks panel does not exist at all. So each handler picks the control for the
//   layout it is in, and when there is none it FAILS IN WORDS — the assistant
//   then says so out loud instead of leaving "listo" standing over nothing.
//
//   IT CALLS THE SAME FUNCTION THE BUTTON CALLS. Never a reimplementation: the
//   button and the voice go through one code path, so they cannot drift apart.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const pc = () => document.body.classList.contains('pc-mode');
    const has = (n) => typeof window[n] === 'function';
    const call = (n, ...a) => {
        if (!has(n)) throw new Error(`esta version de TSRCT no tiene ${n}`);
        return window[n](...a);
    };
    // Only on the big screen. The phone has no tabs, no focus mode and no rail.
    const onlyPC = (what) => { if (!pc()) throw new Error(`${what} existe solo en la compu`); };

    // Font size means one thing to the desktop (1-4) and another to the phone
    // (the point size), and he says "grande" to both.
    const PT = [8, 10, 12, 14];

    const HANDLERS = {
        go_tab: ({ tab }) => {
            if (pc()) return call('pcSwitchTab', tab);
            // On the phone the "tabs" that exist are rooms; the rest do not.
            const asRoom = { studio: 'studio', lurk: 'lurk', playlist: 'playlist' };
            if (tab === 'terminal') {
                const open = window.WorldManager && WorldManager.activeRoom;
                if (open) return WorldManager.close(open);
                return true;                       // already on the terminal
            }
            if (asRoom[tab] && window.WorldManager) return WorldManager.open(asRoom[tab]);
            throw new Error(`${tab} en el telefono no existe, es una pantalla de la compu`);
        },
        open_room: ({ room }) => {
            if (!window.WorldManager) throw new Error('las pantallas grandes no estan cargadas');
            return WorldManager.open(room);
        },
        close_room: () => {
            if (!window.WorldManager) throw new Error('las pantallas grandes no estan cargadas');
            const open = WorldManager.activeRoom;
            if (!open) throw new Error('no hay ninguna abierta');
            return WorldManager.close(open);
        },
        show_session: ({ session }) => call('switchSession', session),
        // The split panel showing `place` gets `session`; no split view = a plain switch.
        put_in_panel: ({ session, place }) => (pc() ? call('pcCombineReplaceSession', place, session) : call('switchSession', session)),
        scroll_bottom: () => { onlyPC('bajar la terminal'); return call('scrollToBottom'); },
        focus_mode: () => { onlyPC('el modo foco'); return call('pcToggleFocusMode'); },
        show_brief: () => call('mrnToggle'),
        show_projector: ({ session }) => { onlyPC('el proyector'); return call('projectorOpen', session || ''); },
        mute_voices: () => call('toggleVoiceMute'),
        eye_protect: () => call('toggleEyeProtect'),
        font_size: ({ size }) => {
            const n = Math.max(1, Math.min(4, Number(size) || 2));
            return pc() ? call('pcSetFontSize', n) : call('setTerminalFontSize', PT[n - 1]);
        },
        sessions_panel: () => (pc() ? call('showHomeSessionPicker') : call('showSessionsModal')),
        new_session_dialog: () => { onlyPC('el cuadro de sesion nueva'); return call('pcCreateSession'); },
        restart_dialog: () => call('showRestartConfirm'),
        // The permission card is drawn twice, and the two have different names.
        approve_permission: () => (pc() ? call('approvePerm') : call('approveAction')),
        deny_permission: () => (pc() ? call('denyPerm') : call('denyAction')),
        quick_answer: ({ answer }) => call('quick', answer),
        slash_command: ({ cmd }) => call('quick', cmd),
        stop_session: () => call('sendKey', 'Escape'),
        // The session first, then the text: switching sessions must not be the
        // thing that wipes the draft he is about to read.
        draft_prompt: ({ text, session }) => {
            if (session) call('switchSession', session);
            return call('fillPrompt', text);
        },
    };

    // One press. Never throws at the caller: a failure is an answer, and the
    // assistant has to be able to say it.
    function run(fn, args) {
        const h = HANDLERS[String(fn || '')];
        if (!h) return { ok: false, why: `no conozco el boton ${fn}` };
        try {
            h(args || {});
            return { ok: true };
        } catch (e) {
            return { ok: false, why: e && e.message ? e.message : 'no se pudo' };
        }
    }

    window.UIActions = { run, names: () => Object.keys(HANDLERS) };
})();
