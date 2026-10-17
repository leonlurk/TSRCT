---
name: pc-open
description: Open a program, a file, a folder or a web page on Leon's PC, bring an open program to the front, show a file in its folder, or find the files a session just wrote. Use instead of the Start menu, the taskbar or the File Explorer.
---

# Opening things without the mouse

`D=/mnt/c/Users/you/PROJECTS/TSRCT/scripts/desk.js`

```
node $D focus --window spotify        # already open (even minimized): restore + bring to front; not open: launches it
node $D open --app "Spotify"          # launch from the Start menu's own list (no clicking Start)
node $D open --path /mnt/c/Users/you/Downloads/report.pdf     # opens in its default program
node $D open --reveal /mnt/c/Users/you/Downloads/report.pdf   # opens the folder with the file selected
node $D open --url https://app.clickup.com/t/86abc              # a page in his browser
```

- Paths are WSL paths (`/mnt/c/...`); Windows paths (`C:\...`) work too.
- To FIND a file: shell commands into a file in your scratchpad, then python3 to filter. Never the Explorer.
  Common places: `/mnt/c/Users/you/Downloads`, `/mnt/c/Users/you/Desktop`, `/mnt/c/Users/you/Documents`,
  his projects under `/mnt/c/Users/you/PROJECTS/`.
- To MOVE or COPY: `mv` / `cp` (never overwrite: check first that the target does not exist).
- After `open`, the program may appear on either monitor. Do not look unless the task continues inside it.
- A ClickUp task, a Slack message, a Salesforce record: open its URL directly instead of navigating to it.
