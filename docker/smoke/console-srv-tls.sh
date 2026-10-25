#!/usr/bin/env bash
#
# Atlas-style connection strings in the console image, for real but without Atlas:
#
#   mongodb+srv://user:pass@cluster0.example.test/?tlsCAFile=/certs/ca.pem
#
# Atlas strings rely on three things the distroless image must get right by itself:
#   - DNS SRV and TXT lookups (`_mongodb._tcp.cluster0…` lists the hosts; the TXT record
#     adds options such as replicaSet and authSource), done by Node's resolver;
#   - TLS, which `mongodb+srv://` turns on implicitly, verified against trusted CAs
#     (Node's bundled CAs for Atlas; a mounted CA file for a private authority);
#   - the replica set's own member names resolving from inside the container.
#
# This script builds that world on a private Docker network with fixed addresses:
#
#   172.31.250.53  CoreDNS   zone example.test: SRV _mongodb._tcp.cluster0 → mongo-tls:27017,
#                            TXT cluster0 "replicaSet=rs0&authSource=admin", A mongo-tls
#   172.31.250.10  mongod 8  requireTLS with a certificate for mongo-tls.example.test signed
#                            by a throwaway CA; replica set rs0; access control on
#   172.31.250.20  console   started with --dns 172.31.250.53 and the CA mounted read-only
#
# and checks, through the console's API:
#   1. the SRV string with tlsCAFile connects: ok, topology replicaSet; its path names the
#      database `shop` (the default authSource) while the user exists in `admin` only, so
#      it only authenticates when the TXT record's authSource=admin is honoured;
#   2. a raw password with special characters (`p@ss:w/rd`) pasted unencoded still works;
#   3. without tlsCAFile the check fails and calls it a TLS problem (`problem.kind: tls`);
#   4. a typo in the cluster name is a DNS problem (`dns-not-found`);
#   5. "Back up now" over the SRV/TLS connection succeeds.
#
#   docker/smoke/console-srv-tls.sh [image]           # default: mongoshield-console:local
#
# Docker's embedded DNS (127.0.0.11 in containers on user-defined networks) answers
# container names itself and forwards everything else, SRV and TXT included, to the
# servers given with --dns. Needs docker, curl, jq and openssl on the host.

set -euo pipefail

IMAGE="${1:-mongoshield-console:local}"
PORT="${SMOKE_PORT:-18082}"
BASE="http://127.0.0.1:${PORT}"
RUN_ID="srv$$"
NETWORK="ms-${RUN_ID}"
# A private range Docker rarely hands out by itself; override if it clashes.
SUBNET_PREFIX="${SMOKE_SUBNET_PREFIX:-172.31.250}"
DNS_IP="${SUBNET_PREFIX}.53"
MONGO_IP="${SUBNET_PREFIX}.10"
CONSOLE_IP="${SUBNET_PREFIX}.20"
DNS="ms-${RUN_ID}-dns"
MONGO="ms-${RUN_ID}-mongo"
CONSOLE="ms-${RUN_ID}-console"
VOLUME="ms-${RUN_ID}-data"
# Pinned: a moving tag could change the resolver's behaviour under the test.
COREDNS_IMAGE="coredns/coredns:1.11.3"
WORK="$(mktemp -d)"

# The database user: its password needs percent-encoding in a URI, on purpose.
DB_USER="atlas-like"
DB_PASSWORD='p@ss:w/rd-2026'
ADMIN_PASSWORD="smoke-test-password-$(openssl rand -hex 4)"

log() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nFAIL: %s\n' "$*" >&2
  docker logs --tail 40 "${CONSOLE}" 2>&1 | sed 's/^/  console| /' >&2 || true
  docker logs --tail 20 "${DNS}" 2>&1 | sed 's/^/  dns| /' >&2 || true
  exit 1
}
cleanup() {
  docker rm -f "${CONSOLE}" "${MONGO}" "${DNS}" >/dev/null 2>&1 || true
  docker volume rm -f "${VOLUME}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

COOKIE=""
CSRF=""
# api METHOD PATH [JSON]: the response body; fails on non-2xx (see console-zero-setup.sh).
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o "${WORK}/body" -D "${WORK}/headers" -w '%{http_code}' -X "${method}")
  [[ -n "${COOKIE}" ]] && args+=(-H "Cookie: ${COOKIE}")
  [[ -n "${CSRF}" ]] && args+=(-H "x-csrf-token: ${CSRF}")
  [[ -n "${body}" ]] && args+=(-H 'content-type: application/json' --data "${body}")
  local status
  status="$(curl "${args[@]}" "${BASE}${path}")"
  [[ "${status}" == 2* ]] || fail "${method} ${path} answered ${status}: $(cat "${WORK}/body")"
  cat "${WORK}/body"
}
expect_json() { jq -e "$2" >/dev/null <<<"$1" || fail "$3 (got: $1)"; }
# check URI: POST /api/connections/check with a pasted connection string.
check() { api POST /api/connections/check "$(jq -n --arg uri "$1" '{uri: $uri}')"; }

# ---------------------------------------------------------------------------
# Certificates: a throwaway CA and a server certificate for mongo-tls.example.test
# ---------------------------------------------------------------------------

log "Creating a CA and a server certificate"
mkdir -p "${WORK}/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=MongoShield smoke test CA" \
  -keyout "${WORK}/certs/ca.key" -out "${WORK}/certs/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=mongo-tls.example.test" \
  -keyout "${WORK}/certs/server.key" -out "${WORK}/certs/server.csr" 2>/dev/null
# Clients check the name they connected to against the subjectAltName.
printf 'subjectAltName=DNS:mongo-tls.example.test,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' \
  >"${WORK}/certs/server.ext"
openssl x509 -req -in "${WORK}/certs/server.csr" -CA "${WORK}/certs/ca.pem" -CAkey "${WORK}/certs/ca.key" \
  -CAcreateserial -days 2 -extfile "${WORK}/certs/server.ext" -out "${WORK}/certs/server.crt" 2>/dev/null
# mongod wants certificate and key in one PEM file.
cat "${WORK}/certs/server.crt" "${WORK}/certs/server.key" >"${WORK}/certs/server.pem"
# Test-only keys: readable by the containers' users (mongod's and the console's 65532).
chmod 755 "${WORK}/certs" && chmod 644 "${WORK}/certs"/*

# ---------------------------------------------------------------------------
# DNS: the zone an Atlas project would have
# ---------------------------------------------------------------------------

log "Starting CoreDNS with SRV and TXT records for cluster0.example.test"
mkdir -p "${WORK}/dns"
cat >"${WORK}/dns/Corefile" <<'EOF'
example.test:53 {
  file /etc/coredns/example.test.db
  log
  errors
}
EOF
cat >"${WORK}/dns/example.test.db" <<EOF
\$ORIGIN example.test.
@                       3600 IN SOA ns.example.test. admin.example.test. 1 7200 3600 1209600 60
@                       3600 IN NS  ns.example.test.
ns                      60   IN A   ${DNS_IP}
mongo-tls               60   IN A   ${MONGO_IP}
; The seed list: the driver requires the targets to share the parent domain (example.test).
_mongodb._tcp.cluster0  60   IN SRV 0 0 27017 mongo-tls.example.test.
; Options the driver adds to the connection string (only these two are allowed in TXT).
cluster0                60   IN TXT "replicaSet=rs0&authSource=admin"
EOF
chmod 755 "${WORK}/dns" && chmod 644 "${WORK}/dns"/*
docker network create --subnet "${SUBNET_PREFIX}.0/24" "${NETWORK}" >/dev/null
docker run -d --name "${DNS}" --network "${NETWORK}" --ip "${DNS_IP}" \
  -v "${WORK}/dns:/etc/coredns:ro" "${COREDNS_IMAGE}" -conf /etc/coredns/Corefile >/dev/null

# ---------------------------------------------------------------------------
# mongod with TLS required, a replica set and access control
# ---------------------------------------------------------------------------

log "Starting mongod 8 with requireTLS, replica set rs0 and a user in admin"
# A replica set with access control needs a key file for its members (one member here);
# it is generated inside the container with the strict mode mongod insists on.
docker run -d --name "${MONGO}" --network "${NETWORK}" --ip "${MONGO_IP}" \
  --hostname mongo-tls.example.test -v "${WORK}/certs:/certs:ro" --entrypoint bash mongo:8.0 -c '
    head -c 756 /dev/urandom | base64 > /tmp/keyfile && chmod 400 /tmp/keyfile
    exec mongod --replSet rs0 --bind_ip_all --keyFile /tmp/keyfile \
      --tlsMode requireTLS --tlsCertificateKeyFile /certs/server.pem \
      --tlsCAFile /certs/ca.pem --tlsAllowConnectionsWithoutCertificates' >/dev/null
# Over localhost, with no user yet, mongod's localhost exception lets us initiate the set
# and create the first user.
LOCAL_URI="mongodb://localhost:27017/?tls=true&tlsCAFile=/certs/ca.pem&directConnection=true"
for _ in $(seq 1 60); do
  docker exec "${MONGO}" mongosh --quiet "${LOCAL_URI}" --eval 'db.adminCommand({ ping: 1 }).ok' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${MONGO}" mongosh --quiet "${LOCAL_URI}" --eval \
  "rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo-tls.example.test:27017' }] })" >/dev/null
for _ in $(seq 1 60); do
  [[ "$(docker exec "${MONGO}" mongosh --quiet "${LOCAL_URI}" --eval 'db.hello().isWritablePrimary' 2>/dev/null)" == "true" ]] && break
  sleep 1
done
docker exec "${MONGO}" mongosh --quiet "${LOCAL_URI}" --eval \
  "db.getSiblingDB('admin').createUser({ user: '${DB_USER}', pwd: '${DB_PASSWORD}', roles: ['root'] })" >/dev/null
AUTH_URI="mongodb://${DB_USER}:$(jq -rn --arg p "${DB_PASSWORD}" '$p | @uri')@localhost:27017/?tls=true&tlsCAFile=/certs/ca.pem&directConnection=true&authSource=admin"
docker exec "${MONGO}" mongosh --quiet "${AUTH_URI}" --eval \
  "db.getSiblingDB('shop').orders.insertMany([{ _id: 1 }, { _id: 2 }, { _id: 3 }]).insertedIds.length" >/dev/null

# ---------------------------------------------------------------------------
# The console, resolving through CoreDNS, with the CA mounted
# ---------------------------------------------------------------------------

log "Starting ${IMAGE} with --dns ${DNS_IP} and the CA at /certs/ca.pem"
docker run -d --name "${CONSOLE}" --network "${NETWORK}" --ip "${CONSOLE_IP}" --dns "${DNS_IP}" \
  -p "127.0.0.1:${PORT}:8080" -v "${VOLUME}:/data" -v "${WORK}/certs/ca.pem:/certs/ca.pem:ro" \
  "${IMAGE}" >/dev/null
for _ in $(seq 1 60); do curl -fsS "${BASE}/healthz" >/dev/null 2>&1 && break; sleep 1; done
api POST /api/setup "$(jq -n --arg p "${ADMIN_PASSWORD}" '{username: "admin", password: $p}')" >/dev/null
COOKIE="$(grep -i '^set-cookie:' "${WORK}/headers" | head -1 | sed -E 's/^[Ss]et-[Cc]ookie: *([^;]+).*/\1/' | tr -d '\r')"
CSRF="$(jq -r .csrfToken "${WORK}/body")"

# The password pasted raw, as people copy it: the console encodes it. The path names the
# database `shop`, which would also be the authSource by default; the user exists only in
# `admin`, so connecting proves the TXT record's authSource=admin was applied.
SRV_URI="mongodb+srv://${DB_USER}:${DB_PASSWORD}@cluster0.example.test/shop?tlsCAFile=/certs/ca.pem"

log "1-2. SRV + TXT + TLS with the mounted CA (raw password with @ : /)"
RESULT="$(check "${SRV_URI}")"
expect_json "${RESULT}" '.ok == true and .topology == "replicaSet"' \
  "the SRV connection string should connect to the replica set"
# The name comes from the cluster's DNS name. (`.test` is a reserved testing domain, so the
# console proposes "not production" here; for Atlas and other real domains it proposes production.)
expect_json "${RESULT}" '.suggestedName == "cluster0"' "the name should come from the SRV host"
printf '    ok: %s\n' "$(jq -c '{ok, topology, serverVersion, suggestedName}' <<<"${RESULT}")"

log "3. Without tlsCAFile the certificate is not trusted: a TLS problem"
RESULT="$(check "mongodb+srv://${DB_USER}:${DB_PASSWORD}@cluster0.example.test/?serverSelectionTimeoutMS=5000")"
expect_json "${RESULT}" '.ok == false and .problem.kind == "tls"' "a TLS failure should be explained as such"
printf '    problem: %s\n' "$(jq -c '{kind: .problem.kind, detail: .problem.detail}' <<<"${RESULT}")"

log "4. A typo in the cluster name: a DNS problem"
RESULT="$(check "mongodb+srv://${DB_USER}:${DB_PASSWORD}@clusterO.example.test/")"
expect_json "${RESULT}" '.ok == false and .problem.kind == "dns-not-found"' "a missing SRV record should be a DNS problem"

log "5. Back up now over SRV + TLS"
CONNECTION_ID="$(api POST /api/connections "$(jq -n --arg uri "${SRV_URI}" '{name: "cluster0", uri: $uri, production: true}')" | jq -r .id)"
JOB_ID="$(api POST /api/quick-backup "$(jq -n --arg id "${CONNECTION_ID}" '{connectionId: $id, include: ["shop.*"]}')" | jq -r .job.id)"
for _ in $(seq 1 120); do
  STATUS="$(api GET "/api/jobs/${JOB_ID}" | jq -r .status)"
  [[ "${STATUS}" == succeeded ]] && break
  [[ "${STATUS}" == failed || "${STATUS}" == cancelled ]] && fail "backup over SRV/TLS ${STATUS}: $(cat "${WORK}/body")"
  sleep 1
done
[[ "${STATUS}" == succeeded ]] || fail "the backup did not finish in time"

log "PASS: SRV + TXT + TLS from the console image (${IMAGE})"
