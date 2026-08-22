# Example workflows

[`review.yaml`](review.yaml) is the copy-paste reference workflow for the spec's
[GitHub Actions binding](../../SPEC.md#appendix-a--reference-realization-github-actions-non-normative):
a single file, three jobs, triggered by your existing CI workflow completing. Its routing follows
[SPEC §3.1](../../SPEC.md#31-trigger--routing) — CI success gets the comprehensive reviewer, CI failure
gets the fast "mechanic" that proposes minimal fixes from the failing-job logs.

- **`review` job** — holds the model key + a **read-only** token + locked egress. Fetches the diff
  as data via the API. `code-review gather` collects the inputs (resolves the PR, fetches the diff
  with a git-diff fallback, the PR context, the prior bot review, and failing-job logs as files),
  then it runs the two-phase gate: (1) a data-only security triage of the diff → `{safe, reasons}`,
  fail-closed; (2) if safe, the agentic review runs and its output is mapped onto the spec envelope
  with `code-review adapt`.
- **`announce` job** — holds the write token, runs **no agent and no PR code**; `code-review announce`
  posts an in-progress placeholder sticky the moment the review starts (a `workflow_run` review runs
  from the default branch and is otherwise invisible on the PR), preserving any prior sticky's embedded
  re-review markers so the swap never clobbers the seed the `review` job reads back. It also opens a
  **check-run on the head SHA** — the native attribution surface: it shows in the PR's own checks list,
  correlates by construction, and (written to the base repo) works for fork PRs too.
- **`comment` job** — holds the write token, runs **no agent and no PR code**; `code-review post`
  validates findings against the diff and posts the inline review + sticky summary, then finalizes the
  check-run `neutral` (non-gating — the review is informational).
- **`finalize` job** — reaches a terminal state for the check-run whenever `comment` won't. A
  hard-**failed** review gets an attributed "did not complete — re-request" sticky (`code-review
  report-incomplete`) and a `failure` check; a **cancelled** review (typically superseded by a newer
  run on the same branch) gets an informational "superseded — no action needed" sticky
  (`report-incomplete --cancelled`), *not* the failure reading — a superseded run is not an operational
  failure ([#139](../../../issues/139)) — and settles the check this run's announce created to
  `cancelled` (every settlement is ownership-matched by details_url, so a superseding run's live check
  is never touched); a legitimate **skip** just finalizes the check `neutral` so it never hangs
  `in_progress`.

## Two ways to consume it

- **Copy-paste (`review.yaml`, this directory)** — own the whole pipeline inline. Best when you want
  to read, audit, or customize every step in your own repo.
- **Reusable workflow (`@ref`)** — a thin ~20–35 line caller that delegates to
  [`.github/workflows/review-reusable.yaml`](../../.github/workflows/review-reusable.yaml) via
  `workflow_call`, so an upgrade is an `@ref` bump instead of re-copying the file. The full pipeline
  (all jobs, the permission boundary, harden-runner, the CLI pins) lives in the pinned ref; you own
  the trigger, secrets, egress policy, prices, version pin — and any check-running setup. Minimal
  caller (STATIC review — no PR-code execution):

  ```yaml
  name: Code review
  # Names the run in the Actions list after the PR it reviews — otherwise every workflow_run row
  # reads `main`, indistinguishable when several PRs are open. `gh run list --json displayTitle`
  # then answers "which run is which PR" directly.
  run-name: >-
    Review ${{ github.event.workflow_run.head_branch }}
    @ ${{ github.event.workflow_run.head_sha }}
  on:
    workflow_run:
      workflows: ["CI"]            # your CI workflow's name
      types: [completed]
  permissions:                     # superset; the internal jobs narrow from this
    contents: read
    actions: read
    pull-requests: write
    issues: write
    checks: write                  # the review posts a check-run on the PR head SHA (its attribution surface)
  jobs:
    review:
      if: >-
        github.event.workflow_run.event == 'pull_request' &&
        (github.event.workflow_run.conclusion == 'success' ||
         github.event.workflow_run.conclusion == 'failure')
      uses: JPHutchins/code-review/.github/workflows/review-reusable.yaml@v0.1.0-alpha.33
      with:
        head_sha:      ${{ github.event.workflow_run.head_sha }}
        head_branch:   ${{ github.event.workflow_run.head_branch }}
        head_repo:     ${{ github.event.workflow_run.head_repository.full_name }}   # fork-safe concurrency
        run_id:        ${{ github.event.workflow_run.id }}
        conclusion:    ${{ github.event.workflow_run.conclusion }}
        trigger_event: ${{ github.event.workflow_run.event }}
        api_base_url:  ${{ vars.API_BASE_URL }}
        model_full:    deepseek-v4-pro[1m]     # required — pick alongside api_base_url
        model_mechanic: deepseek-v4-pro[1m]    # required — `[1m]` on EVERY model input whose model
                                               # really has a 1M window; the CLI assumes 200k otherwise
      secrets:
        MODEL_API_KEY: ${{ secrets.MODEL_API_KEY }}
  ```

  See the reusable workflow's [`inputs:` block](../../.github/workflows/review-reusable.yaml) for the
  full set (tier aliases, per-route time limits + grace periods + USD caps, `extra_endpoints`,
  `egress_policy`, `scope`, `inline`).

### Where findings appear

  By default the findings are listed in the review's sticky comment and no inline comments are
  posted. Set `inline: true` **on the reusable workflow** to render the in-diff findings as inline
  comments on the diff lines instead — they then move out of the sticky and onto the diff. The review
  object itself is posted either way: it is the link from the PR to the sticky and to the run.

  The self-contained [`review.yaml`](review.yaml) in this directory has no `inline` input: it calls
  `code-review post` directly, so add `--inline` to that invocation to opt in. Check first that the
  CLI version it pins accepts the flag (`code-review post --help`) — an unknown option is ignored
  silently, so a hand-added flag against an older pin does nothing and says nothing. The reusable
  workflow probes for exactly that and warns; the copy-paste variant cannot.

  The default is off because an inline thread is a human-only surface: a later round can neither
  revise nor resolve one, so on a PR that iterates, superseded threads accumulate on the diff. With
  `inline: true` the pipeline still minimizes the previous round's threads, but it cannot resolve them.

### `scope` — tell the reviewer what the project accepts ([#139](../../../issues/139))

  Set the `scope` input (or the `SCOPE` Actions variable in the copy-paste file) to the languages the
  project accepts, e.g. `scope: C` or `scope: "C C++"`. It is spliced into the full-review prompt so
  the agent triages **"is this input a program the project accepts?"** *before* assigning severities:
  an out-of-scope input is a **scope note** (a sentence in the summary), never a severity-bearing
  finding — a project that formats C receiving C++ is out of scope, not a C++ layout regression. When
  `scope` is empty, the reviewer infers scope from the README's first paragraph instead. A malformed
  value (e.g. one containing a newline or `<`) is rejected by `check-scope`: it logs a warning and the
  scope is treated as absent (the reviewer infers it from the README) — it never aborts the review into
  a confusing crash notice, and never splices an unvalidated value into the prompt. (`check-scope` is
  release-gated, so on a pinned CLI that predates it the scope is likewise treated as absent.)

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

## Comment / ChatOps trigger (on-demand reviews)

Beyond reviewing on CI completion, you can let people **request a review from a PR comment**, with
optional in-comment arguments — a bigger budget for a thorny PR, a one-off focus, or both:

```
/code-review 24m $2.00 I'm especially concerned about docstring/README/inline-comment sync — audit that.
```

`/code-review` alone runs a normal full review. This is **additive** — the pipeline is the same
trigger-agnostic reusable workflow. Copy [`review-on-comment.yaml`](review-on-comment.yaml) into
`.github/workflows/` (run it alongside `review.yaml`, or on its own).

The copy-paste file is deliberately **thin** — it owns only the two things GitHub forces into your
repo: the trigger (a `workflow_call` reusable can't declare `on: issue_comment`) and the
**authorization gate** (the job-level `if:`, your security boundary, kept visible in your repo rather
than hidden behind a pinned `@ref`). Everything mechanical — parsing the comment args, resolving the
PR head, the 👀/🚀 acknowledgement, and running the review — lives in a reusable *front-end*
(`review-on-comment-reusable.yaml`) it delegates to, which in turn nested-calls the same
`review-reusable.yaml` the CI path uses.

**Argument grammar** — an optional leading duration and/or dollar amount, in either order, then
free-form instructions (a `/` slash command, like prow's `/lgtm` or `slash-command-dispatch`, not an
`@mention` — there is no `code-review` account to notify, and `/` never mislinks):

| token | example | effect |
| --- | --- | --- |
| duration | `24m`, `90s`, `1h` | overrides the full-review wall for this run, **clamped** to `--max-duration` |
| dollar amount | `$2.00`, `$0.50` | overrides the USD spend cap for this run, **clamped** to `--max-usd` |
| everything else | `audit the error paths` | appended to the review agent's system prompt as guidance |

A duration/dollar token is only recognized when it **leads** — `spend 24m on it` keeps `24m` as prose.
`code-review parse-command` parses this in type-safe code (not workflow bash), clamps to the ceilings
you set, resolves the PR head from the comment's **PR number via the API** (never a SHA in the
comment), and emits the outputs the review job consumes.

**CI-result aware** — the differentiator. Comment a `/code-review` *before* CI finishes and the
front-end **waits** for the head's CI run to conclude, then routes on its **real** result — exactly
as the CI-completion trigger does: `success` → full review, `failure` → the fast mechanic route with
that CI run's failing-job logs. It never reviews blind to CI. The workflow to wait for is the
`ci_workflow` input (default `CI` — the same `name:` you list in `review.yaml`'s `workflows: [...]`);
`ci_wait_timeout` bounds the wait (default `30m`). If CI never concludes in time — or concludes as
something other than success/failure (cancelled, skipped) — the review is **declined** (😕) rather
than run on a guessed result. `code-review await-ci` does this in type-safe code (not workflow bash).

**Acknowledgement** — the front-end's trusted gate reacts 👀 to your comment on receipt (before the
CI wait, so you see receipt immediately); on completion the `ack` job swaps it for 🚀 (review posted
— read the sticky summary) or 😕 (CI didn't conclude in time, or the run failed). The review job
itself is read-only and runs untrusted PR code, so it can't post progress; the sticky comment is the
result, exactly as with the CI trigger.

**Security model** — comment-triggering opens surfaces the CI trigger doesn't, so the recipe closes
each in the *trusted* default-branch context (`issue_comment` runs there, never in PR-fork context):

- **Authorization.** The gate's `if:` requires `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` —
  without it, any stranger on a public PR could drain your model budget or steer the agent. (Same
  posture as `anthropics/claude-code-action`.)
- **Cost is bounded.** `parse-command --max-duration` / `--max-usd` clamp what a comment can request;
  a commenter may lower cost or raise it *within your ceiling*, never unbounded. The USD cap still
  applies on top (with a committed `.github/prices.json`).
- **`extra_instructions` is a trust boundary.** It flows into the agent's system prompt and **bypasses
  the diff security triage** (which screens the diff, not the comment). It's acceptable *only* because
  it's gated to write-access users — who can already push code the agent runs — and it's length-capped
  (`--max-instructions`, default 4000). It does not override the schema, safety, or single-writer rules.
- **Head resolved from the API, never the comment.** `parse-command` resolves the head SHA/branch from
  the trusted PR number, so a comment can't point the review at arbitrary content.
- **No self-triggering.** The gate ignores bot comments (`comment.user.type != 'Bot'`), and the bot's
  own sticky never begins with `/code-review`.

The front-end's gate/ack jobs run only trusted code (the workflow + the CLI + the GitHub API), never
PR code, so the egress lock stays where untrusted code executes — the reusable workflow's review job.

## Cancel a review when the PR is merged or closed ([#183](../../../issues/183))

A review is an expensive agentic run, and nobody iterates a merged PR — so a review left queued or
running when its PR is **merged or closed** spends its tokens for nothing (worst case: a fast-merge
whose review is still queued). The per-PR concurrency group cancels a review on a **new commit**, but
merge/close pushes no commit, so it never fires.

Copy [`review-cancel-on-merge.yaml`](review-cancel-on-merge.yaml) into `.github/workflows/`. On
`pull_request: closed` it enters the review's per-PR concurrency group with `cancel-in-progress`,
cancelling whatever review is queued or in flight — no token, no run lookup, no per-repo config (every
consumer's copy is identical). It covers the full, mechanic, and on-comment routes (they share the
group) and both merge and manual close. A review that only *starts* after the close (CI concluding
post-merge) is not in the group to cancel, but the pipeline already skips a PR that is no longer open,
so it costs the gather step, not a full review.

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
