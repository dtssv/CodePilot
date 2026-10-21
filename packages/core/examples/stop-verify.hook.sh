#!/bin/sh
# Example user Stop hook (optional). Built-in stopVerify already covers the
# common "code ok ≠ feature done" case — use this when you want a custom gate.
#
# Config (~/.codepilot/config.json or .codepilot/config.json):
#   "hooks": { "Stop": [{ "matcher": "*", "command": "./path/to/stop-verify.hook.sh" }] }
#
# Contract: stdin = JSON payload (reason, stop_hook_active, transcript_hint, …).
#   exit 0  — allow the turn to end
#   exit 2  — block; stderr is fed back to the agent as continue feedback
#   other   — warning only (does not block)

set -eu
payload=$(cat)
# Example: always allow. Replace with your own checks (tests, lint, etc.).
# echo "$payload" | jq -e '.stop_hook_active == true' >/dev/null && exit 0
exit 0
