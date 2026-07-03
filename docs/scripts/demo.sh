#!/usr/bin/env bash
# Regenerates the README's demo frame: runs `bun start` in a real tmux pane
# and captures the rendered screen. freeze --execute can't reconstruct
# OpenTUI's alt-screen cursor addressing, so the README carries this captured
# frame in a fenced block instead of a PNG.
# Usage: bash docs/scripts/demo.sh   (prints the frame to stdout)
set -euo pipefail
cd "$(dirname "$0")/../.."
tmux kill-session -t ccpane-demo 2>/dev/null || true
tmux new-session -d -s ccpane-demo -x 70 -y 6 'bun start'
sleep 3
tmux capture-pane -t ccpane-demo -p
tmux kill-session -t ccpane-demo
