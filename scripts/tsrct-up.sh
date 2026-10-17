#!/usr/bin/env bash
# tsrct-up.sh — "is TSRCT listening, and if not, start it" — from Linux.
#
# WHY: the only up-check in this tree lived inside the Windows launcher
# (launch-tsrct.ps1: Test-Port 3847). Anything that fires on a schedule from WSL
# — a 6am routine, a cron line, another Claude session — had no way to ask, and
# no way to start the server without the GUI splash. boot-server.sh has no guard
# of its own either: run it twice and the second node dies on EADDRINUSE after
# having already rotated the boot log, which throws away the log of the run that
# is actually serving.
#
# Usage:
#   scripts/tsrct-up.sh            # check only. exit 0 = up, 1 = down
#   scripts/tsrct-up.sh --ensure   # check, and boot it if it is down (waits for [READY])
#   scripts/tsrct-up.sh --json     # machine-readable, same exit codes
#
# It reads BRIDGE_PORT/BIND_HOST from .env so it cannot drift from the server.

set -u
cd "$(dirname "$0")/.." || exit 2

ENSURE=0; JSON=0
for a in "$@"; do
    case "$a" in
        --ensure) ENSURE=1 ;;
        --json)   JSON=1 ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) echo "unknown option: $a" >&2; exit 2 ;;
    esac
done

env_val() {
    # KEY from .env, last one wins, quotes and inline comments stripped.
    [ -f .env ] || return 0
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | tail -1 \
        | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

PORT="$(env_val BRIDGE_PORT)"; PORT="${PORT:-3847}"
HOST="$(env_val BIND_HOST)";   HOST="${HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}/api/health"

# /api/health is public but LOCAL-ONLY and says nothing but "I am up", so a 200
# means the server is really answering, not merely that the port is open (a 401
# from an authenticated route would prove the same thing, but only by accident).
probe() {
    curl -fsS --connect-timeout 2 --max-time 5 "$URL" >/dev/null 2>&1
}

say() {
    if [ "$JSON" = "1" ]; then
        printf '{"up":%s,"host":"%s","port":%s,"action":"%s"}\n' "$1" "$HOST" "$PORT" "$2"
    else
        printf '[tsrct-up] %s (%s:%s)%s\n' "$3" "$HOST" "$PORT" "${4:-}"
    fi
}

if probe; then
    say true none "ONLINE"
    exit 0
fi

if [ "$ENSURE" != "1" ]; then
    say false none "OFFLINE" " - run with --ensure to start it"
    exit 1
fi

# One boot at a time, even if two schedulers fire in the same minute. flock is
# in util-linux; without it, fall back to a plain check-and-go (the probe above
# already makes a double boot unlikely, just not impossible).
LOCK=".tsrct-boot.lock"
if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK" || exit 2
    if ! flock -n 9; then
        say false waiting "ANOTHER BOOT IN PROGRESS"
        exit 1
    fi
    probe && { say true none "ONLINE"; exit 0; }   # the other boot won the race
fi

nohup setsid bash boot-server.sh >/dev/null 2>&1 &

# The server prints [READY] as the last line of its listen callback; the Windows
# splash greps the same marker. Wait for the port to answer, not for the string,
# because the log is rotated at boot and a stale [READY] from the previous run
# would read as success.
for _ in $(seq 1 60); do
    sleep 1
    if probe; then
        say true started "STARTED"
        exit 0
    fi
done

say false failed "BOOT FAILED" " - see .tsrct-boot.log"
exit 1
