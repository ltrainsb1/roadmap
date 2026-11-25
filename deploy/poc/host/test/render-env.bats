#!/usr/bin/env bats
load helpers

setup() { setup_server; }

mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

@test "render-env writes the three files with mode 0600 and the parameter values" {
  run "$HOST_DIR/render-env" abc123
  [ "$status" -eq 0 ]
  for f in compose api worker; do
    [ -f "$ROADMAP_ENV_DIR/$f.env" ]
    [ "$(mode "$ROADMAP_ENV_DIR/$f.env")" = "600" ]
  done
  grep -qx "DOMAIN='roadmap.example.com'" "$ROADMAP_ENV_DIR/compose.env"
  grep -qx "REGISTRY='123456789012.dkr.ecr.eu-west-1.amazonaws.com'" "$ROADMAP_ENV_DIR/compose.env"
  grep -qx "RELEASE='abc123'" "$ROADMAP_ENV_DIR/compose.env"
  grep -qx "MONGO_INITDB_ROOT_USERNAME='root'" "$ROADMAP_ENV_DIR/compose.env"
  grep -qx "BACKUP_BUCKET='roadmap-backups-bucket'" "$ROADMAP_ENV_DIR/compose.env"
  grep -qx "API_ENV_FILE='$ROADMAP_ENV_DIR/api.env'" "$ROADMAP_ENV_DIR/compose.env"
  grep -qx "WORKER_ENV_FILE='$ROADMAP_ENV_DIR/worker.env'" "$ROADMAP_ENV_DIR/compose.env"
  grep -qx "NODE_ENV='production'" "$ROADMAP_ENV_DIR/api.env"
  grep -qx "MAILER='ses'" "$ROADMAP_ENV_DIR/api.env"
  grep -qx "AWS_REGION='eu-west-1'" "$ROADMAP_ENV_DIR/api.env"
  grep -qx "SES_CONFIGURATION_SET='roadmap-events'" "$ROADMAP_ENV_DIR/api.env"
  grep -qx "SES_EVENTS_QUEUE_URL='https://sqs.eu-west-1.amazonaws.com/123456789012/roadmap-ses-events'" "$ROADMAP_ENV_DIR/worker.env"
  grep -qx "SES_CONFIGURATION_SET='roadmap-events'" "$ROADMAP_ENV_DIR/worker.env"
  run grep -c TOTP_ENC_KEY "$ROADMAP_ENV_DIR/worker.env"
  [ "$output" = "0" ]
}

@test "render-env asks SSM for the whole path with decryption" {
  run "$HOST_DIR/render-env" abc123
  [ "$status" -eq 0 ]
  grep -q -- "ssm get-parameters-by-path --path /roadmap/poc/ --with-decryption --recursive" "$STUB_LOG"
}

@test "render-env URL-encodes the MongoDB password in both MONGO_URI values" {
  run "$HOST_DIR/render-env" abc123
  [ "$status" -eq 0 ]
  want="MONGO_URI='mongodb://roadmap_app:p%40ss%2Fw%25rd@mongo:27017/roadmap?replicaSet=rs0&authSource=roadmap'"
  grep -qxF "$want" "$ROADMAP_ENV_DIR/api.env"
  grep -qxF "$want" "$ROADMAP_ENV_DIR/worker.env"
  # The raw password stays raw in compose.env, where it is the roadmap_app password itself.
  grep -qxF "MONGO_APP_PASSWORD='p@ss/w%rd'" "$ROADMAP_ENV_DIR/compose.env"
}

@test "render-env with a parameter missing names it, fails, and leaves existing files untouched" {
  "$HOST_DIR/render-env" old1
  for f in compose api worker; do cp "$ROADMAP_ENV_DIR/$f.env" "$BATS_TEST_TMPDIR/$f.before"; done
  grep -v '/ses-events-queue-url' "$STUB_SSM_FILE" > "$STUB_SSM_FILE.new"
  mv "$STUB_SSM_FILE.new" "$STUB_SSM_FILE"
  run "$HOST_DIR/render-env" new2
  [ "$status" -ne 0 ]
  contains "$output" "ses-events-queue-url"
  for f in compose api worker; do
    cmp "$ROADMAP_ENV_DIR/$f.env" "$BATS_TEST_TMPDIR/$f.before"
  done
  # No temporary files are left behind.
  [ "$(ls "$ROADMAP_ENV_DIR" | wc -l | tr -d ' ')" = "3" ]
}

@test "render-env names every missing parameter" {
  grep -v -e '/domain' -e '/totp-enc-key' "$STUB_SSM_FILE" > "$STUB_SSM_FILE.new"
  mv "$STUB_SSM_FILE.new" "$STUB_SSM_FILE"
  run "$HOST_DIR/render-env" abc123
  [ "$status" -ne 0 ]
  contains "$output" "/roadmap/poc/domain"
  contains "$output" "/roadmap/poc/totp-enc-key"
  [ -z "$(ls "$ROADMAP_ENV_DIR")" ]
}

@test "render-env refuses a value it cannot write safely" {
  printf '%s\t%s\n' /roadmap/poc/mail-from "it's" >> "$STUB_SSM_FILE"
  # The later line wins; a single quote cannot be quoted in a .env file.
  run "$HOST_DIR/render-env" abc123
  [ "$status" -ne 0 ]
  contains "$output" "mail-from"
  [ -z "$(ls "$ROADMAP_ENV_DIR")" ]
}

@test "render-env needs a release" {
  run "$HOST_DIR/render-env"
  [ "$status" -ne 0 ]
}
