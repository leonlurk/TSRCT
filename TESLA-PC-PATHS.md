# Tesla on the PC: building fast paths (step-by-step guide)

## Status (2026-10-11): built, live after a TSRCT restart

| Phase | State |
|---|---|
| 1 Inventory | built: `desk.js windows`, `list_windows` (0.6 s) |
| 2 Window placement | built: `place`, `solo`, `arrange_window`, `solo_window`; pixel exact on both monitors, 1.1-2.0 s |
| 3 PowerToys Workspaces | built (read + launch by name), **unverified**: he has saved none yet, so the launcher args are untested |
| 4 Tesla's own layouts | built: save/restore/list/delete + 4 starters (trabajo, concentracion, comunicacion, musica); restore of 3 windows 3.3 s |
| 5 FancyZones | built: `set_zones`, tested on his monitor 2 (0.6 s) and set back. Needs PowerToys running |
| 6 Shortcut library | built: 36 shortcuts + 3 routines in `lib/deskShortcuts.js`; Slack routine tested (6 s, nothing typed in the message box) |
| 7 Deep links | built: Windows Settings (45 words), Spotify search; `pcDirect.openUri` allowlist (ms-settings, spotify, slack, whatsapp without text, vscode) |
| 8 Virtual desktops | switch/create via shortcuts only; moving a window between desktops skipped (needs a third-party module) |
| 9 Learning loop | built: `tesla-review.js` DESK counts paths vs mouse steps and flags stretches of 3+ clicks with no path |
| Skills | `tesla-skills/` (7 sheets) for the `hands` worker |

Done with his authorization (2026-10-11): PowerToys started, Workspaces editor hotkey Ctrl+W -> Win+Ctrl+`.
Next: one PowerShell run per shortcut/routine (now 3-5 runs, 1-6 s); a claude.ai routine (the 2026-10-11
kara test used 115 clicks/typing steps with no path); verify the Workspaces launcher once he saves one.

---

Written 2026-10-10. Audience: whoever builds this next (a Claude session in this repo, or Tesla's
`hands` worker when it is asked to extend itself). Read it top to bottom once, then work phase by
phase. Each phase ends in something Leon can say out loud and that works.

---

## 0. The goal in one paragraph

Leon wants to run his Windows PC by voice, like a person would, but faster than a person. Today
Tesla can look (`look_at_screen`), click and type (`do_on_pc`), and open files, apps, links and
media keys directly (`lib/pcDirect.js`). The slow part is everything in between: arranging windows,
switching between "modes" of work, and doing in-app things she currently does with the mouse. This
guide turns those into **direct paths**: one command, no screenshot, no model, about one second.

The rule that decides everything (his words, 2026-10-10): *"toda tarea que se pueda hacer mas
rapido o eficiente evitando el uso fisico del mouse, que se haga."*

---

## 1. Ground rules (read before writing any code)

1. **Direct first, mouse last.** Order of preference for any task:
   1. A Windows/OS call (open, focus, move a window, a URI, a command line).
   2. A PowerToys command (Workspaces launcher, FancyZones CLI).
   3. A keyboard shortcut sent with `act.ps1 key`.
   4. Only then `do_on_pc` with look + click.
2. **Harmless runs without a question; changes ask.** See the table in section 13.
3. **SecretCo.** Refuse only when he is actually working in SecretCo (their org, the SecretCoSandbox folder or
   session, a window that IS SecretCo work). The word on screen never refuses. Every new path goes
   through `restrictedGuard.assertNotRestricted()` on its inputs and through `desk.titleIsRestrictedWork()` on the
   window it touches. No SecretCo data in any log line, prompt or answer.
4. **He has the mouse, he wins.** Any path that moves windows or presses keys respects the
   3-minute human pause in `lib/desk.js` (`planAct`). Pure launches (open app, open workspace) may
   skip it, the same way `focus` and `media` do (`direct: true`).
5. **Never type into the wrong window.** Before any `type`, check the window in front. (A test
   line once went into his Notepad file "PV-A ordenar drive.txt".)
6. **Do not load the machine.** No polling loops, no background watchers. Every path is one
   short PowerShell call. `grep` here is `ugrep`: write output to a file and filter with python3.
7. **Do not change his PowerToys or Windows settings without his yes.** Reading them is fine.
   Creating a layout, a workspace or a key remap is a change.
8. **One copy of the code.** Everything lives in TSRCT (`lib/`, `scripts/desk/`). Ghost Runner
   loads the same orb; never copy logic into it.
9. **Red test first** for every phase, in `scripts/check-desk.js` (and `check-talk.js` for new
   sentences). `npm run check` stays green.

---

## 2. What is on his PC today (measured 2026-10-10, read-only)

| Thing | State |
|---|---|
| PowerToys | **v0.100.2**, per-user install at `C:\Users\you\AppData\Local\PowerToys\`, starts with Windows, not elevated |
| Settings folder | `C:\Users\you\AppData\Local\Microsoft\PowerToys\` |
| Workspaces | **ON**, editor hotkey **Ctrl+W** (see warning below). **No workspace saved yet** (no `workspaces.json`) |
| FancyZones | **ON**. Both monitors use the built-in `focus` layout (3 zones). No custom layouts, no layout hotkeys |
| FancyZones CLI | **Present**: `FancyZonesCLI.exe` (commands in section 6) |
| Command Palette (CmdPal) | ON |
| Keyboard Manager | **OFF** |
| PowerToys Run | OFF (replaced by Command Palette) |
| Always On Top, Peek, Awake, Shortcut Guide, Find My Mouse | ON |
| Monitors (desk.js numbering) | Screen 1: laptop 2560x1600 at 0,0 (`SDC41AB`). Screen 2: Samsung 1920x1080 at -1920,368 (`SAM707B`) |
| FancyZones monitor numbers | laptop = 1, Samsung = **5**. Not the same numbering as desk.js. Always map by monitor ID, never by number |

**Warning for Leon (a question, not a change):** the Workspaces editor hotkey is set to plain
**Ctrl+W**, which is also "close tab" in every browser and many apps. If PowerToys grabs it, Ctrl+W
stops closing tabs; if it does not, the hotkey never works. The PowerToys default is Win+Ctrl+`.
Ask him before changing it.

---

## 3. The toolbox, fastest first

### 3.1 Already built (use these, do not rebuild)
| Path | Where | Speed |
|---|---|---|
| Open file / folder / reveal in folder | `pcDirect.openPath` -> `scripts/desk/open.ps1 -Target/-Reveal` | ~1 s |
| Open link | `pcDirect.openUrl` | ~1 s |
| Open app (raise if open, else launch from Get-StartApps) | `pcDirect.openApp` | ~1 s |
| Move file to a folder (asks) | `pcDirect.moveFile` | instant |
| Files a session just wrote | `pcDirect.sessionFiles` | instant |
| Media keys and volume | `pcDirect.media` -> `act.ps1 -Op media` | instant |
| Raise a window by name | `act.ps1 -Op focus` | ~1 s |
| Key combos | `act.ps1 -Op key -Keys ctrl+l` | instant |

### 3.2 To build, in this order
1. **Window placement** (Win32 `SetWindowPos` / `ShowWindow`): halves, thirds, quarters,
   maximize, minimize, restore, move to the other monitor. No PowerToys needed. (Phase 2)
2. **PowerToys Workspaces**: launch a saved set of apps with positions in one call. (Phase 3)
3. **Tesla's own layouts**: "guardá como está ahora" and "volvé a eso" without PowerToys'
   editor. (Phase 4)
4. **FancyZones CLI**: switch the zone layout per monitor. (Phase 5)
5. **Shortcut library**: named Windows and in-app shortcuts. (Phase 6)
6. **Deep links into apps** (URI schemes and command-line flags). (Phase 7)
7. **Virtual desktops**. (Phase 8)
8. **The learning loop**: find what she still does by mouse and turn it into a path. (Phase 9)

---

## 4. Phase 1: Inventory (read-only, do this first)

Goal: one cheap call that tells Tesla what is open and where, so every later path can match
windows by name without a screenshot.

1. Create `scripts/desk/inventory.ps1` (per-monitor DPI aware, like `look.ps1`). It prints one line
   per item, same `X|...` style as the other scripts:
   - `M|id|deviceName|x,y,w,h|primary` for each monitor (with the FancyZones monitor ID string
     from `EnumDisplayDevices`, so the two numberings can be mapped).
   - `W|hwnd|process|title|x,y,w,h|monitor|state` for each visible top-level window (state =
     normal/min/max). Skip tool windows and cloaked windows (`DwmGetWindowAttribute` CLOAKED).
2. Add `inventory` to `scripts/desk.js` and `desk.inventory()` in `lib/desk.js`. Titles that are
   SecretCo work are replaced by `[restricted]` before anything returns.
3. Cache the result for 5 s in memory only (no file, no loop).
4. Tests in `check-desk.js`: parse a fixed sample output; an SecretCo title is masked; the monitor
   map pairs desk screen 1/2 with FancyZones 1/5.
5. Done when: `node scripts/desk.js inventory` lists his open windows in under 1 s.

---

## 5. Phase 2: Window placement (`arrange_window`)

Goal: "poné Spotify a la derecha", "el chrome en el otro monitor", "maximizá el excel",
"minimizá todo menos TSRCT". No mouse, no look.

1. **New op in `scripts/desk/act.ps1`: `place`.** Args: `-Window <name>` and `-Where <slot>`,
   optional `-Screen N`.
   - Find the window the same way `focus` does (process name or title contains; restore it first
     if minimized).
   - Compute the target rectangle from the monitor's **work area** (`MONITORINFO.rcWork`, which
     excludes the taskbar), never the full rect.
   - Apply with `SetWindowPos` (`SWP_NOZORDER` off so it also comes to front), or `ShowWindow`
     for max/min/restore.
   - Print `P|process|title|x,y,w,h|monitor` after, read back with `GetWindowRect`.
   - Account for the invisible resize border of Windows 11 (`DwmGetWindowAttribute
     DWMWA_EXTENDED_FRAME_BOUNDS` vs `GetWindowRect`), or windows end up with a 7 px gap.
2. **Slot vocabulary** (one table, in `lib/pcDirect.js`, his words -> slot):
   | He says | Slot |
   |---|---|
   | izquierda / mitad izquierda | `left` |
   | derecha / mitad derecha | `right` |
   | arriba / abajo | `top` / `bottom` |
   | arriba a la izquierda (etc.) | `tl`, `tr`, `bl`, `br` |
   | tercio izquierdo / centro / derecho | `third1`, `third2`, `third3` |
   | dos tercios izquierda / derecha | `twothirds-left`, `twothirds-right` |
   | grande / maximizá / pantalla completa | `max` |
   | minimizá / escondé | `min` |
   | centrado | `center` (70 % of the work area) |
   | el otro monitor / el monitor grande / la notebook | `move` to screen 2 / 1 (keeps the relative slot) |
   Monitor words: "la notebook", "la laptop", "la pantalla de la compu" = screen 1; "el monitor",
   "el samsung", "el grande", "el otro" = screen 2. Confirm these words with him once.
3. **`pcDirect.placeWindow({window, where, screen})`** and the action **`arrange_window`** in
   `lib/actions.js` (args `window`, `where`, `screen`; `readOnly: false`, `skipConfirm: true`
   because it is harmless and undoable). Plain short line: "Listo." Several windows in one
   sentence ("spotify a la izquierda y chrome a la derecha") -> an array of moves, one call each.
4. **"Minimizá todo menos X"**: `pcDirect.soloWindow(name)` = minimize every visible window except
   X and TSRCT itself. Harmless, no question.
5. **Understanding:** rows in `lib/understand.js` (`aboutThePc`): verbs poné/mové/llevá/mandá +
   a window + a slot -> `arrange_window`, no Haiku needed. Haiku rule in `haikuBrain.js` BASE:
   "ventanas: arrange_window, nunca do_on_pc".
6. **Gate:** `planAct` with `direct: true` is NOT enough here, because moving windows while he
   drags something is rude. Use the human-pause check, but no look and no SecretCo pane OCR (the
   window title check is enough, it moves a window, it does not read it).
7. **Tests:** slot math for both monitors (including the negative-x Samsung at -1920,368); the word
   table; "no lo encuentro" when nothing matches; SecretCo title refused; his sentences routed
   without Haiku.
8. Done when: "Tesla, Spotify a la derecha del monitor grande" moves it in about 1 s.

---

## 6. Phase 3: PowerToys Workspaces (`open_workspace`)

Goal: "Tesla, armá trabajo" opens every app of that set in its saved place, on both monitors.

### 6.1 What Leon does once (put these steps in her answer when he asks how)
1. Open the apps he wants and place them where he likes.
2. Open the Workspaces editor (his hotkey is Ctrl+W today, or PowerToys > Workspaces >
   "Launch editor").
3. "Create workspace" -> "Capture". Remove apps he does not want, name it in Spanish the way he
   will say it ("trabajo", "musica", "secretco" is NOT allowed, see below), save.
4. Suggested first set (ask him, do not assume): **trabajo** (TSRCT + ClickUp + Slack + Outlook),
   **foco** (TSRCT big + Spotify small), **cliente** (Chrome with Salesforce + ClickUp + Teams),
   **musica**, **cierre del dia**.

### 6.2 What Tesla builds
1. **Read the list:** `pcDirect.workspaces()` reads
   `C:\Users\you\AppData\Local\Microsoft\PowerToys\Workspaces\workspaces.json` (path from
   `WIN_HOME`). Expected shape (VERIFY against the real file once he saves one; this is from the
   PowerToys source and may differ in v0.100):
   ```json
   { "workspaces": [ { "id": "{GUID}", "name": "trabajo", "applications": [
       { "application": "Spotify", "application-path": "...", "app-user-model-id": "...",
         "command-line-arguments": "", "position": {"X":0,"Y":0,"width":1280,"height":800},
         "monitor": 1, "maximized": false, "minimized": false } ],
     "monitor-configuration": [ ... ], "move-existing-windows": true } ] }
   ```
   Return `[{id, name, apps:[names]}]`. Skip and never name any workspace whose name or app list
   is SecretCo (`restrictedGuard.mentionsRestricted`).
2. **Launch:** `PowerToys.WorkspacesLauncher.exe <id>`. VERIFY the exact arguments first: have him
   tick "Create desktop shortcut" on one workspace, then read that `.lnk` target with
   `(New-Object -ComObject WScript.Shell).CreateShortcut(path).TargetPath / .Arguments`. Use
   exactly what the shortcut uses. Add `-Workspace <id>` to `scripts/desk/open.ps1`, which starts
   the launcher detached and prints `K|<name>`.
3. **Match his words to a workspace:** normalize (lowercase, no accents, drop "modo", "el",
   "la", "setup de"), exact name first, then a prefix, then one-word overlap. Two matches -> ask
   "¿Trabajo o trabajo cliente?". None -> list the names he has in one sentence.
4. **Action `open_workspace`** (args `name`; harmless: `skipConfirm: true`, it only opens and
   moves apps). Short line: "Armado." Also **`list_workspaces`** (read-only): "Tenés trabajo,
   foco y música."
5. **Understanding:** "armá X", "modo X", "poneme el setup de X", "abrí el workspace X",
   "preparame para X" -> `open_workspace` when X matches a saved name; otherwise fall through to
   the normal brain (so "armá un plan" still works). The match check needs the list, so pass the
   names into `understand` the way session names are passed.
6. **Brain context:** add one line to the per-turn context only when workspaces exist:
   `Workspaces guardados: trabajo, foco, musica.` (cheap, a few tokens).
7. **Tests:** parse a sample `workspaces.json`; name matching (accents, "modo", near names); SecretCo
   workspace hidden; missing file -> "Todavia no guardaste ninguno" with the 3 steps.
8. Done when: "Tesla, modo trabajo" opens and places the whole set.

**Fallback if the launcher cannot be called from the command line in v0.100:** Phase 4 does the
same job without PowerToys.

---

## 7. Phase 4: Tesla's own layouts (`save_layout` / `restore_layout`)

Goal: "Tesla, guardá cómo está ahora como foco" and later "volvé a foco", with no editor at all.
This is also the fallback for Phase 3.

1. **Save:** take the Phase 1 inventory, keep visible non-minimized windows (skip TSRCT's own
   PWA window only if he says so), and store per window: process, a title pattern (the stable
   part, e.g. "Spotify", not the song), monitor ID, rect, state. Write to
   `.tsrct/desk-layouts.json` (gitignored). SecretCo windows are never stored.
   - Asks before overwriting an existing name ("¿Piso foco?"). A new name does not ask.
2. **Restore:** for each stored window: if open, `place` it to the stored rect; if not, launch it
   (`openApp`), wait for its window (poll every 300 ms, max 8 s, one at a time), then place it.
   Report only what failed: "Listo, menos Teams que no abrió."
3. **Monitor safety:** if a stored monitor is not connected (the Samsung unplugged), put those
   windows on screen 1 in the same relative slot and say so in one short sentence.
4. Actions `save_layout` (asks only on overwrite), `restore_layout` (harmless), `list_layouts`,
   `delete_layout` (asks). When a name exists both as a PowerToys workspace and a Tesla layout,
   PowerToys wins and she says which one she used.
5. Tests: save -> restore round trip on a fake inventory; missing monitor; title pattern
   extraction ("Spotify Premium - Song" -> "Spotify").

---

## 8. Phase 5: FancyZones (`set_zones`)

Goal: "Tesla, poné el monitor grande en tres columnas" / "en prioridad" / "en foco".

1. CLI (measured on his PC, v0.100.2), run from
   `C:\Users\you\AppData\Local\PowerToys\FancyZonesCLI.exe`:
   ```
   get-monitors | m               list monitors and FancyZones metadata
   get-layouts | ls               list available layouts
   get-active-layout | active     show the active layout
   set-layout <uuid|template> [--monitor N]
   get-hotkeys | hk ; set-hotkey <0-9> <layout> ; remove-hotkey <key>
   open-editor | e ; open-settings
   ```
   Templates: `focus`, `columns`, `rows`, `grid`, `priority-grid`, `blank` (confirm with
   `get-layouts`).
2. Wrap in `scripts/desk/zones.ps1` or call the exe directly from `lib/pcDirect.js`
   (`execFile`, argv, timeout 10 s). Map desk screen numbers to FancyZones monitor numbers through
   `get-monitors` + the Phase 1 monitor IDs (today: screen 1 -> 1, screen 2 -> 5).
3. Words -> template: "columnas / tres columnas" = columns, "filas" = rows, "grilla / cuadricula"
   = grid, "prioridad / uno grande al medio" = priority-grid, "foco" = focus, "sin zonas" = blank.
4. Action `set_zones` (args `layout`, `screen`). It changes a PowerToys setting, but it is his
   own quick toggle and fully undoable: **ask once the first time, then remember his yes** in
   `config` (`desk_zones_ok`). `get_zones` is read-only.
5. **Snapping a window INTO a zone:** do not drive FancyZones with Shift-drag. Read the zone
   rects (`get-active-layout` gives zone count and type; compute the rects the same way
   FancyZones does for templates, or read `custom-layouts.json` for custom ones) and use the
   Phase 2 `place` op with that rect. So "Chrome en la zona 2" = `place` to zone 2's rect.
6. Tests: word table; monitor mapping; the CLI output parser on a captured sample.

---

## 9. Phase 6: The shortcut library (`press_shortcut`)

Goal: named shortcuts he can say ("captura de pantalla", "portapapeles", "escritorio"), and that
Tesla's hands use instead of clicking menus.

1. **Data, not code:** `lib/deskShortcuts.js` exports one table:
   `{ name, says: [his words], keys | uri | command, app: null|'chrome'|..., risk: 'harmless'|'ask'|'never' }`.
2. **Windows shortcuts to include (all verified Windows 11 defaults):**
   | Name | Keys | Risk |
   |---|---|---|
   | Show desktop | Win+D | harmless |
   | Minimize all / restore | Win+M / Win+Shift+M | harmless |
   | Snap left / right / max / min | Win+Left / Win+Right / Win+Up / Win+Down | harmless |
   | Move window to other monitor | Win+Shift+Left / Win+Shift+Right | harmless |
   | Snap layouts menu | Win+Z | harmless (opens a menu) |
   | Task view | Win+Tab | harmless |
   | New virtual desktop / next / previous / close | Win+Ctrl+D / Win+Ctrl+Right / Win+Ctrl+Left / Win+Ctrl+F4 | close = ask |
   | Clipboard history | Win+V | harmless |
   | Screenshot snip | Win+Shift+S | harmless |
   | File Explorer | Win+E | harmless |
   | Settings | Win+I | harmless |
   | Notifications / quick settings | Win+N / Win+A | harmless |
   | Emoji panel | Win+. | harmless |
   | Task Manager | Ctrl+Shift+Esc | harmless |
   | Taskbar app N | Win+1..9 | harmless |
   | Lock the PC | Win+L | **ask** (he loses the session in VR) |
   | Close window | Alt+F4 | **ask**, and never on TSRCT or an app with unsaved work |
   | Sign out / shut down | | **never** by shortcut |
3. **PowerToys shortcuts (only the enabled modules):** Always On Top Win+Ctrl+T (harmless),
   Command Palette Win+Alt+Space, Peek Ctrl+Space on a selected file, Shortcut Guide (hold Win).
   Read the real bindings from each module's `settings.json` under the PowerToys settings folder
   instead of trusting this list; he may have changed them.
4. **In-app shortcuts (verify each on his PC with one look before adding):**
   | App | Shortcut | Does |
   |---|---|---|
   | Chrome / Edge | Ctrl+L, Ctrl+T, Ctrl+Shift+T, Ctrl+Tab, Ctrl+1..8, Ctrl+F | address bar, new tab, reopen tab, next tab, tab N, find |
   | Spotify | Ctrl+L (search), Space (play/pause), Ctrl+Right/Left (next/previous), Ctrl+S (shuffle) | |
   | Slack | Ctrl+K (jump to channel or person), Ctrl+Shift+K (DMs), Alt+Up/Down | |
   | ClickUp | `/` or Ctrl+K (search) | verify, it changes between versions |
   | WhatsApp Desktop | Ctrl+F (search chats), Ctrl+N (new chat) | verify |
   | VS Code | Ctrl+P (file), Ctrl+Shift+P (command), Ctrl+` (terminal) | |
   | Outlook | Ctrl+1 mail, Ctrl+2 calendar, Ctrl+N new | ask before anything that sends |
   | Excel | Ctrl+F, Ctrl+G (go to), Ctrl+PageDown (next sheet) | ask before Ctrl+S |
5. **Action `press_shortcut`** (args `name`). It looks up the table, focuses `app` first when set,
   checks the window in front is that app, then sends the keys with `act.ps1 key`. `ask` rows
   confirm in 3 words ("¿Bloqueo la PC?"); `never` rows refuse. Unknown names are refused: she
   never sends free-form key combos from a spoken sentence. (Her `hands` worker can still send
   keys inside `do_on_pc`, under its own rules.)
6. **The recipe for `do_on_pc` and `look_at_screen`** gets one line: "before clicking a menu,
   check `lib/deskShortcuts.js` for that app". Better: inject the rows for the app in front into
   the recipe.
7. **Keyboard Manager is OFF.** Do not turn it on. If a path would need a remap (for example one
   key that opens his work workspace), propose it to Leon with the exact remap and let him do it.
8. Tests: every `says` phrase routes to its row; `never` rows unreachable; the app-in-front check
   refuses when the wrong window is in front; no duplicate `says` across rows.

---

## 10. Phase 7: Deep links into apps (no clicking inside the app)

Goal: land directly on the right screen of an app.

1. Extend `pcDirect.openUrl` to accept an allowlist of schemes besides http(s), each with a
   builder:
   | Scheme | Example | Use |
   |---|---|---|
   | `ms-settings:` | `ms-settings:display`, `ms-settings:sound`, `ms-settings:bluetooth`, `ms-settings:network-wifi` | "abrí la config de sonido" |
   | `spotify:` | `spotify:search:<query>`, `spotify:playlist:<id>` | "poné X en spotify" without typing |
   | `slack://` | `slack://channel?team=<T>&id=<C>`, `slack://user?team=<T>&id=<U>` | open a channel or DM (IDs from the Slack MCP, read-only) |
   | `whatsapp://` | `whatsapp://send?phone=<number>` | open a chat (never send) |
   | `mailto:` | `mailto:x@example.com?subject=...` | opens a draft, never sends |
   | `vscode://` | `vscode://file/<path>:<line>` | open a file at a line |
   | ClickUp | `https://app.clickup.com/t/<task id>` | open a task (ID from the ClickUp MCP) |
   | Salesforce | the org's Lightning URL | **not for SecretCo orgs**, ever |
2. Command-line forms for the rest: `explorer /select,<path>` (already `-Reveal`), `code <path>`,
   `wt -d <path>` (terminal in a folder).
3. Each scheme is checked against its own regex; the whole URI goes through `restrictedGuard`.
4. Action: reuse `open_file` / `open_app` with a new `uri` arg, or one `open_link` action. Short
   line "Abierto."
5. Tests: each builder; schemes outside the list refused; `whatsapp://send` never carries `text=`
   (that would pre-fill a message he did not write).

---

## 11. Phase 8: Virtual desktops

Goal: "Tesla, pasate al escritorio de clientes", "mandá esto al escritorio 2".

1. Switching and creating: Phase 6 shortcuts (Win+Ctrl+Left/Right/D).
2. Moving a window to another desktop and naming desktops has no public API. Options, in order:
   the `VirtualDesktop` PowerShell module (third party: ask Leon before installing anything), or
   skip it. Do not hand-roll undocumented COM interfaces; they break with every Windows update.
3. Note: FancyZones layouts and PowerToys workspaces are per virtual desktop; test both after
   switching.

---

## 12. Phase 9: The learning loop (how the list keeps growing)

1. **Measure:** in `scripts/tesla-review.js` DESK section, add "mouse used where a path exists":
   for each `do_on_pc` run, check whether its task text matches a row in the shortcut table, a
   saved workspace, a layout or a deep link. Count them.
2. **Find new paths:** group `do_on_pc` tasks by app and verb over the last 7 days. Anything done
   by mouse 3 or more times becomes a candidate in `logs/tesla-workarounds.md` with: the task, the
   app, how long it took, and the proposed direct path.
3. **Each `/tesla-review`** picks the top 1 or 2 candidates and builds them (red test first), the
   same way buttons are added today.
4. **Never auto-create** a workspace, layout, shortcut or remap from the log. She proposes, he
   says yes.

---

## 13. The safety table (applies to every phase)

| Kind | Examples | Rule |
|---|---|---|
| Harmless, undoable | open app/file/link/workspace, move/resize/min/max a window, media keys, show desktop, switch virtual desktop, clipboard panel | Runs at once, short line ("Listo") |
| Changes a setting or saved thing | save layout over an existing one, set FancyZones layout (first time), close a window, lock the PC | Asks in 3-4 words, once |
| Touches his work | type in an app, send, save, delete, Ctrl+S, Alt+F4 on a window with unsaved work | `do_on_pc` rules: asks, checks the window in front |
| Never | shut down, sign out, uninstall, change PowerToys/Windows settings other than the above, any SecretCo window or org, free-form key combos from his words | Refuses in one sentence |

---

## 14. Per-phase checklist (copy into each phase's PR)

- [ ] Red test added and seen failing (`check-desk.js`, `check-talk.js` for sentences)
- [ ] Code in `scripts/desk/*.ps1` (argv only, per-monitor DPI) + `lib/pcDirect.js` / `lib/desk.js`
- [ ] Action in `lib/actions.js` with `readOnly`, `skipConfirm`, a short plain line, `verify.fn`
- [ ] Sentences in `lib/understand.js` (`aboutThePc`), rule line in `lib/haikuBrain.js` BASE
- [ ] Every step logged by `logDesk` (no SecretCo, no window titles of restricted work)
- [ ] SecretCo guard on inputs and on the window touched; `npm run check` green
- [ ] Ghost Runner `node test-tesla.mjs` still passes (the orb is shared)
- [ ] If any frontend file changed: bump `sw.js` CACHE_NAME and the number in CLAUDE.md
- [ ] CLAUDE.md "Tesla's eyes on the PC" paragraph, DOCUMENTATION.md gotcha 46, vault decision at
      the TOP of `vault/wiki/decisions/TSRCT.md`
- [ ] Measured: time from his last word to "Listo", before (mouse) and after (direct)
- [ ] No restart and no commit without his yes

---

## 15. Questions for Leon before starting

1. Which workspaces does he want first, and what goes in each? (Phase 3 needs him to save them.)
2. Workspaces' editor hotkey is plain **Ctrl+W**. Change it back to Win+Ctrl+`?
3. His words for each monitor ("la notebook" / "el grande")?
4. OK to let Tesla switch the FancyZones layout by voice after asking once?
5. Virtual desktops: does he use them at all? If not, skip Phase 8.
