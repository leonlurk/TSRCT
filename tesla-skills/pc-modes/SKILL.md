---
name: pc-modes
description: Open and arrange a whole set of windows at once (a work mode like "trabajo", "comunicacion", "musica" or one Leon saved), save the current arrangement as a new mode, and change FancyZones zones. Use when he says "modo X", "arma X", "guarda las ventanas como X".
---

# Work modes, saved arrangements and zones

`D=/mnt/c/Users/you/PROJECTS/TSRCT/scripts/desk.js`

## Use a mode
```
node $D layout --list                # his modes, the starter ones and his PowerToys workspaces
node $D layout --restore trabajo     # opens what is missing and places every window
```
Starter modes (until he saves his own with the same name):
- **trabajo**: TSRCT big on the laptop, ClickUp left and Slack right on the monitor.
- **concentracion**: only TSRCT, everything else minimized.
- **comunicacion**: Slack left, WhatsApp right on the monitor.
- **musica**: Spotify on the right of the monitor.
A PowerToys Workspace with the same name wins over these (it opens with PowerToys' own launcher).
"modo foco" is NOT a PC mode: it is TSRCT's focus mode, not yours.

## Save one
```
node $D layout --save clientes                 # how the windows are NOW
node $D layout --save clientes --overwrite     # only after Leon said yes to replacing it
```
Saving is harmless; replacing an existing one needs his yes. Minimized windows are not saved.
To build a mode he describes ("un modo con excel a la izquierda y el mail a la derecha"):
open the apps, `place` each one, then `layout --save NAME`.

## Zones (PowerToys FancyZones)
```
node $D zones --layout columns --screen 2   # columns, rows, grid, priority-grid, focus, blank
```
PowerToys must be running. If the answer says it is closed: `open --app PowerToys`, wait 5 s, retry once.
Zones only change where windows snap when HE drags them with Shift; to put a window somewhere yourself use `place`.

## PowerToys Workspaces
He creates them in the PowerToys Workspaces editor (shortcut Win+Ctrl+`). You do not create or edit them:
they appear in `layout --list` under `workspaces` and open with `layout --restore NAME`.
