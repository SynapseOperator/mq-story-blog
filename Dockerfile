# syntax=docker/dockerfile:1
# Tags describe the reviewed versions; digests bind the actual image inputs.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get -o Acquire::Retries=0 update && apt-get -o Acquire::Retries=0 upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@11.17.0 && test "$(npm --version)" = "11.17.0"
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

# Offline targets share the full toolchain layer instead of copying /app into a
# second image. Both use PG18 native tools and Bookworm-compatible Node/Prisma.
# No database server is started here; this is not the web container.
FROM postgres:18.6-bookworm@sha256:f1ea2a1a4fb7b68d4836be1fdcb8a6466a89b072158bf9d97663600538c294c5 AS tools
WORKDIR /app
# Apply signed same-release distribution fixes in the candidate, never on the VPS.
RUN apt-get -o Acquire::Retries=0 update && apt-get -o Acquire::Retries=0 upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=build /app /app
RUN groupadd --gid 10001 mq && useradd --uid 10001 --gid 10001 --no-create-home mq \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && mkdir -p /var/lib/mq/media && chown 10001:10001 /var/lib/mq/media \
    && chmod 0700 /var/lib/mq/media && node --version && test "$(npm --version)" = "11.17.0" && pg_dump --version
USER 10001:10001
ENV NODE_ENV=production
ENTRYPOINT ["node"]
CMD ["scripts/production/database-cli.mjs", "audit"]

# Offline backup/restore target only. Native PG tools match the server major;
# restic is a pinned upstream static binary, absent from the application image.
FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic
FROM tools AS operations
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
RUN node --version && pg_dump --version && restic version
CMD ["scripts/production/operations-check.mjs"]

FROM caddy:2.11.9-alpine@sha256:71d41fe4b1ae92a058abc87afe614178b996d8a6b96d0f4c71ae30606e5927e3 AS proxy
RUN apk upgrade --no-cache
COPY ops/Caddyfile ops/Caddyfile.local ops/mq-options.caddy ops/mq-proxy.caddy /etc/caddy/
COPY scripts/production/caddy-entrypoint.sh /usr/local/bin/mq-caddy-entrypoint
RUN chmod 0555 /usr/local/bin/mq-caddy-entrypoint \
    && mkdir -p /data /config && chown -R 10001:10001 /data /config
USER 10001:10001
ENTRYPOINT ["/bin/sh", "/usr/local/bin/mq-caddy-entrypoint"]

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
# The runtime starts Node directly. Package managers belong only in build/tools.
RUN apt-get -o Acquire::Retries=0 update && apt-get -o Acquire::Retries=0 upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
RUN groupadd --gid 10001 mq && useradd --uid 10001 --gid 10001 --no-create-home mq \
    && mkdir -p /var/lib/mq/media /app/.next/cache /app/src/server/media \
    && chown -R 10001:10001 /var/lib/mq /app/.next/cache \
    && chmod 0700 /var/lib/mq/media \
    && printf '%s\n' '{"type":"module"}' > /app/src/server/media/package.json
COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=build --chown=10001:10001 /app/public ./public
# These execute outside Next's bundle (startup audit and the isolated decoder).
COPY --from=build /app/scripts/production ./scripts/production
COPY --from=build /app/scripts/db/log-privacy.mjs /app/scripts/db/prisma-command.mjs ./scripts/db/
COPY --from=build /app/config/postgresql/log-privacy.conf ./config/postgresql/log-privacy.conf
COPY --from=build /app/prisma/migrations ./prisma/migrations
COPY --from=build /app/src/server/media/local-store.ts ./src/server/media/local-store.ts
COPY --from=build /app/scripts/media/image-worker.mjs ./scripts/media/image-worker.mjs
USER 10001:10001
EXPOSE 3000
CMD ["node", "scripts/production/start.mjs"]
