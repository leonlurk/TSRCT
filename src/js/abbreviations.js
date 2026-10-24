// ==============================================
// TSRCT - Abbreviations and the command builder
// Typed shortcuts that expand into text, Ctrl keys or special keys, with the live
// preview under the input and the editor modal. Cut out of main.js verbatim
// (cleanup round 4, 2026-10-24); it loads just before main.js.
// ==============================================
(function () {
        // ═══════════════════════════════════════════════════════════════════════════
        // SMART ABBREVIATIONS - Advanced text expansion system
        // ═══════════════════════════════════════════════════════════════════════════


        // ═══════════════════════════════════════════════════════════
        // COMMAND BUILDER - Shortcuts & Actions
        // Types: 'text' (expansion), 'ctrl' (Ctrl+key), 'key' (special key)
        // ═══════════════════════════════════════════════════════════

        const DEFAULT_COMMANDS = {
            // ── ACTIONS: Terminal Control ──
            '^c': { type: 'ctrl', key: 'c', label: 'Interrupt (SIGINT)' },
            '^d': { type: 'ctrl', key: 'd', label: 'EOF / Exit' },
            '^z': { type: 'ctrl', key: 'z', label: 'Suspend process' },
            '^l': { type: 'ctrl', key: 'l', label: 'Clear screen' },
            '^a': { type: 'ctrl', key: 'a', label: 'Start of line' },
            '^e': { type: 'ctrl', key: 'e', label: 'End of line' },
            '^u': { type: 'ctrl', key: 'u', label: 'Clear line' },
            '^k': { type: 'ctrl', key: 'k', label: 'Kill to end' },
            '^w': { type: 'ctrl', key: 'w', label: 'Delete word' },
            '^r': { type: 'ctrl', key: 'r', label: 'Search history' },

            // ── ACTIONS: Special Keys ──
            '@ent': { type: 'key', key: 'Enter', label: 'Enter' },
            '@esc': { type: 'key', key: 'Escape', label: 'Escape' },
            '@tab': { type: 'key', key: 'Tab', label: 'Tab' },
            '@up': { type: 'key', key: 'Up', label: 'Arrow Up' },
            '@dn': { type: 'key', key: 'Down', label: 'Arrow Down' },

            // ── TEXT: Git shortcuts ──
            'gs': { type: 'text', value: 'git status' },
            'gd': { type: 'text', value: 'git diff' },
            'gp': { type: 'text', value: 'git pull' },
            'gps': { type: 'text', value: 'git push' },
            'ga': { type: 'text', value: 'git add .' },
            'gc': { type: 'text', value: 'git commit -m ""' },
            'gco': { type: 'text', value: 'git checkout ' },
            'gb': { type: 'text', value: 'git branch' },
            'gl': { type: 'text', value: 'git log --oneline -10' },
            'gcp': { type: 'text', value: 'git add . && git commit -m "" && git push' },
            'gst': { type: 'text', value: 'git stash' },
            'gsp': { type: 'text', value: 'git stash pop' },

            // ── TEXT: npm/node ──
            'ni': { type: 'text', value: 'npm install' },
            'nid': { type: 'text', value: 'npm install -D ' },
            'nr': { type: 'text', value: 'npm run ' },
            'nrs': { type: 'text', value: 'npm run start' },
            'nrd': { type: 'text', value: 'npm run dev' },
            'nrt': { type: 'text', value: 'npm run test' },
            'nrb': { type: 'text', value: 'npm run build' },

            // ── TEXT: Quick responses ──
            'yy': { type: 'text', value: 'y' },
            'nn': { type: 'text', value: 'n' },
            'yya': { type: 'text', value: 'yes to all' },
            'ss': { type: 'text', value: 'skip' },
            'ok': { type: 'text', value: 'looks good, continue' },
            'fx': { type: 'text', value: 'fix it' },
            'rvt': { type: 'text', value: 'revert that change' },

            // ── TEXT: Navigation ──
            '..': { type: 'text', value: 'cd ..' },
            '...': { type: 'text', value: 'cd ../..' },
            'lsa': { type: 'text', value: 'ls -la' },
            'mkd': { type: 'text', value: 'mkdir -p ' },

            // ── TEXT: Claude Code ──
            'clr': { type: 'text', value: '/clear' },
            'cmp': { type: 'text', value: '/compact' },
            'hlp': { type: 'text', value: '/help' },

            // ── TEXT: Docker ──
            'dps': { type: 'text', value: 'docker ps' },
            'dcu': { type: 'text', value: 'docker-compose up -d' },
            'dcd': { type: 'text', value: 'docker-compose down' },
        };

        let userCommands = {};
        let currentPreview = null;

        function loadAbbreviations() {
            try {
                const saved = localStorage.getItem('commandBuilder');
                if (saved) {
                    userCommands = JSON.parse(saved);
                } else {
                    // Migrate old format or use defaults
                    const oldSaved = localStorage.getItem('smartAbbreviations');
                    if (oldSaved) {
                        const old = JSON.parse(oldSaved);
                        // Convert old string format to new object format
                        userCommands = {};
                        for (const [key, val] of Object.entries(old)) {
                            if (typeof val === 'string') {
                                userCommands[key] = { type: 'text', value: val };
                            } else {
                                userCommands[key] = val;
                            }
                        }
                        saveAbbreviations();
                        localStorage.removeItem('smartAbbreviations');
                    } else {
                        userCommands = JSON.parse(JSON.stringify(DEFAULT_COMMANDS));
                    }
                }
            } catch (e) {
                userCommands = JSON.parse(JSON.stringify(DEFAULT_COMMANDS));
            }
        }

        function saveAbbreviations() {
            localStorage.setItem('commandBuilder', JSON.stringify(userCommands));
        }

        // Get display text for a command
        function getCommandDisplay(cmd) {
            if (cmd.type === 'ctrl') return `Ctrl+${cmd.key.toUpperCase()}`;
            if (cmd.type === 'key') return cmd.key;
            return cmd.value || '';
        }

        // Find matching command for current input
        function findAbbreviationMatch(text) {
            if (!text) return null;
            const lower = text.toLowerCase();

            // Exact match first
            if (userCommands[lower]) {
                const cmd = userCommands[lower];
                return {
                    abbr: lower,
                    cmd: cmd,
                    expansion: getCommandDisplay(cmd),
                    exact: true
                };
            }

            // Fuzzy: find commands that start with input (only for 2+ chars)
            if (text.length >= 2) {
                for (const [abbr, cmd] of Object.entries(userCommands)) {
                    if (abbr.startsWith(lower)) {
                        return {
                            abbr,
                            cmd,
                            expansion: getCommandDisplay(cmd),
                            exact: false
                        };
                    }
                }
            }

            return null;
        }

        // Expand abbreviation in text (for send function)
        function expandAbbreviation(text) {
            if (!text) return text;
            const match = findAbbreviationMatch(text.trim());
            if (match && match.exact && match.cmd.type === 'text') {
                return match.cmd.value;
            }
            return text;
        }

        // Global preview element
        let abbrPreviewEl = null;
        let activeAbbrInput = null;

        function getOrCreatePreview() {
            if (!abbrPreviewEl) {
                abbrPreviewEl = document.createElement('div');
                abbrPreviewEl.id = 'abbr-preview';
                abbrPreviewEl.className = 'abbr-preview';

                // Use touchend for mobile
                abbrPreviewEl.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    applyAbbrFromPreview();
                });

                // Fallback for desktop
                abbrPreviewEl.addEventListener('click', (e) => {
                    e.preventDefault();
                    applyAbbrFromPreview();
                });

                document.body.appendChild(abbrPreviewEl);
            }
            return abbrPreviewEl;
        }

        function applyAbbrFromPreview() {
            if (!activeAbbrInput || !currentPreview) return;

            const input = activeAbbrInput;
            const cmd = currentPreview.cmd;

            playSound('tap');
            hideAbbrPreview();

            if (cmd.type === 'ctrl') {
                // Send Ctrl+key
                input.value = '';
                sendCtrl(cmd.key);
            } else if (cmd.type === 'key') {
                // Send special key
                input.value = '';
                sendKey(cmd.key);
            } else {
                // Text expansion
                const expansion = cmd.value;
                input.value = expansion;

                // Re-focus and position cursor inside quotes if present
                const quotePos = expansion.indexOf('""');
                setTimeout(() => {
                    input.focus();
                    if (quotePos !== -1) {
                        input.setSelectionRange(quotePos + 1, quotePos + 1);
                    }
                }, 50);
            }
        }

        // Show inline preview hint
        function showAbbrPreview(inputEl) {
            if (!inputEl) return;
            const text = inputEl.value.trim();
            const match = findAbbreviationMatch(text);

            const preview = getOrCreatePreview();
            activeAbbrInput = inputEl;

            if (match) {
                // Position preview above input
                const rect = inputEl.getBoundingClientRect();
                preview.style.position = 'fixed';
                preview.style.left = rect.left + 'px';
                preview.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
                preview.style.width = rect.width + 'px';

                // Style based on command type
                const cmd = match.cmd;
                let typeIcon = '';
                let typeClass = '';

                if (cmd.type === 'ctrl') {
                    typeIcon = '<span class="abbr-type-icon ctrl">⌃</span>';
                    typeClass = 'ctrl';
                } else if (cmd.type === 'key') {
                    typeIcon = '<span class="abbr-type-icon key">⌨</span>';
                    typeClass = 'key';
                }

                const displayVal = match.expansion.substring(0, 30) + (match.expansion.length > 30 ? '...' : '');

                const hint = match.exact
                    ? `${typeIcon}<span class="abbr-hint-key ${typeClass}">${match.abbr}</span> <span class="abbr-hint-arrow">→</span> <span class="abbr-hint-val">${displayVal}</span> <span class="abbr-hint-tab">TAP</span>`
                    : `${typeIcon}<span class="abbr-hint-partial">${match.abbr}</span> <span class="abbr-hint-val">${displayVal}</span> <span class="abbr-hint-tab">TAP</span>`;

                preview.innerHTML = hint;
                preview.classList.add('visible');
                currentPreview = match;
            } else {
                preview.classList.remove('visible');
                currentPreview = null;
            }
        }

        // Hide preview
        function hideAbbrPreview() {
            if (abbrPreviewEl) abbrPreviewEl.classList.remove('visible');
            currentPreview = null;
            activeAbbrInput = null;
        }

        // Accept preview with Tab
        function acceptAbbrPreview(inputEl) {
            if (!currentPreview || !inputEl) return false;
            inputEl.value = currentPreview.expansion;
            hideAbbrPreview();

            // Position cursor intelligently (inside quotes if present)
            const quotePos = currentPreview.expansion.indexOf('""');
            if (quotePos !== -1) {
                inputEl.setSelectionRange(quotePos + 1, quotePos + 1);
            }

            return true;
        }

        // Initialize abbreviation system on input fields
        function initAbbrSystem() {
            // Main input on home screen
            const inputs = ['prompt', 'fs-prompt', 'omni-quick-input', 'omni-broadcast-input'];

            inputs.forEach(id => {
                const input = $(id);
                if (!input) return;

                input.addEventListener('input', () => showAbbrPreview(input));
                input.addEventListener('blur', () => setTimeout(hideAbbrPreview, 200));
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Tab' && currentPreview) {
                        e.preventDefault();
                        acceptAbbrPreview(input);
                    }
                });
            });
        }

        // Call on load
        document.addEventListener('DOMContentLoaded', initAbbrSystem);

        function addCommand(abbr, cmd) {
            userCommands[abbr.toLowerCase()] = cmd;
            saveAbbreviations();
            toast(`Added: ${abbr}`, 'success');
        }

        function removeAbbreviation(abbr) {
            delete userCommands[abbr];
            saveAbbreviations();
        }

        function showAbbreviationsModal() {
            const modal = $('abbreviations-modal');
            if (!modal) return;
            modal.classList.remove('hidden');
            renderAbbreviationsList();
            playSound('notify');
        }

        function hideAbbreviationsModal() {
            const modal = $('abbreviations-modal');
            if (modal) modal.classList.add('hidden');
        }

        function resetAbbreviations() {
            userCommands = JSON.parse(JSON.stringify(DEFAULT_COMMANDS));
            saveAbbreviations();
            renderAbbreviationsList();
            toast('Reset to defaults', 'success');
        }

        // ═══════════════════════════════════════════════════════════
        function renderAbbreviationsList(filter = '') {
            const list = $('abbreviations-list');
            if (!list) return;

            let entries = Object.entries(userCommands);

            // Filter if search term provided
            if (filter) {
                const f = filter.toLowerCase();
                entries = entries.filter(([abbr, cmd]) => {
                    const display = getCommandDisplay(cmd);
                    return abbr.includes(f) || display.toLowerCase().includes(f) ||
                           (cmd.label && cmd.label.toLowerCase().includes(f));
                });
            }

            // Sort: actions first (^, @), then alphabetically
            entries.sort((a, b) => {
                const aIsAction = a[0].startsWith('^') || a[0].startsWith('@');
                const bIsAction = b[0].startsWith('^') || b[0].startsWith('@');
                if (aIsAction && !bIsAction) return -1;
                if (!aIsAction && bIsAction) return 1;
                return a[0].localeCompare(b[0]);
            });

            if (entries.length === 0) {
                list.innerHTML = filter
                    ? '<div class="abbr-empty">No matches</div>'
                    : '<div class="abbr-empty">No commands</div>';
                return;
            }

            list.innerHTML = entries.map(([abbr, cmd]) => {
                const display = getCommandDisplay(cmd);
                const typeClass = cmd.type === 'ctrl' ? 'type-ctrl' :
                                  cmd.type === 'key' ? 'type-key' : 'type-text';
                const typeIcon = cmd.type === 'ctrl' ? '⌃' :
                                 cmd.type === 'key' ? '⌨' : '⌨';

                return `
                <div class="abbr-item ${typeClass}" onclick="quickUseAbbr('${escapeHtml(abbr)}')">
                    <span class="abbr-type">${cmd.type !== 'text' ? typeIcon : ''}</span>
                    <span class="abbr-key">${escapeHtml(abbr)}</span>
                    <span class="abbr-arrow">→</span>
                    <span class="abbr-value">${escapeHtml(display.substring(0, 28))}${display.length > 28 ? '...' : ''}</span>
                    <button class="abbr-delete" onclick="event.stopPropagation(); removeAbbreviation('${escapeHtml(abbr)}'); renderAbbreviationsList();">×</button>
                </div>`;
            }).join('');
        }

        // Quick use: tap command to execute it
        function quickUseAbbr(abbr) {
            const cmd = userCommands[abbr];
            if (!cmd) return;

            hideAbbreviationsModal();
            playSound('tap');

            if (cmd.type === 'ctrl') {
                sendCtrl(cmd.key);
            } else if (cmd.type === 'key') {
                sendKey(cmd.key);
            } else {
                // Text - insert into input
                const msgInput = $('prompt');
                if (msgInput) {
                    msgInput.value = cmd.value;
                    msgInput.focus();

                    // Position cursor in quotes if present
                    const quotePos = cmd.value.indexOf('""');
                    if (quotePos !== -1) {
                        setTimeout(() => {
                            msgInput.setSelectionRange(quotePos + 1, quotePos + 1);
                        }, 10);
                    }
                }
            }
        }

        function addNewAbbreviation() {
            const abbrInput = $('new-abbr-key');
            const expInput = $('new-abbr-value');
            const typeSelect = $('new-abbr-type');
            if (!abbrInput || !expInput) return;

            const abbr = abbrInput.value.trim().toLowerCase();
            const value = expInput.value.trim();
            const type = typeSelect ? typeSelect.value : 'text';

            if (!abbr || !value) {
                toast('Fill both fields', 'error');
                return;
            }

            if (abbr.includes(' ')) {
                toast('Key cannot have spaces', 'error');
                return;
            }

            let cmd;
            if (type === 'ctrl') {
                cmd = { type: 'ctrl', key: value.toLowerCase() };
            } else if (type === 'key') {
                cmd = { type: 'key', key: value };
            } else {
                cmd = { type: 'text', value: value };
            }

            addCommand(abbr, cmd);
            abbrInput.value = '';
            expInput.value = '';
            renderAbbreviationsList();
        }

        // Initialize commands on load
        loadAbbreviations();

        // ═══════════════════════════════════════════════════════════════════════════
        // END SMART FEATURES
        // ═══════════════════════════════════════════════════════════════════════════

        Object.assign(window, {
            addNewAbbreviation, expandAbbreviation, hideAbbreviationsModal, quickUseAbbr, removeAbbreviation,
            renderAbbreviationsList, resetAbbreviations, showAbbreviationsModal,
        });
        Object.defineProperty(window, 'userCommands', { get: () => userCommands, configurable: true });

})();
