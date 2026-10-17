#!/bin/bash
# TSRCT Weekly Security Audit
# ---------------------------------------------------------------------------
# Runs `npm audit` + version/outdated checks against the ACTUAL installed tree
# on this box, logs the result, and posts a summary to the TSRCT bridge so it
# shows up in the in-app event stream (the channel you actually use).
#
#   - Does NOT use ntfy (disabled) — surfaces via POST /api/event.
#   - Best-effort: if the server is down, it still logs to scripts/../logs/.
#   - Scheduled weekly via cron (see the install note this script was set up with).
#
# Run manually any time:  bash scripts/weekly-audit.sh
# ---------------------------------------------------------------------------

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root
cd "$SCRIPT_DIR" || exit 1

# --- Make node/npm available under cron's minimal PATH (survives nvm upgrades) ---
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1090
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$PATH:/usr/bin:/usr/local/bin"

LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/security-audit.log"
mkdir -p "$LOG_DIR"

BRIDGE_SERVER="${BRIDGE_SERVER:-http://localhost:3847}"
_FILE_TOKEN="$(grep -oP '^\s*BRIDGE_TOKEN=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null | tr -d '\r')"
BRIDGE_TOKEN="${_FILE_TOKEN:-${BRIDGE_TOKEN:-}}"

TS="$(date '+%Y-%m-%d %H:%M:%S')"

# --- npm audit (exits non-zero when vulns exist; capture, don't fail) ---
AUDIT_JSON="$(npm audit --json 2>/dev/null || true)"
_vuln() { echo "$AUDIT_JSON" | jq -r ".metadata.vulnerabilities.$1 // 0" 2>/dev/null || echo 0; }
CRIT="$(_vuln critical)"; HIGH="$(_vuln high)"; MOD="$(_vuln moderate)"
LOW="$(_vuln low)";       TOTAL="$(_vuln total)"

# --- outdated DIRECT deps (informational) ---
OUTDATED="$(npm outdated 2>/dev/null | tail -n +2 | grep -c . || true)"

# --- runtime versions ---
# NOTE (2026-09-08): the `cloudflared` field was removed with the binary. It reported
# the version of a RETIRED subsystem in the same sentence as the vulnerability verdict,
# so a routine version number read as the finding itself. Do not add an environment
# field back into BODY unless it can actually be the cause of the verdict.
NODE_V="$(node -v 2>/dev/null || echo '?')"

# --- verdict ---
if [ "${TOTAL:-0}" -gt 0 ]; then
    STATUS="[!] ${TOTAL} vulnerability(ies): critical=${CRIT} high=${HIGH} moderate=${MOD} low=${LOW}"
    PRIORITY="high"; TAGS="warning,shield"
else
    STATUS="[*] 0 vulnerabilities"
    PRIORITY="low"; TAGS="white_check_mark,shield"
fi

BODY="${STATUS} | outdated direct deps: ${OUTDATED} | node ${NODE_V}"

echo "[${TS}] ${BODY}" >> "$LOG_FILE"

# --- surface in the TSRCT in-app event stream (best-effort) ---
EVENT_JSON=$(cat <<EOF
{
  "event": "SecurityAudit",
  "type": "security_audit",
  "title": "TSRCT Weekly Security Audit",
  "body": "${BODY}",
  "priority": "${PRIORITY}",
  "tags": "${TAGS}",
  "project": "TSRCT",
  "timestamp": $(date +%s)
}
EOF
)

curl -s -m 10 -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: ${BRIDGE_TOKEN}" \
    -d "${EVENT_JSON}" \
    "${BRIDGE_SERVER}/api/event" > /dev/null 2>&1 \
    && echo "[${TS}] posted summary to bridge" >> "$LOG_FILE" \
    || echo "[${TS}] bridge unreachable (server down?) — logged only" >> "$LOG_FILE"

exit 0
