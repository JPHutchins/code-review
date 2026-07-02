# code-review

Build an **agentic pull-request reviewer out of workflow YAML you own** — no marketplace Action, no
hosted GitHub App, no SaaS reviewer. A headless coding-agent CLI reviews the PR; deterministic glue
you control posts a sticky summary and inline suggestions. **Claude Code (`claude -p`) is the reference
adapter — the same shape fits other agent CLIs (e.g. OpenCode) and any Anthropic-compatible model
backend.** You own the prompt, the schema, the security boundary, and the cost.

> **Status: spec in progress.** The approach is proven — a live review on
> [camas PR #17](https://github.com/JPHutchins/camas/pull/17#issuecomment-4859543691). This repo turns
> it into a reusable **spec + schema + helpers + templates**.

## Why "no Action"

| Because there's no Action… | You get |
| --- | --- |
| The backend is a CLI + `ANTHROPIC_BASE_URL` + a model env | **Agent- & model-agnostic** — no vendor lock |
| The prompt, schema, and gate live in your repo | **Transparent & auditable** |
| You choose token scopes / egress / spend cap | **You own the security boundary** |
| The orchestration is just a CLI call | **Portable** — GitHub is a thin posting adapter |

## What's here

- **[HANDOFF.md](HANDOFF.md)** — start here: context, locked decisions, reference facts, what to build.
- **[docs/design.md](docs/design.md)** — the full design + roadmap (the rationale, with a mermaid data flow).
- **[schema/findings.schema.json](schema/findings.schema.json)** — the structured JSON a review agent emits.
- **[schema/prices.example.json](schema/prices.example.json)** — token→USD price map (recompute cost yourself).
- **[examples/workflows/](examples/workflows/)** — the **proven** reference workflows + the v1→v2 delta.
- **[examples/templates/comment.example.md](examples/templates/comment.example.md)** — the target comment look.

## Not built yet (see HANDOFF §8)

`SPEC.md` (normative, provider-agnostic) · an `npx` helper package (render / inline-payload / cost /
validate) · real templates · the v2 single-file example workflow · a `LICENSE`.

## Quickstart (today)

Copy `examples/workflows/*` into `.github/workflows/`, add a burner model key as a repo secret (with a
hard spend cap), merge to your default branch, then open a test PR. See
[examples/workflows/README.md](examples/workflows/README.md) for caveats and the v2 direction.

## License

TBD — add before publishing (MIT or Apache-2.0 are typical for a spec + schema).

## Trademarks

"Claude" and "Claude Code" are trademarks of Anthropic, PBC. "OpenCode", "DeepSeek", and "GitHub" are
trademarks of their respective owners. This project is independent and is **not affiliated with,
sponsored by, or endorsed by** any of them; their names are used nominatively only, to refer to the
tools an adapter targets.

> [!NOTE]
> **LLM Disclosure** — the initial design, schema, and handoff in this repo were authored by
> claude-opus-4-8 on behalf of [@JPHutchins](https://github.com/JPHutchins), who prototyped and proved
> the approach in [camas](https://github.com/JPHutchins/camas) and asked for a clean spec repo with a
> full context handoff.
