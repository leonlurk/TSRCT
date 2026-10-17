# TSRCT cleanup plan

Measured 2026-10-16 (repo-prime). Nothing here has been executed. Each phase is approved
separately, ships alone and is checked against the same baseline.

## Where it stands
- **89,951 lines** across 154 source files and 15 test files. **Zero npm dependencies** and no build step, both on purpose.
- **Two god files:** `src/js/desktop.js` is 8,827 lines and `server.js` is 8,765. Inside `server.js`, `handleAPI` is one function of **4,838 lines**.
- **46 functions run over 80 lines.** The next ones after `handleAPI` are `buildPCLayout` (606 lines), `rdVrRender` (579), `handleDispatcherRoute` (562) and `askTurn` (463).
- **There are 22 check scripts, but `npm run check` stops at the first red.** Today `check-automations` fails 4 of 86 on its Wednesday date tests, so the 9 checks after it never run.
- **Tooling:** no linter, no formatter, no `.editorconfig` and no pre-commit hook.
- **Precondition:** 65 files are uncommitted. They have to be committed before P0 starts, so that every phase can be reverted cleanly.

## P0 - Safety net (nothing else moves until this is green)
**Done 2026-10-16.** `npm run check` now runs `scripts/check-all.js`: 23/23 green, every check runs
even after a red one. #1 was a test bug, not a date bug: `register()` stamps `firstSeen` with the
real clock, so once today passed the test's September dates the missed Monday read as "before the
job existed". `scripts/check-routes.js` pins 257 routes (`routes-baseline.json`, `--update` to
record new ones) and the auth gate; both red cases were proven on a copy of `server.js`.

| # | What | Where | Why | Risk | Verified by | Size |
|---|---|---|---|---|---|---|
| 1 | Fix the 4 scheduler date tests (they depend on the day the suite runs) | `scripts/check-automations.js` | Today they are red on a Wednesday, and because the chain stops there, 9 checks are silently skipped | low | The test passes with the clock pinned to every weekday | S |
| 2 | Run all checks every time and fail at the end (`scripts/check-all.js`, called by `npm run check`) | `package.json` | `&&` chaining hides every check after the first red one | low | It reports 22 results, and exits non-zero if any fail | S |
| 3 | Route inventory check: extract every `/api/...` literal that `handleAPI` and `handleDispatcherRoute` answer, and save the list | new `scripts/check-routes.js` | P2 moves about 230 routes. Without this, a route dropped while moving is only found by a user | low | It is red if the list shrinks or a route skips the auth gate | M |
| 4 | Auth-gate check: no `/api/*` route answers before the auth block, except the documented exceptions (`/api/health` and `/session/{id}/refresh`, both local-only) | `scripts/check-routes.js` | Splitting `handleAPI` is exactly how a route ends up in front of the gate | low | It goes red on a planted route | S |

## P1 - Hygiene (zero behavior change)
**Done 2026-10-16**, 23/23 green. #5: 34 dead `//console.log` lines and the 5 `if` blocks they left
empty (all side-effect-free) removed from the HF code, deletions only. #6: the two `.bak` files
deleted; `.tsrct-boot.log` stays, the launcher writes it. #7: the 14 video renders in `out/` deleted
on his word (12 GB; the original phone videos are in `Downloads/De Carla`), images and test sheet kept. #8: only the
`hermes.js` pair merged (`spokenText()`). The other pairs stay: `handson`/`plainBrief` are six
lines each carrying their own reason, `codemapEngine` is one sync and one async walk (merging
changes behavior), and the two `clickupAnalyst` job payloads are different jobs that share fields.

| # | What | Where | Why | Risk | Verified by | Size |
|---|---|---|---|---|---|---|
| 5 | Delete the dead `//console.log` lines in the HF claude finder and the SSE emit | `server.js:2041-2124` | 39 commented-out lines; git keeps the history | low | Baseline checks pass | S |
| 6 | Remove the stray local files (`logo.ico.bak`, `.tsrct-clients.v1.json.bak`, `.tsrct-boot.log`) | repo root | They are already ignored, so this only removes clutter | low | `git status` is unchanged | S |
| 7 | Decide what happens to `out/` | `out/` | It holds **about 12 GB of video renders**. It is ignored, but it sits inside the repo folder | none (disk only) | Leon decides | S |
| 8 | Merge the copy-pasted helpers (5 pairs) | `lib/handson.js:43` = `lib/plainBrief.js:51`, `lib/dispatcher/hermes.js:344/413`, `codemapEngine.js:107/239`, `clickupAnalyst.js:388/484` | Two copies of the same rule drift apart | low | Baseline checks pass | S |

## P2 - Structure (cut and paste first, one seam per commit)
**Partly done 2026-10-16**, 23/23 green after every commit, plus a headless-Chrome load test of the real page
at desktop width (no uncaught errors, the moved functions on `window`, PC layout built).
- **#9 done in place:** `handleAPI` 4,838 -> 85 lines: the gate, then 15 named route groups called in the
  original order (`NOT_MINE` sentinel). Cut by an acorn script, verified token for token (nothing lost,
  every added token is a wrapper) and by scope (no group reads a name it lost). The move into
  `lib/routes/*.js` files is **not** done: each group needs 8-31 server names, several of them mutable
  (`TMUX_SESSION`, `dispatcher`, the VNC proxies), so the file move costs real behavior risk for little
  more gain. `check-routes` now also requires `handleAPI` to stay under 150 lines.
- **#10 not worth it:** `handleDispatcherRoute` is already a flat list of 45 short routes (longest 82 lines).
- **#11 four seams moved** (`desktop.js` 8,827 -> 5,524): `desktop-git.js`, `desktop-runners.js` (with
  nano mode, which calls runner functions directly), `desktop-attach.js` (gallery + files + runner and
  org attach, which share selection state), `desktop-notes.js`. Each loads BEFORE `desktop.js` and the two
  reach each other only through `window.*`, which a bare call falls back to, so no call site changed.
  Left in place: the split view (~2,200 lines) shares six mutable values with the session sidebar, so a
  cut there means rewriting how that state is shared.
- **#12 done:** `remote-desktop-vr.js` (2,385 lines) is its own ES module; the two import each other.
  It is evaluated first, and the splitter refused to write while any top-level line of it read the
  other module or either side wrote a binding it imports. The three writes from the VNC side now go
  through `rdVrSetTerminalMode` / `rdVrInsertAtCursor` (same lines, moved). Load test passes;
  **not tried in the headset.**
- **#13 done:** `askTurn` 463 -> 227 lines. The decision part (yes/no, missing argument, fast path,
  Haiku, chooser) is `decideTurn()`, unchanged: it set only `acted`/`haikuReply`/`fast` and never
  returned. The SecretCo guards stay in `askTurn`, where check-restricted reads them.
- **#14 nothing safe to do blind:** a real CSS parse finds **0** exact duplicate rules in any file. The
  56 repeated blocks are shared declarations under different selectors; merging them moves a rule in the
  cascade, which needs screenshots of each surface while logged in.
- Found while doing it: **check-desk is flaky** (3 "hands is waiting on a permission" checks failed once
  in the full suite, then 178/178 twice alone and in the next full run). Not caused by this work.

| # | What | Where | Why | Risk | Verified by | Size |
|---|---|---|---|---|---|---|
| 9 | Split `handleAPI` into route modules by prefix (`/api/git`, `/api/talk`, `/api/studio`, `/api/desk`, `/api/fs`, `/api/null`, `/api/scheduler`, ...). The auth gate and the choke points stay in `server.js`, in front of every module | `server.js:3150` | 4,838 lines in one function. It is the most-changed file (24 commits in 90 days), and `MAP.md` sees about 26% of its routes | **high**: a route dropped or put in front of the gate | Checks 3 and 4, check-restricted, and the baseline. One prefix per commit | L |
| 10 | Same treatment for `handleDispatcherRoute` | `server.js:2479` | 562 lines | medium | Same as #9 | M |
| 11 | Split `desktop.js` by surface: layout, split view, runners, keyboard, git panel | `src/js/desktop.js` | 8,827 lines. `buildPCLayout` alone is 606 | **high**: a lost `window.*` export means a dead button | check-handlers, check-ui, new `<script>` tags in `index.html`, `sw.js` assets and a cache bump | L |
| 12 | Move the VR part of `remote-desktop.js` into its own module | `src/js/remote-desktop.js:2912, 4472` | 5,102 lines. `rdVrRender` is 579 | medium | check-handlers, plus a manual VR open | M |
| 13 | Break `askTurn` into named steps. The guards stay where `check-restricted` looks for them | `lib/talk.js:1324` | 463 lines on the path every spoken sentence takes | medium | check-talk (515), check-brain, check-restricted | M |
| 14 | Split `desktop.css` by surface and fold the 56 duplicated blocks into shared rules | `src/css/desktop.css` | 6,560 lines. The same 6-line block is pasted up to 4 times | medium: CSS order changes what wins | Screenshots of each surface before and after, plus a cache bump | M |

## P3 - Consistency
**#15 done 2026-10-17**, proven red before green: 19/19 failing, then 27/27; two design bugs found by
the tests on the way. (1) "never overwrite" was wrong: the running server is the OLD code and keeps
writing the root file after a move, so the newest copy must win (rule rewritten, 3 of 4 new checks red,
then green). (2) the full suite itself moved three real files out from under the running server, so
only `server.js` moves files now (1 of 2 new checks red, then 29/29; the suite was then shown to move
nothing). The three moved files were copied back to the root for the old server; they win at restart
because they are newer. Full suite 25/25.

| # | What | Where | Why | Risk | Verified by | Size |
|---|---|---|---|---|---|---|
| 15 | Put the runtime state in one place. Seven `.tsrct-*.json` files sit at the repo root next to `.tsrct/` and `data/` | root, and the modules that write them | Three homes for the same kind of file. **This changes file paths, so it needs its own approval and a one-time migration** | medium | Each module reads the old path once, then writes the new one; check-layout and check-automations | M |
| 16 | Delete the dead rules in `components.css`, porting the height cap first (gotcha 16) | `src/css/components.css` | It is 74% dead and contains a second `.modal` | medium | Screenshots of the modals | M |
| 17 | Replace the most-used neon colour literals with tokens | CSS | About 390 hardcoded colours; the navy theme is about 60% real | low | Screenshots | M |

## P4 - Tooling (no new runtime dependencies)
**Done 2026-10-16**, 24/24 green. #18 `.editorconfig` holds only what the tracked files already all do
(measured; a first draft said CRLF for .ps1 and 4 spaces for JSON, and both were wrong). #19
`check-syntax` parses all 148 .js files without running them; it found that **`node --check file.js`
exits 0 on a broken ES module**, so modules go through `node --input-type=module --check` on stdin
(three red cases proven). #20 `npm run hooks` installs a pre-commit hook running `npm run check:fast`
(everything but check-brain, ~15 s); `git commit --no-verify` skips it.

| # | What | Where | Why | Risk | Verified by | Size |
|---|---|---|---|---|---|---|
| 18 | Add `.editorconfig` (4 spaces, LF, final newline) | root | 15 files have no final newline, and line endings are mixed under Windows | low | none needed | S |
| 19 | Syntax check: `node --check` over every `.js` file, as one of the checks | `scripts/check-all.js` | It catches a broken file before a restart does, with zero dependencies | low | It goes red on a planted typo | S |
| 20 | Git pre-commit hook that runs `npm run check` | `.git/hooks` (installed by a script) | There is no CI, and one machine does not need CI | low | A commit with a red check is refused | S |

## P5 - Docs
**Done 2026-10-16, except #22.** #21: `DOCUMENTATION.md` 3,550 -> ~3,000 lines. The old §§2-9 are
replaced by a §2 that points to where each answer lives (CLAUDE.md, MAP.md, `routes-baseline.json`,
this plan, the vault); the three current blocks of the old §6 (auth/WebAuthn, SecretCo security,
single-monitor view) are kept verbatim; §1's deleted features (neural network, QR/OCR rooms, ntfy.sh)
are corrected; the "zero dependencies" header is true again. #22: only stale facts fixed in
`CLAUDE.md` (cache `v417`, server size and the route-group rule, the new files in the load order,
the VR module rule, the section pointers). **Slimming it is Leon's call**: it is loaded into every
session, so moving text out changes what every session knows. #23: `MAP.md` regenerated (160 files,
3,257 symbols). It still skips most of `server.js`, a limit of the generator, not of this repo.

| # | What | Where | Why | Risk | Verified by | Size |
|---|---|---|---|---|---|---|
| 21 | Delete or rewrite `DOCUMENTATION.md` §§2-9 | `DOCUMENTATION.md` | CLAUDE.md itself calls them "pre-refactor and partly fictional". Stale docs are worse than none | low | none needed | M |
| 22 | Slim `CLAUDE.md` down to rules and pointers. The feature detail (Tesla, desk, projector, ...) moves to `DOCUMENTATION.md` | `CLAUDE.md` | It is loaded into every session, and its counts are already stale (`v411` vs `v412`, "21 scripts" vs 22) | low | none needed | M |
| 23 | Regenerate `MAP.md` after P2 | `MAP.md` | Once routes live in modules, the extractor will see them | low | none needed | S |

## Kept on purpose
- **SecretCo choke points** (`gitCwd`, `sfAlias`, `submitJob`, the guards in `talk.js`). They look redundant, and they are the contract.
- **`/api/output` stays open to the `secretco` pane.** That is the sanctioned SecretCo workflow (CLAUDE.md).
- **Zero npm dependencies and no build step.** Hence no ESLint or Prettier package; P4 uses only what Node already has.
- **Inline `onclick` plus `window.*` exports.** This was the Phase 3 decision of 2026-06-15; check-handlers guards it.
- **345 `console.log` lines with `[tag]` prefixes.** They are the server's real log, not leftover debugging.
- **Non-ASCII text.** It is Spanish UI text and the box characters in the pane-reading regexes.
- **The long "why" comments.** They are the scars this repo learned from; the hygiene scan flags them as "AI tells" because they mention Claude.

## Not worth it
- A framework, a bundler, TypeScript or ES modules everywhere.
- A logging library in place of the tagged `console.log` lines.
- CI on a hosted service, or a LICENSE file (private, single-machine app).
- Splitting the long check scripts (check-talk is 1,075 lines). Long test files are fine.

## Round 2 (2026-10-17): the rest, red before green
Every item below started as a check that was run and seen failing for the right reason, then the change,
then the full suite. The CSS/JS changes were also compared as computed styles: a local proxy served one
exact version of the frontend at a time (read-only `/api` forwarded to the live server, non-GET refused,
logged in with the master token from this machine), every visible element's computed style was recorded
on all 11 PC panels and 8 mobile views, and each version was compared with the one before it, one change
apart, against a same-version repeat to measure live-data noise.
- **Flaky check-desk fixed.** Three checks judged a 15 ms poller at a fixed 400 ms; on a busy machine the
  poller was late. Reproduced with a 250 ms poller: old version 3 failing, new 178/178.
- **#15 state files** - see P3.
- **#16 dead CSS.** `components.css` was already pruned (2026-08-15). The rest of the tree had 100 rules no
  page code can produce (deleted TOWER panel, old rooms list, an earlier git folder picker, utility
  classes). New `check-css`: red 100, then 0; 531 lines deleted, 0 added.
- **#11 split view.** Sessions sidebar + split view + drag and drop moved together to
  `desktop-sessions.js` (they share six mutable values, none crosses files now); 4 private functions
  exported. New `check-size` ratchet: red 1/6 (desktop.js 5,525 > 3,100), then 6/6; desktop.js 2,864.
- **#17 colour tokens.** New `check-colors`: red 287 literals that equal a palette token, then 0. The
  style comparison then caught a real change the check had caused: three CUSTOM PROPERTIES in
  rooms-base.css (`--room-secondary: #00d4ff` -> `var(--cyan)`) resolve where they are used, so the
  NULL and Catalog rooms, which define their own navy `--cyan`, turned navy in the default theme. The
  check was wrong; it now skips `--x:` definitions, and those three lines are back to their literals
  (284 replacements remain). Under navy and eye-protect the replaced colours now follow the theme,
  which is the fix.
- **#14 desktop.css split** into six files linked in the original order; rejoined byte for byte (150,688
  characters). `check-size` ceiling 2,100: red, then green.
- **#22 CLAUDE.md** 527 -> ~345 lines. The 248-line Tesla/clock write-up moved word for word to
  DOCUMENTATION.md §9o; CLAUDE.md keeps a rule list. New `check-docs`: red 3/18 (too long, no pointer, no
  §9o), then 18/18; its 15 must-keep rules were green throughout on purpose.

## Round 3 (2026-10-17): the last stretch - no function over 150 own lines
New `check-functions` (own lines = a function minus the functions nested in it; a browser file's module
wrapper is exempt): red 11, then 0 across 4,354 functions. `server.js` 8,827 -> 3,571 lines.
- **Route groups into `lib/routes/`** (15 files + `dispatcher.js`), each route its own small function,
  tried in the old order. `S` (built in server.js) carries the shared state; anything the server changes
  over time is always read as `S.<name>`. Proven by an old-vs-new harness: every one of the 257 known
  addresses (regex routes included) x GET/POST/PUT/DELETE, against a recording stand-in server, with
  request `end` callbacks fired and timers disabled: identical on every file (976-1,024 cases each).
- **Two tools of mine were wrong and are fixed**: my scope resolver read the key in `{ path: target }`
  as a declaration, and TypeScript in JS mode stays silent about a name declared ANYWHERE in the file.
  Together they hid one real bug: POST /api/cwd (the project switcher) lost the `path` module in the
  move. A correct resolver (bindings only) found exactly that one; fixed before any restart.
- **check-restricted could pass on nothing**: after the move it read "0 /api/git/* routes, 0 guarded" and
  stayed green. It now has a floor (18) and reads server.js + lib/routes (`scripts/serverSource.js`).
- **Boot** split into one `startX(loops)` per subsystem; `[READY]` still printed last.
- **Tesla**: no check drove a turn through the Haiku brain or the local chooser (both could be broken
  with every check green). New `check-turns` does, with stand-in brains; proven by breaking each moved
  function in turn (3, 3, 3 and 2 checks go red). Then `decideByHaiku`, `decideByChooser`,
  `composeReply`, `rememberTurn` out of `decideTurn`/`askTurn`.
- **Browser**: `handleGlobalKeydown` -> `handleAppShortcut` + `handleQuickKeys` (old vs new on 3,776
  key x modifier x typing x permission-banner cases: identical, 762 of them doing something);
  notifications `render` -> six card functions (identical HTML on 3 fixtures); `rdVrRender` -> eight
  drawing steps (identical canvas call sequence on 4 fixtures, clock frozen). Each harness was first
  shown to catch a one-token change.
