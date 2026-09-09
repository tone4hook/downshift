#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
launcher="$root/route-agent"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/routing-lab-phase03.XXXXXX")
project_one="$temporary/project one"
project_two="$temporary/project;two"
project_bad="$temporary/project-bad"
alias_one="$temporary/project-alias"
sentinel="$temporary/prompt-was-evaluated"
profile="phase03-$$"
compose_project=$(docker compose --project-directory "$root" -f "$root/compose.yaml" config |
  sed -n 's/^name: //p' | sed -n '1p')
agent_image="${compose_project}-agent"
created_volumes=
first_pid=
signal_pid=

cleanup() {
  cleanup_status=$?
  for pid in "$first_pid" "$signal_pid"; do
    [ -z "$pid" ] || kill -TERM "$pid" >/dev/null 2>&1 || true
    [ -z "$pid" ] || wait "$pid" >/dev/null 2>&1 || true
  done
  for volume in $created_volumes; do
    docker volume rm "$volume" >/dev/null 2>&1 || true
  done
  if [ "$cleanup_status" -eq 0 ]; then rm -rf "$temporary"
  else printf 'phase03 evidence retained at %s\n' "$temporary" >&2; fi
}
trap cleanup EXIT HUP INT TERM

make_project() {
  directory=$1
  name=$2
  mkdir -p "$directory"
  printf '{"name":"%s","version":"1.0.0"}\n' "$name" >"$directory/package.json"
  printf '{"name":"%s","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"%s","version":"1.0.0"}}}\n' \
    "$name" "$name" >"$directory/package-lock.json"
  printf 'export const preserved = true;\n' >"$directory/preserved.ts"
}

make_project "$project_one" phase03-one
make_project "$project_two" phase03-two
make_project "$project_bad" phase03-bad
ln -s "$project_one" "$alias_one"
project_id_for() {
  canonical=$(CDPATH= cd -- "$1" && pwd -P)
  docker run --rm --entrypoint node "$agent_image" \
    /app/dist/launcher/container-cli.js identify "$canonical" |
    sed -n 's/^project-id:\([0-9a-f]*\)$/\1/p'
}
project_one_id=$(project_id_for "$project_one")
project_two_id=$(project_id_for "$project_two")
project_bad_id=$(project_id_for "$project_bad")
state_one="${compose_project}-project-${project_one_id}-state"
state_two="${compose_project}-project-${project_two_id}-state"
deps_one="${compose_project}-project-${project_one_id}-dependencies"
deps_two="${compose_project}-project-${project_two_id}-dependencies"
deps_bad="${compose_project}-project-${project_bad_id}-dependencies"
cache_one="${compose_project}-project-${project_one_id}-cache"
cache_two="${compose_project}-project-${project_two_id}-cache"
cache_bad="${compose_project}-project-${project_bad_id}-cache"
auth_volume="${compose_project}-test-auth-${profile}"
auth_state="${compose_project}-auth-setup-${profile}"
created_volumes="$state_one $state_two $deps_one $deps_two $deps_bad $cache_one $cache_two $cache_bad $auth_volume $auth_state"
before_uid=$(if stat -f '%u' "$project_one/preserved.ts" >/dev/null 2>&1; then
  stat -f '%u' "$project_one/preserved.ts"
else
  stat -c '%u' "$project_one/preserved.ts"
fi)

mkdir "$temporary/bin"
cat >"$temporary/bin/node" <<'EOF'
#!/bin/sh
printf 'host node must not be used\n' >&2
exit 99
EOF
chmod +x "$temporary/bin/node"
(cd "$temporary" && PATH="$temporary/bin:$PATH" "$launcher" dev -- sh -c 'printf phase03-dev-ok') |
  grep -q phase03-dev-ok

if "$launcher" run --project "$temporary/missing" --config "$root/config/lab.mock.json" \
  --mode weak-only prompt >"$temporary/missing.out" 2>&1; then
  printf 'nonexistent project unexpectedly launched\n' >&2
  exit 1
fi
grep -q 'project directory does not exist' "$temporary/missing.out"

colon_project="$temporary/project:colon"
make_project "$colon_project" phase03-colon
if "$launcher" run --project "$colon_project" --config "$root/config/lab.mock.json" \
  --mode weak-only prompt >"$temporary/colon.out" 2>&1; then
  printf 'colon-containing project unexpectedly launched\n' >&2
  exit 1
fi
grep -q "unsupported mount delimiter" "$temporary/colon.out"

rm "$project_bad/package-lock.json"
if LAB_PHASE03_TEST=1 "$launcher" run --project "$project_bad" \
  --config "$root/config/lab.mock.json" --mode weak-only prompt >"$temporary/no-lock.out" 2>&1; then
  printf 'project without a lockfile unexpectedly launched\n' >&2
  exit 1
fi
grep -q 'exactly one supported root lockfile' "$temporary/no-lock.out"

make_project "$project_bad" phase03-bad
printf '{"name":"different","version":"1.0.0","dependencies":{"missing":"1.0.0"}}\n' \
  >"$project_bad/package.json"
lock_hash_before=$(git hash-object "$project_bad/package-lock.json")
if LAB_PHASE03_TEST=1 "$launcher" run --project "$project_bad" \
  --config "$root/config/lab.mock.json" --mode weak-only prompt >"$temporary/install-failure.out" 2>&1; then
  printf 'invalid frozen install unexpectedly succeeded\n' >&2
  exit 1
fi
grep -q 'project dependency setup failed' "$temporary/install-failure.out"
test "$(git hash-object "$project_bad/package-lock.json")" = "$lock_hash_before"

prompt='-Perform the mock edit task; touch '"$sentinel"' $(touch '"$sentinel"')'
LAB_PHASE03_TEST=1 LAB_PHASE03_PERSIST_MOCK_PROFILE=1 \
  "$launcher" auth --auth-profile "$profile" >"$temporary/auth.out"
grep -q '"mockAuth":"created"' "$temporary/auth.out"

LAB_PHASE03_TEST=1 LAB_PHASE03_PERSIST_MOCK_PROFILE=1 LAB_PHASE03_TEST_HOLD_SECONDS=8 \
  "$launcher" run --project "$project_one" --config "$root/config/lab.mock.json" \
  --auth-profile "$profile" --mode weak-only -- "$prompt" >"$temporary/first.out" 2>&1 &
first_pid=$!
attempt=0
until grep -q '"sessionId":' "$temporary/first.out" 2>/dev/null; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 60
  sleep 1
done
test "$(sed -n 's/^route-agent: project \([0-9a-f]*\) invocation .*/\1/p' "$temporary/first.out")" = \
  "$project_one_id"

if LAB_PHASE03_TEST=1 LAB_PHASE03_PERSIST_MOCK_PROFILE=1 \
  "$launcher" run --project "$alias_one" --config "$root/config/lab.mock.json" \
  --auth-profile "$profile" --mode weak-only prompt >"$temporary/conflict.out" 2>&1; then
  printf 'same canonical project unexpectedly acquired a second writer lock\n' >&2
  exit 1
fi
grep -q 'project is already open' "$temporary/conflict.out"

LAB_PHASE03_TEST=1 LAB_PHASE03_PERSIST_MOCK_PROFILE=1 \
  "$launcher" run --project "$project_two" --config "$root/config/lab.mock.json" \
  --auth-profile "$profile" --mode weak-only prompt >"$temporary/second.out" 2>&1
grep -q '"mockAuth":"reused"' "$temporary/second.out"
test -f "$project_two/mock-edit.txt"
test "$(sed -n 's/^route-agent: project \([0-9a-f]*\) invocation .*/\1/p' "$temporary/second.out")" = \
  "$project_two_id"
test "$project_one_id" != "$project_two_id"

wait "$first_pid"
first_pid=
test -f "$project_one/mock-edit.txt"
test ! -e "$sentinel"
test ! -e "$project_one/.pi"
test ! -e "$project_one/.route-agent"
for project_node_modules in "$project_one/node_modules" "$project_two/node_modules"; do
  if [ -d "$project_node_modules" ]; then
    test -z "$(find "$project_node_modules" -mindepth 1 -maxdepth 1 -print -quit)"
  fi
done
test "$(cat "$project_one/preserved.ts")" = 'export const preserved = true;'
after_uid=$(if stat -f '%u' "$project_one/preserved.ts" >/dev/null 2>&1; then
  stat -f '%u' "$project_one/preserved.ts"
else
  stat -c '%u' "$project_one/preserved.ts"
fi)
test "$before_uid" = "$after_uid"

docker run --rm --entrypoint sh -v "$state_one:/state:ro" "$agent_image" \
  -c 'find /state/sessions -type f | grep -q .'
docker run --rm --entrypoint sh -v "$state_two:/state:ro" "$agent_image" \
  -c 'find /state/sessions -type f | grep -q .'
session_one=$(sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p' "$temporary/first.out" | sed -n '1p')
session_two=$(sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p' "$temporary/second.out" | sed -n '1p')
test -n "$session_one"
test -n "$session_two"
docker run --rm --entrypoint sh -v "$state_one:/state:ro" "$agent_image" \
  -c "! grep -R '$session_two' /state >/dev/null 2>&1"
docker run --rm --entrypoint sh -v "$state_two:/state:ro" "$agent_image" \
  -c "! grep -R '$session_one' /state >/dev/null 2>&1"

lock_root="${TMPDIR:-/tmp}/route-agent-locks-$(id -u)"
stale_lock="$lock_root/$project_one_id"
mkdir -p "$stale_lock"
printf 'stale-invocation\n' >"$stale_lock/invocation"
printf 'missing-container\n' >"$stale_lock/container"
LAB_PHASE03_TEST=1 "$launcher" run --project "$project_one" \
  --config "$root/config/lab.mock.json" --mode weak-only prompt >"$temporary/stale.out" 2>&1
test -f "$project_one/mock-edit.txt"

LAB_PHASE03_TEST=1 LAB_PHASE03_TEST_HOLD_SECONDS=30 \
  "$launcher" run --project "$project_one" --config "$root/config/lab.mock.json" \
  --mode weak-only prompt >"$temporary/signal.out" 2>&1 &
signal_pid=$!
attempt=0
until grep -q '"sessionId":' "$temporary/signal.out" 2>/dev/null; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 60
  sleep 1
done
kill -TERM "$signal_pid"
set +e
wait "$signal_pid"
signal_status=$?
signal_pid=
set -e
test "$signal_status" = "130"
test ! -d "$lock_root/$project_one_id"

if LAB_PHASE03_TEST=1 LAB_PHASE03_BRIDGE=/missing/switchyard-bridge \
  "$launcher" run --project "$project_one" --config "$root/config/lab.mock.json" \
  --mode weak-only prompt >"$temporary/bridge.out" 2>&1; then
  printf 'missing bridge unexpectedly launched\n' >&2
  exit 1
fi
grep -E -q 'ENOENT|switchyard-bridge' "$temporary/bridge.out"

fake_path="$temporary/no-docker"
mkdir "$fake_path"
ln -s "$(command -v dirname)" "$fake_path/dirname"
if PATH="$fake_path" "$launcher" build >"$temporary/no-docker.out" 2>&1; then
  printf 'launcher unexpectedly ran without Docker\n' >&2
  exit 1
fi
grep -q 'Docker with Compose v2 is required' "$temporary/no-docker.out"
cat >"$fake_path/docker" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$fake_path/docker"
if PATH="$fake_path:/bin:/usr/bin" "$launcher" build >"$temporary/compose.out" 2>&1; then
  printf 'launcher unexpectedly ran without Compose v2\n' >&2
  exit 1
fi
grep -q 'Docker Compose v2 is required' "$temporary/compose.out"
cat >"$fake_path/docker" <<'EOF'
#!/bin/sh
if [ "${1:-}" = compose ] && [ "${2:-}" = version ]; then
  exit 0
fi
if [ "${1:-}" = info ]; then
  exit 1
fi
exit 1
EOF
chmod +x "$fake_path/docker"
if PATH="$fake_path:/bin:/usr/bin" "$launcher" build >"$temporary/daemon.out" 2>&1; then
  printf 'launcher unexpectedly accepted an unavailable daemon\n' >&2
  exit 1
fi
grep -q 'Docker daemon is unavailable' "$temporary/daemon.out"

if "$launcher" run --project "$project_one" --config "$root/config/lab.mock.json" \
  --mode weak-only prompt >"$temporary/non-tty.out" 2>&1; then
  printf 'non-interactive run unexpectedly opened Pi\n' >&2
  exit 1
fi
grep -q 'requires an interactive terminal' "$temporary/non-tty.out"

printf 'phase03 host launcher checks passed on %s/%s\n' "$(uname -s)" "$(uname -m)"
