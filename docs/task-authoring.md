# Authoring benchmark tasks

A task measures a stated behavioral change in a fresh TypeScript/Node repository.
Its public prompt must describe the issue and acceptance invariants without
revealing the reference patch. The agent navigates the exported API and supporting
modules, edits coordinated implementation files, and can run public regressions.
Fixtures use one supported root npm/pnpm lockfile and offline reproducible setup.

1. Assign a new ID and a development or held-out split in
   `src/evaluation/corpus.ts`. Keep related templates/variants in the same split
   and `clusterId`; do not count mutations as independent tasks. Give each task
   unit weight for `combined`. Changing the frozen registry is a new corpus
   version/protocol, not a retroactive edit to an experiment.
2. Add immutable files under `fixtures/public/<id>/`: an issue README, package
   and root lockfile, at least two interacting implementation modules and an API
   entrypoint, and useful public regression tests. Avoid hidden dependencies or
   network setup. Declare only implementation files editable.
3. Put trusted behavioral and strict TypeScript checks under `evaluator/<id>/`.
   They run against the submitted source in a fresh evaluator workspace with
   no network or credentials. Load source via the submission root, never a
   reference. Concurrency tests should use controlled promises, injected
   schedulers, or explicit barriers, not wall-clock sleeps. Assert every stated
   invariant, including error paths, unchanged inputs, and cleanup.
4. Add `reference/src/` with a complete fix and `incomplete/src/` with a targeted
   plausible partial fix. Add `mutant-<invariant>/src/` for other incorrect fixes;
   list each in `validator.json`'s `mutantDirectories`. Record the mutation and
   affected module in `invariants.json`. Every mutation must violate a public
   acceptance invariant and fail a trusted check. A surviving mutant reveals
   an inadequate check or an equivalent mutation and must be resolved.
5. Write `tasks/<id>.json` with per-file SHA-256 hashes and the fixture directory
   digest. Directory digests hash sorted `relative-path + NUL + file-sha256 + NUL`
   records. Bind the entire evaluator directory using `validatorHash`. Include
   setup/check argv, editable directories, allowed new extensions, protected
   paths, and bounded validation time/file size. `loadTaskDefinition` verifies
   these hashes before use.
6. Run `./route-agent build`, then
   `./route-agent eval fixtures --suite full --corpus combined`. Every baseline
   must FAIL; every reference must PASS; every incomplete/curated mutant must
   FAIL. For persistent detailed logs, create a result directory and pass
   `--output /absolute/path/to/directory`. Finish with full engineering
   verification before collecting new live development data.

Trusted public checks are copied from the immutable fixture; submitted edits
to tests, package files, or lockfiles are rejected. Hidden checks and references
are never mounted in the coding container. The evaluator rejects premature
successful process exits before test assertions, symlinks, traversal, oversized
or protected files, and unsupported artifact layouts. Keep assertion checks
under Node's test runner; strict compile checks can invoke `LAB_TYPESCRIPT_BIN`
from a trusted Node test.

The 24 harness tasks span CLI/configuration, cross-module APIs, authorization,
cache invalidation and races, workers, transactions, cleanup, and integration
regressions. They are small independently authored fixtures, not claims about
large production repository coverage. Publish results with that scope intact.
