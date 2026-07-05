# code-review

Build an **agentic pull-request reviewer out of workflow YAML you own** — no marketplace Action, no
hosted GitHub App, no SaaS reviewer. A headless coding-agent CLI reviews the PR and emits structured
findings; a deterministic commenter you control renders and posts the sticky summary and inline
suggestions. **Claude Code (`claude -p`) is the reference adapter — the same shape fits other agent
CLIs (e.g. OpenCode) and any Anthropic-compatible model backend.** You own the prompt, the schema,
the security boundary, and the cost.

> **Status: alpha.** The approach is proven — a live review on
> [camas PR #17](https://github.com/JPHutchins/camas/pull/17#issuecomment-4859543691). This repo is
> the reusable **spec + schema + CLI + templates**: [SPEC.md](SPEC.md) is normative, the schemas live
> in [schema/](schema/), and the commenter ships as
> [`@jphutchins/code-review`](https://www.npmjs.com/package/@jphutchins/code-review).

## Why "no Action"

| Because there's no Action… | You get |
| --- | --- |
| The backend is a CLI + `ANTHROPIC_BASE_URL` + a model env | **Agent- & model-agnostic** — no vendor lock |
| The prompt, schema, and gate live in your repo | **Transparent & auditable** |
| You choose token scopes / egress / spend cap | **You own the security boundary** |
| The orchestration is just a CLI call | **Portable** — GitHub is a thin posting adapter |

## The CLI

The npm package is the **deterministic commenter** — the presentation and posting layer that no
model should do, plus the adapter glue between an agent CLI's native output and the spec's abstract
envelope ([SPEC §6.1](SPEC.md#61-result-envelope)).

```sh
npm install -g @jphutchins/code-review
# or per invocation:
npx @jphutchins/code-review <subcommand>
```

| Subcommand | What it does |
| --- | --- |
| `post` | Post a complete review (inline comments + sticky summary) from findings + envelope + diff — the one-call path |
| `gather` | Resolve the PR from the CI head SHA and gather the review inputs (diff with git-diff fallback, PR context, prior bot review, failing-job logs) into the workspace for the agent |
| `render` | Render the sticky-comment markdown from findings + usage + prices |
| `inline` | Build the GitHub reviews `comments[]` payload from findings + diff (in-diff validation; strays demote to the summary) |
| `adapt` | Map a native agent-CLI result envelope onto the abstract SPEC §6.1 envelope |
| `extract` | Recover findings/triage JSON from a native envelope via the deterministic extraction ladder |
| `cost` | Recompute USD cost from the envelope's per-model token counts + a price map |
| `validate` | Validate findings JSON against the published schema |
| `print-schema` | Print a bundled schema (findings, triage, prices) |

Every helper is usable standalone; the reference workflow composes them. The comment templates are
user-swappable — pass `--template` / `--inline-template` to `post` to override the bundled defaults
in [templates/](templates/). See [docs/adapters.md](docs/adapters.md) for the adapter contract and
`code-review <subcommand> --help` for flags.

## Quickstart

1. Copy [examples/workflows/review.yaml](examples/workflows/review.yaml) into `.github/workflows/`.
   Your existing CI workflow is untouched — edit the `workflows: ["CI"]` filter to match its `name:`.
2. Set the `API_BASE_URL` Actions **variable** — your provider's Anthropic-compatible endpoint,
   e.g. `https://api.deepseek.com/anthropic` — and add a repo secret `MODEL_API_KEY`, a **burner
   key with a hard spend cap** (it is exposed to untrusted PR code during the contained review
   window). Both are required: with no endpoint configured the workflow fails loudly rather than
   letting the CLI pick where your key gets sent.
3. Commit `.github/prices.json` (fork [schema/prices.example.json](schema/prices.example.json) and
   fill in your provider's per-token rates) — without it the cost footer renders **$0**
   ([SPEC §6.2](SPEC.md#62-price-map)).
4. Merge to your default branch first — `workflow_run` only fires from the default branch, so the
   introducing PR won't review itself — then open a test PR.
5. First run: consider `egress-policy: audit` to discover the real allowlist, then switch to `block`
   ([SPEC §8.4](SPEC.md#84-egress-allowlist)).

Every model knob is committed step `env` on the workflow's triage and review steps — models,
efforts, the subagent model, and the tier aliases, right where each is consumed — edited and
PR-reviewed like the rest of the file ([SPEC §8.5](SPEC.md#85-model-backend-env)). Only the backend
endpoint is a per-repo **Actions variable** (`API_BASE_URL`, required, no default); pointing it at
another provider requires adding that provider's API host to the workflow's egress allowlist in the
same reviewed PR.

## What's here

- **[SPEC.md](SPEC.md)** — the normative, provider-agnostic specification.
- **[schema/](schema/)** — the findings/triage/prices JSON Schemas + the version policy.
- **[src/](src/)** — the commenter CLI (published as `@jphutchins/code-review`).
- **[docs/adapters.md](docs/adapters.md)** — the adapter contract + the Claude Code reference adapter.
- **[docs/design.md](docs/design.md)** — rationale and history.
- **[examples/workflows/review.yaml](examples/workflows/review.yaml)** — the copy-paste reference workflow.

## License

[MIT](LICENSE)

## Trademarks

"Claude" and "Claude Code" are trademarks of Anthropic, PBC. "OpenCode", "DeepSeek", and "GitHub" are
trademarks of their respective owners. This project is independent and is **not affiliated with,
sponsored by, or endorsed by** any of them; their names are used nominatively only, to refer to the
tools an adapter targets.

> [!NOTE]
> **LLM Disclosure** — this repo's design, spec, schemas, and implementation were authored by
> Anthropic Claude models (claude-opus-4-8 for the initial design and schema; claude-fable-5 with
> Opus/Sonnet subagents for the spec tightening and implementation) on behalf of
> [@JPHutchins](https://github.com/JPHutchins), who prototyped and proved the approach in
> [camas](https://github.com/JPHutchins/camas) and directs and reviews the work.
