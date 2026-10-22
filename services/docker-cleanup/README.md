# Docker Cleanup

Cron container for deleting stale internal `assets_v2` media transformations.

The cleanup is intentionally scoped to transient frame/cache paths:

- `video/frames/<sessionId>`
- `ai_video/frames/<sessionId>`
- `video/narrator_avatar/frames/<sessionId>`
- `video/narrator_avatar/joined_frames/<sessionId>`
- old media files in `ai_video/temp`

It does not clean final video renders under `video/output`, API generated
resources, generated music, user resources, outro assets, or AI video
generation outputs such as `ai_video/generations`.

## Environment

- `SAMSAR_ASSETS_V2_ROOT`: defaults to `/assets_v2`
- `CLEANUP_MIN_AGE_HOURS`: defaults to `168` (seven days), shared with the task processor
- `CLEANUP_FRAME_MIN_AGE_HOURS`: defaults to `24` in the image for the four frame session roots; falls back to `CLEANUP_MIN_AGE_HOURS` when unset
- `CLEANUP_TEMP_MIN_AGE_HOURS`: defaults to `48` in the image for media files in `ai_video/temp`; falls back to `CLEANUP_MIN_AGE_HOURS` when unset
- `CLEANUP_CRON_SCHEDULE`: defaults to `17 */3 * * *` (every three hours)
- `CLEANUP_ON_START`: defaults to `true`
- `CLEANUP_DRY_RUN`: defaults to `false`
- `CLEANUP_TARGETS`: optional comma-separated list of supported target ids or paths
- `CLEANUP_STATUS_FILE`: defaults to `/run/docker-cleanup/status.json` in the image
- `CLEANUP_HEALTH_MAX_AGE_HOURS`: defaults to `4`; successful cleanup must finish within this time for the image healthcheck to pass
- `CLEANUP_HEALTH_MAX_RUN_HOURS`: defaults to `0.5`; an in-progress cleanup is healthy for up to 30 minutes

Run once locally:

```sh
SAMSAR_ASSETS_V2_ROOT=/path/to/assets_v2 npm run cleanup
```

Run tests:

```sh
npm test
```

Cleanup is age-based rather than render-triggered. The image uses a 24-hour
frame grace period and a 48-hour temp-media grace period. The next three-hour
sweep removes an eligible session directory only when its newest file or
directory is older than the frame grace period. The temp-media age is checked
per file. Standalone Node runs with unset per-target settings retain the
seven-day global default.

The entrypoint quotes cron environment values, omits empty optional settings,
and validates the schedule with Debian `crontab` before installing it or running
startup cleanup. Invalid schedules stop the container with a nonzero exit.
Cleanup output goes to container logs; a missing media mount is an error.
`CLEANUP_DRY_RUN=true` reports eligible files without deleting files or directories.
The container healthcheck reads the last cleanup result and checks that cron is
running as PID 1. A failed startup or scheduled sweep makes the container
unhealthy while cron keeps running and retries. A later successful sweep
restores health. An active sweep remains healthy for 30 minutes; a stuck sweep
then becomes unhealthy. If a sweep never runs, success becomes stale after four hours.
Dry runs do not update health status, so previews cannot hide a failed real sweep.
With `CLEANUP_ON_START=false`, health remains pending or unhealthy until the
first scheduled sweep succeeds.
Each container start resets the health state, so a previous success cannot
mask a missing sweep after restart.

To test the real scheduler using disposable media inside a container (up to
70 seconds for the next cron tick):

```sh
docker build -t samsar-cleanup-test .
docker run --rm -e CLEANUP_TEST_REAL_CRON=true \
  --mount type=bind,src="$(pwd)/test",dst=/app/test,readonly \
  samsar-cleanup-test node --test
```
