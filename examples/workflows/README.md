# Example workflows

[`review.yaml`](review.yaml) is the copy-paste reference workflow for the spec's
[GitHub Actions binding](../../SPEC.md#appendix-a--reference-realization-github-actions-non-normative):
a single file, two jobs, triggered by your existing CI workflow completing. Its routing follows
[SPEC §3.1](../../SPEC.md#31-trigger--routing) — CI success gets the comprehensive reviewer, CI failure
gets the fast "mechanic" that proposes minimal fixes from the failing-job logs.

- **`review` job** — holds the model key + a **read-only** token + locked egress. Fetches the diff
  as data via the API. `code-review gather` collects the inputs (resolves the PR, fetches the diff
  with a git-diff fallback, the PR context, the prior bot review, and failing-job logs as files),
  then it runs the two-phase gate: (1) a data-only security triage of the diff → `{safe, reasons}`,
  fail-closed; (2) if safe, the agentic review runs and its output is mapped onto the spec envelope
  with `code-review adapt`.
- **`comment` job** — holds the write token, runs **no agent and no PR code**; `code-review post`
  validates findings against the diff and posts the inline review + sticky summary.

## To try it

1. Copy `review.yaml` into `.github/workflows/`. Your existing CI workflow is untouched — edit the
   `workflows: ["CI"]` filter to match its `name:`.
2. Set the `API_BASE_URL` Actions **variable** (your provider's Anthropic-compatible endpoint,
   e.g. `https://api.deepseek.com/anthropic`) and add a repo secret `MODEL_API_KEY` — a **burner
   key with a hard spend cap** (it is exposed to untrusted PR code during the contained phase-2
   window). Both are required; an unset endpoint fails the triage step loudly.
3. Commit `.github/prices.json` (fork [`schema/prices.example.json`](../../schema/prices.example.json))
   so the cost footer isn't **$0** ([SPEC §4.4](../../SPEC.md#44-required-controls-conformance)).
4. `workflow_run` only fires from the **default branch** — merge first, then open a test PR. The
   introducing PR won't review itself.
5. First run: consider `egress-policy: audit` to discover the real allowlist, then switch to `block`
   ([SPEC Appendix A](../../SPEC.md#appendix-a--reference-realization-github-actions-non-normative)).

Model configuration is committed step `env` on the two claude-invoking steps — models, efforts, the
subagent model, and the tier aliases, scoped to where each is consumed — deliberately in-file config,
reviewed in your own PR flow. Only the backend endpoint is a per-repo **Actions variable**
(`API_BASE_URL`, required, no default — an unset endpoint fails loudly instead of letting the CLI
choose where the key gets sent), and it is safe as one because the egress allowlist still pins the
reachable hosts: a different provider means adding its API host to `allowed-endpoints` in the same
PR. Add your ecosystem's package registries there only if the agent should install packages to
validate findings (the file's own comment marks where).

The approach was proven by a live review on
[camas PR #17](https://github.com/JPHutchins/camas/pull/17#issuecomment-4859543691); see
[docs/design.md](../../docs/design.md) for the history.
