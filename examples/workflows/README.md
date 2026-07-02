# Example workflows

These are the **proven v1** reference workflows, copied verbatim from
[camas](https://github.com/JPHutchins/camas). They posted a real sticky review comment on
[camas PR #17](https://github.com/JPHutchins/camas/pull/17#issuecomment-4859543691) and the
harden-runner egress log confirmed the containment held. Treat them as the *starting point*, not the
final spec.

## The v1 relay (what's here)

- **`collect.yaml`** — unprivileged (`pull_request`, `contents: read`). Captures `pr.diff` as an inert
  artifact and posts nothing. GitHub Security Lab "preventing pwn requests" pattern.
- **`review.yaml`** — privileged (`workflow_run`). Two jobs with separate tokens:
  - `review` — holds the model key + a **read-only** token + a locked egress. Two-phase gate:
    (1) data-only security triage of the diff → `{safe, reasons}`; (2) if safe, `git apply` + agentic
    `claude -p "/code-review"`, output as free-form markdown.
  - `comment` — holds the write token, runs **no agent and no PR code**; posts the sticky comment.

## v1 → v2 delta (see [`../../docs/design.md`](../../docs/design.md))

| | v1 (here) | v2 (target) |
| --- | --- | --- |
| Files | `collect.yaml` + `review.yaml` | just `review.yaml` (+ your unchanged `ci.yaml`) — **collector dropped** |
| Trigger | off the collector | off the **CI workflow** completing |
| Routing | none (always full review) | route on `workflow_run.conclusion` — green→reviewer, red→mechanic |
| Diff source | collector artifact | `gh api pulls/{N} -H 'Accept: …diff'` (data, no fork checkout) |
| Agent output | free-form markdown | **structured JSON** (`schema/findings.schema.json`) |
| Posting | sticky comment only | sticky summary **+ inline comments + suggestions** |
| Reporting | none | token/cost/model footer |
| Context | diff only | + previous review + PR conversation (fetched as data) |

## Camas-specific lines to generalize before reuse

- **Triage prompt** (`review.yaml`) lists Python execution vectors (`setup.py`, `conftest.py`,
  `pyproject` build backend, `package.json` scripts, `Makefile`, `tasks.py`). Generalize to
  "build/test/CI scripts and anything that runs on install or test."
- **Phase-2 `--append-system-prompt`** says "run this project's checks (`uv run camas` — see README and
  CLAUDE.md)." Generalize to your project's check command, or make it a workflow input.
- **`astral-sh/setup-uv`** assumes Python. Swap for your ecosystem's setup, or drop it.

## To try it (today)

1. Copy both files into `.github/workflows/`.
2. Add a repo secret `DEEPSEEK_API_KEY` — a **burner key with a hard spend cap** (it is exposed to
   untrusted PR code during the contained phase-2 window).
3. The `workflow_run` half only activates from the **default branch** — merge first, then open a test
   PR. The introducing PR won't review itself.
4. First run: consider `egress-policy: audit` to discover the real allowlist, then switch to `block`.
