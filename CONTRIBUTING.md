# Contributing

Contributions are welcome. Downshift combines TypeScript, a small Rust bridge,
POSIX shell orchestration, and Docker, but all supported development commands
run through the repository launcher.

## Set up and verify

```sh
git clone https://github.com/tone4hook/downshift.git
cd downshift
./route-agent build
./route-agent eval verify --level quick
```

Before opening a pull request, run:

```sh
./route-agent eval verify --level full
```

Full verification uses only the fake provider. Do not make live provider calls
while developing or in CI. A live test must be deliberate, use `--live`, and
must not commit credentials, local configuration, transcripts, patches, or
result directories.

## Project conventions

- Keep TypeScript strict and Node ESM-compatible.
- Keep `route-agent` POSIX-shell compatible and treat paths and prompts as data.
- Preserve Pi's ownership of authentication, provider calls, tools, terminal
  UI, and the coding loop.
- Preserve Switchyard's ownership of classification, thresholding, and model
  selection.
- Do not mount the Docker socket, host home, SSH files, or unrelated credentials
  into runtime containers.
- Keep evaluator inputs and reference solutions out of agent image layers.
- Treat infrastructure failures as unavailable evidence, not model failures.
- Keep missing usage unknown; never convert it to zero.

When changing the benchmark corpus, follow
[the task authoring guide](docs/task-authoring.md). Corpus, validator, schedule,
and policy hashes are compatibility boundaries; do not rewrite historical
result artifacts.

## Pull requests

Describe the behavior changed, the commands you ran, and any compatibility or
security impact. Keep generated `results/`, local auth state, and
`config/lab.local.json` out of commits. If a check cannot run in your
environment, say so plainly rather than reporting it as passed.
