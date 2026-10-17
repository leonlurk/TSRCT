/* ==============================================
   TSRCT - Desktop notes (Nexus Notes, the living notepad)
   ============================================== */
// Moved out of desktop.js (cleanup P2 #11). Loads BEFORE desktop.js; see desktop-git.js.
(function () {

// ==============================================
// NEXUS NOTES - Living Notepad
// ==============================================

function nexusNotesInit() {
    const textarea = document.getElementById('pc-notes-textarea');
    const container = document.getElementById('pc-notes-container');
    const toggle = document.getElementById('pc-notes-toggle');

    if (!textarea) return;

    // Create default note if none exist
    if (Desktop.notes.length === 0) {
        nexusNotesAdd(true);
    }

    // Restore collapsed state
    if (Desktop.notesCollapsed) {
        container?.classList.add('collapsed');
        if (toggle) toggle.textContent = '[v]';
    }

    // Set up auto-save on input
    textarea.addEventListener('input', () => {
        nexusNotesAutoSave();
        nexusNotesUpdateInfo();
    });

    // Keyboard shortcuts within notes
    textarea.addEventListener('keydown', (e) => {
        // Ctrl+Enter: Send to terminal input
        if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            nexusNotesToTerminal();
            return;
        }
        // Ctrl+Shift+C: Copy all
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
            e.preventDefault();
            nexusNotesCopy();
            return;
        }
        // Ctrl+Shift+E: Export
        if (e.ctrlKey && e.shiftKey && e.key === 'E') {
            e.preventDefault();
            nexusNotesExport();
            return;
        }
        // Tab: Insert 2 spaces instead of changing focus
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 2;
            nexusNotesAutoSave();
        }
    });

    // Render tabs and load active note
    nexusNotesRenderTabs();
    nexusNotesLoadActive();
}

function nexusNotesAdd(silent = false) {
    const id = 'note_' + Date.now();
    const noteNum = Desktop.notes.length + 1;
    const note = {
        id,
        title: `#${noteNum}`,
        content: '',
        created: Date.now(),
        modified: Date.now(),
        color: nexusNotesRandomColor()
    };

    Desktop.notes.push(note);
    Desktop.activeNoteId = id;
    nexusNotesSave();
    nexusNotesRenderTabs();
    nexusNotesLoadActive();

    if (!silent && typeof toast === 'function') {
        toast('NEW NOTE', 'success');
    }

    // Focus textarea
    document.getElementById('pc-notes-textarea')?.focus();
}

function nexusNotesRandomColor() {
    const colors = ['neon', 'cyan', 'amber', 'purple', 'pink'];
    return colors[Math.floor(Math.random() * colors.length)];
}

function nexusNotesRenderTabs() {
    const tabsEl = document.getElementById('pc-notes-tabs');
    if (!tabsEl) return;

    if (Desktop.notes.length <= 1) {
        tabsEl.innerHTML = '';
        tabsEl.classList.add('hidden');
        return;
    }

    tabsEl.classList.remove('hidden');
    tabsEl.innerHTML = Desktop.notes.map(note => `
        <button class="pc-note-tab ${note.id === Desktop.activeNoteId ? 'active' : ''} pc-note-${note.color}"
                onclick="nexusNotesSwitch('${note.id}')"
                title="${escapeHtml(note.title)} - ${new Date(note.modified).toLocaleString()}">
            ${escapeHtml(note.title)}
        </button>
    `).join('');
}

function nexusNotesSwitch(id) {
    // Save current first
    nexusNotesSaveCurrent();

    Desktop.activeNoteId = id;
    localStorage.setItem('nexus_active_note', id);
    nexusNotesRenderTabs();
    nexusNotesLoadActive();
}

function nexusNotesLoadActive() {
    const textarea = document.getElementById('pc-notes-textarea');
    if (!textarea) return;

    const note = Desktop.notes.find(n => n.id === Desktop.activeNoteId);
    if (note) {
        textarea.value = note.content;
        nexusNotesUpdateInfo();
    } else if (Desktop.notes.length > 0) {
        // Fallback to first note
        Desktop.activeNoteId = Desktop.notes[0].id;
        textarea.value = Desktop.notes[0].content;
        nexusNotesUpdateInfo();
    }
}

function nexusNotesAutoSave() {
    // Debounce saves
    clearTimeout(Desktop.notesSaveTimeout);
    nexusNotesShowStatus('...');

    Desktop.notesSaveTimeout = setTimeout(() => {
        nexusNotesSaveCurrent();
        nexusNotesShowStatus('[ok]');
        setTimeout(() => nexusNotesShowStatus(''), 1500);
    }, 500);
}

function nexusNotesSaveCurrent() {
    const textarea = document.getElementById('pc-notes-textarea');
    if (!textarea) return;

    const note = Desktop.notes.find(n => n.id === Desktop.activeNoteId);
    if (note) {
        note.content = textarea.value;
        note.modified = Date.now();

        // Auto-title from first line
        const firstLine = textarea.value.split('\n')[0].trim();
        if (firstLine && firstLine.length > 0) {
            note.title = firstLine.substring(0, 15) + (firstLine.length > 15 ? '...' : '');
        }

        nexusNotesSave();
        nexusNotesRenderTabs();
    }
}

function nexusNotesSave() {
    localStorage.setItem('nexus_notes', JSON.stringify(Desktop.notes));
    localStorage.setItem('nexus_active_note', Desktop.activeNoteId);
}

function nexusNotesShowStatus(text) {
    const el = document.getElementById('pc-notes-status');
    if (el) el.textContent = text;
}

function nexusNotesUpdateInfo() {
    const textarea = document.getElementById('pc-notes-textarea');
    const info = document.getElementById('pc-notes-info');
    if (!textarea || !info) return;

    const chars = textarea.value.length;
    const lines = textarea.value.split('\n').length;
    const words = textarea.value.trim() ? textarea.value.trim().split(/\s+/).length : 0;

    info.textContent = `${chars}c ${words}w ${lines}L`;
}

function nexusNotesToggle() {
    const container = document.getElementById('pc-notes-container');
    const toggle = document.getElementById('pc-notes-toggle');
    if (!container) return;

    Desktop.notesCollapsed = !Desktop.notesCollapsed;
    container.classList.toggle('collapsed', Desktop.notesCollapsed);
    localStorage.setItem('nexus_notes_collapsed', Desktop.notesCollapsed);

    if (toggle) {
        toggle.textContent = Desktop.notesCollapsed ? '[v]' : '[^]';
    }
}

function nexusNotesCopy() {
    const textarea = document.getElementById('pc-notes-textarea');
    if (!textarea || !textarea.value) return;

    navigator.clipboard.writeText(textarea.value).then(() => {
        if (typeof toast === 'function') toast('COPIED', 'success');
    }).catch(() => {
        // Fallback
        textarea.select();
        document.execCommand('copy');
        if (typeof toast === 'function') toast('COPIED', 'success');
    });
}

function nexusNotesToTerminal() {
    const textarea = document.getElementById('pc-notes-textarea');
    const input = document.getElementById('pc-input');
    if (!textarea || !input) return;

    const text = textarea.value.trim();
    if (!text) return;

    input.value = text;
    input.focus();
    if (typeof toast === 'function') toast('SENT TO INPUT', 'success');
}

async function nexusNotesExport() {
    const textarea = document.getElementById('pc-notes-textarea');
    if (!textarea || !textarea.value) return;

    const note = Desktop.notes.find(n => n.id === Desktop.activeNoteId);
    const filename = note ? note.title.replace(/[^a-zA-Z0-9]/g, '_') : 'note';

    try {
        const res = await fetch('/api/files/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': (typeof token !== 'undefined' ? token : '')
            },
            body: JSON.stringify({
                filename: filename + '.md',
                content: textarea.value
            })
        });
        const data = await res.json();

        if (data.success) {
            if (typeof toast === 'function') toast(`EXPORTED: ${data.filename}`, 'success');
        } else {
            throw new Error(data.error);
        }
    } catch (e) {
        if (typeof toast === 'function') toast('EXPORT FAILED', 'error');
    }
}

function nexusNotesDelete() {
    if (Desktop.notes.length <= 1) {
        if (typeof toast === 'function') toast('CANNOT DELETE LAST NOTE', 'error');
        return;
    }

    const idx = Desktop.notes.findIndex(n => n.id === Desktop.activeNoteId);
    if (idx === -1) return;

    Desktop.notes.splice(idx, 1);

    // Switch to another note
    Desktop.activeNoteId = Desktop.notes[Math.max(0, idx - 1)].id;
    nexusNotesSave();
    nexusNotesRenderTabs();
    nexusNotesLoadActive();

    if (typeof toast === 'function') toast('NOTE DELETED', 'error');
}

// buildPCLayout in desktop.js calls it; the rest come from generated onclick HTML
Object.assign(window, {
    nexusNotesInit,
    nexusNotesAdd, nexusNotesCopy, nexusNotesDelete, nexusNotesExport, nexusNotesSwitch,
    nexusNotesToTerminal, nexusNotesToggle,
});

})();
