# /// script
# requires-python = ">=3.14"
# dependencies = ["camas[mcp]==0.1.21"]
# ///
"""Project tasks for code-review — a deterministic commenter for agentic PR review."""

from camas import Claude, Config, Parallel, Task, run_cli

# ---------------------------------------------------------------------------
# Checks (read-only, parallel-safe)
# ---------------------------------------------------------------------------

format_check = Task("npx prettier --check .", help="check formatting with prettier")
lint = Task("npx eslint src/", help="lint with eslint + typescript-eslint")
typecheck = Task("npx tsc --noEmit", help="static type-check with TypeScript")
test = Task("npx vitest run", help="run the vitest test suite")
build = Task("npx tsup", help="bundle with tsup (ESM, d.ts, sourcemaps)")

# ---------------------------------------------------------------------------
# Mutating tasks (formatters, fixers)
# ---------------------------------------------------------------------------

autofix = Task(
    "npx prettier --write {paths}",
    mutates=True,
    paths=".",
    help="format changed files with prettier",
)

# ---------------------------------------------------------------------------
# Composite tasks
# ---------------------------------------------------------------------------

checks = Parallel(
    format_check,
    lint,
    typecheck,
    test,
    help="all read-only checks in parallel",
)

ci = Parallel(checks, build, help="full CI pipeline")

# ---------------------------------------------------------------------------
# Project configuration
# ---------------------------------------------------------------------------

_ = Config(
    default_task=ci,
    agent=Claude(fix=autofix, check=checks),
)

if __name__ == "__main__":
    run_cli(globals())
