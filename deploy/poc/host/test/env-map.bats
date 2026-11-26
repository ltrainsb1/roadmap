#!/usr/bin/env bats
load helpers

EXAMPLES="$BATS_TEST_DIRNAME/../.."

# Keys an example file sets (uncommented) or documents as optional settings (a commented KEY=value line).
keys_of() { grep -oE '^#? ?[A-Z][A-Z0-9_]+=' "$1" | sed -E 's/^# ?//; s/=$//' | sort -u; }
set_keys_of() { grep -oE '^[A-Z][A-Z0-9_]+=' "$1" | sed 's/=$//' | sort -u; }
mapped() { awk -v f="$1" '$1 == f { print $2 }' "$HOST_DIR/env-map" | sort -u; }

@test "env-map has a line for every setting api.env.example sets" {
  run comm -23 <(set_keys_of "$EXAMPLES/api.env.example") <(mapped api)
  [ -z "$output" ]
}

@test "env-map has a line for every setting worker.env.example sets" {
  run comm -23 <(set_keys_of "$EXAMPLES/worker.env.example") <(mapped worker)
  [ -z "$output" ]
}

@test "env-map covers the optional SES settings the examples document" {
  for k in SES_CONFIGURATION_SET; do mapped api | grep -qx "$k"; done
  for k in SES_CONFIGURATION_SET SES_EVENTS_QUEUE_URL; do mapped worker | grep -qx "$k"; done
}

@test "env-map has no setting the examples do not know" {
  run comm -13 <(keys_of "$EXAMPLES/api.env.example") <(mapped api)
  [ -z "$output" ]
  run comm -13 <(keys_of "$EXAMPLES/worker.env.example") <(mapped worker)
  [ -z "$output" ]
}

@test "the worker's env-map has no TOTP_ENC_KEY, and both files carry the same UNSUBSCRIBE_KEY source" {
  run mapped worker
  lacks "$output" TOTP_ENC_KEY
  [ "$(awk '$2 == "UNSUBSCRIBE_KEY" { print $3 }' "$HOST_DIR/env-map" | sort -u | wc -l | tr -d ' ')" = "1" ]
}

@test "env-map has every Compose variable the stack needs" {
  for k in DOMAIN S3_BUCKET MONGO_INITDB_ROOT_USERNAME MONGO_INITDB_ROOT_PASSWORD MONGO_APP_PASSWORD MONGO_DB \
    MONGO_DATA REGISTRY RELEASE API_ENV_FILE WORKER_ENV_FILE BACKUP_BUCKET; do
    mapped compose | grep -qx "$k"
  done
}
