import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { readRepoFile, repoRoot, WORKFLOW_EXTENSIONS } from "./test-util.js";
import { readPackageVersion } from "./index.js";

// The pin shape, wherever a consumer-facing surface names it: a uses: line in a workflow or a
// doc's fenced example (the line rule below), possibly commented out (the internal dogfood
// trigger documents its pin in a comment). The capture is semver.org's recommended expression —
// strict enough that prose punctuation ending the ref (…@v0.1.0-alpha.60.) is never swallowed,
// and +build metadata (0.1.0-alpha.60+fix) captures whole. The @v prefix is optional (a v-less
// ref is a legal pin the guard must not silently ignore) and the owner/filename classes are
// case-permissive (GitHub treats owner names case-insensitively).
const PINNED_REF_RE =
  /JPHutchins\/code-review\/\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml@v?((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/gi;

const pinnedRefsOf = (
  path: string,
): readonly { readonly line: number; readonly version: string }[] =>
  readRepoFile(path)
    .split("\n")
    .flatMap((line, index) => {
      // A pin lives on a workflow-reference line (mapping or list form, commented or not).
      // Restricting to reference lines is what lets the scan be repo-wide: historical version
      // citations in prose (workflow-probe.test.ts names alpha.52/alpha.53) are not pins and must
      // not fail a release.
      const stripped = line.replace(/^\s*(?:[-#]\s*)*/, "");
      if (!stripped.startsWith("uses:")) return [];
      return [...line.matchAll(PINNED_REF_RE)].map((m) => ({
        line: index + 1,
        version: m[1]!,
      }));
    });

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", ".camas"]);

const walk = (directory: string): readonly string[] =>
  readdirSync(resolvePath(repoRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRECTORIES.has(entry.name)) return [];
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return walk(relative);
    if (entry.isSymbolicLink()) {
      // A symlinked directory must be followed, not read as a file (EISDIR); a broken link skipped.
      try {
        return statSync(resolvePath(repoRoot, relative)).isDirectory()
          ? walk(relative)
          : [relative];
      } catch {
        return [];
      }
    }
    return [relative];
  });

// The extension policy reuses the shared workflow extensions (test-util.ts's one-policy rule); the
// docs half is the only addition.
const PIN_SURFACE_EXTENSIONS = [...WORKFLOW_EXTENSIONS, ".md"] as const;

const pinSurfaces = (): readonly string[] =>
  walk(".").filter((path) => PIN_SURFACE_EXTENSIONS.some((extension) => path.endsWith(extension)));

describe("copy-paste version pins (#207)", () => {
  // The guard's boundary: pins must equal package.json — the version about to be published — so
  // the check runs at the release commit, before the tag exists. That ordering is deliberate: a
  // miss must fail before a tag is pushed. release.yaml's tag guard then enforces the pushed tag
  // carries that same version, and tag + npm publish ride the same push.
  const expected = readPackageVersion();

  it("every pinned JPHutchins/code-review workflow ref matches package.json's version", () => {
    const sites = pinSurfaces().flatMap((path) =>
      pinnedRefsOf(path).map((site) => ({ path, ...site })),
    );
    // The vacuity tripwire reads the SAME collection the comparison does, so a narrowing edit
    // cannot leave one loop green off files the other no longer reads.
    expect(sites.length).toBeGreaterThan(0);
    expect(
      sites.flatMap((site) =>
        site.version === expected
          ? []
          : [`${site.path}:${String(site.line)}: @v${site.version} (expected ${expected})`],
      ),
    ).toEqual([]);
  });

  it("src/released.ts carries a plausible release date (stamped by the bump flow)", () => {
    const match = readRepoFile("src/released.ts").match(/export const RELEASED = "([^"]+)"/);
    expect(match).not.toBeNull();
    const date = match![1]!;
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Round-trips through Date as its own UTC day — a malformed stamp fails here, and a typo'd
    // year (a hand-rolled future date) must not ship: the stamp is the release day.
    expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
    expect(date <= new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it("package-lock.json's two version fields ride package.json's too", () => {
    const lock = JSON.parse(readRepoFile("package-lock.json")) as {
      version?: unknown;
      packages?: { ""?: { version?: unknown } };
    };
    expect(lock.version).toBe(expected);
    expect(lock.packages?.[""]?.version).toBe(expected);
  });
});
