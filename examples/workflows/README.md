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
- **Reusable workflow (`@ref`)** — a thin ~20–35 line caller that delegates to
  [`.github/workflows/review-reusable.yaml`](../../.github/workflows/review-reusable.yaml) via
  `workflow_call`, so an upgrade is an `@ref` bump instead of re-copying the file. The full pipeline
  (both jobs, the permission boundary, harden-runner, the CLI pins) lives in the pinned ref; you own
  the trigger, secrets, egress policy, prices, version pin — and any check-running setup. Minimal
  caller (STATIC review — no PR-code execution):

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
      uses: JPHutchins/code-review/.github/workflows/review-reusable.yaml@v0.1.0-alpha.22
      with:
        head_sha:      ${{ github.event.workflow_run.head_sha }}
        head_branch:   ${{ github.event.workflow_run.head_branch }}
        head_repo:     ${{ github.event.workflow_run.head_repository.full_name }}   # fork-safe concurrency
        run_id:        ${{ github.event.workflow_run.id }}
        conclusion:    ${{ github.event.workflow_run.conclusion }}
        trigger_event: ${{ github.event.workflow_run.event }}
        api_base_url:  ${{ vars.API_BASE_URL }}
        model_full:    deepseek-v4-pro       # required — pick alongside api_base_url
        model_mechanic: deepseek-v4-flash    # required
      secrets:
        MODEL_API_KEY: ${{ secrets.MODEL_API_KEY }}
  ```

  See the reusable workflow's [`inputs:` block](../../.github/workflows/review-reusable.yaml) for the
  full set (tier aliases, per-route time limits + grace periods + USD caps, `extra_endpoints`,
  `egress_policy`).

### Check-running with the reusable workflow

By default the reusable workflow reviews **statically** (the diff + source, no execution). To let the
agent run your project's checks and confirm fixes, there are two opt-in hooks — the shared workflow
deliberately owns **no** ecosystem toolchain or cache action:

- **Simple, shell-installable deps** — set `install_command` (a shell string): `npm ci`, `uv sync`,
  `pip install -e .`, even a `pipx install uv && uv sync`. Add your registries via `extra_endpoints`.
- **Anything needing `uses:` steps** (a toolchain installer, a store cache) — commit your own composite
  at **`.github/actions/code-review-setup`** and set `use_setup_action: true`. The reusable workflow
  invokes it (resolved against *your* checked-out repo), so your toolchain + cache live in **your**
  repo, versioned and owned by you. Example (Nix, mirroring your CI):

  ```yaml
  # .github/actions/code-review-setup/action.yml
  name: code-review-setup
  runs:
    using: composite
    steps:
      - uses: nixbuild/nix-quick-install-action@v35
      - uses: nix-community/cache-nix-action@v7        # your cache, your key, your repo
        with:
          primary-key: nix-${{ runner.os }}-${{ hashFiles('**/*.nix', '**/flake.lock') }}
          restore-prefixes-first-match: nix-${{ runner.os }}-
      - shell: bash
        run: nix develop --command true                # warm the dev shell (outside the agent wall)
  ```

  Hosts the composite needs (`cache.nixos.org`, package registries, the Actions cache backend, …) must
  be reachable when harden-runner arms — run `egress_policy: audit` first to discover them, then pin
  via `extra_endpoints` and switch back to `block`.

## Setup (both paths)

1. **Add the workflow.** Copy-paste: drop `review.yaml` into `.github/workflows/`. Reusable: add the
   thin caller above. Either way, edit the `workflows: ["CI"]` filter to match your CI workflow's
   `name:`; your existing CI workflow is untouched.
2. Set the `API_BASE_URL` Actions **variable** (your provider's Anthropic-compatible endpoint,
   e.g. `https://api.deepseek.com/anthropic`) and add a repo secret `MODEL_API_KEY` — a **burner
   key with a hard spend cap** (it is exposed to untrusted PR code during the contained phase-2
   window). Both are required; an unset endpoint fails the triage step loudly.
3. Commit `.github/prices.json` (fork [`schema/prices.example.json`](../../schema/prices.example.json))
   so the cost footer isn't **$0** ([SPEC §4.4](../../SPEC.md#44-required-controls-conformance)). The
   reusable workflow checks out your repo, so it reads your committed price map too.
4. `workflow_run` only fires from the **default branch** — merge first, then open a test PR. The
   introducing PR won't review itself. (Both paths.)
5. First run: discover the real egress allowlist before locking it. Copy-paste: set the
   `harden-runner` step's `egress-policy: audit`. Reusable: pass `egress_policy: audit`. Then switch
   to `block` (copy-paste: add hosts to `allowed-endpoints`; reusable: add them via `extra_endpoints`)
   ([SPEC Appendix A](../../SPEC.md#appendix-a--reference-realization-github-actions-non-normative)).
   An egress **canary** step then proves the lock actually engaged on every run — harden-runner can
   silently degrade `block` to audit ([harden-runner#675](https://github.com/step-security/harden-runner/issues/675))
   — and fails the job closed if it can reach the open internet. The reusable workflow skips it
   automatically in audit mode; in the copy-paste file, comment it out during audit discovery.

In the copy-paste file, model configuration is committed step `env` on the two claude-invoking steps —
models, efforts, the subagent model, and the tier aliases, scoped to where each is consumed. In the
reusable workflow the same knobs are `with:` inputs. Only the backend endpoint is a per-repo **Actions
variable** (`API_BASE_URL`, required, no default — an unset endpoint fails loudly instead of letting
the CLI choose where the key gets sent), and it is safe as one because the egress allowlist still pins
the reachable hosts: a different provider means allowlisting its API host (copy-paste:
`allowed-endpoints`; reusable: `extra_endpoints`).

The approach was proven by a live review on
[camas PR #17](https://github.com/JPHutchins/camas/pull/17#issuecomment-4859543691); see
[docs/design.md](../../docs/design.md) for the history.
