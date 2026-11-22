#!/usr/bin/env bash
# Checks a running stack: scripts/smoke.sh [base_url]   (default https://localhost)
# By default it only reads: health, the page and its headers, and that /api/me needs a session.
# SMOKE_WRITES=yes also runs the file checks, which WRITE to the stack: using the setup link's tenant (made by the
#   bootstrap command) they set its person's password and authenticator, and create a roadmap, an item and two files
#   (a third, the test virus, is refused). Run them only against a throwaway stack, never one with real data.
# SMOKE_RESOLVE=host:port:address is passed to curl --resolve, for a stack that runs on another machine.
# SMOKE_CONNECT_TO=host:port:host2:port2 is passed to curl --connect-to, so a download link that names a host the
#   machine running this script can't resolve (minio:9000 in the smoke stack) still reaches it.
# SMOKE_WAIT_SECONDS (default 60) bounds the wait for /api/health before the checks run.
# SMOKE_SETUP_URL is a setup link from the bootstrap command (dist/cli/bootstrap.js); the file checks sign in with it,
#   and fail without it. A link works once, so each run with SMOKE_WRITES=yes needs a new one.
#   SMOKE_EMAIL (default you@example.com) is the address it was made for.
set -uo pipefail

base="${1:-https://localhost}"
curl_args=(-sS -k --max-time 60)
if [[ -n "${SMOKE_RESOLVE:-}" ]]; then curl_args+=(--resolve "$SMOKE_RESOLVE"); fi
if [[ -n "${SMOKE_CONNECT_TO:-}" ]]; then curl_args+=(--connect-to "$SMOKE_CONNECT_TO"); fi

failures=0
check() { # description, then the command that must succeed
  local description=$1
  shift
  if "$@"; then echo "ok   $description"; else echo "FAIL $description"; failures=$((failures + 1)); fi
}
finish() {
  if [[ "$failures" -gt 0 ]]; then echo "$failures check(s) failed"; exit 1; fi
  echo "smoke passed"
  exit 0
}
fatal() { # a check failed and the ones after it depend on it
  echo "FAIL $1"
  failures=$((failures + 1))
  finish
}
equals() { [[ "$1" == "$2" ]]; }
has_header() { printf '%s' "$headers" | grep -qi "^$1:"; }
header_starts() { printf '%s' "$headers" | grep -qi "^$1"; }
is_html() { printf '%s' "$headers" | grep -qi '^content-type:.*text/html'; }
body_contains() { printf '%s' "$body" | grep -qF "$1"; }
# The string value of a top-level JSON field (no escapes in the values these checks read).
json_field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p"; }

# The stack may still be starting (or restarting): wait, bounded, until the API answers through the proxy.
wait_seconds="${SMOKE_WAIT_SECONDS:-60}"
deadline=$((SECONDS + wait_seconds))
until health=$(curl "${curl_args[@]}" -f "$base/api/health" 2>/dev/null); do
  if ((SECONDS >= deadline)); then
    echo "FAIL $base/api/health did not answer with 2xx within ${wait_seconds}s"
    exit 1
  fi
  sleep 2
done
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

if [[ "${SMOKE_WRITES:-}" != yes ]]; then
  echo "skip the file checks, which write to the stack (set SMOKE_WRITES=yes on a throwaway stack to run them)"
  finish
fi

# ---- Files (SMOKE_WRITES=yes): sign in, then upload, download, and have a test virus refused.

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
jar="$work/cookies"
csrf=''

# api METHOD PATH [curl args...]: prints the body, then the status code on its own last line.
api() {
  local method=$1 path=$2
  shift 2
  curl "${curl_args[@]}" -b "$jar" -c "$jar" -X "$method" -H "x-csrf-token: $csrf" -w '\n%{http_code}' "$@" "$base$path"
}
api_json() { # METHOD PATH JSON
  api "$1" "$2" -H 'content-type: application/json' --data-binary "$3"
}
status_of() { printf '%s' "$1" | tail -n1; }
body_of() { printf '%s' "$1" | sed '$d'; }

# RFC 6238 code (SHA-1, 30 seconds, 6 digits) for a base32 secret, with only bash and openssl.
# A code computed just before a 30-second boundary arrives in the next window; that is safe because the server
# accepts the previous and the next window too (verifyTotp in apps/api/src/auth/totp.ts, window: 1).
base32_hex() {
  local s alphabet=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567 bits=0 value=0 hex='' c rest i
  s=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -d '=')
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    rest=${alphabet%%"$c"*}
    [[ "$rest" == "$alphabet" ]] && return 1
    value=$(((value << 5) | ${#rest}))
    bits=$((bits + 5))
    if ((bits >= 8)); then
      bits=$((bits - 8))
      hex+=$(printf '%02x' $(((value >> bits) & 255)))
      value=$((value & ((1 << bits) - 1)))
    fi
  done
  printf '%s' "$hex"
}
totp_code() {
  local key counter mac offset
  key=$(base32_hex "$1") || return 1
  counter=$(printf '%016x' $(($(date +%s) / 30)))
  # shellcheck disable=SC2059 # the format is the counter as \x escapes, built here
  mac=$(printf "$(printf '%s' "$counter" | sed 's/../\\x&/g')" |
    openssl dgst -sha1 -mac HMAC -macopt "hexkey:$key" | awk '{print $NF}')
  offset=$((16#${mac:39:1}))
  printf '%06d' $(((16#${mac:offset*2:8} & 0x7fffffff) % 1000000))
}

[[ -n "${SMOKE_SETUP_URL:-}" ]] || fatal "SMOKE_WRITES=yes needs SMOKE_SETUP_URL: the file checks sign in with a setup link from the bootstrap command"
setup_token=${SMOKE_SETUP_URL##*/}
email=${SMOKE_EMAIL:-you@example.com}
password="smoke-$(openssl rand -hex 16)"

res=$(api_json POST /api/auth/password-reset/confirm "{\"token\":\"$setup_token\",\"password\":\"$password\"}")
check "the setup link sets a password (got $(status_of "$res"))" equals "$(status_of "$res")" 204
res=$(api_json POST /api/auth/login "{\"email\":\"$email\",\"password\":\"$password\"}")
csrf=$(json_field "$(body_of "$res")" csrfToken)
[[ "$(status_of "$res")" == 200 && -n "$csrf" ]] || fatal "sign-in with the new password (got $(status_of "$res"))"
res=$(api_json POST /api/auth/totp/enroll/start '{}')
secret=$(json_field "$(body_of "$res")" secret)
[[ "$(status_of "$res")" == 200 && -n "$secret" ]] || fatal "start setting up an authenticator code (got $(status_of "$res"))"
res=$(api_json POST /api/auth/totp/enroll/confirm "{\"code\":\"$(totp_code "$secret")\"}")
csrf=$(json_field "$(body_of "$res")" csrfToken)
[[ "$(status_of "$res")" == 200 && -n "$csrf" ]] || fatal "confirm the authenticator code and finish signing in (got $(status_of "$res"))"
echo "ok   signed in with the setup link"

# The proxy refuses a body over 1 MB anywhere but the upload path, before the API reads it: the API's own 413
# would carry a JSON error, the proxy's carries none.
big_json="$work/big.json"
{ printf '{"name":"too big","description":"'; head -c $((2 * 1024 * 1024)) /dev/zero | tr '\0' 'a'; printf '"}'; } > "$big_json"
res=$(api POST /api/roadmaps -H 'content-type: application/json' --data-binary "@$big_json")
check "a 2 MB JSON body is refused with 413 (got $(status_of "$res"))" equals "$(status_of "$res")" 413
check "the 2 MB body is refused by the proxy, not the API" equals "$(body_of "$res")" ''

res=$(api_json POST /api/roadmaps '{"name":"Smoke test"}')
roadmap_id=$(json_field "$(body_of "$res")" id)
[[ "$(status_of "$res")" == 201 && -n "$roadmap_id" ]] || fatal "create a roadmap (got $(status_of "$res"))"
res=$(api_json POST "/api/roadmaps/$roadmap_id/projects" '{"parentId":null,"title":"Smoke item"}')
item_id=$(json_field "$(body_of "$res")" id)
[[ "$(status_of "$res")" == 201 && -n "$item_id" ]] || fatal "create an item (got $(status_of "$res"))"
files_path="/api/roadmaps/$roadmap_id/projects/$item_id/attachments"

small="$work/small.txt"
printf 'smoke test file %s\n' "$(openssl rand -hex 8)" > "$small"
res=$(api POST "$files_path" -F "file=@$small;filename=smoke.txt;type=text/plain")
file_id=$(json_field "$(body_of "$res")" id)
check "upload a small file returns 201 (got $(status_of "$res"))" equals "$(status_of "$res")" 201
if [[ -n "$file_id" ]]; then
  res=$(api GET "$files_path/$file_id/download")
  url=$(json_field "$(body_of "$res")" url)
  check "the file has a download link (got $(status_of "$res"))" equals "$(status_of "$res")" 200
  downloaded="$work/downloaded"
  headers=$(curl "${curl_args[@]}" -D - -o "$downloaded" "$url")
  check "the download link returns the same bytes" cmp -s "$small" "$downloaded"
  check "the download is sent as an attachment" header_starts 'content-disposition: attachment'
else
  fatal "the upload returned no file id"
fi

# The EICAR test string, in two halves so this script is not itself flagged.
virus="$work/eicar.txt"
# shellcheck disable=SC2016 # the halves are literal text
printf '%s%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR' '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > "$virus"
res=$(api POST "$files_path" -F "file=@$virus;filename=eicar.txt;type=text/plain")
check "upload the test virus returns 422 (got $(status_of "$res"))" equals "$(status_of "$res")" 422
check "the test virus is refused as file_infected" equals "$(json_field "$(body_of "$res")" error)" file_infected

# The largest file allowed (25 MB) passes the proxy's limit on the upload path and the scanner.
largest="$work/largest.bin"
head -c $((25 * 1024 * 1024)) /dev/zero > "$largest"
res=$(api POST "$files_path" -F "file=@$largest;filename=largest.bin;type=application/octet-stream")
check "upload a 25 MB file returns 201 (got $(status_of "$res"))" equals "$(status_of "$res")" 201

if [[ "$failures" -gt 0 ]]; then echo "$failures check(s) failed"; exit 1; fi
echo "smoke passed"
