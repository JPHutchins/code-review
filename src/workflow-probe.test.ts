import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { repoRoot } from "./test-util.js";

// The capability probes (seed_accepts/post_accepts) live as inline bash in the workflows, and their
// correctness depends on citty's --help rendering — a version-mutable, human-facing surface. These
// tests extract the REAL functions from the REAL workflow files and run them through bash against
// the REAL published help (captured fixtures) plus a backtick-quoted variant, so a rendering change
// in either citty or the workflow fails here instead of silently dropping flags in CI (issue #233
// r2 — the systemic that followed a probe change verified against the wrong help text).
//
// Fixture provenance: test/fixtures/published-help/*.txt are captures of the REAL published
// alpha.52 package's --help, taken 2026-08-30 by running the published tarball's dist directly
// (`npm pack @jphutchins/code-review@0.1.0-alpha.52`, `npm --prefix <dir> install`, then
// `node <dir>/dist/index.js <cmd> --help`). Earlier captures were poisoned by the npx cache
// (`~/.npm/_npx` held an alpha.40-era install that `npx -y` reused) and were deleted — never
// verify package output through npx; run the tarball's dist.

const workflowPaths = [".github/workflows/review-reusable.yaml", "examples/workflows/review.yaml"];

const workflowTexts = (): readonly string[] =>
  workflowPaths.map((p) => readFileSync(`${repoRoot}/${p}`, "utf-8"));

const stepScripts = (text: string): readonly string[] => {
  const doc = parseYaml(text) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
  return Object.values(doc.jobs).flatMap((job) =>
    job.steps.flatMap((s) => (s.run !== undefined ? [s.run] : [])),
  );
};

// The functions are deliberately ONE-LINE definitions so this extraction stays exact.
const FN_RE = /(seed_accepts|post_accepts)\(\) \{ [^}]* \}/g;

const probeSites = (): readonly { name: "seed_accepts" | "post_accepts"; fn: string }[] =>
  workflowTexts().flatMap((text) =>
    stepScripts(text).flatMap((script) =>
      [...script.matchAll(FN_RE)].map((m) => ({
        name: m[1] as "seed_accepts" | "post_accepts",
        fn: m[0],
      })),
    ),
  );

const runProbe = (
  name: "seed_accepts" | "post_accepts",
  fn: string,
  help: string,
  flag: string,
): string => {
  const result = spawnSync("bash", ["-c", `${fn}\n${name} ${flag} && echo yes || echo no`], {
    env: { ...process.env, [name === "seed_accepts" ? "SEED_HELP" : "POST_HELP"]: help },
    encoding: "utf-8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

describe("workflow capability probes (issue #233 r2)", () => {
  const sites = probeSites();

  it("defines the probes identically in both workflow copies, with no pipe to race", () => {
    const seed = sites.filter((s) => s.name === "seed_accepts").map((s) => s.fn);
    const post = sites.filter((s) => s.name === "post_accepts").map((s) => s.fn);
    expect(seed.length).toBe(2);
    expect(post.length).toBe(2);
    expect(new Set(seed).size).toBe(1);
    expect(new Set(post).size).toBe(1);
    // The `|` in the case pattern is the pattern-alternative separator, not a pipeline — the
    // subprocess-free guarantee is what this checks (a pipeline has whitespace around the pipe).
    for (const s of sites) expect(s.fn).not.toMatch(/\s\|\s/);
  });

  it("accepts a flag the real published alpha.52 help carries, and rejects a bogus one", () => {
    const postFn = sites.find((s) => s.name === "post_accepts")!.fn;
    const postHelp = readFileSync(
      `${repoRoot}/test/fixtures/published-help/post-alpha52.txt`,
      "utf-8",
    );
    expect(runProbe("post_accepts", postFn, postHelp, "json-url")).toBe("yes");
    expect(runProbe("post_accepts", postFn, postHelp, "cloc-diff")).toBe("yes");
    expect(runProbe("post_accepts", postFn, postHelp, "bogus-flag")).toBe("no");
  });

  it("reports the published seed-draft as lacking --prior-findings (it predates #217)", () => {
    const seedFn = sites.find((s) => s.name === "seed_accepts")!.fn;
    const seedHelp = readFileSync(
      `${repoRoot}/test/fixtures/published-help/seed-draft-alpha52.txt`,
      "utf-8",
    );
    expect(runProbe("seed_accepts", seedFn, seedHelp, "prior")).toBe("yes");
    expect(runProbe("seed_accepts", seedFn, seedHelp, "prior-findings")).toBe("no");
    expect(runProbe("seed_accepts", seedFn, seedHelp, "prior-answers")).toBe("yes");
    expect(runProbe("seed_accepts", seedFn, seedHelp, "nit-visibility-floor")).toBe("yes");
  });

  it("matches a help text that backtick-quotes option names", () => {
    const postFn = sites.find((s) => s.name === "post_accepts")!.fn;
    const quoted =
      "OPTIONS\n  `--inline`  Inline review comments.\n  `--cloc-diff`  The cloc table.\n";
    expect(runProbe("post_accepts", postFn, quoted, "inline")).toBe("yes");
    expect(runProbe("post_accepts", postFn, quoted, "cloc-diff")).toBe("yes");
    expect(runProbe("post_accepts", postFn, quoted, "bogus-flag")).toBe("no");
  });
});
