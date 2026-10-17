---
name: pc-windows
description: Move, resize, maximize, minimize or switch monitor for any window on Leon's PC without the mouse, and list what is open where. Use instead of dragging windows or reading a screenshot to find them.
---

# Windows without the mouse

`D=/mnt/c/Users/you/PROJECTS/TSRCT/scripts/desk.js` (write the full path every time, run the command as is).

## His monitors
- **Screen 1 = the laptop** (primary, 2560x1600). His words: la notebook, la laptop, la compu, la principal.
- **Screen 2 = the Samsung** (1920x1080, to the LEFT of the laptop). His words: el monitor, el samsung, el externo, el segundo.
- "el otro / la otra" = the monitor the window is NOT on now.

## Commands
```
node $D windows                                        # monitors + every open window, front first, no screenshot
node $D place --window spotify --where "a la derecha del monitor"
node $D place --window chrome --slot left --screen 2   # same thing with exact values
node $D place --window excel --where "al otro monitor" # keeps its shape, other monitor
node $D solo  --window slack                           # minimize every other window (TSRCT stays)
```
`--where` takes his words as he said them. Slots, if you prefer `--slot`:
`left right top bottom tl tr bl br third1 third2 third3 twothirds-left twothirds-right center max min restore`.

`--window` matches the program name first (spotify, chrome, slack, code, notepad, excel, ClickUp, WhatsApp),
then the window title. For one Chrome window among several, use a word of its title (`--window "Gmail"`).

## Notes
- Two windows at once: two `place` calls (one per window), no look in between.
- "Spotify a la izquierda y Chrome a la derecha del monitor" = `place spotify left screen 2`, `place chrome right screen 2`.
- The answer has the rectangle where it landed; trust it, no screenshot needed.
- A window of the restricted project is shown as `[restringido]` and cannot be moved. Do not try.
- "no veo ninguna ventana de X": it is not open. Open it first (`open --app X`), then place it.
