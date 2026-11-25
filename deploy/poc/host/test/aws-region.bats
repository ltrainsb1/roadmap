#!/usr/bin/env bats
# The region: systemd services and SSM Run Command have no HOME, so ~/.aws/config is never read on the server. Each
# host script sources aws-region, which asks the instance metadata service (IMDSv2) when no region is set.
load helpers

setup() {
  setup_server
  make_release rel-now
  make_release rel-new
  echo rel-now > "$ROADMAP_ROOT/current"
  printf "BACKUP_BUCKET='roadmap-backups-bucket'\nMONGO_DB='roadmap'\n" > "$ROADMAP_ENV_DIR/compose.env"
  mkdir -p "$STUB_S3_DIR/roadmap-backups-bucket/mongo"
  printf 'ARCHIVE-BYTES' > "$STUB_S3_DIR/roadmap-backups-bucket/mongo/2026-11-24.archive.gz"
}

imds_asked() {
  logged 'curl -fsS --max-time 5 --retry 3 -X PUT http://169.254.169.254/latest/api/token -H X-aws-ec2-metadata-token-ttl-seconds: 60'
  logged 'curl -fsS --max-time 5 --retry 3 -H X-aws-ec2-metadata-token: imds-token http://169.254.169.254/latest/meta-data/placement/region'
}

@test "render-env with no region takes it from the metadata service and passes it to aws" {
  run "$HOST_DIR/render-env" abc123
  [ "$status" -eq 0 ]
  imds_asked
  aws_region_was ap-southeast-2
  grep -qF 'AWS_DEFAULT_REGION=ap-southeast-2' "$STUB_REGION_LOG"
}

@test "render-env keeps an AWS_REGION that is already set and does not ask the metadata service" {
  AWS_REGION=eu-central-1 run "$HOST_DIR/render-env" abc123
  [ "$status" -eq 0 ]
  not_logged curl
  aws_region_was eu-central-1
}

@test "render-env keeps an AWS_DEFAULT_REGION that is already set and does not ask the metadata service" {
  AWS_DEFAULT_REGION=eu-north-1 run "$HOST_DIR/render-env" abc123
  [ "$status" -eq 0 ]
  not_logged curl
  grep -qF 'AWS_DEFAULT_REGION=eu-north-1' "$STUB_REGION_LOG"
}

@test "render-env fails before any aws call when the metadata service does not answer" {
  STUB_IMDS_FAIL=1 run "$HOST_DIR/render-env" abc123
  [ "$status" -ne 0 ]
  contains "$output" "no AWS region"
  not_logged 'aws '
  [ -z "$(ls "$ROADMAP_ENV_DIR" | grep -v compose.env)" ]
}

@test "render-env refuses a region that is not a plain region name" {
  STUB_IMDS_REGION='<html>' run "$HOST_DIR/render-env" abc123
  [ "$status" -ne 0 ]
  not_logged 'aws '
}

@test "backup-mongo uploads with the region from the metadata service" {
  run "$HOST_DIR/backup-mongo"
  [ "$status" -eq 0 ]
  imds_asked
  logged 'aws s3 cp'
  aws_region_was ap-southeast-2
}

@test "backup-mongo keeps an AWS_REGION that is already set" {
  AWS_REGION=eu-central-1 run "$HOST_DIR/backup-mongo"
  [ "$status" -eq 0 ]
  not_logged curl
  aws_region_was eu-central-1
}

@test "backup-mongo fails before any aws call or dump when the metadata service does not answer" {
  STUB_IMDS_FAIL=1 run "$HOST_DIR/backup-mongo"
  [ "$status" -ne 0 ]
  contains "$output" "no AWS region"
  not_logged 'aws '
  not_logged mongodump
}

@test "restore-mongo downloads with the region from the metadata service" {
  run "$HOST_DIR/restore-mongo" 2026-11-24
  [ "$status" -eq 0 ]
  imds_asked
  aws_region_was ap-southeast-2
}

@test "restore-mongo fails before any aws call or restore when the metadata service does not answer" {
  STUB_IMDS_FAIL=1 run "$HOST_DIR/restore-mongo" 2026-11-24
  [ "$status" -ne 0 ]
  contains "$output" "no AWS region"
  not_logged 'aws '
  not_logged mongorestore
}

@test "deploy signs in to ECR in the region from the metadata service, not from api.env" {
  run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 0 ]
  imds_asked
  logged 'aws ecr get-login-password'
  aws_region_was ap-southeast-2
  # The region in the SSM settings (eu-west-1) is the app's, and is not what the host scripts use.
  grep -qx "AWS_REGION='eu-west-1'" "$ROADMAP_ENV_DIR/api.env"
}

@test "deploy keeps an AWS_REGION that is already set" {
  AWS_REGION=eu-central-1 run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 0 ]
  not_logged curl
  aws_region_was eu-central-1
}

@test "deploy exits 2 before any aws call when the metadata service does not answer" {
  STUB_IMDS_FAIL=1 run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 2 ]
  contains "$output" "AWS region"
  not_logged 'aws '
  not_logged 'docker compose'
  [ "$(cat "$ROADMAP_ROOT/current")" = "rel-now" ]
}

@test "the installed backup-mongo finds the installed aws-region beside it" {
  run "$HOST_DIR/deploy" rel-new
  [ "$status" -eq 0 ]
  [ -f "$ROADMAP_ROOT/bin/aws-region" ]
  : > "$STUB_LOG"
  : > "$STUB_REGION_LOG"
  COMPOSE_FILES="$ROADMAP_ROOT/releases/rel-new/deploy/poc/docker-compose.yml" run "$ROADMAP_ROOT/bin/backup-mongo"
  [ "$status" -eq 0 ]
  imds_asked
  aws_region_was ap-southeast-2
}
