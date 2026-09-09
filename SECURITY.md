# Security

## Trust model

`route-agent` mounts the selected project read-write into an agent container.
Pi's coding tools can execute project code and change source files. Docker is
not a rollback mechanism and this configuration is not a complete sandbox for
hostile repositories.

Pi owns credentials in the selected `/pi-profile` volume. The Pi process and
same-UID tools inside that agent container can access those files; the lab does
not claim an in-container credential boundary. The launcher never mounts the
host home, SSH directory, Docker socket, or unrelated credentials. Dev,
evaluator, report, and ordinary mock operations do not receive a real profile.

Independent evaluator containers have no network and no auth-profile mount.
Hidden checks and reference solutions are excluded from every agent image
layer. This protects benchmark integrity against routine leakage and tampering,
not against every possible malicious-code technique.

## Operational guidance

- Review and commit or back up a project before mounting it.
- Use a dedicated Pi auth profile where provider policy permits.
- Complete login and logout only through Pi's native `/login` and `/logout`.
- Do not place tokens, provider URLs, or account identifiers in lab config.
- Treat `runs/`, `results/`, transcripts, patches, and command output as
  potentially private. Share only reviewed report files.
- Do not run `--live` or `--probe-models` unless provider usage is intentional.
- Stop and reauthenticate through Pi after revoked credentials, refresh
  failures, quota errors, or entitlement errors. Do not substitute another
  model to conceal an infrastructure failure.

The report redactor removes known credential fields and terminal/Markdown
control content. It is not a comprehensive secret scanner.

## Reporting a vulnerability

Report vulnerabilities privately to the repository maintainers, preferably
through the repository's private security-advisory feature. Include affected
revision, reproduction steps, impact, and whether credentials or private
artifacts may have been exposed. Do not include real secrets in the report.
