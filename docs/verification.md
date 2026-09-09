# Verification and platform scope

Downshift separates deterministic engineering verification from live model
evaluation. Passing engineering checks demonstrates that the harness behaves as
designed with its fake provider; it does not establish the capability, cost, or
availability of any live model.

## Automated verification

Build the pinned images, then run either verification level:

```sh
./route-agent build
./route-agent eval verify --level quick
./route-agent eval verify --level full
```

Quick verification checks image/source identity, routing and measurement
contracts, the deterministic smoke matrix, and provider-side usage
reconciliation. Full verification additionally runs the complete test suite,
strict TypeScript checks, documentation validation, all 42 baseline/reference/
negative fixture gates, and clone-style host integration.

Verification reports and sanitized logs are written to
`results/verify-<id>/`. The report remains `INCOMPLETE` if execution is
interrupted and becomes `FAIL` if any required check has an unexpected exit
code. The smoke check's expected exit code is `1` because its scripted matrix
contains intentional capability failures.

GitHub Actions runs full verification without live credentials or paid calls
and uploads only the verification report and check logs. The current workflow
result on the commit being evaluated is the authoritative CI status.

## Supported environment

The supported host interface is a POSIX shell with Docker Compose v2 on macOS
or Linux. Images are built for the host architecture from pinned Node and Rust
base-image digests. Native Windows, nested npm/pnpm workspace dependency
layouts, and container engines without Compose v2 are outside the current
support scope.

Authentication, terminal behavior, callback handling, provider entitlement,
model limits, streaming, usage reporting, and retry behavior can vary by Pi
provider. Use `./route-agent doctor --probe-models` only when intentionally
testing a live provider. A successful mock verification must never be presented
as evidence that those provider-specific paths work.

## Public-release checks

Before publishing a revision:

1. Run full verification on the exact source revision and retain its report.
2. Confirm `git status --ignored` contains no local configuration or credentials
   that are about to be forced into Git.
3. Scan the files being published for credentials, private keys, personal paths,
   transcripts, patches, and private result data.
4. Review dependency pins, licenses, and third-party notices.
5. Confirm the README commands and repository URL match the release.

Results are local by default. Even sanitized aggregate reports require review
before publication; raw attempt directories can contain private source and
model output.
