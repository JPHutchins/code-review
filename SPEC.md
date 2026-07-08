# code-review — a normative approach for safe agentic code review

> **Version:** 0.1.0-alpha · **Status:** alpha.
>
> This document specifies an **approach** — a security architecture for having an AI agent review a
> proposed change and post the result — in **provider-neutral** terms, together with the reasoning for
> why it is safe. It is deliberately **general**: an implementation may use any agent, any model
> backend, any code host, and any schema of its own choosing and still conform.
>
> It does **not** define a data format, a rendering, a cost report, or a workflow file. Those are
> decisions of a **reference implementation** — this repository: [`@jphutchins/code-review`](https://www.npmjs.com/package/@jphutchins/code-review),
> its schema in [`schema/`](schema/), its commenter in [`src/`](src/) and [`templates/`](templates/),
> and its GitHub Actions realization in [`examples/workflows/review.yaml`](examples/workflows/review.yaml).
> **Changing any of those requires no change to this document.** The approach is proven: a reference
> implementation posted a live review on
> [camas PR #17](https://github.com/JPHutchins/camas/pull/17#issuecomment-4859543691).
>
> "Claude," "Claude Code," "DeepSeek," "GitHub," and "OpenCode" are trademarks of their respective
> owners, used nominatively; no affiliation or endorsement is implied. See [README.md](README.md).

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 1. Overview & thesis

An agentic code review asks a large language model to read a proposed change and report on it. Doing
so safely means confronting a single hard fact: **the same task needs three capabilities that must
never be held together.**

1. **Read untrusted content.** The change, its surrounding source, and any logs or discussion are
   author-controlled. Text placed in a model's context can override the model's instructions —
   *prompt injection*, whether the hostile text is supplied directly or embedded in content the model
   merely reads ([OWASP LLM01][llm01]; [NIST AI 100-2][nist]). An agent that ingests a pull request
   MUST therefore be assumed to be attacker-influenced.
2. **Hold a model credential.** Driving a model requires a key that spends money — a bearer token and
   a standing financial liability.
3. **Write to the review surface.** Posting the result requires a credential that can modify the
   repository or its conversation.

Any one component holding all three is the "lethal trifecta": private/valuable data, exposure to
untrusted content, and a way to act on the outside world — the combination an injection turns into
exfiltration or unwanted action ([Willison][trifecta]).

**Thesis.** Split the three capabilities across **privilege-isolated roles** that communicate only
through **validated, structured data**, never through code or shell. No single role can be both
subverted by untrusted input *and* capable of causing harm. The whole system is then plain
workflow-as-code — reviewed in the same flow as the code it guards — with no marketplace action, no
hosted app, and no third-party reviewing service to trust.

This document defines the **roles**, the **contracts** between them, the **threat model** and
**required controls**, and **conformance**. It treats data formats, rendering, and platform bindings
as an implementation's own concern (§6).

---

## 2. Roles & the privilege boundary

A conforming system has three roles, defined by **capability**, not by any particular tool or vendor.
They span two trust domains.

### 2.1 Orchestrator (unprivileged)

The existing CI for the change — whatever already runs the project's checks. It produces an outcome
the review routes on and MAY publish machine-readable test results. It holds no review credential and
requires **no modification** to enable review.

### 2.2 Reviewer (untrusted input + model key; no write; contained)

Ingests the untrusted change and its context, drives the model, and emits the review as **structured
data** (§3.2). It holds the model key and, at most, a **read-only** repository credential. Because it
reads attacker-influenced content (§1), it MUST be treated as potentially subverted, and is therefore
**contained**: no write or publish credential, a **locked network egress**, and a **burner model key
with a hard spend cap**. Its worst realistic output is a public comment — never a secret leak or a
repository write.

### 2.3 Commenter (write credential; no model; no untrusted execution)

Transforms the reviewer's structured data into the review surfaces. It holds the **write** credential
but **no model key**, and it **never executes** the change under review — it only deserializes and
renders validated data. It MUST be **deterministic**: no model call, and no interpolation of untrusted
text into a shell or an API body (§4).

### 2.4 The boundary

> The role that reads untrusted content cannot write. The role that can write neither reads a model
> nor executes untrusted content. Nothing crosses between them except data that has been validated
> against a published schema.

This is the load-bearing invariant. It directly defeats the dominant CI attack class, in which
untrusted pull-request code runs in a *privileged* context that holds secrets and write access — the
"pwn request" ([GitHub Security Lab][pwn]) and *poisoned pipeline execution* ([OWASP CICD-SEC-04][ppe];
[Gil & Krivelevich][ppeorig]) patterns. Here the privileged role runs no untrusted content at all,
and the role that does is stripped of everything worth stealing.

The two roles MUST run as **separate execution contexts with independently scoped credentials**. A
role's credential MUST follow least privilege — the minimum scope for its job, nothing more
([NIST][leastpriv]).

---

## 3. The contracts between roles

The roles are coupled only by the three abstract contracts below. All are stated in CI-neutral terms;
a concrete platform binding is illustrative, not part of the contract (Appendix A).

### 3.1 Trigger & routing

- **Trigger.** The review is driven by the **completion of CI** for a change, so the CI outcome
  arrives for free and no model spend occurs before the project's checks have run. The trigger and the
  identifier of the reviewed commit MUST come from the **CI event**, not from author-controlled
  content — otherwise a fork could redirect or forge the review.
- **Routing.** The reviewer MUST route on the CI outcome:

  | Outcome | Route | Behavior |
  |---|---|---|
  | passed | **review** | Full agentic review; MAY re-run the project's checks to validate findings; higher effort. |
  | failed | **mechanic** | Fast, minimal pass over the failure only — propose targeted fixes, not a broad review; lower effort. |
  | did not run (cancelled/skipped/errored) | **skip** | Post nothing — there is no meaningful result to review. |

  Paying for a full review of code that does not pass CI is wasteful, and a CI outcome is universal —
  every project has one — so routing on it needs no special tooling.
- **Input as data.** The change and all context (diff, logs, prior review, discussion, optional test
  report) MUST be gathered as **data** by a step that holds only the read-only credential — never by
  checking out and running fork code, and never by granting the reviewer network access to fetch them.
  A binding that fetches the change over an API that may truncate MUST detect truncation or fall back
  to a non-truncating source; silently reviewing a partial change is a correctness fault.

### 3.2 The deliverable

The reviewer's output is a **structured document** — an overall assessment plus zero or more findings,
each anchored to a precise location in the change — accompanied by a **vendor-neutral record of model
usage** (per-model token counts, turns, duration) sufficient to report cost independently of any
backend's own pricing.

The document MUST be **validated against a published schema before anything is posted**. The schema —
not this specification — is the single, authoritative definition of the deliverable's fields and which
are required; a conforming implementation publishes its own and treats it as the source of truth, so
the schema can evolve without amending this document. (The reference schema is
[`schema/findings.schema.json`](schema/findings.schema.json); its field descriptions are its spec.)

When a model's structured-output enforcement is imperfect, an implementation MAY recover the deliverable
from the model's output by a **deterministic** procedure, provided that procedure accepts **exactly one**
validating candidate and **fails closed** on ambiguity or absence (§4.2). Recovering a self-validated
document the agent wrote to a file is preferable to parsing free-form output.

### 3.3 The commenter

The commenter renders the validated deliverable onto durable review surfaces. Its behavior is
constrained, but *how* it renders — layout, markers, per-surface formatting — is the implementation's
own decision (the reference commenter's templates are the source of truth for its rendering). It MUST be:

- **Deterministic and agentless** — a data-in, string-out transform; no model call.
- **Advisory** — posted as a non-blocking comment, **never** as a merge-blocking "request changes,"
  and **never** wired as a required status check. The review is model output and MUST NOT gate merge.
- **Truthful** — it MUST NOT claim a surface or action that did not occur (e.g. asserting inline
  annotations exist when none were posted). A finding that cannot be anchored where it belongs MUST be
  surfaced elsewhere, not silently dropped.
- **Idempotent** — re-running on the same commit updates in place rather than duplicating, and it
  decides what already exists by **authenticated author identity**, never by a marker that untrusted
  parties could copy (§4.2).

---

## 4. Threat model & required controls

### 4.1 Assets

- **Model API key** — spends money; the primary target.
- **Write credential** — can modify the repository or its conversation; the secondary target.
- **Reviewer runtime** — transient, but its environment holds the model key.

### 4.2 Threats

| Threat | Why it matters | Control |
|---|---|---|
| Untrusted content hijacks the reviewer (direct or indirect prompt injection) | The reviewer reads author-controlled text by design ([OWASP LLM01][llm01]; [NIST][nist]) | The reviewer holds no write/publish credential and no open egress; its worst output is a public comment (§2.2) |
| Reviewer is induced to exfiltrate the model key or environment secrets | The "lethal trifecta" turns injection into exfiltration ([Willison][trifecta]) | Read-only credential; egress allowlist ([StepSecurity][harden]); burner key with hard spend cap; public comment is the sole accepted residual channel |
| Untrusted change runs in a privileged context (pwn request / poisoned pipeline execution) | A documented, high-impact CI class ([GitHub Security Lab][pwn]; [OWASP][ppe]; [Gil & Krivelevich][ppeorig]) | The privileged (write) role never executes the change; the trigger and reviewed commit come from CI, not author content |
| Output carries a payload aimed at the maintainer (phishing, "ignore previous instructions") | A finding is untrusted text shown to a human | Rendered as data by a host that neutralizes active content; the commenter escapes all untrusted text (defense in depth) |
| Output smuggles a second, conflicting result to flip the verdict | Appending an extra block could mask the real one | Recovery accepts exactly one validating candidate; ambiguity fails closed (§3.2) |
| A fork redirects the review to the wrong target | Author-controlled routing would misattribute the review | Target resolved from the trusted commit identifier (+ branch), never from author-controlled data |
| A prior review is spoofed to suppress a real one | A copied marker could impersonate the bot | Prior state trusted by **authenticated author identity**, not by any marker (§3.3) |
| Spend runaway / denial-of-wallet | Repeated pushes could burn budget | Burner key + hard spend cap; run timeout; cancel superseded runs |
| Tampered deliverable in transit between roles | The write role must not act on forged data | Transport integrity is provided by the CI platform; the write role only deserializes, never executes |

### 4.3 Preflight triage

Before a reviewer applies and executes untrusted content (e.g. to run the project's checks and confirm
a fix), an implementation SHOULD run a **data-only** triage of the change — reading it, never executing
it — screening for injection attempts, secret access/exfiltration, calls to unexpected hosts, changes
to CI/build/hook scripts that could execute code, and obfuscated payloads. The triage reads the same
untrusted content an injection would ride in, so it is a **heuristic first filter only**; its decision
MUST **fail closed** (any ambiguous, malformed, or unrecoverable result is treated as unsafe). The
controls that actually contain the reviewer are the read-only credential, the egress lock, and the
capped burner key (§4.4).

### 4.4 Required controls (conformance)

A conforming implementation MUST:

- Run the reviewer with, at most, a **read-only** repository credential and **no** write/publish
  credential.
- Run the commenter as a **separate execution context** with **no model key**, and never let it
  execute the change under review.
- **Lock network egress** on **both** roles to minimal allowlists — the reviewer (holds the model key)
  and the commenter (holds the write credential) ([StepSecurity][harden]; and see the exfiltration
  precedents [CVE-2025-30066][tjcve], [Unit 42][unit42], [Codecov][codecov]).
- Use a **burner model key with a hard spend cap**; a run SHOULD also enforce a per-run budget from the
  usage record and abort to a notice if a ceiling is exceeded.
- Pass all untrusted content (change, logs, discussion, the deliverable itself) as **files or
  structured data**, and build every API request body with a **JSON-aware serializer** — never
  interpolate untrusted text into a shell or an API body.
- Resolve the review target from **trusted CI data** (commit identifier, disambiguated by branch),
  never from author-controlled content.
- **Validate the deliverable against the published schema before posting**; on malformed output, post a
  safe notice, never unvalidated content.
- Keep the review **advisory** (§3.3): a non-blocking comment, never a merge gate.
- Scope every credential to **least privilege** ([GitHub][ghtoken]; [NIST][leastpriv]).

A conforming implementation SHOULD report **cost recomputed from the usage record against a price map
committed to the trusted base** (so author-controlled content cannot forge the displayed rates), and
MUST surface — never silently zero — a model or token class the map does not price.

---

## 5. Conformance

Conformance is defined at the level of the architecture and its controls, so that an implementation is
free in every concrete choice.

- **Reviewer** — MUST emit a schema-validated deliverable and a vendor-neutral usage record (§3.2),
  route on the CI outcome (§3.1), hold no write/publish credential, and run contained (§2.2, §4.4). It
  SHOULD triage before executing untrusted content (§4.3).
- **Commenter** — MUST be deterministic, agentless, advisory, truthful, and idempotent (§3.3), hold no
  model key, never execute the change, obey the injection-discipline and target-resolution controls
  (§4.4), and trust prior state by authenticated identity.
- **Orchestrator / CI binding** — MUST drive the review from CI completion without modifying the
  existing CI, split the reviewer and commenter into separate least-privilege contexts, and derive the
  target from trusted CI data (§3.1, §2.4).
- **Schema** — a conforming deliverable schema is the implementation's own published, versioned
  contract; it MUST be validated before posting (§3.2). This document asserts nothing about its fields.

The reference implementation's schema and commenter carry their specific guarantees in this
repository's **test suite** (run via `camas run ci`); those tests — not this document — are the
executable definition of the reference implementation's concrete behavior.

---

## 6. Reference implementation

This repository realizes the approach. Every concrete decision this document declines to make lives
here, each with a single owner:

| Concern | Source of truth |
|---|---|
| The deliverable (fields, types, requiredness, agent-facing guidance) | [`schema/findings.schema.json`](schema/findings.schema.json) and the sibling `triage`/`prices` schemas — the field descriptions **are** the spec |
| Schema version policy | [`schema/VERSIONING.md`](schema/VERSIONING.md) |
| The commenter (validation, rendering, posting) | [`src/`](src/) and the per-surface templates in [`templates/`](templates/) |
| The agent adapter (native output → the deliverable) | [`src/adapt.ts`](src/adapt.ts), [`src/extract.ts`](src/extract.ts), [`docs/adapters.md`](docs/adapters.md) |
| The GitHub Actions realization | [`examples/workflows/review.yaml`](examples/workflows/review.yaml) (see Appendix A) |

The reference reviewer is driven by **Claude Code** (`claude -p`) against an Anthropic-compatible model
backend; the same contract fits other agent CLIs (e.g. OpenCode) and any compatible backend.

---

## Appendix A — Reference realization: GitHub Actions (non-normative)

The reference binding is a single `review.yaml` with two jobs — `review` (reviewer) and `comment`
(commenter) — triggered by `workflow_run` on completion of the project's existing CI. The full,
copy-paste-ready file is [`examples/workflows/review.yaml`](examples/workflows/review.yaml); this
appendix records only the platform facts that make the binding safe.

- **The trigger runs in the privileged, base-repository context.** `workflow_run` (like
  `pull_request_target`) executes with the base repo's token and secrets even when the triggering run
  was unprivileged ([GitHub — events][events]; [GitHub — `pull_request_target`][prtarget]). That is
  exactly why the reviewer must never check out and run fork code, and why the write role is a separate
  job ([GitHub — security hardening][ghsec]; [GitHub Security Lab, Part 4][seclab4]).
- **Least-privilege token.** The `review` job is granted read-only scopes; the `comment` job is granted
  only the write scopes it needs ([GitHub — controlling `GITHUB_TOKEN` permissions][ghtoken]).
- **Egress lock on both jobs.** Enforced by a runner-hardening step ([StepSecurity][harden]); because
  the lock arms at job start, the allowlist must also cover trusted setup (CLI/dependency installs), so
  the allowlist is *not* the reviewer's containment — the read-only token and capped burner key are.
- **Target resolution** derives the pull request from the trusted `workflow_run.head_sha`, disambiguated
  by `head_branch`; author-controlled artifacts never carry or override it.

Everything else in the file — routing thresholds, model env, artifact handling, the commenter
invocation — is implementation detail, kept in the example and its README, not here.

## Appendix B — Adapters (non-normative)

An agent CLI is a pluggable adapter behind one interface: **in** — the change plus context files;
**out** — the schema-validated deliverable plus the vendor-neutral usage record (§3.2). The reference
adapter is Claude Code; an OpenCode or other CLI adapter drops into the same contract. See
[`docs/adapters.md`](docs/adapters.md).

---

## References

1. **OWASP Gen AI Security Project** — [LLM01:2025 Prompt Injection][llm01].
2. **Simon Willison** — [The lethal trifecta for AI agents: private data, untrusted content, and external communication][trifecta] (2025).
3. **NIST** — [Adversarial Machine Learning: A Taxonomy and Terminology of Attacks and Mitigations][nist] (AI 100-2 E2025).
4. **GitHub Security Lab (J. Lobačevski)** — [Preventing pwn requests (Part 1)][pwn]; [New vulnerability patterns and mitigations (Part 4)][seclab4].
5. **GitHub** — [Securely using `pull_request_target`][prtarget]; [Events that trigger workflows][events]; [Security hardening for GitHub Actions][ghsec]; [Controlling permissions for `GITHUB_TOKEN`][ghtoken].
6. **OWASP** — [CICD-SEC-04: Poisoned Pipeline Execution][ppe]; **O. Gil & D. Krivelevich (Cider Security)** — [PPE — Poisoned Pipeline Execution][ppeorig] (2022).
7. **StepSecurity** — [Harden-Runner: egress filtering for CI runners][harden].
8. **GitHub Advisory Database** — [CVE-2025-30066 — tj-actions/changed-files][tjcve]; **Palo Alto Networks Unit 42** — [tj-actions & reviewdog supply-chain attack][unit42] (2025); **Codecov** — [Bash Uploader Security Update][codecov] (2021).
9. **NIST CSRC Glossary** — [Least privilege][leastpriv].

[llm01]: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
[trifecta]: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
[nist]: https://csrc.nist.gov/pubs/ai/100/2/e2025/final
[pwn]: https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/
[seclab4]: https://securitylab.github.com/resources/github-actions-new-patterns-and-mitigations/
[prtarget]: https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
[events]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
[ghsec]: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
[ghtoken]: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/controlling-permissions-for-github_token
[ppe]: https://owasp.org/www-project-top-10-ci-cd-security-risks/CICD-SEC-04-Poisoned-Pipeline-Execution
[ppeorig]: https://medium.com/cider-sec/ppe-poisoned-pipeline-execution-34f4e8d0d4e9
[harden]: https://docs.stepsecurity.io/github-actions/harden-runner
[tjcve]: https://github.com/advisories/GHSA-mrrh-fwg8-r2c3
[unit42]: https://unit42.paloaltonetworks.com/github-actions-supply-chain-attack/
[codecov]: https://about.codecov.io/security-update/
[leastpriv]: https://csrc.nist.gov/glossary/term/least_privilege
