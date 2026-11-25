#!/usr/bin/env bats
load helpers

setup() {
  setup_server
  make_release rel-new
  make_release rel-old
  UNITS="backup.service backup.timer patch.service patch.timer"
}

compose_calls() { grep '^docker compose' "$STUB_LOG" || true; }

@test "deploy exits 2 and starts nothing when /srv/mongo is not a mount point" {
  STUB_NOT_MOUNTED=1 run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 2 ]
  contains "$output" "mount"
  [ -z "$(compose_calls)" ]
  not_logged 'aws ecr'
  [ ! -e "$ROADMAP_ROOT/current" ]
}

@test "deploy checks the data folder with mountpoint -q" {
  run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 0 ]
  logged "mountpoint -q $ROADMAP_DATA_DIR"
}

@test "deploy exits 2 when render-env fails, and starts nothing" {
  grep -v '/registry' "$STUB_SSM_FILE" > "$STUB_SSM_FILE.new"; mv "$STUB_SSM_FILE.new" "$STUB_SSM_FILE"
  echo rel-old > "$ROADMAP_ROOT/current"
  run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 2 ]
  contains "$output" "registry"
  [ -z "$(compose_calls)" ]
  [ "$(cat "$ROADMAP_ROOT/current")" = "rel-old" ]
}

@test "deploy exits 2 when ECR sign-in fails, and starts nothing" {
  STUB_ECR_FAIL=1 run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 2 ]
  [ -z "$(compose_calls)" ]
}

@test "deploy exits 2 when docker login fails" {
  STUB_LOGIN_FAIL=1 run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 2 ]
  [ -z "$(compose_calls)" ]
}

@test "deploy exits 2 when the images cannot be pulled, before touching the running stack" {
  STUB_PULL_FAIL=1 run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 2 ]
  not_logged ' up '
}

@test "deploy signs in to the registry from the SSM settings" {
  run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 0 ]
  logged 'aws ecr get-login-password --region eu-west-1'
  logged 'docker RELEASE= login --username AWS --password-stdin 123456789012.dkr.ecr.eu-west-1.amazonaws.com'
}

@test "deploy on success starts the stack the documented way and records the release" {
  run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 0 ]
  [ "$(cat "$ROADMAP_ROOT/current")" = "rel-new" ]
  up=$(grep ' up ' "$STUB_LOG")
  contains "$up" "-p roadmap-poc"
  contains "$up" "-f $POC_DIR/docker-compose.yml"
  contains "$up" "-f $POC_DIR/docker-compose.aws.yml"
  contains "$up" "--env-file $ROADMAP_ENV_DIR/compose.env"
  contains "$up" "up -d --no-build --wait --wait-timeout 600"
  grep -qx "RELEASE='rel-new'" "$ROADMAP_ENV_DIR/compose.env"
}

@test "deploy installs the systemd units and enables both timers" {
  run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 0 ]
  for u in roadmap-backup.service roadmap-backup.timer roadmap-patch.service roadmap-patch.timer; do
    [ -f "$SYSTEMD_DIR/$u" ]
  done
  [ -f "$SYSTEMD_DIR/docker.service.d/wait-for-data.conf" ]
  logged "systemctl daemon-reload"
  logged "systemctl enable --now roadmap-backup.timer"
  logged "systemctl enable --now roadmap-patch.timer"
  # The backup scripts are installed where the service expects them.
  [ -x "$ROADMAP_ROOT/bin/backup-mongo" ]
  [ -x "$ROADMAP_ROOT/bin/restore-mongo" ]
  [ -x "$ROADMAP_ROOT/bin/render-env" ]
  [ -f "$ROADMAP_ROOT/bin/env-map" ]
}

@test "deploy keeps only the newest 5 release folders" {
  rm -rf "$ROADMAP_ROOT/releases"/*
  for i in 1 2 3 4 5 6 7; do
    make_release "r$i"
    touch -t "20260101000$i" "$ROADMAP_ROOT/releases/r$i"
  done
  run "$HOST_DIR/deploy" r7
  [ "$status" -eq 0 ]
  [ "$(ls "$ROADMAP_ROOT/releases" | tr '\n' ' ')" = "r3 r4 r5 r6 r7 " ]
}

@test "deploy never prunes the running release or the one it deployed" {
  rm -rf "$ROADMAP_ROOT/releases"/*
  for i in 1 2 3 4 5 6 7; do
    make_release "r$i"
    touch -t "20260101000$i" "$ROADMAP_ROOT/releases/r$i"
  done
  echo r1 > "$ROADMAP_ROOT/current"
  run "$HOST_DIR/deploy" r2
  [ "$status" -eq 0 ]
  [ -d "$ROADMAP_ROOT/releases/r2" ]
}

@test "deploy rolls back when up --wait fails: previous release, current unchanged, exit 1" {
  echo rel-old > "$ROADMAP_ROOT/current"
  STUB_UP_FAILS=1 run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 1 ]
  contains "$output" "rolled back"
  [ "$(cat "$ROADMAP_ROOT/current")" = "rel-old" ]
  ups=$(grep ' up ' "$STUB_LOG")
  [ "$(echo "$ups" | wc -l | tr -d ' ')" = "2" ]
  second=$(echo "$ups" | sed -n 2p)
  contains "$second" "RELEASE=rel-old "
  contains "$second" "-f $ROADMAP_ROOT/releases/rel-old/deploy/poc/docker-compose.yml"
  contains "$second" "-f $ROADMAP_ROOT/releases/rel-old/deploy/poc/docker-compose.aws.yml"
  # The environment was rendered again for the old release.
  grep -qx "RELEASE='rel-old'" "$ROADMAP_ENV_DIR/compose.env"
  [ "$(grep -c 'ssm get-parameters-by-path' "$STUB_LOG")" = "2" ]
  # No timers are touched by a failed deploy.
  not_logged 'enable --now'
}

@test "deploy with no previous release leaves the failed stack up for inspection and exits 1" {
  STUB_UP_FAILS=1 run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 1 ]
  contains "$output" "no previous release"
  [ ! -e "$ROADMAP_ROOT/current" ]
  [ "$(grep -c ' up ' "$STUB_LOG")" = "1" ]
  not_logged ' down'
}

@test "deploy exits 1 when the rollback itself fails" {
  echo rel-old > "$ROADMAP_ROOT/current"
  STUB_UP_FAILS=2 run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 1 ]
  contains "$output" "rollback failed"
  [ "$(cat "$ROADMAP_ROOT/current")" = "rel-old" ]
}

@test "deploy needs a release argument and exits 2 without one" {
  run "$HOST_DIR/deploy"
  [ "$status" -eq 2 ]
  [ -z "$(compose_calls)" ]
}
