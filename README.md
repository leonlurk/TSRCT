# TSRCT

**A control room for many Claude Code sessions at once** - from your desk or your phone.

TSRCT (Tesseract Remote Control Terminal) runs your Claude Code sessions in tmux and gives you one
screen to drive all of them: see every session live, answer their permission requests, split a dozen
of them on one screen, hand a heavy session off to a fresh one, and talk to it all through **Tesla**,
a voice assistant that can read the sessions, open new ones, and act on your PC.

It is one person's daily tool, built in the open: vanilla JavaScript, zero npm dependencies, no build
step, and 32 checks that run before every commit.

## What it does

- **Every session, one screen.** A sidebar of all your tmux + Claude Code sessions, grouped by
  project, with live state (working, waiting for you, failed) and a split view that fits 20 of them.
- **Permissions from anywhere.** Claude Code hooks push every permission request to TSRCT; approve or
  deny from the desktop or the phone.
- **Tesla, the voice assistant.** Speak, and a hidden Claude Haiku session answers; what a sentence
  *means* is decided in code first (a parser and a declared catalogue of ~80 actions), so it opens,
  stops, renames and briefs sessions without guessing. It can watch a session and tell you when it
  needs you.
- **Hands on the PC** (Windows): open apps and files, arrange windows, run named shortcuts, and as a
  last resort click and type, with guards that stop the moment you touch the mouse.
- **The Projector**: a separate headless browser that a session drives for web tasks while you watch
  it live, so your own mouse stays free.
- **Restricted projects**: name the projects that must never reach an AI service or leave the machine
  (a client under NDA, a Bedrock-only account). Every egress point refuses them - fail closed.
- **The clock**: a morning routine that reads your day and opens the sessions it calls for, scheduled
  jobs, and an Automations tab with one switch per loop.
- Plus remote desktop (VNC) with a VR mode, a mobile PWA, phone calls through ntfy, and more.

## Requirements

- **Linux, or Windows with WSL2** (it was built on WSL2; the PC features need Windows + PowerShell)
- **Node.js 22+**, **tmux**, and the **Claude Code** CLI
- Optional, per feature: Ollama (local model), Piper or edge-tts (voice), ntfy (phone alerts),
  Tailscale (remote access), chrome-headless-shell + puppeteer-core (Projector), a ClickUp token

## Quick start

```bash
git clone <this repo> TSRCT && cd TSRCT
cp .env.example .env          # set BRIDGE_TOKEN to a long random string, and PROJECTS_ROOT
npm run check                 # 32 checks, about a minute
npm run hooks                 # optional: run the fast checks before every commit
node server.js                # then open http://127.0.0.1:3847 and log in with BRIDGE_TOKEN
```

Point Claude Code's hooks at TSRCT to get permission requests in the UI: see
`claude-hooks-config.json` (replace `/path/to/TSRCT`). Read **[docs/SECURITY.md](docs/SECURITY.md)
before exposing it beyond localhost**: it is a remote control for your terminals.

## How it is built

- `server.js` - boot and the auth gate; every API route lives in `lib/routes/`, one small function
  per route, tried in order.
- `lib/` - the features: Tesla (`talk.js`, `haikuBrain.js`, `actions.js`, `understand.js`), the PC
  (`desk*.js`, `pcDirect.js`), the Projector, the scheduler and morning routine, the guard
  (`dispatcher/restrictedGuard.js`), all paths in one place (`paths.js`).
- `src/` - the PWA: plain IIFE modules that publish on `window`, no framework.
- `scripts/check-*.js` - the suite. `npm run check` runs all of them and fails at the end; among them a
  route inventory and auth-gate check, a syntax check of every file, a function-size ratchet, a check
  that drives a whole Tesla turn through each brain, and `check-public.js`, the release gate that keeps
  private names, paths and secrets out of this repository.

`CLAUDE.md` holds the working rules (it is what Claude Code reads in this repo) and
`DOCUMENTATION.md` the design notes and the measured gotchas, kept as they were written while building.

## License

MIT - see [LICENSE](LICENSE). By Leon ([leonlurk](https://github.com/leonlurk)).
