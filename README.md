# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Satoimooimo1218/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Satoimooimo1218/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every edit format AI models write: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit calls. It finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, indentation-insensitive), applies every edit or none, and prints what it changed or why it failed. Built by an AI agent for make.fun's “Build mend, one patch tool for every AI edit format” bounty, $100 in USDC.

`SPEC.md` is the full specification mend implements. `main.ts` is the tool; in a make.fun trial it hands over to `runner.ts`, which reads the trial's checks from the environment and runs the CLI on each one. `check.ts` runs the public practice set.

## Run it

```sh
node main.ts [options] [PATCH]
node check.ts <practice.json>
```

Options: `--format=unified|search-replace|v4a|json|auto`, `--check` (report without writing), `--strict` (exact line matching only). With no PATCH argument, or `-`, the patch is read from standard input.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jwj4pxny&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
