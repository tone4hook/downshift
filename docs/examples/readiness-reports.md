# Illustrative readiness reports

These are synthetic illustrations, not measured live benchmark results. Actual
reports include source/manifest/protocol/verification hashes, sample coverage,
strata, limitations, and links to the descriptive experiment report.

| Example | Engineering | Routed success 95% interval | Quality difference 95% interval | Strong-token reduction 95% interval | Verdict / exit |
|---|---|---|---|---|---|
| Complete eligible live evidence | PASS | 84% to 96% | -3 to +4 pp | 29% to 52% | PASS / 0 |
| Valid quality loss below target | PASS | 81% to 94% | -14 to -7 pp | 32% to 61% | FAIL / 1 |
| Bounds cross targets | PASS | 76% to 93% | -8 to +2 pp | 19% to 49% | INCONCLUSIVE / 4 |
| Required routing invariant fails | FAIL | unavailable | unavailable | unavailable | FAIL / 1 |
| Missing usage or an interrupted attempt | PASS | descriptive only | descriptive only | unavailable | INCONCLUSIVE / 4 |
| Perfect but degenerate task outcomes | PASS | unavailable | unavailable | varies | INCONCLUSIVE / 4 |
| Complete mock, smoke, or development run | PASS | descriptive only | descriptive only | descriptive only | INCONCLUSIVE / 4 |

A FAIL or INCONCLUSIVE result still produces usable JSON and Markdown.
`./route-agent report --experiment results/EXPERIMENT_ID` regenerates the
independent descriptive report successfully. `eval assess` returns its verdict
code on every regeneration and performs no inference. Do not rerun failed
capability trials or enlarge a held-out sample after inspecting these outcomes.
