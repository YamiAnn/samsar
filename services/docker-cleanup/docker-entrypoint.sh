#!/bin/sh
set -eu

CRON_FILE=${CLEANUP_CRON_FILE:-/etc/cron.d/samsar-assets-v2-cleanup}

run_startup_cleanup() {
  case "${CLEANUP_ON_START:-true}" in
    1|true|TRUE|yes|YES|on|ON)
      echo "[docker-cleanup] Running startup cleanup"
      node /app/src/cleanup.js || echo "[docker-cleanup] Startup cleanup failed; cron will continue"
      ;;
  esac
}

write_cron_file() {
  node /app/src/cron.js > "$CRON_FILE.pending"
  # crontab validates user syntax, so remove the system-cron user column.
  sed 's/ root node / node /' "$CRON_FILE.pending" | crontab -n -
  chmod 0644 "$CRON_FILE.pending"
  mv "$CRON_FILE.pending" "$CRON_FILE"
}

write_cron_file
node /app/src/status.js
run_startup_cleanup

echo "[docker-cleanup] Scheduled assets_v2 cleanup with cron: ${CLEANUP_CRON_SCHEDULE:-17 */3 * * *}"
exec cron -f
