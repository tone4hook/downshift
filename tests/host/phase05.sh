#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
launcher="$root/route-agent"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/routing-lab-phase05.XXXXXX")
project_one="$temporary/project one"
project_two="$temporary/project two"
profile="phase05-$$"
compose_project=$(docker compose --project-directory "$root" -f "$root/compose.yaml" config |
  sed -n 's/^name: //p' | sed -n '1p')
agent_image="${compose_project}-agent"
created_volumes=

cleanup() {
  for volume in $created_volumes; do
    docker volume rm "$volume" >/dev/null 2>&1 || true
  done
  rm -rf "$temporary"
}
trap cleanup EXIT HUP INT TERM

make_project() {
  directory=$1
  name=$2
  mkdir -p "$directory"
  printf '{"name":"%s","version":"1.0.0"}\n' "$name" >"$directory/package.json"
  printf '{"name":"%s","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"%s","version":"1.0.0"}}}\n' \
    "$name" "$name" >"$directory/package-lock.json"
}

project_id_for() {
  canonical=$(CDPATH= cd -- "$1" && pwd -P)
  docker run --rm --entrypoint node "$agent_image" \
    /app/dist/launcher/container-cli.js identify "$canonical" |
    sed -n 's/^project-id:\([0-9a-f]*\)$/\1/p'
}

run_mock() {
  LAB_PHASE05_TEST=1 LAB_PHASE05_PERSIST_MOCK_PROFILE=1 \
    "$launcher" run "$@"
}

make_project "$project_one" phase05-one
make_project "$project_two" phase05-two
project_one_id=$(project_id_for "$project_one")
project_two_id=$(project_id_for "$project_two")
state_one="${compose_project}-project-${project_one_id}-state"
state_two="${compose_project}-project-${project_two_id}-state"
deps_one="${compose_project}-project-${project_one_id}-dependencies"
deps_two="${compose_project}-project-${project_two_id}-dependencies"
cache_one="${compose_project}-project-${project_one_id}-cache"
cache_two="${compose_project}-project-${project_two_id}-cache"
auth_volume="${compose_project}-test-auth-${profile}"
created_volumes="$state_one $state_two $deps_one $deps_two $cache_one $cache_two $auth_volume"

run_mock --project "$project_one" --config "$root/config/lab.mock.json" \
  --auth-profile "$profile" --mode routed "Make the requested mock edit." >"$temporary/routed.out"
grep -q '"selectedTier":"weak"' "$temporary/routed.out"
grep -q '"source":"classifier"' "$temporary/routed.out"
grep -q '"weakSolveProbability":0.9' "$temporary/routed.out"
test "$(cat "$project_one/mock-edit.txt")" = "mock edit completed"
session_id=$(sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p' "$temporary/routed.out" | sed -n '1p')
decision_id=$(sed -n 's/.*"decisionId":"\([^"]*\)".*/\1/p' "$temporary/routed.out" | sed -n '1p')
test -n "$session_id"
test -n "$decision_id"

run_mock --project "$project_one" --config "$root/config/lab.mock.json" \
  --auth-profile "$profile" --mode routed --resume "$session_id" \
  "Continue the existing session." >"$temporary/resume.out"
grep -q "\"decisionId\":\"$decision_id\"" "$temporary/resume.out"
test "$(sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p' "$temporary/resume.out" | sed -n '1p')" = "$session_id"

run_mock --project "$project_two" --config "$root/config/lab.mock.json" \
  --auth-profile "$profile" --mode routed "Make the requested mock edit." >"$temporary/project-two.out"
second_session_id=$(sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p' "$temporary/project-two.out" | sed -n '1p')
second_decision_id=$(sed -n 's/.*"decisionId":"\([^"]*\)".*/\1/p' "$temporary/project-two.out" | sed -n '1p')
test -n "$second_session_id"
test -n "$second_decision_id"
test "$second_session_id" != "$session_id"
test "$second_decision_id" != "$decision_id"

run_mock --project "$project_two" --config "$root/config/lab.mock.json" \
  --auth-profile "$profile" --mode strong-only "Use the fixed strong model." >"$temporary/strong.out"
grep -q '"selectedTier":"strong"' "$temporary/strong.out"
grep -q '"source":"fixed-baseline"' "$temporary/strong.out"
grep -q '"classifier":null' "$temporary/strong.out"

if run_mock --project "$project_one" --config "$root/config/lab.mock.json" \
  --auth-profile "$profile" --mode invalid "Reject this mode." >"$temporary/invalid-mode.out" 2>&1; then
  printf 'invalid mode unexpectedly launched\n' >&2
  exit 1
fi
grep -q 'mode must be weak-only, strong-only, or routed' "$temporary/invalid-mode.out"

if run_mock --project "$project_one" --config "$root/config/lab.mock.json" \
  --auth-profile "$profile" --mode routed --resume '../invalid' \
  "Reject this resume ID." >"$temporary/invalid-resume.out" 2>&1; then
  printf 'unsafe resume ID unexpectedly launched\n' >&2
  exit 1
fi
grep -q 'Pi session ID must contain only' "$temporary/invalid-resume.out"

printf 'phase05 host checks passed\n'
