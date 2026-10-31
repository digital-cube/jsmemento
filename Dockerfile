# syntax=docker/dockerfile:1
# JSMemento server image.
#   docker build -t jsmemento .
#   docker run -p 3000:3000 -e DATABASE_URL=… -e REDIS_URL=… jsmemento
# See docs/DEPLOYMENT.md.

ARG NODE_VERSION=24

# --- build: install the workspace, compile, and bundle the server's production tree ------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@memento/cli...
# Standalone copies of @memento/server and @memento/cli with their production dependencies;
# the workspace packages they use (@memento/core, @memento/lookups, …) are copied in, not
# symlinked.
RUN pnpm --config.inject-workspace-packages=true --filter @memento/server deploy --prod /out/app \
 && pnpm --config.inject-workspace-packages=true --filter @memento/cli deploy --prod /out/cli \
 && mkdir -p /out/app/config \
 && cp -r lookups.yaml i18n /out/app/config/ \
 && printf '#!/bin/sh\nexec node /opt/memento-cli/dist/main.js "$@"\n' > /out/memento \
 && chmod 755 /out/memento

# --- runtime ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="jsmemento" \
      org.opencontainers.image.description="Self-hosted activity ledger: tenant-isolated event API with real-time streaming" \
      org.opencontainers.image.source="https://github.com/digital-cube/jsmemento" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info \
    MEMENTO_API_PREFIX=/memento \
    MEMENTO_LOOKUPS_PATH=/app/config/lookups.yaml \
    MEMENTO_CANDIDATES_DIR=/data/candidates
WORKDIR /app
COPY --from=build --chown=node:node /out/app /app
# `memento` CLI (tenants, API keys, templates…): `docker compose exec memento memento --help`
COPY --from=build /out/cli /opt/memento-cli
COPY --from=build /out/memento /usr/local/bin/memento
COPY --chmod=755 docker/healthcheck.mjs /usr/local/bin/memento-healthcheck
RUN mkdir -p /data/candidates && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD ["memento-healthcheck"]
# Applies pending migrations, then listens; SIGTERM closes connections and exits.
CMD ["node", "dist/server.js"]
