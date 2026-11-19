#!/usr/bin/env bash
# Checks a running stack: scripts/smoke.sh [base_url]   (default https://localhost)
# SMOKE_RESOLVE=host:port:address is passed to curl --resolve, for a stack that runs on another machine.
set -uo pipefail

base="${1:-https://localhost}"
curl_args=(-sS -k --max-time 15)
if [[ -n "${SMOKE_RESOLVE:-}" ]]; then curl_args+=(--resolve "$SMOKE_RESOLVE"); fi

failures=0
check() { # description, then the command that must succeed
  local description=$1
  shift
  if "$@"; then echo "ok   $description"; else echo "FAIL $description"; failures=$((failures + 1)); fi
}
equals() { [[ "$1" == "$2" ]]; }
has_header() { printf '%s' "$headers" | grep -qi "^$1:"; }
is_html() { printf '%s' "$headers" | grep -qi '^content-type:.*text/html'; }
body_contains() { printf '%s' "$body" | grep -qF "$1"; }

health=$(curl "${curl_args[@]}" "$base/api/health") || { echo "FAIL cannot reach $base"; exit 1; }
check 'GET /api/health returns {"status":"ok"}' equals "$health" '{"status":"ok"}'

headers=$(curl "${curl_args[@]}" -D - -o /dev/null "$base/") || { echo "FAIL cannot reach $base/"; exit 1; }
body=$(curl "${curl_args[@]}" "$base/")
status=$(printf '%s' "$headers" | head -n1 | awk '{print $2}')
check "GET / returns 200 (got $status)" equals "$status" 200
check "GET / is text/html" is_html
check 'GET / contains <div id="root">' body_contains '<div id="root">'
check "content-security-policy header present" has_header content-security-policy
check "strict-transport-security header present" has_header strict-transport-security

me=$(curl "${curl_args[@]}" -o /dev/null -w '%{http_code}' "$base/api/me")
check "GET /api/me returns 401 (got $me)" equals "$me" 401

if [[ "$failures" -gt 0 ]]; then echo "$failures check(s) failed"; exit 1; fi
echo "smoke passed"
