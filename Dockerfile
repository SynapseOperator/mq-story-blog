# syntax=docker/dockerfile:1
# Tags describe the reviewed versions; digests bind the actual image inputs.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@11.17.0 && test "$(npm --version)" = "11.17.0"
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

# Offline maintenance/test target: no secret is copied into the image. Its
# operator grants one operation's files at runtime; it is not the web container.
FROM build AS tools
RUN groupadd --gid 10001 mq && useradd --uid 10001 --gid 10001 --no-create-home mq \
    && mkdir -p /var/lib/mq/media && chown 10001:10001 /var/lib/mq/media \
    && chmod 0700 /var/lib/mq/media
USER 10001:10001
ENV NODE_ENV=production
ENTRYPOINT ["node"]
CMD ["scripts/production/database-cli.mjs", "audit"]

# Offline backup/restore target only. Native PG tools match the server major;
# restic is a pinned upstream static binary, absent from the application image.
FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic
FROM postgres:18.6-bookworm@sha256:f1ea2a1a4fb7b68d4836be1fdcb8a6466a89b072158bf9d97663600538c294c5 AS operations
WORKDIR /app
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY --from=tools /app /app
RUN groupadd --gid 10001 mq && useradd --uid 10001 --gid 10001 --no-create-home mq \
    && node --version && pg_dump --version && restic version
USER 10001:10001
ENV NODE_ENV=production
ENTRYPOINT ["node"]
CMD ["scripts/production/operations-check.mjs"]

FROM caddy:2.11.9-alpine@sha256:71d41fe4b1ae92a058abc87afe614178b996d8a6b96d0f4c71ae30606e5927e3 AS proxy
COPY ops/Caddyfile ops/Caddyfile.local ops/mq-options.caddy ops/mq-proxy.caddy /etc/caddy/
COPY scripts/production/caddy-entrypoint.sh /usr/local/bin/mq-caddy-entrypoint
RUN chmod 0555 /usr/local/bin/mq-caddy-entrypoint \
    && mkdir -p /data /config && chown -R 10001:10001 /data /config
USER 10001:10001
ENTRYPOINT ["/bin/sh", "/usr/local/bin/mq-caddy-entrypoint"]

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
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
