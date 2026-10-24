# syntax=docker/dockerfile:1
#
# MongoShield Console container image: the self-hosted web UI for backups.
#
#   docker build -f docker/console.Dockerfile -t mongoshield-console .
#   docker run -p 8080:8080 -v mongoshield-console:/data \
#     -e MONGOSHIELD_SECRET="$(openssl rand -hex 32)" mongoshield-console
#   # then open the one-time setup link printed in the log
#
# Build from the repository root. Same three-stage layout as docker/Dockerfile (read
# that file for the reasoning behind each choice); the differences are:
#   - both workspace packages are built and packed (the console depends on the library),
#   - every cloud SDK is included by default, because storage is chosen in the UI,
#   - the container serves HTTP on 8080 and keeps its state in the /data volume.

ARG CLOUD_SDKS=all
ARG NODE_MAJOR=24


# ---------------------------------------------------------------------------
# Stage 1: build both packages and pack them as npm tarballs
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_MAJOR}-bookworm AS build
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Manifests first, so the slow install is cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/mongoshield/package.json packages/mongoshield/
COPY packages/console/package.json packages/console/
COPY website/package.json website/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm-store \
      --filter mongoshield --filter @mongoshield/console

COPY tsconfig.base.json ./
COPY packages/mongoshield packages/mongoshield
COPY packages/console packages/console

# The console's build runs Vite (UI → dist/ui) and tsdown (server → dist/server).
# `pnpm pack` rewrites the console's `workspace:*` dependency on mongoshield to the
# exact version being packed, so the two tarballs install together below.
RUN pnpm --filter mongoshield build \
 && pnpm --filter @mongoshield/console build \
 && pnpm --filter mongoshield pack --pack-destination /pack \
 && pnpm --filter @mongoshield/console pack --pack-destination /pack \
 && mv /pack/mongoshield-[0-9]*.tgz /pack/mongoshield.tgz \
 && mv /pack/mongoshield-console-*.tgz /pack/console.tgz


# ---------------------------------------------------------------------------
# Stage 2: install the tarballs like a user would (flat node_modules, no symlinks)
# ---------------------------------------------------------------------------
FROM node:${NODE_MAJOR}-bookworm-slim AS deps
ARG CLOUD_SDKS
WORKDIR /app
COPY --from=build /pack/mongoshield.tgz /pack/console.tgz /tmp/
COPY docker/install-sdks.sh /usr/local/bin/install-sdks.sh
RUN echo '{ "name": "mongoshield-console-image", "private": true, "type": "module" }' > package.json

# The library and the chosen SDKs first (the script also checks the CLI starts),
# then the console itself, whose `mongoshield` dependency is already satisfied.
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    sh /usr/local/bin/install-sdks.sh /tmp/mongoshield.tgz "$CLOUD_SDKS" \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund /tmp/console.tgz

# The state volume's mount point, owned by the runtime user so a fresh named
# volume inherits that ownership and is writable without a chown.
RUN mkdir -p /data


# ---------------------------------------------------------------------------
# Stage 3: distroless runtime, non-root
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs${NODE_MAJOR}-debian12:nonroot AS runtime
ARG CLOUD_SDKS

LABEL org.opencontainers.image.title="MongoShield Console" \
      org.opencontainers.image.description="Self-hosted web console for MongoDB backups: schedules, verification, browsing and restores." \
      org.opencontainers.image.source="https://github.com/ShamalRathnayake/mongoshield" \
      org.opencontainers.image.documentation="https://shamalrathnayake.github.io/mongoshield/" \
      org.opencontainers.image.licenses="MIT" \
      io.mongoshield.cloud-sdks="${CLOUD_SDKS}"

COPY --from=deps /app /app
COPY --from=deps --chown=65532:65532 /data /data

ENV NODE_ENV=production \
    MONGOSHIELD_DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

USER 65532:65532
WORKDIR /app
EXPOSE 8080

# The console's state (connections, plans, users, audit log) lives here. Back the
# volume up too: losing it means re-entering connections, not losing backups, which
# stay in their storage locations.
VOLUME ["/data"]

# Unlike the CLI image, the console is a long-running web server, so a health check
# is meaningful: /healthz answers when the server is up. Distroless has no curl, so
# Node itself makes the request; any failure exits non-zero.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# The server handles SIGTERM itself (finishes running jobs within a grace period).
ENTRYPOINT ["/nodejs/bin/node", "/app/node_modules/@mongoshield/console/dist/server/main.mjs"]
