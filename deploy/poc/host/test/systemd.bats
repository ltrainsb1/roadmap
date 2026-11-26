#!/usr/bin/env bats
load helpers

@test "the backup timer runs at 03:00 UTC and catches up after downtime" {
  grep -qx 'OnCalendar=\*-\*-\* 03:00:00 UTC' "$HOST_DIR/systemd/roadmap-backup.timer"
  grep -qx 'Persistent=true' "$HOST_DIR/systemd/roadmap-backup.timer"
}

@test "the patch timer runs at 04:00 UTC" {
  grep -qx 'OnCalendar=\*-\*-\* 04:00:00 UTC' "$HOST_DIR/systemd/roadmap-patch.timer"
}

@test "the patch service upgrades security fixes and reboots only when needed" {
  grep -q 'dnf -y upgrade --security --releasever=latest' "$HOST_DIR/systemd/roadmap-patch.service"
  grep -q 'dnf needs-restarting -r || systemctl reboot' "$HOST_DIR/systemd/roadmap-patch.service"
}

@test "docker waits for the data volume" {
  grep -qx 'RequiresMountsFor=/srv/mongo' "$HOST_DIR/systemd/docker-wait-for-data.conf"
}

@test "the backup service runs the installed script" {
  grep -q '^ExecStart=/opt/roadmap/bin/backup-mongo' "$HOST_DIR/systemd/roadmap-backup.service"
}
