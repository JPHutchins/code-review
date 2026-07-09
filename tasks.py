# /// script
# requires-python = ">=3.14"
# dependencies = ["camas[mcp]==0.1.24"]
# ///
"""Project tasks for code-review — a deterministic commenter for agentic PR review."""

from pathlib import Path

from camas import Claude, Config, Parallel, Task, run_cli

format_check = Task("npx prettier --check .", help="check formatting with prettier")
lint = Task("npx eslint src/", help="lint with eslint + typescript-eslint")
typecheck = Task("npx tsc --noEmit", help="static type-check with TypeScript")
test = Task("npx vitest run", help="run the vitest test suite")
build = Task("npx tsup", help="bundle with tsup (ESM, sourcemaps)")

_workflow_yamls = tuple(
    str(p)
    for d in (Path("examples/workflows"), Path(".github/workflows"))
    for p in sorted(d.glob("*.y*ml"))
)
actionlint = Task(
    ("uvx", "--from", "actionlint-py", "actionlint", *_workflow_yamls),
    when=("examples/workflows", ".github/workflows"),
    help="lint GitHub Actions workflow YAML (examples + repo workflows)",
)

autofix = Task(
    "npx prettier --write {paths}",
    mutates=True,
    paths=".",
    help="format changed files with prettier",
)

checks = Parallel(
    format_check,
    lint,
    typecheck,
    test,
    actionlint,
    help="all read-only checks in parallel",
)

ci = Parallel(checks, build, help="full CI pipeline")

_ = Config(
    default_task=ci,
    agent=Claude(fix=autofix, check=checks),
)

if __name__ == "__main__":
    run_cli(globals())
