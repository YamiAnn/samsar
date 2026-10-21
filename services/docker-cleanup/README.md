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
- `CLEANUP_CRON_SCHEDULE`: defaults to `17 */3 * * *` (every three hours)
- `CLEANUP_ON_START`: defaults to `true`
- `CLEANUP_DRY_RUN`: defaults to `false`
- `CLEANUP_TARGETS`: optional comma-separated list of supported target ids or paths

Run once locally:

```sh
SAMSAR_ASSETS_V2_ROOT=/path/to/assets_v2 npm run cleanup
```

Run tests:

```sh
npm test
```

Cleanup is age-based rather than render-triggered. A render can therefore
reuse its intermediate frames for at least seven days; the next three-hour
sweep removes an eligible session directory only when its newest file is
older than that grace period.

The entrypoint quotes cron environment values, omits empty optional settings,
and validates the schedule with Debian `crontab` before installing it or running
startup cleanup. Invalid schedules stop the container with a nonzero exit.
Cleanup output goes to container logs; a missing media mount is an error.
`CLEANUP_DRY_RUN=true` reports eligible files without deleting files or directories.

To test the real scheduler using disposable media inside a container (up to
70 seconds for the next cron tick):

```sh
docker build -t samsar-cleanup-test .
docker run --rm -e CLEANUP_TEST_REAL_CRON=true \
  --mount type=bind,src="$(pwd)/test",dst=/app/test,readonly \
  samsar-cleanup-test node --test
```
