---
name: pc-fast-paths
description: Read FIRST for any task on Leon's Windows PC. Picks the fastest way to do it (a direct command, never the mouse when there is another way) and points to the skill for each kind of task.
---

# PC fast paths: which tool for which task

Leon's rule: *"toda tarea que se pueda hacer mas rapido o eficiente evitando el uso fisico del mouse, que se haga."*
Every command below is `node /mnt/c/Users/you/PROJECTS/TSRCT/scripts/desk.js <op> ...`. Run it EXACTLY like
that: no `cd`, no `&&`, no `&`, no `| head`, no `> file`, no `2>&1` (any of those stops you on a permission card).

## Decide in this order (stop at the first that fits)

| He wants | Do | Skill | Time |
|---|---|---|---|
| Open a program, file, folder or web page | `open --app X` / `open --path P` / `open --url U` | pc-open | ~1 s |
| A program that is already open, in front | `focus --window X` | pc-open | ~1 s |
| Move, resize, maximize, minimize a window, other monitor | `place --window X --where "..."` | pc-windows | ~1 s |
| Only one window visible | `solo --window X` | pc-windows | ~1 s |
| What windows are open, on which monitor | `windows` (no screenshot) | pc-windows | ~1 s |
| A whole work mode ("modo trabajo") | `layout --restore NAME` | pc-modes | 2-4 s |
| Save how the screen is now | `layout --save NAME` | pc-modes | ~1 s |
| Zones of a monitor | `zones --layout columns --screen 2` | pc-modes | <1 s |
| Desktop, task view, clipboard, screenshot, tabs, Slack unread... | `shortcut --name "..."` | pc-shortcuts | ~1 s |
| A Slack channel or person, a file in VS Code, find text in a page | `routine --name "..." --what "..."` | pc-shortcuts | ~2 s |
| A Windows Settings page | `settings --page sonido` | pc-shortcuts | ~1 s |
| Search Spotify | `spotify --query "..."` | pc-shortcuts | ~1 s |
| Music and volume | `media --keys playpause` | pc-media | instant |
| Something INSIDE a program with no shortcut (fill, click a button, read) | `look`, then click/type | pc-mouse | 20-60 s |

Find a file with shell commands (`find`, `ls` to a file, then python3), move or copy it with `mv`/`cp`.
Never with the File Explorer and the mouse.

## Always
- After opening or arranging, do NOT look again unless the task needs to read the screen.
- If a command answers `refused`, stop: there is no other way, and you never try one. Say why in one sentence.
- If it says Leon moved the mouse and stopped: look at the screen again (`look`) and continue the task from where it is now.
- If it says Leon took the mouse (he kept moving it for a minute): stop at once, report how far you got, do not retry.
- Anything that sends, deletes, pays, publishes, accepts or overwrites: ask first
  (end with RESULTADO ok:false and the exact question in "dijo").
- The restricted project (the one that only runs on AWS Bedrock): never touch its windows; if a task is about it, stop and say so.
- Your answer to him ("dijo") is one short line: the result, never how.

## A path that is missing
If a task needed the mouse but could have been a shortcut, a link or a command, write it in "falta" of your
RESULTADO (for example `falta: atajo "nueva carpeta" en el explorador`). That is how the next review adds it.
