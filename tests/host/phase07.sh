#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/routing-lab-phase07.XXXXXX")
compose_project=$(docker compose --project-directory "$root" -f "$root/compose.yaml" config |
  sed -n 's/^name: //p' | sed -n '1p')
agent_image="${compose_project}-agent"
evaluator_image="${compose_project}-evaluator"
uid=$(id -u)
gid=$(id -g)
[ "$uid" -ne 0 ] || uid=10001
[ "$gid" -ne 0 ] || gid=10001
agent_container="${compose_project}-phase07-cancel-$$"
profile_volume="${compose_project}-phase07-profile-$$"
state_volume="${compose_project}-phase07-state-$$"
dependency_volume="${compose_project}-phase07-dependencies-$$"

cleanup() {
  docker rm -f "$agent_container" >/dev/null 2>&1 || true
  docker volume rm "$profile_volume" "$state_volume" "$dependency_volume" >/dev/null 2>&1 || true
  rm -rf "$temporary"
}
trap cleanup EXIT HUP INT TERM

mkdir -p \
  "$temporary/trial-a" \
  "$temporary/trial-b" \
  "$temporary/export" \
  "$temporary/validation" \
  "$temporary/quality" \
  "$temporary/profile"
printf '{"token":"PHASE07_FAKE_TOKEN_SENTINEL"}\n' >"$temporary/profile/auth.json"
printf 'outside-trial\n' >"$temporary/uncommitted-user-file.txt"
before_hash=$(git hash-object "$root/fixtures/public/phase07-synthetic/src/sum-positive.ts")

run_evaluator() {
  docker run --rm \
    --read-only --network none --cap-drop ALL --cap-add SETGID --cap-add SETUID \
    --security-opt no-new-privileges:true \
    --pids-limit 64 --memory 256m --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
    -e LAB_CONTAINER_ROLE=evaluator -e "LAB_UID=$uid" -e "LAB_GID=$gid" \
    "$@"
}

run_evaluator \
  -v "$temporary/trial-a:/trial" \
  "$evaluator_image" \
  node /app/dist/evaluation/cli.js materialize phase07-synthetic /trial \
  >"$temporary/materialize-a.json"
run_evaluator \
  -v "$temporary/trial-b:/trial" \
  "$evaluator_image" \
  node /app/dist/evaluation/cli.js materialize phase07-synthetic /trial \
  >"$temporary/materialize-b.json"

hash_a=$(sed -n 's/.*"sourceHash":"\([0-9a-f]*\)".*/\1/p' "$temporary/materialize-a.json")
hash_b=$(sed -n 's/.*"sourceHash":"\([0-9a-f]*\)".*/\1/p' "$temporary/materialize-b.json")
test "${#hash_a}" -eq 64
test "$hash_a" = "$hash_b"
printf '\nexport const independent = true;\n' >>"$temporary/trial-a/src/sum-positive.ts"
if grep -q independent "$temporary/trial-b/src/sum-positive.ts"; then
  printf 'trial workspaces are not independent\n' >&2
  exit 1
fi

cp "$root/evaluator/phase07-synthetic/reference/src/sum-positive.ts" \
  "$temporary/trial-b/src/sum-positive.ts"
run_evaluator \
  -v "$temporary/trial-b:/trial:ro" \
  -v "$temporary/export:/out" \
  "$evaluator_image" \
  node /app/dist/evaluation/cli.js export phase07-synthetic /trial /out \
  >"$temporary/export.json"
run_evaluator \
  -v "$temporary/export:/submission:ro" \
  -v "$temporary/validation:/out" \
  "$evaluator_image" \
  node /app/dist/evaluation/cli.js validate phase07-synthetic /submission/submission.json /out \
  >"$temporary/validate.json"
grep -q '"status":"pass"' "$temporary/validate.json"

run_evaluator \
  -v "$temporary/quality:/out" \
  "$evaluator_image" \
  node /app/dist/evaluation/cli.js verify-reference phase07-synthetic /out \
  >"$temporary/quality.json"
grep -q '"baseline":{"status":"fail"' "$temporary/quality.json"
grep -q '"reference":{"status":"pass"' "$temporary/quality.json"
grep -q '"incomplete":{"status":"fail"' "$temporary/quality.json"

if docker run --rm --read-only --entrypoint /bin/sh "$agent_image" -c \
  'test ! -e /evaluation && ! grep -R -q PHASE07_HIDDEN_SENTINEL /app /workspace 2>/dev/null'; then
  :
else
  printf 'hidden evaluator content is visible in the agent filesystem\n' >&2
  exit 1
fi
docker image save "$agent_image" -o "$temporary/agent-image.tar"
if grep -a -q PHASE07_HIDDEN_SENTINEL "$temporary/agent-image.tar"; then
  printf 'hidden evaluator sentinel is present in an agent image layer\n' >&2
  exit 1
fi
run_evaluator "$evaluator_image" /bin/sh -c \
  'test ! -e /pi-profile && test ! -e /project-state && grep -q PHASE07_HIDDEN_SENTINEL /evaluation/evaluator/phase07-synthetic/hidden.test.mjs'

docker volume create "$profile_volume" >/dev/null
docker volume create "$state_volume" >/dev/null
docker volume create "$dependency_volume" >/dev/null
docker run --detach --name "$agent_container" \
  --read-only --network none --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
  --security-opt no-new-privileges:true --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  -e LAB_CONTAINER_ROLE=agent -e LAB_AUTH_PROFILE=phase07 \
  -e "LAB_UID=$uid" -e "LAB_GID=$gid" \
  -v "$temporary/trial-a:/workspace" \
  -v "$profile_volume:/pi-profile" \
  -v "$state_volume:/project-state" \
  -v "$dependency_volume:/workspace/node_modules" \
  "$agent_image" /bin/sh -c '(sleep 3; printf "late-child\n" >>/workspace/src/sum-positive.ts) & wait' \
  >/dev/null
sleep 1
docker rm -f "$agent_container" >/dev/null
sleep 3
if grep -q late-child "$temporary/trial-a/src/sum-positive.ts"; then
  printf 'agent descendant survived container shutdown\n' >&2
  exit 1
fi

test "$(cat "$temporary/uncommitted-user-file.txt")" = "outside-trial"
if grep -R -q PHASE07_FAKE_TOKEN_SENTINEL "$temporary/export" "$temporary/validation" "$temporary/quality"; then
  printf 'fake authentication sentinel escaped into evaluator artifacts\n' >&2
  exit 1
fi

after_hash=$(git hash-object "$root/fixtures/public/phase07-synthetic/src/sum-positive.ts")
test "$before_hash" = "$after_hash"

printf 'phase07 host checks passed\n'
