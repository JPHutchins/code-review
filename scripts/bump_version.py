#!/usr/bin/env python3
"""Derive every version-bearing surface from one version (argv[1]) — the mechanical half of a
release. The drift guard (src/version-pins.test.ts) is the backstop: a surface this script misses
fails the release commit's CI with the path named, so this list needs no mirroring.

Run as `camas bump_version -- <new-version>` (or `python3 scripts/bump_version.py <new-version>`),
then `camas build` and `camas capture_help` before committing the release.
"""

import json
import pathlib
import sys
from datetime import datetime, timezone


def replace(path: str, expected: int, pairs: tuple[tuple[str, str], ...]) -> None:
    text = pathlib.Path(path).read_text()
    for old, new in pairs:
        found = text.count(old)
        if found != expected:
            print(
                f"{path}: expected {expected} occurrence(s) of {old!r}, found {found} — "
                "the drift guard would have caught this at CI; fix the surface or this script",
                file=sys.stderr,
            )
            sys.exit(1)
        text = text.replace(old, new)
    pathlib.Path(path).write_text(text)
    print(f"{path}: bumped to {new}")


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: bump_version.py <new-version>", file=sys.stderr)
        sys.exit(2)
    new = sys.argv[1]
    current = json.loads(pathlib.Path("package.json").read_text())["version"]
    if new == current:
        print(f"already at {new}")
        sys.exit(0)
    replace("package.json", 1, ((f'"version": "{current}"', f'"version": "{new}"'),))
    replace("package-lock.json", 2, ((f'"version": "{current}"', f'"version": "{new}"'),))
    replace(
        ".github/workflows/review-reusable.yaml",
        1,
        ((f"CODE_REVIEW_VERSION: {current}", f"CODE_REVIEW_VERSION: {new}"),),
    )
    replace(
        ".github/workflows/review-on-comment-reusable.yaml",
        1,
        ((f"CODE_REVIEW_VERSION: {current}", f"CODE_REVIEW_VERSION: {new}"),),
    )
    replace(
        "examples/workflows/review.yaml",
        1,
        ((f"CODE_REVIEW_VERSION: {current}", f"CODE_REVIEW_VERSION: {new}"),),
    )
    replace("examples/workflows/review-on-comment.yaml", 1, ((f"@v{current}", f"@v{new}"),))
    replace("examples/workflows/README.md", 1, ((f"@v{current}", f"@v{new}"),))
    replace(".github/workflows/review.yaml", 1, ((f"@v{current}", f"@v{new}"),))
    stamp = datetime.now(timezone.utc).date().isoformat()
    pathlib.Path("src/released.ts").write_text(
        "// The release date, stamped by scripts/bump_version.py at release time. The staleness signal for\n"
        "// the price map (issue #220): a map whose `_updated` predates this date cannot reflect pricing the\n"
        "// CLI ships — the warn fires exactly when a consumer rolled the CLI but not the prices.\n"
        f'export const RELEASED = "{stamp}";\n'
    )
    print(f"src/released.ts: stamped RELEASED={stamp}")


if __name__ == "__main__":
    main()
