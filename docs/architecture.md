# Architecture and trust boundaries

## Ownership

The lab deliberately keeps three ownership domains:

| Owner | Responsibilities |
|---|---|
| Pi | Native TUI, tools, coding loop, model catalog, provider calls, login, logout, and credential refresh |
| Switchyard | Capability rubric, verdict validation, thresholding, fallback, and weak/strong selection |
| This repository | Docker lifecycle, project mounting, configuration, persistence, measurement, independent validation, and reporting |

The TypeScript adapter converts between Pi and the versioned Rust bridge
protocol. It does not choose a threshold or parse an alternative verdict.
Switchyard requests a tool-free classifier call through Pi and returns one
selection. Pi then receives the selected native provider/model before coding.
There is one persisted decision per Pi session.

```text
POSIX host launcher
  |
  +-- Docker lifecycle and one canonical-project writer lock
       |
       +-- agent
       |    Pi AgentSession + native TUI/tools
       |       |
       |       +-- stdio -> pinned Switchyard library bridge
       |       |              |
       |       |              +-- call_model -> Pi ModelRuntime
       |       |
       |       +-- selected native Pi coding model
       |
       +-- evaluator --network none
       +-- mock provider on an internal test-only network
```

There is no router daemon, proxy model ID, custom OAuth implementation,
replacement coding loop, database, queue, web UI, or Docker socket mount.

## Filesystems and state

| Path | Scope | Contents |
|---|---|---|
| `/workspace` | Selected project | Bind-mounted source; edits affect the host |
| `/workspace/node_modules` | Canonical project + runtime identity | Named dependency volume |
| `/package-cache` | Canonical project | Package-manager cache volume |
| `/project-state` | Canonical project | Pi sessions, settings, routing decisions, interactive run artifacts |
| `/pi-profile` | Selected auth-profile label | Pi-owned credentials and model catalog |
| `results/<experimentId>/` | Lab checkout | Immutable schedule, attempts, validation, aggregate reports, optional frozen policy |

The launcher canonicalizes project paths and keeps arguments as data. It
rejects unsafe mount delimiters and newline-containing paths. A host temporary
writer lock plus a labeled guard container excludes concurrent writers to the
same canonical project; different projects remain independent.

Authentication profiles may be reused across projects, but project sessions,
dependencies, workspaces, and routing decisions are not shared. Mock
evaluations create ephemeral fake profiles. Cleanup preserves real profile and
project-state volumes.

## Evaluation boundary

The controller materializes public fixture content into a fresh workspace.
After Pi stops, only allowlisted regular source changes are exported. A
separate networkless evaluator reconstructs the immutable baseline and applies
the submission before running trusted public and hidden checks. Protected
tests, lockfiles, configuration, path escapes, symlinks, and oversized files
are rejected.

An agent receives a fresh writable `/results` scratch directory for its current
attempt. The experiment manifest, prior attempts, and validation results are
never mounted into it. After stopping the agent, the controller collects only
bounded regular `events.jsonl`, `patch.diff`, and `run.json` files into that
attempt's directory. Interrupted runs use the same collection path.

Node test validation requires a successful assertion-bearing test summary
reported by the supervisor over a separate pipe. A preload rejects premature
`process.exit()` in submitted code; a zero exit without real test completion
does not count as PASS. This protects against accidental early termination,
without claiming that arbitrary hostile JavaScript is safe in the test worker.

Agent images do not contain evaluator files. Evaluators do not receive Pi
credentials, project state, the Docker socket, or network access. Docker
isolation is an engineering boundary for this harness, not a hostile-code
security proof.

## Session and schema compatibility

Initial routing is persisted before coding starts. Resume verifies the stored
configuration, model, provider, profile, and capability-card fingerprints and
restores the same native model without reclassification. Authentication token
rotation is excluded from the fingerprint. Corrupt or incompatible state is
rejected with a new-session instruction.

Runtime decisions and run results use schema version 1. New experiment
manifests use schema version 2 so they can bind corpus and source provenance;
historical version 1 manifests remain readable. Readers reject unsupported
versions and preserve old evidence rather than rewriting it.

See [the evaluation guide](evaluation-guide.md), [security guidance](../SECURITY.md),
and [verification scope](verification.md).

## Reproducibility and readiness

The evaluation controller reads a versioned corpus registry and
creates version 2 experiment manifests with source hashes. A `harness-v1` freeze
binds the complete held-out protocol, image identities, schedule, configuration,
and acceptance targets before inference. The same independent evaluator grades
all 42 tasks, including the 24 coordinated multi-file fixtures and their curated
incorrect implementations. This adds no coding loop or alternate tool system.

`verification.ts` records objective-linked deterministic gates and reconciles a
mock-provider ledger collected after the coding container exits. That ledger is
owned by the provider process and never mounted into the agent. `readiness.ts`
implements the separate 10,000-resample cluster assessment; `analysis.ts` keeps
descriptive statistics and counterfactual replays. `probe.ts` prepares
only public classifier inputs for Pi/Switchyard, records repeated wording
sensitivity, and never adds coding outcomes to an experiment. Version 1 readers
remain available for historical artifacts.

Every physical attempt retains its own accounting; strong identity usage includes
classifier, coding, compaction, and infrastructure replacements. An unused role
is known zero, while a missing dispatched response is unknown. Image source
stamps and source/task/validator/protocol hashes make stale code or changed
benchmarks rejectable before held-out inference. Verification and readiness
reports are local reproducible evidence, scoped to their recorded inputs.
