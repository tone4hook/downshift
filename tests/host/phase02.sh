#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
cd "$root"

project=$(docker compose config | sed -n 's/^name: //p' | head -1)
if [ -z "$project" ]; then
  project=$(basename "$root" | tr '[:upper:]_' '[:lower:]-')
fi
auth_volume="${project}_phase02-test-auth-$$"
readonly_volume="${project}_phase02-test-readonly-$$"
cancel_volume="${project}_phase02-test-cancel-$$"
corrupt_volume="${project}_phase02-test-corrupt-$$"
hold_container="${project}-phase02-signal-$$"
conflict_container="${project}-phase02-port-$$"
delayed_container="${project}-phase02-delay-$$"
port=$((20000 + ($$ % 20000)))

cleanup() {
  docker rm -f "$hold_container" "$conflict_container" "$delayed_container" >/dev/null 2>&1 || true
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$auth_volume" "$readonly_volume" "$cancel_volume" "$corrupt_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

services=$(docker compose config --services)
test "$(printf '%s\n' "$services" | wc -l | tr -d ' ')" = "4"
for service in dev agent evaluator mock; do
  printf '%s\n' "$services" | grep -q "^${service}$"
done
! printf '%s\n' "$services" | grep -q router

agent_image="${project}-agent"
evaluator_image="${project}-evaluator"
mock_image="${project}-mock"
docker image inspect "$agent_image" "$evaluator_image" "$mock_image" >/dev/null

docker image inspect "$agent_image" --format '{{json .Config.ExposedPorts}}' | grep -q '^null$'
docker image inspect "$evaluator_image" --format '{{json .Config.ExposedPorts}}' | grep -q '^null$'
docker image inspect "$mock_image" --format '{{json .Config.ExposedPorts}}' | grep -q '^null$'

docker run --rm --entrypoint sh "$agent_image" -c '
  command -v pi >/dev/null
  command -v pnpm >/dev/null
  command -v npm >/dev/null
  command -v git >/dev/null
  command -v bash >/dev/null
  command -v rg >/dev/null
  command -v tini >/dev/null
  test -x /usr/local/bin/switchyard-bridge
  test ! -e /app/tests
  test ! -e /app/specs
  test ! -e /app/.git
  test ! -e /app/dist/mock
'
docker run --rm --entrypoint sh "$evaluator_image" -c '
  test ! -e /app
  test ! -e /pi-profile/auth.json
  test ! -e /workspace
'
docker compose run --rm dev sh -c 'test ! -e /pi-profile'
docker compose run --rm --entrypoint sh evaluator -c 'test ! -e /pi-profile'
docker compose run --rm --entrypoint sh mock -c 'test ! -e /pi-profile'
! docker history --no-trunc "$agent_image" | grep -E -q 'access_token|refresh_token|authorization:'

agent_output=$(docker compose run --rm agent)
printf '%s\n' "$agent_output" | grep -q '"ready":true'
printf '%s\n' "$agent_output" | grep -q '"uid":10001'
printf '%s\n' "$agent_output" | grep -q '"bridgeProtocolVersion":1'

uid_output=$(LAB_UID=12345 LAB_GID=12346 docker compose run --rm agent)
printf '%s\n' "$uid_output" | grep -q '"uid":12345'
printf '%s\n' "$uid_output" | grep -q '"gid":12346'

if docker run --rm --read-only --tmpfs /tmp \
  -e LAB_CONTAINER_ROLE=agent \
  -e LAB_AUTH_PROFILE=default \
  -e LAB_UID=10001 \
  -e LAB_GID=10001 \
  "$agent_image" >/tmp/phase02-absent-state.out 2>&1; then
  printf 'agent unexpectedly started without writable project/profile volumes\n' >&2
  exit 1
fi
grep -q 'required writable state directory\|Read-only file system' /tmp/phase02-absent-state.out
rm -f /tmp/phase02-absent-state.out

docker volume create "$corrupt_volume" >/dev/null
docker run --rm --entrypoint sh -v "$corrupt_volume:/pi-profile" "$agent_image" \
  -c 'printf "{not-json\n" >/pi-profile/auth.json'
if docker run --rm --read-only --tmpfs /tmp \
  -e LAB_CONTAINER_ROLE=agent \
  -e LAB_AUTH_PROFILE=default \
  -e LAB_UID=10001 \
  -e LAB_GID=10001 \
  -v "$corrupt_volume:/pi-profile" \
  -v "${project}_phase02-project-state:/project-state" \
  -v "${project}_phase02-project-dependencies:/workspace/node_modules" \
  "$agent_image" >/tmp/phase02-corrupt.out 2>&1; then
  printf 'agent unexpectedly started with a corrupt Pi profile\n' >&2
  exit 1
fi
grep -q 'Pi credential store is corrupt' /tmp/phase02-corrupt.out
rm -f /tmp/phase02-corrupt.out

docker compose up --detach --wait mock
docker volume create "$auth_volume" >/dev/null
docker compose run --rm \
  -e MOCK_BASE_URL=http://mock:8080 \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$auth_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts login | grep -q login-persisted
docker compose run --rm \
  -e MOCK_BASE_URL=http://mock:8080 \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$auth_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts check | grep -q login-present

docker compose run --rm \
  -e MOCK_BASE_URL=http://mock:8080 \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$auth_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts refresh >"/tmp/phase02-refresh-a-$$.out" &
pid_a=$!
docker compose run --rm \
  -e MOCK_BASE_URL=http://mock:8080 \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$auth_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts refresh >"/tmp/phase02-refresh-b-$$.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
grep -q refresh-complete "/tmp/phase02-refresh-a-$$.out"
grep -q refresh-complete "/tmp/phase02-refresh-b-$$.out"
rm -f "/tmp/phase02-refresh-a-$$.out" "/tmp/phase02-refresh-b-$$.out"
refresh_count=$(docker compose exec -T mock node -e "fetch('http://127.0.0.1:8080/admin/state').then(r=>r.json()).then(s=>process.stdout.write(String(s.refreshCount)))")
test "$refresh_count" = "1"

docker volume create "$readonly_volume" >/dev/null
docker compose run --rm \
  -e MOCK_BASE_URL=http://mock:8080 \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$readonly_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts login | grep -q login-persisted
if docker compose run --rm \
  -e MOCK_BASE_URL=http://mock:8080 \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$readonly_volume:/pi-profile:ro" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts refresh >/tmp/phase02-readonly.out 2>&1; then
  printf 'refresh unexpectedly succeeded with a read-only auth profile\n' >&2
  exit 1
fi
grep -E -q 'read-only|EROFS|permission|EACCES' /tmp/phase02-readonly.out
rm -f /tmp/phase02-readonly.out

docker volume create "$cancel_volume" >/dev/null
docker run --detach --name "$delayed_container" \
  --network "${project}_default" \
  -e MOCK_REFRESH_DELAY_MS=5000 \
  "$mock_image" >/dev/null
attempt=0
until docker exec "$delayed_container" node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 30
  sleep 1
done
docker compose run --rm \
  -e MOCK_BASE_URL="http://${delayed_container}:8080" \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$cancel_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts login | grep -q login-persisted
if docker compose run --rm \
  -e MOCK_BASE_URL="http://${delayed_container}:8080" \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$cancel_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts cancel-refresh >/tmp/phase02-cancel.out 2>&1; then
  printf 'cancelled OAuth refresh unexpectedly succeeded\n' >&2
  exit 1
fi
grep -E -q 'AbortError|aborted|cancel' /tmp/phase02-cancel.out
rm -f /tmp/phase02-cancel.out

docker compose run --rm \
  -e MOCK_BASE_URL="http://${delayed_container}:8080" \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$cancel_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts login | grep -q login-persisted
docker compose run --rm \
  -e MOCK_BASE_URL="http://${delayed_container}:8080" \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$cancel_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts refresh >"/tmp/phase02-refresh-logout-$$.out" &
refresh_logout_pid=$!
attempt=0
until [ "$(docker exec "$delayed_container" node -e \
  "fetch('http://127.0.0.1:8080/admin/state').then(r=>r.json()).then(s=>process.stdout.write(String(s.refreshCount)))")" -ge 2 ]; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 30
  sleep 1
done
docker compose run --rm \
  -e MOCK_BASE_URL="http://${delayed_container}:8080" \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$cancel_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts logout | grep -q logout-complete
wait "$refresh_logout_pid"
grep -q refresh-complete "/tmp/phase02-refresh-logout-$$.out"
rm -f "/tmp/phase02-refresh-logout-$$.out"
docker compose run --rm \
  -e MOCK_BASE_URL="http://${delayed_container}:8080" \
  -e PI_AUTH_PATH=/pi-profile/auth.json \
  -v "$cancel_volume:/pi-profile" \
  dev pnpm exec tsx tests/phase02/auth-probe.ts check-absent | grep -q login-absent
docker rm -f "$delayed_container" >/dev/null

docker run --detach --name "$hold_container" \
  --read-only --tmpfs /tmp \
  -e LAB_AUTH_PROFILE=default \
  -v "${project}_phase02-auth-profile:/pi-profile" \
  -v "${project}_phase02-project-state:/project-state" \
  -v "${project}_phase02-project-dependencies:/workspace/node_modules" \
  "$agent_image" node /app/dist/container/agent.js --bridge-hold >/dev/null
attempt=0
until docker logs "$hold_container" 2>&1 | grep -q bridge-ready; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 30
  sleep 1
done
docker top "$hold_container" -eo user,pid,comm | grep -E -q '^10001[[:space:]].*switchyard-brid'
docker stop --time 5 "$hold_container" >/dev/null
test "$(docker inspect "$hold_container" --format '{{.State.ExitCode}}')" = "143"
docker rm "$hold_container" >/dev/null

docker run --detach --name "$conflict_container" -p "127.0.0.1:${port}:8080" "$mock_image" >/dev/null
if docker run --rm -p "127.0.0.1:${port}:8080" "$mock_image" >/tmp/phase02-port-conflict.out 2>&1; then
  printf 'second callback-style loopback port binding unexpectedly succeeded\n' >&2
  exit 1
fi
grep -E -q 'address already in use|port is already allocated|Bind for' /tmp/phase02-port-conflict.out
rm -f /tmp/phase02-port-conflict.out

config=$(docker compose config)
printf '%s\n' "$config" | grep -q 'network_mode: none'
! printf '%s\n' "$config" | grep -q '/var/run/docker.sock'
! printf '%s\n' "$config" | grep -q '/root/.pi'
! printf '%s\n' "$config" | grep -q 'published:'

printf 'phase02 host container checks passed on %s/%s\n' "$(uname -s)" "$(uname -m)"
