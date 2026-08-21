import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, "..");

const configuredModelIds = (relativePath: string): readonly string[] =>
  readFileSync(resolvePath(repoRoot, relativePath), "utf-8").match(
    /deepseek-v4-[a-z0-9-]+(?:\[1m\])?/g,
  ) ?? [];

const modelConfigSurfaces = [
  ".github/workflows/review.yaml",
  ".github/workflows/review-on-comment.yaml",
  ".github/workflows/review-selftest.yaml",
  ".github/workflows/review-reusable.yaml",
  "examples/workflows/review.yaml",
  "examples/workflows/review-on-comment.yaml",
  "examples/workflows/README.md",
] as const;

// Both deepseek-v4 models carry a 1M context window, but the agent CLI assumes 200k for any id it
// does not recognize and starts compacting the review's own evidence away well before that. The
// `[1m]` suffix is what corrects it, and dropping the suffix fails silently — no error, just a
// reviewer with a shorter memory — so every id these surfaces configure is pinned to carry it.
describe("1M context window declaration (#157)", () => {
  for (const path of modelConfigSurfaces) {
    it(`${path} declares [1m] on every model id it configures`, () => {
      const ids = configuredModelIds(path);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(id).toMatch(/\[1m\]$/);
    });
  }
});
