#!/bin/bash
# Claude Remote Bridge - Enhanced Notification Script
# Handles all Claude Code hooks and sends rich notifications

# DEBUG: Log every call
echo "[$(date)] Hook called" >> /tmp/claude-hook-debug.log

# Configuration
NTFY_TOPIC="${NTFY_TOPIC:-}"
NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"
BRIDGE_SERVER="${BRIDGE_SERVER:-http://localhost:3847}"

# Bridge auth token - the server requires it on every endpoint. .env is the
# source of truth; only fall back to an inherited env var if .env has none.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_FILE_TOKEN="$(grep -oP '^\s*BRIDGE_TOKEN=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null | tr -d '\r')"
BRIDGE_TOKEN="${_FILE_TOKEN:-$BRIDGE_TOKEN}"

# Read hook data from stdin
HOOK_DATA=$(cat)
echo "[$(date)] Hook data: $HOOK_DATA" >> /tmp/claude-hook-debug.log

# Extract common information
HOOK_EVENT=$(echo "$HOOK_DATA" | jq -r '.hook_event_name // "unknown"')
NOTIFICATION_TYPE=$(echo "$HOOK_DATA" | jq -r '.notification_type // ""')
MESSAGE=$(echo "$HOOK_DATA" | jq -r '.message // ""')
CWD=$(echo "$HOOK_DATA" | jq -r '.cwd // "unknown"')
TOOL_NAME=$(echo "$HOOK_DATA" | jq -r '.tool_name // ""')
TOOL_INPUT=$(echo "$HOOK_DATA" | jq -r '.tool_input // {}')
SESSION_ID=$(echo "$HOOK_DATA" | jq -r '.session_id // ""')
PERMISSION_MODE=$(echo "$HOOK_DATA" | jq -r '.permission_mode // "default"')

# Extract tool-specific details
FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .filePath // ""')
COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // ""')
CONTENT_PREVIEW=$(echo "$TOOL_INPUT" | jq -r '.content // .new_string // ""' | head -c 200)

# Determine notification based on hook event
case "$HOOK_EVENT" in
    "PreToolUse")
        case "$TOOL_NAME" in
            "Edit"|"Write"|"NotebookEdit")
                TITLE="Claude: File Edit"
                BODY="Editing: $(basename "$FILE_PATH")"
                PRIORITY="default"
                TAGS="pencil"
                ACTION_TYPE="edit"
                ;;
            "Bash")
                TITLE="Claude: Running Command"
                BODY="$ ${COMMAND:0:100}"
                PRIORITY="default"
                TAGS="computer"
                ACTION_TYPE="bash"
                ;;
            *)
                TITLE="Claude: Using $TOOL_NAME"
                BODY="Tool: $TOOL_NAME"
                PRIORITY="default"
                TAGS="gear"
                ACTION_TYPE="tool"
                ;;
        esac
        ;;
    "PermissionRequest")
        TITLE="Claude Needs Permission"
        case "$TOOL_NAME" in
            "Edit"|"Write")
                BODY="Approve edit to: $(basename "$FILE_PATH")"
                TAGS="warning,pencil"
                ;;
            "Bash")
                BODY="Approve command: ${COMMAND:0:80}"
                TAGS="warning,computer"
                ;;
            *)
                BODY="Approve: $TOOL_NAME"
                TAGS="warning"
                ;;
        esac
        PRIORITY="default"
        ACTION_TYPE="permission"
        ;;
    "Notification")
        case "$NOTIFICATION_TYPE" in
            "idle_prompt")
                TITLE="Claude is Waiting"
                BODY="Idle for 60+ seconds - needs input"
                PRIORITY="low"
                TAGS="hourglass"
                ACTION_TYPE="idle"
                ;;
            "permission_prompt")
                TITLE="Claude Needs Approval"
                BODY="${MESSAGE:-Permission required}"
                PRIORITY="default"
                TAGS="warning"
                ACTION_TYPE="permission"
                ;;
            "elicitation_dialog")
                TITLE="Claude Asking Question"
                BODY="${MESSAGE:-Claude has a question}"
                PRIORITY="default"
                TAGS="question"
                ACTION_TYPE="question"
                ;;
            *)
                TITLE="Claude Notification"
                BODY="${MESSAGE:-Notification}"
                PRIORITY="default"
                TAGS="bell"
                ACTION_TYPE="notification"
                ;;
        esac
        ;;
    "Stop")
        TITLE="Claude Finished"
        BODY="Task completed - ready for next prompt"
        PRIORITY="low"
        TAGS="white_check_mark"
        ACTION_TYPE="stop"
        ;;
    "SubagentStop")
        TITLE="Claude: Task Agent Done"
        BODY="Subagent completed its work"
        PRIORITY="default"
        TAGS="checkered_flag"
        ACTION_TYPE="subagent_stop"
        ;;
    *)
        TITLE="Claude Update"
        BODY="Event: $HOOK_EVENT"
        PRIORITY="low"
        TAGS="information_source"
        ACTION_TYPE="unknown"
        ;;
esac

# Add project context
PROJECT_NAME=$(basename "$CWD")
BODY="$BODY
Project: $PROJECT_NAME"

# Send event to bridge server (for real-time UI updates)
EVENT_JSON=$(cat <<EOF
{
    "event": "$HOOK_EVENT",
    "type": "$ACTION_TYPE",
    "title": "$TITLE",
    "body": "$BODY",
    "tool": "$TOOL_NAME",
    "file": "$FILE_PATH",
    "command": "$COMMAND",
    "message": "$MESSAGE",
    "project": "$PROJECT_NAME",
    "timestamp": $(date +%s),
    "session_id": "$SESSION_ID",
    "notification_type": "$NOTIFICATION_TYPE"
}
EOF
)

# Post to bridge server (non-blocking)
curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: $BRIDGE_TOKEN" \
    -d "$EVENT_JSON" \
    "$BRIDGE_SERVER/api/event" > /dev/null 2>&1 &

# ntfy push notifications DISABLED (user doesn't use them). The /api/event POST
# above still feeds the in-app event stream. To re-enable, restore the curl to
# "$NTFY_SERVER/$NTFY_TOPIC" with Title/Priority/Tags/Actions headers.

# Log for debugging
echo "[$(date)] Sent: $TITLE - $ACTION_TYPE" >> ~/.claude-bridge.log 2>/dev/null

exit 0
