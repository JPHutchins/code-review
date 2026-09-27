#!/usr/bin/env python3
"""Capture the published-help fixtures from the freshly built dist — the post/seed-draft --help
renders the workflow probes verify against (src/workflow-probe.test.ts). Run after `camas build`
in the same release commit, so the fixtures are byte-identical to what CI's probes match against.
"""

import json
import os
import pathlib
import subprocess
import sys

version = json.loads(pathlib.Path("package.json").read_text(encoding="utf-8"))["version"]
short = version.removeprefix("0.1.0-")
env = {**os.environ, "CI": "true", "NO_COLOR": "1"}
for command in ("post", "seed-draft"):
    result = subprocess.run(
        ["node", "dist/index.js", command, "--help"],
        capture_output=True,
        text=True,
        # The decode must match the write below, or a non-UTF-8 locale round-trips mojibake into
        # the fixtures.
        encoding="utf-8",
        env=env,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)
    path = pathlib.Path(f"test/fixtures/published-help/{command}-{short}.txt")
    path.write_text(result.stdout, encoding="utf-8", newline="")
    print(f"captured {path}")
