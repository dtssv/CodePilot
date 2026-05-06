#!/usr/bin/env bash
# codePilot-reset — external reset helper (use when the IDE is frozen)
# Usage: ./codePilot-reset.sh [soft|hard|factory]
# Sentinel files consumed by CodePilotStartupActivity on next IDE launch.

set -euo pipefail

ROOT="${HOME}/.codePilot"
FLAGS="${ROOT}/flags"

mkdir -p "$FLAGS"

case "${1:-soft}" in
  soft)
    echo "Writing soft-reset sentinel…"
    touch "${FLAGS}/reset_soft"
    echo "Done. Restart the IDE; credentials will be cleared."
    ;;
  hard)
    echo "Writing hard-local reset sentinel…"
    touch "${FLAGS}/reset_hard_local"
    echo "Done. Next IDE start will rename ~/.codePilot to ~/.codePilot.broken-<ts> and start clean."
    ;;
  factory)
    echo "Writing factory-reset sentinel…"
    touch "${FLAGS}/reset_factory"
    echo "Done. Next IDE start will move ~/.codePilot, clear PasswordSafe credentials, and start fresh."
    ;;
  *)
    echo "Usage: $0 [soft|hard|factory]"
    exit 1
    ;;
esac