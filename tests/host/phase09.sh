#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/routing-lab-phase09.XXXXXX")
compose_project=$(docker compose --project-directory "$root" -f "$root/compose.yaml" config |
  sed -n 's/^name: //p' | sed -n '1p')
agent_image="${compose_project}-agent"
run_log="$temporary/interrupted.log"
resume_log="$temporary/resume.log"
active_lock_container=
run_pid=

cleanup() {
  [ -z "$run_pid" ] || kill -TERM "$run_pid" >/dev/null 2>&1 || true
  [ -z "$active_lock_container" ] ||
    docker rm -f "$active_lock_container" >/dev/null 2>&1 || true
  rm -rf "$temporary"
}
trap cleanup EXIT HUP INT TERM

plan=$("$root/route-agent" eval plan --suite smoke --repetitions 3 --seed 20260905)
printf '%s\n' "$plan" | grep -q '"taskCount":3'
printf '%s\n' "$plan" | grep -q '"codingTrials":27'
printf '%s\n' "$plan" | grep -q '"expectedClassifierCalls":9'

heldout_plan=$("$root/route-agent" eval plan --suite heldout --repetitions 3)
printf '%s\n' "$heldout_plan" | grep -q '"taskCount":12'
printf '%s\n' "$heldout_plan" | grep -q '"codingTrials":108'
printf '%s\n' "$heldout_plan" | grep -q '"expectedClassifierCalls":36'

set +e
"$root/route-agent" eval run --suite smoke --max-cost-usd 1 \
  >"$temporary/budget.stdout" 2>"$temporary/budget.stderr"
budget_exit=$?
set -e
[ "$budget_exit" -eq 2 ]
grep -q 'bounded per-token billing' "$temporary/budget.stderr"

LAB_PHASE03_MOCK_DELAY_MS=2000 \
  "$root/route-agent" eval run --suite smoke --repetitions 3 --seed 20260905 \
  >"$run_log" 2>&1 &
run_pid=$!

experiment_path=
isolation_checked=0
attempts=0
while [ "$attempts" -lt 600 ]; do
  relative=$(sed -n 's/^experiment-directory:\(results\/[^[:space:]]*\)$/\1/p' "$run_log" |
    sed -n '1p')
  if [ -n "$relative" ]; then
    experiment_path="$root/$relative"
    if [ "$isolation_checked" -eq 0 ]; then
      active_agent=$(docker ps --filter "label=io.downshift.experiment=$(basename "$experiment_path")" \
        --filter label=io.downshift.attempt --format '{{.ID}}' | sed -n '1p')
      if [ -n "$active_agent" ]; then
        output_mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/results"}}{{.Source}}{{end}}{{end}}' "$active_agent")
        [ -n "$output_mount" ]
        [ "$output_mount" != "$experiment_path" ]
        docker exec "$active_agent" sh -c 'test ! -e /results/manifest.json && test ! -e /results/experiment.json'
        isolation_checked=1
      fi
    fi
    finalized=$(find "$experiment_path/attempts" -name run.json -type f 2>/dev/null | wc -l |
      tr -d ' ')
    directories=$(find "$experiment_path/attempts" -mindepth 1 -maxdepth 1 -type d 2>/dev/null |
      wc -l | tr -d ' ')
    if [ "$isolation_checked" -eq 1 ] && [ "$finalized" -ge 1 ] && [ "$directories" -gt "$finalized" ]; then
      break
    fi
  fi
  attempts=$((attempts + 1))
  sleep 1
done
[ -n "$experiment_path" ]
[ "$attempts" -lt 600 ]

manifest_hash_before=$(git hash-object "$experiment_path/manifest.json")
find "$experiment_path/attempts" -name run.json -type f -print | sort >"$temporary/completed.paths"
while IFS= read -r path; do
  printf '%s %s\n' "$(git hash-object "$path")" "$path"
done <"$temporary/completed.paths" >"$temporary/completed.hashes"

kill -TERM "$run_pid"
set +e
wait "$run_pid"
interrupted_exit=$?
set -e
run_pid=
[ "$interrupted_exit" -eq 130 ]
test "$(find "$experiment_path/attempts" -name run.json -type f | wc -l | tr -d ' ')" \
  -gt "$(wc -l <"$temporary/completed.paths" | tr -d ' ')"
grep -R -q '"status": "not-run"' "$experiment_path/attempts"
test ! -d "$experiment_path/.writer-lock"

set +e
"$root/route-agent" eval resume --experiment "$experiment_path" >"$resume_log" 2>&1
resume_exit=$?
set -e
[ "$resume_exit" -eq 1 ]
[ "$(git hash-object "$experiment_path/manifest.json")" = "$manifest_hash_before" ]
while IFS=' ' read -r expected path; do
  [ "$(git hash-object "$path")" = "$expected" ]
done <"$temporary/completed.hashes"
test ! -d "$experiment_path/.writer-lock"
test "$(find "$experiment_path/attempts" -name run.json -type f | wc -l | tr -d ' ')" -ge 27
grep -q '"planned": 27' "$experiment_path/experiment.json"
grep -q '"missing": 0' "$experiment_path/experiment.json"

active_lock_container="${compose_project}-phase09-active-lock-$$"
docker run --detach --name "$active_lock_container" \
  --label io.downshift.invocation=phase09-active \
  --read-only --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --entrypoint /bin/sleep "$agent_image" infinity >/dev/null
mkdir "$experiment_path/.writer-lock"
printf 'phase09-active\n' >"$experiment_path/.writer-lock/invocation"
printf '%s\n' "$active_lock_container" >"$experiment_path/.writer-lock/container"
set +e
"$root/route-agent" eval resume --experiment "$experiment_path" \
  >"$temporary/locked.stdout" 2>"$temporary/locked.stderr"
locked_exit=$?
set -e
[ "$locked_exit" -eq 2 ]
grep -q 'active writer phase09-active' "$temporary/locked.stderr"
docker rm -f "$active_lock_container" >/dev/null
active_lock_container=
rm -f "$experiment_path/.writer-lock/invocation" "$experiment_path/.writer-lock/container"
rmdir "$experiment_path/.writer-lock"

if docker ps -a --filter "label=io.downshift.experiment=$(basename "$experiment_path")" \
  --format '{{.ID}}' | grep -q .; then
  printf 'phase09 experiment containers were not cleaned up\n' >&2
  exit 1
fi

printf 'phase09 host checks passed: %s\n' "$experiment_path"
