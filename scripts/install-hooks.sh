#!/usr/bin/env bash
# Installs the git pre-commit hook (cleanup P4 #20): every commit runs the fast
# suite (`node scripts/check-all.js --fast`, ~15 s, everything but check-brain)
# and is refused while a check is red. There is no CI - this is the gate.
# Skip once, on purpose only: git commit --no-verify
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
hook=.git/hooks/pre-commit
if [ -e "$hook" ] && ! grep -q 'installed by scripts/install-hooks.sh' "$hook"; then
    echo "[!] $hook exists and is not ours - not touching it" >&2
    exit 1
fi
cat > "$hook" <<'EOF'
#!/bin/sh
# installed by scripts/install-hooks.sh - the full suite is `npm run check`
exec node scripts/check-all.js --fast
EOF
chmod +x "$hook"
echo "[+] pre-commit hook installed: $hook"
