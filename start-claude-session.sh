#!/bin/bash
# Claude Remote Bridge - Session Starter
# Run this script to start Claude Code in a tmux session with hooks enabled

SESSION_NAME="${CLAUDE_SESSION:-claude}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║        Claude Remote Bridge - Session Starter          ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check dependencies
check_deps() {
    local missing=()

    if ! command -v tmux &> /dev/null; then
        missing+=("tmux")
    fi

    if ! command -v node &> /dev/null; then
        missing+=("node")
    fi

    if ! command -v jq &> /dev/null; then
        missing+=("jq")
    fi

    if ! command -v claude &> /dev/null; then
        missing+=("claude (Claude Code CLI)")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        echo -e "${RED}Missing dependencies:${NC}"
        for dep in "${missing[@]}"; do
            echo "  - $dep"
        done
        echo ""
        echo "Please install missing dependencies and try again."
        exit 1
    fi
}

# Check if session already exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo -e "${YELLOW}Session '$SESSION_NAME' already exists.${NC}"
    echo ""
    echo "Options:"
    echo "  1) Attach to existing session"
    echo "  2) Kill and create new session"
    echo "  3) Exit"
    echo ""
    read -p "Choose [1-3]: " choice

    case $choice in
        1)
            echo "Attaching to session..."
            tmux attach-session -t "$SESSION_NAME"
            exit 0
            ;;
        2)
            echo "Killing existing session..."
            tmux kill-session -t "$SESSION_NAME"
            ;;
        3)
            exit 0
            ;;
        *)
            echo "Invalid choice"
            exit 1
            ;;
    esac
fi

# Check dependencies
check_deps

echo -e "${GREEN}Starting Claude session in tmux...${NC}"
echo ""

# Create new tmux session with Claude Code
tmux new-session -d -s "$SESSION_NAME" -x 200 -y 50

# Set up environment in the tmux session
tmux send-keys -t "$SESSION_NAME" "export TMUX_SESSION=$SESSION_NAME" Enter
tmux send-keys -t "$SESSION_NAME" "export CLAUDE_BRIDGE_DIR='$SCRIPT_DIR'" Enter

# Start Claude Code
tmux send-keys -t "$SESSION_NAME" "cd '$(pwd)' && claude" Enter

echo -e "${GREEN}Session started!${NC}"
echo ""
echo "Next steps:"
echo "  1. Attach to session: tmux attach -t $SESSION_NAME"
echo "  2. Start bridge server: node $SCRIPT_DIR/server.js"
echo ""
echo -e "${BLUE}Tip: Run both in separate terminals or use tmux splits${NC}"
echo ""

# Ask if user wants to attach
read -p "Attach to session now? [Y/n]: " attach
if [[ ! "$attach" =~ ^[Nn]$ ]]; then
    tmux attach-session -t "$SESSION_NAME"
fi
