# syntax=docker/dockerfile:1
#
# MongoShield Kubernetes operator image: watches MongoShieldBackupPlan,
# MongoShieldBackup and MongoShieldRestore objects and runs the MongoShield image
# (docker/Dockerfile) as Jobs.
#
#   docker build -f docker/operator.Dockerfile -t mongoshield-operator .
#   helm install mongoshield-operator deploy/helm/mongoshield-operator
#
# Build from the repository root. Same three-stage layout as docker/Dockerfile (read
# that file for the reasoning behind each choice); the differences are:
#   - the library and the operator are built and packed (the operator validates plans
#     with the library's config schema),
#   - no cloud SDKs: the operator never touches storage or databases itself; the Jobs
#     it creates do, with the MongoShield image,
#   - the process is long-running and serves /healthz, /readyz and /metrics on 8080.

ARG NODE_MAJOR=24


# ---------------------------------------------------------------------------
# Stage 1: build both packages and pack them as npm tarballs
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_MAJOR}-trixie AS build
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Manifests first, so the slow install is cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/mongoshield/package.json packages/mongoshield/
COPY packages/operator/package.json packages/operator/
COPY website/package.json website/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm-store \
      --filter mongoshield --filter @mongoshield/operator

COPY tsconfig.base.json ./
COPY packages/mongoshield packages/mongoshield
COPY packages/operator packages/operator

# `pnpm pack` rewrites the operator's `workspace:*` dependency on mongoshield to the
# exact version being packed, so the two tarballs install together below.
RUN pnpm --filter mongoshield build \
 && pnpm --filter @mongoshield/operator build \
 && pnpm --filter mongoshield pack --pack-destination /pack \
 && pnpm --filter @mongoshield/operator pack --pack-destination /pack \
 && mv /pack/mongoshield-[0-9]*.tgz /pack/mongoshield.tgz \
 && mv /pack/mongoshield-operator-*.tgz /pack/operator.tgz


# ---------------------------------------------------------------------------
# Stage 2: install the tarballs like a user would (flat node_modules, no symlinks)
# ---------------------------------------------------------------------------
FROM node:${NODE_MAJOR}-trixie-slim AS deps
WORKDIR /app
COPY --from=build /pack/mongoshield.tgz /pack/operator.tgz /tmp/
RUN echo '{ "name": "mongoshield-operator-image", "private": true, "type": "module" }' > package.json

# The library first (with the MongoDB driver, its required peer), then the operator,
# whose `mongoshield` dependency is already satisfied. No install scripts run.
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm install --omit=dev --ignore-scripts --no-audit --no-fund /tmp/mongoshield.tgz mongodb@^7 \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund /tmp/operator.tgz \
 && test -f node_modules/@mongoshield/operator/dist/main.mjs


# ---------------------------------------------------------------------------
# Stage 3: distroless runtime, non-root
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs${NODE_MAJOR}-debian13:nonroot AS runtime

LABEL org.opencontainers.image.title="MongoShield Operator" \
      org.opencontainers.image.description="Kubernetes operator for MongoDB backups and restores with MongoShield." \
      org.opencontainers.image.source="https://github.com/ShamalRathnayake/mongoshield" \
      org.opencontainers.image.documentation="https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/guides/kubernetes-operator.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="MongoShield"

COPY --from=deps /app /app

ENV NODE_ENV=production \
    HTTP_PORT=8080

# Numeric user, so Kubernetes can verify runAsNonRoot without guessing.
USER 65532:65532
WORKDIR /app
EXPOSE 8080

# No HEALTHCHECK: in Kubernetes the Deployment's liveness and readiness probes call
# /healthz and /readyz. Locally: docker run -p 8080:8080 … && curl localhost:8080/healthz.
#
# The operator handles SIGTERM itself: it stops taking new work, lets running
# reconciles finish, releases its leader Lease and exits.
ENTRYPOINT ["/nodejs/bin/node", "/app/node_modules/@mongoshield/operator/dist/main.mjs"]
