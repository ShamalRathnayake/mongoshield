#!/usr/bin/env bash
#
# Smoke test of the console image's zero-setup promise, end to end against a real MongoDB:
#
#   docker run -p 8080:8080 -v mongoshield:/data ghcr.io/shamalrathnayake/mongoshield-console
#
# with NO environment variables and a fresh volume must start, serve /healthz, let the
# first admin be created without the setup token (the setup window), and then take a
# connection, back it up with "Back up now" into the default "Local backups" location
# (encrypted with a key the console keeps) and restore it. Run from anywhere:
#
#   docker/smoke/console-zero-setup.sh [image]          # default: mongoshield-console:local
#
# What it checks, in order:
#    1. a MongoDB 8 replica set on a private Docker network, with 50 seeded documents;
#    2. the console starts with no env and a fresh named volume (the image prepares /data
#       for its non-root user, uid 65532), says it generated a secret key, and prints the
#       setup instructions (setup window + one-time link);
#    3. GET /api/session reports the setup window open, POST /api/setup without a token
#       creates the admin (the request has no Origin header, like curl, so the
#       same-origin check lets it through);
#    4. the connection check, saving the connection, the default storage location;
#    5. "Back up now" → a succeeded, encrypted backup job;
#    6. a restore into a renamed database, counted with mongosh inside the mongo container;
#    7. the recovery key (age private key) can be downloaded once by the admin;
#    8. /data/secret.key is mode 0600 and owned by 65532, survives a restart unchanged, and
#       the restarted console still opens its state (sign-in, connections);
#    9. starting the same volume with a different MONGOSHIELD_SECRET is refused (clear error);
#   10. the Docker HEALTHCHECK reports healthy;
#   11. SIGINT (Ctrl-C) and SIGTERM (docker stop) stop the console promptly with exit code 0;
#   12. an explicit MONGOSHIELD_SECRET still works as before, a too-short one is refused.
#
# Everything it creates (containers, network, volumes) is removed on exit, also on failure.
# Needs docker, curl, jq and openssl on the host.

set -euo pipefail

IMAGE="${1:-mongoshield-console:local}"
# A port that is unlikely to be taken on a developer machine; CI may override it.
PORT="${SMOKE_PORT:-18080}"
BASE="http://127.0.0.1:${PORT}"
# A unique suffix, so two runs (or a crashed earlier run) never collide.
RUN_ID="smoke$$"
NETWORK="ms-${RUN_ID}"
MONGO="ms-${RUN_ID}-mongo"
CONSOLE="ms-${RUN_ID}-console"
VOLUME="ms-${RUN_ID}-data"
VOLUME_EXPLICIT="ms-${RUN_ID}-explicit"
WORK="$(mktemp -d)"

# The admin this test creates. Twelve characters minimum, like every console password.
ADMIN_USER="admin"
ADMIN_PASSWORD="smoke-test-password-$(openssl rand -hex 4)"

log() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nFAIL: %s\n' "$*" >&2
  # The console's log usually says why; show its end before cleaning up.
  docker logs --tail 60 "${CONSOLE}" 2>&1 | sed 's/^/  console| /' >&2 || true
  exit 1
}

cleanup() {
  docker rm -f "${CONSOLE}" "${CONSOLE}-explicit" "${MONGO}" >/dev/null 2>&1 || true
  docker volume rm -f "${VOLUME}" "${VOLUME_EXPLICIT}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

# The session cookie and CSRF token of the signed-in admin, set by remember_session.
COOKIE=""
CSRF=""

# api METHOD PATH [JSON]: calls the API, prints the response body, fails on non-2xx.
# Sends the session cookie and CSRF token once there are any. The cookie is passed by
# hand instead of through a cookie jar: it is `__Host-…; Secure`, and whether a client
# sends Secure cookies to plain-HTTP localhost differs between curl versions (browsers
# do send them to localhost).
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o "${WORK}/body" -D "${WORK}/headers" -w '%{http_code}' -X "${method}")
  [[ -n "${COOKIE}" ]] && args+=(-H "Cookie: ${COOKIE}")
  [[ -n "${CSRF}" ]] && args+=(-H "x-csrf-token: ${CSRF}")
  [[ -n "${body}" ]] && args+=(-H 'content-type: application/json' --data "${body}")
  local status
  status="$(curl "${args[@]}" "${BASE}${path}")"
  if [[ "${status}" != 2* ]]; then
    fail "${method} ${path} answered ${status}: $(cat "${WORK}/body")"
  fi
  cat "${WORK}/body"
}

# Keeps the session cookie from the last response's headers and the CSRF token from its body.
remember_session() {
  COOKIE="$(grep -i '^set-cookie:' "${WORK}/headers" | head -1 | sed -E 's/^[Ss]et-[Cc]ookie: *([^;]+).*/\1/' | tr -d '\r')"
  CSRF="$(jq -r '.csrfToken // empty' "${WORK}/body")"
  [[ -n "${COOKIE}" && -n "${CSRF}" ]] || fail "no session cookie or CSRF token in the response"
}

# expect_json JSON JQ_FILTER DESCRIPTION: fails unless the filter is true for the JSON.
expect_json() {
  jq -e "$2" >/dev/null <<<"$1" || fail "$3 (got: $1)"
}

# wait_healthz: polls /healthz for up to 60 s.
wait_healthz() {
  for _ in $(seq 1 60); do
    curl -fsS "${BASE}/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "the console did not answer /healthz within 60 s"
}

# wait_job ID: polls a job until it has finished; fails unless it succeeded. Prints it.
wait_job() {
  local job
  for _ in $(seq 1 120); do
    job="$(api GET "/api/jobs/$1")"
    case "$(jq -r .status <<<"${job}")" in
      succeeded) printf '%s' "${job}"; return 0 ;;
      failed | cancelled) fail "job $1 did not succeed: ${job}" ;;
    esac
    sleep 1
  done
  fail "job $1 did not finish within 120 s"
}

# mongosh_eval JS: runs a script in the mongo container and prints its output.
mongosh_eval() {
  docker exec "${MONGO}" mongosh --quiet "mongodb://localhost:27017/?replicaSet=rs0" --eval "$1"
}

# secret_key_fingerprint: mode, owner and SHA-256 of /data/secret.key, read from the volume
# by a throwaway container (the console image is distroless: it has no shell to look inside).
secret_key_fingerprint() {
  docker run --rm -v "${VOLUME}:/data:ro" busybox:1.37 \
    sh -c 'stat -c "%a %u" /data/secret.key && sha256sum /data/secret.key | cut -d" " -f1'
}

# ---------------------------------------------------------------------------
# 1. MongoDB
# ---------------------------------------------------------------------------

log "Starting MongoDB 8 (single-node replica set) on network ${NETWORK}"
docker network create "${NETWORK}" >/dev/null
docker run -d --name "${MONGO}" --network "${NETWORK}" --network-alias mongo \
  mongo:8.0 --replSet rs0 --bind_ip_all >/dev/null
for _ in $(seq 1 60); do
  docker exec "${MONGO}" mongosh --quiet --eval 'db.adminCommand({ ping: 1 }).ok' >/dev/null 2>&1 && break
  sleep 1
done
# The member's host name is the network alias the console uses, so the replica set's own
# view of itself (its `hello` reply) matches the connection string.
docker exec "${MONGO}" mongosh --quiet --eval \
  "rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] })" >/dev/null
for _ in $(seq 1 60); do
  [[ "$(docker exec "${MONGO}" mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null)" == "true" ]] && break
  sleep 1
done
mongosh_eval "db.getSiblingDB('shop').orders.insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: i, total: i * 1.5 }))).insertedIds.length" >/dev/null
[[ "$(mongosh_eval "db.getSiblingDB('shop').orders.countDocuments()")" == "50" ]] || fail "seeding MongoDB failed"

# ---------------------------------------------------------------------------
# 2. The console with no environment at all
# ---------------------------------------------------------------------------

log "Starting ${IMAGE} with no environment and a fresh volume"
docker run -d --name "${CONSOLE}" --network "${NETWORK}" \
  -p "127.0.0.1:${PORT}:8080" -v "${VOLUME}:/data" "${IMAGE}" >/dev/null
wait_healthz
LOGS="$(docker logs "${CONSOLE}" 2>&1)"
grep -q "generated a new secret key" <<<"${LOGS}" || fail "no 'generated a new secret key' message in the log"
grep -q "/data/secret.key" <<<"${LOGS}" || fail "the log does not say where the key is"
grep -q "within 15 minutes" <<<"${LOGS}" || fail "no setup window instructions in the log"
grep -q "/setup?token=" <<<"${LOGS}" || fail "no one-time setup link in the log"
grep -q "Created the default storage location" <<<"${LOGS}" || fail "no default storage location in the log"

# ---------------------------------------------------------------------------
# 3. The first admin, without the token
# ---------------------------------------------------------------------------

log "Creating the first admin through the setup window (no token)"
SESSION="$(api GET /api/session)"
expect_json "${SESSION}" '.setupComplete == false and .setup.tokenRequired == false and (.setup.windowEndsAt | type == "string")' \
  "the setup window should be open"
api POST /api/setup "$(jq -n --arg u "${ADMIN_USER}" --arg p "${ADMIN_PASSWORD}" '{username: $u, password: $p}')" >/dev/null
remember_session

# ---------------------------------------------------------------------------
# 4. Connection and storage
# ---------------------------------------------------------------------------

log "Checking and saving the connection"
URI="mongodb://mongo:27017/?replicaSet=rs0"
CHECK="$(api POST /api/connections/check "$(jq -n --arg uri "${URI}" '{uri: $uri}')")"
expect_json "${CHECK}" '.ok == true and .topology == "replicaSet" and .production.suggested == false' \
  "the connection check should succeed and call a Docker host a test database"
NAME="$(jq -r .suggestedName <<<"${CHECK}")"
CONNECTION="$(api POST /api/connections "$(jq -n --arg n "${NAME}" --arg uri "${URI}" '{name: $n, uri: $uri, production: false}')")"
CONNECTION_ID="$(jq -r .id <<<"${CONNECTION}")"
expect_json "${CONNECTION}" '.deployment.topology == "replicaSet"' "the saved connection should keep what the check found"
STORAGE="$(api GET /api/storage)"
expect_json "${STORAGE}" 'length == 1 and .[0].name == "Local backups" and .[0].url == "backups"' \
  "the default storage location should exist"

# ---------------------------------------------------------------------------
# 5. Back up now
# ---------------------------------------------------------------------------

log "Back up now"
QUICK="$(api POST /api/quick-backup "$(jq -n --arg id "${CONNECTION_ID}" '{connectionId: $id, include: ["shop.*"]}')")"
expect_json "${QUICK}" '.created == true and .plan.encryption.kind == "managed" and .plan.origin == "quick"' \
  "the quick plan should be created with a managed key"
PLAN_ID="$(jq -r .plan.id <<<"${QUICK}")"
STORAGE_ID="$(jq -r .plan.storageId <<<"${QUICK}")"
BACKUP_JOB="$(wait_job "$(jq -r .job.id <<<"${QUICK}")")"
BACKUP_ID="$(jq -r .backupId <<<"${BACKUP_JOB}")"
BACKUPS="$(api GET "/api/storage/${STORAGE_ID}/backups")"
jq -e --arg id "${BACKUP_ID}" 'any(.[]; .id == $id and .status == "complete" and .encrypted == true)' \
  >/dev/null <<<"${BACKUPS}" || fail "backup ${BACKUP_ID} should be complete and encrypted: ${BACKUPS}"

# ---------------------------------------------------------------------------
# 6. Restore into a renamed database
# ---------------------------------------------------------------------------

log "Restoring ${BACKUP_ID} into shop_restored"
RESTORE="$(api POST /api/restore "$(jq -n --arg s "${STORAGE_ID}" --arg b "${BACKUP_ID}" --arg t "${CONNECTION_ID}" \
  '{storageId: $s, backupId: $b, targetConnectionId: $t, include: ["shop.orders"], rename: {"shop.*": "shop_restored.*"}, mode: "fail-if-exists"}')")"
wait_job "$(jq -r .id <<<"${RESTORE}")" >/dev/null
RESTORED="$(mongosh_eval "db.getSiblingDB('shop_restored').orders.countDocuments()")"
[[ "${RESTORED}" == "50" ]] || fail "expected 50 restored documents, found ${RESTORED}"

# ---------------------------------------------------------------------------
# 7. The recovery key
# ---------------------------------------------------------------------------

log "Downloading the recovery key"
KEY="$(api POST "/api/plans/${PLAN_ID}/recovery-key")"
# shellcheck disable=SC2016 # `$key` is a jq variable, not a shell one.
expect_json "${KEY}" '. as $key | ($key.identity | startswith("AGE-SECRET-KEY-1")) and ($key.fileContent | contains($key.identity))' \
  "the recovery key should be an age identity"

# ---------------------------------------------------------------------------
# 8. secret.key: private, and stable across restarts
# ---------------------------------------------------------------------------

log "Checking /data/secret.key and restarting"
BEFORE="$(secret_key_fingerprint)"
[[ "$(head -1 <<<"${BEFORE}")" == "600 65532" ]] || fail "secret.key should be mode 600 owned by 65532, is: ${BEFORE}"
docker restart "${CONSOLE}" >/dev/null
wait_healthz
[[ "$(secret_key_fingerprint)" == "${BEFORE}" ]] || fail "secret.key changed across a restart"
docker logs "${CONSOLE}" 2>&1 | grep -q "Using the generated secret key" || fail "the restarted console did not reuse the key"
COOKIE="" CSRF=""
api POST /api/session "$(jq -n --arg u "${ADMIN_USER}" --arg p "${ADMIN_PASSWORD}" '{username: $u, password: $p}')" >/dev/null
remember_session
expect_json "$(api GET /api/connections)" 'length == 1' "the restarted console should still have its connection"

# ---------------------------------------------------------------------------
# 9. A different MONGOSHIELD_SECRET against the generated key's state is refused
# ---------------------------------------------------------------------------

log "A different MONGOSHIELD_SECRET on the same volume must be refused"
docker stop "${CONSOLE}" >/dev/null
set +e
WRONG="$(docker run --rm -v "${VOLUME}:/data" -e MONGOSHIELD_SECRET="$(openssl rand -hex 32)" "${IMAGE}" 2>&1)"
WRONG_EXIT=$?
set -e
[[ ${WRONG_EXIT} -ne 0 ]] || fail "the console started with a different secret"
grep -q "does not match" <<<"${WRONG}" || fail "unexpected message for a wrong secret: ${WRONG}"
docker start "${CONSOLE}" >/dev/null
wait_healthz

# ---------------------------------------------------------------------------
# 10. HEALTHCHECK
# ---------------------------------------------------------------------------

log "Waiting for Docker to report the container healthy (first check after 30 s)"
for _ in $(seq 1 90); do
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "${CONSOLE}")" == "healthy" ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "${CONSOLE}")" == "healthy" ]] || fail "the health check did not pass"

# ---------------------------------------------------------------------------
# 11. Ctrl-C and docker stop
# ---------------------------------------------------------------------------

log "SIGINT (Ctrl-C) stops it with exit code 0"
docker kill --signal INT "${CONSOLE}" >/dev/null
for _ in $(seq 1 15); do
  [[ "$(docker inspect --format '{{.State.Running}}' "${CONSOLE}")" == "false" ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Running}}/{{.State.ExitCode}}' "${CONSOLE}")" == "false/0" ]] \
  || fail "SIGINT did not stop the console cleanly: $(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "${CONSOLE}")"

log "SIGTERM (docker stop) stops it with exit code 0, well within the 10 s grace"
docker start "${CONSOLE}" >/dev/null
wait_healthz
START=$(date +%s)
docker stop "${CONSOLE}" >/dev/null
ELAPSED=$(($(date +%s) - START))
[[ "$(docker inspect --format '{{.State.ExitCode}}' "${CONSOLE}")" == "0" ]] || fail "docker stop: non-zero exit code"
[[ ${ELAPSED} -lt 8 ]] || fail "docker stop took ${ELAPSED} s (SIGTERM not handled?)"

# ---------------------------------------------------------------------------
# 12. Operator-managed secrets still work as before
# ---------------------------------------------------------------------------

log "An explicit MONGOSHIELD_SECRET still works; a short one is refused"
docker run -d --name "${CONSOLE}-explicit" -p "127.0.0.1:${PORT}:8080" -v "${VOLUME_EXPLICIT}:/data" \
  -e MONGOSHIELD_SECRET="$(openssl rand -hex 32)" "${IMAGE}" >/dev/null
wait_healthz
if docker logs "${CONSOLE}-explicit" 2>&1 | grep -q "generated a new secret key"; then
  fail "a key was generated although MONGOSHIELD_SECRET was set"
fi
docker rm -f "${CONSOLE}-explicit" >/dev/null
if docker run --rm -e MONGOSHIELD_SECRET=short "${IMAGE}" >"${WORK}/short.log" 2>&1; then
  fail "started with a too-short MONGOSHIELD_SECRET"
fi
grep -q "at least 32" "${WORK}/short.log" || fail "unexpected message for a short secret: $(cat "${WORK}/short.log")"
[[ "$(docker inspect --format '{{.Config.User}}' "${IMAGE}")" == "65532:65532" ]] || fail "the image should run as 65532"

log "PASS: zero-setup console smoke test (${IMAGE})"
