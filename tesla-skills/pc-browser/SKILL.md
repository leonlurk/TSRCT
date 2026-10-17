---
name: pc-browser
description: Do web work (an online course, Salesforce or the ShopLine Academy in a browser, a web form, reading a site) in a SEPARATE headless browser that Leon watches live in TSRCT's Projector window, without touching his mouse. Use for browser_task; never for his own logged-in Chrome.
---

# The separate browser (Projector)

`P=/mnt/c/Users/you/PROJECTS/TSRCT/scripts/projector.js`. Write the full path every time and run each command
EXACTLY as written: no `cd`, no `&&`, no `&`, no `| head`, no `> file`, no `2>&1`.

```
node $P start                      # opens YOUR browser (1280x800), registered under this tmux session
node $P open https://...           # go to a page
node $P look                       # prints a PNG path: open it with Read (look --full = whole page)
node $P read                       # url, title and the page text (cut at 20000 chars)
node $P find "Guardar"             # buttons, links, fields matching the text, each with x,y
node $P click 640 400              # or: click text=Guardar | click css=#save
node $P dblclick 640 400           # rightclick too
node $P type "texto"               # where the cursor is: click the field first
node $P key Enter                  # Tab, Escape, Control+A, Shift+Tab ...
node $P drag 120 300 700 340       # a real drag: works for drag-and-drop editors (App Builder) too
node $P drag 120 300 700 340 --synthetic   # last resort only, if the real drag does nothing
node $P scroll 600                 # negative = up
node $P upload "text=Upload Files" /path/theme.zip   # clicks the button and answers the file picker
node $P upload css=input[type=file] /path/theme.zip  # or fills the file input directly (even a hidden one)
node $P upload /path/theme.zip     # the page's only file input
node $P download https://github.com/.../archive/refs/heads/main.zip   # a PUBLIC file -> prints where it saved it
node $P back | reload | tabs | tab 1 | status | stop
```

- X/Y are page pixels of the 1280x800 view, the same numbers `find` prints. `look` shows exactly that view.
- `find`, `text=` and `css=` search every frame (Salesforce Setup, embedded forms) and open shadow roots, take only
  VISIBLE elements, and prefer the button itself over the box around it. `inFrame: true` = inside an iframe; its
  x,y is already a page position.
- After every step that changes something: `look` or `read` to confirm it happened. 3 failed tries: stop, say what you saw.
- **Passwords:** never type them, never look for them. At a login page stop with RESULTADO ok:false and
  "dijo": "Entra con tu usuario en el proyector y avisame". He clicks the picture in the Projector window and
  types. The browser remembers the login next time (its own profile, separate from his Chrome).
- **Ask before** anything that cannot be undone: send, publish, pay, buy, delete, accept terms, submit a form or a
  graded step. If the task already says to submit, that is his yes.
- The restricted project (only on AWS Bedrock): the tool refuses it. Stop and say you cannot go on there.
- Do not `stop` the browser when you finish: he may want to look at it. It closes by itself when this session
  ends or after 3 hours unused.
- Every command gives up after 90 s. A page that is slow: `look` again before calling it broken.
