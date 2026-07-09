#!/usr/bin/env bash
# Manual, live-endpoint smoke of the review agent's budget discipline (issue #38) against a real
# headless `claude -p`. NOT part of CI (needs a live model endpoint + secrets + the official
# /code-review plugin) — a maintainer tool for validating changes to the budget hooks end-to-end.
# See README.md for setup (the endpoint .env and plugin provisioning).
#
# Each run is isolated: a fresh HOME + cwd, a `code-review` shim resolving to this repo's built
# dist/, a crafted flawed-PR fixture applied to the working tree, and the composed --settings from
# `print-settings`. The session transcript is snapshotted and summarised (draft validity, deduped
# cost via check-cost, and the budget steer/deny messages the hook injected).
#
# Usage:
#   LABEL=calib WALL=30m PRICES="$REPO/.github/prices.json" test/manual/dogfood/run_smoke.sh
#   LABEL=dollars WALL=30m BUDGET_USD=0.05 PRICES=... run_smoke.sh   # force the cost axis
#   LABEL=time WALL=60s TIMEOUT=4m run_smoke.sh                      # time axis, no prices
#   USE_SKILL=1 FANOUT=1 LABEL=fan WALL=60s RESERVE_WALL=15s run_smoke.sh  # real /code-review fan-out
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${CODE_REVIEW_REPO:-$(cd "$HERE/../../.." && pwd)}"
DOGFOOD_ENV="${DOGFOOD_ENV:-$REPO/.env.dogfood}"
PLUGIN="${CODE_REVIEW_PLUGIN:-$HOME/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-review}"
OUT="${DOGFOOD_OUT:-${TMPDIR:-/tmp}/code-review-dogfood}"
# The PR to review, as a base/ + head/ tree pair (head = base with the PR diff applied). Defaults to
# the bundled crafted fixture; point FIXTURE at any repo@base + head to replay a real PR (issue #45).
FIXTURE="${FIXTURE:-$HERE/fixture}"

LABEL="${LABEL:?set LABEL}"
WALL="${WALL:?set WALL, e.g. 60s or 5m}"
TIMEOUT="${TIMEOUT:-$WALL}"
EFFORT="${EFFORT:-xhigh}"

[ -f "$REPO/dist/index.js" ] || { echo "build first: (cd $REPO && npx tsup)"; exit 1; }

RUN="$OUT/$LABEL"
rm -rf "$RUN"
mkdir -p "$RUN/home" "$RUN/proj" "$RUN/bin"
RHOME="$RUN/home"
PROJ="$RUN/proj"
DRAFT="$RUN/findings-draft.json"

# `code-review` → this repo's built CLI, on PATH (no global install needed).
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$REPO/dist/index.js" >"$RUN/bin/code-review"
chmod +x "$RUN/bin/code-review"
export PATH="$RUN/bin:$PATH"

# Crafted flawed PR: base commit, then head applied as the working tree + pr.diff (mirrors the
# review job's "diff already applied" invariant).
cp -r "$FIXTURE/base/." "$PROJ/"
git -C "$PROJ" init -q
git -C "$PROJ" -c user.email=s@local -c user.name=s add -A
git -C "$PROJ" -c user.email=s@local -c user.name=s commit -qm base
cp -r "$FIXTURE/head/." "$PROJ/"
git -C "$PROJ" add -A >/dev/null 2>&1
git -C "$PROJ" diff --cached >"$PROJ/pr.diff"
git -C "$PROJ" reset -q

SCHEMA="$(code-review print-schema findings)"

PRICES_ARGS=(); [ -n "${PRICES:-}" ] && PRICES_ARGS=(--prices "$PRICES")
BUDGET_ARGS=(); [ -n "${BUDGET_USD:-}" ] && BUDGET_ARGS=(--budget-usd "$BUDGET_USD")
RESERVE_ARGS=()
[ -n "${RESERVE_FRAC:-}" ] && RESERVE_ARGS+=(--reserve-frac "$RESERVE_FRAC")
[ -n "${RESERVE_USD:-}" ] && RESERVE_ARGS+=(--reserve-usd "$RESERVE_USD")
[ -n "${RESERVE_WALL:-}" ] && RESERVE_ARGS+=(--reserve-wall "$RESERVE_WALL")

code-review print-settings --draft "$DRAFT" --kind findings --wall "$WALL" \
  "${BUDGET_ARGS[@]}" "${PRICES_ARGS[@]}" "${RESERVE_ARGS[@]}" >"$RUN/settings.json"

echo "=== $LABEL: wall=$WALL timeout=$TIMEOUT budget_usd=${BUDGET_USD:-<none>} prices=${PRICES:-<none>} effort=$EFFORT ==="
echo "--- settings.json ---"; cat "$RUN/settings.json"; echo

# Endpoint config (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL + default tiers) —
# from $DOGFOOD_ENV if present, else assumed already exported. No secret is echoed.
[ -f "$DOGFOOD_ENV" ] && { set -a; . "$DOGFOOD_ENV"; set +a; }
export CLAUDE_CODE_EFFORT_LEVEL="$EFFORT"
export HOME="$RHOME"
printf '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}\n' >"$RHOME/.claude.json"

PROMPT="A pull request proposes the changes in ./pr.diff, already applied to the working tree. README.md documents the intended behavior. Review the diff for correctness bugs, validating each by running the code."
# USE_SKILL=1 → provision + invoke the official /code-review plugin command (mirrors the review job);
# the append below redirects its deliverable to $DRAFT so it never touches gh/comments.
if [ "${USE_SKILL:-}" = "1" ]; then
  [ -f "$PLUGIN/commands/code-review.md" ] || { echo "plugin not found at $PLUGIN (set CODE_REVIEW_PLUGIN)"; exit 1; }
  mkdir -p "$RHOME/.claude/commands"
  cp "$PLUGIN/commands/code-review.md" "$RHOME/.claude/commands/code-review.md"
  PROMPT="/code-review"
fi
APPEND="You're reviewing a PR in a throwaway sandbox; the diff is already applied to the working tree (./pr.diff), and there is NO GitHub PR — do NOT use gh; review the local diff. Your only deliverable is the review as JSON conforming to the findings schema provided via --json-schema. Write the JSON to $DRAFT (an absolute path outside the repo tree), run \`code-review validate $DRAFT\`, and fix-and-revalidate until it exits 0 before ending your turn.
You have about $WALL of wall-clock. Write a COMPLETE, valid draft to $DRAFT as early as you can — the moment you have a first pass of findings — then refine it in place. Never leave $DRAFT unwritten while you keep exploring: a valid review that exists beats a thorough one that gets cut off.
Validate freely: run the project's checks and edit or run code to confirm a bug or a candidate fix."
# FANOUT=1 → explicitly invoke the skill's parallel-subagent step, to exercise the hook against a
# real fan-out (subagent tool calls are denied once the hard reserve bites).
if [ "${FANOUT:-}" = "1" ]; then
  APPEND="You're reviewing the applied diff (./pr.diff) in a sandbox; there is NO GitHub PR — do NOT use gh, and do NOT post anything to GitHub. Follow your full review methodology INCLUDING its parallel-subagent step: launch several Task subagents to independently review the diff (bugs, CLAUDE.md adherence, comments) before you converge. Your only deliverable is the findings JSON written to $DRAFT — validate it with \`code-review validate $DRAFT\` and fix-and-revalidate until it exits 0 before ending your turn."
fi

cd "$PROJ"
# Absolute deadline anchor (issue #45) — inherited by every hook, incl. fan-out subagents, so all
# measure the same true remaining wall instead of their own ≈0 transcript start. Matches the budget
# wall ($WALL, what print-settings used), NOT the hard $TIMEOUT backstop. NO_ANCHOR=1 skips it, to
# A/B against the pre-fix per-transcript blindness (subagents read ≈0% and run unsteered).
if [ "${NO_ANCHOR:-}" = "1" ]; then
  unset CODE_REVIEW_DEADLINE_EPOCH  # neutralize any anchor inherited from the calling env, so the A/B truly tests pre-#45
  echo "NO_ANCHOR=1 — deadline anchor DISABLED (reproducing pre-#45 per-transcript elapsed)"
else
  CODE_REVIEW_DEADLINE_EPOCH="$(code-review deadline --wall "$WALL")"
  export CODE_REVIEW_DEADLINE_EPOCH
  echo "deadline anchor: CODE_REVIEW_DEADLINE_EPOCH=$CODE_REVIEW_DEADLINE_EPOCH (now + $WALL)"
fi
START=$(date +%s)
set +e
timeout --kill-after=60s "$TIMEOUT" \
  claude -p "$PROMPT" \
    --permission-mode bypassPermissions \
    --settings "$RUN/settings.json" \
    --strict-mcp-config \
    --output-format json \
    --json-schema "$SCHEMA" \
    --append-system-prompt "$APPEND" \
    >"$RUN/envelope.json" 2>"$RUN/claude.stderr"
RC=$?
set -e
END=$(date +%s)
echo "agent RC=$RC  wall_elapsed=$((END-START))s"

mkdir -p "$RUN/transcript"
find "$RHOME/.claude/projects" -name '*.jsonl' -exec cp {} "$RUN/transcript/" \; 2>/dev/null
echo "--- transcript files ---"; ls -la "$RUN/transcript/" 2>/dev/null
MAIN="$(find "$RUN/transcript" -name '*.jsonl' -printf '%s %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"

echo "--- draft present? ---"
if [ -f "$DRAFT" ]; then
  echo "YES: $DRAFT"; code-review validate "$DRAFT" && echo "draft VALID" || echo "draft INVALID"
else
  echo "NO draft written"
fi

echo "--- check-cost (true post-hoc, deduped) ---"
[ -n "$MAIN" ] && code-review check-cost "$MAIN" "${PRICES_ARGS[@]}" || echo "(no transcript)"

echo "--- run 'node $HERE/analyze.mjs $MAIN' for the chronological tool/deny/spawn trace ---"
echo "=== end $LABEL ==="
