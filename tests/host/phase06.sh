#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
launcher="$root/route-agent"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/routing-lab-phase06.XXXXXX")
project="$temporary/project"
profile="phase06-$$"
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

mkdir -p "$project"
printf '{"name":"phase06-host","version":"1.0.0"}\n' >"$project/package.json"
printf '{"name":"phase06-host","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"phase06-host","version":"1.0.0"}}}\n' \
  >"$project/package-lock.json"
printf 'before\n' >"$project/mock-edit.txt"
git -C "$project" init --quiet
git -C "$project" add package.json package-lock.json mock-edit.txt
git -C "$project" -c user.name='Phase Six' -c user.email=phase06@example.invalid \
  commit --quiet -m fixture

canonical=$(CDPATH= cd -- "$project" && pwd -P)
project_id=$(docker run --rm --entrypoint node "$agent_image" \
  /app/dist/launcher/container-cli.js identify "$canonical" |
  sed -n 's/^project-id:\([0-9a-f]*\)$/\1/p')
test "${#project_id}" -eq 64

state_volume="${compose_project}-project-${project_id}-state"
dependency_volume="${compose_project}-project-${project_id}-dependencies"
cache_volume="${compose_project}-project-${project_id}-cache"
created_volumes="$state_volume $dependency_volume $cache_volume"

LAB_PHASE06_TEST=1 "$launcher" run \
  --project "$project" \
  --config "$root/config/lab.mock.json" \
  --auth-profile "$profile" \
  --mode routed \
  "Create the requested mock edit." >"$temporary/run.out"

invocation_id=$(sed -n 's/.*"invocationId":"\([^"]*\)".*/\1/p' "$temporary/run.out" | sed -n '1p')
session_id=$(sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p' "$temporary/run.out" | sed -n '1p')
test -n "$invocation_id"
test -n "$session_id"
grep -q '"executionStatus":"completed"' "$temporary/run.out"
test "$(cat "$project/mock-edit.txt")" = "mock edit completed"

INVOCATION_ID="$invocation_id" SESSION_ID="$session_id" docker run --rm \
  --read-only --network none --entrypoint node \
  -e INVOCATION_ID -e SESSION_ID \
  -v "$state_volume:/state:ro" \
  "$agent_image" -e '
    const fs = require("node:fs");
    const path = `/state/runs/${process.env.INVOCATION_ID}`;
    const run = JSON.parse(fs.readFileSync(`${path}/run.json`, "utf8"));
    const events = fs.readFileSync(`${path}/events.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
    if (run.schemaVersion !== 1 || run.evidenceKind !== "mock") process.exit(1);
    if (run.identity.piSessionId !== process.env.SESSION_ID) process.exit(1);
    if (run.execution.status !== "completed" || run.validation.status !== "not-run") process.exit(1);
    if (run.decision?.selectedTier !== "weak" || run.decision?.weakSolveProbability !== 0.9) process.exit(1);
    if (run.usage.classifier.totalTokens !== 20 || run.usage.coding.totalTokens !== 34) process.exit(1);
    if (run.costs.classifier.estimatedCostUsd !== null || run.costs.coding.estimatedCostUsd !== null) process.exit(1);
    if (!run.missingReasons.some((reason) => reason.includes("independent validation has not run"))) process.exit(1);
    if (!fs.readFileSync(`${path}/patch.diff`, "utf8").includes("+mock edit completed")) process.exit(1);
    if (events.length < 8 || events.some((event, index) => event.sequence !== index + 1)) process.exit(1);
    if (events.filter((event) => event.kind === "routing" && event.payload.action === "decision-recorded").length !== 1) process.exit(1);
    if ((fs.statSync(path).mode & 0o777) !== 0o700) process.exit(1);
    if ((fs.statSync(`${path}/run.json`).mode & 0o777) !== 0o600) process.exit(1);
  '

short_project=$(printf '%s' "$project_id" | cut -c1-12)
short_invocation=$(printf '%s' "$invocation_id" | tr -d '-' | cut -c1-8)
if docker inspect "${compose_project}-agent-${short_project}-${short_invocation}" >/dev/null 2>&1; then
  printf 'phase06 agent container survived launcher cleanup\n' >&2
  exit 1
fi

printf 'phase06 host checks passed\n'
