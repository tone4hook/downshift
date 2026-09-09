#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/routing-lab-release.XXXXXX")
clone="$temporary/fresh clone"
restricted="$temporary/restricted-bin"
experiment=
persistent_profile=

cleanup() {
  [ -z "$experiment" ] || rm -rf "$experiment"
  [ -z "$persistent_profile" ] || docker volume rm "$persistent_profile" >/dev/null 2>&1 || true
  rm -rf "$temporary"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$clone" "$restricted"
tar -C "$root" \
  --exclude=.git --exclude=node_modules --exclude=results \
  -cf - . | tar -C "$clone" -xf -
ln -s "$(command -v dirname)" "$restricted/dirname"
ln -s "$(command -v docker)" "$restricted/docker"
for helper in docker-credential-desktop docker-credential-osxkeychain; do
  path=$(command -v "$helper" 2>/dev/null || :)
  [ -z "$path" ] || ln -s "$path" "$restricted/$helper"
done

if PATH="$restricted" command -v node >/dev/null 2>&1 ||
  PATH="$restricted" command -v python3 >/dev/null 2>&1 ||
  PATH="$restricted" command -v rustc >/dev/null 2>&1; then
  printf 'restricted clone-to-use PATH unexpectedly contains a host language runtime\n' >&2
  exit 1
fi

(cd "$clone" && PATH="$restricted" /bin/sh ./route-agent build)
(cd "$temporary" && PATH="$restricted" /bin/sh "$clone/route-agent" dev -- pnpm check:docs)

compose_project=$(docker compose --project-directory "$root" -f "$root/compose.yaml" config |
  sed -n 's/^name: //p' | sed -n '1p')
persistent_profile="${compose_project}-auth-release-preserve-$$"
docker volume create "$persistent_profile" >/dev/null
docker run --rm --entrypoint sh -v "$persistent_profile:/profile" \
  "${compose_project}-agent" -c 'printf preserved >/profile/release-sentinel'

sh "$root/tests/host/phase02.sh"
sh "$root/tests/host/phase03.sh"
sh "$root/tests/host/phase05.sh"
sh "$root/tests/host/phase06.sh"
sh "$root/tests/host/phase07.sh"
sh "$root/tests/host/phase09.sh"
sh "$root/tests/host/execution-limits.sh"
docker run --rm --network none --read-only --entrypoint sh \
  -v "$persistent_profile:/profile:ro" "${compose_project}-agent" \
  -c 'test "$(cat /profile/release-sentinel)" = preserved'

set +e
"$root/route-agent" eval run --suite smoke >"$temporary/smoke.out" 2>&1
smoke_exit=$?
set -e
[ "$smoke_exit" -eq 1 ]
relative=$(sed -n 's/^experiment-directory:\(results\/[^[:space:]]*\)$/\1/p' "$temporary/smoke.out" |
  sed -n '1p')
[ -n "$relative" ]
experiment="$root/$relative"

"$root/route-agent" report --experiment "$experiment" >"$temporary/report.out"
docker run --rm --network none --read-only --entrypoint node \
  -v "$experiment:/experiment:ro" "${compose_project}-evaluator" -e '
    const fs = require("node:fs");
    const report = JSON.parse(fs.readFileSync("/experiment/experiment.json", "utf8"));
    const markdown = fs.readFileSync("/experiment/experiment.md", "utf8");
    if (report.evidenceKind !== "mock" || report.suite !== "smoke") process.exit(1);
    if (report.counts.planned !== 9 || report.counts.evaluated !== 9) process.exit(1);
    if (report.modes["weak-only"].pass !== 2 || report.modes["strong-only"].pass !== 3) process.exit(1);
    if (report.modes.routed.pass !== 2 || report.routing.fallback !== 1) process.exit(1);
    if (!markdown.includes("Evidence kind") || !markdown.includes("mock")) process.exit(1);
  '

printf 'phase12 release smoke passed on %s/%s with mock report %s\n' \
  "$(uname -s)" "$(uname -m)" "$relative"
