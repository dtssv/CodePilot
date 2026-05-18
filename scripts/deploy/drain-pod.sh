#!/usr/bin/env bash
# Trigger deploy drain on a CodePilot backend instance (bare metal or port-forwarded pod).
# Usage:
#   ./scripts/deploy/drain-pod.sh [base-url]
#   ./scripts/deploy/drain-pod.sh http://127.0.0.1:8080
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8080}"
BASE_URL="${BASE_URL%/}"

echo "POST ${BASE_URL}/actuator/drain"
if command -v curl >/dev/null 2>&1; then
  curl -sf -X POST "${BASE_URL}/actuator/drain"
else
  wget -qO- --post-data='' "${BASE_URL}/actuator/drain"
fi
echo ""
echo "GET ${BASE_URL}/actuator/drain"
if command -v curl >/dev/null 2>&1; then
  curl -sf "${BASE_URL}/actuator/drain"
else
  wget -qO- "${BASE_URL}/actuator/drain"
fi
echo ""
