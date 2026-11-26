#!/usr/bin/env bash
# Checks a deployed stack from outside:   scripts/post-deploy-check.sh [options] <origin>
#   for example: scripts/post-deploy-check.sh https://roadmap.example.com
# It sends GET requests only and creates no data, so it is safe against the live server. It checks:
#   - /api/health answers 200
#   - the certificate is valid (curl verifies it; there is never a -k) and TLS 1.1 is refused
#   - Strict-Transport-Security is there with a max-age of at least a year
#   - the Content-Security-Policy header is there
#   - a calendar feed that does not exist answers 404 with X-Robots-Tag
#   - plain http:// redirects to https://
# Options, for a stack on a developer machine:
#   --insecure-for-local-ca <file>  trust this one CA file (Caddy's local CA) and nothing else, with curl's --cacert.
#                                   The certificate is still checked, against that file. It never turns checking off.
#   --connect-to <host:port:host:port>  curl's --connect-to, for a stack that listens on other ports (repeatable)
#   --http-origin <url>             where to send the plain http:// request (default: the origin with http://)
# CHECK_WAIT_SECONDS (default 120) bounds the wait for /api/health, for a stack that has only just started.
set -uo pipefail

ca_file=''
http_origin=''
connect_to=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --insecure-for-local-ca)
      ca_file=${2:?--insecure-for-local-ca needs a file}
      shift 2
      ;;
    --connect-to)
      connect_to+=("${2:?--connect-to needs a value}")
      shift 2
      ;;
    --http-origin)
      http_origin=${2:?--http-origin needs a URL}
      shift 2
      ;;
    -*)
      echo "unknown option: $1" >&2
      exit 2
      ;;
    *) break ;;
  esac
done
if [[ $# -ne 1 || ! "$1" =~ ^https://[^/]+$ ]]; then
  echo "usage: post-deploy-check.sh [--insecure-for-local-ca <file>] [--connect-to <spec>] [--http-origin <url>] https://<host>" >&2
  exit 2
fi
origin=$1
if [[ -z "$http_origin" ]]; then http_origin="http://${origin#https://}"; fi

# GET only (curl's default), a time limit on everything, and no -k.
curl_args=(-sS --max-time 30)
if [[ -n "$ca_file" ]]; then curl_args+=(--cacert "$ca_file"); fi
for spec in "${connect_to[@]+"${connect_to[@]}"}"; do curl_args+=(--connect-to "$spec"); done

failures=0
check() { # description, then the command that must succeed
  local description=$1
  shift
  if "$@"; then echo "ok   $description"; else echo "FAIL $description"; failures=$((failures + 1)); fi
}
# Not grep -q: under pipefail, grep stopping at its first match can leave the writer to die of SIGPIPE.
has_header() { printf '%s' "$1" | grep -i "^$2:" > /dev/null; }
status_of() { printf '%s' "$1" | head -n 1 | awk '{print $2}'; }
header_value() { printf '%s' "$1" | grep -i "^$2:" | head -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

# 1. Health, and the certificate with it: the request is verified, so a bad certificate shows as a failure here.
deadline=$((SECONDS + ${CHECK_WAIT_SECONDS:-120}))
err_file=$(mktemp)
trap 'rm -f "$err_file"' EXIT
while true; do
  health_status=$(curl "${curl_args[@]}" -o /dev/null -w '%{http_code}' "$origin/api/health" 2> "$err_file") || health_status=''
  if [[ "$health_status" == 200 || "$SECONDS" -ge "$deadline" ]]; then break; fi
  sleep 3
done
health_error=$(cat "$err_file")
if [[ "$health_status" == 200 ]]; then
  echo "ok   GET /api/health is 200"
  echo "ok   the certificate is valid (curl checked it)"
else
  echo "FAIL GET /api/health is 200 (got '${health_status:-nothing}'${health_error:+, curl said: $health_error})"
  echo "FAIL the certificate is valid (the request could not be made with checking on)"
  exit 1
fi

# 2. TLS 1.2 works and TLS 1.1 is refused by the server. A TLS 1.1 attempt needs a client that is still willing to
#    speak it, so it goes through openssl s_client at security level 0, and only a refusal from the server counts
#    (a protocol alert, or the connection dropped). A client that cannot even try is not a pass: with no openssl, or one
#    built without TLS 1.1, the check falls back to curl and the failure is reported as unproven.
tls12() { curl "${curl_args[@]}" --tlsv1.2 --tls-max 1.2 -o /dev/null "$origin/api/health"; }
tls11_refused() {
  local host=${origin#https://} port=443 target spec
  if [[ "$host" == *:* ]]; then
    port=${host##*:}
    host=${host%:*}
  fi
  target="$host:$port"
  for spec in "${connect_to[@]+"${connect_to[@]}"}"; do
    IFS=: read -r from_host from_port to_host to_port <<< "$spec"
    if [[ "$from_host" == "$host" && "$from_port" == "$port" ]]; then target="$to_host:$to_port"; fi
  done
  if ! command -v openssl > /dev/null; then
    echo "     (no openssl here, so TLS 1.1 could not be tried)" >&2
    return 1
  fi
  local out
  out=$(echo | timeout 20 openssl s_client -connect "$target" -servername "$host" -tls1_1 -cipher 'ALL:@SECLEVEL=0' 2>&1) || true
  if grep -Eq 'no protocols available|unsupported protocol|no ciphers available|Connection refused|Name or service not known' <<< "$out"; then
    echo "     (this client could not try TLS 1.1, or could not connect)" >&2
    return 1
  fi
  # A session that was set up names a cipher; a refusal shows "Cipher is (NONE)" and "Cipher : 0000".
  ! grep -Eq 'Cipher is [A-Za-z0-9]|Cipher +: +[A-Za-z]' <<< "$out" || return 1
  grep -Eqi 'alert protocol version|alert handshake failure|wrong version number|unexpected eof|connection reset|alert number (70|40)' <<< "$out"
}
check 'TLS 1.2 is accepted' tls12
check 'TLS 1.1 is refused' tls11_refused

# 3. Headers on the front page.
headers=$(curl "${curl_args[@]}" -D - -o /dev/null "$origin/") || headers=''
hsts=$(header_value "$headers" strict-transport-security)
hsts_long_enough() {
  local seconds
  seconds=$(printf '%s' "$hsts" | sed -n 's/.*max-age=\([0-9][0-9]*\).*/\1/p')
  [[ -n "$seconds" && "$seconds" -ge 31536000 ]]
}
check "Strict-Transport-Security has max-age of at least 31536000 (got '$hsts')" hsts_long_enough
check 'Content-Security-Policy is present' has_header "$headers" content-security-policy

# 4. A calendar feed that does not exist: 404, and search engines told to stay away. 43 random base64url characters.
token=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
feed_headers=$(curl "${curl_args[@]}" -D - -o /dev/null "$origin/api/calendar/$token.ics") || feed_headers=''
feed_status=$(status_of "$feed_headers")
check "GET /api/calendar/<unknown token>.ics is 404 (got ${feed_status:-nothing})" test "$feed_status" = 404
check 'the calendar 404 has X-Robots-Tag' has_header "$feed_headers" x-robots-tag

# 5. http:// goes to https:// (no redirect following, so the answer itself is read).
redirect=$(curl "${curl_args[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "$http_origin/" 2> /dev/null) || redirect=''
redirect_code=${redirect%% *}
redirect_to=${redirect#* }
redirects_to_https() { [[ "$redirect_code" =~ ^30[1278]$ && "$redirect_to" == https://* ]]; }
check "http:// redirects to https:// (got '$redirect')" redirects_to_https

if [[ "$failures" -gt 0 ]]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "post-deploy check passed"
