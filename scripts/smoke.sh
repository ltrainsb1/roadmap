#!/usr/bin/env bash
# Checks a running stack: scripts/smoke.sh [base_url]   (default https://localhost)
# By default it only reads: health, the page and its headers, and that /api/me needs a session.
# SMOKE_WRITES=yes also runs the file checks, which WRITE to the stack: using the setup link's tenant (made by the
#   bootstrap command) they set its person's password and authenticator, and create a roadmap, an item and two files
#   (a third, the test virus, is refused). Then they share the roadmap as a snapshot, open it with its password,
#   have the PDF service print it, check port 8080 (the PDF service's internal listener) does not answer, and revoke
#   the snapshot. Then they turn on a calendar feed, give the item dates, fetch the feed with no session (and again
#   with its ETag), and turn the feed off. Run them only against a throwaway stack, never one with real data.
# SMOKE_COMPOSE is the stack's Compose command (for example "docker compose -f deploy/poc/docker-compose.yml -f
#   deploy/poc/docker-compose.smoke.yml"). With it, and SMOKE_WRITES=yes, the email checks run too: they invite a
#   second person, read the invite link from the API container's outbox file (MAILER=file), accept it, assign that
#   person to the item, and wait for the worker container to write the assignment email to its own outbox file.
#   They then POST that email's one-click unsubscribe link (the List-Unsubscribe header) and check the second person's
#   email settings are all off.
#   They also check the worker is healthy. Without it these checks are skipped.
# SMOKE_RESOLVE=host:port:address is passed to curl --resolve, for a stack that runs on another machine.
# SMOKE_CONNECT_TO=host:port:host2:port2 is passed to curl --connect-to, so a download link that names a host the
#   machine running this script can't resolve (minio:9000 in the smoke stack) still reaches it.
# SMOKE_WAIT_SECONDS (default 60) bounds the wait for /api/health before the checks run, and the wait for the
#   assignment email.
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
# Not grep -q: under pipefail, grep stopping at its first match can leave the writer to die of SIGPIPE, which would
# read as no match.
has_header() { printf '%s' "$headers" | grep -i "^$1:" > /dev/null; }
header_starts() { printf '%s' "$headers" | grep -i "^$1" > /dev/null; }
is_html() { printf '%s' "$headers" | grep -i '^content-type:.*text/html' > /dev/null; }
body_contains() { printf '%s' "$body" | grep -F "$1" > /dev/null; }
body_contains_in() { printf '%s' "$1" | grep -F "$2" > /dev/null; }
not() { ! "$@" 2> /dev/null; }
# The string value of a top-level JSON field (no escapes in the values these checks read).
json_field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p"; }
# The number value of a top-level JSON field.
json_number() { printf '%s' "$1" | sed -n "s/.*\"$2\":\\([0-9][0-9]*\\).*/\\1/p"; }

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

# ---- Snapshots and PDFs (SMOKE_WRITES=yes): share the roadmap by link and password, print it through the PDF
# service, then revoke it. The snapshot is revoked even when a check before that fails.

snap_password="smoke-$(openssl rand -hex 12)"
res=$(api_json POST "/api/roadmaps/$roadmap_id/snapshots" \
  "{\"name\":\"Smoke snapshot\",\"asOf\":\"$(date -u +%F)\",\"password\":\"$snap_password\",\"expiresAt\":null,\"include\":{\"notes\":false,\"assignees\":false}}")
snapshot_id=$(json_field "$(body_of "$res")" id)
link_id=$(json_field "$(body_of "$res")" linkId)
[[ "$(status_of "$res")" == 201 && -n "$snapshot_id" && -n "$link_id" ]] || fatal "create a snapshot (got $(status_of "$res"))"
snap="/api/snapshots/$link_id"
viewer="$work/viewer-cookies"
# viewer METHOD PATH [curl args...]: as api, but as someone with no account: only the snapshot's own cookie.
viewer() {
  local method=$1 path=$2
  shift 2
  curl "${curl_args[@]}" -b "$viewer" -c "$viewer" -X "$method" -w '\n%{http_code}' "$@" "$base$path"
}

res=$(viewer GET "$snap")
check "the snapshot link answers (got $(status_of "$res"))" equals "$(status_of "$res")" 200
headers=$(curl "${curl_args[@]}" -D - -o /dev/null "$base/s/$link_id")
check "the snapshot page says noindex, nofollow" header_starts 'x-robots-tag: noindex, nofollow'
headers=$(curl "${curl_args[@]}" -D - -o /dev/null "$base$snap")
check "the snapshot API says noindex, nofollow" header_starts 'x-robots-tag: noindex, nofollow'
res=$(viewer GET "$snap/content")
check "the snapshot's content needs its password first (got $(status_of "$res"))" equals "$(status_of "$res")" 401
res=$(viewer POST "$snap/unlock" -H 'content-type: application/json' --data-binary "{\"password\":\"$snap_password\"}")
check "the right password opens the snapshot (got $(status_of "$res"))" equals "$(status_of "$res")" 204
res=$(viewer GET "$snap/content")
check "the opened snapshot's content is readable (got $(status_of "$res"))" equals "$(status_of "$res")" 200
check "the content is the roadmap's" body_contains_in "$(body_of "$res")" 'Smoke item'

# Chromium in the PDF service prints the page from Caddy's internal listener; the API stores it and links to it.
res=$(viewer POST "$snap/pdf" -H 'content-type: application/json' --data-binary '{"view":"list"}')
check "the list PDF is made (got $(status_of "$res"))" equals "$(status_of "$res")" 200
url=$(json_field "$(body_of "$res")" url)
if [[ -n "$url" ]]; then
  pdf="$work/snapshot.pdf"
  curl "${curl_args[@]}" -o "$pdf" "$url"
  check "the PDF's download link returns a PDF" equals "$(head -c 5 "$pdf" 2>/dev/null)" '%PDF-'
else
  check "the PDF request returned a download link" false
fi

# The internal listener (8080) is for the PDF service only: never published, so nothing answers it from here.
host_port=${base#*://}
host_port=${host_port%%/*}
internal_host=${host_port%:*}
internal_args=(-sS --max-time 10 -o /dev/null)
if [[ -n "${SMOKE_RESOLVE:-}" ]]; then internal_args+=(--resolve "$internal_host:8080:${SMOKE_RESOLVE#*:*:}"); fi
check "port 8080 does not answer from outside the stack" not curl "${internal_args[@]}" "http://$internal_host:8080/"

res=$(api DELETE "/api/roadmaps/$roadmap_id/snapshots/$snapshot_id")
check "revoke the snapshot (got $(status_of "$res"))" equals "$(status_of "$res")" 204
res=$(viewer GET "$snap")
check "the revoked snapshot's link is not found (got $(status_of "$res"))" equals "$(status_of "$res")" 404

# ---- Calendar feed (SMOKE_WRITES=yes): a private feed shows the item's dates to a calendar app with no session,
# answers 304 to a matching ETag, and is gone once turned off.

res=$(api_json POST /api/me/calendar-feed '{}')
feed_url=$(json_field "$(body_of "$res")" url)
[[ "$(status_of "$res")" == 201 && -n "$feed_url" ]] || fatal "turn on the calendar feed (got $(status_of "$res"))"
# The link names APP_ORIGIN, which may not be where this script reaches the stack: keep only its path.
feed_path="/${feed_url#*://*/}"
check "the feed link is a calendar path (got ${feed_path%/*}/…)" equals "${feed_path%/*}" /api/calendar
# The roadmap has the one item, so its list carries one version.
res=$(api GET "/api/roadmaps/$roadmap_id/projects")
item_version=$(json_number "$(body_of "$res")" version)
[[ "$(status_of "$res")" == 200 && -n "$item_version" ]] || fatal "read the item's version (got $(status_of "$res"))"
res=$(api_json PATCH "/api/roadmaps/$roadmap_id/projects/$item_id" \
  "{\"version\":$item_version,\"startDate\":\"$(date -u +%F)\",\"endDate\":\"$(date -u +%F)\"}")
check "give the item dates (got $(status_of "$res"))" equals "$(status_of "$res")" 200

# No cookie: a calendar app has only the link.
feed_body="$work/feed.ics"
headers=$(curl "${curl_args[@]}" -D - -o "$feed_body" "$base$feed_path")
status=$(printf '%s' "$headers" | head -n1 | awk '{print $2}')
check "the feed answers with no session (got $status)" equals "$status" 200
check "the feed is text/calendar" header_starts 'content-type: text/calendar'
check "the feed is a calendar" equals "$(head -n1 "$feed_body" | tr -d '\r')" BEGIN:VCALENDAR
check "the feed has the item" body_contains_in "$(cat "$feed_body")" 'SUMMARY:Smoke item'
check "the feed says noindex, nofollow" header_starts 'x-robots-tag: noindex, nofollow'
robots=$(printf '%s' "$headers" | grep -ic '^x-robots-tag:')
check "the feed sends x-robots-tag once (got $robots)" equals "$robots" 1
etag=$(printf '%s' "$headers" | grep -i '^etag:' | sed 's/^[^:]*: *//' | tr -d '\r')
status=$(curl "${curl_args[@]}" -o /dev/null -w '%{http_code}' -H "if-none-match: $etag" "$base$feed_path")
check "the feed answers 304 to its ETag (got $status)" equals "$status" 304

res=$(api DELETE /api/me/calendar-feed)
check "turn off the calendar feed (got $(status_of "$res"))" equals "$(status_of "$res")" 204
headers=$(curl "${curl_args[@]}" -D - -o /dev/null "$base$feed_path")
status=$(printf '%s' "$headers" | head -n1 | awk '{print $2}')
check "the turned-off feed is not found (got $status)" equals "$status" 404
# The API sends the header only with a calendar; the proxy sends it on every feed path, the 404 too.
check "the turned-off feed's 404 says noindex, nofollow" header_starts 'x-robots-tag: noindex, nofollow'

# ---- Notifications (SMOKE_WRITES=yes and SMOKE_COMPOSE): an assignment reaches the assigned person by email.

if [[ -z "${SMOKE_COMPOSE:-}" ]]; then
  echo "skip the email checks, which read the containers' mail (set SMOKE_COMPOSE to the stack's Compose command to run them)"
  finish
fi
# outbox SERVICE: what that container's file mailer has written (nothing yet if it has sent no mail).
outbox() {
  # shellcheck disable=SC2086,SC2016 # SMOKE_COMPOSE is a command and its arguments; the variable is the container's
  $SMOKE_COMPOSE exec -T "$1" sh -c 'cat "$MAIL_OUTBOX_FILE" 2> /dev/null' 2> /dev/null || true
}
# The member entry (one object of the members list) with this email address.
member_with_email() { printf '%s' "$1" | sed 's/},{/}\n{/g' | grep -F "\"email\":\"$2\""; }

invitee="smoke-$(openssl rand -hex 6)@example.com"
res=$(api_json POST "/api/roadmaps/$roadmap_id/invites" "{\"email\":\"$invitee\",\"role\":\"contributor\"}")
[[ "$(status_of "$res")" == 201 ]] || fatal "invite a second person (got $(status_of "$res"))"
invite_token=$(outbox api | grep -F "\"to\":\"$invitee\"" | grep -o '/invite/[A-Za-z0-9_-]*' | tail -n1 | sed 's|^/invite/||')
[[ -n "$invite_token" ]] || fatal "the invite email is in the API's outbox"
echo "ok   the invite email is in the API's outbox"
# A new account, with no cookies: the signed-in person's session must not be replaced by the new one.
member_password="smoke-$(openssl rand -hex 16)"
res=$(curl "${curl_args[@]}" -X POST -H 'content-type: application/json' -w '\n%{http_code}' \
  --data-binary "{\"name\":\"Smoke Teammate\",\"password\":\"$member_password\",\"timezone\":\"UTC\"}" \
  "$base/api/invites/$invite_token/accept")
check "the invite is accepted with a new account (got $(status_of "$res"))" equals "$(status_of "$res")" 200

res=$(api GET "/api/roadmaps/$roadmap_id/members")
invitee_id=$(json_field "$(member_with_email "$(body_of "$res")" "$invitee")" userId)
assigner=$(json_field "$(member_with_email "$(body_of "$res")" "$email")" name)
[[ -n "$invitee_id" && -n "$assigner" ]] || fatal "the new member is in the members list (got $(status_of "$res"))"
res=$(api_json PUT "/api/roadmaps/$roadmap_id/projects/$item_id/assignees" "{\"userIds\":[\"$invitee_id\"]}")
check "assign the new member to the item (got $(status_of "$res"))" equals "$(status_of "$res")" 200

# The worker sends instant emails on its next pass (every WORKER_INTERVAL_MS, 30 seconds by default).
subject="$assigner assigned you to Smoke item"
# The outbox is read once per poll; the greps read all of it (no -q: see has_header).
worker_sent() {
  local mail
  mail=$(outbox worker)
  printf '%s\n' "$mail" | grep -F "\"to\":\"$invitee\"" | grep -F "\"subject\":\"$subject\"" > /dev/null
}
deadline=$((SECONDS + wait_seconds))
until worker_sent || ((SECONDS >= deadline)); do sleep 2; done
check "the worker emails \"$subject\" to the new member" worker_sent
# shellcheck disable=SC2086 # SMOKE_COMPOSE is a command and its arguments
worker_health=$($SMOKE_COMPOSE ps --format '{{.Health}}' worker 2> /dev/null)
# One-click unsubscribe (RFC 8058): the List-Unsubscribe URL in that email, POSTed as a mail client does, through Caddy.
# The URL names APP_ORIGIN; only its path and query are used, so a stack reached by another address still answers.
unsubscribe_url=$(printf '%s\n' "$(outbox worker)" | grep -F "\"to\":\"$invitee\"" | grep -F "\"subject\":\"$subject\"" | tail -n1 |
  grep -o '"List-Unsubscribe":"<[^>]*>' | sed 's/^"List-Unsubscribe":"<//; s/>$//')
[[ "$unsubscribe_url" == http*://*/api/email/unsubscribe\?t=* ]] || fatal "the email has a List-Unsubscribe header (got ${unsubscribe_url:-nothing})"
echo "ok   the email carries a List-Unsubscribe URL"
unsubscribe_path="/api/email/unsubscribe?${unsubscribe_url#*\?}"
status=$(curl "${curl_args[@]}" -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/x-www-form-urlencoded' \
  --data-binary 'List-Unsubscribe=One-Click' "$base$unsubscribe_path")
check "the one-click unsubscribe POST answers 200 (got $status)" equals "$status" 200
# The new member signs in (and sets up an authenticator code, which the settings page needs) to read their settings.
member_jar="$work/member-cookies"
res=$(curl "${curl_args[@]}" -c "$member_jar" -X POST -H 'content-type: application/json' -w '\n%{http_code}' \
  --data-binary "{\"email\":\"$invitee\",\"password\":\"$member_password\"}" "$base/api/auth/login")
member_csrf=$(json_field "$(body_of "$res")" csrfToken)
[[ "$(status_of "$res")" == 200 && -n "$member_csrf" ]] || fatal "the new member signs in (got $(status_of "$res"))"
member_api() { # METHOD PATH [curl args...]
  local method=$1 path=$2
  shift 2
  curl "${curl_args[@]}" -b "$member_jar" -c "$member_jar" -X "$method" -H "x-csrf-token: $member_csrf" -w '\n%{http_code}' "$@" "$base$path"
}
res=$(member_api POST /api/auth/totp/enroll/start -H 'content-type: application/json' --data-binary '{}')
member_secret=$(json_field "$(body_of "$res")" secret)
[[ "$(status_of "$res")" == 200 && -n "$member_secret" ]] || fatal "the new member starts setting up an authenticator code (got $(status_of "$res"))"
res=$(member_api POST /api/auth/totp/enroll/confirm -H 'content-type: application/json' --data-binary "{\"code\":\"$(totp_code "$member_secret")\"}")
member_csrf=$(json_field "$(body_of "$res")" csrfToken)
[[ "$(status_of "$res")" == 200 && -n "$member_csrf" ]] || fatal "the new member finishes signing in (got $(status_of "$res"))"
res=$(member_api GET /api/me/notification-prefs)
off_count=$(printf '%s' "$(body_of "$res")" | grep -o '"[a-z_]*":"off"' | wc -l | tr -d ' ')
check "the new member's four email settings are all off (got $(body_of "$res"))" equals "$off_count" 4
check "the worker is healthy (got ${worker_health:-no worker})" equals "$worker_health" healthy

finish
