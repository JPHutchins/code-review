# HANDOFF.md Compliance Checklist

Each requirement is mapped to its implementing file(s). Status: ✅ = verified, ❌ = missing, ⚠️ = partial/contradiction.

---

## §4 — Generalization Mandate

| # | Requirement | File(s) | Status |
|---|---|---|---|
| 4.1 | Model backend is example, not requirement — DeepSeek/Anthropic presented as examples | SPEC.md §1, §8.5, docs/adapters.md | ✅ |
| 4.2 | camas is optional enrichment, never a dependency — universal core routes on `workflow_run.conclusion` | SPEC.md §3.2–3.3, review-v2.yaml | ✅ |
| 4.3 | CTRF absent → failing-job logs cover it; reader without camas can implement whole spec | SPEC.md §3.3, review-v2.yaml lines 121-128 | ✅ |
| 4.4 | CI system abstract with "GitHub Actions binding" section for concrete shape | SPEC.md §8 | ✅ |
| 4.5 | Naming generic: `code-review`, `<!-- code-review -->`; trademarks nominative; "adapters" framing | SPEC.md header, README.md §Trademarks, docs/adapters.md | ✅ |
| 4.6 | "Not affiliated with, sponsored by, or endorsed by" notice in README/SPEC | README.md §Trademarks, SPEC.md header | ✅ |

---

## §5 — Locked Decisions

| # | Decision | File(s) | Status |
|---|---|---|---|
| 5.1 | **Two files, not three**: `ci.yaml` (unchanged) + `review.yaml` (privileged, two jobs). Collector dropped. | SPEC.md §8.1, review-v2.yaml | ✅ |
| 5.2 | **Route on native CI result**: `workflow_run.conclusion` → success=reviewer, failure=mechanic | SPEC.md §3.2, review-v2.yaml lines 121-128, 183-203 | ✅ |
| 5.3 | **Agent emits structured JSON, commenter renders**: model never hand-formats comment, never touches writable token | SPEC.md §2.2–2.3, §5, src/ inline/render separation | ✅ |
| 5.4 | **Two-job token split IS the security boundary**: review=read-only+key, comment=write+no-agent+no-PR-code | SPEC.md §2.4, review-v2.yaml jobs | ✅ |
| 5.5 | **Advisory only**: `COMMENT` event, never `REQUEST_CHANGES`, never required check, always exit 0 | SPEC.md §5.2.5, §7.4, review-v2.yaml line 310 | ✅ |
| 5.6 | **Trust by author identity, not marker**: filter prior-review to bot login, marker alone insufficient | SPEC.md §5.3, review-v2.yaml lines 116-119 | ✅ |
| 5.7 | **Injection discipline everywhere**: untrusted content passed as files, `jq -n --rawfile` or JSON serialization | SPEC.md §5.4, review-v2.yaml jq usage, src/ pure functions | ✅ |
| 5.8 | **Real containment is not the triage**: read-only token + egress lock + burner spend cap are the backstop | SPEC.md §7.3, review-v2.yaml triage comments | ✅ |

---

## §6 — Reference Facts

| # | Fact | Status |
|---|---|---|
| 6.1 | Model env uses `ANTHROPIC_AUTH_TOKEN` (not `_API_KEY`) | ✅ review-v2.yaml line 149 |
| 6.2 | Subagent model from `CLAUDE_CODE_SUBAGENT_MODEL` | ✅ review-v2.yaml line 190 |
| 6.3 | Tier aliases mapped for `/code-review` internal model picks | ✅ review-v2.yaml lines 187-189 |
| 6.4 | `--json-schema` may not accept `$ref`/`$defs`/`$id` → schema inlined | ✅ schema/findings.schema.json (no $ref), SPEC.md §4, VERSIONING.md |
| 6.5 | Result envelope has `modelUsage` with subagent keys, `total_cost_usd` Anthropic-priced → recompute | ✅ src/cost.ts recomputes, SPEC.md §6.1–6.2 |
| 6.6 | `workflow_run` fires only from default branch — merge first, test PR second | ✅ SPEC.md §3.1, review-v2.yaml comment |
| 6.7 | Trusted PR number: `gh api repos/{repo}/commits/{head_sha}/pulls` | ✅ SPEC.md §3.4, review-v2.yaml lines 93-94 |
| 6.8 | Inline comments: modern absolute `line`+`side`, `start_line`/`start_side` for multi-line, `commit_id` = head SHA | ✅ SPEC.md §5.2, src/inline.ts |
| 6.9 | Out-of-diff comment → 422 rejection → validate against diff hunks, demote strays | ✅ SPEC.md §5.2.1, src/diff.ts partitionFindings |
| 6.10 | Action versions current at time of writing, SHA-pinned for harden-runner | ✅ review-v2.yaml |
| 6.11 | Egress allowlist includes `api.anthropic.com` (CLI phones home) | ✅ review-v2.yaml line 73 |

---

## §7 — Camas-Specific Generalizations

| # | v1 (camas) | v2 (generic) | Status |
|---|---|---|---|
| 7.1 | Triage prompt lists `setup.py, conftest.py, pyproject, package.json, Makefile, tasks.py` | Generalized to "CI/CD workflows, git hooks, or build/test scripts" | ✅ review-v2.yaml line 155 |
| 7.2 | Phase-2 prompt says "run this project's checks (`uv run camas`)" | Generalized to "run this project's checks (see its README/contributing docs)" | ✅ review-v2.yaml line 199 |
| 7.3 | `astral-sh/setup-uv` hardcoded | Commented example, user swappable | ✅ review-v2.yaml lines 56-61 |
| 7.4 | Artifact/marker/workflow names use `claude-code-review` | Renamed to generic `code-review` | ✅ review-v2.yaml, SPEC.md, templates |

---

## §8 — Deliverables

| # | Deliverable | Required Shape | File(s) | Status |
|---|---|---|---|---|
| 8.1 | `SPEC.md` | Overview, Roles, Trigger/Routing, Schema ref, Posting, Cost/Usage, Threat model, GitHub Actions binding, Conformance | SPEC.md | ✅ |
| 8.2 | `schema/` version policy | Semver, `$id` to published URL per version | schema/VERSIONING.md | ✅ |
| 8.3 | `npx` package — the *commenter* | `render` (headline), `inline`, `cost`, `validate` (minor); each usable standalone | src/index.ts, src/render.ts, src/inline.ts, src/cost.ts, src/validate.ts | ✅ |
| 8.4 | `templates/` | Reference comment template: severity-folding + footer + disclosure; consumed by `render` | templates/comment.eta, templates/inline.eta | ✅ |
| 8.5 | v2 example workflow | Single-file `review.yaml`, CI-triggered, API diff fetch, triage→route→JSON, inline+sticky comment | examples/workflows/review-v2.yaml | ✅ |
| 8.6 | Adapters | Agent CLI as pluggable adapter behind interface (in: diff+CI+context; out: findings JSON) | docs/adapters.md | ✅ |

---

## §8.3 — NPX Package Command Shapes

| # | Command | Required Shape | Status |
|---|---|---|---|
| 8.3a | `render <findings.json> --template <t> --usage <envelope.json> --prices <prices.json>` | → comment markdown (severity folding, test panel, cost/model footer, disclosure) | ✅ |
| 8.3b | `inline <findings.json> --diff <pr.diff> [--template <t>]` | → GitHub reviews `comments[]` payload, in-diff only, demote strays | ✅ |
| 8.3c | `cost <envelope.json> --prices <prices.json>` | → recompute USD from `modelUsage` | ✅ |
| 8.3d | `validate <findings.json>` | → ajv against schema (defense-in-depth) | ✅ |

---

## §11 — House Rules

| # | Rule | Status |
|---|---|---|
| 11.1 | Functional style: immutable, pure functions, sum types, exhaustive matching | ✅ TS uses readonly, discriminated unions, pure functions |
| 11.2 | No redundant comments, no divider/why comments | ✅ |
| 11.3 | Types are SSOT — docstrings say *what* never *why* | ✅ |
| 11.4 | Commit authorship with `Co-Authored-By: <model-id> <noreply@<provider>>` | ⚠️ Not yet committed |
| 11.5 | Don't commit unless asked — maintainer reviews first | ⚠️ Respecting this |

---

## Cross-Cutting Verification

| # | Check | Status |
|---|---|---|
| X1 | Schema `$id` matches actual file URI | ⚠️ SPEC says `main` tracks latest, tags use `vX.Y.Z`; file has `main` — OK per VERSIONING.md |
| X2 | SPEC conformance requirements match body text (no MUST/SHOULD contradictions) | ✅ (fixed §7.3 MUST→SHOULD) |
| X3 | io-ts codecs match JSON Schema constraints (integer, min/max) | ⚠️ io-ts uses plain `t.number` without refinements; Ajv catches this in `validate` |
| X4 | Template variables match render.ts provided data | ✅ (updated for summary table model) |
| X5 | Inline comment body format includes LLM disclosure | ✅ (inline.eta has minimal disclosure) |
| X6 | Sticky comment includes all required sections per SPEC §5.1 | ✅ (marker, SHA, verdict, route, summary, findings table, test panel, cost footer, disclosure) |
| X7 | Cost recomputed from `modelUsage`, not `total_cost_usd` | ✅ (src/cost.ts) |
| X8 | Result envelope includes `modelUsage`, `usage`, `num_turns`, `duration_ms` | ✅ (src/schema.ts ResultEnvelopeCodec) |
| X9 | No shell interpolation of untrusted text in TypeScript code | ✅ (all JSON built with native serialization) |
| X10 | `parse-diff` used for diff validation, not regex | ✅ (src/diff.ts) |
