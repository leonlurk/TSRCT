---
name: pc-mouse
description: Look at Leon's screen and click, scroll and type like a person, for what happens INSIDE a program and has no shortcut or command. The slow last resort; read pc-fast-paths first.
---

# Looking, clicking and typing (last resort)

`D=/mnt/c/Users/you/PROJECTS/TSRCT/scripts/desk.js`

```
node $D look [--screen N]                       # one PNG per monitor + open windows; open each PNG with Read
node $D click|double|right|move --screen N --x X --y Y
node $D scroll --screen N --x X --y Y --amount -5      # negative = down, positive = up
node $D drag --screen N --x X --y Y --to-x X2 --to-y Y2   # press, travel, release (same monitor): drag-and-drop editors, sliders
node $D type --text "..."     (or --text-file F)
node $D key --keys ctrl+s     # enter, tab, esc, alt+tab, ctrl+l, pageup, pagedown, f5 ...
```

- X/Y are pixels of THAT monitor's PNG at full size. If Read shows it smaller ("multiply by K"), multiply.
- Every action looks again by itself and returns the new PNGs and `front` (the window in front). Read them before the next step.
- A click needs a look of the last 60 s that included that monitor. Typing needs the right window in front:
  check `front` first (never TSRCT, never another session, never one of his files that has nothing to do with the task).
- Inside a program, a keyboard shortcut beats a click: check pc-shortcuts first
  (`node $D shortcut --list`), and the program's own (Ctrl+F to find, Ctrl+L for the address bar, Esc to close a menu).
- Read a long chat or document by scrolling (`key --keys pagedown` or `scroll`) until the end, then explain it.
- Stop and ask before anything that cannot be undone: send, publish, pay, buy, delete, submit, accept, save over a file, close without saving.
- Leon moving the mouse pauses you while he moves it; when the answer says he stopped, look again and go on.
- 3 tries without success: stop and say what you saw.
