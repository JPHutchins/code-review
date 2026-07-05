# code-review — normative specification

> **Version:** 0.1.0-alpha
> **Status:** alpha — implemented by [`@jphutchins/code-review`](https://www.npmjs.com/package/@jphutchins/code-review)
> and the reference workflow in [examples/workflows/review.yaml](examples/workflows/review.yaml). The
> approach is proven — a reference implementation posted a live review on
> [camas PR #17](https://github.com/JPHutchins/camas/pull/17#issuecomment-4859543691).
>
> The reference adapter is Claude Code (`claude -p`); the same shape fits other agent CLIs
> (e.g. OpenCode) and any Anthropic-compatible model backend. "Claude," "Claude Code," "DeepSeek,"
> "GitHub," and "OpenCode" are trademarks of their respective owners; used nominatively — no
> affiliation or endorsement is implied. See [README.md](README.md) § Trademarks.

---

## 1. Overview & thesis

A **pull-request code review** is produced by:

1. A **headless coding-agent CLI** that emits **structured JSON** conforming to a published schema;
2. A **deterministic commenter** that renders and posts the JSON to two GitHub surfaces — a sticky
   summary comment and an inline PR review.

The whole system is **workflow YAML you can read** — reviewed in the same PR flow as the code it
guards — plus a CLI invocation and `gh api` to post the result. There is no marketplace Action, no
hosted GitHub App, and no third-party SaaS reviewer.

Because there is no Action:

| Property | Advantage |
|---|---|
| The backend is a CLI + `ANTHROPIC_BASE_URL` + a model env | **Agent- & model-agnostic** — any Anthropic-compatible backend, any compatible CLI |
| The prompt, schema, and gate live in your repo | **Transparent & auditable** — nothing hidden in a vendor's servers |
| You choose token scopes / egress / spend cap | **You own the security boundary** |
| The orchestration is just a CLI call | **Portable** — GitHub is a thin posting adapter |

### 1.1 Scope

This specification defines:

- The **findings schema** — the structured JSON a review agent MUST emit.
- The **roles** (CI, review agent, commenter) and the **security boundary** between them.
- The **trigger and routing** — how CI completion drives review routing.
- The **findings + envelope contract** — the structured JSON a review agent emits and the
  vendor-neutral cost/usage envelope that accompanies it (§4, §6.1, §5.5).
- The **posting** — how structured findings become a sticky comment and inline review.
- **Cost and usage reporting** — how token consumption is reported, independent of model vendor.
- The **threat model** and required controls.
- **Conformance** — what a conforming implementation MUST and SHOULD do.

This specification is **provider- and tool-agnostic**. Model backends, agent CLIs, and CI systems are
presented as examples; the normative requirements are abstract. A "GitHub Actions binding" section
(§8) provides the concrete workflow shape for GitHub users.

### 1.2 Document conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 2. Roles & the security boundary

The system has three roles, distributed across two trust domains:

### 2.1 CI (unprivileged)

The project's existing CI workflow. Runs on `pull_request`; produces a **conclusion** (success,
failure, or cancelled) that the review routes on. Optionally uploads machine-readable test reports
as artifacts. This workflow is **unchanged** — no modifications are required to enable review.

### 2.2 Review agent (privileged — model key, read-only repo token)

A job in the privileged review workflow. Holds the model API key and a **read-only** GitHub token.
Consumes:

- The PR diff (fetched as data via the API — no fork checkout).
- The CI result (`workflow_run.conclusion`).
- Failing-job logs (when CI failed) and/or an optional machine-readable test report (any conforming
  format).
- Prior review context (bot-authored comments on the PR, PR title and body).

Produces: structured JSON conforming to the [findings schema](schema/findings.schema.json).

The review agent executes untrusted PR code **only after a preflight security triage** of the diff.
The real containment is the read-only token, an egress lock on the runner, and a **burner model key
with a hard spend cap**.

### 2.3 Commenter (semi-privileged — write token, no model key, no PR code)

A separate job (separate runner, separately-scoped token) in the same privileged workflow. Holds a
**pull-requests: write** token but **no model key** and **no PR code**. Its only responsibility is to
transform the structured JSON output into GitHub review surfaces. It MUST be deterministic — no model
invocation, no shell interpolation of untrusted text.

The commenter's separation from the review agent is the security boundary: the job that holds the
write token never touches the model or the PR code.

### 2.4 Token split

```
review job    — model key (secret) + contents:read + actions:read
comment job   — pull-requests:write + issues:write + actions:read
                (NO model key, NO agent, NO PR code)
```

The two jobs MUST be separate runners with independently-scoped tokens.

---

## 3. Trigger & routing

### 3.1 Abstract contract

The review is **triggered by CI completion** and **routed on the CI result**. This section states the
requirements in CI-neutral terms; §8 binds them to GitHub Actions.

- **Trigger.** A CI run for a pull request completes → the review runs. The trigger MUST come from
  CI completion (not from the PR itself), so the result arrives for free and CI is guaranteed to
  have finished before a model token is spent. The trigger MUST NOT be fork-controlled: the
  initiating event and the reviewed commit identifier MUST come from the CI event, not from
  PR-authored content.
- **Routing.** The review agent MUST route on the CI run's outcome:

  | Outcome | Route | Behavior |
  |---|---|---|
  | pass | **reviewer** | Full agentic review; may re-run project checks to validate findings. High-effort model. |
  | fail | **mechanic** | Fast, minimal pass: failing-job logs are fed to a low-effort model that proposes minimal fixes only — no comprehensive review. |
  | cancelled / skipped / not-run | **skip** | No review; post nothing. ("not-run" covers outcomes like `startup_failure` or `neutral` where CI did not actually execute the project's checks — the mechanic MUST NOT critique code for failures that never ran.) |

  The rationale: paying a max-effort review for code that doesn't pass CI is wasteful, and a CI
  result is universal — every repo has one — and requires no special tooling.

- **Diff source.** The diff MUST be fetched as data, not by checking out fork code. The reviewed
  commit identifier comes from the CI event; the associated pull request is resolved from it (not
  from a fork-controlled value). When multiple pull requests share a commit, the binding SHOULD
  disambiguate by the CI event's branch rather than taking an arbitrary first match.
- **Diff size.** A binding that fetches the diff over an API which may truncate large responses
  MUST detect truncation or fall back to a non-truncating source (e.g. a bare `git fetch` + `git
  diff`); silently reviewing a truncated diff is a correctness bug.

### 3.2 GitHub realization

The GitHub Actions binding of §3.1:

- **Trigger** — `on: workflow_run: { workflows: ["CI"], types: [completed] }`. `workflow_run` fires
  only from the default branch, so the PR that introduces the reviewer will not review itself —
  merge first, then open a test PR.
- **Routing** — `workflow_run.conclusion`: `success` → reviewer, `failure` → mechanic,
  `cancelled`/`skipped`/`startup_failure`/`neutral` → skip.
- **Diff source** — `gh api repos/{repo}/pulls/{N} -H 'Accept: application/vnd.github.v3.diff'`,
  with `{N}` resolved from the trusted `workflow_run.head_sha` via
  `gh api repos/{repo}/commits/{head_sha}/pulls`. This works for forks and is not fork-controlled.

### 3.3 Enrichment (optional)

A conforming implementation MAY consume richer inputs when available:

- **Machine-readable test reports**: when the CI run uploaded one, download and hand it to the agent
  (structured per-test detail — which tests failed, messages, timings). The report format is not
  fixed; any conforming test report is acceptable.
- **Prior review context**: previous bot-authored comments on the PR, author replies, PR title and
  body. Gathered as data files by a pre-agent step, never by granting the agent network access.

These enrichments MUST be optional. When absent, the system MUST degrade gracefully (failing-job
logs for the mechanic, no prior-review context for the first run).

---

## 4. Findings schema

The canonical schema is [`schema/findings.schema.json`](schema/findings.schema.json) — JSON Schema
2020-12, inlined (no `$ref`/`$defs`/`$id` fragments) so the same file works for both JSON-Schema
validators and CLI structured-output enforcement (e.g. `claude -p --json-schema`).

### 4.1 Shape

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | `string` (semver) | yes | The findings-schema version this object conforms to (e.g. `"0.2.0"`); see §4.2. Lets a commenter detect a version mismatch rather than silently dropping fields. |
| `summary` | `string` | yes | Markdown walkthrough of the change and overall assessment |
| `verdict` | `enum[approve, comment, changes]` | yes | Overall stance; advisory only |
| `findings` | `array` | yes | Zero or more specific findings |

Each finding:

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | yes | Repo-relative file path |
| `start_line` | `integer` (≥1) | yes | 1-indexed first line of the anchored range |
| `end_line` | `integer` (≥1) | yes | 1-indexed last line; must be ≥ `start_line` (enforced by the runtime codecs; see REQ-SC-6) |
| `side` | `enum[RIGHT, LEFT]` | no (default: `RIGHT`) | RIGHT for added/changed lines, LEFT for removed lines |
| `severity` | `enum[critical, major, minor, nit]` | yes | Used for grouping and noise folding |
| `code` | `string` | no | Stable rule identifier (e.g. `"null-check-missing"`) for rule-based filtering, suppression, and cross-run dedup |
| `code_url` | `string` | no | URL documenting the rule named by `code` |
| `title` | `string` | yes | One-line summary |
| `body` | `string` | yes | Markdown explanation |
| `suggestion` | `string \| null` | no | `null` = no mechanical fix; `""` = delete `start_line..end_line`; non-empty = exact replacement for `start_line..end_line` (§5.2.4) |
| `confidence` | `number` (0..1) | no | For noise suppression; the commenter MAY suppress a finding below a configurable threshold, but MUST NOT suppress a `critical` finding on confidence alone |

### 4.2 Versioning

The schema follows [semver](https://semver.org). The **in-data conformance signal** is the
`schema_version` field (§4.1): a findings object declares which schema version it conforms to, so a
commenter can detect a version mismatch rather than silently dropping or misinterpreting fields.

A conforming commenter accepts a configurable allowlist of schema minors (currently `{0.2}`); a
document declaring a minor outside the allowlist degrades per §5.5 rather than being silently
accepted or rejected without explanation.

The schema file's `$id` URI is the schema's own identity, distinct from a finding's
`schema_version`:

```
https://raw.githubusercontent.com/JPHutchins/code-review/schema-v<version>/schema/findings.schema.json
```

The `$id` on a tagged release MUST carry that release's version tag — not `main`. The release
process MUST verify the `$id` matches the tag (a CI check or release step), since the file on
`main` carries the moving `main` ref until the tag is cut. See
[`schema/VERSIONING.md`](schema/VERSIONING.md) for the version policy.

---

## 5. Posting

The commenter produces two GitHub surfaces from the same findings JSON.

### 5.1 Sticky summary comment

An **issue comment** on the PR, found and updated by a fixed marker:

- **Marker:** `<!-- code-review -->` (fixed constant; MUST be a known value, never interpolated).
- **Reviewed-SHA marker:** `<!-- reviewed-sha: <sha> -->` — enables incremental review on subsequent
  runs.

The marker MUST be the first line of the rendered comment, so the commenter's upsert (which matches
on `startswith(marker)` AND bot author) finds the existing comment rather than posting a duplicate.

The summary SHALL include the items below. **Structural items (1, 2, 6) are normative** — a
conforming commenter MUST render them. **Presentation items (3, 4, 5) are RECOMMENDED shape** — a
commenter MAY vary their layout, but MUST preserve the information (e.g. findings MUST be grouped by
severity somewhere; cost MUST appear in a footer somewhere), even if the exact rendering differs.

1. A title with a **verdict badge** and **route** line (the route MUST reflect the actual routing
   decision per §3.1, not be inferred from side-effects like turn count).
2. A markdown walkthrough (the `summary` field).
3. Findings grouped by severity; nits folded in `<details>`.
4. A collapsible **test-results panel** when a test report is provided as input, else a CI job
   summary when one is available. The panel is **format-agnostic**: it consumes any conforming test
   report, not a single fixed format.
5. A **footer** with the per-model cost table (recomputed per §6.2), duration, and effort.
6. An **LLM Disclosure** aside naming the model(s) used, sourced from the envelope's `models`.

### 5.2 Inline review

A **pull request review** (`POST /repos/{owner}/{repo}/pulls/{n}/reviews`) with a `comments[]`
array. Each finding becomes one inline comment.

Rules (these MUST be enforced by the commenter, not the agent):

1. **In-diff only.** A finding whose `path` + anchored range endpoints (`start_line` AND `end_line`)
   do not all appear in the diff hunks MUST be demoted into the summary body — not dropped, and not
   posted as an inline comment. The inline comment anchors on `end_line` (with `start_line` for
   multi-line ranges), and posting a comment where either endpoint is absent from the diff causes
   the GitHub API to reject the entire review (`422`).
2. **Use absolute `line` + `side`** (`RIGHT` for additions), plus `start_line`/`start_side` for
   multi-line ranges. The deprecated `position` (diff-offset) field MUST NOT be used.
3. **`commit_id`** MUST be the reviewed head SHA (`workflow_run.head_sha`).
4. **Suggestions** are a fenced `suggestion` block inside the comment `body`, replacing exactly
   `start_line..end_line`. A finding's `suggestion` field has three distinct semantics: `null` — no
   mechanical fix, render no block; `""` (empty string) — delete the range, render an empty
   suggestion block; non-empty — replace the range with the given text. A suggestion spanning more
   than GitHub's single-block line limit MUST be stripped (never emitted) and reported (a warning,
   with the stripped suggestion noted in the summary); the inline comment MAY be retained without
   the suggestion block. Emitting a payload that would 422 remains prohibited.
5. **Event.** MUST post as `COMMENT`, never `REQUEST_CHANGES`. The review is advisory and MUST
   never block merge via branch protection.
6. **Re-run hygiene.** When the head SHA differs from the reviewed-SHA marker, the commenter MUST
   post a fresh review for the new head SHA and SHOULD dismiss the prior bot-authored review on the
   same PR. When the head SHA matches (a re-run of the same commit), the commenter SHOULD update
   only the sticky summary.
7. **Confidence suppression.** A finding with `confidence` below a configurable threshold (default
   `0.5`) MAY be suppressed from the inline review (demoted to a collapsed summary section, not
   dropped). A `critical`-severity finding MUST NOT be suppressed on confidence alone. The
   threshold SHOULD be configurable by the workflow.

### 5.3 Trust — author identity, not marker

The previous review is trusted **only when the comment's author login matches the bot identity**
(e.g. `github-actions[bot]`). A fork author can paste the `<!-- code-review -->` marker into their
own comment, but they cannot post as the bot identity. The marker alone MUST NOT be used to determine
trust.

### 5.4 Injection discipline

All untrusted text — diff, job logs, test reports, PR body/comments, and the findings themselves —
MUST be passed as files or structured data, never shell-interpolated. API request bodies MUST be
built with a JSON-aware tool (`jq -n --rawfile` in bash; native JSON serialization in TypeScript) so
untrusted text is always escaped before it reaches the shell or the API.

### 5.5 Inputs & error semantics

The commenter consumes two inputs produced by the review job (passed as files, never interpolated):

- **`findings`** — the findings object (§4) carried in the envelope's `findings` field (§6.1).
- **`envelope`** — the full abstract result envelope (§6.1), source of `models`, `turns`,
  `duration_ms`, and `schema_version` (the reference CLI exposes this input as `--usage`).

The reviewer's inputs (gathered by the review job, also as files) are: the diff (§3.1), the CI
result, prior bot-authored review context (§3.3), failing-job logs when CI failed, and an optional
test report. A reviewer MUST NOT be granted network access to fetch these itself — a pre-agent step
gathers them to files with the read-only token.

**Error semantics.** The commenter MUST handle these conditions deterministically rather than crash
or post a misleading comment:

| Condition | Required behavior |
|---|---|
| Empty diff (no changes) | Post a sticky summary noting the empty diff; verdict `comment`; no inline review. |
| Corrupt or absent findings artifact | Post a sticky summary noting the review did not complete; verdict `comment`; reference the run for logs. |
| Findings fail schema validation (`schema_version` mismatch or invalid shape) | Post a sticky summary noting the review output was malformed; verdict `comment`. Never post unvalidated inline comments. |
| Agent emitted a gate verdict (skipped/unsafe) instead of findings | Post the gate verdict as the sticky summary (the review job SHOULD already assemble this as a valid findings object). |
| PR was closed between trigger and run | Exit zero with a notice; post nothing. |
| No open PR for the head SHA | Exit zero with a notice; post nothing. |
| Posting fails (422 from an out-of-diff line, network, auth) | Exit non-zero (REC-CO-3) so the failure is visible; never partially post. |

---

## 6. Cost & usage reporting

### 6.1 Result envelope

The review agent's CLI invocation MUST capture its full result envelope, not just the findings. The
envelope is the **abstract, vendor-neutral cost/usage contract** the commenter recomputes from; an
adapter maps its CLI's native output onto it. The canonical field names are **spec-owned** so a
non-reference adapter need not mimic any other CLI's internal keys.

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | `string` | yes | Semver version of the findings schema this object conforms to (e.g. `"0.2.0"`); see §4.2. |
| `findings` | `object` | yes | The findings object conforming to [§4](#4-findings-schema). |
| `models` | `array<object>` | yes | Per-model token breakdown; subagent models appear as their own entries. |
| `models[].model` | `string` | yes | Model identifier as the CLI reports it. |
| `models[].input_tokens` | `integer` | yes | Input tokens consumed by this model. |
| `models[].output_tokens` | `integer` | yes | Output tokens consumed by this model. |
| `models[].cache_read_tokens` | `integer` | no | Cache-read tokens (prompt-cache hits) for this model. |
| `models[].cache_write_tokens` | `integer` | no | Cache-write tokens (prompt-cache population) for this model. |
| `turns` | `integer` | yes | Number of agentic turns taken. |
| `duration_ms` | `integer` | yes | Wall-clock duration of the review, in milliseconds. |
| `vendor_cost_usd` | `number` \| `null` | no | CLI-reported cost, vendor-priced — MUST NOT be used as canonical; recompute from `models` (§6.2). |

```jsonc
{
  "schema_version": "0.2.0",
  "findings": { /* …per §4… */ },
  "models": [
    { "model": "deepseek-v4-pro",   "input_tokens": 0, "output_tokens": 0,
      "cache_read_tokens": 0, "cache_write_tokens": 0 },
    { "model": "deepseek-v4-flash", "input_tokens": 0, "output_tokens": 0,
      "cache_read_tokens": 0, "cache_write_tokens": 0 }
  ],
  "turns": 7,
  "duration_ms": 91234,
  "vendor_cost_usd": null
}
```

A reference adapter's **native** envelope (e.g. Claude Code's `--output-format json`, with its
`modelUsage`/`usage`/`num_turns`/`structured_output`/`result` keys) is mapped to this abstract
shape by the adapter; the mapping is documented in [`docs/adapters.md`](docs/adapters.md). The
commenter consumes the abstract shape only — it MUST NOT depend on any adapter's internal field
names.

When structured-output enforcement is imperfect or absent, a conforming adapter MUST deterministically recover `findings` via an ordered extraction ladder (agent-file → structured output → parsed result → fenced block, exactly-one-validating), preferring an agent-written, self-validated findings file over parsing free-text output.

### 6.2 Price map

A conforming implementation SHALL maintain a date-stamped **price map** conforming to
[`schema/prices.schema.json`](schema/prices.schema.json) (an example lives at
`schema/prices.example.json`), and recompute cost from `models`:

```
cost = Σ_model (
    input_tokens      · price_in
  + output_tokens     · price_out
  + cache_read_tokens · price_cache_read
  + cache_write_tokens· price_cache_write
) / 1e6
```

A model with no entry in the price map, or a token field the map doesn't price, MUST be reported by
the commenter (e.g. a stderr warning) rather than silently zeroed — silent zeros make a stale price
map invisible. The CLI's `vendor_cost_usd` (§6.1) is vendor-priced and will be wrong for other
backends. The recomputed value is the canonical cost.

### 6.3 Footer

The comment footer SHALL render a per-model table recomputed from `models` (§6.1) against the price
map (§6.2):

```
| Model | Input | Output | Cache read | Cache write | Cost |
|---|---|--:|--:|--:|--:|--:|
| … | … | … | … | … | $… |
| **Total** | … | … | … | … | **$…** |

Route: full review (all green) · effort: max · turns: 7 · wall: 91s
```

The footer's `Route` line MUST reflect the actual routing decision (§3.1), not be inferred from
side-effects such as turn count. Followed by an LLM Disclosure aside naming the model(s) from
`models`.

---

## 7. Threat model & required controls

### 7.1 Assets

- **Model API key** — a bearer token that spends money. Primary target.
- **GitHub write token** — can post comments and reviews. Secondary target.
- **Runner filesystem** — temporary, but the review job's env holds the model key.

### 7.2 Threats

| Threat | Control |
|---|---|
| PR diff prompts model to exfiltrate secrets | Preflight triage (§7.3); read-only token; egress lock; spend cap |
| Model output contains injection payloads | Commenter is deterministic; all text JSON-escaped before API call |
| Model output injects into the review itself (a finding body aimed at the maintainer — "ignore previous instructions", phishing links) | Findings `body` is untrusted text rendered as markdown; treated as any PR comment; GitHub's renderer strips scripts (defense-in-depth) |
| Injected extra JSON block in agent output (append-a-block to smuggle a differing verdict) | Extraction ladder (§6.1) requires exactly-one validating candidate; ambiguous output fails closed (findings: non-zero exit; triage: `safe:false`) |
| Fork PR redirects review to wrong target | PR number resolved from trusted `head_sha` + disambiguated by `head_branch`; CI event is not fork-controlled (§8.3) |
| Prior review marker spoofed by fork author | Trust by author identity (bot login), not by marker (§5.3) |
| CI job logs contain secrets | Logs are untrusted; passed as data, never interpolated |
| Spend runaway | Burner key with hard spend cap; `timeout-minutes` on job; `concurrency` cancel on force-push |
| Denial-of-wallet via repeated force-pushes | `concurrency` group keyed on the head SHA cancels superseded runs (§8.2) |
| Resource exhaustion (huge diff or test report) | Diff-size cap + truncation detection (§3.1); input size limits on enrichment |
| Tampered findings artifact between jobs | Artifact integrity is GitHub-managed (signed URLs, run-id-scoped download); the comment job never executes artifact content — only deserializes it |

### 7.3 Preflight security triage

Before applying and executing untrusted PR code, a conforming implementation SHOULD run a **data-only**
security triage of the diff — reading the diff text and surrounding source, never executing. The
triage SHOULD screen for:

- Prompt injection (text aimed at manipulating the AI reviewer).
- Attempts to read, log, or exfiltrate environment variables, secrets, or tokens.
- Network calls to unexpected hosts.
- Changes to CI/CD workflows, git hooks, or build/test scripts that could execute arbitrary code.
- Obfuscated or encoded payloads.

The triage is a **heuristic first filter** — it reads the same untrusted diff an injection would ride
in. The triage decision MUST fail closed: any ambiguous, malformed, or unrecoverable Phase 1 output
is treated as `safe:false`, never defaulted to safe. The controls that actually hold are:

1. **Read-only token** on the agent job.
2. **Egress lock** (e.g. harden-runner `egress-policy: block` with an explicit allowlist).
3. **Burner key with a hard spend cap** — the backstop; the residual exfil channel is the public
   comment.

### 7.4 Required controls (conformance)

A conforming implementation MUST:

- Run the review agent with a **read-only** GitHub token (`contents: read` + `actions: read`).
- Run the commenter in a **separate job** with **no model key and no PR code**.
- Lock network egress on **both** jobs — the review job (holds the model key) and the comment job
  (holds the write token) — to minimal allowlists.
- Use a burner model key with a hard spend cap, configured at the provider; the workflow SHOULD
  additionally enforce a per-run token budget (computed from the envelope's `models`) and abort to
  a notice comment if a ceiling is exceeded.
- Pass all untrusted content (diff, logs, PR body/comments, findings) as files or structured data,
  never shell-interpolated.
- Build all API request bodies with JSON-aware tools (`jq --rawfile` in bash; native JSON
  serialization in TypeScript) so untrusted text is escaped before it reaches the shell or API.
- Resolve the PR number from the trusted `workflow_run.head_sha` (+ `head_branch` disambiguation).
- Post the GitHub review as `COMMENT`, never `REQUEST_CHANGES`.

---

## 8. GitHub Actions binding

This section provides the concrete workflow shape for GitHub Actions users. It is the GitHub
realization of the abstract contract in [§3.1](#31-abstract-contract); normative for implementations
targeting GitHub, descriptive for other CI systems.

### 8.1 File layout

Two files total:

- `ci.yaml` — the existing CI workflow. **Unchanged.**
- `review.yaml` — the privileged review workflow (two jobs: `review` + `comment`).

### 8.2 `review.yaml` shape

```yaml
name: Code review

on:
  workflow_run:
    workflows: ["CI"]       # your existing CI workflow name
    types: [completed]

concurrency:                 # cancel superseded runs; bounds spend on force-push
  group: review-${{ github.event.workflow_run.head_sha }}
  cancel-in-progress: true

jobs:
  review:
    if: >-
      github.event.workflow_run.event == 'pull_request' &&
      (github.event.workflow_run.conclusion == 'success' ||
       github.event.workflow_run.conclusion == 'failure')
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      actions: read
      pull-requests: read
      issues: read
    steps:
      - uses: actions/checkout@v7       # SHA-pin for auditability (§8.5)
      - uses: actions/setup-node@v6

      # Lock egress BEFORE untrusted data touches the agent, AFTER trusted setup
      - uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4

      # Phase 1: data-only security triage of the diff
      # Phase 2: if safe, agentic review → abstract envelope (§6.1)

      - uses: actions/upload-artifact@v7
        with:
          name: code-review-findings
          path: findings/

  comment:
    needs: review
    if: ${{ always() && (needs.review.result == 'success' || needs.review.result == 'failure') }}
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      issues: write
      actions: read
    steps:
      - uses: actions/download-artifact@v8
        with: { name: code-review-findings }

      # The comment job holds the WRITE token and runs NO agent, NO PR code —
      # so it MUST also have a locked egress allowlist (api.github.com + blob host only).
      - uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4

      # Deterministic posting (resolves PR from head_sha, validates diff, renders, posts;
      # reads the write token from GH_TOKEN):
      #   code-review post findings/findings.json --repo … --head-sha … --head-branch … \
      #     --usage … --route … --effort … --prices …
```

The full, copy-paste-ready example lives in [`examples/workflows/review.yaml`](examples/workflows/review.yaml).

### 8.3 PR number resolution

```bash
PR=$(gh api "repos/$REPO/commits/$HEAD_SHA/pulls" \
      --jq ".[] | select(.head.ref == \"$HEAD_REF\") | .number" | head -n1)
```

`HEAD_SHA` comes from `github.event.workflow_run.head_sha` and `HEAD_REF` from
`workflow_run.head_branch` — both trusted. Disambiguating by `head_ref` avoids posting to the wrong
PR when multiple open PRs share a commit. The fork-controlled artifact carrying the diff MUST NOT
carry or override the PR number. Resolution SHOULD happen once (inside the commenter command), not
independently in each job, to avoid split-brain when PR state changes between jobs.

### 8.4 Egress allowlist

**Both** jobs lock egress — the review job (holds the model key) and the comment job (holds the write
token). Run `egress-policy: audit` on a first run to discover the real endpoints, then pin:

```
api.<model-provider>.com:443
api.anthropic.com:443           # the CLI phones home even on non-Anthropic backends
github.com:443
api.github.com:443
objects.githubusercontent.com:443
*.blob.core.windows.net:443     # artifact download
results-receiver.actions.githubusercontent.com:443  # artifact upload
```

Plus ecosystem registries (pypi.org, npmjs.org, etc.) if the agent needs to install packages to
validate findings.

### 8.5 Model backend env

The reference adapter (Claude Code) uses DeepSeek via an Anthropic-compatible endpoint:

```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=${{ secrets.MODEL_API_KEY }}
ANTHROPIC_MODEL=deepseek-v4-pro
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
CLAUDE_CODE_EFFORT_LEVEL=max
```

These env names are Claude-Code-specific; other adapters use their own configuration mechanism. The
abstract requirement (§2.2) is that the adapter accepts a model backend URL, a model identifier, and
optionally a subagent model identifier and an effort level. Any Anthropic-compatible backend works
with the Claude Code adapter's env shape above.

The binding MUST NOT default the backend endpoint: it is explicit operator configuration (the
reference workflow requires an `API_BASE_URL` repository variable and fails before any model call
when it is unset), because a CLI left to fall back to its own vendor's API would send the model key
to an endpoint the operator never chose.

---

## 9. Conformance

### 9.1 Review agent

A conforming review agent MUST:

- **REQ-RA-1:** Emit findings as structured JSON conforming to the published findings schema (§4).
- **REQ-RA-2:** Emit the abstract result envelope (§6.1) — `schema_version`, `findings`, `models`
  (per-model token counts incl. subagents), `turns`, `duration_ms`; map the adapter's native CLI
  output onto these spec-owned field names.
- **REQ-RA-3:** Not hold or use a writable GitHub token.
- **REQ-RA-4:** Not post comments, reviews, or any other content to GitHub.
- **REQ-RA-5:** Be subject to an egress lock and a hard spend cap (§7.3).
- **REQ-RA-6:** Route behavior on the CI result — full review on pass, mechanic-only pass on fail,
  skip on cancelled/skipped/not-run (§3.1).

A conforming review agent MAY satisfy REQ-RA-1's and REQ-RA-2's findings requirement by writing a
self-validated findings file for the commenter's deterministic extraction ladder (§6.1) to recover,
rather than relying solely on structured-output enforcement.

A conforming review agent SHOULD:

- **REC-RA-1:** Run a data-only security triage before executing PR code (§7.3).
- **REC-RA-2:** Accept prior review context and job logs as data files (§3.3).

### 9.2 Commenter

A conforming commenter MUST:

- **REQ-CO-1:** Post a sticky summary comment with the `<!-- code-review -->` marker (§5.1).
- **REQ-CO-2:** Post an inline PR review as `COMMENT`, never `REQUEST_CHANGES` (§5.2).
- **REQ-CO-3:** Validate each finding's anchored range endpoints (`start_line` AND `end_line`)
  against the diff and demote a finding into the summary body if either endpoint is out-of-diff
  (§5.2 rule 1).
- **REQ-CO-4:** Use the modern absolute `line` + `side` API; never the deprecated `position` field
  (§5.2 rule 2).
- **REQ-CO-5:** Trust the previous review by author identity (bot login), not by marker (§5.3).
- **REQ-CO-6:** Never shell-interpolate untrusted text; build all API bodies with JSON-aware
  serialization (§5.4).
- **REQ-CO-7:** Not hold a model API key, run a model, or execute PR code (§2.3).
- **REQ-CO-8:** Render a cost/usage footer recomputed from `models` against a date-stamped price
  map (§6). A model missing from the price map MUST be reported, not silently zeroed.
- **REQ-CO-9:** Render a test-results panel when a test report is provided as input; else render
  a CI job summary when one is available (§5.1). The panel is format-agnostic — it consumes any
  conforming test report, not a single fixed format.
- **REQ-CO-10:** Include an LLM Disclosure aside naming the model(s) used, sourced from `models`
  (§5.1, §6.1).

- **REQ-CO-11:** Set the inline review's `commit_id` to the reviewed head SHA (§5.2.3).
- **REQ-CO-12:** Render each suggestion as a fenced `suggestion` block inside the comment `body`,
  replacing exactly `start_line..end_line`; a `null` suggestion renders no block, an empty-string
  suggestion (`""`) renders a deletion block, and a non-empty suggestion renders a replacement
  (§4.1, §5.2.4).
- **REQ-CO-13:** Strip (never emit) a suggestion block that spans more than GitHub's single-block
  line limit, report it (a warning, with the stripped suggestion noted in the summary), and MAY
  retain the inline comment without it — never emit a review payload that will 422.

A conforming commenter SHOULD:

- **REC-CO-1:** Collapse nit findings in `<details>` (severity folding).
- **REC-CO-2:** When the head SHA differs from the reviewed-SHA marker, dismiss the prior
  bot-authored review on the same PR and post a fresh review for the new head SHA; when the head
  SHA matches (a re-run of the same commit), update only the sticky summary. Dismissal failure
  (already dismissed, missing scope) MUST be logged and continue — never fail the job on dismissal.
- **REC-CO-3:** Exit non-zero when posting fails (422, network) so failures are visible; exit zero
  only when there is nothing to post (no open PR). The review check MUST NOT be a required check
  in branch protection — advisory-only is enforced by configuration, not by exit code (§5.2.5).

### 9.3 CI system binding (for GitHub Actions)

A conforming GitHub Actions binding MUST:

- **REQ-GH-1:** Trigger the review off `workflow_run` of the CI workflow (§3.1).
- **REQ-GH-2:** Split the review and comment jobs with separate token scopes (§2.4).
- **REQ-GH-3:** Resolve the PR number from `workflow_run.head_sha` (§8.3).
- **REQ-GH-4:** Not modify the existing CI workflow.

### 9.4 Schema

A conforming findings schema MUST:

- **REQ-SC-1:** Be a valid JSON Schema (2020-12).
- **REQ-SC-2:** Be inlined (no `$ref`/`$defs`/`$id` fragments) so it works for both validators and
  CLI structured-output enforcement.
- **REQ-SC-3:** Follow semantic versioning; each version SHALL have a distinct, stable `$id` URI.
- **REQ-SC-4:** Require at minimum `schema_version`, `summary`, `verdict`, `findings`; each finding
  MUST require `path`, `start_line`, `end_line`, `severity`, `title`, and `body`.
- **REQ-SC-5:** Declare `suggestion` as `string | null` with `""` (delete) and non-empty (replace)
  both valid; `null` (no fix) is the only absence sentinel.
- **REQ-SC-6:** Constrain both `start_line` and `end_line` `>= 1` in the schema; the schema MAY
  approximate the cross-field `end_line >= start_line` invariant where the schema language allows,
  but the invariant MUST be enforced by the runtime codecs.
- **REQ-SC-7:** Allow an optional `code` (stable rule identifier) and `code_url` per finding, for
  rule-based filtering, suppression, cross-run dedup, and SARIF export.

---

## 10. Adapters

Each agent CLI is treated as a pluggable **adapter** behind one interface:

- **In:** diff text + CI result + context file (prior review, PR conversation, optional test report).
- **Out:** the abstract result envelope (§6.1) — `findings` conforming to the
  [findings schema](schema/findings.schema.json) plus `models`/`turns`/`duration_ms`/`schema_version`.

The reference adapter is **Claude Code** (`claude -p "/code-review" --json-schema … --output-format json`,
whose native `.structured_output` the adapter maps onto the abstract envelope's `findings`). An
**OpenCode** or other CLI adapter drops into the same contract.

See [`docs/adapters.md`](docs/adapters.md) for the adapter contract, the Claude Code reference
adapter, and guidance for writing new adapters.
