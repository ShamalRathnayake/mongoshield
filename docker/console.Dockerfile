# syntax=docker/dockerfile:1
#
# MongoShield Console container image: the self-hosted web UI for backups.
#
#   docker build -f docker/console.Dockerfile -t mongoshield-console .
#   docker run -p 8080:8080 -v mongoshield:/data mongoshield-console
#   # then open http://localhost:8080 and create the admin (within 15 minutes of start)
#
# Zero setup: with no environment at all, the first start generates the secret that
# encrypts stored credentials (/data/secret.key, mode 0600), creates the "Local backups"
# storage location (/data/backups), and lets the setup page create the first admin
# without the token for 15 minutes (the one-time link in the log works any time).
# Bring your own secret with MONGOSHIELD_SECRET or MONGOSHIELD_SECRET_FILE, and a
# pre-made admin with MONGOSHIELD_ADMIN_USERNAME + MONGOSHIELD_ADMIN_PASSWORD(_FILE);
# see docs/guides/docker.md. docker/smoke/console-zero-setup.sh tests all of this
# against a real MongoDB, and docker/smoke/console-srv-tls.sh tests mongodb+srv:// + TLS.
#
# Build from the repository root. Same three-stage layout as docker/Dockerfile (read
# that file for the reasoning behind each choice); the differences are:
#   - both workspace packages are built and packed (the console depends on the library),
#   - every cloud SDK is included by default, because storage is chosen in the UI,
#   - the container serves HTTP on 8080 and keeps its state in the /data volume.

ARG CLOUD_SDKS=all
# Base images are pinned by digest and npm installs honour NPM_BEFORE, as in
# docker/Dockerfile (read it for why).
ARG NPM_BEFORE=""


# ---------------------------------------------------------------------------
# Stage 1: build both packages and pack them as npm tarballs
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:24-trixie@sha256:8c761eca2bf7eec965f946cf47b8090143cb41f45f2f8699af0cc0298d2d2d19 AS build
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
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS deps
ARG CLOUD_SDKS
ARG NPM_BEFORE
WORKDIR /app
COPY --from=build /pack/mongoshield.tgz /pack/console.tgz /tmp/
COPY docker/install-sdks.sh /usr/local/bin/install-sdks.sh
RUN echo '{ "name": "mongoshield-console-image", "private": true, "type": "module" }' > package.json

# The library and the chosen SDKs first (the script also checks the CLI starts),
# then the console itself, whose `mongoshield` dependency is already satisfied.
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    sh /usr/local/bin/install-sdks.sh /tmp/mongoshield.tgz "$CLOUD_SDKS" \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
      ${NPM_BEFORE:+--before="$NPM_BEFORE"} /tmp/console.tgz

# The state volume's mount point, owned by the runtime user so a fresh named
# volume inherits that ownership and is writable without a chown (Docker copies the
# image's /data, including its owner 65532, into an empty named volume on first use).
# A bind-mounted host directory is not prepared that way: chown it to 65532 first.
RUN mkdir -p /data


# ---------------------------------------------------------------------------
# Stage 3: distroless runtime, non-root
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba AS runtime
ARG CLOUD_SDKS

LABEL org.opencontainers.image.title="MongoShield Console" \
      org.opencontainers.image.description="Self-hosted web console for MongoDB backups: schedules, verification, browsing and restores." \
      org.opencontainers.image.source="https://github.com/ShamalRathnayake/mongoshield" \
      org.opencontainers.image.documentation="https://shamalrathnayake.github.io/mongoshield/" \
      org.opencontainers.image.licenses="MIT" \
      io.mongoshield.cloud-sdks="${CLOUD_SDKS}"

COPY --from=deps /app /app
COPY --from=deps --chown=65532:65532 /data /data

# No HOST here: the server's own default listen address applies (all interfaces), so
# the image follows it, including dual-stack IPv4 + IPv6 where the server supports it.
# Set HOST to listen on one address only; the HEALTHCHECK below follows it.
ENV NODE_ENV=production \
    MONGOSHIELD_DATA_DIR=/data \
    PORT=8080

USER 65532:65532
WORKDIR /app
EXPOSE 8080

# The console's state (connections, plans, users, audit log, the generated secret.key)
# and the default "Local backups" location live here. Back the volume up, and keep that
# copy private: it holds the key next to what it encrypts. Backups that must survive the
# loss of this machine belong in an off-machine location (S3 and friends).
VOLUME ["/data"]

# Unlike the CLI image, the console is a long-running web server, so a health check
# is meaningful: /healthz answers when the server is up. Distroless has no curl, so
# Node itself makes the request; any failure exits non-zero.
#
# Which address: the one in HOST when it names a single address (an IPv6 one goes in
# brackets), otherwise loopback over IPv4 and then IPv6, so the check passes whether the
# server listens on 0.0.0.0, on :: (dual stack) or in an IPv6-only network.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const host=process.env.HOST||'';const port=process.env.PORT||8080;const any=['','0.0.0.0','::','[::]'].includes(host);const hosts=any?['127.0.0.1','[::1]']:[host.includes(':')&&!host.startsWith('[')?'['+host+']':host];(async()=>{for(const h of hosts){try{const r=await fetch('http://'+h+':'+port+'/healthz',{signal:AbortSignal.timeout(2000)});if(r.ok)process.exit(0)}catch{}}process.exit(1)})()"]

# The server handles SIGTERM and SIGINT itself (finishes running jobs within a grace
# period, then exits 0), so `docker stop` and Ctrl-C under `docker run -it` stop it
# promptly without `--init`, even though Node.js runs as PID 1.
ENTRYPOINT ["/nodejs/bin/node", "/app/node_modules/@mongoshield/console/dist/server/main.mjs"]
