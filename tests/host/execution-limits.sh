#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/routing-lab-limits.XXXXXX")
clone="$temporary/checkout"
COMPOSE_PROJECT_NAME=$(docker compose --project-directory "$root" -f "$root/compose.yaml" config |
  sed -n 's/^name: //p' | sed -n '1p')
export COMPOSE_PROJECT_NAME
evaluator_image="${COMPOSE_PROJECT_NAME}-evaluator"
cleanup() {
  status=$?
  if [ "$status" -eq 0 ]; then rm -rf "$temporary"
  else printf 'execution-limit evidence retained at %s\n' "$temporary" >&2; fi
}
trap cleanup EXIT
mkdir -p "$clone"
tar -C "$root" --exclude=.git --exclude=node_modules --exclude=results \
  --exclude=rust/switchyard-bridge/target --exclude=config/lab.local.json \
  -cf - . | tar -C "$clone" -xf -

for limit in budget-exhausted timeout; do
  docker run --rm --network none --read-only --entrypoint node \
    -v "$clone/config:/config" -v "$root/config/lab.mock.json:/baseline.json:ro" "$evaluator_image" -e '
      const fs = require("node:fs");
      const path = "/config/lab.mock.json";
      const config = JSON.parse(fs.readFileSync("/baseline.json", "utf8"));
      if (process.argv[1] === "timeout") {
        config.execution.timeoutSeconds = 1;
        config.execution.requestTimeoutSeconds = 1;
      } else config.execution.maxAgentTurns = 1;
      fs.writeFileSync(`${path}.tmp`, JSON.stringify(config));
      fs.renameSync(`${path}.tmp`, path);
    ' "$limit"
  if [ "$limit" = timeout ]; then LAB_PHASE03_MOCK_DELAY_MS=2000
  else LAB_PHASE03_MOCK_DELAY_MS=0; fi
  export LAB_PHASE03_MOCK_DELAY_MS
  set +e
  "$clone/route-agent" eval run --suite smoke >"$temporary/$limit.log" 2>&1
  run_exit=$?
  set -e
  [ "$run_exit" -eq 1 ]
  relative=$(sed -n 's/^experiment-directory:\(results\/[^[:space:]]*\)$/\1/p' "$temporary/$limit.log" | sed -n '1p')
  [ -n "$relative" ]
  experiment="$clone/$relative"
  docker run --rm --network none --read-only --entrypoint node \
    -v "$experiment:/experiment:ro" "$evaluator_image" -e '
      const fs = require("node:fs");
      const assert = require("node:assert/strict");
      const report = JSON.parse(fs.readFileSync("/experiment/experiment.json", "utf8"));
      assert.equal(report.planned, 9);
      assert.equal(report.evaluated, 9);
      assert.equal(report.missing, 0);
      for (const mode of Object.values(report.modeResults)) {
        assert.equal(mode.fail, 3);
        assert.equal(mode.unavailable, 0);
      }
      const attempts = fs.readdirSync("/experiment/attempts");
      assert.equal(attempts.length, 9);
      for (const id of attempts) {
        const run = JSON.parse(fs.readFileSync(`/experiment/attempts/${id}/run.json`, "utf8"));
        assert.equal(run.execution.status, process.argv[1]);
      }
    ' "$limit"

  # The checkout default no longer matches: resume must use frozen config.
  cp "$root/config/lab.mock.json" "$clone/config/reset.json"
  mv "$clone/config/reset.json" "$clone/config/lab.mock.json"
  set +e
  "$clone/route-agent" eval resume --experiment "$experiment" >"$temporary/$limit-resume.log" 2>&1
  resume_exit=$?
  set -e
  [ "$resume_exit" -eq 1 ]
  [ "$(find "$experiment/attempts" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 9 ]
done
printf 'execution-limit host checks passed: nine FAIL trials per limit; frozen-config resume preserved attempts\n'
