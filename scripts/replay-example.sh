#!/usr/bin/env bash
# Replays the brief's March 15 and March 16 feeds against a running service and prints
# the resulting inventory. Requires curl. Pretty-prints with jq when it is installed.
#
#   scripts/replay-example.sh                     # against http://localhost:8080
#   BASE_URL=http://localhost:9090 scripts/replay-example.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
DEALERSHIP_ID="LHS-1042"
ACCORD_VIN="1HGCY1F39TA098765"
EXAMPLES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../examples" && pwd)"

pretty() {
  if command -v jq >/dev/null 2>&1; then jq .; else cat; echo; fi
}

# Prints "HTTP <status>" then the body; fails only on transport errors, so 4xx/5xx are shown.
request() {
  local method="$1" path="$2" body_file="${3:-}"
  local response status
  if [[ -n "$body_file" ]]; then
    response="$(curl -sS -X "$method" -H 'content-type: application/json' --data-binary "@$body_file" -w '\n%{http_code}' "$BASE_URL$path")"
  else
    response="$(curl -sS -X "$method" -w '\n%{http_code}' "$BASE_URL$path")"
  fi
  status="${response##*$'\n'}"
  echo "HTTP $status"
  printf '%s' "${response%$'\n'*}" | pretty
}

section() {
  printf '\n=== %s ===\n' "$1"
}

section "POST March 15 feed"
request POST /v1/feeds "$EXAMPLES_DIR/2026-03-15.json"

section "POST March 16 feed"
request POST /v1/feeds "$EXAMPLES_DIR/2026-03-16.json"

section "POST March 16 feed again (replay: nothing changes)"
request POST /v1/feeds "$EXAMPLES_DIR/2026-03-16.json"

section "Active inventory for $DEALERSHIP_ID"
request GET "/v1/dealerships/$DEALERSHIP_ID/vehicles"

section "Removed vehicles for $DEALERSHIP_ID"
request GET "/v1/dealerships/$DEALERSHIP_ID/vehicles?status=removed"

section "Accord by VIN (removed, daysInInventory 6)"
request GET "/v1/dealerships/$DEALERSHIP_ID/vehicles/$ACCORD_VIN"

section "Dealerships"
request GET /v1/dealerships
