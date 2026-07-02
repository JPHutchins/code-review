# Handoff — read me first

You are the agent (or human) picking up **`code-review`**, a fresh repo. This file is the
context transfer from the session that produced the design. Read it top to bottom before touching
anything; it contains facts you cannot recover from this repo alone (they live in another project's
history).

---

## 1. What this repo is for

An **open spec + schema + helpers + templates** for building an **agentic pull-request reviewer out of
plain workflow YAML you own** — no marketplace Action, no hosted GitHub App, no third-party SaaS
reviewer. The whole approach is: a headless coding-agent CLI — Claude Code (`claude -p`) is the
reference adapter, but the interface is agent-agnostic (OpenCode and other agent CLIs fit the same
shape) — driven by workflow steps you can read, posting results with `gh api`.

The maintainer (JP Hutchins, she/her) intends to use this repo to:

1. **Publish & maintain the approach as a spec** (the normative, provider-agnostic description).
2. **Publish & maintain the schema** — the structured JSON a review agent emits (`schema/`).
3. Probably **publish a lightweight `npx` package** to validate the schema and run helpers
   (render a comment, compute cost, validate a findings file).
4. Probably **publish templates** for the posted comment.

Design tension to hold the whole time: **maximum flexibility** (people compose their own pipeline,
swap models, own their security boundary) **but also fast to get running** (copy an example workflow,
point it at a key, done). When in doubt, ship a small composable primitive + a copy-paste example
rather than a monolith.

---

## 2. Where this came from (provenance you can't see from here)

This was prototyped and **proven** in a different repo — **camas** (a Python task-runner):
<https://github.com/JPHutchins/camas>. The reference implementation posted a real sticky review
comment on a live PR:

- Proof: <https://github.com/JPHutchins/camas/pull/17#issuecomment-4859543691>
- The run's `step-security/harden-runner` egress log confirmed the designed containment held (only
  `api.deepseek.com` + `api.anthropic.com` + pypi/uv + github hosts were contacted; the runner's
  eBPF "armour" engaged and a `/proc/*/mem`-read lockdown rule armed).

The design doc in [`docs/design.md`](docs/design.md) is written from that camas origin, so it talks
about camas a lot. **Your job includes generalizing it** (see §4). The camas-specific bits are clearly
marked below.

---

## 3. What already exists in this repo

| Path | What it is | State |
| --- | --- | --- |
| [`docs/design.md`](docs/design.md) | The full design + roadmap (moved from camas). The rationale. | complete, camas-flavored |
| [`schema/findings.schema.json`](schema/findings.schema.json) | Canonical review-findings JSON Schema (2020-12), inlined (no `$ref`) so it's usable by both `ajv` and `--json-schema`. | v0.1 draft |
| [`schema/prices.example.json`](schema/prices.example.json) | Example token→USD price map (recompute cost yourself; the CLI's `total_cost_usd` is Anthropic-priced). | example, prices are placeholders |
| [`examples/workflows/review.yaml`](examples/workflows/review.yaml) | The **proven v1** privileged workflow, copied verbatim from camas. | reference (v1) |
| [`examples/workflows/collect.yaml`](examples/workflows/collect.yaml) | The v1 unprivileged collector. **Being retired in v2** (see §5). | reference (v1, retired) |
| [`examples/workflows/README.md`](examples/workflows/README.md) | What the examples are + the v1→v2 delta + the camas-specific lines to generalize. | complete |
| [`examples/templates/comment.example.md`](examples/templates/comment.example.md) | A sample *rendered* sticky comment — the target look. | illustrative |

Not created yet, by design (yours to build — see §7): `SPEC.md`, the `npx` package, real templates,
the v2 single-file example workflow, a `LICENSE`.

---

## 4. The generalization mandate (do this as you write `SPEC.md`)

The normative spec must be **provider- and tool-agnostic**. Concretely:

- **Model backend is an example, not a requirement.** The reference uses DeepSeek via the
  Anthropic-compatible endpoint; the pattern is "any Anthropic-compatible CLI + `ANTHROPIC_BASE_URL` +
  a model env." Present DeepSeek/Anthropic as *examples*.
- **camas is one optional enrichment example, never a dependency.** The universal core routes on the
  **native GitHub Actions result** (`workflow_run.conclusion`) — every repo has that. CTRF (camas'
  machine-readable test report) is an *optional* richer input; when absent, failing-job logs cover it.
  A reader whose repo has never heard of camas must be able to implement the whole spec.
- **CI system is GitHub Actions in the reference, but the shape generalizes** (a CI run finishes → its
  result routes a review → a poster comments). Keep the normative parts abstract where you can; put
  GitHub specifics in a "GitHub Actions binding" section.
- **Naming & trademarks.** The project is named generically (`code-review`), never after a vendor.
  Refer to Claude Code, OpenCode, DeepSeek, GitHub, etc. **nominatively** — to name the tool an
  adapter targets — never in a way that implies affiliation or endorsement. The tool's own output
  (comment header, sticky marker, schema title) uses generic names (`code-review`,
  `<!-- code-review -->`). Ship a trademarks / "not affiliated" notice in `README`/`SPEC` (there's one
  in the README to copy). Frame each integration as an **adapter** (the Claude Code adapter, an
  OpenCode adapter, …) — this supports the agent-agnostic thesis *and* keeps trademarks at arm's length.

---

## 5. Decisions already locked (do not re-litigate without reason)

- **Two files, not three.** v2 = your existing `ci.yaml` (**unmodified**) + one privileged
  `review.yaml`. The separate unprivileged *collector* from v1 is **dropped**: triggering the review
  off CI completion gives the routing signal for free, and the diff is fetched as data via the API.
- **Route on the native CI result.** `workflow_run.conclusion` — `success` → comprehensive reviewer,
  `failure` → fast "mechanic" that only proposes minimal fixes from the failing-job logs. No point
  paying a max-effort review for code that doesn't pass yet.
- **Agent emits structured JSON, commenter renders it.** The model never hand-formats the comment or
  touches a writable token. Data in via files, structured data out.
- **Two-job token split IS the security boundary.** `review` job holds the model key + a **read-only**
  GitHub token + locked egress; `comment` job holds the write token but runs **no agent and no PR
  code**. They're separate jobs (separate runners, independently-scoped tokens) in the one file.
- **Advisory only.** Post the GitHub review as `COMMENT`, never `REQUEST_CHANGES`; never a required
  check; always exit 0 on the comment path. It must never block merge.
- **Trust the previous review by author identity, not by marker.** A fork author can paste your
  `<!-- code-review -->` marker into their own comment; they cannot post *as* the bot identity.
  Filter prior-review context to comments authored by the bot login.
- **Injection discipline everywhere.** Diff, job logs, CTRF, PR body/comments are all untrusted. Pass
  as files, never shell-interpolate; build every API body with `jq -n --rawfile` so untrusted text is
  JSON-escaped before it reaches the shell or the API.
- **The real containment is not the triage.** Phase-1 triage is a heuristic first filter (it reads the
  same untrusted diff an injection would ride in). The controls that actually hold: read-only token on
  the agent job + egress lock + a **burner model key with a hard spend cap**. The residual exfil
  channel is the public comment itself — the spend cap is the backstop.

---

## 6. Reference facts you'll need (verified in the camas session; verify versions before relying)

**Model backend env (DeepSeek via Anthropic-compatible API):**
```
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=<key>          # NOTE: _AUTH_TOKEN, not _API_KEY
ANTHROPIC_MODEL=deepseek-v4-pro
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
CLAUDE_CODE_EFFORT_LEVEL=max
# phase-2 also mapped the tier aliases so /code-review's internal model picks resolve:
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
```

**Claude Code CLI (`@anthropic-ai/claude-code`), version `2.1.197` at time of writing.** Flags used:
- `-p "<prompt>"` headless; `"/code-review"` is a built-in command.
- `--output-format json` → result envelope; the review markdown is in `.result`.
- `--json-schema '<schema>'` → forces structured output into `.structured_output`. (The triage used a
  tiny inline `{safe, reasons}` schema. **`--json-schema` may not accept `$ref`/`$defs`/`$id`** — the
  published schema is therefore *inlined* so the same file works for both `ajv` and the CLI. Verify on
  your CLI version; keep a flattened variant if needed.)
- `--tools "Read,Grep,Glob"` restricts the toolset (triage = read-only, no execution).
- `--permission-mode dontAsk` (deny anything not allowed — never hangs in CI) for triage;
  `bypassPermissions` for the phase-2 agentic review (safe *because* the runner is throwaway,
  egress-locked, and holds only a read-only GitHub token).
- `--disallowedTools "Read(/proc/**)" "Read(/sys/**)" "Grep(/proc/**)"` (deny beats allow).
- `--strict-mcp-config` so no ambient MCP servers leak in.
- `--append-system-prompt "<...>"` to frame the review (the v1 text is camas-specific — see §7).

**Result envelope shape (representative — capture one real envelope and pin your parser to its keys):**
`total_cost_usd` (Anthropic-priced → **wrong for non-Anthropic backends; recompute**), `usage`
(`input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`), `modelUsage`
(a per-model object — **subagent models appear as their own keys**, this is how you report per-model
incl. subagents), `num_turns`, `duration_ms`, `structured_output`, `result`.

**Action versions (current-latest at time of writing; some pin exactly):**
`actions/checkout@v7`, `actions/setup-node@v6`, `astral-sh/setup-uv@v8.2.0` (exact — setup-uv stopped
moving its major past v6), `actions/upload-artifact@v7`, `actions/download-artifact@v8` (keeps
`run-id` + `github-token` cross-run download; compatible with v7 uploads),
`step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411` (v2.19.4, SHA-pinned).

**Egress allowlist gotcha:** the *proven* PR #17 run was `egress-policy: audit` (discovery mode —
logs, doesn't block). In `block` mode you must allow every host the job really uses. Observed in the
audit log: `api.deepseek.com`, `api.anthropic.com` (the CLI phones home even on a non-Anthropic
backend — keep it), `pypi.org`, `files.pythonhosted.org`, `github.com`, `objects.githubusercontent.com`,
plus `api.github.com` and the artifact blob hosts (`*.blob.core.windows.net`,
`results-receiver.actions.githubusercontent.com`) for artifact up/download. Recommend: run `audit`
once on the target repo, then pin the allowlist from the log.

**GitHub API specifics:**
- Trusted PR number from a `workflow_run`: `gh api repos/{repo}/commits/{head_sha}/pulls` — works for
  forks and is not fork-controlled (head_sha comes from the event).
- Inline review comments: `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with `comments[]` using the
  modern absolute `line` + `side` (`RIGHT` for additions), `start_line`/`start_side` for multi-line.
  **A comment on a line not in the diff → 422 rejects the whole review**, so validate each finding's
  line against the diff hunks and demote strays into the summary. `commit_id` must be the reviewed
  head SHA. Suggestions are a fenced `suggestion` block; it replaces exactly `start_line..end_line`.
  Resolved-thread state needs the GraphQL API (`reviewThreads { isResolved }`).
- `workflow_run` fires **only from the default branch** — the PR that introduces the reviewer won't
  review itself; merge first, then open a test PR.

---

## 7. camas-specific lines to generalize (they're in the v1 example verbatim)

When you lift `examples/workflows/review.yaml` into a generic v2 example, neutralize these:

- **Triage prompt** enumerates Python-ecosystem execution vectors (`setup.py`, `conftest.py`,
  `pyproject` build backend, `package.json` scripts, `Makefile`, `tasks.py`). Generalize to
  "build/test/CI scripts and anything that runs on install or test."
- **Phase-2 `--append-system-prompt`** says "run this project's checks (`uv run camas` — see README and
  CLAUDE.md)." Generalize to "run this project's checks (see its README/contributing docs)" — or make
  the check command a workflow input.
- **`astral-sh/setup-uv`** and Python assumptions — the reference project is Python. The generic
  example should set up whatever the target ecosystem needs (or leave it to the user).
- Artifact/marker/workflow names in the camas files carry camas's own branding (`claude-code-review`,
  `<!-- claude-code-review -->`, `name: Claude Code review`). The **spec's** defaults are generic
  (`code-review`, `<!-- code-review -->`) — don't adopt the vendor-branded names for this project (see
  §4 Naming & trademarks). Keep the camas example files verbatim as attributed reference.

---

## 8. What to build (deliverables, with recommended shapes — flexibility preserved)

1. **`SPEC.md`** — the normative, provider-agnostic spec extracted from `docs/design.md`. Suggested
   sections: Overview & thesis · Roles (CI, review, comment) & the security boundary · Trigger &
   routing · The findings schema (link `schema/`) · Posting (sticky summary + inline review) · Cost &
   usage reporting · Threat model & required controls · "GitHub Actions binding" (the concrete
   workflow) · Conformance (what a conforming reviewer/commenter MUST do — advisory-only, injection
   discipline, in-diff validation, author-identity trust). Keep `docs/design.md` as the rationale.
2. **`schema/`** — the findings schema (v0.1 present). Add: a **version policy** (semver; set `$id` to
   the published URL per version), and later maybe schemas for the price map and the CI-context bundle
   (`context.json`: diff meta + CI result + prior review + optional CTRF).
3. **`npx` package — it's the *commenter*, not a validator.** Important framing: Claude Code enforces
   the schema **on the agent side** already — `--json-schema` constrains the model and the validated
   object comes back in `.structured_output`. So a standalone "validate this JSON" tool is *narrow* —
   it's a conformance/defense-in-depth check, not the point. The package's real center of gravity is
   the **deterministic commenter**: the presentation + posting layer, which is where all the fiddly
   correctness actually lives and which no model should do. Recommended commands, in priority order:
   - `render <findings.json> --template <t> --usage <envelope.json> --prices <prices.json>` → the
     comment markdown (severity folding, test panel, cost/model footer, disclosure). **Headline.**
   - `inline <findings.json> --diff <pr.diff>` → the GitHub reviews `comments[]` payload: parse the
     diff hunks, **keep only in-diff findings** (out-of-diff → 422 kills the whole review), map to
     `line`/`side`/`start_line`, attach `suggestion` blocks, demote strays into the summary. This is
     the most valuable helper — it's the part everyone gets wrong.
   - `cost <envelope.json> --prices <prices.json>` → recompute USD from `modelUsage` (the CLI's
     `total_cost_usd` is Anthropic-priced and wrong for other backends).
   - `validate <findings.json>` → ajv against the schema. **Minor** — useful for testing your own
     schema, gating outputs from backends/CLIs that *don't* self-enforce, and as a conformance test
     for the spec; not the reason the package exists.

   Keep each helper usable standalone so a workflow calls just the one it needs. TS or JS is your call;
   publish under whatever scope JP picks. Net: the schema is the contract Claude Code fills; the
   package turns that filled contract into a beautiful, safe, correctly-anchored PR review.
4. **`templates/`** — reference comment template(s) matching `examples/templates/comment.example.md`,
   as data (Handlebars/Eta/plain-with-placeholders) that the `render` helper consumes. Ship the
   severity-folding + footer + disclosure structure.
5. **v2 example workflow** — the single-file `review.yaml` (CI-triggered, API diff fetch, triage →
   route → structured JSON, then inline + sticky comment) as the copy-paste quickstart. Build it as
   the camas-side phases (below) prove out each piece.
6. **Adapters.** Treat each agent CLI as a pluggable *adapter* behind one interface (in: diff + CI
   result + context; out: findings JSON conforming to the schema). The reference adapter is Claude
   Code (`claude -p --json-schema` → `.structured_output`); an OpenCode or other adapter drops into the
   same contract. Document that contract; a future `adapters/` dir is a reasonable home.

---

## 9. Roadmap (from the design; A–C are also being built on the camas side)

- **Phase A** — reviewer emits `--json-schema` structured output; commenter renders via template;
  footer with usage/cost/models. No new triggers.
- **Phase B** — commenter posts a diff-validated PR review with inline comments + suggestions, keeping
  the sticky summary.
- **Phase C** — trigger off CI completion; route on `workflow_run.conclusion` (green→reviewer,
  red→mechanic-from-logs); optional CTRF enrichment.
- **Phase D** — feed the previous review + author replies for incremental review (don't re-nag
  resolved items); severity folding; confidence suppression; `concurrency` cancel; spend cap;
  skip-labels.
- **Phase E** — extract orchestration into a task runner so it runs identically locally and in CI
  (the camas side does this as a camas task; the generic spec describes the shape).

Coordinate: the **camas repo** iterates the working implementation; **this repo** is the spec/schema/
helpers/templates the implementation conforms to. Keep the schema here as SSOT; camas consumes it.

---

## 10. Open questions for the maintainer

- Package name/scope for the `npx` helpers; `LICENSE` (MIT/Apache-2.0 are typical for a spec+schema).
- Stable hosting URL for the schema `$id` (raw GitHub is fine to start; a custom domain later?).
- Templating engine for `templates/` (Handlebars vs Eta vs plain string-substitution).
- How much of the spec is normative (MUST/SHOULD) vs guidance.

---

## 11. House rules carried over (JP's global conventions)

- Any post/PR/issue authored via JP's identity needs an **LLM Disclosure** aside naming the model +
  a one-sentence prompt summary. Commits by an agent end with `Co-Authored-By: <model-id>
  <noreply@<provider>>`.
- Functional style, sum types, exhaustive matching; types are SSOT (no `Args:`/`Returns:` docstrings);
  docstrings say *what*, never *why*; no divider/why comments. Prefer NamedTuples/dataclasses in
  Python; discriminated unions in TS. `cargo fmt`/`clippy -D warnings` for Rust.
- Don't commit here yet unless asked — the maintainer reviews first.

> [!WARNING]
> **LLM Disclosure**
>
> This repository's initial design, schema, and handoff were authored by claude-opus-4-8 on behalf of
> @JPHutchins, who prototyped and proved the approach in the camas repo, then asked for a clean
> spec/schema repo with a full context handoff to continue the work here.
