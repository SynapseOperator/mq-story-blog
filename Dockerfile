# syntax=docker/dockerfile:1
# Tags describe the reviewed versions; digests bind the actual image inputs.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get -o Acquire::Retries=0 update && apt-get -o Acquire::Retries=0 upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@11.21.2 && test "$(npm --version)" = "11.21.2"
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
    && apt-get install -y --no-install-recommends ca-certificates \
    && test -s /etc/ssl/certs/ca-certificates.crt \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=build /app /app
RUN groupadd --gid 10001 mq && useradd --uid 10001 --gid 10001 --no-create-home mq \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && mkdir -p /var/lib/mq/media && chown 10001:10001 /var/lib/mq/media \
    && chmod 0700 /var/lib/mq/media && node --version && test "$(npm --version)" = "11.21.2" && pg_dump --version
USER 10001:10001
ENV NODE_ENV=production
ENTRYPOINT ["node"]
CMD ["scripts/production/database-cli.mjs", "audit"]

# MQ rebuild of the signed upstream source, not an upstream release binary.
# 0.19.1's official binary uses Go 1.26.4 and lacks GO-2026-6809. Keep the
# upstream Go code unchanged; apply a fixed dependency-only patch for the S3
# HTTP/2 and repository compression paths, and use the fixed official compiler.
FROM golang:1.27.3-alpine@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS restic-build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS="-mod=readonly -buildvcs=false"
WORKDIR /build
RUN apk add --no-cache patch
ADD --checksum=sha256:bb9b1a19040744d26d8a79be029d4e6b189c45ccc9d8831d7fe367d3c33df725 https://github.com/restic/restic/releases/download/v0.19.1/restic-0.19.1.tar.gz /build/source.tar.gz
RUN test "$(go version)" = "go version go1.27.3 linux/amd64" \
    && tar -xzf source.tar.gz && mkdir /out
WORKDIR /build/restic-0.19.1
COPY ops/restic-dependencies.patch /build/restic-dependencies.patch
RUN printf '%s\n' 'd166913ed4897cf69069ef5be090b2d79a857fc28328bb950e12655b5a54f176  go.mod' \
      'e2d2bab6fc96eeaf53d9460af8b43e25d4c5c5de6c1aa6c1306550e6b62b26bc  go.sum' > /out/upstream-module-lock.sha256 \
    && sha256sum -c /out/upstream-module-lock.sha256 \
    && patch -p1 < /build/restic-dependencies.patch \
    && printf '%s\n' 'b95419a360174ea8aa271019e7e7bb683830e749bc0121d8a7913a88526f9820  go.mod' \
      'ccd95498facd178283e4abb3538a9b12fb280c904518bce116cc9353969575cc  go.sum' > /out/module-lock.sha256 \
    && sha256sum -c /out/module-lock.sha256 \
    && go mod download && go mod verify && sha256sum -c /out/module-lock.sha256
RUN --network=none go run build.go --goos linux --goarch amd64 --output /out/restic \
    && sha256sum -c /out/module-lock.sha256 \
    && test "$(/out/restic version)" = "restic 0.19.1 compiled with go1.27.3 on linux/amd64" \
    && go version -m /out/restic > /out/restic-buildinfo.txt \
    && sha256sum /out/restic > /out/restic.sha256
COPY tests/fixtures/restic/ /security-test/
RUN --network=none go run /security-test/verify-distrust.go /security-test/compromised-intermediate.txt \
    && /bin/sh /security-test/roundtrip.sh /out/restic
ADD --checksum=sha256:f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2 /build/restic-upstream-control.bz2
RUN --network=none bunzip2 -c /build/restic-upstream-control.bz2 > /build/restic-upstream-control \
    && chmod 0500 /build/restic-upstream-control \
    && /bin/sh /security-test/cross-version.sh /build/restic-upstream-control /out/restic

# Offline backup/restore only. The source/compiler do not enter the final image.
FROM tools AS operations
LABEL org.mq.restic.distribution="mq-patched-rebuild" org.mq.restic.version="0.19.1" org.mq.restic.go-version="1.27.3"
COPY --from=restic-build /out/restic /usr/local/bin/restic
COPY --from=restic-build /out/restic-buildinfo.txt /out/module-lock.sha256 /out/upstream-module-lock.sha256 /out/restic.sha256 /usr/local/share/mq/
COPY ops/restic-source-provenance.json /usr/local/share/mq/restic-source-provenance.json
RUN node --version && pg_dump --version && restic version
CMD ["scripts/production/operations-check.mjs"]

FROM caddy:2.11.9-alpine@sha256:71d41fe4b1ae92a058abc87afe614178b996d8a6b96d0f4c71ae30606e5927e3 AS proxy
RUN apk upgrade --no-cache
COPY ops/Caddyfile ops/Caddyfile.local ops/Caddyfile.private ops/mq-options.caddy ops/mq-proxy.caddy /etc/caddy/
COPY scripts/production/caddy-entrypoint.sh /usr/local/bin/mq-caddy-entrypoint
RUN chmod 0555 /usr/local/bin/mq-caddy-entrypoint \
    && mkdir -p /data /config && chown -R 10001:10001 /data /config
USER 10001:10001
ENTRYPOINT ["/bin/sh", "/usr/local/bin/mq-caddy-entrypoint"]

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS app
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
