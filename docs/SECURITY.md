# Security

TSRCT types into your terminals, approves Claude Code's permission requests and can click on your PC.
Anyone who can log in to it can do all of that. Treat it like SSH: the design goal is that reaching
it from anywhere in the world is safe, and reaching it from anywhere *else* is impossible.

## The threat model in one picture

```
 phone / laptop (anywhere)
        |
        |  WireGuard tunnel, only devices signed into YOUR tailnet
        v
 tailscale serve  (HTTPS on <machine>.<tailnet>.ts.net, Funnel OFF)
        |
        |  loopback only (WSL2 mirrored networking reaches it from Windows)
        v
 TSRCT on 127.0.0.1:3847
   1. auth gate on every /api/* route    -> 401 without a session
   2. isRemoteRequest(): default-deny    -> the master token is local-only
   3. WebAuthn / TOTP login, lockout     -> a tailnet device still has to log in
   4. argv-only commands                 -> no shell injection
   5. restricted-projects guard          -> some data never leaves at all
```

## Layer 1 - nothing listens in public

- **The server binds `127.0.0.1`** (`BIND_HOST`). It is not reachable from your LAN, your coffee
  shop's Wi-Fi, or the internet. There is no port to scan.
- **Tailscale is the only door.** `tailscale serve --bg 3847` publishes it as HTTPS inside your
  tailnet. A device must hold a WireGuard key admitted to *your* tailnet to open a connection at all;
  traffic is end-to-end encrypted, and the certificate is real (no "accept this risk" prompt to train
  you into clicking through).
- **Funnel stays off.** Funnel is the Tailscale feature that would publish the same address to the
  whole internet. TSRCT never needs it. Check with `tailscale funnel status`.

Being off the internet is the strongest layer, but not the only one: a lost phone, or a
compromised device on the same tailnet, is still inside. So the server does not trust the network.

## Layer 2 - the server trusts nobody on the tailnet either

- **One gate in front of every `/api/*` route** (`handleAPI` in `server.js`). `scripts/check-routes.js`
  fails the build if a route escapes it, and `scripts/check-route-calls.js` replays all 257 routes on
  every commit and fails if any status or reply changes.
- **Login, per device:**
  - **Windows Hello / WebAuthn (passkeys)** is the primary login. Each credential is bound to the
    origin it was enrolled on; challenges are random, single-use and short-lived. Enrolling a new key
    requires being logged in already.
  - **Fallback:** the `BRIDGE_TOKEN` plus a 6-digit TOTP code from your authenticator app.
  - **Lockout:** 5 failed logins lock that device out for 15 minutes. Through `tailscale serve`, each
    device is told apart by its own stable tailnet IP, so one bad device cannot lock out the others.
  - **Sessions** are random 256-bit tokens with a sliding idle timeout (12 h by default,
    `SESSION_IDLE_HOURS`). A trusted device can renew for 30 days; logout revokes it on the server.
  - Token comparisons are constant-time.
- **"Remote" is default-deny** (`isRemoteRequest()`). A request counts as local only if it carries
  *no* proxy header at all. `tailscale serve` adds `Tailscale-User-*` (which tailscaled sets itself
  and strips from what the client sends) and `X-Forwarded-*`; any other proxy adds at least the
  latter. So the master token alone only works for a process on this machine - the Claude Code
  hooks - and an ingress nobody has met yet is still treated as remote. Do not narrow this to one
  vendor's headers.
- **Local-only routes refuse anything remote:** the health check, the session-change ping, and the
  self-refresh route an orchestrating session uses on itself.
- **The few routes outside the gate, and why:**
  - the login pair (it *is* the login; it hands out only a random challenge);
  - live streams (`EventSource` cannot send headers), which check `?token=` themselves;
  - `/images/<file>`, so `<img>` tags work: image extensions only, no `/` or `..`, served from the
    uploads folder fixed at boot.

## Layer 3 - the page and the machine

- **Content-Security-Policy** on the app: data can only be sent to this server (and the OCR library's
  CDN), no plugins, no framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), no referrer.
  Honest caveat: `script-src` still allows `'unsafe-inline'` because the UI uses inline `onclick=`.
- **No shell interpolation.** Every command runs argv-based through one helper (`tmux()` and
  `execFileSync`/`spawnSync`), so a session name or a path can never become shell code.
- **Static files** are served through a path-traversal guard.

## Layer 4 - data that never leaves

- **The restricted-projects guard** (`lib/dispatcher/restrictedGuard.js`) is required on its own,
  never through an optional subsystem, and stands at every point where data could reach a model or a
  third party: git and Salesforce routes, every headless job, ntfy and Web Push, the voice, the
  project memory. It fails closed. `scripts/check-restricted.js` fails the build if one loses it.
- **Background Claude workers** get the restriction as deny rules in their own settings file, not
  just a sentence in the prompt. A prompt is not a guard.
- **The PC hands** stop for three minutes when you move the mouse, need a fresh look at the screen
  before acting, refuse windows of restricted projects, and log every step with what they saw
  (kept 3 days).
- **The release gate** (`scripts/check-public.js`) scans exactly what a push would carry and fails on
  private names, machine paths, tailnet hostnames or secrets. It holds the private names only as
  salted fingerprints, so the gate itself does not leak them.

## What you must do

- Set a long random `BRIDGE_TOKEN` and keep `.env` out of git (it is in `.gitignore`).
- Enroll Windows Hello / WebAuthn or TOTP **before** using it from another device.
- Keep `BIND_HOST=127.0.0.1`. Never bind `0.0.0.0`, never put it behind a public tunnel, never turn
  on Funnel for it.
- In the Tailscale admin console: turn on device approval, keep key expiry on, and remove devices you
  no longer use. For extra safety, an ACL can limit port 443 on this machine to your own user.
- Review `claude-hooks-config.json` before installing the hooks: they forward permission requests.

## Reporting

Open a private security advisory on the repository rather than a public issue.
