#!/bin/bash
# Claude Remote Bridge - Blocking Permission Hook
# Bloquea Claude hasta recibir aprobación/rechazo desde el celular

BRIDGE_SERVER="${BRIDGE_SERVER:-http://localhost:3847}"
TIMEOUT=300  # 5 minutos máximo de espera
CURL_TIMEOUT=3  # Timeout for curl requests

# Bridge auth token - the server requires it on every endpoint. .env is the
# source of truth; only fall back to an inherited env var if .env has none.
# (A stale exported BRIDGE_TOKEN must NOT win over .env, or the token desyncs.)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_FILE_TOKEN="$(grep -oP '^\s*BRIDGE_TOKEN=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null | tr -d '\r')"
BRIDGE_TOKEN="${_FILE_TOKEN:-$BRIDGE_TOKEN}"

# Leer datos del hook
HOOK_DATA=$(cat)
HOOK_EVENT=$(echo "$HOOK_DATA" | jq -r '.hook_event_name // "unknown"')
TOOL_NAME=$(echo "$HOOK_DATA" | jq -r '.tool_name // ""')
TOOL_INPUT=$(echo "$HOOK_DATA" | jq -r '.tool_input // {}')
TOOL_USE_ID=$(echo "$HOOK_DATA" | jq -r '.tool_use_id // ""')

# Get current tmux session name
# Prefer the ACTUAL tmux session this hook is running in over any inherited
# TMUX_SESSION env var (which is often stale-exported as "claude" globally and
# would mis-tag every permission across all tmux sessions, breaking per-panel
# auto-accept in TSRCT's combined view).
SESSION_NAME="$(tmux display-message -p '#S' 2>/dev/null)"
[ -z "$SESSION_NAME" ] && SESSION_NAME="${TMUX_SESSION:-unknown}"

# Every tool goes to the bridge. This hook only runs when Claude would show a
# permission prompt anyway, so a tool left off a list here was a prompt TSRCT
# never saw and auto-accept could never answer. Subagents fire this same hook
# from the same tmux pane, so they carry the same session name.
[ -z "$TOOL_NAME" ] && exit 0
AGENT_TYPE=$(echo "$HOOK_DATA" | jq -r '.agent_type // ""')

# Check if bridge server is reachable - if not, allow tool to proceed
if ! curl -s --connect-timeout "$CURL_TIMEOUT" -H "Authorization: $BRIDGE_TOKEN" "$BRIDGE_SERVER/api/permissions" > /dev/null 2>&1; then
    echo "Bridge server not available, allowing tool" >&2
    exit 0
fi

# Extraer detalles
FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .filePath // ""')
COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // ""')
OLD_STRING=$(echo "$TOOL_INPUT" | jq -r '.old_string // ""' | head -c 500)
NEW_STRING=$(echo "$TOOL_INPUT" | jq -r '.new_string // ""' | head -c 500)
CONTENT=$(echo "$TOOL_INPUT" | jq -r '.content // .new_string // ""' | head -c 500)

# Crear ID único para esta solicitud
REQUEST_ID="${TOOL_USE_ID:-$(date +%s%N)}"

# Preparar descripción
case "$TOOL_NAME" in
    "Edit"|"Write")
        DESCRIPTION="Edit: $(basename "$FILE_PATH")"
        DETAIL="$FILE_PATH"
        ;;
    "Bash")
        DESCRIPTION="Run: ${COMMAND:0:50}"
        DETAIL="$COMMAND"
        ;;
    "Read")
        DESCRIPTION="Read: $(basename "$FILE_PATH")"
        DETAIL="$FILE_PATH"
        ;;
    "WebFetch"|"WebSearch")
        URL=$(echo "$TOOL_INPUT" | jq -r '.url // .query // ""')
        DESCRIPTION="$TOOL_NAME: ${URL:0:50}"
        DETAIL="$URL"
        ;;
    "Grep")
        PATTERN=$(echo "$TOOL_INPUT" | jq -r '.pattern // ""')
        DESCRIPTION="Grep: ${PATTERN:0:50}"
        DETAIL="$PATTERN"
        ;;
    "Glob")
        PATTERN=$(echo "$TOOL_INPUT" | jq -r '.pattern // ""')
        DESCRIPTION="Glob: ${PATTERN:0:50}"
        DETAIL="$PATTERN"
        ;;
    mcp__*)
        # mcp__<server>__<tool> -> "MCP <server>: <tool>" en texto legible.
        MCP_REST="${TOOL_NAME#mcp__}"          # claude_ai_ClickUp__clickup_add_time_entry
        MCP_SERVER="${MCP_REST%%__*}"           # claude_ai_ClickUp
        MCP_TOOL="${MCP_REST#*__}"              # clickup_add_time_entry
        MCP_SERVER="${MCP_SERVER//_/ }"
        MCP_TOOL="${MCP_TOOL//_/ }"
        DESCRIPTION="MCP ${MCP_SERVER}: ${MCP_TOOL}"
        DETAIL="$(echo "$TOOL_INPUT" | jq -c '.' 2>/dev/null | head -c 300)"
        ;;
    *)
        DESCRIPTION="$TOOL_NAME"
        DETAIL=""
        ;;
esac

# A subagent's request says so on the card, so he knows it is not the main turn.
[ -n "$AGENT_TYPE" ] && DESCRIPTION="[$AGENT_TYPE] $DESCRIPTION"

# Enviar solicitud de permiso al bridge
REQUEST_JSON=$(jq -n \
    --arg id "$REQUEST_ID" \
    --arg tool "$TOOL_NAME" \
    --arg desc "$DESCRIPTION" \
    --arg detail "$DETAIL" \
    --arg file "$FILE_PATH" \
    --arg cmd "$COMMAND" \
    --arg content "$CONTENT" \
    --arg old "$OLD_STRING" \
    --arg new "$NEW_STRING" \
    --arg session "$SESSION_NAME" \
    '{
        id: $id,
        tool: $tool,
        description: $desc,
        detail: $detail,
        file: $file,
        command: $cmd,
        content: $content,
        old_string: $old,
        new_string: $new,
        session: $session,
        timestamp: now | floor,
        status: "pending"
    }')

# Registrar solicitud en el bridge
PERM_RESULT=$(curl -s --connect-timeout "$CURL_TIMEOUT" -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: $BRIDGE_TOKEN" \
    -d "$REQUEST_JSON" \
    "$BRIDGE_SERVER/api/permission" 2>&1)
echo "[PERM-HOOK] POST result: $PERM_RESULT, ID: $REQUEST_ID" >> /tmp/perm-hook-debug.log
echo "[PERM-HOOK] Starting polling loop for ID: $REQUEST_ID" >> /tmp/perm-hook-debug.log

# Esperar decisión (polling)
START_TIME=$(date +%s)
while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))

    if [ $ELAPSED -ge $TIMEOUT ]; then
        echo "[PERM-HOOK] TIMEOUT ID: $REQUEST_ID" >> /tmp/perm-hook-debug.log
        echo "Permission timeout - no response received" >&2
        exit 2
    fi

    # Consultar decisión
    RESPONSE=$(curl -s --connect-timeout "$CURL_TIMEOUT" -H "Authorization: $BRIDGE_TOKEN" "$BRIDGE_SERVER/api/permission/$REQUEST_ID" 2>/dev/null)
    DECISION=$(echo "$RESPONSE" | jq -r '.decision // "pending"')

    echo "[PERM-HOOK] Poll ID: $REQUEST_ID, Decision: $DECISION, Elapsed: ${ELAPSED}s" >> /tmp/perm-hook-debug.log

    case "$DECISION" in
        "approve")
            echo "[PERM-HOOK] APPROVED ID: $REQUEST_ID" >> /tmp/perm-hook-debug.log
            # The wrapped shape is the only one Claude Code accepts. The bare
            # {"behavior":"allow"} printed here for months was silently ignored,
            # and every approval really came from the blind Enter keystroke —
            # which misses the second of two prompts that appear together
            # (parallel subagent fetches, 2026-09-22).
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
            exit 0
            ;;
        "deny")
            echo "[PERM-HOOK] DENIED ID: $REQUEST_ID" >> /tmp/perm-hook-debug.log
            echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Permission denied by remote user"}}}'
            exit 0
            ;;
        "pending")
            sleep 1  # Esperar y reintentar
            ;;
        *)
            sleep 1
            ;;
    esac
done
