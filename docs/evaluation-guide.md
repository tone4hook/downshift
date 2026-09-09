# Evaluation guide

## Evidence classes

- `mock`: the real Pi runtime and Switchyard bridge with a scripted provider.
  This proves integration, never model capability.
- `live`: user-authorized inference through a Pi-authenticated provider,
  followed by independent validation.
- `replay`: offline threshold calculations from existing baseline outcomes and
  classifier verdicts.

Reports never combine these classes in one headline metric. Subscription and
unknown billing keep measured dollar cost and savings `null`; unknown is not
zero. Pi catalog prices, when available, are hypothetical reference costs and
not measured spend.

## Fixture and smoke checks

Verify all 42 task baselines, reference implementations, and known incomplete
solutions without model calls:

```sh
./route-agent eval fixtures --suite full --corpus combined
```

Run the deterministic three-task mock matrix:

```sh
./route-agent eval run --suite smoke
```

The fake provider intentionally produces two failing runs, so the expected exit
is `1`. The experiment is nevertheless complete and should contain nine
finalized trials. Regenerate a report without provider access:

```sh
./route-agent report --experiment results/EXPERIMENT_ID
```

See the committed [mock report example](examples/mock-report.md).

## Live and repeated experiments

Live execution requires both explicit `--live` and an intentionally configured
Pi profile:

```sh
./route-agent eval plan --suite dev --corpus combined --repetitions 3 \
  --config config/lab.local.json
./route-agent eval run --suite dev --corpus combined --repetitions 3 \
  --live --config config/lab.local.json --auth-profile default
```

Planning does not call a model or refresh credentials. A live run may consume
API or subscription quota. Every weak-only, strong-only, and routed trial gets
a fresh workspace, Pi session, bridge process, and state volume. The same
prompt, tools, budgets, and effective context/output envelope apply to all
three modes.

Interrupted infrastructure attempts remain attached to their logical trial.
Resume skips terminal capability outcomes and creates linked replacement
attempts only for incomplete infrastructure work:

```sh
./route-agent eval resume --experiment results/EXPERIMENT_ID --live
```

Resume restores the configuration and selected auth-profile label recorded in
the manifest, independently of the checkout's current default config. Optional
`--config FILE` and `--auth-profile NAME` overrides must still match the frozen
experiment identity. Live experiments continue to require `--live` explicitly.

## Threshold workflow

Use development data only:

```sh
./route-agent analyze thresholds --experiment results/DEV_ID --split dev
./route-agent eval freeze --experiment results/DEV_ID --threshold 0.75
```

Replay rows are counterfactual and do not replace observed routed runs. Freezing
writes an immutable `policy.json` containing the development hash and
classifier/model/profile fingerprints. Held-out or full execution checks that
policy before any provider call:

```sh
./route-agent eval run --suite heldout --live \
  --policy results/DEV_ID/policy.json --config config/lab.local.json
```

## Interpreting results

PASS requires normal agent completion and every independent check passing.
Time or turn exhaustion is capability FAIL. Missing login, revoked auth,
rate-limit, quota, entitlement, transport, bridge, harness, and evaluator
failures are unavailable infrastructure outcomes.

Time and turn exhaustion finalize the trial as FAIL and the schedule continues;
infrastructure failures stop dispatch and can be resumed. Agent duration starts
before initial routing, so it includes classifier overhead as well as coding.
Routing duration is also reported separately. Artifacts produced before this
fix excluded initial routing from agent duration; keep those historical timing
cohorts separate rather than rewriting their evidence.

Reports expose:

- success, operational completion, conservative planned success, and
  unavailable counts per mode;
- weak/strong decisions, classifier fallback, and strong coding-session share;
- matched routing categories, baseline disagreements, and paired quality;
- provider/model usage by classifier, coding, and compaction role;
- measured-cost coverage, reference-cost separation, and latency coverage;
- Wilson intervals, task-cluster bootstrap intervals, calibration, and
  exclusions.

The smoke suite has one repetition and is not statistically conclusive.
Repeated runs on the same task are correlated. The 42 public tasks are a
bounded TypeScript/Node corpus; browser automation, databases, other runtimes,
and nested workspace installs are outside v0.1. A negative routing result is
valid evidence and must not be hidden or rerun selectively.

## Artifacts and privacy

`manifest.json` is immutable. Physical attempts live under
`attempts/<attemptId>/`; aggregate output is `experiment.json` and
`experiment.md`; a development freeze adds `policy.json`. Raw transcripts and
patches may contain private source and stay local. Share reviewed aggregate
reports, not entire results directories.

Each agent can write only its current attempt's scratch output. The controller
collects its evidence after it stops; agents cannot read the experiment manifest
or previous trials' validation results through the output mount.

The classifier receives only public task context and a capability description,
not hidden checks, reference patches, split labels, or prior outcomes. Native
providers can be nondeterministic even with a fixed schedule seed.

The report displays numerators, denominators, missing records, and exclusions
beside aggregate metrics. Routed-versus-strong quality uses matched
task/repetition pairs; confidence intervals resample task clusters so repeated
runs and related fixture variants are not treated as independent tasks.

## Harness readiness workflow

Use these stages in order. Engineering verification and planning perform no
live inference. Every live run, probe, and resume requires explicit `--live`.
The example threshold is a declared choice, not an automatically tuned result.

```sh
./route-agent build
./route-agent eval verify --level quick
./route-agent eval verify --level full

# Deliberate live integration pilot after native authentication/configuration.
./route-agent eval run --suite smoke --live --config config/lab.local.json

# 14 tasks x 3 repetitions x 3 modes = 126 coding trials, 42 classifiers.
./route-agent eval plan --suite dev --corpus combined --repetitions 3 \
  --config config/lab.local.json
./route-agent eval run --suite dev --corpus combined --repetitions 3 \
  --live --config config/lab.local.json
./route-agent analyze thresholds --experiment results/DEV_ID --split dev
./route-agent eval probe-routing --experiment results/DEV_ID --live
./route-agent eval freeze --experiment results/DEV_ID \
  --threshold 0.75 --benchmark-profile harness-v1

# 28 tasks x 5 repetitions x 3 modes = 420 coding trials, 140 classifiers.
./route-agent eval plan --suite heldout --corpus combined --repetitions 5 \
  --from-dev results/DEV_ID --config config/lab.local.json
./route-agent eval run --suite heldout --corpus combined --repetitions 5 \
  --policy results/DEV_ID/policy.json --live --config config/lab.local.json
./route-agent eval assess --experiment results/HELDOUT_ID \
  --verification results/VERIFY_ID
./route-agent report --experiment results/HELDOUT_ID
```

Use the full verification directory from the same source and images for
`VERIFY_ID`. `eval plan` prints task and call counts, execution limits, the
maximum agent-time envelope, and an optional agent-time projection from
compatible development measurements. Projection excludes setup/validation;
real latency, failures, and provider throughput can differ. Planning never
makes classifier or coding requests. The classifier probe adds 210 calls for
fourteen tasks (three wordings, five samples each); these do not add coding
trials or independent task samples.

Existing commands default to `--corpus core` (6 dev, 12 heldout). `harness`
contains 8 dev and 16 heldout tasks; `combined` includes both. Smoke is the
original three core integration tasks by default. Corpus IDs, splits, unit weights, and
statistical cluster IDs are versioned in `src/evaluation/corpus.ts`. Related
fixture variants must share a cluster and split; mutations are validator
quality checks, never new benchmark tasks. See [task authoring](task-authoring.md).

Quick verification returns 0 only when its routing/measurement contract tests
and independent smoke matrix all agree. Full adds all tests, strict typecheck,
documentation checks, all 42 fixture quality gates, and Docker
host integration. A verification report is written before checks start and
after every check; interrupted reports remain INCOMPLETE. Logs are linked and
hashed. The mock-provider request ledger is collected from the provider after
the agent stops, outside its filesystem, and reconciled with recorded roles,
identities, ordering, tool calls, and token totals. CI runs full verification
and publishes only its sanitized report and check logs, not live transcripts.
This command does not certify the pending manual platform/TUI/OAuth gates.

Development diagnostics retain actual routed results. Threshold replay and
`random-selection-replay.json` use independent matched baseline outcomes.
Threshold replay also accounts for observed classifier overhead; the random
control reports outcome counts. The latter uses a seeded shuffle with the same
weak-selection count as normal observed decisions; fallback decisions remain
strong. Both are explicitly counterfactual. The routing probe supplies only the
existing prompt-level classifier input: original issue text plus two
presentation-preserving rewrites, five samples per wording. It reports
probability ranges, selection changes, invalid-verdict fallback counts, and
latency. It never exposes the repository or hidden checks to classification.
Infrastructure failure stops the probe and preserves partial samples in a new
`results/probe-<id>` directory.

A `harness-v1` freeze requires a completed version 2 combined development
experiment. It binds the 28 held-out tasks, equal task weights, five repetitions,
development schedule seed, native models, capability description, threshold,
limits (including any monetary cap), method, targets, source-content digest, and immutable agent/evaluator
image IDs. The held-out manifest embeds the protocol and copies it to
`protocol.json`. Configuration, source, images, task hashes, or schedule changes
are rejected before held-out inference. If using a nondefault development
`--seed`, pass that same seed to held-out execution. Rebuild images after changing
source or fixture inputs; a rebuild with different image identities requires
new verification and development evidence. Freeze is immutable and never
selects a threshold for you.

Readiness uses separate `readiness.json` and `readiness.md` reports:

| Criterion | Required lower 95% confidence bound |
|---|---:|
| Routed absolute task success | 80% |
| Routed minus strong success | -5 percentage points |
| Strong-identity token reduction | 25% |

Token reduction is `1 - routed strong-identity tokens / strong-only
strong-identity tokens`. The exact provider/model identity determines inclusion,
including when the strong model is the classifier. Count Pi's verified exclusive
input/output/cache-read/cache-write categories once, including compaction and
all replacement-attempt overhead. An unused role has known zero calls; a
missing response from a dispatched call has unknown usage. Unknown usage cannot
become zero or establish savings. This is token avoidance, not money or measured
subscription quota.

The readiness bootstrap uses 10,000 seeded resamples of independent task
clusters, retaining repetitions and matched modes together, with equal task
weights and 95% percentile intervals. At least twenty held-out clusters and
5,000 valid resamples are required. Sparse, all-pass/all-fail, or otherwise
degenerate distributions cannot establish zero-width certainty. Core and
multi-file strata are also shown; individual task outcomes, routing mistakes,
calibration, fallback, latency, and operational completion stay in the existing
experiment report. Its descriptive Wilson and 2,000-resample calculations are
unchanged. The pairing and clustering follow the principles in
[Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640).

PASS requires matching full engineering verification, complete fresh held-out
live evidence, complete usage, and every lower bound meeting its target. FAIL
means a matching engineering invariant failed, or a valid performance upper
bound falls below a target. All other cases are INCONCLUSIVE, including crossing
intervals, missing usage, incomplete execution, small samples, mock evidence,
and smoke/development results. The 420-trial default can be inconclusive; more
repetitions do not replace broader independent task coverage.

`eval assess` exits 0 for PASS, 1 for FAIL, and 4 for INCONCLUSIVE. Invalid
configuration is 2; unreadable/invalid evidence or infrastructure is 3;
cancellation remains 130. Existing evaluation exit codes are unchanged.
`report` regenerates descriptive reports offline and exits successfully even
when results are negative. Re-running `eval assess` regenerates readiness
without inference and returns its verdict code again. See
[example verdicts](examples/readiness-reports.md).

Never extend a held-out schedule, change targets, or retry capability failures
after seeing results. Preserve the prior experiment and explicitly declare any
prior exposure on a subsequent freeze with `--prior-exposure "description"`.
Such outcomes remain descriptive and are ineligible for fresh confirmation.
Resume is for infrastructure recovery, retains every physical attempt, and
requires explicit `--live` for live evidence.

Version 1 artifacts retain their existing readers and descriptive reports.
Version 2 launcher manifests add corpus, source, and optional benchmark
provenance; version 2 frozen policies add the protocol. Historical manifests
cannot be upgraded into confirmation after outcomes are known. `CorpusDefinition`,
`BenchmarkProtocol`, `VerificationReport`, and `ReadinessReport` have their own
schema version 1 records. Owned records reject unknown fields and hash changes.
