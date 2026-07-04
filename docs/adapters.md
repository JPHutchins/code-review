# Agent CLI adapter contract

Each agent CLI is treated as a pluggable **adapter** behind one interface. The reference adapter is
**Claude Code** (`claude -p`); the same contract fits any headless coding-agent CLI (e.g. OpenCode).

## Contract

### Input (adapter receives)

| Input | Format | Description |
|---|---|---|
| Diff | unified diff text (file) | The PR's changes — fetched via API, never by checking out fork code |
| CI result | `workflow_run.conclusion` or equivalent | pass → full review; fail → mechanic-only pass |
| Context | JSON file(s) | Prior review (bot-authored comments), PR title/body, optional test report (any conforming format) |
| Failing-job logs | text (file) | When CI failed — the failed step logs; presented alongside the test report when both exist |

All inputs are passed as **files**, never as shell arguments or environment variables. The adapter
reads them from known paths.

### Output (adapter MUST produce)

The adapter MUST emit the **abstract result envelope** defined in [SPEC §6.1](../SPEC.md#61-result-envelope),
with spec-owned field names — not its CLI's internal keys:

| Field | Source |
|---|---|
| `schema_version` | The findings-schema version the adapter targets. |
| `findings` | The model's structured output, conforming to [`findings.schema.json`](../schema/findings.schema.json). |
| `models` | Per-model token counts (incl. subagents). Map the CLI's native per-model breakdown (e.g. Claude Code's `modelUsage` keyed object) to this array of `{model, input_tokens, output_tokens, cache_read_tokens?, cache_write_tokens?}`. |
| `turns` | Number of agentic turns (Claude Code: `num_turns`). |
| `duration_ms` | Wall-clock duration (Claude Code: `duration_ms`). |
| `vendor_cost_usd` | The CLI's reported cost if any (Claude Code: `total_cost_usd`); nullable. The commenter recomputes canonical cost from `models` + the price map. |

The reference adapter (Claude Code) produces a native `--output-format json` envelope with its own
keys (`modelUsage`, `usage`, `num_turns`, `structured_output`, `result`, `total_cost_usd`). A thin
mapping step (a `jq` filter or a function in the commenter package) projects that native shape onto
the abstract envelope above; the commenter consumes the abstract shape only.

The adapter MUST NOT:
- Post comments, reviews, or any content to GitHub.
- Hold or use a writable GitHub token.
- Format the comment (presentation is the commenter's job).

### Routing behavior

| CI result | Adapter behavior |
|---|---|
| pass (`success`) | Full agentic review; may re-run project checks to validate findings. High-effort model. |
| fail (`failure`) | Fast mechanic pass: only proposes minimal fixes from failing-job logs. Low-effort model. No comprehensive review. |
| cancelled / skipped / not-run | No review; post nothing. |

## Reference adapter: Claude Code

The Claude Code CLI (`@anthropic-ai/claude-code`) is the reference adapter. Its structured-output
mode (`--json-schema`) constrains the model to emit findings conforming to the published schema.

### Invocation shape

```bash
claude -p "/code-review" \
  --output-format json \
  --json-schema "$(cat schema/findings.schema.json)" \
  --tools "Read,Grep,Glob,Bash(uv run:*),Bash(npm:*),Bash(cargo:*)" \
  --permission-mode bypassPermissions \
  --strict-mcp-config \
  --disallowedTools "Read(/proc/**)" "Read(/sys/**)" "Grep(/proc/**)" \
  >envelope.json
```

### Key flags

| Flag | Purpose |
|---|---|
| `-p "/code-review"` | Headless invocation with the built-in code-review command |
| `--output-format json` | Result envelope (not just the text) — `modelUsage`, `usage`, `num_turns`, `duration_ms` |
| `--json-schema '<schema>'` | Forces structured output into `.structured_output`. The schema MUST be inlined (no `$ref`/`$defs`/`$id` fragments). |
| `--tools "…"` | Restrict the toolset — e.g. read-only for triage, broader for phase-2 review |
| `--permission-mode dontAsk` | Deny anything not allowed; never hangs in CI (used for triage) |
| `--permission-mode bypassPermissions` | Allow tool use; safe because the runner is throwaway, egress-locked, and read-only token (used for phase 2) |
| `--strict-mcp-config` | No ambient MCP servers leak in |
| `--disallowedTools` | Deny beats allow — block `/proc/`, `/sys/` reads |
| `--append-system-prompt` | Frame the review with project-specific instructions |

### Model configuration (non-Anthropic backend example)

```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=<key>          # NOTE: _AUTH_TOKEN, not _API_KEY
ANTHROPIC_MODEL=deepseek-v4-pro
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
CLAUDE_CODE_EFFORT_LEVEL=max
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
```

Any Anthropic-compatible backend works with the same env shape.

### Result envelope

The `--output-format json` envelope has this shape (verify against your CLI version):

```jsonc
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "total_cost_usd": 0.0,          // Anthropic-priced — recompute for other backends
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  },
  "modelUsage": {                 // per-model; subagent models appear as their own keys
    "deepseek-v4-pro": {
      "inputTokens": 0, "outputTokens": 0,
      "cacheReadInputTokens": 0, "costUSD": 0
    }
  },
  "num_turns": 7,
  "duration_ms": 91234,
  "structured_output": { /* findings per schema */ },
  "result": "…"
}
```

## Writing a new adapter

A conforming adapter for another agent CLI (e.g. OpenCode) MUST:

1. **Accept the same inputs** — diff, CI result, context, and logs as file paths.
2. **Emit findings JSON conforming to the findings schema** — either via structured-output enforcement
   or by post-validating the model's free-text output and mapping it to the schema.
3. **Emit the abstract result envelope** (SPEC §6.1): `schema_version`, `findings`, `models`
   (per-model token counts), `turns`, `duration_ms`, and optional `vendor_cost_usd` — mapped from
   the CLI's native output onto these spec-owned field names.
4. **Not post to GitHub** — the commenter owns presentation and posting.
5. **Be subject to the same security controls** — read-only token, egress lock, burner key with
   spend cap.

An adapter MAY:

- Use a different CLI flag syntax (the contract is the data, not the flags).
- Map the agent CLI's native output format to the envelope shape.
- Add project-specific context (CLAUDE.md, README, contributing guidelines) to the prompt.
- Re-run project checks to validate findings (the runner is throwaway).

## Conformance tests

A conformance test suite for adapters SHOULD verify:

1. Valid findings JSON → `validate` command passes; invalid → non-zero exit.
2. In-diff findings → `inline` command maps them to comments (not strays).
3. Out-of-diff findings → `inline` command demotes them to strays (not dropped, not 422).
4. Envelope `models` + price map → `cost` command produces correct USD; an unknown model warns,
   not silently zeroes.
5. Findings + envelope + prices + template → `render` command produces valid markdown with the
   normative sections (marker first line, verdict, route, summary, cost footer, LLM disclosure
   naming the models from `models`).
6. A `suggestion: ""` finding renders a deletion block; `null` renders none; a >10-line suggestion
   is demoted to the summary rather than 422-ing the review.
7. `post` finds-and-PATCHes the existing bot comment by marker **and author identity**; a non-bot
   comment carrying the marker is not updated.
