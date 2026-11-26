# Shared setup for the host-script tests: a temporary "server" and fake aws, curl (the instance metadata service),
# docker, mountpoint and systemctl.
HOST_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
POC_DIR="$(cd "$HOST_DIR/.." && pwd)"

setup_server() {
  SERVER="$BATS_TEST_TMPDIR/server"
  mkdir -p "$SERVER"/{env,root/releases,data,backup,systemd,s3,state}
  export ROADMAP_ENV_DIR="$SERVER/env"
  export ROADMAP_ROOT="$SERVER/root"
  export ROADMAP_DATA_DIR="$SERVER/data"
  export ROADMAP_BACKUP_DIR="$SERVER/backup"
  export SYSTEMD_DIR="$SERVER/systemd"
  export STUB_LOG="$SERVER/calls.log"
  export STUB_S3_DIR="$SERVER/s3"
  export STUB_STATE="$SERVER/state"
  export STUB_RESTORE_STDIN="$SERVER/restore.stdin"
  export STUB_SSM_FILE="$SERVER/ssm.tsv"
  export STUB_REGION_LOG="$SERVER/regions.log"
  : > "$STUB_LOG"
  : > "$STUB_REGION_LOG"
  # As under systemd or SSM Run Command: no region set, so the scripts ask the metadata service (the curl stub).
  unset AWS_REGION AWS_DEFAULT_REGION
  export PATH="$BATS_TEST_DIRNAME/stubs:$PATH"
  # Every parameter the env-map names, as `aws ssm ... --output text` prints them (name, tab, value).
  write_ssm
}

write_ssm() {
  local p='/roadmap/poc'
  {
    printf '%s\t%s\n' "$p/domain" 'roadmap.example.com'
    printf '%s\t%s\n' "$p/app-origin" 'https://roadmap.example.com'
    printf '%s\t%s\n' "$p/mail-from" 'no-reply@roadmap.example.com'
    printf '%s\t%s\n' "$p/aws-region" 'eu-west-1'
    printf '%s\t%s\n' "$p/s3-bucket" 'roadmap-files-bucket'
    printf '%s\t%s\n' "$p/backup-bucket" 'roadmap-backups-bucket'
    printf '%s\t%s\n' "$p/registry" '123456789012.dkr.ecr.eu-west-1.amazonaws.com'
    printf '%s\t%s\n' "$p/ses-configuration-set" 'roadmap-events'
    printf '%s\t%s\n' "$p/ses-events-queue-url" 'https://sqs.eu-west-1.amazonaws.com/123456789012/roadmap-ses-events'
    printf '%s\t%s\n' "$p/mongo-root-password" 'rootpw'
    printf '%s\t%s\n' "$p/mongo-app-password" "${APP_PASSWORD:-p@ss/w%rd}"
    printf '%s\t%s\n' "$p/totp-enc-key" 'totp+key/AAAA='
    printf '%s\t%s\n' "$p/unsubscribe-key" 'unsub+key/BBBB='
  } > "$SERVER/ssm.tsv"
}

# A release folder as the workflow unpacks it: deploy/poc with the Compose files.
make_release() {
  local dir="$ROADMAP_ROOT/releases/$1/deploy/poc"
  mkdir -p "$dir"
  : > "$dir/docker-compose.yml"
  : > "$dir/docker-compose.aws.yml"
}

# bats on bash 3.2 (macOS) ignores a failing [[ ]] or ! in the middle of a test, so assertions are functions.
contains() { case "$1" in *"$2"*) return 0 ;; esac; echo "expected '$2' in: $1" >&2; return 1; }
lacks() { case "$1" in *"$2"*) echo "did not expect '$2' in: $1" >&2; return 1 ;; esac; return 0; }
logged() { grep -qF -- "$1" "$STUB_LOG" || { echo "expected in log: $1" >&2; cat "$STUB_LOG" >&2; return 1; }; }
# Every aws call so far was given this region (and there was at least one).
aws_region_was() {
  [ -s "$STUB_REGION_LOG" ] || { echo "no aws call was made" >&2; return 1; }
  if grep -vF -- "AWS_REGION=$1 " "$STUB_REGION_LOG"; then echo "an aws call had another region than $1" >&2; return 1; fi
}
not_logged() { if grep -qF -- "$1" "$STUB_LOG"; then echo "unexpected in log: $1" >&2; return 1; fi; }
