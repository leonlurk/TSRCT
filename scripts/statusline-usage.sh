#!/usr/bin/env bash
# TSRCT status line + the ONLY honest source of the Claude.ai quota bars.
#
# Claude Code hands a status line command a JSON payload on stdin that contains a
# `rate_limits` block: the 5-hour and 7-day windows, each with `used_percentage`
# and `resets_at`. Those percentages are the real limits Leon lives under (Max 5x)
# and they exist NOWHERE on disk -- Claude Code fetches them from its usage
# endpoint and keeps them in memory. A status line is the supported way to read
# them without a token, an API call, or a screen scrape.
#
# So this script does two jobs, in this order:
#   1. persist `rate_limits` (plus a captured_at stamp) to a small JSON file that
#      TSRCT's [$] USAGE panel reads,
#   2. print the status line itself.
#
# It must NEVER fail the status line: every step degrades to printing something.
# jq is used when present and a pure-bash fallback covers the case where it is not.

set -uo pipefail

OUT="$HOME/.claude/tsrct-rate-limits.json"
TMP="$OUT.tmp.$$"
INPUT="$(cat)"

field() {   # field <regex-key> -- first JSON string/number value for that key
    printf '%s' "$INPUT" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"\?[^,\"}]*" | head -1 \
        | sed 's/.*:[[:space:]]*"\?//'
}

if command -v jq >/dev/null 2>&1; then
    # `// empty` so a Claude Code build without rate_limits leaves the previous
    # reading alone instead of overwriting it with null -- a stale-but-real number
    # beats a fresh empty one, and the panel shows the age either way.
    BARS="$(printf '%s' "$INPUT" | jq -c '.rate_limits // empty' 2>/dev/null)"
    if [ -n "$BARS" ]; then
        printf '%s' "$INPUT" | jq -c \
            --argjson now "$(date +%s000)" \
            '{captured_at: $now, rate_limits: .rate_limits,
              session: (.session_id // ""), model: (.model.display_name // .model.id // ""),
              cwd: (.workspace.current_dir // .cwd // "")}' > "$TMP" 2>/dev/null \
            && mv -f "$TMP" "$OUT"
    fi
    FIVE="$(printf '%s' "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)"
    SEVEN="$(printf '%s' "$INPUT" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)"
    MODEL="$(printf '%s' "$INPUT" | jq -r '.model.display_name // .model.id // ""' 2>/dev/null)"
    DIR="$(printf '%s' "$INPUT" | jq -r '.workspace.current_dir // .cwd // ""' 2>/dev/null)"
    CTX="$(printf '%s' "$INPUT" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)"
else
    FIVE="$(field 'used_percentage')"
    SEVEN=""
    MODEL="$(field 'display_name')"
    DIR="$(field 'current_dir')"
    CTX=""
fi

rm -f "$TMP" 2>/dev/null

pctf() { [ -n "${1:-}" ] && printf '%.0f' "$1" 2>/dev/null || printf '?'; }

LINE=""
[ -n "$FIVE" ]  && LINE="$LINE[5h $(pctf "$FIVE")%] "
[ -n "$SEVEN" ] && LINE="$LINE[7d $(pctf "$SEVEN")%] "
[ -n "$CTX" ]   && LINE="$LINE[ctx $(pctf "$CTX")%] "
[ -n "$MODEL" ] && LINE="$LINE$MODEL "
[ -n "$DIR" ]   && LINE="$LINE· $(basename "$DIR")"

printf '%s' "${LINE:-TSRCT}"
