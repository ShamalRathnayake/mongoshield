# syntax=docker/dockerfile:1
#
# MongoShield container image.
#
#   docker build -f docker/Dockerfile -t mongoshield .                      # S3 support (default)
#   docker build -f docker/Dockerfile --build-arg CLOUD_SDKS=all -t mongoshield:all .
#   docker run --rm --init -e MONGODB_URI=... -e MONGOSHIELD_STORAGE=s3://bucket/prefix mongoshield backup
#
# Build from the repository root (the build needs the workspace lockfile).
#
# Three stages, so the final image contains nothing but Node.js, the built
# package and its production dependencies:
#
#   1. build    install the workspace with the lockfile, build dist/, pack the npm tarball
#   2. deps     install that tarball like a user would, plus the driver and the chosen cloud SDKs
#   3. runtime  distroless Node.js 24 (no shell, no package manager), running as non-root
#
# Expected size (uncompressed, linux/amd64): the distroless nodejs24 base is ~140 MB,
# almost all of it the node binary. node_modules adds (measured with install-sdks.sh):
#   CLOUD_SDKS=none  ~19 MB  (mongoshield, its 4 small dependencies, the mongodb driver)
#   CLOUD_SDKS=s3    ~41 MB  (default: + AWS S3, multipart upload and KMS clients)
#   CLOUD_SDKS=all  ~170 MB  (+ Google Cloud and Azure SDKs with gRPC/protobuf and auth)
# So the default image is ~180 MB on disk and ~60 MB compressed in the registry.

# Which optional cloud SDKs to bake in. A comma-separated list of:
#   s3     AWS SDK: S3 storage (also R2, B2, MinIO, Spaces, Wasabi) and AWS KMS
#   gcs    Google Cloud Storage and Cloud KMS
#   azure  Azure Blob Storage, Key Vault and Azure identity
#   sftp   ssh2, for SFTP storage
#   all    everything above
#   none   local/mounted storage only (smallest image)
# Declared before the first FROM so every stage can read it.
ARG CLOUD_SDKS=s3

# Node.js major version. Debian 13 (trixie) everywhere so the deps stage and the
# distroless runtime share the same glibc, should a dependency ever ship native code.
ARG NODE_MAJOR=24


# ---------------------------------------------------------------------------
# Stage 1: build
# ---------------------------------------------------------------------------
# Runs on the builder's own CPU architecture ($BUILDPLATFORM) even for arm64 images:
# its output (JavaScript and an npm tarball) is identical on every platform, and
# running natively avoids slow QEMU emulation in multi-arch builds.
FROM --platform=$BUILDPLATFORM node:${NODE_MAJOR}-trixie AS build

WORKDIR /repo

# corepack reads "packageManager" from package.json and fetches that exact pnpm.
# Node 24 still bundles corepack (it was removed from Node 25 onwards).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Copy only the manifests first. This layer, and the slow install below, stay cached
# until a dependency changes; editing source code does not invalidate them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Every workspace project's manifest, so the frozen lockfile matches the workspace;
# --filter below still installs only what the CLI needs.
COPY packages/mongoshield/package.json packages/mongoshield/
COPY packages/console/package.json packages/console/
COPY website/package.json website/

# --frozen-lockfile: fail instead of resolving new versions, so the image is built
#   from exactly the dependencies CI tested.
# --ignore-scripts: no install scripts. The build needs none, and the root "prepare"
#   script (git hooks) would fail here because there is no .git directory.
# The cache mount keeps pnpm's store between builds without putting it in a layer.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm-store --filter mongoshield

COPY tsconfig.base.json ./
COPY packages/mongoshield packages/mongoshield

# Build dist/ and pack it exactly as `npm publish` would. The deps stage installs this
# tarball, so the image runs the same artifact users get from npm (same "files" list,
# same package.json), not a workspace checkout.
RUN pnpm --filter mongoshield build \
 && pnpm --filter mongoshield pack --pack-destination /pack \
 && mv /pack/mongoshield-*.tgz /pack/mongoshield.tgz


# ---------------------------------------------------------------------------
# Stage 2: deps
# ---------------------------------------------------------------------------
# Runs on the *target* platform. All dependencies are pure JavaScript today, but
# installing on the target means a future dependency with platform-specific
# optional packages still gets the right ones.
FROM node:${NODE_MAJOR}-trixie-slim AS deps
ARG CLOUD_SDKS

# Why npm and not `pnpm deploy --prod`: the cloud SDKs are *optional peer*
# dependencies, and the workspace lockfile resolves them (auto-install-peers) as
# regular dependencies of the package. `pnpm deploy` would therefore always copy
# every SDK (GCS, Azure, SSH...) into the image, ignoring CLOUD_SDKS. Installing the
# packed tarball into a tiny "consumer" project gives exactly what a user gets from
# `npm install mongoshield mongodb @aws-sdk/client-s3`, and a flat node_modules
# with real files (no symlinks into a store) that copies cleanly into distroless.
WORKDIR /app
COPY --from=build /pack/mongoshield.tgz /tmp/mongoshield.tgz
COPY docker/install-sdks.sh /usr/local/bin/install-sdks.sh

# The "consumer project" at /app. A config file mounted into /app can then
# `import { defineConfig } from "mongoshield"`, because Node resolves bare imports
# from /app/node_modules.
RUN echo '{ "name": "mongoshield-image", "private": true, "type": "module" }' > package.json

RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    sh /usr/local/bin/install-sdks.sh /tmp/mongoshield.tgz "$CLOUD_SDKS"

# An empty, non-root-owned mount point for local backups. Docker copies this
# ownership into a fresh named volume on first use, so `-v backups:/backups` is
# writable by the non-root user without any chown.
RUN mkdir -p /backups


# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
# Distroless: Node.js and the bare minimum around it (glibc, CA certificates,
# tzdata). No shell, no package manager, so far fewer CVEs and nothing for an
# attacker to use. Every dependency is pure JavaScript, so nothing is missing;
# MongoShield never spawns binaries (no mongodump), and the zstd compression it
# uses is built into Node.js 24's zlib. To debug interactively, use the
# `:debug-nonroot` variant of this base image, which adds a busybox shell.
#
# The `nonroot` tag runs as uid/gid 65532. It is repeated below as a numeric
# USER so Kubernetes can verify `runAsNonRoot: true` without guessing.
FROM gcr.io/distroless/nodejs${NODE_MAJOR}-debian13:nonroot AS runtime

ARG CLOUD_SDKS

# OCI labels: shown by registries (GHCR links the image to the repository via
# "source") and by `docker inspect`. The release workflow adds version, revision
# and created on top of these.
LABEL org.opencontainers.image.title="MongoShield" \
      org.opencontainers.image.description="Backup, restore and copy MongoDB. No mongodump required." \
      org.opencontainers.image.source="https://github.com/ShamalRathnayake/mongoshield" \
      org.opencontainers.image.url="https://github.com/ShamalRathnayake/mongoshield" \
      org.opencontainers.image.documentation="https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/guides/docker.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="MongoShield" \
      io.mongoshield.cloud-sdks="${CLOUD_SDKS}"

COPY --from=deps /app /app
COPY --from=deps --chown=65532:65532 /backups /backups

# NODE_ENV=production: some SDKs skip development-only checks.
ENV NODE_ENV=production

USER 65532:65532

# The working directory is where the CLI looks for mongoshield.config.{ts,js,json}
# (mount yours at /app/mongoshield.config.json) and what relative storage paths
# such as ./backups resolve against. Prefer absolute paths like /backups.
WORKDIR /app

# No HEALTHCHECK on purpose. `mongoshield run` (and every other command) exits when
# done, and Docker/Kubernetes already notice a process that exits. For the
# long-running `schedule` command, a healthy process is not the same as healthy
# backups: a check that the process answers would stay green while every backup
# fails. Use the `heartbeat` config option (healthchecks.io, Cronitor, ...) or
# `notify` instead; they alert when backups stop *succeeding*. Distroless has no
# curl/wget to run a check with anyway.
#
# Signals: a process running as PID 1 gets no default SIGTERM handling from the
# kernel. `schedule` handles SIGTERM itself (it lets the running backup finish or
# abort it cleanly, then exits). For one-off commands, run with `docker run --init`
# (compose: `init: true`) so `docker stop` interrupts them promptly.
#
# The node binary lives at /nodejs/bin/node in distroless and is not on PATH,
# hence the absolute path. dist/cli.mjs is the package's "bin" entry.
ENTRYPOINT ["/nodejs/bin/node", "/app/node_modules/mongoshield/dist/cli.mjs"]

# With no arguments the container runs the scheduler, which reads `schedule.cron`
# from the config. Override with any command: `docker run ... mongoshield list`.
CMD ["schedule"]
