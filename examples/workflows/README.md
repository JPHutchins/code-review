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

## Two ways to consume it

- **Copy-paste (`review.yaml`, this directory)** — own the whole pipeline inline. Best when you want
  to read, audit, or customize every step in your own repo.
- **Reusable workflow (`@ref`)** — a thin ~18–35 line caller that delegates to
  [`.github/workflows/review-reusable.yaml`](../../.github/workflows/review-reusable.yaml) via
  `workflow_call`, so a release is an `@ref` bump instead of re-copying the file. The full pipeline
  (both jobs, the permission boundary, harden-runner, the CLI pins) lives in the pinned ref; you own
  the trigger, secrets, egress policy, prices, and version pin. Minimal caller:

  ```yaml
  name: Code review
  on:
    workflow_run:
      workflows: ["CI"]            # your CI workflow's name
      types: [completed]
  permissions:                     # superset; the two internal jobs narrow from this
    contents: read
    actions: read
    pull-requests: write
    issues: write
  jobs:
    review:
      if: >-
        github.event.workflow_run.event == 'pull_request' &&
        (github.event.workflow_run.conclusion == 'success' ||
         github.event.workflow_run.conclusion == 'failure')
      uses: JPHutchins/code-review/.github/workflows/review-reusable.yaml@v0.1.0-alpha.15
      with:
        head_sha:      ${{ github.event.workflow_run.head_sha }}
        head_branch:   ${{ github.event.workflow_run.head_branch }}
        head_repo:     ${{ github.event.workflow_run.head_repository.full_name }}
        run_id:        ${{ github.event.workflow_run.id }}
        conclusion:    ${{ github.event.workflow_run.conclusion }}
        trigger_event: ${{ github.event.workflow_run.event }}
        api_base_url:  ${{ vars.API_BASE_URL }}
        install_command: npm ci    # omit for a STATIC review (diff + source only)
      secrets:
        MODEL_API_KEY: ${{ secrets.MODEL_API_KEY }}
  ```

  Per-repo deltas are `with:` inputs — see the reusable workflow's `inputs:` block for the full set
  (models + tier aliases, `setup` + `install_command`, per-route walls, `extra_endpoints`,
  `egress_policy`, pinned versions).

## To try it (copy-paste)

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
