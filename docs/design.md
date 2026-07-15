# AI Code Review Without a Black Box — design rationale & history

> **What this is.** The *why* document: the rationale behind the design, the alternatives that were
> weighed and rejected, and the history of how this project got here. The **normative** description —
> schemas, requirements, the concrete workflow — lives in [`SPEC.md`](../SPEC.md); where this doc
> touches a normative detail it links there rather than restating it, so there is one source of truth.
>
> The project is named `code-review`. Claude Code, DeepSeek, camas, and OpenCode are named
> nominatively — the tools an adapter targets — and no affiliation or endorsement is implied.

---

## Thesis: the advantage is that there is *no* Action

There is no marketplace Action here, no hosted GitHub App, no third-party SaaS reviewer
(CodeRabbit / Greptile / Copilot / the Claude GitHub App). The whole system is:

- **workflow YAML you can read top to bottom**, reviewed in the same PR flow as the code it guards,
- a headless coding-agent CLI invocation (Claude Code `claude -p` is the reference adapter, but the
  interface is agent-agnostic), and
- `gh api` to post the result.

That is the product. The advantages are not incidental — they *fall out* of there being no Action: the
backend is `ANTHROPIC_BASE_URL` + a model env, so it is model-agnostic; the prompt, schema, and gate
live in your repo, so it is auditable; you choose the token scopes, egress, and spend cap, so you own
the security boundary; the orchestration is just a CLI call, so GitHub is a thin posting adapter you
can swap. See [`SPEC.md` §1](../SPEC.md#1-overview--thesis) for the normative statement of these
properties.

---

## Why route on the CI result

The routing signal is the **native CI outcome**, which every repo already has — not a machine-readable
test report, and not any camas-specific artifact. Triggering the privileged review off CI *completion*
(rather than off the PR) gets three things at once: the result arrives for free, CI is guaranteed to
have finished before a model token is spent, and the trigger is not fork-controlled. Green code gets a
full agentic review; red code gets a fast mechanic pass that only proposes minimal fixes from the
failing-job logs — because paying a max-effort agent to review code that doesn't pass yet is premature
and wasteful.

This is deliberately the *universal core*: a reader whose repo has never heard of camas must be able to
implement the whole thing. A machine-readable test report (camas emits one via its
[Ctrf effect](https://github.com/JPHutchins/camas/blob/main/src/camas/effect/ctrf.py)) is **optional
enrichment** layered on top — sharper mechanic fixes and richer green-path evidence when present, with
failing-job logs covering the absence. It must never become a requirement. The normative trigger and
routing contract is [`SPEC.md` §3.1](../SPEC.md#31-trigger--routing).

---

## Why the security boundary is a token split, not the triage

The design's hardest constraint is that the review agent runs *untrusted PR code* while holding a model
key. The instinct is to lean on the preflight triage (does this diff look safe to apply and execute?),
but the triage reads the very same untrusted diff an injection payload would ride in — so it is a
**heuristic first filter, not the containment**. The controls that actually hold are structural: a
read-only GitHub token on the agent job, an egress lock on the runner, and a **burner model key with a
hard spend cap**. The residual exfiltration channel is the public comment/log itself, which is exactly
why the spend cap — not the gate — is the real backstop.

That reasoning is what forces the **two-job split**: the job that holds the write token (the commenter)
runs no model and no PR code, and the job that runs the model holds only a read-only token. The split
*is* the boundary. The normative threat model and required controls are
[`SPEC.md` §4](../SPEC.md#4-threat-model--required-controls); the conformance requirements are
[`SPEC.md` §5](../SPEC.md#5-conformance).

---

## Why structured output plus a deterministic commenter

Two independent motivations converge on the same shape: the agent emits **data**, and a deterministic
commenter owns **presentation and posting**.

The security motivation is injection safety — model output must never be string-concatenated into a
shell command or an API body near a write token (§4.4). The correctness motivation is that the fiddly,
must-not-get-wrong logic — validating each finding's line against the diff hunks so an out-of-diff
comment doesn't 422 the *entire* review, mapping to the modern `line`/`side` API, sizing suggestion
blocks — is deterministic work no model should do. Both point at: structured findings in, rendered
markdown out. The commenter's principles (deterministic, truthful, no claim of an unposted surface)
are normative in [`SPEC.md` §3.3](../SPEC.md#33-the-commenter); these inline-posting mechanics are
owned by [`src/inline.ts`](../src/inline.ts), [`src/render.ts`](../src/render.ts), and
[`src/post.ts`](../src/post.ts).

### Why an extraction ladder, and not just `--json-schema`

The original plan was simple: pass the reviewer a `--json-schema` and read the validated object back
out of `.structured_output`. In practice the Claude Code CLI does **not** reliably populate
`.structured_output` when given `--json-schema` (GitHub issues
[#18536](https://github.com/anthropics/claude-code/issues/18536),
[#27926](https://github.com/anthropics/claude-code/issues/27926)). That empirical finding is why the
adapter recovers findings through an **ordered extraction ladder** instead of trusting one field:
agent-written self-validated file → structured output → pure-JSON result → fenced block, requiring
*exactly one* validating candidate so an injected extra JSON block can't smuggle a differing verdict,
and failing closed for triage. Preferring an agent-written file (written to a path *outside* the
worktree) also closes the door on a PR planting a same-named findings file inside the repo. The ladder
is [`src/extract.ts`](../src/extract.ts); the native→abstract envelope mapping is
[`src/adapt.ts`](../src/adapt.ts); the contract is [`SPEC.md` §3.2](../SPEC.md#32-the-deliverable) and
[`docs/adapters.md`](adapters.md).

### Why recompute cost instead of trusting the CLI

A CLI's reported `total_cost_usd` is priced against *its* vendor's rate card (Anthropic's), so it is
simply wrong for a DeepSeek or any other non-Anthropic backend. The commenter therefore recomputes cost
from the per-model token counts against a date-stamped price map, and reports (never silently zeroes) a
model the map doesn't price — a stale price map should be visible, not invisible. Subagent models show
up as their own entries, which is how per-model reporting including subagents works. See
[`SPEC.md` §4.4](../SPEC.md#44-required-controls-conformance) and [`src/cost.ts`](../src/cost.ts).

---

## Alternatives weighed and rejected

These were live design questions; recording the resolutions (and what was given up) is the point of
this doc.

- **Orchestrator: bespoke YAML vs a task-runner task.** Long-term direction is to make the review a
  task that runs identically locally and in CI, with GitHub reduced to a thin posting adapter — the
  truest "no Action." YAML stays as the trigger + secret/egress boundary. The shipped reference is
  still workflow-driven.
- **The unprivileged collector — dropped.** The camas MVP had a separate unprivileged workflow that
  produced the diff as an artifact. Triggering off CI completion gives the routing signal for free and
  the diff is fetched as inert data via the REST API (`Accept: …diff` executes nothing), so the
  collector became redundant — leaving two files: the unchanged `ci.yaml` and one privileged
  `review.yaml`. What was given up: the defense-in-depth framing that the privileged job's only inputs
  were the trusted base plus one inert artifact — judged not worth a third file, since fork code is
  still applied and executed *only* post-triage under the egress lock.
- **Inline delivery: reviews API vs individual comments.** The single reviews API call won, with
  diff-validation and demotion of out-of-diff findings into the summary body — one 422 rejects the
  whole review, so validation is mandatory either way and the single call is simpler.
- **Price-map SSOT.** A committed, date-stamped example price map (readers fork it) rather than a
  hard-coded table — prices drift and belong in data, not code.
- **Incremental vs full review each run, and re-run stacking.** On a re-review the seed compares the
  prior comment's `<!-- reviewed-sha: … -->` against the current head to steer the agent — validate the
  seeded findings and spend the rest of the budget on new ones when the commit is unchanged, or check
  what the new commits addressed and review the newly-changed code when it moved. The sticky *summary*
  comment is editable (find-and-PATCH) while a fresh *review* is posted per head SHA with the prior bot
  review dismissed.
- **Advisory only.** The review posts as `COMMENT`, never `REQUEST_CHANGES`, and must never be a
  required check — advisory-only is enforced by configuration, not by exit code.

`<!-- code-review -->` is the deliberate, fixed sticky-comment marker (a product constant, never
interpolated); trust in a prior review comes from the comment's **bot author identity**, never from the
presence of that marker, which a fork author can paste into their own text.

---

## History & provenance

**Extracted from camas.** This project was prototyped and *proven* in a different repo — **camas**,
a parallel task-tree runner: <https://github.com/JPHutchins/camas>. The reference implementation
posted a real sticky review comment on a live PR —
[camas PR #17](https://github.com/JPHutchins/camas/pull/17#issuecomment-4859543691) — and that run's
`step-security/harden-runner` egress log confirmed the designed containment actually held (only the
DeepSeek/Anthropic APIs, PyPI/uv, and GitHub hosts were contacted; the runner's eBPF "armour" engaged).
There was no "v1" beyond that MVP: a collector + review-workflow pair on the camas repo. This repo is
the generalization of that MVP into a provider-agnostic spec, schema, and CLI.

**What generalizing meant.** The MVP was camas-flavored throughout, and neutralizing that was much of
the early work: the triage prompt enumerated Python-ecosystem execution vectors (`setup.py`,
`conftest.py`, build backends) and became "build/test/CI scripts and anything that runs on install or
test"; the phase-2 system prompt said "run this project's checks (`uv run camas`)" and became "run this
project's checks (see its README/contributing docs)"; the `astral-sh/setup-uv` step gave way to
ecosystem-neutral setup; and the vendor-branded `claude-code-review` / `<!-- claude-code-review -->`
names were replaced with the generic `code-review` / `<!-- code-review -->`. The camas repo continues
to iterate the working implementation; this repo is the spec/schema/helpers the implementation conforms
to.

**What has shipped since the extraction.** The abstract, vendor-neutral result envelope
([`SPEC.md` §3.2](../SPEC.md#32-the-deliverable), [`src/adapt.ts`](../src/adapt.ts)) and the
extraction ladder above ([`src/extract.ts`](../src/extract.ts)); a version-aware schema registry that
dispatches on a document's `schema_version` against a supported allowlist
([`src/registry.ts`](../src/registry.ts), [`schema/VERSIONING.md`](../schema/VERSIONING.md); findings
schema is now `0.4.0`); a CLI with `render`/`inline`/`post`/`adapt`/`cost`/`validate`/`print-schema`/`extract`
subcommands ([`src/index.ts`](../src/index.ts)), published to npm as `@jphutchins/code-review` via OIDC
trusted publishing ([`.github/workflows/release.yaml`](../.github/workflows/release.yaml)); and the
single-file reference workflow ([`examples/workflows/review.yaml`](../examples/workflows/review.yaml)).

Two HIGH-severity workflow issues were found and fixed while hardening that reference workflow, and both
are worth remembering because they are the kind of thing the token-split boundary does *not* catch on
its own:

- **Attacker-plantable findings file.** The agent writes its self-validated findings to `$RUNNER_TEMP`,
  outside the checked-out worktree — a PR diff can `git apply` a same-named `findings-draft.json` into
  the repo, but never into the runner temp dir, so the extraction ladder's top rung can't be won by
  attacker-controlled content.
- **`$GITHUB_OUTPUT` heredoc injection.** The triage step emits its `safe`/`reasons` outputs with a
  per-run *random* heredoc delimiter and a fail-closed `EXIT` trap, so untrusted `reasons` text cannot
  forge a `safe=true` output by embedding a fixed delimiter, and any operational failure defaults to
  unsafe.

**LLM authorship, disclosed.** This system and repo are largely LLM-authored, and that is disclosed
deliberately rather than hidden — the initial design, schema, and handoff were authored by
`claude-opus-4-8` on behalf of [@JPHutchins](https://github.com/JPHutchins), who prototyped and proved
the approach in camas and then asked for a clean spec/schema repo. The README and `SPEC.md` carry the
standing trademark and LLM-disclosure notices; posts and commits made under the maintainer's identity
carry the disclosure convention too.
