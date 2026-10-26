#!/usr/bin/env bash
# Container smoke test (spec §9.4). Builds the linux/amd64 image, runs it with the
# evaluator's runtime flags, and checks health, the brief example, persistence across
# stop/start, non-root + read-only filesystem, and running with no network.
#
# Requires docker (with buildx), curl and node on the host.
#
#   scripts/container-smoke.sh
#   SKIP_BUILD=1 IMAGE=inventory-service:local scripts/container-smoke.sh
#
# The evaluator's command uses the volume name "inventory-data". This script uses a
# throwaway volume instead (override with VOLUME=...) so it never touches real data.
set -euo pipefail

IMAGE="${IMAGE:-inventory-service:local}"
HOST_PORT="${HOST_PORT:-8080}"
RUN_ID="$$"
CONTAINER="inventory-smoke-$RUN_ID"
OFFLINE_CONTAINER="inventory-smoke-offline-$RUN_ID"
VOLUME="${VOLUME:-inventory-smoke-$RUN_ID}"
OFFLINE_VOLUME="inventory-smoke-offline-$RUN_ID"
BASE_URL="http://localhost:$HOST_PORT"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The evaluator's flags, minus the volume and port mapping (added per container below).
RUNTIME_FLAGS=(--platform linux/amd64 --read-only --tmpfs /tmp --cap-drop ALL --memory 512m --cpus 1)

pass() { echo "ok - $*"; }
fail() {
  echo "FAIL - $*" >&2
  echo "--- last container logs ($CONTAINER) ---" >&2
  docker logs --tail 50 "$CONTAINER" >&2 2>&1 || echo "(no logs: container $CONTAINER not found)" >&2
  exit 1
}

cleanup() {
  docker rm -f "$CONTAINER" "$OFFLINE_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" "$OFFLINE_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for tool in docker curl node; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required on the host"
done

# Reads JSON from stdin and evaluates a JS expression against it as `body`; fails if falsy.
assert_json() {
  local description="$1" expression="$2"
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
      const body = JSON.parse(input);
      const isOk = new Function("body", `return (${process.argv[1]});`)(body);
      if (!isOk) { console.error(JSON.stringify(body, null, 2)); process.exit(1); }
    });
  ' "$expression" || fail "$description"
  pass "$description"
}

get_json() {
  curl -fsS "$BASE_URL$1"
}

wait_for_health_endpoint() {
  local container="$1"
  for _ in $(seq 1 60); do
    if docker exec "$container" node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "$container: /healthz did not return 200 within 60 s"
}

wait_for_docker_healthy() {
  local container="$1" status=""
  for _ in $(seq 1 90); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)"
    [[ "$status" == "healthy" ]] && return 0
    sleep 1
  done
  fail "$container: Docker health status is '$status' after 90 s, expected 'healthy'"
}

# 1. Build for linux/amd64 and check the architecture.
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  docker buildx build --platform linux/amd64 --load -t "$IMAGE" "$REPO_ROOT" || fail "image build failed"
fi
architecture="$(docker image inspect -f '{{.Architecture}}' "$IMAGE" 2>/dev/null)" || fail "image $IMAGE not found"
[[ "$architecture" == "amd64" ]] || fail "image architecture is '$architecture', expected amd64"
pass "image $IMAGE is linux/amd64"

# 2. Run with the evaluator's flags and wait for health.
docker run -d --name "$CONTAINER" "${RUNTIME_FLAGS[@]}" -v "$VOLUME:/data" -p "$HOST_PORT:8080" "$IMAGE" >/dev/null \
  || fail "docker run failed"
wait_for_health_endpoint "$CONTAINER"
curl -fsS "$BASE_URL/healthz" | assert_json "GET /healthz from the host returns ok" 'body.status === "ok"'
wait_for_docker_healthy "$CONTAINER"
pass "Docker HEALTHCHECK reports healthy"

# 3. Replay the brief example and check the result.
BASE_URL="$BASE_URL" "$REPO_ROOT/scripts/replay-example.sh" >/dev/null || fail "replay-example.sh failed"
pass "replay-example.sh ran against the container"

get_json /v1/dealerships/LHS-1042/vehicles | assert_json "active inventory is Civic, Pilot, CR-V (VIN order)" \
  'body.count === 3 && body.vehicles.map((v) => v.vin).join() === "2HGFE1F71NH304352,5FNYG1H78RB033333,5J6RS4H84TL012345"'
get_json /v1/dealerships/LHS-1042/vehicles/2HGFE1F71NH304352 | assert_json "Civic has the March 16 price and mileage" \
  'body.price === 17995 && body.mileage === 41910 && body.status === "active"'
get_json /v1/dealerships/LHS-1042/vehicles/1HGCY1F39TA098765 | assert_json "Accord is removed on 2026-03-16 with daysInInventory 6" \
  'body.status === "removed" && body.removedOn === "2026-03-16" && body.daysInInventory === 6'

replay_status="$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  --data-binary "@$REPO_ROOT/examples/2026-03-16.json" "$BASE_URL/v1/feeds")"
[[ "$replay_status" == "200" ]] || fail "re-posting the March 16 feed returned $replay_status, expected 200 (replay)"
pass "re-posting the March 16 feed is a 200 replay"

inventory_snapshot() {
  printf '%s\n%s\n%s\n' \
    "$(get_json /v1/dealerships)" \
    "$(get_json /v1/dealerships/LHS-1042/vehicles)" \
    "$(get_json '/v1/dealerships/LHS-1042/vehicles?status=removed')"
}
snapshot_before_restart="$(inventory_snapshot)"

# 4. Stop must be a clean SIGTERM shutdown well inside Docker's 10 s kill timeout.
stop_started_at=$SECONDS
docker stop "$CONTAINER" >/dev/null || fail "docker stop failed"
stop_seconds=$((SECONDS - stop_started_at))
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER")"
[[ "$exit_code" == "0" ]] || fail "container exited with $exit_code after docker stop, expected 0"
((stop_seconds < 8)) || fail "docker stop took ${stop_seconds}s; SIGTERM was probably not handled"
pass "docker stop exits 0 in ${stop_seconds}s"

docker start "$CONTAINER" >/dev/null || fail "docker start failed"
wait_for_health_endpoint "$CONTAINER"
[[ "$(inventory_snapshot)" == "$snapshot_before_restart" ]] || fail "inventory changed across stop/start"
pass "inventory is unchanged after stop/start on the same volume"

# 5. Non-root, and only /data and /tmp are writable.
uid="$(docker exec "$CONTAINER" id -u)"
[[ "$uid" != "0" ]] || fail "container runs as root"
pass "container runs as uid $uid"
docker exec "$CONTAINER" sh -c 'touch /data/.write-probe && rm /data/.write-probe' || fail "/data is not writable"
docker exec "$CONTAINER" sh -c 'touch /tmp/.write-probe && rm /tmp/.write-probe' || fail "/tmp is not writable"
if docker exec "$CONTAINER" sh -c 'touch /app/.write-probe' 2>/dev/null; then
  fail "/app is writable; the root filesystem should be read-only"
fi
pass "/data and /tmp are writable; /app is not"

# 6. No outbound dependency: starts and serves with --network none.
docker run -d --name "$OFFLINE_CONTAINER" "${RUNTIME_FLAGS[@]}" --network none -v "$OFFLINE_VOLUME:/data" "$IMAGE" >/dev/null \
  || fail "docker run --network none failed"
wait_for_health_endpoint "$OFFLINE_CONTAINER"
pass "service starts and is healthy with --network none"

echo "All container smoke checks passed."
