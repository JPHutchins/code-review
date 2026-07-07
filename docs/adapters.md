# Agent CLI adapter contract

Each agent CLI is treated as a pluggable **adapter** behind one interface. The reference adapter is
**Claude Code** (`claude -p`); the same contract fits any headless coding-agent CLI (e.g. OpenCode).
The reference implementation is [`src/adapt.ts`](../src/adapt.ts), with its finding-recovery ladder
in [`src/extract.ts`](../src/extract.ts).

## Contract

An adapter maps one agent CLI's native result envelope onto the **abstract result envelope**
([SPEC §6.1](../SPEC.md#61-result-envelope)) and does nothing else. Its inputs, outputs, and
prohibitions are normative in SPEC — this file explains the shape and the reference invocation; SPEC
owns the field lists so they can't rot out of sync here.

### Input

The adapter receives the reviewer's inputs — the PR diff, the CI result, prior-review context, an
optional test report, and failing-job logs — as **files** (SPEC §2.2, §3.3). It never fetches them
itself (no network) and never takes untrusted text as a shell argument or environment variable
(SPEC §5.4). The CI result routes the run per [SPEC §3.1](../SPEC.md#31-abstract-contract): pass →
full review, fail → mechanic-only pass, cancelled/skipped/not-run → post nothing.

### Output

The adapter emits the abstract result envelope with the **spec-owned field names**
([SPEC §6.1](../SPEC.md#61-result-envelope)) — `schema_version`, `findings`, `models`, `turns`,
`duration_ms`, `vendor_cost_usd` — not its CLI's internal keys. The commenter consumes only this
abstract shape and MUST NOT depend on any adapter's native field names.

The adapter MUST NOT post to GitHub, hold a writable GitHub token, or format the comment —
presentation and posting are the commenter's job (SPEC §2.3, and §9.1 REQ-RA-3/REQ-RA-4).

## Reference adapter: Claude Code

`code-review adapt --adapter claude-code <native.json>` projects Claude Code's native
`--output-format json` envelope onto the abstract envelope, delegating `findings` recovery to the
extraction ladder (`code-review extract`, below). [`src/adapt.ts`](../src/adapt.ts) is the mapping:
`modelUsage` → `models[]`, `num_turns` → `turns`, `duration_ms` → `duration_ms`, `total_cost_usd` →
`vendor_cost_usd`. `findings` and `schema_version` come from the ladder when it recovers a candidate;
every other envelope field always comes from the native envelope itself, unconditionally — a ladder
miss degrades to an empty `findings: []` with a "did not complete" summary, never to a discarded
envelope, so the run's real telemetry (models, turns, duration, cost) is never lost to a findings
recovery failure. A real captured native envelope lives at
[`test/fixtures/native-claude-code-envelope.json`](../test/fixtures/native-claude-code-envelope.json).

### Invocation shape

```bash
claude -p "/code-review" \
  --output-format json \
  --json-schema "$(cat schema/findings.schema.json)" \
  --tools "Read,Grep,Glob,Bash(npm:*),Bash(cargo:*)" \
  --permission-mode bypassPermissions \
  --strict-mcp-config \
  --disallowedTools "Read(/proc/**)" "Read(/sys/**)" "Grep(/proc/**)" \
  >envelope.json
```

Notes on the flags:

- `--json-schema` asks for structured output in `.structured_output`, but the Claude Code CLI does
  not reliably populate it (observed on 2.1.197/2.1.201; GitHub issues #18536 and #27926, both closed
  not-planned) — the JSON often arrives as a fenced block inside the prose `result` string instead.
  The extraction ladder recovers it deterministically either way, so structured-output enforcement is
  a best-effort optimization, not a dependency. The schema MUST be inlined (no `$ref`/`$defs`/`$id`).
- `--tools` restricts the toolset — read-only for triage, broader (e.g. adding the project's own
  test/build runner) for the phase-2 review.
- `--permission-mode bypassPermissions` is safe only because the runner is throwaway, egress-locked,
  and carries a read-only token; use a deny-by-default mode for triage so it never hangs in CI.
- `--strict-mcp-config` keeps ambient MCP servers out; `--disallowedTools` blocks `/proc` and `/sys`
  reads (deny beats allow).

For the model-backend env (base URL, auth token, model + subagent model + effort), see
[SPEC §8.5](../SPEC.md#85-model-backend-env). Note the auth variable is `ANTHROPIC_AUTH_TOKEN`, not
`ANTHROPIC_API_KEY`. Any Anthropic-compatible backend works with the same env shape.

## Extraction ladder

Because structured-output enforcement is unreliable (above), `code-review extract` (and `adapt`,
which delegates to it) recovers a schema-conforming candidate deterministically. The rung order and
the exactly-one-distinct-validating semantics are implemented and commented in
[`src/extract.ts`](../src/extract.ts); the ordered rungs are `--agent-file` (findings only — a
documented no-op for triage) → `structured_output` → the whole `result` parsed as one JSON document →
fenced code blocks. The first rung that yields a validating candidate wins, so an earlier rung always
beats a disagreeing later one.

The security property is why the fenced-block rung refuses to guess. Validating candidates are first
deduplicated by canonical equality (a model re-emitting its answer verbatim is not a conflict), then
**exactly one** distinct candidate must remain: zero recovers nothing, and **more than one is
ambiguous, never resolved by taking the first or the last**. This defeats an append-a-block injection
(a diff or file that smuggles a second, differing JSON block into the model's context) that a naive
"last JSON wins" parser would obey ([SPEC §7.2](../SPEC.md#72-threats)). The residual
total-replacement injection — one forged survivor left after the genuine block is suppressed entirely
— is out of the ladder's scope and is contained by the §7.2 controls (read-only token, egress lock,
spend cap, untrusted-markdown rendering).

An error envelope (`is_error`, a non-`"success"` `subtype`, or a non-null `api_error_status`)
short-circuits before any rung runs — a failed run is never salvaged from a stray block. Triage
extraction additionally **fails closed**: when nothing validates, `extract --kind triage` still
exits 0 but synthesizes `safe: false` ([SPEC §7.3](../SPEC.md#73-preflight-security-triage)); only
findings extraction exits non-zero on recovery failure.

Caveat: a finding `body` that itself contains a complete, valid findings-JSON example (e.g. as
documentation) can trip the ambiguity guard against the real answer. This is an accepted,
fail-closed false positive, not a bug.

## Writing a new adapter

A new adapter for another agent CLI (e.g. OpenCode) implements the same contract: accept the inputs
as files, emit the abstract envelope (SPEC §6.1) mapped from the CLI's native output, recover
`findings` via the same extraction ladder when structured-output enforcement is imperfect, never post
to GitHub, and run under the same controls (read-only token, egress lock, burner key with spend cap).
The full conformance requirements are [SPEC §9.1](../SPEC.md#91-review-agent) (REQ-RA-1…6); the
reference to mirror is [`src/adapt.ts`](../src/adapt.ts).

An adapter MAY use any CLI flag syntax (the contract is the data, not the flags), add project-specific
context (CLAUDE.md, README, contributing guidelines) to the prompt, and re-run project checks to
validate findings (the runner is throwaway).

## Conformance tests

The adapter and ladder conformance suite is executable, not aspirational:
[`src/adapt.test.ts`](../src/adapt.test.ts), [`src/extract.test.ts`](../src/extract.test.ts), and the
fixtures in [`test/fixtures/extract-ladder/`](../test/fixtures/extract-ladder/) exercise the rung
order, the error-envelope short-circuit, the ajv + io-ts candidate gate, ambiguity-is-failure, and
fail-closed triage. Commenter-side conformance (in-diff demotion, cost recompute, render sections,
`post` upsert by marker **and** author identity) is covered by the sibling `src/*.test.ts` suites.
Run them via the project's test task.
