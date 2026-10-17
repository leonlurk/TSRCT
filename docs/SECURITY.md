# Security

TSRCT types into your terminals, approves Claude Code's permission requests and can click on your PC.
Anyone who can log in to it can do all of that. Treat it like SSH.

## The defaults, and why
- **It listens on 127.0.0.1.** Remote access goes through Tailscale (`tailscale serve`), which keeps
  it inside your own tailnet with TLS. Do not bind it to `0.0.0.0` or put it behind a public tunnel.
- **Every `/api/*` route is behind one auth gate** (`handleAPI` in `server.js`). The master
  `BRIDGE_TOKEN` alone only authorizes requests from this machine; anything that arrives through a
  proxy is treated as remote (`isRemoteRequest()` is default-deny: any proxy header means remote) and
  needs a login - Windows Hello / WebAuthn, or the token plus a TOTP code. Logins are trusted-device
  sessions with an idle timeout.
- **No shell interpolation.** Every command runs argv-based through one helper (`tmux()`), so a session
  name or a path can never become shell code.
- **The restricted-projects guard** (`lib/dispatcher/restrictedGuard.js`) stands at every point where
  data could reach a model or leave the machine; `scripts/check-restricted.js` fails if one loses it.
- **The PC hands stop when you move the mouse**, refuse windows of restricted projects, and log every
  step with what they saw (kept 3 days).

## What you must do
- Set a long random `BRIDGE_TOKEN` and keep `.env` out of git (it is in `.gitignore`).
- Enroll Windows Hello / WebAuthn or TOTP before using it from another device.
- Keep `BIND_HOST=127.0.0.1` unless you know exactly what you are exposing.
- Review `claude-hooks-config.json` before installing the hooks: they forward permission requests.

## Reporting
Open a private security advisory on the repository rather than a public issue.
