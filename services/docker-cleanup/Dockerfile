FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates cron \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg

WORKDIR /app

COPY package*.json ./
COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production
ENV SAMSAR_ASSETS_V2_ROOT=/assets_v2
ENV CLEANUP_MIN_AGE_HOURS=168
ENV CLEANUP_FRAME_MIN_AGE_HOURS=24
ENV CLEANUP_TEMP_MIN_AGE_HOURS=48
ENV CLEANUP_CRON_SCHEDULE="17 */3 * * *"
ENV CLEANUP_ON_START=true
ENV CLEANUP_DRY_RUN=false
ENV CLEANUP_STATUS_FILE=/run/docker-cleanup/status.json
ENV CLEANUP_HEALTH_MAX_AGE_HOURS=4
ENV CLEANUP_HEALTH_MAX_RUN_HOURS=0.5

HEALTHCHECK --interval=30s --timeout=10s --start-period=1m --retries=2 \
  CMD ["node", "/app/src/healthcheck.js"]

CMD ["/app/docker-entrypoint.sh"]
