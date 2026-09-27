import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { allWorkflows, readRepoFile, repoRoot } from "./test-util.js";

// A pinned JPHutchins/code-review workflow ref, wherever it appears — a uses: line or a doc
// comment. The capture is the bare version so `@v`-prefixed refs and the workflow pins compare
// against package.json with one shape.
const PINNED_REF_RE =
  /JPHutchins\/code-review\/\.github\/workflows\/[a-z0-9-]+\.ya?ml@v([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)/g;

const walk = (directory: string): readonly string[] =>
  readdirSync(resolvePath(repoRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(relative) : [relative];
  });

const packageVersion = (): string =>
  (JSON.parse(readRepoFile("package.json")) as { version: string }).version;

describe("copy-paste version pins (#207)", () => {
  // Every copy-paste surface that names a pinned ref: the example workflows, their README, the
  // adapter docs, and the internal workflows' doc comments. A release that misses one fails HERE
  // with the path and the expected version, instead of a consumer copy-pasting a 25-release-old
  // reusable.
  const surfaces = [
    ...walk("examples"),
    ...walk("docs"),
    ...walk(".github/workflows"),
    "README.md",
  ].filter((path) => /\.(ya?ml|md)$/.test(path));

  const pinnedRefsOf = (path: string): readonly string[] =>
    [...readRepoFile(path).matchAll(PINNED_REF_RE)].map((m) => m[1]!);

  it("every pinned JPHutchins/code-review workflow ref matches package.json's version", () => {
    const expected = packageVersion();
    const mismatches = surfaces.flatMap((path) =>
      pinnedRefsOf(path).flatMap((version) =>
        version === expected ? [] : [`${path}: @v${version} (expected ${expected})`],
      ),
    );
    // The guard must not rot to vacuity — the docs pin at least one ref, or the regex drifted.
    expect(surfaces.flatMap(pinnedRefsOf).length).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });

  it("the workflow CODE_REVIEW_VERSION pins agree with package.json's version", () => {
    const expected = packageVersion();
    const pins = allWorkflows().flatMap((path) => {
      const version = (parseYaml(readRepoFile(path)) as { env?: { CODE_REVIEW_VERSION?: string } })
        .env?.CODE_REVIEW_VERSION;
      return version === undefined ? [] : [version];
    });
    expect(pins.length).toBeGreaterThan(0);
    expect(pins.every((version) => version === expected)).toBe(true);
  });
});
