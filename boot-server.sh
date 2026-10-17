#!/usr/bin/env bash
# Boot the TSRCT bridge server with node resolved via nvm.
# Invoked by the Windows launcher as:  wsl -d Ubuntu -- bash <path>/boot-server.sh
# Self-contained node resolution (nvm lives in ~/.bashrc, not sourced by login shells).
cd "$(dirname "$0")" || exit 1

export NVM_DIR="${HOME}/.nvm"

# 1) preferred: source nvm and select the default version
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
fi

# 2) fallback: prepend the newest installed node bin dir to PATH
if ! command -v node >/dev/null 2>&1; then
    NODE_BIN="$(ls -d "$NVM_DIR"/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
    [ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
    echo "[BOOT] FATAL: node not found (looked in $NVM_DIR)" > .tsrct-boot.log
    exit 127
fi

# Refuse to start a second server. Without this, a second boot rotates the boot
# log (below) and THEN dies on EADDRINUSE -- destroying the log of the run that
# is actually serving, which is the one you need when something goes wrong.
PORT_LINE="$(sed -n 's/^[[:space:]]*BRIDGE_PORT[[:space:]]*=[[:space:]]*//p' .env 2>/dev/null | tail -1 | sed -e 's/[[:space:]]*#.*$//' -e 's/"//g' -e "s/'//g")"
HOST_LINE="$(sed -n 's/^[[:space:]]*BIND_HOST[[:space:]]*=[[:space:]]*//p' .env 2>/dev/null | tail -1 | sed -e 's/[[:space:]]*#.*$//' -e 's/"//g' -e "s/'//g")"
if curl -fsS --connect-timeout 2 --max-time 5 "http://${HOST_LINE:-127.0.0.1}:${PORT_LINE:-3847}/api/health" >/dev/null 2>&1; then
    echo "[BOOT] already running on ${HOST_LINE:-127.0.0.1}:${PORT_LINE:-3847} - nothing to do. [READY]"
    exit 0
fi

# Keep ONE previous boot log. This file used to be truncated on every start, so
# when the server died on 2026-08-24 the stack trace that would have named the
# cause was overwritten by the very restart that followed it -- the diagnosis was
# unrecoverable. A crash is only ever readable from the log of the run that died.
# The launcher still greps .tsrct-boot.log for [READY], so the live path is unchanged.
[ -f .tsrct-boot.log ] && mv -f .tsrct-boot.log .tsrct-boot.log.prev 2>/dev/null

echo "[BOOT] $(date -Is) node $(node -v) starting server.js ..." > .tsrct-boot.log
exec node server.js >> .tsrct-boot.log 2>&1
