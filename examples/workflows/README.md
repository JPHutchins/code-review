# Example workflows

[`review.yaml`](review.yaml) is the copy-paste reference workflow for the spec's
[GitHub Actions binding](../../SPEC.md#8-github-actions-binding): a single file, two jobs, triggered
by your existing CI workflow completing. Its routing follows
[SPEC §3](../../SPEC.md#3-trigger--routing) — CI success gets the comprehensive reviewer, CI failure
gets the fast "mechanic" that proposes minimal fixes from the failing-job logs.

- **`review` job** — holds the model key + a **read-only** token + locked egress. Fetches the diff
  as data via the API, runs the two-phase gate: (1) a data-only security triage of the diff →
  `{safe, reasons}`, fail-closed; (2) if safe, the agentic review runs and its output is mapped onto
  the spec envelope with `code-review adapt`.
- **`comment` job** — holds the write token, runs **no agent and no PR code**; `code-review post`
  validates findings against the diff and posts the inline review + sticky summary.

## To try it

1. Copy `review.yaml` into `.github/workflows/`. Your existing CI workflow is untouched — edit the
   `workflows: ["CI"]` filter to match its `name:`.
2. Add a repo secret `MODEL_API_KEY` — a **burner key with a hard spend cap** (it is exposed to
   untrusted PR code during the contained phase-2 window).
3. `workflow_run` only fires from the **default branch** — merge first, then open a test PR. The
   introducing PR won't review itself.
4. First run: consider `egress-policy: audit` to discover the real allowlist, then switch to `block`
   ([SPEC §8.4](../../SPEC.md#84-egress-allowlist)).

The approach was proven by a live review on
[camas PR #17](https://github.com/JPHutchins/camas/pull/17#issuecomment-4859543691); see
[docs/design.md](../../docs/design.md) for the history.
