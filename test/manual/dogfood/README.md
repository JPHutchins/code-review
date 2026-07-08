# Manual dogfood: budget-discipline smoke against a live agent

`run_smoke.sh` drives a real headless `claude -p` through the review agent's budget hooks
(issue #38) end-to-end, on a live model endpoint, and reports what the hooks actually did. It is
**not** part of CI — it needs a live endpoint, credentials, and the official `/code-review` plugin —
so it lives here as a maintainer tool for validating changes to `budget.ts` / `transcript.ts` /
`settings.ts` before release. `vitest` covers the pure decision logic; this covers the behavior.

## What it exercises

- **dedup / cost** — `check-cost` sums the transcript (deduped by `message.id`), so an over-count
  regression shows up as an inflated figure.
- **soft → hard steering** — the reserve model (`--reserve-frac` / `--reserve-usd` / `--reserve-wall`)
  steers the agent to converge, then forces it.
- **denylist** — under the hard reserve, subagent spawns / arbitrary shell / web are denied while the
  draft-delivery path (Write/Edit the draft, `code-review validate`, the terminal answer tool) stays
  open.
- **the #38 cure** — the agent writes a valid `$DRAFT` under budget pressure instead of investigating
  until it is killed.

## Setup

1. **Build the CLI** so the run-time shim resolves it: `npx tsup` (from the repo root).
2. **Endpoint credentials.** Create `$REPO/.env.dogfood` (gitignored — see `.gitignore`) exporting the
   Claude Code endpoint variables for your provider, e.g.:
   ```sh
   export ANTHROPIC_BASE_URL=https://api.example.com
   export ANTHROPIC_AUTH_TOKEN=...            # never commit this
   export ANTHROPIC_MODEL=...                 # main agent
   export ANTHROPIC_DEFAULT_HAIKU_MODEL=...   # subagent tiers (for USE_SKILL fan-out)
   export ANTHROPIC_DEFAULT_SONNET_MODEL=...
   ```
   Point elsewhere with `DOGFOOD_ENV=/path/to/env`, or just pre-export the vars.
3. **The `/code-review` plugin** (only for `USE_SKILL=1`) — the official marketplace plugin, found by
   default at `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-review`. Override
   with `CODE_REVIEW_PLUGIN=/path/to/plugin`.

Runs are written to `$DOGFOOD_OUT` (default `$TMPDIR/code-review-dogfood`), never into the repo.

## Usage

```sh
# Baseline: generous budget, natural finish — hooks stay silent, valid draft.
LABEL=calib WALL=30m PRICES="$PWD/.github/prices.json" test/manual/dogfood/run_smoke.sh

# Force the cost axis (a 5-cent cap): steer then forced convergence, reconcile with check-cost.
LABEL=dollars WALL=30m BUDGET_USD=0.05 PRICES="$PWD/.github/prices.json" test/manual/dogfood/run_smoke.sh

# Time axis, no prices → steer on time alone, never a misleading $0.00.
LABEL=time WALL=60s TIMEOUT=4m test/manual/dogfood/run_smoke.sh

# Real /code-review skill, forced fan-out — watch subagent tool calls get denied under hard.
USE_SKILL=1 FANOUT=1 LABEL=fan WALL=60s TIMEOUT=6m RESERVE_WALL=15s test/manual/dogfood/run_smoke.sh
```

`WALL` is the hook's budget; `TIMEOUT` (default = `WALL`) is the `timeout` backstop — set it larger to
isolate hook convergence from the backstop kill. The reserve overrides let you force soft/hard at a
toy scale (the production defaults — 15% / $0.02 / 2 min — are sized for real 20-minute reviews).

## Reading a run

The script prints the composed settings, the agent's exit code, draft validity, and the deduped
`check-cost`. For the chronological picture — every tool call, each budget deny, and subagent
(`isSidechain`) activity — run the analyzer on the snapshotted transcript it points you to:

```sh
node test/manual/dogfood/analyze.mjs "$DOGFOOD_OUT/<label>/transcript/"*.jsonl
```

## Fixture

`fixture/base` → `fixture/head` is a crafted "flawed PR": `head/src/range.js` introduces two bugs that
contradict `head/README.md` (an off-by-one in `inRange`, and `parseRange` mishandling negative bounds),
with a `range.test.js` the agent can run to confirm them. The script commits `base`, applies `head` as
the working tree, and hands the agent the resulting `pr.diff` — mirroring the review job's
"diff already applied" invariant.
