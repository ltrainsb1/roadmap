#!/usr/bin/env bats
load helpers

setup() {
  setup_server
  make_release rel-now
  echo rel-now > "$ROADMAP_ROOT/current"
  printf "BACKUP_BUCKET='roadmap-backups-bucket'\nMONGO_DB='roadmap'\n" > "$ROADMAP_ENV_DIR/compose.env"
  TODAY=$(date -u +%F)
}

@test "backup-mongo dumps inside the mongo container as root, uploads with KMS, removes the local file" {
  run "$HOST_DIR/backup-mongo"
  [ "$status" -eq 0 ]
  dump=$(grep mongodump "$STUB_LOG")
  contains "$dump" "-p roadmap-poc"
  contains "$dump" "-f $ROADMAP_ROOT/releases/rel-now/deploy/poc/docker-compose.yml"
  contains "$dump" "--env-file $ROADMAP_ENV_DIR/compose.env"
  contains "$dump" "exec -T -u root mongo"
  contains "$dump" "mongodump --archive --gzip"
  logged "aws s3 cp $ROADMAP_BACKUP_DIR/$TODAY.archive.gz s3://roadmap-backups-bucket/mongo/$TODAY.archive.gz --sse aws:kms"
  [ "$(cat "$STUB_S3_DIR/roadmap-backups-bucket/mongo/$TODAY.archive.gz")" = "DUMP-OF-DATABASE" ]
  [ ! -e "$ROADMAP_BACKUP_DIR/$TODAY.archive.gz" ]
}

@test "backup-mongo takes its project and Compose files from the environment when set" {
  COMPOSE_PROJECT_NAME=smoke COMPOSE_FILES="/x/a.yml /x/b.yml" COMPOSE_ENV_FILE=/x/.env run "$HOST_DIR/backup-mongo"
  [ "$status" -eq 0 ]
  dump=$(grep mongodump "$STUB_LOG")
  contains "$dump" "-p smoke -f /x/a.yml -f /x/b.yml --env-file /x/.env exec"
}

@test "backup-mongo when the dump fails part-way uploads nothing, removes the partial file, exits non-zero" {
  STUB_DUMP_FAIL=1 run "$HOST_DIR/backup-mongo"
  [ "$status" -ne 0 ]
  not_logged 'aws s3 cp'
  [ -z "$(ls "$ROADMAP_BACKUP_DIR")" ]
  [ -z "$(find "$STUB_S3_DIR" -type f)" ]
}

@test "backup-mongo fails without a backup bucket" {
  echo "MONGO_DB='roadmap'" > "$ROADMAP_ENV_DIR/compose.env"
  run "$HOST_DIR/backup-mongo"
  [ "$status" -ne 0 ]
  contains "$output" "BACKUP_BUCKET"
  not_logged mongodump
}

@test "backup-mongo removes the local file when the upload fails" {
  STUB_S3_DIR=/nonexistent/dir run "$HOST_DIR/backup-mongo"
  [ "$status" -ne 0 ]
  [ -z "$(ls "$ROADMAP_BACKUP_DIR")" ]
}

@test "restore-mongo refuses without a date" {
  run "$HOST_DIR/restore-mongo"
  [ "$status" -ne 0 ]
  contains "$output" "usage"
  not_logged mongorestore
}

@test "restore-mongo refuses a date that is not YYYY-MM-DD" {
  run "$HOST_DIR/restore-mongo" ../../etc/passwd
  [ "$status" -ne 0 ]
  not_logged 'aws s3 cp'
}

@test "restore-mongo downloads that object and restores it with --drop into the running mongo" {
  mkdir -p "$STUB_S3_DIR/roadmap-backups-bucket/mongo"
  printf 'ARCHIVE-BYTES' > "$STUB_S3_DIR/roadmap-backups-bucket/mongo/2026-11-24.archive.gz"
  run "$HOST_DIR/restore-mongo" 2026-11-24
  [ "$status" -eq 0 ]
  logged "aws s3 cp s3://roadmap-backups-bucket/mongo/2026-11-24.archive.gz $ROADMAP_BACKUP_DIR/restore-2026-11-24.archive.gz"
  restore=$(grep mongorestore "$STUB_LOG")
  contains "$restore" "exec -T -u root mongo"
  contains "$restore" "mongorestore --archive --gzip --drop"
  contains "$restore" '--nsInclude'
  lacks "$restore" "--nsFrom"
  [ "$(cat "$STUB_RESTORE_STDIN")" = "ARCHIVE-BYTES" ]
  [ -z "$(ls "$ROADMAP_BACKUP_DIR")" ]
}

@test "restore-mongo --to restores into another database" {
  mkdir -p "$STUB_S3_DIR/roadmap-backups-bucket/mongo"
  printf 'ARCHIVE-BYTES' > "$STUB_S3_DIR/roadmap-backups-bucket/mongo/2026-11-24.archive.gz"
  run "$HOST_DIR/restore-mongo" 2026-11-24 --to roadmap_check
  [ "$status" -eq 0 ]
  restore=$(grep mongorestore "$STUB_LOG")
  contains "$restore" "--nsFrom"
  contains "$restore" "roadmap_check"
}

@test "restore-mongo with a missing backup fails and restores nothing" {
  run "$HOST_DIR/restore-mongo" 2026-01-01
  [ "$status" -ne 0 ]
  not_logged mongorestore
  [ -z "$(ls "$ROADMAP_BACKUP_DIR")" ]
}

@test "restore-mongo rejects a --to name that is not a plain database name" {
  run "$HOST_DIR/restore-mongo" 2026-11-24 --to 'a b;c'
  [ "$status" -ne 0 ]
}
