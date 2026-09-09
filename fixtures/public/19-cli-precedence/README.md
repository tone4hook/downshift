# Cli Precedence

The deploy CLI combines defaults, a config file, DEPLOY_* environment values, and command flags. Fix precedence (defaults < file < environment < flags), preserve explicit false, and reject non-integer ports outside 1..65535 before invoking deploy. Empty environment values are absent. Keep inputs unchanged and retain the existing planDeploy API.

The exported API is in `src/index.ts`. Supporting modules separate policy and integration behavior.
Run `npm test` for the public regression check.
