# Scheduled maintenance

Hosted and standalone containers run maintenance immediately, then every three
hours, retrying failed runs after five minutes. Native installations run once
per invocation so the host's existing cron schedule controls repetition.
`TASK_PROCESSOR_INTERVAL_HOURS` and `TASK_PROCESSOR_RETRY_MINUTES` override the
container schedule. Run native maintenance with `bash run_task.sh`; it loads the
service's `.env` and works from any working directory.

Container media roots default to `/assets` and `/assets_v2`. Native source
installs use the sibling `samsar_processor` directory; generated monorepos use
the sibling `processor` service. `SAMSAR_ASSETS_ROOT` and
`SAMSAR_ASSETS_V2_ROOT` override these paths. A missing `assets_v2` root fails
the run so an incorrect mount does not silently disable maintenance.

`CLEANUP_MIN_AGE_HOURS` defaults to `168` (seven days), matching Docker-Cleanup.
Optional `STALE_SESSION_FRAME_CLEANUP_HOURS` and
`INTERMEDIATE_MEDIA_CLEANUP_HOURS` override the shared retention for their
respective stages. Invalid retention values fail the affected cleanup stage.

Cleanup removes stale session frames and old media in `ai_video/temp`. Final
renders, generated resources and user resources remain protected. Containers
disable generation side effects by default; native cron retains the existing
generation behavior. See `TASK_PROCESSOR_ENABLE_FILE_CLEANUP` and
`TASK_PROCESSOR_ENABLE_GENERATION_SIDE_EFFECTS` for explicit overrides.

Maintenance reports successes and failures to stdout/stderr as well as the
existing cron log files. Run the regression tests with `npm test`.
