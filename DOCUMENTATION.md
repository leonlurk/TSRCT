# TSRCT - Tesseract Remote Control Terminal
## Complete Codebase Documentation

> **How to read this file (2026-10-16).** §1, the dated feature write-ups (§§9b-9n) and §14 "Known
> Gotchas" are current. §§10-13 and 15-17 are older and partly stale; check them against the code.
> The old §§2-9 (tech stack, architecture, directory tree, file table, route tables, frontend
> module map, CSS, rooms) were deleted on 2026-10-16 (cleanup P5 #21): an audit had found most of it
> wrong, and hand-written inventories rot. §2 below says where each of those answers lives now.
> Git still has the old text.

**Version**: 2.1  
**Type**: Zero-dependency Node.js PWA for remotely controlling Claude Code sessions via tmux (`@slack/bolt` went with the Slack half, 2026-09-19)  
**Last Updated**: 2026-10-16 (§§2-9 replaced by §2, cleanup P5)  
**Author**: leonlurk (Claude Code assisted)

---

## 1. Overview

TSRCT (Tesseract Remote Control Terminal) is a sophisticated remote control system that allows you to monitor and interact with Claude Code sessions running in tmux from any mobile device or computer. It bridges the gap between long-running AI coding sessions and real-time mobile interaction, providing:

- **Real-time terminal output** streaming from tmux sessions
- **Remote prompt sending** with vault-aware augmentation
- **Permission management** for tool access (Bash, Edit, WebFetch, Grep, etc.)
- **Hands-free immersive mode** for voice-controlled Claude interactions
- **Rooms on mobile, surfaces on desktop** (runners, Salesforce CLI, Studio, Catalog, NULL, automations, ...; the live list is in `CLAUDE.md`)
- **Desktop mode** for advanced keyboard-driven workflows (when viewport >= 900px)
- **Service worker caching** for offline-capable PWA installation
- **Push notifications and calls** via a self-hosted ntfy and Web Push (`lib/ring.js`)
- **Tesla**, the voice assistant (the orb), with eyes and hands on the PC and a separate browser (the projector)
- **Git controls** and time travel (commit history inspection)
- **VNC remote desktop proxy** for controlling your PC screen, with a VR (cardboard) mode

### Why It Exists

When running Claude Code for hours at a time, you often need to:
1. Leave your desk but stay responsive to Claude's prompts
2. Approve/deny permissions without being at the terminal
3. Send follow-up commands from your phone
4. See what Claude has produced without SSH-ing

TSRCT solves this by creating a mobile-friendly interface that talks to your Claude session in real-time via a simple Node.js bridge server.

---

## 2. Where the answers live now

The old §§2-9 tried to list everything by hand and drifted within weeks. Each answer has a source
that is either generated or checked:

| Question | Where |
|---|---|
| Architecture, script load order, rooms vs surfaces, conventions, the SecretCo contract | `CLAUDE.md` |
| Which function / `window.*` export / onclick handler is where (`file:line`) | `MAP.md` (regenerate with the `repo-map` skill) |
| Every `/api/*` route | `scripts/routes-baseline.json` (kept honest by `scripts/check-routes.js`) |
| Which route group answers a route | `server.js`: `handleAPI` is the auth gate plus 15 `api*` route groups, matched in order |
| The desktop (PC mode) code | `src/js/desktop.js` plus `desktop-git.js`, `desktop-runners.js`, `desktop-attach.js`, `desktop-notes.js` (loaded before it, joined through `window.*`) |
| Remote desktop and VR | `src/js/remote-desktop.js` and `remote-desktop-vr.js` (ES modules that import each other) |
| What is being cleaned up and why | `docs/CLEANUP-PLAN.md` |
| Why a thing is the way it is | the vault: `wiki/decisions/TSRCT.md`, `wiki/TSRCT Invariants.md` |

The three blocks below were the current parts of the old §6 and are kept as they were.

### Authentication (2FA)

Every API endpoint requires authorization; the gate runs first in `handleAPI()`.
The model splits **remote** (through the Cloudflare tunnel) from **local** (hooks):

- **Remote callers must present a session token from a 2FA login.** Login
  (`POST /api/auth/login`, body `{token, totp, remember}`) requires the master
  `BRIDGE_TOKEN` **plus** a 6-digit TOTP code (RFC 6238). Success returns a
  short-lived **session token** (12h) sent thereafter as `Authorization`. The
  master token alone is rejected over the tunnel.
- **Local callers (hooks)** may use the master `BRIDGE_TOKEN` directly. Local vs
  remote is detected by Cloudflare headers (`cf-ray`/`cf-connecting-ip`), which
  only tunneled requests carry; combined with binding to `127.0.0.1`, the only
  remote path is the tunnel, so "local" can't be spoofed.
- **Trusted-device fast path:** `remember` issues a 30-day device token
  (`POST /api/auth/refresh` exchanges it for a fresh session) so the phone skips
  TOTP after first enrollment. Survives server restarts (sessions are in-memory).
- **Rate limiting:** 5 failed logins per IP → 15-minute lockout.
- TOTP secret + devices live in `.tsrct/auth.json` (gitignored). The secret is
  printed once on first run; also retrievable locally via `GET /api/auth/enroll`.

Public exceptions (no session needed): `GET /images/*` (img tags; path
sanitized), `GET /api/hf/output/*` (SSE, validates `?token=`), and the auth
bootstrap endpoints `/api/auth/login` and `/api/auth/refresh`.

```
Authorization: <session-token>     # remote, after 2FA login
Authorization: <BRIDGE_TOKEN>      # local only (hooks)
```

> History: app-layer 2FA is a strong **plan B** while a real edge gate
> (Cloudflare Access on a named tunnel) is set up. It stops URL-discovery,
> brute-force, and single-secret leaks, but the server stays internet-reachable,
> so code-level exploits / DoS are only removed by edge auth. Earlier (same day)
> several endpoints were fully unauthenticated; that was closed first, then 2FA
> layered on top. ntfy push is disabled.

#### Windows Hello / WebAuthn (2026-08-13) -- PRIMARY login path

A platform passkey is possession (a TPM-bound key) + user verification (face or
PIN) in one gesture, i.e. both factors, so it REPLACES `BRIDGE_TOKEN` + TOTP.
TOTP remains as the fallback -- a covered camera must never lock the owner out.

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/auth/webauthn/register/options` | Challenge for `credentials.create()` | Yes |
| POST | `/api/auth/webauthn/register/verify` | Store the new credential | Yes |
| POST | `/api/auth/webauthn/login/options` | Challenge + allowCredentials for this origin | No (bootstrap) |
| POST | `/api/auth/webauthn/login/verify` | Verify assertion -> session (+ device token) | No (bootstrap) |
| GET | `/api/auth/webauthn/credentials` | List enrolled credentials | Yes |
| DELETE | `/api/auth/webauthn/credentials` | Remove one by `{id}` | Yes |

Enrolment sits BEHIND the auth gate (you must already be logged in to add a
face); only the login pair is public, which is safe because it emits nothing but
a random challenge and verifies against an already-enrolled key.

**Zero-dependency, and the two facts that make it possible.** `authData` is a
fixed-layout buffer -- `rpIdHash[32] flags[1] signCount[4]` then, when the AT
flag (`0x40`) is set, `aaguid[16] credIdLen[2] credId[] COSEkey` -- so it is
sliced by hand; only the COSE key and the attestation wrapper need CBOR (~40
lines). And **`crypto.createPublicKey({key: jwk, format: 'jwk'})` takes a JWK
directly**, which removes the hand-rolled DER/SPKI encoding of raw EC
coordinates that makes most from-scratch implementations painful. Verification
is then one `crypto.verify('sha256', authData || sha256(clientDataJSON), ...)`
for both algorithms, because node's defaults already match the spec (ECDSA ->
DER, RSA -> PKCS#1 v1.5).

**Both ES256 (-7) and RS256 (-257) are advertised in `pubKeyCredParams` and
handled in `coseToJwk`**, because the algorithm a Hello/TPM stack picks is not
knowable in advance. This machine enrolled as ES256 (`alg -7`, `kty EC`);
Windows Hello is widely reported to issue RS256 elsewhere, and supporting only
one fails with an opaque enrolment error on the other.

**Credentials are ORIGIN-BOUND.** Each stored credential carries its own `rpId`
and `origin`; at login the expected values come from the STORED credential, never
from the caller, and `login/options` only offers credentials matching the
requesting origin. So a key enrolled at `<machine>.<tailnet>.ts.net` is invisible
at `localhost:3847` and needs its own enrolment -- the launcher must keep opening
the same URL. Same origin-scoping that killed the 30-day device path when the
Cloudflare hostname rotated.

Challenges are one-shot (consumed by the first attempt, success or failure, so a
captured assertion cannot be replayed) with a 2-minute TTL. Failed assertions
feed the existing per-IP lockout. **`signCount` clone-detection is deliberately
lenient**: Windows Hello reports 0 forever, so zero proves nothing and only a
real counter that fails to advance is rejected.

The auth card ships with the 2FA form VISIBLE and reveals the Hello button only
after the server confirms an enrolled key for that exact origin, so a JS failure
degrades to the old login rather than to a lockout. Front end: `src/js/webauthn.js`.

#### Sessions are an IDLE window, not a lifetime (2026-08-13)

`SESSION_TTL_MS` (12h, `SESSION_IDLE_HOURS` overrides) is now refreshed by every
authorized request in `validSession()`. It used to be an absolute deadline set at
login, so an actively-used desktop was logged out mid-work at exactly 12h. The
desktop polls every 5s, so an open tab stays signed in indefinitely; an abandoned
one still expires.

Three related fixes shipped with it. A 401 during polling now tries the 30-day
trusted-device fast path before falling back to the login form (only `connect()`
did this before, so the fast path was skipped at the one moment it mattered).
`tryDeviceLogin()` is single-flight, because `poll()` (5s) and `pollPerms()`
(500ms) see the same 401 and would otherwise mint two sessions. And
**`/api/auth/logout` is now a bootstrap route**: it is self-authorizing (it only
deletes the token the caller presents) and it must work when the session is
ALREADY dead -- otherwise the revoke 401s, the client forgets its device token
anyway, and the server keeps an orphan row for 30 days. That was the source of
the 58 stale devices purged on 2026-08-11.

#### SecretCo security — `(removed)` (2026-06-25)

**The problem.** The `sf` CLI hardcodes its auth store to `$HOME` (`@salesforce/core/global.js`: `~/.sfdx` + `~/.sf` derived from `os.homedir()`, **no env override**). Every process under `HOME=/home/user` shares all logged-in orgs. So if an **SecretCo** org is authenticated normally, any **non-Bedrock** Claude session (TSRCT home session, runners, auditors) can `sf data query -o secretco` via the shell → SecretCo data reaches the public Anthropic API = **contract breach**. TSRCT code guards can't stop this (OS-level shared credential). Note also: the desktop **"attach org"** feature injects `sf data query -o <alias>` instructions into prompts (`main.js:1591-1598`), and the whole `/api/sf/*` subsystem currently has **no `restrictedGuard`** — so SecretCo must be kept out of it entirely.

**The fix — `(removed)`** (in repo root): isolates `$HOME` so the SecretCo org never touches `/home/user`.

**How to use it:**
1. In TSRCT open a **runner** (or any terminal) and run the **full path** (the script lives in `TSRCT/`, not `PROJECTS/`):
   `/mnt/c/Users/you/PROJECTS/TSRCT/(removed)`
2. **Complete the browser OAuth login** for the SecretCo org (a browser opens; finish the Salesforce login).
3. The script launches **Bedrock Claude** (`CLAUDE_CODE_USE_BEDROCK=1`) in `SecretCoSandbox/`, inside a tmux session **named `secretco`**.
4. In TSRCT's **session list, click `secretco`** to target it. Type prompts there — that Claude queries the org with `sf data query -o secretco -q "<SOQL>" --json`.
5. **When done, kill the `secretco` session** (TSRCT kill button or `tmux kill-session -t secretco`). The script then **auto-revokes the token and `rm -rf`s the isolated store**. Nothing is left in `/home/user`.

**Why it's safe:** isolated `$HOME` (`~/.secretco-ephemeral`, with `.claude` symlinked so config/MCP survive) → no non-Bedrock session can see the org; session named `secretco` → `restrictedGuard` blocks dispatcher/ntfy/cockpit egress; `CLAUDE_CODE_USE_BEDROCK=1` → the AI itself is compliant; `trap EXIT` → Ctrl-C/kill also revoke+wipe.

**Rules:** (1) **Never** authenticate SecretCo through the TSRCT SF CLI room (server runs under shared HOME → token leaks to shared store). (2) **No launch button** — run from a terminal/runner, *drive* from TSRCT. (3) Before running, **close any SecretCoSandbox Claude session running under `HOME=/home/user`** that would query the org (it'd leak the token to the shared store). (4) A "temporary login + logout" into the shared store is **not** cleanly reversible (logs in `~/.sf/sf-*.log`, alias, caches, history persist) — only the ephemeral-`$HOME` route is fully wipeable.

#### Single-monitor view (2026-08-11)

VNC serves the WHOLE virtual desktop as one framebuffer and TightVNC has no
per-monitor mode, so viewing a single screen is a **client-side crop**. The
`[monitor]` toolbar button cycles `all -> 1 -> 2 -> all`; the choice persists in
`.tsrct/vnc-config.json` (`monitor`), **not** localStorage, because localStorage
is origin-scoped and would be lost on any hostname change.

`GET /api/vnc/monitors` shells PowerShell (`Screen::AllScreens`, absolute
`/mnt/c/...` path via `findPowershell()` — a bare `powershell.exe` is not on the
daemon's PATH) and returns each screen's bounds plus the virtual bounding box,
10s-cached. Screens are ordered by adapter number then relabelled `1..N`: Windows
names them `DISPLAY1`/`DISPLAY5` internally but Display Settings shows the user
"1" and "2", and "monitor 1" means what is on that screen.

**The framebuffer is NOT the logical desktop — convert through a ratio.** Measured
here: the logical virtual desktop is 3627x1448 but the VNC framebuffer is
**5440x2172**, because both monitors run at 150% DPI and TightVNC captures
physical pixels. The scale happened to be uniform (x1.5), so
`k = fbW / virtual.w` maps a screen's bounds into framebuffer pixels exactly
(monitor 1 -> `2880,0 2560x1601`, monitor 2 -> `0,552 2880x1620`, tiling the
framebuffer with no gap). Never assume 1:1.

**How the crop keeps input correct:** the canvas element always carries the FULL
framebuffer (scaled); it is absolutely positioned so the wanted monitor lands
inside `.rd-canvas-container` while the rest overflows and is clipped by
`.rd-canvas-wrap`'s `overflow:hidden`. Because the element box still maps 1:1 to
the framebuffer, `rdScreenToVNC()` / `rdCacheCanvasRect()` work unchanged. This
also fixes their latent letterbox bug: both assumed the image filled the element
box, which the old `object-fit: contain` broke whenever the aspects differed
(up to ~9% vertical pointer error on a 2.5:1 desktop). Requires
`rfb.scaleViewport = false` — noVNC's autoscale would overwrite the inline size.
`rdCacheCanvasRect()` re-applies the layout when it sees the framebuffer resize,
which is when noVNC rewrites the canvas style.

> **Related fix:** `POST /api/vnc/config` now MERGES into the stored config. It
> replaced it wholesale, and `rdConnect()` POSTs it on every connect — so each
> connect silently wiped `audioDevice` (and would have wiped `monitor`).
> Read-modify-write callers use `readVNCConfigRaw()`, since `readVNCConfig()`
> resolves `localhost` for the current WSL networking mode and writing that back
> bakes today's IP into the file.

**VR mode is unaffected** and still uses its own `RD_MULTIMON_ASPECT` heuristic,
which assumes 2+ EQUAL monitors split 50/50 — provably wrong for this layout
(2560 vs 2880 wide, 552px vertical offset). Wiring VR to the same crop rect is
open work.

---

---

## 9b. Productivity Dashboard — "Tasks" tab (Increment 1, 2026-06-15)

A **desktop-only** tab (next to Terminal/Neural/Cockpit/Dispatcher; NOT a mobile room) that surfaces ClickUp tasks ASSIGNED to Leon, lets him define each task's *interpretation* (what "done" means), and runs **on-demand** completion analysis. Plan: vault `projects/tsrct-productivity-dashboard.md`.

**Core split — deterministic vs intelligent:**
- **Node server = deterministic only.** It polls the ClickUp REST API + handles the webhook, upserts rows, serves the dashboard API. No reasoning.
- **The `cc-tsrct-analyst` headless Claude session = ALL reasoning.** It judges whether a task is actually done (against the per-task interpretation + repo + vault + `~/.claude/projects/*.jsonl`) and writes a compact verdict. Reuses the promptPolisher job pattern (`jobs/<key>.json` → `claude -p` → `out/<key>.md` → server poll).

**Backend modules (`lib/dispatcher/`):**
- `clickupSync.js` — REST poller. Token from `config.clickup_api_token` (persistent) or `CLICKUP_API_TOKEN`; personal token goes RAW in the `Authorization` header. `start()` polls once at +3s then every `CLICKUP_POLL_MS` (5min). Fetches `/v2/team` then per-team `/v2/team/{id}/task?assignees[]={CLICKUP_USER_ID}`. Upserts each by `clickup_task_id`.
- `clickupAnalyst.js` — on-demand completion analyst. In-memory serialized queue on the `cc-tsrct-analyst` session; outputs `STATUS: complete|incomplete|unclear|skipped` + ≤3 lines, stored as `{status,text,at}` in `analysis_json`. **SecretCo-guarded:** refuses SecretCo tasks before dispatch (stores a `skipped` verdict).
- `clickupHandler.js` (existing webhook) — now ALSO upserts into `clickup_tasks` for real-time updates (same dedup key as the poller).
- `db.js` — EPHEMERAL `clickup_tasks` table. UNIQUE `clickup_task_id` = dedup key, so the startup re-poll never duplicates. The upsert PRESERVES `user_interpretation` + `analysis_json` on conflict (a re-poll never wipes Leon's notes/verdict).

**API routes** (in `handleDispatcherRoute`, auth-gated): `GET /api/dispatcher/clickup/tasks`, `POST .../tasks/sync`, `GET|POST .../config` (GET never returns the token — only `token_configured` + `token_source` (`config`|`env`) + a masked `pk_12345...7f3a` fingerprint; POST **verifies before storing**, see below), `POST .../analyze-bulk`, `POST .../task/:id/interpretation`, `POST .../task/:id/analyze`.

**Frontend:** `src/js/dashboard.js` (IIFE, modeled on cockpit.js; exports `dashInit`/`dashTeardown`/`dashSync`/`dashSaveToken`/`dashSaveInterpretation`/`dashAnalyze`/`dashAnalyzeAll`). Tab + `#pc-tasks-panel` + `pcSwitchTab('tasks')` branch in `desktop.js`. Card CSS `src/css/rooms/room-dashboard.css` (lazy via `loadRoomCSS('dashboard')`); panel layout in `desktop.css`. sw cache → `tsrct-v194`.

**Prerequisites to actually fetch:** a ClickUp personal API token (entered via the Tasks-tab form → stored in `config`, or `CLICKUP_API_TOKEN` env) + `CLICKUP_USER_ID`. The `cc-tsrct-analyst` tmux session auto-creates on first analyze.

**Changing the token (2026-07-28):** the Worklogs sub-view header carries a `[ TOKEN: pk_12345...7f3a ]` button that opens a panel to REPLACE the live token (the first-run setup card only ever appeared when no token was set, so a rotated/expired token could not be swapped from the UI). It lives with Worklogs because that is what the token actually writes. Server-side `POST .../config` now:
1. `clickupSync.verifyToken(candidate)` — `GET /v2/user` + `GET /v2/team` with the CANDIDATE. A rejected token returns 400 and the working token is left in place (never store an unverified token: its downstream failures surface as ClickUp's misleading "you do not have access to this task").
2. stores it, then `clickupSync.resetCaches()` — `cachedTeamId` + `taskTeamCache` are token-scoped, so without this a token change keeps resolving the PREVIOUS account's workspace until restart.
3. re-resolves the worklog workspace with the new token and returns `user` / `workspaces` / `worklog_team` / `warnings`, so the panel confirms *which account* and *which workspace worklogs will land in*, and warns when `CLICKUP_USER_ID` no longer matches the token owner (that env id filters both task sync and the worklog history the analyst learns from).

### Analyst engine (shared across all 3 increments)
`clickupAnalyst.js` is a GENERIC headless-Claude job engine: `submitJob({key,kind,jobData,instruction,onResult,onTimeout,onError,onCancel})` writes `jobs/<key>.json` + `jobs/<key>.prompt.txt`, dispatches `claude -p` on the ONE serialized `cc-tsrct-analyst` tmux session, polls `out/<key>.md`, and hands the text back to `onResult`. Every job kind (completion / worklog / digest / note-route) shares this single queue — never two `claude -p` at once. `--add-dir` grants read access to PROJECTS (vault+repos), `~/.claude/projects` (WSL session logs), and `~/.claude/skills` (the worklog skill).

### Increment 2 — Worklogs (generate → edit → create)
- `worklogEngine.js` — `generate({range_start,range_end,hours_hint})` is async: the SERVER first pulls Leon's last 45 days of real ClickUp time entries (`clickupSync.getTimeEntries`, cap 60) and passes them as `recent_worklogs` in the job. The analyst's STEP 1 LEARNS Leon's patterns from those real entries (comment voice, which task_id each work type maps to, hour splits, billable) — this overrides guesses and is what makes the output sound like him. Then it FOLLOWS `~/.claude/skills/weekly-worklogs/SKILL.md` (mapping table, billable rules, the PHASE 4 comment-style guide embedded verbatim, flat-30m weekday standup, net-hours, SecretCo exclusion, exclude TSRCT/prompt-polisher), reads the local sources (vault + WSL) in parallel for WHAT was done, and emits a STRICT JSON array. Parses → `worklog_proposals` table. **Validated live 2026-06-16** (Sun 06-14 → 3 entries/4.5h created in ClickUp, comments in Leon's voice).
- The SERVER creates each ClickUp time entry on an EXPLICIT `[Create all]` click — `clickupSync.createTimeEntry` (REST `POST /v2/team/{id}/time_entries`, retries transient 5xx/429, IDEMPOTENT: a `created` row is never re-fired). The model never writes to ClickUp.
- Routes: `POST /worklogs/generate`, `POST /worklogs/cancel`, `GET /worklogs`, `POST /worklog/:id` (edit), `POST /worklog/:id/dismiss`, `POST /worklogs/create` (the gate), `GET /clickup/task-lookup?id=`.
- **Cancelling a run (2026-08-11):** a `[ CANCEL ]` button sits next to `[ GENERATE ]` while a batch is in flight (`dashWlCancel`, `confirm()`-gated — it discards however many minutes the analyst already spent, though nothing has reached ClickUp at that stage). `POST /worklogs/cancel {batch_id?}` → `worklogEngine.cancel()` → `analyst.cancelJob(key)`, which pkills the headless `claude` (the batch id is in its argv), sends `C-c` to the pane, releases the one-at-a-time `running` lock and pumps the next job. Two deliberate design points: (1) `cancel()` clears the `generating` flag **unconditionally**, not only when the analyst still tracks the job — a batch the engine already forgot (server restart, orphaned claude) is exactly the case that pins the dashboard on `[ GENERATING ]`; and `cancelJob` still pkills an untracked key for the same reason. (2) The job key becomes the PATTERN of `pkill -f`, so `JOB_KEY_RE` (`/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`) is enforced inside `killJob`/`cancelJob` rather than trusted from the caller — `cancelJob` is reachable from an HTTP route, and a pattern of `.*` would kill the whole session. State gains a `cancelled` flag so the UI shows an amber "nothing was saved" note instead of a red error.

### Increment 3 — Vault digest + note routing
- `digestEngine.js` — `generateDigest(today)`: analyst summarizes ONLY today's vault writes into COMPACT 1-2-sentence items (no full-text dump) → `vault_digests`. `routeNote(noteText)`: analyst proposes a vault destination + the note rewritten in Leon's style (DELIMITED `PATH:`/`RATIONALE:`/`===CONTENT===` output — robust for multi-line markdown, which JSON can't carry) → `note_routes`. On `[Write to vault]` the SERVER writes/appends the `.md` file under a containment guard (`VAULT_ROOT`) + SecretCo guard.
- Routes: `POST /digest/generate`, `GET /digest`, `POST /notes/route`, `GET /notes`, `POST /note/:id/approve` (writes the file), `POST /note/:id/dismiss`.

### Frontend (one desktop tab, four sub-views)
`dashboard.js` renders a sub-nav (**Inbox** | Tasks | Worklogs | Digest) into the single `#pc-tasks-panel`; **Inbox is the default**. `render()` skips only while a TEXT input/textarea is focused (NOT checkboxes/selects — counting those once made session-mapping + multi-select look like they "did nothing"). New ephemeral tables: `inbox_items`, `worklog_proposals`, `vault_digests`, `note_routes`. Token config UI: `renderTokenPanel()`/`renderTokenResult()` + `dashToggleTokenPanel`/`dashSaveToken` (module state `cfg`/`cfgOpen`/`cfgResult`; the browser never receives the token). sw cache (current): `tsrct-v254`.

## 9c. Productivity Dashboard — Unified Inbox + mapped-session analysis + grouping (2026-06-16)

### Unified Inbox ("where I stand") — `[I] Inbox` sub-view, the default
Reconstructs ClickUp's notification firehose (ClickUp has **NO public notifications endpoint**) into one triage feed, 100% deterministic (zero analyst tokens). Per assigned task the poller fetches `GET /v2/task/{id}/comment` and `clickupSync.buildInbox()` emits items for: **@mentions** (a `comment[]` fragment with `type:"tag"` & `user.id===me`, or `type:"group_tag"` whose `user_group.members[]` includes me), **new comments**, **new assignments**, **status changes**, **due/overdue** (from task `due_date`/`priority`).
- Ephemeral `inbox_items` table is FULL-REPLACED each poll (`db.replaceInboxItems` — a render cache, never accumulates). Item identity = stable `item_key` (`c:{commentId}` / `a:{taskId}` / `s:{taskId}:{status}` / `d:{taskId}:{dueMs}`).
- **Read-state + baseline persist in `config`** (the only durable table) so they survive the ephemeral rebuild: `inbox_seen` (keys marked seen — pruned to live keys each poll, so bounded), `inbox_known_tasks` (assignment/status baseline), `inbox_initialized`. Marking `[seen]` hides an item across reload AND restart; no duplicates.
- **Bootstrap:** first poll silently baselines current assignments/statuses (no flood) but DOES surface comments/mentions (14-day window) + overdue, so day-1 triages the real backlog.
- UI: summary bar (`3 mention you · 2 due/overdue · …`) + collapsible urgency groups (MENTIONS / DUE-OVERDUE / NEW COMMENTS open; NEW ASSIGNMENTS / STATUS CHANGES collapsed). `[open]`/`[seen]`/`[CLEAR ALL]`/`[REFRESH]`; unread badge on the nav.
- Routes (namespaced under `/clickup/` to avoid colliding with the dispatcher's own `/api/dispatcher/inbox` task-queue): `GET /clickup/inbox`, `POST /clickup/inbox/refresh`, `POST /clickup/inbox/seen`, `POST /clickup/inbox/seen-all`.

### Task ↔ tmux-session mapping + analyst-proposed interpretation + %-analysis + live feed
Upgrades the Increment-1 completion analysis:
- **Map a task to a live tmux session** (per-task `<select>`, or multi-select checkboxes + bulk-map bar). The session's cwd (`tmuxAdapter.listSessions().cwd`, via `clickupAnalyst.sessionCwd`) is the project the analyst reads. `db` columns `mapped_session` + `proposed_interpretation`.
- **`[PROPOSE]`** (`submitProposeInterpretation`): analyst reads the task + mapped project (vault page + README/git log, efficient) and drafts "what done means" in 1-3 sentences → pre-fills the editable textarea; edit (auto-save on blur) or `[confirm]`.
- **`[ANALYZE]` output is now `%` + missing + next** (was `STATUS:`). Instruction emits `PERCENT: 0-100` / `MISSING:` / `NEXT:` (`PERCENT: -1` = SecretCo skip); `parseVerdict` clamps. Sources, EFFICIENT (hard constraint): the mapped project dir → vault page → if a code repo, `git log/diff --stat` → if not code, the WSL2 `~/.claude/projects` transcript but only recent/tail (never the whole .jsonl).
- **Live activity feed** (`getActivitySteps`): tails the NEWEST transcript `.jsonl` in `~/.claude/projects/-mnt-c-Users-you-PROJECTS-tsrct-analyst/` (each `claude -p` = a fresh file → newest = current run), extracts `tool_use` events into readable steps, shown live under the running task. Dashboard poll tightens to 2.5s while analyzing, 7s idle.
- Routes: `POST /clickup/task/:id/map`, `POST /clickup/task/:id/propose`, `GET /clickup/analyst-activity`.

### Grouping = shared session
Mapping several tasks to the same session clusters them into collapsible **delimited blocks** (header bar + cyan accent; whole header toggles; `[-] collapse all` / `[+] expand all`; collapsed header shows a `~avg%`). `[ANALYZE GROUP]` runs the whole cluster (serialized). Each analysis job receives its SIBLING tasks (same session) as `related_tasks` context so the analyst reasons about the area but scores ONLY that task. Routes: `POST /clickup/tasks/map-bulk`, `POST /clickup/analyze-group`.

### Durable task meta (survives the ephemeral rebuild)
`mapped_session` + confirmed interpretation + proposal are mirrored into `config` as one small JSON keyed by `clickup_task_id` (`db.persistTaskMeta` write-through on edit; restored in `upsertClickupTask` on the re-sync — `config` authoritative). The `%` analysis result stays ephemeral on purpose (on-demand/fresh). The `clickup_tasks` table itself stays ephemeral.

---

## 9d. Codemap tab — repo-map MAP.md control surface (2026-06-24)

A **desktop-only** tab (next to Tasks) that keeps each active tmux session's `MAP.md`
(the `repo-map` skill's file:line code index) FRESH and ARMS the live Claude session
to use it. **You don't browse the index — your session does.** The tab is a per-session
control panel, not a search box.

**Per active user session** (infra sessions — server / `run-*` / `cc-*` — are excluded):
- **Freshness row:** `N symbols · M files · mapped Xago · K changed since` (drift = code
  files newer than MAP.md, bounded walk capped at 4000 files).
- **[Regenerate]** — runs `~/.claude/skills/repo-map/genmap.js` against that session's cwd
  (`execFileSync('node',[GENMAP,cwd])`, argv-exec, no shell). genmap writes `MAP.md` to cwd.
- **[Prime]** — injects a short GENERIC directive ("read MAP.md first, jump by file:line
  instead of grepping") into the live session via `sendToTmuxSession`. No repo content.
- **[Regenerate all]** + **Auto-keep-fresh** toggle (persisted in `db.config` key
  `codemap_autopilot`): a 5-min `tick()` regenerates MISSING or STALE (drift>=8) maps for
  non-SecretCo sessions. Never auto-primes (a prompt injection could interrupt active work).

**SECRETCO — fail-closed, 4 layers (the wire NEVER carries code):** (1) any session whose cwd
matches `/secretco/i` renders `[LOCKED]` with no buttons; (2) `regenerate`/`prime` call
`restrictedGuard.assertNotRestricted(cwd,name)` before acting → `RestrictedProjectError` (`RESTRICTED_PROJECT`)
→ route 403; (3) genmap refuses SecretCo paths itself (exit 2, writes nothing); (4) **data
minimization — `listSessionMaps()` returns only counts/age/drift + project basename, never
MAP.md body, and SecretCo rows redact basename+cwd to `[locked]`.** SecretCo never produces a map.

**Backend:** `lib/dispatcher/codemapEngine.js` — genmap runner + header-only metadata reader
(`Files indexed: N · Symbols: M` parsed from the first 1KB, never the body) + drift walker +
autopilot tick. Routes in `handleDispatcherRoute` (auth-gated): `GET /api/dispatcher/codemap/sessions`,
`POST .../codemap/{regenerate,prime,autopilot}`. Started in the dispatcher init block with
`init({db,tmux,send:sendToTmuxSession,serverSession})`.

**Frontend:** `src/js/codemap.js` (IIFE modeled on `dashboard.js`; exports
`codemapInit`/`codemapTeardown`/`codemapRegen`/`codemapPrime`/`codemapRegenAll`/`codemapToggleAuto`).
`[M] Codemap` tab + `#pc-codemap-panel` + `pcSwitchTab('codemap')` branch in `desktop.js`.
Lazy CSS `src/css/rooms/room-codemap.css` (`loadRoomCSS('codemap')`); panel layout in
`desktop.css`. sw cache → `tsrct-v213`. **Run the generator manually any time:**
`node ~/.claude/skills/repo-map/genmap.js` (inside the project).

---

## 9e. Notifications tab + weekly security audit (2026-07-13)

A **desktop-only `[!] Notifs` tab** — the first UI over the server's event queue (which
existed at `/api/events` but nothing rendered). Two sections:
- **SECURITY AUDITS** — DURABLE history parsed from `logs/security-audit.log` via
  `GET /api/audit/history`; `[Run now]` fires `POST /api/audit/run` (spawns the audit
  script, responds on close). Each row: `[*] CLEAN` / `[!] FINDINGS` + details + timestamp.
- **RECENT ACTIVITY** — the live `/api/events` stream (ephemeral, last 50, wiped on restart).

Backend: two auth-gated routes in `handleAPI` (`/api/audit/history`, `/api/audit/run`).
Frontend: `src/js/notifications.js` (IIFE modeled on codemap.js; exports
`notifsInit`/`notifsTeardown`/`notifsRunAudit`), `src/css/rooms/room-notifs.css`
(lazy via `loadRoomCSS('notifs')`), tab+panel+branch in desktop.js. sw cache → v218.

**Weekly audit engine:** `scripts/weekly-audit.sh` runs `npm audit` (+ outdated + node
version), appends to `logs/security-audit.log`, and POSTs a summary event to
`/api/event` (**no ntfy** — disabled; surfaces in the in-app stream + the Notifs tab). It
sources nvm so it works under cron's minimal PATH. Installed via `crontab`, **Mon 13:00 UTC**
(10:00 Córdoba). Run on demand: `bash scripts/weekly-audit.sh`. (Context: fixed a same-day
Cloudflare-tunnel infinite crash-loop — a URL regex falsely matching `api.trycloudflare.com`
in error text reset the retry counter forever — and an `npm audit` `form-data` high advisory
via `npm audit fix`; see Decisions Log 2026-07-13.)

## 9e-bis. SYFTEN MENTIONS — the live Reddit/forum feed inside Notifs (2026-08-22)

The Notifs tab gained a **third and now first-listed section: SYFTEN MENTIONS.** This is the
reason the tab is checked daily. Syften watches Reddit, Hacker News, Bluesky, dev.to and forums
for AcmeCloudCo's and Verde Soap's keywords; TSRCT is where Leon actually reads them, because
he is in TSRCT all day and not in the Syften web app or in `#syften-testing`.

**Backend — `lib/syften.js` (standalone, like sessionWeight: a Syften outage cannot take anything
else down).**

| piece | detail |
|---|---|
| Poll | `POST https://syften.com/api/0.1/items/get` `{limit:50}`, **every 60 s**, first poll deferred 5 s so a Syften outage never slows boot |
| Auth | `SYFTEN_TOKEN` in `.env`, read **server-side only — the token never reaches the browser** |
| Store | `data/syften-items.json`, ring buffer `MAX_KEEP = 300` + a `dismissed` id list (last 2000) |
| Dedupe | by item `id`; only genuinely new items fire the callback |
| Fan-out | each new mention is pushed through `addEvent({type:'syften_mention', …})`, so the existing event stream and pollers pick it up with no extra plumbing |

**Why a durable store at all:** the in-app event queue is capped at 50 and wiped on restart. A
mention that arrives while the server is down and is never seen is the exact failure the tool
exists to prevent, so mentions live on disk, not in the queue.

**Reading costs no Syften quota.** Syften meters by *matching*, not by fetching — `/items/get` is
free, only the filters cost. That is why a 60 s poll is fine; the real ceiling is Syften's own
surfacing delay (minutes), not ours.

**Normalization gotcha (verified against the live API 2026-08-21):** `/items/get` returns a **bare
array**, not `{items:[…]}`, each entry `{id, item:{…}, matched_on, filter}` — and **the community
lives in `item.backend_sub`** (`"r/Makeup"`), *not* in `item.meta`. Reddit bodies arrive as **HTML**,
so `normalize()` strips tags and clamps to 400 chars to keep a row one line.

**Routes** (all auth-gated, in `handleAPI`):

| route | |
|---|---|
| `GET /api/syften/items[?all=1]` | open mentions; `all=1` includes dismissed. Returns `{items, hidden, showingAll, lastPoll, lastError, configured}` |
| `POST /api/syften/dismiss` `{id}` | hide one |
| `POST /api/syften/clear` | hide every currently visible one |
| `POST /api/syften/restore` | un-hide everything |

**Dismissal never deletes.** Dismissed ids stay in the store and `hidden` reports how many are
being withheld, so `[show]` / `[restore all]` can always bring them back — same rule as the
security-findings section.

**Frontend — `src/js/notifications.js`.** The section renders one row per mention (community ·
filter · author · time-ago, linking straight to the post, `[x]` to dismiss). The important part is
that **the poll is not tied to the tab's lifecycle**: `startBackgroundPolling()` hits
`/api/syften/items` **every 30 s regardless of which room is open**, and on a genuinely new id it
plays the mention chime and sets the tab badge. Opening the tab marks everything currently open as
seen (`localStorage` key `nf-syften-seen`) and clears the badge. Syften dismissals are
**server-side** (they must survive a reload), unlike the Recent-Activity ones which are local-only.

**No ntfy.** This is deliberately an in-app signal: chime + badge while you are in Terminal.

**Failure mode is soft:** if `/api/syften/items` fails the section renders its `lastError` and the
other two sections still draw; if `SYFTEN_TOKEN` is unset the section says so and the poller idles.

**Where the keywords live:** the filter list itself is *not* in this repo — it is Syften-side, and
its rationale, cost model and open questions are documented in
`marketing-stack/DOCUMENTATION.md` ("Syften — competitor monitoring account" + "Syften + F5Bot").

## 9f. Desktop session grouping (2026-07-13)

Sidebar sessions can be organized into **named, collapsible groups** (drill-down),
**desktop-only**. Data model `{ groups: [{id, name, collapsed}], assignments: { sessionName: groupId } }`
stored in the **durable `config` table** via `GET/POST /api/sessions/groups` — survives PWA
refresh AND server restart (lives in WSL2 with the tmux sessions). NEXT: nested groups
(groups-of-groups) — hinted to tie into the neural-network coordination graph.

**Interaction is drag-first (no create button, no native prompt):**
- **Drag one session onto another** → auto-creates a group with both + opens an INLINE rename
  input (`.pc-group-name-input`). Drag onto an existing group to join; drag to the ungrouped
  zone (dashed hint, shown only while dragging) to remove.
- Header-click collapses; **double-click the name** renames; hover-`×` deletes the group
  (sessions stay alive, just become ungrouped).

**Cable safety (split view):** cables anchor `sidebar item → panel` by `getBoundingClientRect`.
A session hidden inside a COLLAPSED group returns a zero rect → the cable would snap to (0,0).
`pcCableAnchor(session)` fixes this: if the item is hidden (`offsetParent === null`), the cable
anchors to the **group header** instead. Cables redraw on collapse and after each sidebar render.

**Two integration gotchas (fixed):** (1) the global image-attach overlay `pc-drop-overlay`
darkened the whole app on ANY drag — `handleDragEnter` now ignores internal session drags
(`pcDragSession` set OR no `Files` type in `dataTransfer`); (2) the 3s session poll destroyed
the inline rename input mid-edit — `refreshPCSessions` bails while a `.pc-group-name-input` is
focused. All grouping logic + `window.*` exports live in `desktop.js`; styles in `desktop.css`.
sw cache → v220.

## 9g. Omni file finder — center-header universal search bar (2026-07-16)

A **desktop-only** VS-Code-quick-open-style search bar in the MIDDLE of the PC header
(the empty space between the session/quick-actions on the left and the S/M/L/XL·VAULT·…
buttons on the right). Solves "navigating Linux (`/mnt/...`) files from Windows is hard":
browse + search all of `/PROJECTS` from the top bar and act on any file without leaving TSRCT.

**Two modes in one dropdown (`#pc-omni-panel`):**
- **BROWSE** (empty query) — lists the current directory (dirs then files) with clickable
  **breadcrumbs**, pre-navigated to `/PROJECTS`. Reuses `POST /api/files/browse`.
- **SEARCH** (typed query) — recursive **fuzzy filename search** across all of `/PROJECTS`
  via `GET /api/fs/search?q=` (server-side bounded walk, ranked: substring-of-basename >>
  substring-of-path >> subsequence). Caps: 60k entries visited, 300 results, `truncated` flag.

**Per-row actions** (hover / selected row): **open** (file → default Windows app, dir →
Explorer, via `explorer.exe` + `/mnt/<d>/…`→`<D>:\…` conversion), **win** (reveal-in-Explorer,
`explorer.exe /select,`), **+** (attach to input — pushes into the same `attachedImages` array
as the paperclip, then `pcUpdateAttachIndicator()`), **copy** (path → clipboard), **ren**
(rename in place), **dup** (duplicate → `name copy.ext`). Keyboard: **Ctrl/Cmd+K** focus,
↑/↓ move, ↵ open / enter dir, → enter dir, Esc close; click-away closes.

**Backend** (`server.js`, all auth-gated, argv-exec no-shell, confined to `PROJECTS_ROOT` via
`resolveWithinProjects()`, SecretCo **fail-closed**): `GET /api/fs/search`, `POST /api/fs/open`
(fire-and-forget `spawn('explorer.exe', …)` — Explorer returns non-zero even on success),
`POST /api/fs/rename`, `POST /api/fs/copy`. Helpers `resolveWithinProjects` + `toWindowsPath`
+ `FS_EXCLUDE_DIRS` added by the roots block. **SecretCo:** the search walk prunes any entry whose
name mentions SecretCo (`restrictedGuard.mentionsRestricted` → `SecretCoSandbox` never descended); open/rename/copy
call `assertNotRestricted` (→ 403 `RESTRICTED_PROJECT`); `/api/files/browse` now also 403s SecretCo paths
and skips SecretCo entries (previously unguarded).

**Frontend:** `src/js/omni.js` (IIFE; exports `omniInit`/`omniOpen`/`omniClose`/`omniToggle`/
`omniOnInput`/`omniOnKeydown`/`omniRowClick`/`omniAct`/`omniCrumb`). DOM `#pc-omni` injected into
`.pc-header` by `buildPCLayout()`; `omniInit()` called right after `app.appendChild(main)`. Styles
in `desktop.css` (`.pc-omni*`). Script tag in `index.html` before `session-voice.js`. sw cache → v225.

## 9h. Generative AI Studio — local ComfyUI control room (2026-07-16)

A **desktop tab `[G] Studio`** (next to `[N] NULL`) + **mobile Tools button → `studio` room** that
wraps Leon's local **ComfyUI (Flux + Wan 2.2 + LoRAs, 8 GB RTX 5060)** in a friendly UI: launch/stop
ComfyUI, **real-time GPU telemetry**, a tailored form per mode, live progress + preview + output
gallery, and an **embedded read-only Claude advisor** that knows the UI and recommends exact settings.
Everything is **proxied through the TSRCT server** (`/api/studio/*`) so it works identically over the
tunnel (ComfyUI is bound to localhost:8188). **Nothing generates until the user hits Generate.**

**Backend (`lib/studio/`, required independently at server top):**
- `comfy.js` — ComfyUI lifecycle (`start`/`stop` argv-exec the venv python, PID-tracked via `pgrep`,
  logs to `~/ComfyUI/lurk-boot.log`, readiness via `/system_stats`) + job proxy (`submit`→`/prompt`,
  `history`, `interrupt`, `view` bytes proxy, `stageInput`, `recentOutputs`) + `models()` (dir read +
  `/object_info` sampler/scheduler enums) + a **hand-rolled minimal WebSocket client** to ComfyUI
  `/ws` (near-zero-dep) that re-emits progress on an EventEmitter `bus`. **ComfyUI 0.26 quirk:** progress
  arrives as **`progress_state`** (per-node map, pick the running node), not `progress`; live previews
  need the client to advertise `{type:'feature_flags',data:{supports_preview_metadata:true}}` (masked
  frame) → previews come as **binary type 4** `[4B evt][4B metaLen][JSON][img]`.
- `workflows.js` — `{mode,params}→graph` builders mirroring `flux_gen.py`/`wan_animate.py` and EXTENDING
  them: Flux schnell/**dev**+FluxGuidance, **LoRA stacking**, **Flux Redux** (style-from-ref), img2img +
  inpaint, upscale, and `custom` (raw API-JSON passthrough = uncapped escape hatch). Hardware defaults baked in.
- `gpu.js` — one `nvidia-smi --query-gpu=...` → `{util,memUsed,memTotal,temp,power,...}` (handles `[N/A]`).

**API (`/api/studio/*`, auth-gated in `handleAPI`):** `GET status`, `POST comfy/{start,stop}`, `GET gpu`
+ `GET gpu/stream` (SSE), `GET models`, `POST stage`, `POST generate`, `POST interrupt`, `GET
progress/:id` (SSE — relays ComfyUI ws + a `/history` completion watcher), `GET view` (output bytes),
`GET outputs`. The two SSE routes self-validate `?token=` (added to the auth gate's `isSSERequest`).

**Advisor:** reuses HF — `HFSession` + `POST /api/hf/start` gained backward-compatible optional
`{systemPrompt, allowedTools}`; when set, `send()` uses `--append-system-prompt` + `--allowedTools`
(read-only: `Read Grep Glob WebSearch WebFetch`) instead of `--dangerously-skip-permissions`. Studio
starts a `studio-advisor` HF session in a chosen cwd (default `/PROJECTS/personal`, **SecretCo-guarded**),
primed with the full UI/field spec + 8 GB hardware, streaming via the existing `/api/hf/output/:id` SSE.

**Frontend:** `src/js/studio.js` (IIFE, dual desktop-tab + mobile-room like `lurk.js`; mounts into
`#pc-studio-body` / `#studio-room .studio-mount`). Modes: Still/Animate/Style/Restyle/Upscale/Custom,
each a form with **Simple⇄Advanced** toggle, **LoRA rack**, seed randomize, size presets, **Leon-tailored
one-tap presets**, and a **live VRAM predictor** (safe/tight/risky vs the 8 GB budget — a guide, never a
cap). Run panel: live step/preview/cancel + output gallery (blob-fetched through `/view`) with per-item
**animate-this / upscale-this / ask-AI / open-in-Windows** (reuses omni `/api/fs/open`). Styles in
`src/css/rooms/room-studio.css` (`.st-*`, lazy via `loadRoomCSS('studio')`); desktop panel layout in
`desktop.css`. Wired: `desktop.js` tab+`#pc-studio-panel`+`pcSwitchTab('studio')` branch; `index.html`
Tools button + `#studio-room` + script tag; `WorldManager.rooms.studio` registered in `studio.js`. sw → v227.
**Layout (v228):** shell = topbar (GPU+launcher) → mode row → **3-pane body** (`.studio-body` grid: form ·
run+gallery · advisor). **Desktop = 3 EQUAL-HEIGHT columns** (`.studio{overflow:hidden}` + grid
`align-items:stretch`; each pane `height:100%` scrolls independently — pro layout, no ragged bottoms):
left form scrolls; middle = run/preview as the dominant canvas (`flex:1`) + gallery strip (`max-height:42%`)
at the bottom; right = advisor filling its column (messages `flex:1` scroll, input pinned, empty-state
"Start advisor" box centered). Mobile stacks vertically, whole `.studio` scrolls, gallery `max-height:44vh`.
The mobile room needs a **solid `#studio-room` background** (rooms-base `.room` is transparent by default —
`theme-studio` has no bg layer) or the terminal bleeds through. **Output viewing reads FROM DISK**
(`comfy.readOutput`, confined to `OUTPUT_DIR`, traversal-blocked) — NOT proxied through ComfyUI — so the
gallery keeps working after ComfyUI is stopped; `blobFor` checks `res.ok` and hides cells for missing files
(no broken icons). Verified visually via a headless puppeteer harness (real CSS + studio.js, stubbed globals)
at 1500px + 412px, incl. the advisor-started state.
**VERIFY STATUS:** read-only endpoints (status/gpu/models/outputs/view) + generate-submission live-verified;
the live progress/preview SSE is source-correct but pending a real generation to runtime-confirm (needs GPU
green light). Local **LoRA training** deferred (32 GB RAM upgrade — see vault `projects/lurk.md`).

## 9i. Studio "Scenes" — project-based AI video editor (2026-07-16)

A **new mode** in the Studio (`Still·Animate·Restyle·Upscale·Custom·**Scenes**`) — a Premiere-style,
**project-based** editor that assembles short AI clips (Wan outputs) into a longer video. **100% ffmpeg
(CPU — GPU-light, no ComfyUI needed).** Purpose: build a *story with a consistent character* over many
sessions (the "duende"/locked-LoRA approach — the project pins a character LoRA + notes so new clips stay
identity-locked). When `S.mode==='scenes'`, `renderAll()` swaps the 3-pane generate body for the editor.

**Backend `lib/studio/scenes.js` (+ `/api/studio/scene/*`):**
- **Projects** = folders under `PROJECTS/personal/lurk/scenes/<name>/` with `project.json` + `export_*.mp4`.
  `listProjects/createProject/loadProject/saveProject/deleteProject`, all confined to `PROJECTS_ROOT`
  (delete extra-guarded to a real project folder under the scenes base).
- **Clip library** `listClips` = `~/ComfyUI/output/*.mp4` + `assets/motion/*.mp4` + the project's own,
  deduped by name, each with `probeDuration` (ffprobe) + a cached first-frame `thumbFor` (ffmpeg).
- **Render** (async job + `renderStatus`) reuses the PIEL patterns: (1) normalize each shot
  (`-ss in -t dur -vf scale=WxH:force_original_aspect_ratio=decrease,pad,fps,setsar,format=yuv420p`),
  (2) assemble: **concat demuxer** if all cuts else a **cumulative-offset xfade chain** (`xfade=…:offset=cum-fade`),
  (3) finish: `drawtext` titles + optional **cinematic look** (`gblur`+navy `curves`+`noise` grain+`vignette`)
  + audio mux (`-map 1:a -c:a aac -shortest`). argv-exec, PROJECTS-confined; clips may also come from the
  ComfyUI dirs (`safeClipPath`).
- Routes: `GET scene/projects`, `POST scene/project`(create)/`GET scene/project`(load)/`POST scene/project/{save,delete}`,
  `GET scene/clips`, `GET scene/thumb?clip=`, `GET scene/file?path=` (export/preview, confined), `POST scene/render`,
  `GET scene/render/status?job=`.

**Frontend (`studio.js` scenes section + `.st-scene*` CSS):** project picker → editor with a **timeline**
(shots: thumb, in/out trim, per-boundary transition cut/crossfade+dur, reorder, remove), **clip library**
(click→add), **audio** (path+offset), **titles** (text+start/end), **character** (locked-LoRA select + notes +
`[+ Clip for this character]` bridge → Still pre-loaded with the LoRA), and **export** (9:16/16:9/1:1, fps,
cinematic-look toggle, Render + progress + result video). Autosaves (debounced); thumbs/exports blob-fetched
with auth. sw → v240.

**VERIFY:** backend live-verified GPU-free — created a project, listed clips w/ durations, rendered a 2-shot
project (crossfade + cinematic look + title + `Deployment.wav`) → **1080×1920 MP4, 3.7 s** in ~8 s. Editor
layout verified via the puppeteer harness (project open, 3 shots, all panels). **v2/future:** beat-sync
(reuse `null_drop_render` librosa), AI transitions (Wan between stills), cloud-clip import, per-shot color/speed.

---

## 9j. HANDS ON — Claude dictates, Leon types (v0, 2026-08-24)

The inverse of HANDS FREE. That one is zero-touch by voice; this one is all-touch. In this mode
Claude does **not** write the code: it publishes a **plan**, and TSRCT makes Leon type it line by
line over ghost text, with a plain-language reason beside every line.

**Desktop tab `[H] Hands On`.** One `SURFACES` entry (`handson`), one panel, one lazy stylesheet —
the documented way to add a surface, no if/else anywhere. Three columns:

| column | what |
|---|---|
| `[F] FILES` | the project tree, rooted at the **session's** cwd. Files the plan touches are marked; a file the plan CREATES is listed as `new` even though it is not on disk yet, or the tree would quietly disagree with the step on screen. Clicking a plan file jumps to its step. |
| `[H] HANDS ON` | the step: target file, action, anchor, then one row per line — `gutter · code cell · why`. |
| `[>] CLAUDE` | the live tmux terminal. **Borrowed, not rebuilt** (see below). |

### The three rules the module exists to enforce

**1. The plan is DATA, never scraped prose.** It arrives as JSON and nothing parses Claude's pane.
The shape is `{title, steps:[{file, action, anchor, note, lines:[{text, why}]}]}` — the explanation
for a line is authored *with* the line, so nothing is generated while you type. v0 ships a
hand-written `SAMPLE_PLAN` inside `handson.js` and tries `GET /api/handson/plan?cwd=` first; the
route does not exist yet, which is why the sample is the fallback and not the other way round.

**2. Checking what you typed NEVER calls a model.** `hoPaintActive()` is a character compare in the
browser: correct chars neon, wrong char red on a red wash, the untyped remainder dim. Instant, and
it works with Ollama, Hermes and the dispatcher all switched off. (TOWER's lesson, applied up
front: never make the valuable part depend on the model. The model is only needed to *author* the
plan and to answer when you ask why.)

**3. The tmux session IS the project selector.** Each session is already open in its own directory,
so there is no separate project picker: a 3 s watcher compares `getCurrentTargetSession()` to the
mounted one and, when it settles on a new one, re-roots the tree and reloads the plan. `GET /api/cwd`
gained an optional `?session=` for this (it previously only ever answered for the server default,
which is `''`). The path goes through the SecretCo guard on the way out.

> **`homeSession` FLAPS, and watching it naively is a churn generator (2026-08-24).** In split view
> every permission arriving from another panel rewrites `homeSession`, so a real console showed it
> bouncing `tsrct -> reddit -> piel-3 -> tsrct` within seconds. The first version acted on a single
> differing sample, which meant discarding and re-fetching the cwd, the plan and the **entire file
> tree** every 3 seconds forever. Two corrections, both required: **hysteresis** — one differing
> sample is noise, two in a row is a switch (the same fix TOWER needed for session states) — and
> **compare the DIRECTORY, not the session name**, since two sessions can share a cwd and a rename
> is not a new project. Verified against the real 3 s interval by
> `~/headless-chrome/tsrct-handson-flap.mjs`: a flapping session now refetches **nothing**, a
> settled new project switches in one round of requests, and a different session with the same cwd
> does not rebuild the tree.

### The ghost mechanic

One active line at a time. The cell stacks a `.ho-mirror` (absolutely positioned, per-character
spans) under a `.ho-typed` input whose text is `transparent` with a neon `caret-color`. **They must
share every metric that moves a glyph** — family, size, line-height, letter-spacing, padding,
`white-space: pre` — or the ghost drifts off the caret. That shared block in `room-handson.css` is
the feature, not tidiness. Per-character spans mean no text measurement is ever needed.

- **Indentation is given, not typed.** A new line prefills with the expected leading whitespace.
- **`enter`** commits, comparing with trailing whitespace stripped. A mismatch shakes the row and
  does **not** advance — the row is the error, no toast, no modal.
- **`tab`** reveals the whole line. **`[skip]`** skips it. Both count the LINE, not the keypress,
  and both paint it **amber for the rest of the session**: the header tally (`typed N · revealed N`)
  is not the only place that admits you did not earn it.
- **`[G]` toggles the ghost off** — the code disappears and only the `why` is left, so you produce
  the line from the intent. This is the v3 difficulty dial, and it is why every step stores both
  halves (code AND intent) from v0 rather than only the code.

### The terminal is BORROWED

`hoBorrowTerminal()` moves the live `.pc-terminal-wrap` **node** into the right column and
`hoTeardown()` puts it back at its exact original parent and sibling position. Same node, so every
handler, id lookup and poller keeps working. The repo already carries three duplicated terminal
implementations (~4000 lines of duplication is the biggest open cleanup) — a fourth is not a
feature. Order matters and `pcSwitchTab` already provides it: teardown runs *before* the hide-all
loop, and init runs *after* the panel is shown, so each side owns visibility at the moment it acts.

### v1 — the plan channel, the store and the skill (2026-08-24)

**`lib/handson.js`** is the store: `data/handson-plans.json`, keyed by cwd, atomic tmp+rename write,
bounded (40 projects · 40 steps · 200 lines · 400 chars). Durable on disk **deliberately** —
`db.js` drops its tables on every boot, and a half-typed lesson that evaporates on restart costs you
the one thing you were building. A corrupt store degrades to "no plans", it does not throw.

**Two route families, and the split is the security design:**

| who | paths | gate |
|---|---|---|
| **Claude** (a `curl` from inside a pane) | `POST /handson/plan` · `GET /handson/events` · `POST /handson/clear` | **local-only, no auth**, matched BEFORE the `/api/` gate — the same contract as `/session/{id}/refresh`, because the caller has no session token and should not be handed one. `isRemoteRequest()` is the only thing in front. |
| **the panel** | `GET /api/handson/plan` · `POST /api/handson/progress` · `POST /api/handson/step-done` | the normal `/api/*` auth gate |

Both families take the cwd through `restrictedGuard` at the top of their handler, not per call site.
Keep what the unauthenticated half can do **small**: it reads and writes one JSON file of lesson
text, and it must never grow the ability to run, read or write anything inside a project.

**Validation is the contract with the skill**, so its errors are written to be read by the model
that got it wrong: `steps[2].lines[5] has no "why"` is actionable, `invalid plan` is not. A plan is
rejected outright if any non-blank line is missing its explanation — a line without its reason is
the feature not happening.

**The loop back.** `POST /api/handson/step-done` carries what Leon **actually typed**, and the store
diffs it against the plan into a `diverged` array (trailing whitespace ignored). Claude polls
`GET /handson/events?cwd=&since=` — `since` is an index, so a re-read is idempotent and nothing is
consumed; a poll that destroyed events would lose them the first time two windows polled at once.
Divergence is the *point*: "different but correct" means re-publishing the remaining steps adapted
to what he wrote, not making him undo working code.

**`doneSteps` is stored, not derived from `stepIndex`** — otherwise stepping back with `[<]` would
re-open every later step and the rail would lie about what you have finished.

**The `[=] PLAN` rail** sits under the step: every step with `[x]`/`[>]`/`[ ]`, click to jump. It
fills what used to be dead space under a short step and answers the one question the step view
cannot — where am I in the whole lesson.

**The skill** is `~/.claude/skills/hands-on/SKILL.md`. Its load-bearing rule is a **prohibition**:
in this mode Claude may not create or edit a single project file. That has to be explicit, because
writing the code is the reflex, and it fires exactly when the lesson gets interesting. Reading,
searching and running read-only commands stay allowed — reading the repo is how you write a plan
that fits it. The skill also fixes the register of the `why` column with a good/bad table, because
"Declaramos una constante que almacena el resultado" and "de todas, deja solo las que no viste" are
the same line and only one of them is the product.

**Still not built:** mobile (typing code on a phone is not a goal), and a way to write the finished
step to the file from the panel — today you type into the panel and paste, which is deliberate for
now: the point is the typing, not the saving.

**VERIFY (v1):** the store by `scratchpad/handson-lib-test.js` running the real `lib/handson.js` —
22/22 over publish, 11 malformed plans each rejected with a message naming the field, clamping,
progress, divergence with both versions carried, incremental non-consuming events, survival across
a simulated restart, and a corrupt store degrading instead of throwing. The panel wiring by
`~/headless-chrome/tsrct-handson-v1.mjs` — 11/11 over a published plan beating the sample, resuming
on the saved step with its tally, the rail's counts and publish age, step-done reporting the typed
text, one debounced progress write, and rail-click navigation.

**VERIFY:** `~/headless-chrome/tsrct-handson-check.mjs` loads the real `handson.js` + real CSS,
stubs only `fetch`/`getCurrentTargetSession`/`playSound`, and drives the actual state machine —
15/15 covering the wrong-character paint, enter-on-wrong not advancing, an exact commit, the
prefilled indent, tab-reveal counted separately from typed, a blank line committing on one enter,
ghost-off keeping every `why`, and the terminal returning to its original parent with its content
intact. Run it with `LD_LIBRARY_PATH="$(cat ~/headless-chrome/libpath.txt)"`.

---

## 9k. USAGE — plan left + what today really cost, in the sidebar (2026-08-24)

A sixth rail section (`[$]`, `data-panel="usage"`), one `GET /api/usage/day`, `lib/usage.js`, and
`scripts/statusline-usage.sh`. It answers **two** questions, from two different sources, and the
panel keeps them apart because they fail differently:

| Question | Source | Freshness |
|---|---|---|
| **How much of the plan is left** (5-hour + 7-day) | the Claude Code status line | as old as the last status-line render |
| **What it cost** (tokens, dollars, context weight) | the transcripts on disk | as old as the last `[refresh]` |

### The quota bars — the limit that actually stops work

Dollars are a proxy; on `default_claude_max_5x` what stops Leon is the **5-hour and 7-day
windows**. Those percentages exist **nowhere on disk** — Claude Code fetches them from its usage
endpoint and holds them in memory. The supported, credential-free way to read them is the **status
line**, which is handed a `rate_limits` block on stdin containing `used_percentage` and `resets_at`
for both windows.

So `scripts/statusline-usage.sh` does two jobs in order: persist `rate_limits` (plus a
`captured_at` stamp) to `~/.claude/tsrct-rate-limits.json`, then print the status line itself
(`[5h 35%] [7d 38%] [ctx 41%] Opus 5 · TSRCT`). Wired in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command",
                "command": "bash /mnt/c/Users/you/PROJECTS/TSRCT/scripts/statusline-usage.sh",
                "refreshInterval": 30 }
```

Four things that are not obvious:

- **`resets_at` is EPOCH SECONDS, not an ISO string** (`1787618400`). Parsing it as a date string
  yields `NaN` and the countdown renders blank — found only by running `bars()` against the real
  file, never by reading the payload description. `lib/usage.js` normalises seconds / milliseconds
  / ISO to epoch ms so the panel has one shape.
- **A missing reading says "no reading", never 0%.** A quota bar that fabricates zero reads as
  *plenty of headroom* — the precise way a usage display gets someone rate-limited.
- **The file is only as fresh as the last render**, so the age travels with the value and the panel
  prints it. With no Claude session open the number stops moving and says so.
- The script **never fails the status line**: `jq` when present, a `grep`/`sed` fallback when not,
  and `// empty` so a Claude Code build without `rate_limits` leaves the previous reading alone
  rather than overwriting it with null.

### The cost half — the only ground truth on this machine

**The source is the transcripts, and nothing else.** Claude Code writes every assistant turn to
`~/.claude/projects/<encoded-cwd>/<session>.jsonl`, and each one carries the `message.usage` the API
actually billed: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and
`cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`. **No model is involved
anywhere in this feature** — reading your own bill must not cost you a turn — so it works with
Ollama, Hermes and the dispatcher off.

### The four things that make the number right

1. **The 1h/5m cache-write split is not a detail.** A cache read costs 0.1x input, a 5-minute write
   1.25x, and **a 1-hour write 2x**. Claude Code runs the 1h TTL, so pricing writes at the 1.25x
   every tutorial quotes under-reports a heavy day by real money. `costParts()` reads the two
   ephemeral fields separately and only falls back to `cache_creation_input_tokens` (as 1h) when the
   split is absent.
2. **Dedupe by `message.id`.** A resumed or forked session **copies the earlier turns into its new
   transcript**, so the same billed message really does appear in more than one file. Without the
   dedupe a day with resumes reports a bill that was never charged.
3. **The day is LOCAL.** Timestamps are UTC `Z`; "today" is Leon's day. `dayBounds()` builds local
   midnight, and the file walk skips any transcript whose `mtime` predates it — which is what keeps
   an 895 MB store off the hot path.
4. **SecretCo is excluded at the one place that enumerates files**, through the standalone
   `restrictedGuard`, with a second check per record on `cwd`. Not a project name, not a token count. The
   count of excluded files IS shown, so the total is never quietly short — and SecretCo is Bedrock, a
   separate bill, so excluding it makes the number *more* correct, not less.

### On demand, and it means it

There is **no timer in the module, the route, or the panel**, and there must never be one: a cold
scan walks ~150 MB of JSON. Three deliberate consequences:

- The panel measures **once**, on the first click of the rail icon in that window.
- **Reopening the section never re-scans** — it re-renders.
- **Restoring the panel on boot never scans.** `pcSidebarInitLayout()` reopens whatever section the
  window had open, and that is not a request to measure, so it passes `{restoring: true}` through
  `pcRailSelect` to `Usage.onOpen()`. Without this, reloading the PWA with the panel open would be
  an auto-poll wearing a different hat.
- After that, `[refresh]` is the only way in. The header always states the measurement's age, which
  is what makes a manual refresh honest instead of a trap.

**Measured on the real store:** 23 files / 149 MB → **970 ms cold, 7-10 ms warm**. The memo cache is
keyed on `(path, size, mtime)` and holds the day's *records*, not per-file totals — per-file totals
would make cross-file dedupe impossible. A second scan re-reads **zero** bytes.

### What it shows

The headline is the day's **tokens** — that is the unit the plan is denominated in — with dollars,
turns and sessions on the line below. Then: **context buckets** (`<100k` /
`100-200k` / `200-300k` / `300k+`, the same edges `sessionWeight` warns on) with a computed verdict
against the **measured pre-handoff baseline** (30% of turns / 49% of the bill above 300k, over the
16 days before the first handoff ran — see `~/headless-chrome/tsrct-handoff-effect.mjs`) — that
baseline is the only reason the distribution means anything; **where the money goes** split four ways (cache read / cache write / output / input, which
always sum to the total) plus what the cache saved as a counterfactual (`cache_read` tokens priced at
full input); **by project**, **by model**, the **most expensive sessions** with their peak context,
and cost **by hour**.

An unknown model id is priced by family (`opus`/`sonnet`/`haiku`/`fable`) and the estimated dollars
are disclosed on screen; a non-Claude id gets **no** price rather than a wrong one.

**VERIFY:** `~/headless-chrome/tsrct-usage-check.mjs` (51/51) runs the real `lib/usage.js` — every
price hand-computed per component, the 1h write proven to be exactly 1.6x the 5m one, the duplicate
message id counted once, all four bucket edges, the SecretCo turn absent from totals *and* from the
project list, plus a real scan asserting that components, buckets, models, projects and hours each
sum to the total, plus the quota bars (epoch-seconds `resets_at`, a missing file that reports "no
reading" instead of 0%, a corrupt file, and a payload with no `rate_limits` block).
`~/headless-chrome/tsrct-usage-panel-check.mjs` (33/33) renders the real panel with
the real `desktop.css` in a 260px column: no fetch before the first open, none on restore, none on
re-open, none after 2.5 s of sitting there, one on `[refresh]`, the numbers matching the payload, a
failed scan rendering as an error rather than a stale number, a nearly-exhausted week rendering red
while a comfortable 5-hour window does not, the reset shown as a countdown, and nothing overflowing
the column.
Both need `LD_LIBRARY_PATH="$(cat ~/headless-chrome/libpath.txt)"` for the panel one.

⚠️ **`/api/usage/day` needs a server restart** — the running process was started before the route
existed and answers 404.

---

## 9l. [PB] PLAIN BRIEF — a toggle that actually enforces a skill (2026-09-08)

The ask: make the `plain-brief` skill one tap away from the phone and the desktop, and have it
**enforced prompt by prompt** while it is on — *"not as a prompt injection like my vault system,
but rather some sort of harness that obligates Claude"*. That distinction is the whole design.

### Why this is not the vault system

`augmentPrompt()` (server.js) prepends text to the message Leon typed. Two limits, both fatal here:
it only fires for prompts **sent through TSRCT**, and it becomes part of his own sentence, so it is
a suggestion in the same voice as the request. [PB] uses the harness instead:

| | vault augmentation | [PB] |
|---|---|---|
| Where the state lives | `localStorage`, per browser | `data/plain-brief.json`, per tmux session |
| Where it is applied | server, inside the prompt string | two Claude Code hooks |
| Prompts typed into the pane directly | not covered | covered |
| If TSRCT is restarting | nothing happens | still enforced (the hooks read the file) |
| Enforcement | none — Claude may ignore it | the turn cannot end until it passes |

### The two hooks (`~/.claude/hooks/`, registered in `~/.claude/settings.json`)

- **`plain-brief-gate.sh` — `UserPromptSubmit`.** Resolves the tmux session, reads the flag, and
  prints `~/.claude/skills/plain-brief/RULES.md` verbatim. On this event stdout **is** the context
  Claude sees, so the rules arrive every turn without touching the user's message. It also picks
  the word cap and detects a detail request ("en detalle", "por qué", "walk me through",
  "status?"), which raises the cap for that one answer — the Stop hook cannot see the prompt, so
  this is the only place that decision can be made. It writes `/tmp/claude-plainbrief/<session>.turn`.
- **`plain-brief-check.sh` — `Stop`.** The half that obligates. Reads `last_assistant_message`
  (provided on the event; the transcript lags), measures it with `plain-brief-check.py`, and on a
  violation **exits 2**, which prevents the stop and feeds stderr back to Claude as the reason.
  Costs zero tokens to measure — no model is asked.

**The escape hatch is load-bearing:** after `MAX_BLOCKS=2` refusals the answer is let through with a
`systemMessage` saying so. A gate with no terminal state turns one stubborn answer into a paid
infinite loop, and the feature would deservedly get switched off (invariant 41).

### What is measured

`plain-brief-check.py` is pure measurement (stdin → stdout JSON), so it can be run against a real
answer to see what it would have said. **Fenced and indented code is stripped before counting** — a
40-line diff is not verbosity, and counting it would make the gate fire on every legitimate code
answer, which is how a guard gets turned off for good.

- **blocking:** `over_cap` (70 words by default, 200 on a detail request), `preamble` (opens with
  "Great question" / "Let me start by" / "Buena pregunta" instead of the answer), `closing_summary`
  ("In summary…" as the last paragraph, and only when there is more than one paragraph).
- **reported but never blocking:** `hedge`. Sometimes a genuine uncertainty is being named, which
  the rules *require* — blocking it would punish the honest case.

### The rules live in ONE file

`~/.claude/skills/plain-brief/RULES.md` is the enforced core; `SKILL.md` is the long form and
explicitly points at it. The gate injects RULES.md rather than a copy, because a pasted copy is the
one that goes stale (invariant 39).

### The toggle

- **Mobile:** `[PB]` in the status bar next to `V`. Cyan when on — gotcha 21 already established
  cyan as "the system is acting under its own rule", and three yellow buttons in a row cannot be
  told apart at arm's length.
- **Desktop:** `PB` in the PC status row next to `VAULT`/`RST`. **No keyboard shortcut** — every
  numpad key is already taken (`*` vault · `+` vault reset · `-` unfocus · `/` focus input ·
  Enter approve · `.` deny), and the digits collide with `e.key >= '1' && e.key <= '9'`.
  *Trap worth keeping:* `NumpadDivide` looked free because grepping for `Numpad` finds nothing for
  it — focus-input is bound as `e.key === '/'`, which the numpad key also emits. **A `code` test
  and a `key` test for the same physical key are the same binding, and whichever handler runs
  first wins, silently.** Grep for both spellings before claiming a key is free.
- Per session, so it follows `pcSwitchSession()` / `updateHomeSessionDisplay()` the same way
  AUTO-ACCEPT does. Never polled: a per-session flag nobody is looking at is not worth the bytes
  (gotcha 26).
- Routes: `GET /api/plainbrief[?session=]`, `POST /api/plainbrief/toggle {session, on?, cap?}`.
  Passing an explicit `on` sets it; omitting it flips it, so two windows cannot race into opposite
  states.
- The cap is per session in the store, so it is tunable without touching code.

`scripts/check-plainbrief.js` (in `npm run check`) walks the whole chain — button, route, store,
RULES.md, both hooks, their executable bit, and their registration in `settings.json` — because the
two halves live in different trees and are linked only by a path string. **A toggle that lights up
and enforces nothing is worse than no toggle.**

## 9m. [C] CLIENTS — client-health board (2026-09-21, rebuilt 2026-09-22)

Desktop tab `[C] Clients` (`SURFACES.clients`, `src/js/clients.js`, `css/rooms/room-clients.css`,
`lib/clientHealth.js`). Per client card, in the order he decides: a one-line **verdict**, at most **3
NEXT steps** each with the button that does it (`REPLY`/`MAIL` -> Gmail, `TASK` -> ClickUp),
`[!] WAITING` for anything not already a step, `[~] THIS WEEK` (overdue, due within 7 days, asked in
the last 14, or living only in a mail), then `[+] BACKLOG` / `[+] RESOLVED` / `[+] EXPIRED` folded.
Every action is a link out. **The tab writes nothing outside TSRCT.**

- **It does not depend on how work is recorded** (Leon, 2026-09-22). A client is CONFIG only —
  `.tsrct-clients-config.json` (gitignored): `{name, code, domains[], clickup:{workspace, folders[],
  lists[]}}`. Adding a client = adding an entry. Headless Claude reads EVERYTHING in those folders/lists
  (open + closed 30 days, descriptions, native checklists, markdown checkboxes, subtasks, comments) and
  the mail with those domains, and reports **requests**, not containers: `title, who, first_asked,
  status (open|resolved), resolved_on, priority, due, quote, places[{url,label}], thread_ids[], review`.
  A request can be a task, a checkbox inside a master task, a subtask, or only a mail. Nothing in the
  code knows a task id, a tag or a description format, and `check-clients.js` fails if one appears.
- **"Resolved" means the problem is solved** (task closed, box ticked, clear evidence in mail), never
  "we replied". An item the job is unsure about is kept with `review` (shown as `[?]`, reason in the
  tooltip), never dropped.
- **Duplicates.** The job merges (a Gmail thread id in any text is a strong hint, the content decides).
  The server merges again only on PROOF: the same ClickUp place listed twice. **Never on a shared mail
  thread — one client mail carried three separate requests**; merging on the thread folded FL's 25
  requests into 18 on the first real run. Measured on FL 2026-09-22 with 23 loose duplicate tasks still
  alive: 25 requests, all 23 master checkboxes covered once, each loose task attached to its checkbox,
  0 places repeated.
- **Where the facts come from:** the 06:00 morning routine (its question carries the `CLIENT HEALTH`
  section, its answer an optional `clients` array -> `clientHealth.ingest()`, also on a dry run) or
  `[Refresh]` (`POST /api/clients/run`, kind `client-health`, ClickUp + Gmail READ tools only). Both
  spend Claude tokens; `GET /api/clients` is a file read. Only configured clients are stored.
- **Claude reports facts; the server decides the colour** (`derive()`). Red: a client mail unanswered
  > 24 weekday hours, a high/urgent request past due, a promise of ours past due. Yellow: other
  unanswered mail, other overdue, a request that lives only in a mail, oldest open > 30 days, more open
  than a week ago, or mail not read. Rule in the dot's tooltip, never on screen. Verdict and NEXT come
  from the job when it gives them, else from `ruleVerdict()` / `ruleActions()` on the same facts.
- **`[x]` expires** (`POST /api/clients/expire`, `.tsrct-clients-expired.json`). A request is keyed by
  its ClickUp PLACES (task + checkbox label), not its thread (siblings from the same mail would vanish
  with it); the expiry remembers every place, so it survives deleting a duplicate task and a reworded
  title. Mail items key on the thread and come back when the client writes again. Applied before the
  rule; the job is told the list. Nothing changes in ClickUp or Gmail.
- Store `.tsrct-clients.json` (gitignored). Cleaned on the way in: ClickUp links must be
  `https://app.clickup.com/...`, thread ids `[A-Za-z0-9_-]`, dates real; SecretCo dropped after the answer.
- Refresh policy: reads once when the tab opens; polls every 15s only while a refresh is running.

## 9n. [@] AUTOMATIONS — everything that runs by itself, one switch each (2026-09-24)

One card per automation, grouped (Work · Upkeep · Content · Machine · Claude Code hooks), each with a
dot (green OK · amber look at this · red needs attention · blue running · hollow waiting), a switch,
one line of last result, and [>] Run. Tap a card: what it does, next run, last 5 runs, and the time
for scheduled jobs. Failing cards are pulled up into a **Needs attention** group at the top; the tab
button carries a red number (`GET /api/automations/alerts`, no process spawned, polled every 2 min).
Mobile: the AUTO button in the tools grid opens the same list as a room.

- `lib/automations.js` — the catalogue and the five kinds: `job` (scheduler), `loop` (inside the
  server; paused state in `.tsrct-automations.json`, so a paused loop stays paused after a restart),
  `service` (systemd **--user** only; `ollama` is a system unit and needs sudo, so it shows a lock),
  `wintask` (`schtasks.exe`, argv only, no admin needed — verified), `hook` (read from
  `~/.claude/settings.json`, **never switchable**: the SecretCo guard and the permission hook are one
  tap from being turned off otherwise).
- **The four WSL cron jobs moved into the scheduler** (Amazon keep-alive Mon 07:23, security audit
  Mon 10:00, Room 404 feed Mon 09:00 — still off, ACME meeting transcripts daily 10:45). The
  scheduler learned `days` (weekly) and now asks "did it serve the most recent OCCURRENCE" instead
  of "did it run today", so a Monday job with a 6-day window still runs on Wednesday if the laptop
  was shut on Monday. Cron could not: the keep-alive ran 3 times in 14 weeks. **The cost: they run
  only while TSRCT runs.** The crontab keeps them commented `#MOVED-TO-TSRCT` (backup in
  `~/.tsrct-backups/`); uncommenting one while TSRCT runs it makes it run twice.
- `lib/shellJob.js` runs the scripts async in their own process group with a timeout that kills the
  whole group. Each job has a `judge` that reads what the script left behind, because three of the
  four wrappers **always exit 0**: the keep-alive's verdict is `KEEPALIVE_FAILED.txt`, the router's is
  `=== exit N` in its newest log, the audit's is the last line of `logs/security-audit.log`.
- First boot after the move: `scheduler.seed()` records cron's last run AND its outcome (read by the
  same judge), so nothing re-runs and a job that was already failing is red on day one.
- Alerts: the second failure in a row, or a missed run (window passed without running), becomes an
  in-app event and a phone push (`ntfyPush`, priority high). The first failure only turns the card red.
- Voice: `automations_status` ("como andan las automatizaciones", "que esta fallando") and
  `set_automation` ("apaga syften", "prende lo de amazon"), which always confirms by name. The verb
  row only fires when a known automation is named near the verb, so "apaga las voces" is untouched.
- Every text that reaches a card goes through `mentionsRestricted()` (meeting names in the router log).
- Routes: `GET /api/automations`, `GET /api/automations/alerts`, `POST /api/automations/{set,run,time}`.
- Check: `scripts/check-automations.js` (77).

## 9o. The clock, the morning routine and Tesla (moved from CLAUDE.md, 2026-10-17)

This was the long half of CLAUDE.md, moved here word for word so every session stops loading it;
CLAUDE.md keeps the rules and points here. Paths were updated where `.tsrct-<name>` became `.tsrct/<name>`.

- **The clock and the morning routine** (2026-09-18, five standalone modules, none of them
  dispatcher-dependent):
  - `lib/scheduler.js` — named jobs at `HH:MM` on a laptop that sleeps. `>=` the hour (never
    `===`), a LOCAL day key (UTC dates let a 22:00 run fire twice), a per-job last-run on disk
    (`.tsrct/scheduler.json`), and a `window` in hours after which an owed run is abandoned
    rather than fired at midnight.
  - `lib/sessionSpawn.js` — create a tmux session, boot `claude`, wait for the REAL input box
    (`lib/paneShape.js`), paste with bracketed paste. Lifted out of the handoff so there is one
    copy; `sessionWeight.configure()` configures it too.
  - `lib/projectRegistry.js` — project name -> folder: an override in `config.project_dirs`,
    then `path:` in the vault frontmatter, then a scan of `PROJECTS_ROOT`. Allowlisted roots
    (same env var as `tmuxAdapter`), directory must exist, **SecretCo refused and never indexed**.
  - `lib/jsonJob.js` — ask headless Claude and get JSON that has been SHAPE-CHECKED, with one
    retry that quotes the parse error back. Balance-aware extraction, so a brace inside a string
    no longer ends the scan (the three older call sites each used their own regex).
  - `lib/morningRoutine.js` — the 06:00 job: local stock-take (live sessions, known projects,
    recent vault notes) -> ONE headless Claude question over ClickUp/Slack/Gmail/calendar/vault/
    past sessions -> open the sessions it names, primed. The cap counts ATTEMPTS, not successes
    (a failed spawn leaves its session alive). Writes `vault/sessions/<date>-morning-brief.md`.
    Runs ONE AT A TIME (`busy` flag): two overlapping runs each write the state file and each
    fan out with a cap that knows nothing about the other's sessions. `startOpen({only})` opens
    the sessions from the plan ALREADY on disk without asking again — that is what the panel's
    OPEN button does, because a dry run opens nothing by design and re-running would spend a
    second headless job and could answer differently.
    **The same run feeds the Clients tab** (`lib/clientHealth.js`, 2026-09-21): its answer carries an
    optional `clients` array of FACTS (requests, unanswered mail, promises), the server decides the
    health colour. No client is named in code — a client is a ClickUp list with `client requests` tasks.
  - Routes: `GET/POST /api/scheduler`, `/api/scheduler/job`, `/api/scheduler/run`,
    `POST /api/morning/open` (`{sessions?}` — accept the plan), `GET/POST /api/projects/registry`.
  - **RING** (`lib/ring.js`, 2026-09-19) — the phone being CALLED rather than notified: ntfy at
    priority 5 makes the noise, Web Push carries the tap that opens TSRCT speaking, and the repeat
    (every 40s, 5 times) is the server's. `/api/ring/{status,start,ack,stop}`; the PWA acks the
    moment it opens from the alert, which is what makes it a call and not an alarm. The morning
    brief rings.
  - **TALK** (`lib/talk.js`, 2026-09-19) — the microphone half of the brief overlay: speech ->
    Hermes -> the `house-es` Piper voice. Routes `GET /api/talk/status?since=`, `POST /api/talk/{open,
    attach,ask,close}`. **The file exists for its memory policy, not its plumbing**: nothing at boot,
    `open()` reads `nvidia-smi` and REFUSES when the card is busy (unless the model is already
    resident), the model PRELOADS when a conversation opens and a heartbeat re-arms `keep_alive` (30m) while it
    stays open, silence included; **only he ends it** (END, or "tesla, terminamos" / "chau tesla", 2026-09-24),
    and `pagehide` or no window polling for `TALK_ABANDON_MS` (20 min) unload it. Measured: 52s cold, 0.96s warm, VRAM back to idle after close.
  - **Tesla's BRAIN is a hidden Claude Haiku session** (`lib/haikuBrain.js`, 2026-09-24, `TALK_BRAIN=haiku`
    default, `local` = Ollama). One `tesla-<project>` tmux session per project folder (max 2, LRU), started
    with `--session-id` so the answer is read from its transcript JSONL (the `end_turn` message), NEVER
    scraped off the screen; read-only tools, everything else disallowed; SecretCo refused by folder, name and
    prompt. `isHiddenSession()` in server.js keeps `tesla-*` out of every list. It wears hermes.js's shape
    (converse/narrateSession/loaded/keepWarm/unload), so talk.js is unchanged below `hermes()`; no
    `chooseAction`, so the parser alone picks actions. Measured: boot 3.3s, answers ~5s, no GPU.
    `scripts/check-brain.js` (13th check).
  - **Every Tesla conversation is logged** (`lib/teslaLog.js`, 2026-10-03) to `logs/tesla/YYYY-MM-DD.jsonl`
    (gitignored, 120 days): each turn with its path through `talk.ask` (a `trace`), actions, reply, ms and
    FRICTION flags (error, slow, repeated, correction, asked-twice, the talk.js guards firing); the orb posts
    `hush`/`repeat`/mic/tts failures to `POST /api/talk/event` (allowlisted kinds). `ask()` is now a thin
    logging wrapper around `askTurn()`, which holds the guards (check-restricted looks there). "tesla, anota eso
    como error" flags the last answer. Any SecretCo field is replaced before writing. Every step carries its offset and duration
    (`trace[].t`, `timed()`: Haiku boot / queue wait / own answer, actions, model); the orb posts each turn's
    timing under its `turnId` (how long he spoke, the 2.5s pause, round trip, TTS, audio, mic back, felt wait),
    every recognised phrase, and every sentence LOST before reaching the server (`dropped`). `scripts/tesla-review.js`
    reads it back; the `/tesla-review` skill is the analyze-and-fix pass. `TESLA_LOG=0` turns it off.
  - **`lib/projectMemory.js`** (2026-09-19) — what a project has been up to, for the voice: its
    vault note, the newest entries of `wiki/decisions/<project>.md` (the split log; the old single-file parse is the fallback), and where
    its last `vault/sessions/` log left off. Chosen by the session's folder name. **The Decisions
    Log is ~3 MB and the live narrator asks on every spoken line**, so every read is cached against
    the file's `mtime` (a stat, not a read) and every extract is capped — the whole block is ~475
    tokens of the 8192 window and costs no VRAM. SecretCo is refused BY NAME before a file is opened
    and the assembled text is scanned after; `check-restricted.js` asserts both. The context is labelled
    as background in the prompt, or a small model recites last week's plan instead of reading the
    screen in front of it.
  - **The spoken half has its own model, its own temperature and one persona file** (2026-09-19).
    `TALK_MODEL` defaults to **`qwen2.5:3b-instruct-q4_K_M`** since 2026-09-24 (half the card, ~12k tokens of context on the GPU; A/B in the Decisions Log; it was `qwen2.5:7b-instruct-q4_K_M`), NOT the dispatcher's `hermes3:8b`:
    measured on the same pane with the same prompt, hermes3 claimed Leon's own verification as its
    own work and addressed Claude instead of him, while qwen2.5 read the screen correctly — in
    5411 MiB instead of 5639. The dispatcher keeps hermes3 (its classifiers are tuned against it).
    **`lib/persona.js` is the only file that says who hermes is**: identity (who is who — stated
    first, as a prohibition, because that is the failure that was measured), voice, form and
    **few-shot EXAMPLES, which are what actually carries a personality on an 8B** — a persona asked
    for in adjectives produced zero ironic lines on both models. `TALK_PERSONA=plain` turns the
    character off and keeps the identity block. **Temperature is part of the personality**:
    everything else in `hermes.js` runs at 0.2 (right for classifiers, fatal for a voice), the
    spoken paths at `TALK_TEMPERATURE` (0.7). Timeouts are split `TALK_COLD_MS` (300s) /
    `TALK_WARM_MS` (90s) — the inherited 180s ceiling was TOWER's, and a cold load plus a real
    prompt exceeds it, which killed the first question of every conversation and tripped the
    circuit breaker so the next two failed instantly.
  - **TALK attached to a session** (2026-09-19, TOWER's job done the other way round) —
    `attach({session, toClaude, watch, live})` points TALK at one tmux session. Two modes:
    **RELAY** (`toClaude:true`) types what he says into the session; **SIDE BY SIDE**
    (`toClaude:false`, which turns `live` on with it) keeps the conversation between him and
    hermes while the session is only watched — that is the one for talking while a turn runs.
    `live` also narrates DURING a turn, floor `TALK_LIVE_MS` (60s), one sentence, and an empty
    answer is a legitimate "nothing worth interrupting for". **Saying "hermes, ..." keeps that one
    line out of the session whatever the mode** (`ADDRESSED` in `lib/talk.js`; the vocative is
    stripped before the model sees it, and the override only ever works in the safe direction —
    it can keep a line out, never put one in). What he says is pasted
    into that session as a prompt AND answered out loud; `hermes.narrateSession()` is given
    `paneShape.readableTail()` (rules, composer, spinner, token footer and mode line stripped —
    TOWER handed over the raw capture, which is why its tiles were junk) plus whether the pane is
    mid-turn. **The watcher is a capture-pane and a regex every 4s — no model, no GPU.** The model
    is woken only on the working -> waiting transition, i.e. once per finished turn, floor
    `TALK_NARRATE_MIN_MS` (20s); a transition seen during that floor is REMEMBERED (`state.pending`),
    never dropped. Narrations queue in a spool the panel drains through `status?since=`, so one
    voice speaks at a time and the mic is down while it does. Auto-narration re-arms the idle timer
    only if a panel polled in the last 60s — a dead tab must not pin 4.7GB all day. SecretCo: the
    session NAME (`sessionGuard`) and the SCREEN (`screenOf`) are both refused, and a refusal
    detaches rather than skipping one tick; `/api/output` staying open is only safe while every
    pane -> model path is closed, and `scripts/check-restricted.js` now checks these three by name.
  - **THE MODEL IS THE MOUTH, NOT THE BRAIN** (2026-09-20). What a spoken sentence MEANS is
    decided in code, and the local model is the fallback for the sentences that code is not sure
    about. Five files, and the checks are half the design:
    - `lib/actions.js` — the declared catalogue (**56 actions**; **the first gaps turned into buttons** (2026-09-25): `day_status`, `store_messages`, `draft_reply` are fixed RECIPES run in `hands` (`teslaHands.start({recipe})`, logged as commands; a draft lands in his input box unsent), `past_sessions` is plain code (`lib/pastSessions.js`, reads `~/.claude/projects/<cwd>/` transcripts, skips Tesla's own, SecretCo refused); `hands` stays open while its transcript moves, and follow-ups asked straight to it are logged too; **NO BUTTON** (2026-09-25): `look_into` (runs at once) / `workaround` (asks once) hand what no action covers to `lib/teslaHands.js` - a VISIBLE interactive Claude session `hands` (his approver sees its permissions, he can open or stop it, it never blocks the analyst queue), model by level, SecretCo denied in its `--settings`, answer read from its transcript (`RESULTADO {...}`), closed after 15 min idle; every one is appended to `logs/tesla-workarounds.md` (gitignored) - the missing buttons, to be turned into real actions; **TASKS** (2026-09-24): `plan_task` (goal + files attached in the orb + level) runs `promptWriter.start({mode:'task'})` - the research reads everything of his (all projects, session logs, vault, web, READ-only Slack/ClickUp/Gmail/calendar) and answers prompt + WHERE (existing project or `newFolder` under PROJECTS) + session name; the code checks the place, the plan WAITS for his yes (24 h, panel [open]/[x], `/api/talk/job`, or `start_task {job}` by voice), then creates the one folder and opens the session with the prompt SENT. Every analyst job now carries SecretCo DENY rules as a `--settings` file (`restrictedDenyRules()`), not just a sentence; `draft_prompt` puts a text into his input box UNSENT via `window.fillPrompt`; `research_prompt` is `lib/promptWriter.js` — a job on the model HAIKU picks by `level` (simple Haiku 5.5 / medium Sonnet 5.5 / complex Opus 5.5, `PROMPT_MODEL_*`) through `analyst.submitJob` (now takes `model`/`addDirs`/`disallowedTools`) that may read the session's project, the vault and the web, never edit or run, and lands in his box or, with `send`, in the session. **It is never silent** (2026-09-24): `promptWriter.list()` feeds an "in the background" block in the orb's panel and the model+clock on the orb, `/api/talk/jobs` is the orb's 12s poll while no conversation is on, a journal (`.tsrct/prompt-jobs.jsonl`) survives restarts, a watchdog delivers from the output file if the analyst's tick is >60s late and fails out loud at 13 min, and with no window watching the result goes to ntfy. Haiku is handed `Trabajo en segundo plano:` every turn and must never guess it. "mandale/enviale" in HIS sentence is the yes for `say_to_session(s)`/`research_prompt` only — `talk.saidDirectly`), the gate, the confirmations.
      **BULK** (2026-09-24): `sessions_overview`, `pending_permissions`/`answer_permissions` (only the
      cards named in the question are decided — `lib/permissionDesk.js`), `stop_sessions`,
      `slash_to_sessions`, `refresh_sessions` (the weight handoff), `rename_session`, `git_status`,
      `usage_today`, `clients_status`, `run_automation`; `open_session` takes an optional `name`.
      Keys and renames go through `lib/paneKeys.js` (argv tmux; refuses `tesla-*`, SecretCo, the server
      session). Type `manySessions` is capped at 12 (cheap things), `sessions` stays at 4 (each costs a Claude).
      Nothing else may run. Server-side actions declare `verify.fn`; page actions `verify.ui`.
    - `lib/uiActions.js` + `src/js/ui-actions.js` — **the buttons that live in the browser**
      (tabs, rooms, permissions, quick answers). The server queues a press, the page runs it from
      its OWN allowlist and reports back on `POST /api/talk/did`; the queue rides out on
      `/api/talk/status` and on the answer to `/api/talk/ask`. A press into a browser that is not
      polling is refused in words, and a press that fails afterwards is spoken. No model turn:
      each action carries the sentence to say.
    - `lib/understand.js` — the verb table, the object extractor and the pronouns. ~0.003 ms per
      sentence against ~2 s warm for a model call. A verb with a negation in front of it is not an
      order; `writes: true` rows can never be reached by "mostrame"/"contame".
    - `lib/setups.js` — named boards (`.tsrct/setups.json`). A setup is a list of the actions
      above, confirmed once by naming every step; a failed step stops the rest.
    - `lib/speech.js` — `shape()` (two sentences, no lists, no markdown — cut, never rewritten)
      on everything the model writes, and `forVoice()` (tsrct -> teseract, 18:29 -> "seis y media",
      a path -> the file at the end) applied ONLY at `/api/tts/say`.
    - Checks: `scripts/check-talk.js` (**211** — 100 of his real sentences, several sessions from one sentence, the yes/no answers, the
      spoken shape, and that the verb table only routes to actions that exist and agrees with each
      one's `readOnly`) and `scripts/check-ui.js` (**116** — the two allowlists agree, every handler
      still reaches a live global, six destructive functions have no voice handle).
      `scripts/check-handlers.js` now **exports its global name set** for check-ui to reuse.
  - **The assistant is an ORB, not a panel** (`src/js/assistant.js` + `css/assistant.css`,
    2026-09-19). TALK was born inside the morning overlay, which made it modal: talking meant
    keeping a sheet open over your work, and closing it ended the conversation. The orb is fixed
    bottom-right, builds its own DOM on boot (so it exists in every room and both layouts — the
    mobile-BRIEF lesson), is never modal (`pointer-events: none` on the container, no backdrop),
    and hides only under the morning overlay. Tap = start/expand; the strip shows state + the last
    line; the panel holds the session picker, the three switches, the log and a text box.
    **The conversation lives in the server**, so the orb is one client of it: closing the panel
    costs nothing, a reload re-joins the live conversation (`adopt()`), and a second window shows
    the same one. **`toClaude` is OFF by default and confirms before arming** — it shipped on and
    typed a test word into a live session (see `lib/talk.js`); changing session disarms it, and
    every paste gets its own amber line plus a toast. Silence never ends a conversation
    (`TALK_MAX_SILENT_MS` is 0 = off since 2026-09-24); the only automatic close is ABSENCE - no window
    polling for `TALK_ABANDON_MS`.
  - Frontend: **not a surface**. `[A]` in the PC header (`mrnToggle()`) opens a fullscreen
    OVERLAY (`#pc-morning-overlay`, `src/js/morning.js` + `css/rooms/room-morning.css`), Esc or
    the backdrop closes it, and it opens itself ONCE per brief on desktop (`tsrct_morning_seen`).
    The module polls in the background from boot — that is what lights `[A]` up.
  - **AUTOMATIONS** (`lib/automations.js` + `lib/shellJob.js`, 2026-09-24) — the [@] tab: every
    job, loop, user service, Windows task and hook with one switch each and its last outcome
    (DOCUMENTATION.md §9n). **The WSL cron jobs live in the scheduler now** (weekly `days`, catch-up
    by occurrence, `#MOVED-TO-TSRCT` in crontab) — so they run only while TSRCT runs. Loops start
    through `automations.bootLoop()`; a NEW background loop must too, or the tab cannot pause it.
    Hooks are shown and never switchable, by design.
  - **PROGRESS REPORT** (`lib/progressReport.js`, 2026-10-06) — `[R] report` at the end of the split-tab
    bar: today's turns of every session in the tab on screen (found through `~/.claude/sessions/<pid>.json`,
    whose `tmux` field names the pane; the newest log in the folder is only a marked fallback, since several
    sessions share a folder), cross-read by ONE headless job with ClickUp/Slack/Gmail/calendar/vault (read-only)
    plus the morning brief's pending list as a starting point, never the whole list. **The conversation decides
    "done"; his panel colour is a hint** and disagreements come back as `markMismatch`. The Slack text
    ("Tasks nailed today: / Pending:") is assembled in code, not by the model. Routes `GET /api/progress`,
    `POST /api/progress/{run,stop}`; state in `.tsrct/progress.json`; `scripts/check-progress.js`.
  - **The orb is shared** (2026-10-09): Ghost Runner loads THIS `src/js/assistant.js` (+ `utils.js`, `assistant.css`)
    from this folder through its server, configured by `window.TESLA_ORB` (base, headers, gate, no silent loop, another
    voice on the page). TSRCT sets nothing and gets the defaults. A change to the orb ships to both apps: keep every
    app-specific behaviour behind a `CFG` option, and run the runner's `node test-tesla.mjs` too.
  - **Tesla in Ghost Runner** (`lib/appKey.js`, 2026-10-09): `personal/runner-app` passes his phone's Tesla calls to
    this server over 127.0.0.1 with the `x-tsrct-app` key (`~/.config/tsrct/tesla-app.key`, made at boot). It opens the talk
    routes, `/api/tts/*`, the two uploads and `GET /api/sessions` ONLY (never `/api/talk/did`), and only for a local request; `scripts/check-appkey.js`. That client
    never gets TSRCT buttons (`talk.js screenPollAt`) and the brain is told he is probably running (`howToAnswer where`).
  - **Tesla's eyes on the PC** (`lib/desk.js`, 2026-10-10): `look_at_screen` is a read-only `hands` recipe whose
    ONLY way to see Windows is `node scripts/desk.js look [--screen N]` (`scripts/desk/look.ps1`, per-monitor DPI).
    SecretCo wall before any PNG is handed out: a request naming SecretCo closes the eyes 2 min (`desk.sawRestrictedPane` in
    handleAPI), a window that IS SecretCo work (`titleIsRestrictedWork`), and local Windows OCR per monitor at 2x for their
    org's address or a prompt inside SecretCoSandbox (that monitor dropped, the other served). **The word alone never
    refuses** (his rule): a mail, chat, folder listing or Claude session that names them is looked at.
    **Step two, `do_on_pc`** (confirmed once): click/double/right/move/scroll/type/key/focus (raise an open window by name) via `scripts/desk/act.ps1`;
    before every input the cursor must be where she left it (else HE took the mouse: 3 min stop), the window in
    front must not be SecretCo work, a look in the last 60 s, clicks only on a monitor clean in that look. Every
    step is logged to `logs/tesla/desk/` with the screenshots she saw (3 days); `tesla-review.js` DESK section.
    **Direct first, mouse last** (`lib/pcDirect.js`): `session_files` (from the session's transcript), `open_file`,
    `open_app` (raise if open, else Get-StartApps), `move_file` (asks) - no screenshot, no model, ~1 s; the
    watched session's new files ride in its context. do_on_pc is only for what happens inside a program.
    **Step three, VR**: no second Tesla - the TSL button in the VR controls toggles the one orb and
    `rdVrDrawTesla` draws its state in both eyes; `body[data-tesla-where="vr"]` tells the brain he is in the
    headset. `understand.aboutThePc` keeps PC sentences ("abrime el excel", "cerra spotify") away from the
    session verbs. `scripts/check-desk.js`. DOCUMENTATION.md gotcha 46.
    **Windows, modes and shortcuts** (2026-10-11, plan and status in `TESLA-PC-PATHS.md`): `lib/deskWindows.js`
    (place a window in a slot or on the other monitor, solo, Tesla's own saved layouts + 4 starters, PowerToys
    Workspaces by name, FancyZones via its CLI) and `lib/deskShortcuts.js` (a TABLE of named shortcuts, short
    routines like Slack Ctrl+K + name, links into Windows Settings and Spotify - a sentence picks a row, never
    keys), wired once by `lib/deskWire.js` for server.js and the CLI; 13 actions (arrange_window, solo_window,
    arrange, save_layout, list_layouts, delete_layout, set_zones, press_shortcut, pc_routine, windows_settings,
    spotify_search, list_windows, lock_pc), none asks except overwrite/delete/lock/close. The `hands` worker gets
    the same commands (`desk.js windows|place|solo|layout|zones|shortcut|routine|settings|spotify`) and its
    **skills in `tesla-skills/<name>/SKILL.md`** (one sheet per tool; the recipe names them, it reads one only
    when unsure). `scripts/check-desk-paths.js`; `tesla-review.js` DESK counts direct paths vs mouse steps.
  - **TESLA'S VOICE** (2026-10-14): `TALK_VOICE` defaults to the PROFILE `jorge-monstruo` (`lib/tts.js PROFILES`):
    Microsoft's free online es-MX Jorge via `edge-tts` (`~/.venvs/edge-tts`, no local model) + an ffmpeg monster chain
    (pitch/formant 0.75, bass, short echo), picked by ear. Offline or failing -> the same effects over local Piper
    `es_MX-claude-high` (never cached as the real sound); text naming SecretCo never goes online. Accent is neutral (tu),
    and the character speaks in the masculine (`lib/persona.js`).
  - **MUSIC TASTE** (`lib/tasteBrain.js`, 2026-10-14): what `play_music` plays for "sorprendeme" or a bare moment
    ("para correr", "chill", "en casa") is picked from HIS taste: seeds + his reasons + yes/no reactions (kept with the
    moment), inferred by ONE background Sonnet job (`analyst.submitJob`) into a pool of artists, each with the trait it
    shares and a distance (close/step/far). Running = close (never far), home = far, chill/none = a step out. The spoken
    path never waits for a model; an empty pool falls back to `spotify.js` SURPRISE. Voice: `music_react` ("me gusta este
    tema", "no me gusta esta cancion, muy limpio"), `music_teach`. State `.tsrct/taste.json`. `scripts/check-taste.js`.
  - **PROJECTOR** (`lib/projector.js` + `scripts/projector.js` + `src/js/projector.js`, 2026-10-12): a live view of a
    SEPARATE headless browser (chrome-headless-shell, own profile, puppeteer-core from `~/headless-chrome`) that a Claude
    session drives, so a course runs "on screen" without taking his mouse. Rail button right below Usage ($) opens a
    runner-style floating window; dropdown of tmux sessions, the picked one streams (CDP screencast over Node's own
    WebSocket, ~10 frames/s cap, ONLY while a window watches it), and his clicks/keys go into THAT page (never logged).
    A browser registers itself in `~/.config/tsrct/projector/<session>.json` and goes away on `stop`, when its tmux
    session ends, or after 3 h unused. Routes `GET /api/projector/{sources,stream}`, `POST /api/projector/input`.
    SecretCo refused at registration, listing, every navigation and in the CLI. `scripts/check-projector.js`.
    The CLI for sessions: `node scripts/projector.js start|open|look|read|find|click|type|key|drag|scroll|upload|download|stop`.
    `find`/`text=`/`css=` search every frame and open shadow roots, visible elements only, innermost control wins;
    `scripts/check-projector-live.js` proves it against a real browser (not in `npm run check`: it starts one).
    **Tesla uses it too**: `browser_task` (always asks: "en el navegador aparte, con tu mouse libre: ...") runs the
    `hands` worker on the `RECIPES.browser_task` text with the projector CLI allowed (sheet `tesla-skills/pc-browser`);
    `show_projector` is a page button (`projectorOpen(session)`). **On a phone** (TOOLS > PROJ, 2026-10-14) the same window opens full screen (`.projector-phone`, styles in main.css): tap = click, swipe = scroll, and a type bar, because the phone keyboard never opens on a picture. Any other session learns both tools from the
    global skill `~/.claude/skills/tesla/SKILL.md`.
  - **LAYOUT MEMORY** (`lib/uiLayout.js` + `src/js/layout-memory.js`, 2026-10-14): a TSRCT restart closes the app
    window and the launcher opens a NEW one, so everything a window kept in sessionStorage (per-folder split tabs,
    sidebar width/panel/collapse, focus mode, the session on screen) was lost. Those keys are mirrored (debounced) to
    `.tsrct/ui-layout.json` per window role through `GET/POST /api/ui/layout`, and a fresh window seeds itself BEFORE
    `initDesktopMode` (`pcStartDesktop`). The file is stamped with `/proc/sys/kernel/random/boot_id`: a Linux restart
    (or `wsl --shutdown`) throws it away and wipes the browser's old `tsrct_split_state` too. Deliberately NOT the
    `config` table, which is durable across boots. A new layout key goes in BOTH key lists. **A restart drops every login** (sessions live in memory), so the new window's first ask is a 401: it saves NOTHING until it has read the server copy, keeps asking every 1.5 s, and reloads once when the copy arrives late. `scripts/check-layout.js`.
  - **SESSION MEMORY** (`lib/sessionFolders.js`, 2026-10-14): every 60 s (loop `session-log`, Automations tab) the
    live `~/.claude/sessions/<pid>.json` files are read (tmux name, cwd, conversation id) into `.tsrct/session-folders.json`
    (30 days, NOT boot-stamped: a reboot is when it is needed) plus an audit line per change in `logs/sessions/YYYY-MM-DD.jsonl`.
    Claude deletes those files on exit, so this is the only record of where a closed session lived. Tesla's
    `reopen_sessions` ("todas" = the ones that closed together) brings each back with its name, folder and
    `claude --resume <id>`, nothing pasted. More than 4 sessions (open or reopen, up to 20) open one at a time in the
    background with a free-memory floor (`TALK_OPEN_MIN_FREE_MB`, 1500) and she says when done. SecretCo never written.
  - Panel attention glow (2026-10-06) follows the same live state as the sidebar (`pcSyncAttentionFromStates`),
    not only SessionVoice's transition events, which needed [V] on and the window focused at that instant.
  - `GET /api/health` — public but **local-only** (404 to any remote request), no token, says
    nothing but "up". **It did not actually exist until 2026-09-22** (this line described it
    anyway), so the second-server guard below always read "down" before then. `scripts/tsrct-up.sh [--ensure|--json]` is the bash side, and
    `boot-server.sh` now refuses to start a second server.

---

## 10. Data Flow

### Prompt Sending (User to Claude)

```
User types prompt in #prompt input
      ↓
clicks send button OR Ctrl+Enter
      ↓
send() function (main.js)
      ↓
POST /api/send { prompt: text, session: "claude" }
      ↓
server.js augmentPrompt()
      ↓
detectProject() from CWD
      ↓
buildVaultHeader() - prepend context
      ↓
sendToTmuxSession(augmented_prompt)
      ↓
tmux send-keys or tmux load-buffer
      ↓
Claude receives prompt in tmux
      ↓
Claude processes and outputs to tmux
      ↓
Frontend polls /api/output every 10s
      ↓
Terminal div updated with new output
```

### Permission Handling

```
Claude Code hook (in tmux)
      ↓
POST /api/permission { id, tool, description, ... }
      ↓
server.js: Add to permissionQueue
      ↓
sendNtfy() - notify phone
      ↓
Frontend polls /api/permissions
      ↓
Permission card appears on screen
      ↓
User swipes right (approve) or left (deny)
      ↓
POST /api/permission/:id/approve (or /deny)
      ↓
server.js: Update permissionQueue[id].decision
      ↓
Claude hook polls /api/permission/:id
      ↓
Hook sees decision and responds to Claude
      ↓
Claude continues execution
```

### Hands-Free Immersive Mode Flow

```
User clicks HF button or /hf-immersive-btn
      ↓
hfEnterImmersive() (hands-free.js)
      ↓
Show .hf-immersive modal
      ↓
User speaks into microphone
      ↓
Web Speech API captures audio → text
      ↓
User confirms transcription
      ↓
POST /api/hf/send { id: sessionId, message: text }
      ↓
server.js: HFSession.send(message)
      ↓
spawn('claude', ['-p', message, '--output-format', 'stream-json'])
      ↓
Claude CLI runs in isolated process (no hook delays)
      ↓
stdout emitted as JSON lines: { type: 'assistant', message: '...' }
      ↓
HFSession.emitSSE() broadcasts to all SSE clients
      ↓
Frontend SSE EventSource receives updates
      ↓
.hf-response div updated in real-time
      ↓
Claude finishes, SSE sends { type: 'assistant_done' }
      ↓
HF mode returns to idle state
```

### Event Polling (Terminal Output)

```
Frontend: setInterval(updateTerminal, 10000)
      ↓
GET /api/output?lines=1000
      ↓
server.js: tmux capture-pane -p
      ↓
return { output: "...", session: "claude" }
      ↓
frontend: Update #terminal div
      ↓
Smart scroll: Scroll to bottom unless user scrolled up
```

**Gotcha — Claude Code TUI has no tmux scrollback (2026-06-05):** recent Claude Code (v2.1.165+) renders as a full-screen TUI on the terminal's **alternate screen** and bottom-anchors its prompt. The alternate screen keeps **no scrollback that tmux can read**, so `capture-pane -p -S -1000` returns only the *currently visible frame*, no history — raising the `-S` number does nothing. The amount of transcript you can see is governed entirely by the **window height**: TSRCT sessions run with 0 attached clients, so tmux defaults them to 80x24 (only 24 lines). Fix is in `~/.tmux.conf` (`window-size manual` + `default-size 80x1000`, plus `mouse on`) so Claude paints ~1000 transcript rows into the canvas. Because a tall window + short conversation leaves huge blank regions (banner top, prompt bottom, blanks between), `/api/output` collapses runs of 2+ blank lines and strips leading/trailing blanks so the view is dynamic (only real content, up to 1000 lines). See Decisions Log → TSRCT (2026-06-05).

### SSE Event Stream (Real-time)

```
Frontend: EventSource('/api/hf/output/:sessionId')
      ↓
Connection kept open (HTTP 200 + text/event-stream)
      ↓
HFSession.emitSSE({ type: 'assistant_delta', text: '...' })
      ↓
server.js: res.write('data: {...}\n\n')
      ↓
Frontend: EventSource 'message' handler
      ↓
Parse JSON and update UI
      ↓
Keep-alive every 15s prevents mobile timeout
```

---

## 11. Configuration

### Environment Variables (.env)

```bash
BRIDGE_TOKEN=<your-secret-token>   # real value lives in .env only, never commit it
BRIDGE_PORT=3847
TMUX_SESSION=claude
NTFY_TOPIC=claude-bridge-LURK
NTFY_SERVER=https://ntfy.sh
REMOTE_URL=https://<machine>.<tailnet>.ts.net   # permanent Tailscale hostname
```

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_TOKEN` | auto-generated | Auth token for API access |
| `BRIDGE_PORT` | `3847` | Port to listen on |
| `BIND_HOST` | `127.0.0.1` | Loopback by default; `tailscale serve` reaches it because WSL2 is in mirrored networking mode |
| `TMUX_SESSION` | `claude` | Name of tmux session to control |
| `NTFY_TOPIC` | `claude-bridge-{USER}` | ntfy.sh notification topic |
| `NTFY_SERVER` | `https://ntfy.sh` | ntfy service URL |
| `SYFTEN_TOKEN` | unset | Syften API token for the Notifs mention feed (`lib/syften.js`). Server-side only — never sent to the browser. Unset = the poller idles and the section says so. **Regenerating it in Syften's UI kills reads and writes instantly** |
| `REMOTE_URL` | none | Permanent remote hostname, reported as `tunnel` in `/api/status` and shown+copied by the PC sidebar. **Cosmetic** - grants no access; `tailscale serve` does the routing |
| `TUNNEL` | unset (off) | Set to `1` to revive the RETIRED Cloudflare quick tunnel for one boot. It was on-by-default until 2026-08-11 (`TUNNEL=0` to disable) - the polarity is now inverted. **The `cloudflared` binary was DELETED 2026-09-08**, so `TUNNEL=1` alone now logs "binary not found" and does nothing - re-download it beside `server.js` first |

### localStorage Keys (Frontend State)

| Key | Purpose | Format |
|-----|---------|--------|
| `cbt` | Claude Bridge Token | string |
| `bridge_stats` | Usage stats (messages, edits, approvals) | JSON |
| `statsMsgCount` | Total messages sent | number |
| `statsTranscriptions` | Transcription count | number |
| `statsActivityLog` | Activity timeline | JSON array |
| `roomVisits` | Room visit tracking | JSON |
| `promptTemplates` | Saved prompt templates | JSON array |
| `autoAcceptSessions` | Sessions auto-approve permissions | JSON array |
| `terminalFontSize` | Terminal font size in px | number |
| `soundEnabled` | Sound effects on/off | boolean |
| `nf-syften-seen` | Syften mention ids already seen (badge/chime suppression only — the real dismissals are server-side) | JSON array (last 500) |
| `speechLang` | Voice input language | string (es-ES, en-US) |

### Claude Code Hooks Configuration

File: `claude-hooks-config.json` (merged into `~/.claude/settings.json`)

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/notify.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "idle_prompt|permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/notify.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**`permission-hook.sh` tool gate (2026-06-05):** the `PermissionRequest` hook (matcher `*`) fires for every tool, but the script has an internal allow-list — `Edit|Write|Bash|NotebookEdit|Read|WebFetch|WebSearch|Grep|Glob` plus **`mcp__*`** — and `exit 0` for anything else (which leaves Claude to show its own native TUI prompt instead of a TSRCT card). MCP connector tools are named `mcp__<server>__<tool>`; the `mcp__*` case is what routes ClickUp/Slack/Gmail/etc. permission prompts to the bridge so they surface as cards and ride per-session AUTO-ACCEPT on both mobile and desktop. The auto-approver itself is per-session and tool-agnostic — surfacing is gated here in the hook, not in the UI. See Decisions Log → TSRCT (2026-06-05).

---

## 12. Core Patterns & Conventions

### No Emojis Rule

**CRITICAL**: Never use emoji characters in code, comments, or UI.

Instead use text symbols:
- `[*]` - success/done
- `[+]` - add
- `[-]` - remove
- `[!]` - warning
- `[?]` - question
- `[>]` - play/continue
- `[x]` - error/close
- `[S]` - save
- `[i]` - info

### Singleton Pattern

Global singletons are used for state management:

```javascript
const WorldManager = {
    activeRoom: null,
    rooms: { ... },
    open(key) { ... },
    close(key) { ... }
};

const Desktop = {
    isPC: false,
    activeTab: 'terminal',
    initDesktopMode() { ... }
};
```

### CSS Class Naming

- **Mobile**: `.card`, `.header`, `.quick-bar`, `.perm-card`
- **PC Mode**: `.pc-mode`, `.pc-sidebar`, `.pc-main`, `.pc-terminal`
- **States**: `.active`, `.hidden`, `.visible`, `.working`, `.waiting`
- **Rooms**: `.room`, `.room.active`, `.theme-{themeName}`
- **Layout**: `.app`, `.app-container`, flex/grid layout containers

### Module Loading Order

Strict order required - later modules depend on earlier globals:

1. `app.js` - Defines core globals
2. `main.js` - Uses globals from step 1
3. `world-manager.js` - Standalone, used by later modules
4-14. Feature modules - All use previous globals

### Fetch Pattern

All API calls use consistent pattern:

```javascript
const res = await fetch('/api/endpoint', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': token
    },
    body: JSON.stringify({ ...data })
});
const data = await res.json();
if (data.error) { /* handle error */ }
```

### Error Handling

- **Frontend**: Toast notifications for user feedback
- **Server**: Return JSON with `{ error: message }`
- **Uncaught**: Log to console, show generic error message

### localStorage Best Practices

- Keys are prefixed by feature: `bridge_*`, `stats*`, `pc_*`, `plan_*`
- Complex data stored as JSON strings
- Auto-load on app init, save on changes
- Use `requestIdleCallback` for batched saves

### Desktop Keyboard Shortcuts (`handleGlobalKeydown`, desktop.js)

All global shortcuts live in one `keydown` listener on `document` (`initKeyboardShortcuts` ->
`handleGlobalKeydown`). It early-returns unless `Desktop.isPC`. A `typing` flag
(`activeElement` is INPUT/TEXTAREA) gates everything below the Escape block, so the
unfocused-only shortcuts sit after `if (typing) return;`.

**Numpad block** -- Leon's numeric keypad is reserved for TSRCT triggers. These match on
`e.code` (not `e.key`) so they are NumLock-independent and never collide with the main-row
keys:

| Key | `e.code` | Action | Gate |
|-----|----------|--------|------|
| Numpad `*` | `NumpadMultiply` | Toggle vault augmentation | input unfocused |
| Numpad `+` | `NumpadAdd` | Reset vault cycle (RST) | input unfocused |
| Numpad `-` | `NumpadSubtract` | Blur the focused input | input FOCUSED (this is the escape hatch into the other numpad keys) |
| Numpad `Enter` | `NumpadEnter` | Approve permission (`approvePerm`) | input unfocused AND `#pc-perm-banner` visible |
| Numpad `.` | `NumpadDecimal` | Deny permission (`denyPerm`) | input unfocused AND banner visible |

**Permission banner shortcuts** -- fire only while `#pc-perm-banner` lacks `.hidden`, and
only with no modifier held: `Y` / Numpad Enter = approve, `N` / Numpad `.` = deny,
`A` = toggle auto-accept for the current session (`pcToggleAutoAccept`). The banner's
`<kbd>` chips advertise all three; `pcUpdateAutoAcceptBtn()` rewrites only
`#pc-auto-accept-label`'s `textContent`, so the sibling `<kbd>` survives a state refresh.

---

## 13. Dependencies & Integrations

### No External NPM Dependencies

Everything runs on built-in APIs:
- **Node.js**: `http`, `fs`, `path`, `crypto`, `child_process`, `url`, `net`
- **Browser**: DOM, Fetch, EventSource, Web Speech, Canvas, localStorage, IndexedDB

### External Services

| Service | Purpose | Integration |
|---------|---------|-------------|
| **ntfy.sh** | Push notifications | HTTPS POST to topic endpoint |
| **Claude CLI** | AI execution (HF mode) | `spawn('claude', [...])` |
| **tmux** | Session management | `execSync('tmux ...')` |
| **Your PC's VNC** | Remote desktop | WebSocket proxy bridge |

### tmux Integration

Commands executed via `execSync` (synchronous spawning):

```bash
tmux send-keys -t session 'command' Enter
tmux capture-pane -t session -p -S -N     # Get output
tmux has-session -t session                # Check existence
tmux display-message -t session -p "#S"   # Get session name
tmux select-pane -t session -t :.+        # Next pane
tmux send-keys -t session "C-c"           # Control key
tmux resize-window -t session -x 80 -y 1000  # Tall window so Claude's TUI paints more transcript rows
```

**Persistent tmux config (`~/.tmux.conf`):** `mouse on` (wheel scroll in panes; selection needs Shift), `window-size manual` + `default-size 80x1000` (TSRCT drives sessions with no attached client, so without this tmux falls back to 80x24 and Claude's alt-screen TUI only renders 24 rows). New sessions inherit 80x1000; existing ones are resized at runtime.

**No mandatory `claude` session (2026-06-16):** TSRCT opens with ZERO tmux sessions — `TMUX_SESSION` defaults to `''`, not `'claude'`. At startup `pickInitialSession()` adopts the first REAL session (excludes `SERVER_SESSION` + `run-*`) or stays empty; killing the active session falls back to the first remaining real one or `''` (never a phantom `claude`); `getRecentOutput`/`sendToTmuxSession` no-op gracefully when there's no target. Frontend: the PC sidebar shows a runners-style empty state ("No sessions — click [+]") and adopts the first real session when none is selected. Create sessions on demand (`tmux new-session` starts the server). NOTE: `tmuxAdapter.tmuxExec` + the server.js `execSync('tmux …')` calls use `stdio:['pipe','pipe','ignore']` so a poll against a non-existent tmux server doesn't spam `error connecting to /tmp/tmux-1000/default`.

### ntfy.sh Integration

Send notifications:
```javascript
const req = https.request({
    hostname: 'ntfy.sh',
    path: '/your-topic',
    method: 'POST',
    headers: {
        'Title': 'Claude Finished',
        'Priority': 'high',
        'Tags': 'bell'
    }
});
req.write('Permission required');
req.end();
```

### Claude CLI Integration (HF Mode)

Runs Claude in "print mode" for single prompts:

```bash
claude -p "Your prompt here" \
    --output-format stream-json \
    --verbose \
    --dangerously-skip-permissions
```

Output is JSON lines, each line parsed as:
```json
{ "type": "assistant", "message": "..." }
{ "type": "content_block_delta", "delta": { "text": "..." } }
{ "type": "result", "result": "...", "cost_usd": 0.001 }
```

---

## 14. Known Gotchas & Limitations

### 1. tmux Message Length

Long prompts (>500 chars) sent via `tmux load-buffer` (safer) instead of `send-keys`.

```javascript
if (text.length > 500) {
    fs.writeFileSync(tempFile, text);
    execSync('tmux load-buffer "${tempFile}"');
    // ...
} else {
    execSync(`tmux send-keys -t session '${escaped}'`);
}
```

### 2. Service Worker Cache Version

Must bump `CACHE_NAME` in `sw.js` when updating assets:

```javascript
const CACHE_NAME = 'tsrct-v103'; // Increment when updating
```

### 3. Permission Race Condition

HF sessions don't receive permission requests - they run isolated Claude CLI.  
Main tmux sessions do receive permissions via hooks.

### 4. WebSocket vs EventSource

- **EventSource** used for HF SSE (read-only, automatic reconnect)
- **WebSocket** used for VNC proxy (bidirectional, manual handling)
- EventSource can't send headers (use query param for auth token)

### 5. WSL2 localhost Resolution (NAT vs Mirrored networking)

How WSL2 reaches Windows services (e.g. TightVNC on :5900) depends on the
`networkingMode` in `.wslconfig`:

- **NAT mode (default, legacy):** Windows is NOT reachable via `localhost`. Must
  resolve the host IP from `/etc/resolv.conf` (the nameserver = WSL virtual
  switch gateway, in the `172.16.0.0/12` range).
- **Mirrored mode (`networkingMode=mirrored`):** WSL shares the Windows network
  stack, so Windows services ARE reachable via `localhost`/`127.0.0.1`, and the
  `resolv.conf` nameserver IP is NOT routable (Connection refused).

`readVNCConfig()` resolves the right host automatically via `resolveVNCHost()`,
which detects the mode from the default route in `/proc/net/route` (gateway in
`172.16/12` => NAT => use resolv.conf IP; otherwise => mirrored => use
`127.0.0.1`). Explicit IPs in the VNC config pass through untouched.

```javascript
function isWSLMirroredMode() {
    // default gateway NOT in 172.16.0.0/12 (WSL NAT switch) => mirrored
}
function resolveVNCHost(host) {
    if (host !== 'localhost' && host !== '127.0.0.1') return host;
    return isWSLMirroredMode() ? '127.0.0.1' : (getWSLWindowsHost() || host);
}
```

> Migration note (2026-05-27): on the new laptop WSL runs in **mirrored** mode,
> so the old NAT-only resolution sent VNC to the unreachable resolv.conf IP
> (`10.255.255.254`) and TightVNC never connected. Fixed by mode detection.

### 6. Terminal Font Sizing

Font sizes stored as pixel values in JS, converted to `rem` for CSS:

```javascript
const sizeRem = (size / 16).toFixed(3) + 'rem';
```

### 7. CORS for Images

Image serving at `/images/:filename` has no auth - for `<img>` tags that can't send headers.

### 8. Terminal Scroll Lock

Smart scroll only happens if user hasn't scrolled up (checks `scrollTop`).

### 9. Vault Augmentation Caching

Prompt augmentation headers cached to avoid re-reading vault files:

```javascript
if (cwd !== lastAugmentedCwd) {
    lastAugmentedHeader = buildVaultHeader(projectName, cwd);
}
return lastAugmentedHeader + prompt;
```

### 10. Room CSS Not Unloaded

Room CSS files cached in DOM after first open - they're not removed even if you close the room. This reduces flicker but increases memory.

### 11. The public tunnel URL ROTATES on every server restart (silently)

> **Status: retired 2026-08-11. Binary DELETED 2026-09-08.** The quick tunnel is
> **opt-in** (`TUNNEL=1`), not opt-out, and remote access is the permanent Tailscale
> hostname in `REMOTE_URL`. The `cloudflared` code path is kept as an emergency fallback,
> but the 39 MB binary it runs is gone from the repo root - re-download it beside
> `server.js` before `TUNNEL=1` can do anything. Everything below is why it had to go -
> keep it, because the failure mode is invisible and cost real hours.

`startTunnel()` runs a Cloudflare **quick** tunnel
(`cloudflared tunnel --url http://localhost:3847`) - there is no `~/.cloudflared`
named-tunnel config. A quick tunnel mints a **new random hostname every time the
server starts**, so any previously-saved URL dies at the next restart.

This reads to the user as "I can only reach TSRCT on the same network / did
something break in security?" - it is neither. Two things make it silent:

- **ntfy is disabled** (`server.js:848` is a no-op, per the 2026-05-27 decision),
  so nothing pushes the new URL after a rotation.
- **`start.sh:40-44` prints it**, but only if you are watching that terminal at boot.
- Worst case: the **installed PWA's scope is pinned to the origin it was installed
  from**, so the app icon on the phone keeps opening a dead host.

**Diagnosis, in order:**

```bash
ps -o pid,lstart,etime,cmd -p $(pgrep -f "node server.js")   # did it restart?
TOK=$(grep -E '^BRIDGE_TOKEN=' .env | cut -d= -f2-)
curl -s -H "Authorization: $TOK" http://127.0.0.1:3847/api/status   # .tunnel = current URL
curl -s -o /dev/null -w "%{http_code}\n" https://<that-url>/        # 200 = tunnel healthy
curl -s https://<that-url>/api/status                               # 401 = auth gate intact
```

`/` returning 200 while `/api/status` returns 401 unauthenticated is the **healthy**
signature - it proves the tunnel works and the auth gate is doing its job, so the
problem is the URL the client holds, not the server.

Permanent fix is a stable public hostname (Tailscale Funnel, or a Cloudflare named
tunnel with an owned domain). See the 2026-07-31 Decisions Log entry.

### 12. The API auth header is the RAW token, not `Bearer <token>`

`isAuthorized()` (`server.js:312`) compares `req.headers.authorization` **verbatim**
against the token - it does not strip a scheme prefix. So:

```bash
curl -H "Authorization: $TOK"        ...   # works
curl -H "Authorization: Bearer $TOK" ...   # 401 unauthorized
curl -H "X-Auth-Token: $TOK"         ...   # 401 unauthorized
```

Also note the gate is asymmetric by design: the master `BRIDGE_TOKEN` authorizes
**only local, non-tunnel** requests (`isTunnelRequest()` detects the `cf-ray` /
`cf-connecting-ip` headers). Over the tunnel, only a post-2FA session token works -
so a `curl` that succeeds locally will correctly 401 through the public URL.

### 13. "Remote vs local" detection - was CLOUDFLARE-SPECIFIC, now default-deny (RESOLVED 2026-08-11)

> **Status: fixed.** `isTunnelRequest()` no longer exists; it was replaced by
> `isRemoteRequest()` (`server.js:332`), which is default-deny. The history below is
> kept because the *shape* of the bug is the lesson: a security boundary that
> identifies one vendor fails open for every other vendor, silently.

#### The bug as it stood

`isTunnelRequest()` was the whole basis for "is this caller remote?",
and it worked by sniffing two **Cloudflare** headers:

```javascript
return !!(req.headers['cf-ray'] || req.headers['cf-connecting-ip']);
```

Any other ingress - Tailscale `serve`/`funnel`, ngrok, a plain reverse proxy, an SSH
tunnel - sends **neither**, so the function returns `false` and every remote request
is classified **LOCAL**. Three guards are keyed to it, in ascending severity:

| Site | Guard | Effect if remote traffic reads as local |
|------|-------|------------------------------------------|
| `isAuthorized()` (now `server.js:339`) | accepts the master token only when the caller is not remote | The master `BRIDGE_TOKEN` alone authorizes every `/api/*` route - **2FA fully bypassed** |
| `/api/auth/enroll` (now `server.js:2523`) | local-only | Returns the **raw TOTP secret** - combined with the row above, one leaked token permanently defeats 2FA |
| `/session/{id}/refresh` (now `server.js:816`) | local-only | Matched **before** the `/api/` auth gate and has **no auth header by contract** - so it becomes reachable **with zero credentials** and it injects keystrokes into any pane |

(`server.js:3564` also branches on it to decide whether to pop the Windows splash
launcher; harmless, but it would fire for remote hits.)

**This is a migration blocker, not a theoretical note.** The network layer may get
*more* private (a tailnet is not the public internet) while these in-app guards get
*weaker* at the same time - and nothing logs the change.

#### What `tailscale serve` actually sends (measured, not guessed)

Rather than guess, a throwaway listener was put on a spare port, `tailscale serve` was
pointed **at the probe and never at the real server**, and the URL was opened from an
Android phone on mobile data with wifi off. Verbatim capture, 2026-08-11:

```
socket.remoteAddress  : 127.0.0.1
host                  : <machine>.<tailnet>.ts.net
tailscale-user-login  : leonlurk@github
tailscale-user-name   : Leon
tailscale-headers-info: https://tailscale.com/s/serve-headers
x-forwarded-for       : 100.86.137.32      <- peer's stable tailnet IP
x-forwarded-proto     : https
x-forwarded-host      : <machine>.<tailnet>.ts.net
-- old verdict: isTunnelRequest() == false  [!] treated as LOCAL
```

Two findings, one of them free value:

1. Not a single `cf-*` header, exactly as predicted - the old guard failed open.
2. `tailscale serve` supplies **verified caller identity**. `tailscaled` sets the
   `Tailscale-User-*` headers itself and strips any the client tries to send, so unlike
   anything Cloudflare offered, they are trustworthy. Not used yet - see below.

#### The fix

The server binds `127.0.0.1` (`BIND_HOST`, `server.js:152`), so **every** connection -
local hook or proxied remote - arrives with `socket.remoteAddress == 127.0.0.1`. The
socket carries no signal whatsoever; headers are the only evidence available.

So the question was inverted from "is this Cloudflare?" to "did this pass through
anything at all?":

```javascript
const PROXY_HEADERS = [
    'cf-ray', 'cf-connecting-ip',                      // Cloudflare
    'tailscale-user-login', 'tailscale-headers-info',  // tailscale serve/funnel
    'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded',
];
function isRemoteRequest(req) {
    for (const h of PROXY_HEADERS) if (req.headers[h]) return true;
    return false;
}
```

This fails **closed**: an ingress nobody has met yet still classifies as remote, because
every reverse proxy in existence sets at least one `x-forwarded-*`. Do not narrow it back
to one vendor's headers.

`clientIp()` (`server.js:291`) had the same disease and was fixed alongside it. It read
`cf-connecting-ip` and otherwise fell back to `socket.remoteAddress` - which is always
loopback, so over any non-Cloudflare ingress **every device collapses into one
rate-limit bucket** and one device's failed logins lock out all of them. It now also
reads the first hop of `x-forwarded-for`.

#### Verification (run this after touching the boundary)

Local curl reproduces both sides without exposing anything - forge the header to
simulate an ingress:

| Request | Expected |
|---------|----------|
| `/api/status` + master token, no proxy headers | `200` |
| `/api/status` + master token + `X-Forwarded-For` | `401` |
| `/api/status` + master token + `Tailscale-User-Login` | `401` |
| `/api/status` + master token + `CF-Ray` | `401` |
| `/api/auth/enroll` + master token, no proxy headers | `200` + raw TOTP secret |
| `/api/auth/enroll` + master token + `X-Forwarded-For` | `401` |
| `/session/{id}/refresh`, no proxy headers | reaches handler (`400` on empty body) |
| `/session/{id}/refresh` + `X-Forwarded-For` | `403` |

All eight confirmed passing 2026-08-11, then re-confirmed end-to-end over the live
tailnet (`/` -> 200, `/api/status` + master token -> 401).

#### Still open

- `/session/{id}/refresh` remains **unauthenticated by contract** and is matched before
  the `/api/` gate, so `isRemoteRequest()` is the *only* thing in front of an endpoint
  that injects keystrokes into any pane. Correct today, but it is one guard deep.
  Requiring the master token would need the hook call sites updated in lockstep.
- The verified `tailscale-user-login` identity is not consumed anywhere. Trusting it
  could drop TOTP entirely for tailnet callers - deliberately NOT done, since it would
  make the tailnet the sole authentication factor.

---

### 14. `powershell.exe` does NOT resolve from the server process (it did in your shell)

WSL appends the Windows `PATH` for **interactive/login** shells. `server.js` is started
detached by `boot-server.sh`, so its `PATH` contains no `System32` and every
`spawn('powershell.exe', ...)` fails `ENOENT` - even though the exact same command works
when you type it in a terminal. That mismatch is what makes this expensive to debug.

It bit `/api/restart` in the worst possible way. With `{splash:true}` from a local caller
the handler chooses `relaunch`, hands off to `launch-tsrct.ps1`, and then calls
`process.exit(0)` **unconditionally**. The spawn error was swallowed by
`child.on('error', () => {})` and `spawn`'s ENOENT is asynchronous, so it could not have
fired before the exit anyway. Net effect: pressing Restart on the desktop killed TSRCT
and nothing brought it back.

Fixed 2026-08-11 by resolving the absolute path **before** committing to `relaunch`:

```javascript
const PS_CANDIDATES = [
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',
];
function findPowershell() { /* first one that exists, else null */ }
```

`psBin` is now part of the `relaunch` condition, so a machine without PowerShell degrades
to a plain respawn instead of dying, and the `catch` falls back to `respawn()` too.

**Rule for any future Windows interop from the server: use an absolute `/mnt/c/...` path,
never a bare `*.exe`.** And never `process.exit()` after a hand-off you have not proven
succeeded.

---

### 15. The splash progress bar is tied to a log marker - retiring a subsystem can hang it

`launch-tsrct.ps1` drives its progress bar off **boot-log milestones**, and its
"we're done" signal used to be the cloudflared URL regex:

```powershell
if ($log -match $tunnelRe) { $script:result = 'tunnel'; Finish }
elseif ($portOpen -and $elapsed -ge 45) { $script:result = 'port'; Finish }
```

Retiring the tunnel would therefore have left **every single launch** creeping to the
45-second `elseif` fallback - the app would still work, so this reads as "TSRCT got
slow", not as "a regex stopped matching". Nothing errors, nothing logs.

Fixed by giving the server an explicit readiness marker instead of inferring one:
`server.js` now prints `[READY] TSRCT listening on ... | remote: ...` as the last line
of its `listen` callback, and the launcher matches `$readyRe = '\[READY\]'`.

Note the marker prints while the dispatcher's async warmups (hermes, slack, clickup) are
still running. That is deliberate: it means "port open, app usable", which is what the
splash is promising.

**When you retire a subsystem, grep for whatever else keyed off its output** - log
scrapers are invisible coupling and they fail quiet.

---

### 16. Mobile modals: `.modal` is capped, `.modal-body` is the scroll region (2026-08-13)

`.modal` (`main.css`) had no `max-height`, so any modal holding a variable-length list
just grew with it. With 18 tmux sessions on a 390x844 viewport the TMUX SESSIONS modal
measured **1351px tall, top at -253px and bottom at 1098px** - the header off the top of
the screen, `+ NEW SESSION` and `CANCEL` off the bottom, and nothing scrollable. The two
actions the modal exists for were unreachable.

The shared primitive now carries the constraint, so every modal gets it:

```css
.modal      { display: flex; flex-direction: column;
              max-height: calc(100vh - 40px);
              max-height: calc(100dvh - 40px); }   /* overlay pads 20px */
.modal-body { overflow-y: auto; overscroll-behavior: contain; }
```

Header and any footer buttons stay pinned; only `.modal-body` scrolls. Use `dvh`, not
`vh` - `100vh` is the *pre-collapse* height on mobile, so a `vh` cap still parks the
footer behind the browser chrome. Modals that need a tighter cap (`.gallery-modal` 80vh)
still win by coming later in `main.css`; the ones that used to hand-inline
`max-height:80vh;overflow:hidden;display:flex;flex-direction:column` no longer need to.

**Do NOT add `min-height:0` to `.modal-body`, or `flex-shrink:0` to its rows.** Those are
the reflex flex-scroll fixes and both are inert here, verified by running the layout with
each removed: an `overflow-y:auto` element is already a scroll container, so its automatic
minimum size resolves to `0` and its children never compress. `min-height:0` is only
needed on a flex item that is *not itself scrollable*.

`.session-picker-list` (the status-bar session picker, `terminal.css`) was never broken
for the same reason - its `.session-picker-content` already capped at 60vh. It gained the
themed scrollbar and `overscroll-behavior: contain` only.

**Verifying modal CSS without the PWA:** it is behind 2FA, so render the real CSS + real
markup headlessly - but **inside a `<iframe style="width:390px">`**, because Chrome refuses
a window narrower than ~485px and silently lays out at 485 then crops, which reads as an
overflow bug that isn't there. Measure `getBoundingClientRect` + `scrollHeight` before and
after **and** screenshot it; a modal can pass every numeric check and still look wrong.
Harness: `~/headless-chrome/tsrct-modal-check.mjs <sessionCount>`.

---

### 17. `.room` must paint its own background (it did not, and 6 of 8 rooms were see-through)

`rooms-base.css` `.room` is `position:fixed; inset:0; z-index:200` — but it had **no
`background`**. Occlusion came from a separate `.room-bg` gradient div, and only the
**remote** and **sfcli** rooms ever included one. Every other room (lurk, studio,
playlist, runners, cockpit, dispatcher) let the app show through: the header ghosted
under the room header — `.room-header` is a translucent white gradient with
`backdrop-filter: blur(10px)`, so it blurs whatever is behind it — and the terminal and
quick bar showed through the body.

Fixed at the base class (`background: var(--bg)`); rooms with a `.room-bg` paint their
gradient over it. **A new room no longer needs to remember anything.**

### 18. The navy theme is SCOPED, and only the toggle persists it

`variables.css` defines the palette on `body.theme-navy, .theme-navy`. The bare class is
what lets a room or a PC panel be navy **on its own**:

- `lurk.js` / the Catalog room add `theme-navy` to their **mount container**, and remove
  it on unmount. They used to repaint `document.body` and never undo it, so the theme
  leaked into the whole app after the room closed — and because nothing persisted it, a
  refresh reverted to green. That is what "the theme doesn't save" actually was.
- The **only** persistent switch is `toggleNavyTheme()` (`localStorage.navyTheme`,
  restored in `app.js` on load). It is on the PC sidebar and — since 2026-08-13 — on the
  mobile **TOOLS** quick-grid.

**Quick-bar budget:** `.quick-grid` is 5 columns. CLAUDE and TERMINAL hold exactly 15
buttons = 3 full rows, and the tabs are meant to be the same height, so adding a button
there costs a whole row. TOOLS had 9; NAVY made it 10. Check the count before adding.

### 19. Touch feedback is delegated, not per-handler

Sound used to be whatever each `onclick` remembered to call, so most of the quick bar,
the rooms and the modals were silent. One delegated `pointerdown` listener in `main.js`
(`initPressFeedback`) now covers `button, .quick-btn, .modal-btn, .modal-close,
.session-picker-item, .btn, [role="button"]` on **coarse pointers only**.

- `pointerdown`, not `click` — the feedback lands on the press. It also serves as the
  AudioContext unlock gesture, so the first sound of a session is not swallowed.
- It plays `press`, the quietest voice in the set, so a control that also plays an
  outcome sound (`send`, `approve`, `error`) layers a tick under it instead of doubling.
- Opt out with `data-nopress` on the element.
- The visual half lives in `base.css` under `@media (pointer: coarse)`: `:active` gets
  `transform: scale(.955)` + `filter: brightness(1.4)` — transform/filter only, so
  nothing reflows under a thumb.

**Sound gotcha worth keeping:** `tap` was an 18 ms **bandpassed** noise burst at 2.6 kHz
and read as a woodblock on a phone — that band is where a phone speaker resonates, and it
sounds fine on a laptop, which is why it shipped. Filtered noise in the low-mids is the
same mistake that made the old `send` a raspberry. Measure with `OfflineAudioContext`
(harness: `~/headless-chrome/tsrct-sound-check.mjs`) and compare energy in 1.5–3.5 kHz
against above 5 kHz; the rebuilt tap moved that ratio from **0.33 to 4.9**.

### 20. Prompt drafts persist; the biometric gate has a grace window on BOTH paths

`localStorage.tsrct_draft` holds whatever is typed in `#prompt` / `#fs-prompt` (debounced
200 ms, the two inputs mirror each other). It is cleared only by a **successful** send
(`clearPromptDraft()`, exported on `window` for `gallery.js`'s fullscreen send) or by the
user emptying the box — an empty input is a deliberate discard, not a candidate for
restore.

The biometric gate has two entry paths and they need the same policy:

| Path | Where | Trigger |
|------|-------|---------|
| Resume | `webauthn.js` `visibilitychange` | app was backgrounded and came back alive |
| Cold start | `app.js` `biometricGate()` | the PWA was **killed** while backgrounded — the common case on Android |

The resume path always had a 30 s grace; the boot gate had none, so a two-second glance
away or a pull-to-refresh cost a fingerprint. `webauthn.js` now stamps
`localStorage.tsrct_last_seen` on a 10 s heartbeat while visible and on hide/`pagehide`,
and the gate skips the lock inside `RELOCK_AFTER_MS`. **Keep the two windows in sync.**
A missing stamp still locks — a first open, or cleared storage, is a real open.

### 21. Auto-approve uses a HUD, not the generic toast

`autoApproveNotice(p)` (`main.js`, styles `.auto-hud` in `main.css`) replaced
`toast('Auto-approved')`. It reports **what** was approved (`tool · session`), counts a
burst in place (`×N`) instead of flashing repeatedly, and dismisses on a visible drain
bar. Colour is deliberate: **cyan = the system acted on its own, green stays "you did
that."** Fields come off the wire, so they are written with `textContent`.

---

### 22. Desktop shell: surface registry, rail sidebar, window roles (2026-08-14)

**Surfaces.** `SURFACES` in `desktop.js` maps a tab id to
`{title, el, css, init, teardown, where}`. `pcSwitchTab()` is a loop over it: teardown
the previous, hide every panel, show + lazy-load + init the requested one. It replaced a
170-line if/else that named nine panel ids in four places each. **Adding a panel = one
registry entry** (plus its markup and a rail/tab button). `terminal` is deliberately the
only surface with no `el`: it restores the main/split sub-view instead.

**Sidebar = rail + one panel.** A permanent 44px icon rail, one section open at a time,
draggable width, collapsible to rail-only (**Ctrl/Cmd+B**). The five sections keep their
original markup and ids, so every existing handler still works — only the container
changed. Width lives in `--sidebar-w`:

```css
grid-template-columns: var(--sidebar-w, var(--sidebar-w-default, 220px)) 1fr;
```

Breakpoints set `--sidebar-w-default`; a drag sets `--sidebar-w` on `:root`, which is
inherited and wins. **Do not put a literal width back into `grid-template-columns`** — the
breakpoint would then override a user drag at 1200/1600px.

**Cables anchor to the rail.** `pcCableAnchor()` prefers the visible session item, then a
visible group header, and finally **the rail's Sessions icon** — the one element that is
always on screen. That is why the rail is permanent: a cable can no longer be orphaned by
a closed panel or a collapsed sidebar.

**Session ordering.** `/api/dispatcher/session-states` (which only `session-voice` used to
consume) drives `pcSessionRank()`: `waiting_input`/`failed` first, then `working`, then the
rest. The sort is stable, so equal-rank sessions do not jitter. Refreshed every other 3s
tick. **Dispatcher off = every rank equal = previous order, no error.** Attention is marked
with a BACKGROUND, never `border-left`: the item carries an inline `border-left` holding the
user's colour identity and no stylesheet can override it.

**Preference scope** — `pcPrefGet/pcPrefSet(key, value, scope)`:
`window` → `sessionStorage` (this window's own state; the default), `browser` →
`localStorage` (a taste that follows you), `server` → the `config` table. Scope is a
per-window vs per-browser decision, not a durability one — see gotcha 20.

**Window roles** (`src/js/windows.js`): `full` (default) · `deck` · `focus` · `wall`.
Roles are not tied to a screen; `pcSwapRoles()` exchanges them over the existing
`BroadcastChannel('tsrct-windows')`, and because surfaces are mountable this is a re-mount,
not a reload. `pcExpandToScreen(role)` opens a second window on the OTHER monitor using
`GET /api/vnc/monitors` (the real Windows rects, already there for the VNC crop) — **no
`window-management` permission required**. Two constraints that are not negotiable:

- **It must run from a click.** `window.open` without a user gesture is blocked, which is
  also why a saved layout cannot restore itself on load.
- **Windows coordinates are not CSS pixels.** At 150% DPI they differ by 1.5x. The code
  calibrates by finding the scale that puts the CURRENT window inside a reported screen,
  and re-reads `screenX` after `moveTo` to confirm the window landed — never assume it did.

### 23. Sidebar focus mode + per-folder split groups (2026-08-24)

The sidebar tree grew faster than the number of live tmux: 22 folder rows around 4 sessions.
Two additions, both in `desktop.js` / `desktop.css`, both frontend-only (`sw.js` → `tsrct-v291`).

**Focus mode** — `[F]` in the Sessions header, `Desktop.focusMode`, persisted with
`pcPrefSet('pcFocusMode', …, 'window')`. `pcRenderGroupTree()` does two things when it is on:
drops any folder whose subtree holds **zero living tmux**, and folds a folder that holds
*nothing but one live sub-folder* into the next header's breadcrumb (`Internal / Marketing /
Verde Soap`). Measured against the real tree: **22 folder rows → 3, all 4 sessions kept.**
Three constraints worth knowing:

- **No blur, no dimming.** What is irrelevant is not in the DOM. A `filter` pass over a live
  sidebar costs a composite every 3s poll; deleting rows costs a repaint that was happening
  anyway.
- **`collapsed` is still honoured.** Focus mode does not force-expand — a folder you folded
  stays folded, so the two controls compose instead of fighting.
- **A folded folder still has to be findable.** `pcCableAnchor()` walks up the group tree to
  anchor a split cable; a folded ancestor has no element left, so the breadcrumb header
  carries `data-chain="id1 id2"` and the anchor falls back to `.pc-group[data-chain~="id"]`.

**Per-folder split groups** — any folder with **2+ living tmux under it** shows `[Split]` /
`[Unsplit]` on its header, and each armed folder becomes a chip in `#pc-split-chips` above the
terminal. One click on a chip swaps the whole split — panels, focus and the layout you dragged.

- `Desktop.splitGroups = { [groupId]: {sessions, activeIndex, bounds} }`, `''` = the manual
  checkbox selection, so the old `[Split]` button rides the same machinery.
- `Desktop.combined.groupId` names who owns what is on screen.
- **Storage is `sessionStorage`, and every entry is pruned against the live tmux list on each
  sidebar refresh** (`pcSplitGroupsPrune`). A group outlives a PWA reload and never outlives
  its sessions. Nothing about a folder split reaches `localStorage` or the `config` table.
- **The snapshot hangs off `pcSplitSave()`**, not off its callers. Resize, focus, rename and
  add/remove panel all already funnel there — a new call site cannot forget to save.
- **Ordering trap, and it is the one real bug in this feature:** when prune kills the group
  that is on screen it must clear `Desktop.combined.groupId` **before** calling
  `pcCombineDisable()`. Disable saves on the way out, and a save re-creates the group it just
  pruned — dead session names and all.

Chips live OUTSIDE `pc-combined-wrap` on purpose: that wrap is `hidden` in single view, and
getting *back* into a split from single view is the whole point of the bar.

**Split panels now default to `XL`**, not `M` (`pcCreateCombinedPanel`). `pcPanelFontSizes` is
in-memory only, so this is the default for every panel unless you click S/M/L on that panel.

**A row selects a SESSION, a chip selects a GROUP (2026-08-24, `tsrct-v295`).** Clicking a session
in the sidebar used to call `pcSwitchSession()` only — which sets `homeSession` and refills the main
terminal *while that terminal is `hidden` behind the split*, so from a split view the click looked
like it did nothing. `pcSidebarItemClick()` now leaves the split when one is on screen:

```javascript
if (Desktop.combined.enabled) { pcCombineDisable(name); return; }
```

`pcCombineDisable(nextSession)` gained that one optional argument, and it is the whole fix — the
function ends by calling `pcSwitchSession(sessions[activeIndex])`, so calling it and *then* switching
would have landed you on the focused panel instead of the row you clicked. With no argument it keeps
its old meaning, which is what `[Unsplit]` and `[single]` need. It also suppresses its own
`Single view` toast when a session was named, because `pcSwitchSession` already said `→ name`.

**Nothing is lost on the way out:** `pcCombineDisable` opens with `pcSplitSave()`, and
`pcSplitSave()` ends with `pcSplitGroupCapture()` — so the group keeps its panels, its focused panel
and the divider you dragged, and its chip brings all three back in one click. The three ways in stay
symmetric with the one way out: **chip / folder `[Split]` / the `[Split]` button open a group, a
session row opens a session.**

Verified by running the real extracted functions (`~/headless-chrome/tsrct-sidebar-single-check.mjs`,
25/25): clicking a session outside the split, clicking one that IS a panel of it (lands on the
clicked one, not the focused one), the chip round-trip restoring bounds byte-identical, two armed
groups surviving the exit, a drag that ends on a row not collapsing anything, and `[single]` with no
argument still landing on the focused panel.

---

### 24. Claude Code's TUI shape lived in THREE copies, and one release blinded all three (2026-08-25)

**Symptom:** the one-click handoff sat on `[>] waiting for idle...` forever and nothing happened.
Reported as a side effect of the split-panel work. It was not — the panel changes are unrelated.

**What actually happened.** Claude Code shipped a new composer. Before, the input box was a rounded
frame with a hint line:

```
╭─────────────────────────────╮
│ >                           │
╰─────────────────────────────╯
  ? for shortcuts
```

Now it is a `❯` line fenced by two full-width rules, with a statusline and a mode line under it:

```
────────────────────────────────────────────────────────────────
❯ ya te lo paso, dame un minuto
────────────────────────────────────────────────────────────────
  [5h 9%] [7d 41%] [ctx 14%] Opus 5 · ledgerly-quirks
  ⏸ manual mode on · ← for agents
```

The spinner changed too: `⠋⠙⠹ … (esc to interrupt)` became `✢ Forging… (6m 7s · ↓ 27.7k tokens)` —
**no braille glyph, no "esc to interrupt", and the ellipsis is `…` (U+2026), not three dots.**

Those two shapes were hardcoded in three separate places, and all three went blind the same day:

| Copy | What it broke |
|---|---|
| `lib/sessionWeight.js looksLikeClaudePrompt()` | The handoff's step (a) refused every session: `handoff aborted: this session is not sitting at a Claude prompt - nothing to compact`. |
| `server.js paneWorkState()` | **The dangerous one.** `waitPaneIdle()` read two actively-working panes as idle. That is the exact failure the idle contract exists to prevent — a `/compact` or a paste mid-turn corrupts the session. |
| `lib/dispatcher/outputParser.js looksLikeWorking()` | TOWER's `working` verdict fell back to the capture-diff heuristic alone (it survived by luck, not design). |

**The fix is structural, not a regex patch:** `lib/paneShape.js` is now the only file that knows what
a Claude pane looks like (`looksLikeWorking`, `looksLikeClaudePrompt`, `looksLikeShellPrompt`,
`tailOf`). Zero dependencies, so `sessionWeight.js` and `server.js` require it standalone — same
contract as `restrictedGuard.js`: a boundary must never reach its check through an optional subsystem.
`scripts/check-paneshape.js` (in `npm run check`) holds verbatim tails from both TUI generations and
also greps the three call sites to catch a private copy of the regexes coming back.

**When Claude Code changes its TUI again: ADD the new shape, KEEP the old one.** Both builds run on
this machine at once — a pane started before the upgrade is still the old binary.

**A second, independent bug hid the first.** `src/js/session-weight.js poll()` read the row for the
*currently selected* session and skipped `showProgress()` whenever `handoff.done` was true. Both
halves hid the ending: on success the server **deletes** the weight row (so there is no row to read),
and on failure the row survives but `done` is true (so the guard skipped it). The handoff had aborted
three seconds in; the bar just froze on the last phase it happened to catch, with every button
disabled, until the tab was closed. `sessionWeight.all()` now reports a handoff independently of the
weight row and reaps it 2 minutes after it ends, `poll()` follows the session the handoff was started
*for*, and a failure toasts its real reason instead of the word "failed".

**The lesson worth keeping:** a progress display must render TERMINAL states above all others. The
only state it refused to draw was the only one that mattered.

**Round two, same day — `still running` was answering the wrong question.** Four handoffs succeeded,
then `piel-2` hung on `waiting for idle...` again. Different marker: the new TUI reports a
`&`-backgrounded shell in two places and keeps reporting it for as long as that shell lives —

```
✻ Cooked for 42s · 1 shell still running        <- the END-OF-TURN line
────────────────────────────────────────
❯ ok mientras tanto, escuche la mezcla
────────────────────────────────────────
  ⏸ manual mode on · 1 shell · ← for agents     <- the MODE line
```

The turn is **over** (`Cooked for 42s`); a shell simply outlived it. The inherited
`/\bstill running\b/i` rule read that as mid-turn, so `waitPaneIdle()` burned its full 180s timeout
on a pane that was sitting at its prompt the whole time — and it could never have succeeded, because
the counter does not go away. The rule asks whether a BACKGROUND process is alive; the idle contract
needs to know whether the TURN is alive. A background shell does not stop you typing into the
composer, so it must not stop TSRCT either. `paneShape.looksLikeWorking()` now strips the counter
before matching.

But the shell is still worth *knowing* about, and that is a **separate question with its own
answer** (`paneShape.backgroundShells()`): step (f) kills the old session, which kills the shell with
it. Whether that matters is the user's call, so `runHandoff()` gained a **pre-flight step (0)** that
refuses immediately — `1 background shell still running - retiring this session would kill it. Stop
it (or let it finish) and try again` — instead of deciding either way. It runs FIRST, before
anything that waits: making someone watch a 3-minute timeout for a verdict you already have is its
own kind of lie.

---

### 25. The monitor crop clipped at the CONTAINER, not at the crop (2026-08-28)

Two complaints, both dating from the day a second monitor was plugged in, and both
real. Leon drives this from a phone in a plastic bag in the shower, so remote desktop
is not a nice-to-have — it is the only way in.

**The strip.** `rdApplyCanvasLayout()` leaves the canvas holding the WHOLE framebuffer
and translates it so the wanted monitor lands inside the container. The leftovers were
being hidden by `.rd-canvas-wrap`'s `overflow: hidden` — **which cuts at the container
edge, not at the crop edge.** Whenever the crop's aspect differs from the container's,
centring leaves a band inside the container, and that band is filled by the
*neighbouring monitor* rather than black.

Measured on the real layout (`GET /api/vnc/monitors`: monitor 1 at `0,0 1707x1067`,
monitor 2 at `-1920,368 1920x1080`, framebuffer `5440x2172`) in landscape at 844x390:

| | band | of which monitor 2 | dead framebuffer |
|---|---|---|---|
| before | 42,900 px (13% of screen) | 28,160 px (8.6%) | 14,740 px |
| after | 0 | 0 | 0 |

Fixed with `clip-path: inset(...)` computed from the crop rect. **`clip-path` was chosen
over an intermediate wrapper div for one specific reason: it does not change layout
geometry**, so `getBoundingClientRect()` still returns the full element box and
`rdScreenToVNC()` / `rdCacheCanvasRect()` keep mapping against the whole framebuffer
with zero changes. Verified: the box reads 1325.16x529.09 identically before and after,
in all four cases. When every monitor is selected the clip is `none`, so the feature is
inert unless you are actually cropping.

**The pointer got 35.3% faster, and the old number was a bug.** Before the crop existed,
`rdCacheCanvasRect()` measured the canvas ELEMENT box while `object-fit: contain`
letterboxed the picture inside it — scaling against 844px of element when the picture
occupied 623. So a finger pixel moved the cursor 0.7389 screen pixels; the crop made the
maths honest and it became exactly 1.0000. Honest, and not what Leon liked.

The fix is therefore **not** a revert but a `Speed` slider in the quality panel,
defaulting to **0.74x**, which reproduces the old feel to within 0.15%. The number he
liked is now an explicit preference instead of an accident.

**The stutter is NOT diagnosed — do not let this section imply it is.** The canvas
backing store went 15.6 MB -> 45.1 MB (2.9x the area). The magnifier's `drawImage`, which
runs on every animation frame while a finger is moving, measured **18.8x slower, not
2.9x**. That superlinearity is the interesting part: it points at a threshold being
crossed rather than a proportional cost. The concrete suspicion is that **5440px exceeds
the 4096 texture limit common on phone GPUs**, past which Chrome rasterises the canvas in
software — which would explain a jump between "perfect" and "unusable" rather than a
gradual decline. **This was measured headless on WSL, not on the phone, so it is evidence
and not proof.** The 10-second test that settles it: Win+P -> "PC screen only",
reconnect, see whether it is smooth again. If it is, the answer is to shrink the desktop
while working from the phone (`DisplaySwitch.exe /internal`, absolute `/mnt/c/...` path
per gotcha 14) — which also drags every window onto the visible screen.

**Moving a window off the monitor you cannot see** does not need drag detection: Windows
already does it with **Win+Shift+Left/Right**. `rdPullWindowHere()` derives the direction
from the monitor rects (monitor 2 sits to the LEFT here, so from monitor 1 it sends
Win+Shift+Right) and the button only renders when there are 2+ screens and one is
selected — it can never be a dead button.

#### SOLO — `POST /api/vnc/display` (2026-08-28)

The crop is cosmetic: the phone still allocates and paints a canvas the size of the whole
virtual desktop either way. **Turning the other screen off is the only lever that shrinks
the framebuffer itself**, and it drags every window onto the screen you can see, which is
the other half of why it exists.

`{ mode: 'solo' | 'extend', keep: '<label>' }`. Driven by `rdToggleSolo()` from a toolbar
button that appears when there are 2+ screens, and stays visible while collapsed so there
is always a way back.

**`DisplaySwitch.exe` takes a MODE, not a monitor id**, so it cannot be told "keep the one
being watched" — `/internal` and `/external` describe which port a display hangs off, which
is not the same question as which one is primary or which one you are looking at. So the
mode is **tried and the result verified**, with the other mode as a second attempt and
`/extend` as an auto-revert. Pressing this from a phone in a bathroom must never be able to
leave the machine showing the screen you cannot see, with no way back.

Three pure helpers carry the decisions so they are testable without switching anyone's
displays (`~/headless-chrome/tsrct-rd-solo-check.mjs`, 17/17):

| helper | question |
|---|---|
| `soloModeOrder(keep)` | which mode to try first — `/internal` for a primary, else `/external` |
| `soloAmbiguous(screens, keep)` | are two panels identical, making geometry unable to verify? |
| `soloKept(after, keep, ambiguous)` | did we land on exactly the screen we asked to keep? |

Four things that are load-bearing:

- **`readWindowsScreens(force)` skips its 10s cache** after a topology change, or the crop
  is computed against the layout that existed ten seconds ago.
- **The route is async** (`execFile`, not `execFileSync`). It blocks for seconds, and a sync
  spawn here would freeze the terminal poll, the permission queue and every other session.
- **Windows applies the change AFTER the call returns**, so there is a 1.8s settle before
  re-reading — an immediate read verifies the OLD layout and reports a false success.
- **`solo` is reported by the SERVER**, from `config.monitorPreSolo`, not inferred from
  counting screens. After a PWA reload the client sees one screen and cannot tell "I
  collapsed it" from "this machine only has one" — and it must, or the button that puts the
  other screen back disappears. The pre-solo crop selection is restored on `extend`.

**One real limit.** With two *identical* panels, geometry cannot verify which one survived;
the response carries `ambiguous: true` and the toast says so rather than claiming a check
that did not happen.

**And one correction to this section.** It originally warned that restoring extended would
leave your windows piled on one screen, because Windows "moved them and does not remember".
**That is wrong** — tested live 2026-08-28: Windows restores the previous per-monitor
arrangement on the way back, which also undoes a `rdPullWindowHere()` pull. So SOLO is a
clean round trip. Recorded as observed behaviour of this Windows build on this machine, not
as a guarantee across versions — but do not repeat the old warning, it cost the feature a
caveat it never had.

Harnesses, all running the real functions extracted from the file:
`~/headless-chrome/tsrct-rd-crop-check.mjs` (14/14, **with a positive control** — the
"before" variant must still leak 28,160px, or the comparison passes vacuously; each
variant writes its own PNG, per the before/after-diffing-itself trap),
`tsrct-rd-mouse-check.mjs`, `tsrct-rd-panel-check.mjs` (18/18 at 320/390/430/844px,
inside an iframe because Chrome lies below 485). `sw.js` -> `tsrct-v301`.
**Frontend only: PWA reload, no server restart.**

---

### 26. Mobile data: the app cost ~45 MB/hour idle, and audio cost 691 MB/hour (2026-08-29)

Leon asked whether TSRCT eats his mobile data away from the house. Measured against his
live sessions, yes — badly, and almost none of it was doing anything useful.

**A `sendJson()` written for exactly this problem had ZERO call sites.** `server.js:652`
implements ETag→304 + gzip, and its own header comment documents the 2026-08-11
measurement it was built to fix (*"~71 KB each … 98 MB/hour of mobile data with the app
merely OPEN"*). It was defined and never wired. Grep for a helper's *call sites*, not its
definition, before trusting that a documented fix is live — this is gotcha-comment risk
in the other direction: the code existed and the behaviour didn't.

| Path | Before | After |
|---|---|---|
| `/api/output` (5s poll) | full 1000-row capture, uncompressed, every cycle | gzip (~3x) + **304, no body**, when the pane hasn't moved |
| `/api/status` (5s poll) | **a second full capture**, which the poller never renders | `output` is opt-in via `?output=1` |
| `/api/permissions` (500ms) | 7200 full bodies/hour | 304s |
| RD audio | raw PCM **48 kHz stereo = 691 MB/h**, same cost silent or not | preset (default 24 kHz mono) + **silence gate** |

**`/api/status` shipped a whole terminal that nothing on that code path read.** `poll()`
(`main.js`) calls it purely for `sessionExists` + `project`. Only three callers ever
wanted the capture — first paint in `connect()`, the no-session panel fallback
(`gallery.js`), the restart splash (`restart.js`) — and they now pass `?output=1`.

**The polls are not equal, and must not be throttled equally.** `poll()` STOPS while
`document.hidden`: terminal output nobody can see is worth nothing at any price.
`pollPerms()` only SLOWS (500ms → 3s), because approving a permission with TSRCT in the
background is what the product *is*. Stopping it to save data would have sold the feature
to pay for the bandwidth. `visibilitychange` fires both immediately on return.

Both loops now reschedule through `schedulePoll()`/`schedulePerms()`, which `clearTimeout`
first. That also fixed a latent duplicate: `connect()` called `poll()` directly while
`send()`/`sendKey()` each started their own `setTimeout(poll, …)`, so several full-freight
chains could run at once. `gallery.js` pokes the same two helpers.

**Silence is not free in raw PCM.** Leaving audio on with a silent PC cost exactly as much
as streaming a film. The gate (`SILENCE_FLOOR = 8`, about −72 dBFS; `HANGOVER_MS = 400`)
drops chunks under the noise floor and needs **no client change** — `rdAudioScheduleBuffer`
already resets its play head when it falls behind wall-clock, so a gap resumes without
drift. Verified against synthetic PCM: dither stays shut, −31 dBFS music opens it, rests
between notes are not clipped. A 15s WS ping keeps the idle socket off the proxy's reaper.

The client AudioContext is now built at the **device's** rate with the AudioBuffer
declaring the *stream's* rate (Web Audio resamples), because a hardware context can refuse
to be constructed at 8 kHz.

**The cost used to be invisible, which is how 691 MB/h went unnoticed.** The proxy counts
real bytes into `rdMeter`; `/api/vnc/status` reports them; the quality panel shows
`MB this session · MB/h · screen/audio split`. It polls **only while that panel is open** —
a meter running in the background would be one more thing quietly spending what it reports.

`rdRfb.compressionLevel` was **2** (near-raw — right on a LAN, wrong on mobile data), now 6.
That trades Windows-side CPU for bytes; drop it back toward 2 if the laptop runs hot.

Not done: **Opus would beat all of this by ~50x** (32 kbps ≈ 14 MB/h vs 173), but it
replaces the decode path with MSE/WebCodecs and could not be tested on Leon's phone from
here. The presets and the gate are the safe win; Opus is a follow-up to test together.
`sw.js` → `tsrct-v303`. **Server restart required** (server.js changed).

---

### 27. `npm audit` reads the LOCKFILE, and `npm audit fix` can lie about what it installed (2026-09-08)

The weekly audit row read `[!] 1 vulnerability(ies) … | node v24.16.0 | cloudflared 2026.7.3`,
which sent Leon looking at a subsystem retired on 2026-08-11. **The two halves of that
sentence were unrelated:** the verdict comes only from `npm audit`, and the versions after
it were context fields. The cloudflared field has been removed (see below); an environment
value must never share a sentence with a verdict it cannot cause.

The real finding was `qs` — moderate, reached as `@slack/bolt` → `express` → `qs`. **Not
exploitable here:** TSRCT's own server is plain Node with no Express, Bolt is started with
`socketMode: true` and `app.start()` with no port so it binds nothing, and `ss -lntp`
confirms only `127.0.0.1:3847` and ComfyUI's `8188` listen. Fixed anyway, because it was free.

**The part that will bite again:**

| What it claimed | What was true |
|---|---|
| `npm audit fix` → "found 0 vulnerabilities" | `node_modules/qs` was still `6.15.2` |
| `package-lock.json` | correctly rewritten to `6.16.0` |
| `node_modules/.package-lock.json` (npm's own bookkeeping) | **also said `6.16.0`** |
| two further `npm install` runs | "up to date", installed nothing |
| `npm audit` | **0 vulnerabilities**, because it reads the lockfile, not the tree |

npm recorded an install that never replaced the files (seen on `/mnt/c`), then trusted its
own record forever after. The only honest probe is
`node -p "require('./node_modules/qs/package.json').version"`. The cure is
`rm -rf node_modules/<pkg> && npm install`, after which the disk read `6.16.0` and
`require.resolve('qs', {paths:['./node_modules/express']})` resolved to it.

**Verify a dependency fix on disk, never from the audit's own summary.** This is gotcha 26's
`sendJson()` lesson inverted: there the code was live and the behaviour was not; here the
record said installed and the bytes said otherwise.

**Also removed:** the 39 MB `cloudflared` binary (untracked, gitignored, not running, no
`~/.cloudflared` credentials). The `TUNNEL=1` path in `server.js` **stays** as the emergency
fallback — its `accessSync` guard was already real, so it now logs that the binary was
deleted and how to re-download it. The `.gitignore` rule stays too, so an emergency
re-download cannot land 39 MB in a commit. `@slack/bolt` 4.7.3 → 5.1.0 was left alone: a
major bump on a working Slack sensor is not audit cleanup.

No frontend file changed, so **no `CACHE_NAME` bump**. **Server restart required** for the
patched `qs` to be the copy in memory.

---

### 28. `jq`'s `//` treats FALSE as absent, so a verdict of `false` became `true` (2026-09-08)

The [PB] Stop gate measured every answer correctly and then passed all of them. One line:

```bash
OK="$(printf '%s' "$RESULT" | jq -r '.ok // true')"     # WRONG
```

`//` is jq's *alternative* operator and it falls through on **`null` AND `false`** — so
`false // true` is `true`. The checker was returning `{"ok": false, "words": 90, ...}`, exactly
right, and the shell read it as a pass. Nothing errored; the hook exited 0 like a clean answer.

```bash
OK="$(printf '%s' "$RESULT" | jq -r 'if has("ok") then (.ok | tostring) else "true" end')"
```

**Never use `//` to supply a default for a value that can legitimately be `false`.** Numbers are
fine (`0` is truthy in jq, so `.attempts // 0` behaves), strings are fine; booleans are the trap.
`scripts/check-plainbrief.js` greps for the pattern coming back — with comment lines stripped
first, because the fix is documented in that same file and matching the explanation of a bug as
the bug is its own false alarm.

**The wider shape, and it is the third time in this repo:** a boundary that reports a refusal
through a channel that cannot express refusal. Gotcha 13's `gitCwd` threw where the catch answered
`{success:true}`; §14.24's progress bar refused to draw its terminal states; here a `false` was
laundered into `true` by an operator that means "or if missing". **A guard is only as good as the
path its verdict takes home** — and the only reason this one was caught is that the end-to-end test
asserted the *exit code*, not that the checker's own numbers looked right.

---

### 29. A harness that measures before the webfont settles fits your fix to noise (2026-09-08)

While checking whether the new `[PB]` button costs the mobile status bar a row, a `max-width` sweep
produced this:

```
vw=40  320:35   vw=36  320:61   vw=32  320:61   vw=28  320:35   vw=24  320:61
```

Non-monotonic, which is impossible for a width cap — a *narrower* cap cannot need *more* room. The
stability check settled it: the **same** configuration measured `35 61 35 61 61` across five runs.
The bar is set in JetBrains Mono, loaded from Google Fonts, and the harness was reading
`getBoundingClientRect()` before the face had arrived. A cap chosen from that sweep would have been
a number fitted to noise, defended with a table.

Three fixes, all needed:

1. **Load the real font and wait for that specific face** — `await d.fonts.load('500 0.65rem
   "JetBrains Mono"')`, then `d.fonts.ready`, then `d.fonts.check(...)` as a **hard fail**. A
   harness that silently falls back to a different font reports the wrong widths confidently.
2. **Wait for the iframe's own `load` event** before touching `contentDocument` — `srcdoc`
   navigations are async, so an immediate read can measure the *previous* document, and
   `fonts.ready` on a stale document resolves instantly.
3. **Settle**: re-measure across `requestAnimationFrame` until two consecutive frames agree.

Then run it twice and diff. **A measurement you have not seen repeat is not a measurement** — same
family as invariant 47 (verify the version on disk) and the crop harness's positive control.

**And the row count was wrong too.** Counting distinct child `top` values reported **3 rows** for a
single row, because items of different heights are vertically centred and so start at different
tops. Group the tops into bands the height of the tallest child, or just use the bar's height (35px
= one row, 61px = two).

---

### 30. `flex-wrap` places an item on a new line BEFORE it will shrink it (2026-09-08)

`.status-bar` was `flex-wrap: wrap`, which reads like a safety net and is the opposite. The session
button holds a tmux name — 2 characters or 22, written by something other than the layout — and
with wrapping on, a long one moved to a second row instead of shrinking, taking **26px off the
terminal** on a phone. `min-width: 0` and `text-overflow: ellipsis` on the label did nothing,
because shrinking is only considered *after* an item has been placed on a line.

The fix is structural, not a tuned number: `flex-wrap: nowrap`, every child `flex-shrink: 0`
**except** the session button, and that one `flex: 0 1 auto; min-width: 44px; overflow: hidden` with
an ellipsizing label. The bar is now incapable of becoming two rows at any width, instead of fitting
the names that happen to exist today. Measured one row / 35px at 320, 360, 390 and 430px with names
from `claude` to `ai-probill-sandbox`; the harness's positive control puts `flex-wrap: wrap`
back and confirms the second row reappears
(`~/headless-chrome/tsrct-pb-statusbar-check.mjs`, 18/18).

This predates [PB]; adding a button only made it reachable at 390px instead of only at 320px.

---

### 31. "The connector refused" meant "nobody put it on the allowlist" (2026-09-18, FIXED)

First real dry run (00:10, ~5 min): it read Slack, Google Calendar and the vault, produced 12
pending items and a 4-session plan — and reported plainly that **ClickUp and Gmail refused**, so
every due date it quoted came from the ClickUp tasks *mirrored into Google Calendar*, not from
ClickUp. Saying so instead of inferring is the designed behaviour (`buildInstruction` tells it to
skip an unavailable source and name it in the brief), and that half worked exactly as intended.

**The reason it gave was wrong, and believing it cost a day.** The brief said the connectors
"need to be authorized from an interactive session". They did not. The morning job runs as
`claude -p` in `ANALYST_WORKSPACE` (`/mnt/c/Users/you/PROJECTS/tsrct-analyst`), and that folder's
`.claude/settings.json` has a `permissions.allow` list written for the older job kinds: Slack read,
Calendar read, a handful of `Bash` verbs. **Gmail and ClickUp were simply not in it.** In print
mode there is nobody to answer a permission prompt, so an unlisted tool is denied on the spot, and
the transcript says so in one line:

    "Claude requested permissions to use mcp__claude_ai_Gmail__search_threads,
     but you haven't granted it yet."

That line lives in `~/.claude/projects/-mnt-c-Users-you-PROJECTS-tsrct-analyst/*.jsonl`, not in
`out/<key>.err` (which was 0 bytes both runs) — so the only trace of a denied connector is in the
transcript. **A model's explanation of its own failure is a guess; the transcript is the evidence.**

Fixed by adding the READ-ONLY Gmail and ClickUp tools to that allowlist (4 Gmail, 13 ClickUp — no
`send_message`, no `reply`, no `create_task`, no `add_time_entry`: the file's whole premise is that
an unattended agent cannot act as Leon). Verified live in that workspace, not reasoned about:
`claude -p "... Answer GMAIL=<ok|refused> CLICKUP=<ok|refused>"` now answers `ok` for both.

**When a new source is added to the morning instruction, add its tools to that file in the same
edit** — the instruction naming a source grants nothing.

Two more things the run proved, both fixed the same night: the ask takes **four to six minutes**
with no intermediate output (so the panel needs a real loader, not a spinner-less wait), and a dry
run that decides but opens nothing is a dead end without a way to accept it — hence
`POST /api/morning/open`, which opens the sessions from the plan already on disk rather than
spending a second headless job that could answer differently.

### 32. A background poll that re-renders takes the reader back to the top (2026-09-18)

The morning overlay polls `/api/scheduler` every 20 s (4 s while a job runs) and each poll called
`render()`, which rewrites `#pc-morning-body.innerHTML`. That destroys the `.mrn-scroll` element
and creates a new one at `scrollTop = 0`, so the brief — eight to ten lines, taller than the sheet —
**scrolled itself back to the top every 20 seconds while Leon was reading it.**

`startTick()` already carried a comment about exactly this hazard ("re-rendering the sheet every
second would throw away his scroll position") and solved it for the 1 s elapsed clock by updating a
single span. The 20 s poll kept doing the thing the comment warned against. **A hazard documented
at one call site is not handled at the others.**

Two rules now, in `render()`:
1. **Identical state does not re-render.** A JSON signature over `data.morning`, `data.jobs`, the
   fold state and the ticked sessions; equal signature, no DOM write at all. That is the common
   case while reading, and it also preserves the tick boxes.
2. **A real re-render carries the scroll position over**, because a session finishing must not
   eject him from the paragraph he is on either.
`render(true)` forces a redraw for the cases where he clicked something and the server payload has
not changed yet (fold, registry reload). Opening empties the body first, so a reopen starts at the
top instead of inheriting the last read position. Harness: 8/8 with a positive control that proves
the stub scroller really does reset when innerHTML is rewritten.

### 33. Five upstream traps between a trained voice and a playable one (2026-09-19)

All five looked like success, which is why they are here. In order:

1. **torch 2.6 flipped `torch.load` to `weights_only=True`.** The published Piper checkpoints carry
   `pathlib` objects in their metadata, so Lightning's resume path refuses them outright. Fixed by
   sanitizing the file ONCE (`scripts/voice-train/sanitize-ckpt.py`) rather than turning the flag
   off for every future run - a workaround like that outlives the problem it solved.
2. **The same checkpoint carries hyper-parameters from a 2021-era Piper** (`accelerator`, `gpus`,
   `tpu_cores`, `sample_bytes`) that today's `VitsModel` rejects: *"Subcommand 'fit' does not
   accept option 'model.sample_bytes'"*. Filtered to the intersection with the model signature -
   configuration dropped, never a weight.
3. **Monotonic Alignment Search ships as a Cython extension compiled at install time.** The wheel
   has neither the compiled module nor the `.pyx`, and there is no C compiler in this WSL.
   Reimplemented with numba in `mas_core.py` **and checked against a plain transcription of the
   upstream algorithm** - a wrong alignment does not crash, it trains for hours and produces a
   voice that mumbles.
4. **Piper's default `ModelCheckpoint(monitor='val_mos')` raises when the MOS predictor is absent**,
   while its own comment says Lightning "warns once and skips". It does not: a full epoch trained
   and was thrown away at the end of it. Passing `--trainer.callbacks` does not help either - the
   CLI APPENDS to the defaults ("Found more than one stateful callback of type ModelCheckpoint").
   `train_entry.py` substitutes the list before the trainer is built.
5. **torch 2.14's ONNX exporter cannot trace this model** (`GuardOnDataDependentSymNode` on an
   assert inside the model's own maths). `export_entry.py` forces the legacy exporter with
   `dynamo=False`; the output file is identical to what Piper's runtime expects.

Two more from the same night, both instances of rules this repo already had:

- **A checkpoint that is still being written is not a checkpoint.** Exporting straight from
  `last.ckpt` mid-save gave `PytorchStreamReader failed reading file data/187`, which reads like
  corruption and is a half-written file. `export-voice.sh` now skips anything touched in the last
  30 s, copies the candidate before reading it, and only accepts one that torch actually loads.
- **`hermes.ollamaChat()` always runs Ollama in JSON mode** (`format: 'json'`, and the response is
  `JSON.parse`d) because every other caller asks for a schema. A prose request through it returns
  an object, and `String(object)` is `"[object Object]"` - which is what the first spoken brief
  said out loud. Ask for a JSON field instead of changing shared plumbing.

### 34. An `<audio>` element answers a failure with nothing useful (2026-09-19)

`POST /api/tts/say` returns a valid WAV (verified with curl: RIFF, 22050 Hz, PCM16), and the
browser still refused it with *"Failed to load because no supported source was found"* - a message
that says nothing about what arrived. Playback moved to Web Audio `decodeAudioData`, which reports
the real decode error, plays from memory and leaks no object URL. **Status: confirmed working in
Leon's browser 2026-09-19.**

### 35. A mobile button that "does nothing" because its DOM lives in `buildPCLayout()` (2026-09-19)

The TOOLS -> BRIEF button on the phone did nothing at all - no error, no toast. `mrnOpen()` starts
with `const ov = overlay(); if (!ov) return;`, and the overlay's markup was written in
`Desktop.buildPCLayout()` (`desktop.js`), which only ever runs at viewport >= 900px. On a phone the
element simply never existed, so the handler resolved, ran, and returned.

**The rule:** a module that owns a surface must own its DOM. `overlay()` now creates the element if
it is missing, and `room-morning.css` already had the phone layout for it. When a mobile entry point
is added to something that grew up in PC mode, check where its markup is injected before assuming
the handler is at fault - `check-handlers.js` passes either way, because the NAME resolves fine.

### 39. The ring: self-hosted ntfy, because the free tier runs out on the wrong day (2026-09-19)

`ntfy.sh` anonymous publishing is ~250 messages a day **per IP**, and one "ring until you answer"
spends five. The first live test answered `{"code":42908,"error":"daily message quota reached"}`
while Web Push went through fine - so the loud half of the call was the half that failed.

**What is installed now (all of it on this laptop, nothing new on the internet):**

| piece | where |
|---|---|
| binary | `~/bin/ntfy` (v2.28.0, 71 MB on disk, ~16 MB resident) |
| config | `~/.config/ntfy/server.yml` - `listen-http: 127.0.0.1:2586`, `behind-proxy: true` |
| service | `systemctl --user ntfy`, enabled, `MemoryMax=300M`, lingering on so it survives logout |
| the phone's door | `tailscale serve --bg --https 8444 http://127.0.0.1:2586` (tailnet only) |
| TSRCT publishes to | `NTFY_SERVER=http://127.0.0.1:2586` (loopback - no TLS, no third party) |

The phone subscribes in the ntfy app to `https://<machine>.<tailnet>.ts.net:8444` + the topic, which
means **the alert only arrives while Tailscale is connected on the phone**, and the app needs
*instant delivery* (its own persistent notification) because Firebase only serves ntfy.sh's own
topics. That is the price of owning the channel, and it is the right trade for an alert that has to
be loud on the day the quota would have been gone.

⚠️ `pkill -f "bin/ntfy serve"` kills the shell that runs it - the pattern matches the command line
of the process doing the searching. Stop it with `systemctl --user stop ntfy`, or by PID.

**DROP, the same pattern for files (2026-09-28).** A one-page upload box so Carla's iPhone (a
node SHARED into the tailnet from another person's account, shown as `device-of-shared-to-user`,
OS hidden by sharing) can send photos/files straight to this laptop. **Taildrop cannot do it**:
it only sends between devices of the same user. SMB from the iOS Files app would need a Windows
account for her and a firewall hole, so a page it is.

| piece | where |
|---|---|
| server | `scripts/drop-server.js` - zero deps, NOT part of server.js, `127.0.0.1:3902` |
| service | `systemctl --user drop`, enabled, `MemoryMax=200M` (streams to disk) |
| the phone's door | `tailscale serve --bg --https 8445 http://127.0.0.1:3902` (tailnet only) |
| lands in | `C:\Users\you\Downloads\De Carla` (`DROP_DIR`) - Downloads, not the OneDrive Desktop, so her photos are not synced to the cloud |

Access is `Tailscale-User-Login` in `DROP_ALLOW` (hers + `leonlurk@github`), no password. Measured:
a client-sent `Tailscale-User-Login` is replaced by serve with the real one, and a request with no
header (i.e. from this machine, not via serve) is refused. Names are basename'd and never
overwrite (`x (2).jpg`); each file is written as `.part` and renamed when complete. Refusals log
the login they saw (`journalctl --user -u drop`) - the first check if she gets `forbidden`.
From WSL the `ts.net` URL does not answer (hairpin); test with `curl.exe` from Windows.

### 38. `overflow-y: auto` silently makes the OTHER axis scrollable too (2026-09-19)

The morning brief on the phone could be swiped sideways, and re-rendering reset that sideways
offset - which reads as "the panel jumped back" and looks identical to the vertical bug from gotcha
32. Cause: `.mrn-scroll` set only `overflow-y: auto`. Per CSS overflow, when one axis is not
`visible` the other computes to `auto`, so one long absolute path inside the brief (`pre-wrap` does
NOT break an unbroken token) made the whole sheet a horizontally scrollable strip.

Fix, in this order: `overflow-x: hidden` on the scroller, `overflow-wrap: anywhere` on every text
class that can hold a path or a session name, `min-width: 0; max-width: 100%` on the rows, and
`white-space: normal` for the phone on the two columns that use `nowrap` as a desktop affordance.
`render()` now also carries `scrollLeft` over, not just `scrollTop`.

**The rule: if you set one overflow axis, set both** - and never let a path be the widest thing in
a mobile layout.

### 37. The voice fine-tune has already flattened - and the numbers are readable without tensorboard (2026-09-19)

`train-piper.sh` never ends on its own: `CHUNKS=0`, `--trainer.max_epochs 100000`, 25-minute chunks
in a `while :` loop. So "is it done?" has to be answered from the curve, not from the process.

**Measured at epoch 5641 / step 803,987 (1202 utterances in the set):**

| metric | earliest logged | mid | last |
|---|---|---|---|
| `val_mel` | 0.4347 | 0.3987 | **0.3953** |
| `val_loss` | 39.20 | 35.68 | 34.92 |
| `train_mel` | 0.4666 | 0.3999 | 0.3960 |

The first quarter of that window bought **0.02** of `val_mel`; the last quarter bought **0.0005** -
about forty times less for the same hour of GPU. That is convergence, not a plateau to push through,
and the corpus is XTTS-rendered, so what is left to learn is increasingly XTTS's own artifacts.

**Reading the metrics with no tensorboard installed:** Lightning writes `lightning_logs/version_*/
events.out.tfevents.*`, which is a TFRecord stream of `[len u64][crc][protobuf][crc]`. The three
fields that matter are Event.step (field 2, varint), Event.summary (field 5), and inside each
Summary.Value the tag (field 1, string) and simple_value (field 2, float32) - about 40 lines of
plain Python, no dependency, no GPU touched. `pip install tensorboard` into a training venv mid-run
is the thing worth avoiding.

### 36. Ollama's `/api/ps` still lists a model while it is unloading (2026-09-19)

After `keep_alive: 0`, a check two seconds later reported the model still resident - and it was not:
`nvidia-smi` showed VRAM back to 390 MiB (below the 1543 MiB the box idled at before). `/api/ps`
reports it through teardown. **Verify an unload with VRAM, not with the listing**, or write a test
that fails for a policy that actually works.

### 40. Reading a session to a model: the screen is two thirds furniture (2026-09-19)

TOWER handed `capture-pane` output straight to hermes and its one-line tiles were vague or wrong.
The reason is visible the moment you print both: on a 25-line tail of a live pane, the full-width
rules, the composer, the `✻ Cooked for 42s` line, the `[7d 29%] [ctx 15%]` footer and the
`⏸ manual mode on` line are more than half the lines. A model given that summarises the box.

`paneShape.readableTail()` strips exactly the chrome and keeps everything a person would read,
including the line he typed at the `❯` prompt (that line is half of "what is going on"). The old
TUI's gutter (`│ `) comes off BEFORE a line is judged, or every line of an answer inside the box
reads as furniture. Measured on `harbor-allocations`: 25 raw lines -> 19 readable, and the narration
that came back named the right report, the right file and the two real caveats.

**The cost of a watcher is in WHEN it asks, not in what it asks.** TOWER woke the model every 25s
per pane regardless of change — that is what pinned a core at 96 °C. TALK's watcher looks at the
pane every 4s with a regex (free) and wakes the model only on the working -> waiting transition:
once per finished turn, with a 20s floor. A transition that lands inside that floor is remembered
and narrated late rather than lost, because "the turn you were waiting for" is the one thing the
watcher exists to report.

**The mode is where his voice GOES, and a button is the wrong instrument for one sentence.** RELAY
types what he says into the session; SIDE BY SIDE keeps it between him and hermes so he can keep
talking while a turn runs. But reaching for a switch to ask "what is it doing?" and reaching for it
again afterwards is exactly how a line gets pasted into a session mid-turn, so the name is also a
switch: an utterance starting with "hermes" (or "che hermes", "ey hermes", with or without the
accent) never reaches the session, whatever the mode, and the vocative is stripped before the model
sees the question. The override only works in the direction that is always safe — it can keep a
line OUT of a session, never put one in.

Two things LIVE mode needs that the end-of-turn narrator does not: the model must be allowed to say
nothing (an empty `respuesta` when nothing changed — "still working" every minute is noise he will
switch off, and then he hears nothing at all), and the same sentence must not be spoken twice in a
row, which sounds broken rather than repetitive. A spoken ANSWER also resets the live interval, or
the first progress ping lands on top of the answer to the question he just asked.

Measured end to end (2026-09-19, card idle at 576 MiB of 8151): open 0.3s, first answer 84.9s cold
(load + generate), VRAM 6153 MiB with the model up, back to 576 MiB twelve seconds after `close()`
— see gotcha 36 for why the check has to be twelve seconds and not two.

### 41. A personality is shown, not declared — and 0.2 is where characters go to die (2026-09-19)

Asked for a sarcastic, House-flavoured voice, the first attempt was a sentence in the system prompt
("sos sarcastico, seco, te aburre lo obvio"). Given to two models on the same real pane it produced
**zero ironic lines on either**, and the older one got WORSE at the actual job while trying:
`hermes3:8b` announced that it had verified the fix Leon verified, and addressed Claude instead of
him. Three findings, all now implemented in `lib/persona.js`:

**Examples, not adjectives.** A 7-8B model copies a demonstrated turn well and follows an adjective
badly. The personality lives in a handful of user/assistant example turns (sent as history, with
the assistant side as the JSON the caller reads, so they teach tone AND shape at once). One of them
must teach SILENCE — an empty answer — or the live commentary says "sigue trabajando" once a minute
until it gets switched off.

**Temperature is part of the personality.** Every call in `hermes.js` ran at `temperature: 0.2`,
which is correct for the classifiers it was written for and produces the same flat report every
time for a voice. The spoken paths now pass `TALK_TEMPERATURE` (0.7).

**State the cast.** "Who did what" is the first casualty when a small model is busy being someone,
and it is not a stylistic slip: claiming Leon's verification is a lie about his own work. The
identity block is first in the prompt, phrased as a prohibition, and survives `TALK_PERSONA=plain`.

⚠️ **A written rule is not a guard here either.** "Si no sabes algo, lo decis y no lo inventas" was
in the prompt from the first version. Asked what day it is on Mars, the model answered "28 de julio"
without hesitation. Adding an EXAMPLE of refusing a plausible-sounding fact fixed the case that
matters — "cuanta plata facture este mes" now gets "no tengo esa informacion" — but **not the absurd
one**: the same Mars question still comes back "no es un dia en Marte, es 7 de octubre", a denial
followed by an invented date. Treat a refusal-to-invent as improved, never as guaranteed; an
invented number is indistinguishable from a real one, which is what makes it the worst failure this
voice has. `scripts/check-persona.js` is the seventh check in `npm run check`: the examples must be
well-formed JSON with a `respuesta` string and must alternate, one must be empty, the identity block
must survive assembly, the temperature must be in a sane band, and both spoken paths must build
their prompt through `persona.system()` / `persona.examples()`.

**The model that speaks is not the model that classifies.** `TALK_MODEL` defaults to
`qwen2.5:7b-instruct-q4_K_M`; the dispatcher's remaining jobs keep `hermes3:8b`. Measured twice,
and the second measurement is the one to trust — same pane, same prompt, both at 4096, both
genuinely cold, on the real code path:

| | cold | warm | VRAM |
|---|---|---|---|
| qwen2.5:7b-instruct | **141.8s** | 6.9s / 5.2s | **4835 MiB** |
| hermes3:8b | 216.5s | 6.0s / 5.3s | 4991 MiB |

⚠️ **An earlier note here said hermes3 loaded FASTER (112s vs 152s). That was wrong**, and the way
it was wrong is worth keeping: the 112s run came after the same model had been loaded three times
in a row, so the page cache served it. The same model measured **112s and 216s the same
afternoon**. Cold-load timings are dominated by disk state, so two models are only comparable when
both are truly cold — and a single run of each is still weak evidence.

**Quality, same three questions.** Asked what was happening, qwen2.5 named the two new reports and
their exact state; hermes3 said "the file was updated" and named nothing — which is the whole job,
so that decided it. ⚠️ The reverse held on the invention trap ("how many commits did I make this
month"): hermes3 refused from context, **qwen2.5 made a number up**. An 8B does that occasionally
and no amount of prompting removes it. That is the ceiling of this class of model, not a defect to
be fixed — so a number from the assistant that matters is a number to verify.

⚠️ **The 180s answer timeout was TOWER's, written for a one-line summary.** A cold load (~150s) plus
a real prompt (persona + examples + the project's vault note + 2500 chars of screen) exceeds it, so
the FIRST question of every conversation died — and the timeout tripped hermes' circuit breaker, so
the two questions after it failed instantly with `ollama-circuit-open`. The panel looked broken when
it was only slow. Split into `TALK_COLD_MS` (300s) and `TALK_WARM_MS` (90s), with TALK tracking
which state it is in. Measured after the fix: 92.5s cold, 6.7s and 1.3s warm.

**Context, not parameters, is what makes it useful.** With the session's folder and the head of that
project's vault note in the prompt, the answer moved from "the tests failed" to naming who the open
item belongs to — a fact that was never on screen. That costs no VRAM.

`lib/projectMemory.js` extends that to three sources — the vault note, the newest entries of the
project's `## <PROJECT>` section in `Decisions Log.md`, and its latest `vault/sessions/` log — for
~475 tokens of the 8192 window. Measured on a HARBOR session: *"que habiamos decidido sobre esto"* was
answered from the decisions log ("el reporte tipo 3.0 es la custom TYPE, no el que probamos"), a
fact that appears nowhere on screen. ⚠️ Two things to know:

- **Labelling the blocks is not enough.** Asked *"donde quedo esto la ultima vez"*, the model
  answered with the current screen reworded. A small model needs telling WHICH block answers which
  question, so `NARRATE_SYSTEM` now says so explicitly, source by source.
- **The context must be marked as background**, or the model recites last week's plan instead of
  reading the screen in front of it.

The project is the session's FOLDER, not its name: `gaap-r05` lives in `ledgerly-quirks`, which
has no vault note, so that session gets the screen and nothing else — no gain, no breakage.

⚠️ **A server message is not a piece of interface just because it reaches the screen.** The SecretCo
refusal (164 characters of contract, written for a log) was rendered verbatim in the middle of the
TALK card: "a quién le importa... está rompiendo con mi estética". `shortWhy()` in `morning.js` maps
each known failure to one short line for the panel ("that session stays off this assistant") and
sends the full text to the console, where it is actually useful. Anything unrecognised is capped at
90 characters. The refusal itself is unchanged — only what the panel says about it.

⚠️ **Cold start is the number to watch, not the answer time.** Warm answers are 2-6s. The cold
first answer was 92s, 131s and — on a box already busy with repeated model loads — **279s**, which
is inside the new 300s ceiling by 20 seconds. If cold starts creep past that, raise `TALK_COLD_MS`
rather than assuming the model hung.

**And the largest single win of the day was one number nobody had looked at: `num_ctx`.** Every call
in `hermes.js` asked Ollama for an 8192-token window because that is what the dispatcher's
classifiers were tuned with. TALK's fattest prompt — persona + examples + project block + 2500 chars
of screen + eight turns — is about 2.4k tokens. The window is a KV cache **allocated when the model
loads**, so the other 5.8k was VRAM held for nothing and cold-start seconds paid on every
conversation. Measured on the same model and prompt, changing only this:

| `num_ctx` | cold | warm | VRAM |
|---|---|---|---|
| 8192 | 211.3s | 5.7s | 5067 MiB |
| 4096 | **129.7s** | **2.2s** | **4835 MiB** |

A 39% cheaper cold start and answers nearly three times faster warm. **The warm number is the one
that decides whether it feels like a conversation** — 2.2s is an answer, 5.7s is a wait. `hermes.js`
now takes `numCtx` per call; the dispatcher keeps 8192, `TALK_NUM_CTX` is 4096. Raise it only with a
measurement, never on the theory that more context is better.

### 42. The assistant stopped being a panel — and the default that typed into a live session (2026-09-19)

TALK shipped inside the morning overlay, so using it meant keeping a modal open over your work, and
closing that modal ended the conversation and unloaded the model. That is correct for a panel and
absurd for an assistant: "es un ENTE, no necesita obligarme a mantenerme en una interfaz". It is now
`src/js/assistant.js` — an orb fixed to the corner of every room and both layouts.

Three things that make it not-a-modal, each of which had to be deliberate:

- **It builds its own DOM on boot.** Markup that lives in one layout's builder exists only in that
  layout — the same defect that made the mobile BRIEF button do nothing for weeks (gotcha 35).
- **`pointer-events: none` on the container**, `auto` on its children. A fixed dock over a terminal
  that swallows clicks is worse than no dock.
- **The conversation lives in the server**, so the orb is a client, not an owner. Closing the panel
  costs nothing, a reload re-joins the live conversation (`adopt()` reads `/api/talk/status`), and a
  second window sees the same one.

⚠️ **What replaced the modal as a safety device.** "A panel is open" was the proof he was present:
it is what let auto-narration re-arm the idle timer without risking a model pinned all day. With the
orb there is no such proof, so `TALK_MAX_SILENT_MS` (30 min without a word FROM HIM) is enforced in
`watchTick()` — the only thing still ticking once he goes quiet. Narrations cannot postpone it.

⚠️ **THE INCIDENT THAT CHANGED THE DEFAULT.** `toClaude` (relay: what he says is typed into the
attached session) shipped **on**. He said one word to test the microphone and "Hello" was typed into
a live `acme-agent-trudy` session, where Claude answered it. Nothing warned him and nothing asked.
The feature did exactly what it was designed to do, which is what made the DESIGN wrong: **typing
into a running session is a decision, not a default.** Now it is off by default, arming it confirms
and names the session, changing session disarms it, every paste gets its own amber line plus a
toast, and the button reads `[!] typing into session` while armed rather than a neutral toggle name.
The general rule, already written for hands-free and re-learned through another door: a voice channel
that can write into a session turns a misheard sentence into a command.

⚠️ Also from that exchange: the spoken reply was *"lo pasé a Jo, esperá su feedback"* when the
screen said the test should be GIVEN to Jo. Naming the cast in `persona.js` was not enough — the
identity block now also forbids claiming actions that are merely SUGGESTED or PENDING on screen.

### 43. The three loops that woke the model, and the pipeline nobody used (2026-09-19)

The fans came on after a restart. The boot log said the right thing — *"local model left alone at
boot"* — and it was true; the model was loaded thirty seconds later, by something else. Finding that
something took three rounds, and each round found the same shape through a different door:

| Loop | Period | What it fed | Who read it |
|---|---|---|---|
| TOWER's pane summariser | 25s | a panel of one-line tiles | nobody (retired) |
| the Slack draft writer | 60s | replies in Leon's style, stored | **nobody** |
| the reconciler | 10s | a draft to unstick a waiting session | **nobody** |

All three loaded a 4.7GB model on their own, unprompted. **The test that settles it is not "is this
code called" but "does a human ever read the output":** the drafts and the reconciliations had
routes, tables, prompts and engines — everything except a caller in `src/js/`.

The wider cut followed from Leon's own description: *"el dispatcher es lo del canal de slack donde
ingreso tareas y hermes distribuye, eso esta todo muerto"*. Measured before cutting: **57
`/api/dispatcher/*` routes, 38 of them called by the UI** — so the dispatcher as a whole was very
much alive, and the split was clean because the live half never touched the dead half:
`clickupSync`, `clickupAnalyst`, `worklogEngine`, `digestEngine` and `codemapEngine` do not go
through `core.js`. What went: core, slackHandler, clickupHandler, followUpRouter, researcher,
promptPolisher, reconciler, towerAggregator, the five voice/draft modules, ~30 routes, the
DISPATCHER room and tab, five tables and about forty db helpers. **15 modules, ~3900 lines.**

Two things worth keeping in mind for next time:

- **`@slack/bolt` was the repo's only npm dependency, and it had exactly one consumer.** The tree
  now has none at all.
- **A `git rm` of several files is all-or-nothing.** One file with local modifications aborted the
  batch, five modules stayed on disk, and the `&& python3 …` that followed never ran either — so
  the requires stayed too. The shape of the bug was invisible until a `require()` of every path in
  `server.js` was run as a test. Do that test after any deletion; syntax checks pass right through
  a missing module.

### 44. A cron line cannot tell "failed" from "never ran" — and the laptop is off at 07:23 (2026-09-24)

The Amazon keep-alive failed every Monday from 2026-08-31 and nobody knew: its wrapper **exits 0
either way** and writes the failure to a file in the project folder, and cron sent the output to
`/dev/null`. It also ran only 3 times in 14 weeks, because cron fires at the minute or not at all.
Two rules came out of moving it into TSRCT's scheduler:

- **Judge a job by what it leaves behind, not by its exit code.** Three of the four moved wrappers
  exit 0 on failure. Each job in `lib/automations.js` has a `judge()` that reads the real verdict.
- **Schedule by occurrence with a window, not by minute.** `lastOccurrence()` + `window` hours.
- `crontab <file>` cannot read the Claude sandbox's private `/tmp` ("Not a regular file"): write the
  new crontab under `$HOME` first.

### 45. An archived ClickUp task still looks alive — and so does every task in an archived list (2026-09-30)

The worklog generator kept booking hours on dead tasks. Its task ids come from two places: Leon's
last 45 days of time entries and the id table in `~/.claude/skills/weekly-worklogs/SKILL.md`. Of
the 22 ids in that table, **3 return 404** (deleted) and **"General Administration" (86ae7fqj1) is
archived**. The only check before posting was "exists and is in the ACME workspace".

- **`task.archived` is not enough.** Every task in the archived "Marketing" list (901327855571)
  answers `archived: false`; only `GET /list/{id}` says `archived: true` (folder and space can too).
  `clickupSync.taskHealth()` checks the task AND its list/folder/space: `live | closed | archived |
  gone`. **archived and gone block; closed (status type `closed`/`done`) only warns.**
- Checked three times: dead ids are named to the model before it writes (`dead_task_ids`, and
  dropped from the history it learns from), every proposal is re-checked after, and the create gate
  asks ClickUp again fresh.
- No live task fits -> the proposal carries `new_task {list_id, name, description}`
  (`new_task_json`), editable in the table. The create gate makes the task FIRST (assigned to Leon,
  only into an active non-SecretCo list from `listCatalogue()`, never retried), writes its id onto the
  row and clears the suggestion — so a retry after a failed time entry does not make a second task.

### 46. Tesla on the Windows desktop: DPI, OCR, Notepad and the mouse (2026-10-10)

`lib/desk.js` + `scripts/desk/{look,act}.ps1`, reached ONLY through `node scripts/desk.js <op>`.
Measured on this laptop (main 2560x1600, second 1920x1080 at -1920,368 with different scaling):

- **DPI awareness must be PER-MONITOR** (`SetProcessDpiAwarenessContext(-4)`). With the old
  system-aware `SetProcessDPIAware()`, `Screen.Bounds` reported the second monitor as 2880x1620 at
  -2880 and `CopyFromScreen` produced a shifted picture with a third of it blank. Both scripts must
  use the same awareness, or a click lands somewhere other than where the screenshot showed it.
- **Windows OCR: only `en-US` is installed** (`TryCreateFromUserProfileLanguages()` returns null on
  es-AR); "SecretCo" reads the same in it. At 1x it misses 7pt Consolas in a dark terminal; at 2x it
  reads it (8pt+ is read at both). ~0.5 s per monitor at 2x. `MaxImageDimension` is 10000.
- **The word is not the signal.** The first guard refused any monitor where OCR read "SecretCo" and
  blinded the one showing a Claude session that only talked about it. Leon's rule: refuse only WORK in
  SecretCo (their org's address, a prompt inside SecretCoSandbox, an editor/terminal/folder window ON it, the
  secretco tmux session). None of his ~33 local sf orgs is theirs, so their org is only reached in a
  browser, and a Salesforce tab title does not name the org: with the address bar hidden it is missed.
- **Windows 11 Notepad restores its last tabs**: `Start-Process notepad` opened his file
  "PV-A ordenar drive.txt", not a blank page, and a test line went into it. Check the window in
  front (`front` in every act's answer) before typing.
- **"He took the mouse" is a cursor comparison**, done inside act.ps1 in the same run as the input
  (6 px tolerance). It fired for real seconds after it was written. It pauses every act for 3 min,
  and a new look does not lift it.
- An app asking for admin rights (UAC) switches to the secure desktop: neither capture nor input
  reaches it.
- **VR re-sent its cursor to VNC on every frame**, moving or not (`rdVrRender`). Harmless alone; with
  Tesla clicking it dragged Windows' cursor back off her click ~60 times a second, which `desk.js`
  reads as "he took the mouse". It now sends only on change (`rdVrLastSentPointer`).
- **Raising a window**: `SetForegroundWindow` from a process that did not get the last input is
  refused by Windows' foreground lock; a tap of Alt (SendInput) first lets it through. `IsIconic` ->
  `ShowWindow(9)` restores a minimized one. `focus --window spotify`: 1.06 s; the Start-menu way 22 s.
- **The session verb table eats PC sentences** ("abrime el excel" -> open_session "excel"). Anything
  new the parser learns must pass `aboutThePc` first (lib/understand.js).

**Windows, modes and shortcuts without the mouse (2026-10-11, `TESLA-PC-PATHS.md`)** -
`lib/deskWindows.js` + `lib/deskShortcuts.js` + `scripts/desk/windows.ps1`, wired once in
`lib/deskWire.js` for both server.js and the CLI. Measured:

- **Windows 11's invisible resize border**: `GetWindowRect` is ~7 px wider than what you see;
  `DWMWA_EXTENDED_FRAME_BOUNDS` is the visible frame. A move across monitors with different scaling
  changes that border on arrival, so `Place` measures and moves TWICE (first try landed 2 px off).
  Halves, thirds and corners now land on the exact pixel, 1.1-2.0 s per move.
- **The laptop is DISPLAY1 = screen 1; the Samsung is DISPLAY5 = screen 2, at x -1920**. FancyZones
  calls the Samsung "Monitor 2" in `get-monitors` but its own monitor-number is 5 and its id is
  `SAM707B`: map by the `Position:` line, never by a number.
- **FancyZonesCLI (PowerToys v0.100.2) only works with PowerToys RUNNING** ("FancyZones is not
  running"). PowerToys was set to start with Windows but was not running on 2026-10-11.
  `set-layout columns --monitor 2`: 0.6 s.
- **The Workspaces editor hotkey was plain Ctrl+W** (= close tab everywhere). Changed to the default
  Win+Ctrl+` with his OK; the original is `Workspaces/settings.json.bak-tesla-2026-10-11`.
  Workspaces themselves: none saved yet; the launcher args (`<id> 1`) are from PowerToys' source and
  still unverified on this machine.
- **A shortcut must target a VISIBLE window**: the first Chrome match in z-order was a minimized Gmail
  window, and Ctrl+T went there. `target()` prefers non-minimized windows, and `front` restores a
  minimized one before keys reach it.
- **TSRCT is a Chrome window**: every Chrome row carries `avoid: 'TSRCT'`, or "cerra la pestana" closes TSRCT.
- **"modo foco" and "guarda esto como X" already belonged to TSRCT** (focus_mode, save_setup):
  PC modes may not be called "foco", and saving windows must say ventanas/pantalla.
- PowerShell prints titles in the console code page; `[Console]::OutputEncoding = UTF8` in act.ps1
  and windows.ps1, or "Facturacion" arrives with a `?`.
- One shortcut is 3 PowerShell starts (list, bring forward, key): ~1.1-3 s. The Slack routine is 5:
  ~6 s. Folding them into one PowerShell run is the next speed-up.

---

## 15. Related Projects

- **Claude Code** - The AI that runs in your tmux session
- **ntfy.sh** - Free notification service for push alerts
- **Obsidian Vault** - Knowledge management system referenced for project context
- **Partner OS** - Separate PWA project in `partner-os/` directory

---

## 16. Quick Start for Contributors

### Run Server

```bash
export BRIDGE_TOKEN=YOUR_SECRET_TOKEN
export TMUX_SESSION=claude
export NTFY_TOPIC=your-ntfy-topic

node server.js
# Server listens on http://localhost:3847
```

### Access From Browser

1. Open `http://localhost:3847` (or `http://YOUR_IP:3847` from phone)
2. Enter token
3. See terminal output
4. Type prompts and send

### Run Inside Claude Code

```bash
node server.js &
claude  # Will be able to send prompts via bridge
```

### Development Workflow

1. Edit CSS in `src/css/`
2. Edit JS modules in `src/js/` (maintain load order)
3. Refresh browser to see changes
4. Service Worker caches assets - bump `CACHE_NAME` in `sw.js` to force reload

### Debugging

- **Browser Console**: Frontend logs and errors
- **Server Console**: Logs from Node.js
- **tmux**: See Claude's actual output
- **Network Tab**: Watch API calls and SSE streams

---

## 17. Summary

TSRCT is a sophisticated yet dependency-free remote control system for Claude Code. It combines:

- **Server** (`server.js`): ~2000 lines handling tmux, permissions, HF sessions, vault augmentation
- **Frontend** (modular JS): Terminal UI, room system, desktop mode, feature modules
- **CSS**: Mobile-first hacker aesthetic with smooth desktop scaling
- **PWA**: Offline-capable with service worker caching
- **Integration**: ntfy.sh notifications, tmux session control, Claude CLI spawning

The architecture emphasizes **clarity over magic**: no build step, no bundler, no transpiler. Everything is vanilla JavaScript, HTML, and CSS running on top of Node.js built-ins.

Perfect for remote Claude sessions that need to work from anywhere.

---

**Generated**: 2026-05-06  
**Author**: leonlurk + Claude Code  
**For**: TSRCT v2.0 Codebase

