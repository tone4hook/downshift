# Downshift

Downshift is an experimental harness for measuring whether a smaller coding
model can solve a task before spending a larger model's tokens. It combines
[Pi](https://github.com/earendil-works/pi) for authentication and the native
coding loop with [NVIDIA NeMo Switchyard](https://github.com/NVIDIA-NeMo/Switchyard)
for capability classification and weak/strong model selection.

Downshift provides Docker isolation, reproducible task scheduling, independent
validation, usage accounting, and evidence reports. It is a research tool, not
a production sandbox or a guarantee that routing will improve quality or cost.

## Requirements

- Git
- Docker Desktop on macOS, or Docker Engine on Linux
- Docker Compose v2
- A POSIX shell

Host Node.js, Python, and Rust are not required. The pinned toolchains
run inside Docker. Native Windows is not currently supported.

## Quick start

```sh
git clone https://github.com/tone4hook/downshift.git
cd downshift
./route-agent build
./route-agent auth
```

Inside Pi's terminal UI, run `/login`, complete the provider's login flow, and
then run `/quit`. Credentials stay in a Docker volume managed by Pi; Downshift
does not accept copied bearer tokens or a separate router API key.

Discover the authenticated model IDs and create a local configuration:

```sh
./route-agent models --refresh
cp config/lab.example.json config/lab.local.json
# Replace the CHOOSE_PI_* placeholders with IDs reported by `models`.
./route-agent config check --config config/lab.local.json
./route-agent doctor --config config/lab.local.json
```

`config/lab.local.json` is ignored by Git and Docker. Downshift 0.1 uses Pi
0.85.0, whose session API cannot lower the coding models' native limits. The
weak and strong models must therefore expose matching native context and output
limits, and the configured caps must be at least those limits.

`doctor` performs static checks by default. Add `--probe-models` only when you
intend to make provider requests and potentially consume quota.

## Run a coding session

The target must be an npm or pnpm project with exactly one supported root
lockfile:

```sh
./route-agent run --project /absolute/path/to/project
./route-agent run --project /absolute/path/to/project "Fix the failing test."
```

The first machine-readable line includes a `sessionId`. Resume that session to
keep its original routing decision and selected model:

```sh
./route-agent run --project /absolute/path/to/project --resume SESSION_ID
```

The selected project is mounted read-write, so agent edits affect the host.
Commit or back up important work before running Downshift. One writer is allowed
per canonical project path; separate projects can run concurrently.

## Verify the harness

The following commands use the repository's fake provider and make no live
model requests:

```sh
./route-agent eval verify --level quick
./route-agent eval verify --level full
```

Quick verification checks routing, lifecycle, isolation, accounting, and the
nine-trial mock matrix. Full verification also runs all tests, strict
typechecking, documentation checks, all 42 fixture quality gates, and host
integration. Both commands write a report under `results/verify-<id>/`.

You can also run individual offline checks:

```sh
./route-agent eval fixtures --suite full --corpus combined
./route-agent eval run --suite smoke
./route-agent report --experiment results/EXPERIMENT_ID
```

The mock smoke run intentionally exits `1` because its scripted matrix contains
capability failures. A complete nine-trial report is the expected result.

## Run an evaluation

Live execution always requires `--live` and may consume API credits,
subscription quota, or both:

```sh
./route-agent eval plan --suite dev --corpus combined --repetitions 3 \
  --config config/lab.local.json
./route-agent eval run --suite dev --corpus combined --repetitions 3 \
  --live --config config/lab.local.json
```

The `core` corpus contains 18 single-module tasks. The `harness` corpus
contains 24 coordinated multi-file tasks. `combined` contains all 42 tasks,
split into 14 development and 28 held-out tasks. `core` remains the default
for backward compatibility.

Use development data to choose and freeze a threshold before running held-out
tasks:

```sh
./route-agent analyze thresholds --experiment results/DEV_ID --split dev
./route-agent eval freeze --experiment results/DEV_ID \
  --threshold 0.75 --benchmark-profile harness-v1
./route-agent eval run --suite heldout --corpus combined --repetitions 5 \
  --policy results/DEV_ID/policy.json --live \
  --config config/lab.local.json
```

See the [evaluation guide](docs/evaluation-guide.md) for the complete protocol,
recovery rules, statistical interpretation, and readiness assessment.

## Results and privacy

Interactive artifacts are stored in a project-scoped Docker volume. Evaluation
artifacts are stored under `results/<experimentId>/`, which is ignored by Git.
Raw transcripts, patches, prompts, logs, and command output may contain private
source or credentials. Review aggregate reports before sharing them and never
publish an entire results directory without inspecting it.

Exit codes are stable across the launcher:

| Code | Meaning |
|---:|---|
| `0` | Command succeeded, or an assessment passed |
| `1` | Completed evaluation/assessment with a capability or target failure |
| `2` | Usage, configuration, dependency, authentication preflight, or lock error |
| `3` | Incomplete execution, infrastructure failure, or invalid evidence |
| `4` | Readiness assessment is inconclusive |
| `130` | User cancellation |

## Documentation

- [Architecture and trust boundaries](docs/architecture.md)
- [Evaluation guide](docs/evaluation-guide.md)
- [Verification and platform scope](docs/verification.md)
- [Benchmark task authoring](docs/task-authoring.md)
- [Pinned upstream compatibility](docs/upstream-compatibility.md)
- [Security guidance](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

Downshift's original code is available under the [MIT License](LICENSE).
Redistributed and pinned upstream components retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the `licenses/` directory.
