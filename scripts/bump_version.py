#!/usr/bin/env python3
"""Derive every version-bearing surface from one version (argv[1]) — the mechanical half of a
release. The drift guard (src/version-pins.test.ts) is the backstop: a surface this script misses
fails the release commit's CI with the path named, so this list needs no mirroring.

Run as `camas bump_version -- <new-version>` (or `python3 scripts/bump_version.py <new-version>`),
then `camas build` and `camas capture_help` before committing the release.
"""

import json
import pathlib
import re
import sys
from datetime import datetime, timezone


def replace(path: str, expected: int, pairs: tuple[tuple[str, str], ...]) -> None:
    text = pathlib.Path(path).read_text(encoding="utf-8")
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
    # encoding + newline pinned so the output is byte-identical on any platform: a locale-derived
    # encoding or CRLF translation would rewrite every file as a whole-file diff.
    pathlib.Path(path).write_text(text, encoding="utf-8", newline="\n")
    print(f"{path}: bumped to {new}")


def stamp_released() -> None:
    """Stamp src/released.ts with today's UTC date — via the same replace() drift guard, so the
    committed header stays the file's single source (it is not regenerated here). Runs even when
    the version is unchanged, so a re-run after a same-version bump re-stamps."""
    path = pathlib.Path("src/released.ts")
    text = path.read_text(encoding="utf-8")
    match = re.search(r'export const RELEASED = "([^"]+)"', text)
    if match is None:
        print('src/released.ts: no export const RELEASED = "..." line to stamp', file=sys.stderr)
        sys.exit(1)
    old = match.group(1)
    stamp = datetime.now(timezone.utc).date().isoformat()
    if old == stamp:
        print(f"src/released.ts: already stamped {stamp}")
        return
    replace("src/released.ts", 1, ((f'export const RELEASED = "{old}"', f'export const RELEASED = "{stamp}"'),))


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: bump_version.py <new-version>", file=sys.stderr)
        sys.exit(2)
    new = sys.argv[1]
    stamp_released()
    current = json.loads(pathlib.Path("package.json").read_text(encoding="utf-8"))["version"]
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


if __name__ == "__main__":
    main()
