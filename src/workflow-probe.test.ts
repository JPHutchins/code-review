import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { allWorkflows, readRepoFile } from "./test-util.js";

// The capability probes (seed_accepts/post_accepts) live as inline bash in the workflows, and their
// correctness depends on citty's --help rendering — a version-mutable, human-facing surface. These
// tests extract the REAL functions from the REAL workflow files and run them through bash against
// the REAL published help (captured fixtures), so a rendering change in either citty or the
// workflow fails here instead of silently dropping flags in CI (issue #233 r2 — the systemic that
// followed a probe change verified against the wrong help text).
//
// Fixture provenance: test/fixtures/published-help/*.txt are captures of the REAL published
// package's --help, taken by running the published tarball's dist directly with
// `CI=true NO_COLOR=1 node <dir>/dist/index.js <cmd> --help` (after `npm pack
// @jphutchins/code-review@<ver>` + `npm --prefix <dir> install`). The workflow's capture commands
// themselves set NO_COLOR=1 (issue #238 r2 — under CI alone citty styles the description and
// section labels, and a styled-option-name change would blind every probe while these fixtures
// stayed green), so the fixtures are byte-identical to what CI's probes actually match against.
// The CURRENT generation is tied to the workflow's pinned CODE_REVIEW_VERSION (asserted below) —
// a release commit refreshes the current pair from the freshly built dist, the same bytes prepack
// publishes. Earlier captures were poisoned by the npx cache (`~/.npm/_npx` held an alpha.40-era
// install that `npx -y` reused) and were deleted — never verify package output through npx; run
// the tarball's dist.

const workflowTexts = (): readonly string[] => allWorkflows().map(readRepoFile);

const stepScripts = (text: string): readonly string[] => {
  const doc = parseYaml(text) as {
    jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
  };
  return Object.values(doc.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).flatMap((s) => (s.run !== undefined ? [s.run] : [])),
  );
};

// The functions are deliberately ONE-LINE definitions so this extraction stays exact. The
// word-boundary anchor keeps a comment or echo mentioning a probe name from being extracted first.
const FN_RE = /\b(seed_accepts|post_accepts)\(\) \{ [^}]* \}/g;

const probeSites = (): readonly { name: "seed_accepts" | "post_accepts"; fn: string }[] => {
  const sites = workflowTexts().flatMap((text) =>
    stepScripts(text).flatMap((script) =>
      [...script.matchAll(FN_RE)].map((m) => ({
        name: m[1] as "seed_accepts" | "post_accepts",
        fn: m[0],
      })),
    ),
  );
  // A reformatted probe definition would silently truncate or stop matching FN_RE, and the empty
  // extraction would surface as a confusing per-flag probe failure — fail loudly at the source.
  if (sites.length === 0) {
    throw new Error(
      "no probe definitions extracted from the workflows — FN_RE no longer matches the probe format",
    );
  }
  return sites;
};

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
    const postHelp = readRepoFile("test/fixtures/published-help/post-alpha52.txt");
    // The historical pair pins its OWN version line: the post pair differs from the 53 pair only in
    // that line, so an unpinned fixture could be silently re-captured from the wrong generation
    // (issue #238 r2).
    expect(postHelp).toContain("code-review post v0.1.0-alpha.52");
    expect(runProbe("post_accepts", postFn, postHelp, "json-url")).toBe("yes");
    expect(runProbe("post_accepts", postFn, postHelp, "cloc-diff")).toBe("yes");
    expect(runProbe("post_accepts", postFn, postHelp, "bogus-flag")).toBe("no");
  });

  it("reports the published seed-draft as lacking --prior-findings (it predates #217)", () => {
    const seedFn = sites.find((s) => s.name === "seed_accepts")!.fn;
    const seedHelp = readRepoFile("test/fixtures/published-help/seed-draft-alpha52.txt");
    expect(seedHelp).toContain("code-review seed-draft v0.1.0-alpha.52");
    expect(runProbe("seed_accepts", seedFn, seedHelp, "prior")).toBe("yes");
    // The probe matches help PROSE too ("re-derived from --prior" in the floor's description), so a
    // citty that dropped --prior from OPTIONS would still pass the positive check — pin the option
    // column itself (issue #238 r2).
    expect(seedHelp).toMatch(/^\s+`--prior`\s+/m);
    expect(runProbe("seed_accepts", seedFn, seedHelp, "prior-findings")).toBe("no");
    expect(runProbe("seed_accepts", seedFn, seedHelp, "prior-answers")).toBe("yes");
    expect(runProbe("seed_accepts", seedFn, seedHelp, "nit-visibility-floor")).toBe("yes");
  });

  // The alpha.53 pair is historical now (the 52→53 boundary: the seed gains --prior-findings and the
  // post side's CI-gated flags probe against its OPTIONS block), pinned to its own version line like
  // the alpha.52 pair — only the CURRENT generation ties to the workflow's pin.
  it("reports the published alpha.53 as carrying the prior-findings channel and the CI-gated post flags", () => {
    const seedFn = sites.find((s) => s.name === "seed_accepts")!.fn;
    const postFn = sites.find((s) => s.name === "post_accepts")!.fn;
    const seedHelp53 = readRepoFile("test/fixtures/published-help/seed-draft-alpha53.txt");
    const postHelp53 = readRepoFile("test/fixtures/published-help/post-alpha53.txt");
    expect(seedHelp53).toContain("code-review seed-draft v0.1.0-alpha.53");
    expect(postHelp53).toContain("code-review post v0.1.0-alpha.53");
    expect(runProbe("seed_accepts", seedFn, seedHelp53, "prior-findings")).toBe("yes");
    expect(runProbe("post_accepts", postFn, postHelp53, "inline")).toBe("yes");
    expect(runProbe("post_accepts", postFn, postHelp53, "unverified-no-logs")).toBe("yes");
    expect(runProbe("post_accepts", postFn, postHelp53, "nit-visibility-floor")).toBe("yes");
  });

  // The current generation's version strings are tied to the workflow's pinned CODE_REVIEW_VERSION —
  // the source of truth for what CI installs — so a release that bumps the pin while the fixtures
  // lag fails HERE (a self-referential pin only proved the fixture matched its own filename). The
  // release commit refreshes this pair from the freshly built dist.
  it("reports the published pinned generation as carrying the CI-gated flags", () => {
    const seedFn = sites.find((s) => s.name === "seed_accepts")!.fn;
    const postFn = sites.find((s) => s.name === "post_accepts")!.fn;
    const pinnedVersions = workflowTexts().flatMap((text) => {
      const version = (parseYaml(text) as { env?: { CODE_REVIEW_VERSION?: string } }).env
        ?.CODE_REVIEW_VERSION;
      return version === undefined ? [] : [version];
    });
    expect(new Set(pinnedVersions).size).toBe(1);
    const pinnedVersion = pinnedVersions[0]!;
    const shortPin = pinnedVersion.replace("0.1.0-", "");
    const seedHelp = readRepoFile(`test/fixtures/published-help/seed-draft-${shortPin}.txt`);
    const postHelp = readRepoFile(`test/fixtures/published-help/post-${shortPin}.txt`);
    expect(seedHelp).toContain(`code-review seed-draft v${pinnedVersion}`);
    expect(postHelp).toContain(`code-review post v${pinnedVersion}`);
    expect(runProbe("seed_accepts", seedFn, seedHelp, "prior-findings")).toBe("yes");
    expect(runProbe("post_accepts", postFn, postHelp, "inline")).toBe("yes");
    expect(runProbe("post_accepts", postFn, postHelp, "unverified-no-logs")).toBe("yes");
    expect(runProbe("post_accepts", postFn, postHelp, "nit-visibility-floor")).toBe("yes");
  });

  // The real fixtures are backtick-quoted, so they exercise only that branch of the pattern — this
  // pins the PLAIN alternative the workflow comment says exists for older published renderings, so
  // neither branch can rot silently (issue #238 r2).
  it("matches a help text that renders option names plain (pre-0.1.6 CLIs)", () => {
    const postFn = sites.find((s) => s.name === "post_accepts")!.fn;
    const plain =
      "OPTIONS\n    --inline  Inline review comments.\n    --cloc-diff  The cloc table.\n";
    expect(runProbe("post_accepts", postFn, plain, "inline")).toBe("yes");
    expect(runProbe("post_accepts", postFn, plain, "cloc-diff")).toBe("yes");
    expect(runProbe("post_accepts", postFn, plain, "bogus-flag")).toBe("no");
  });

  // The capture-condition ↔ call-site coverage: both #236 regressions were a probe call firing
  // against an uncaptured help. Pin the concrete invariants that failed (issue #236 r3). Scoped to
  // the workflow files that DEFINE the probes, whatever future file that is (issue #238 r2).
  it("covers every probe call site with its help-capture condition", () => {
    const probeWorkflows = workflowTexts().filter((t) => /seed_accepts\(\) \{/.test(t));
    expect(probeWorkflows.length).toBeGreaterThanOrEqual(2);
    for (const text of probeWorkflows) {
      const scripts = stepScripts(text);
      const postCapture = scripts.find((s) =>
        s.includes('POST_HELP="$(NO_COLOR=1 code-review post --help'),
      );
      const seedCapture = scripts.find((s) =>
        s.includes('SEED_HELP="$(NO_COLOR=1 code-review seed-draft --help'),
      );
      expect(postCapture).toBeDefined();
      expect(seedCapture).toBeDefined();
      // The capture's enclosing GATE must name every trigger — the prior whole-block toContain was
      // satisfiable by the flag-passing sections below the gate, so deleting or inverting the gate
      // left every assertion green (issue #238 r2). The gate is the nearest if/elif line above the
      // capture command.
      const gateOf = (script: string, captureNeedle: string): string => {
        const lines = script.split("\n");
        const captureIndex = lines.findIndex((l) => l.includes(captureNeedle));
        return (
          lines
            .slice(0, captureIndex)
            .reverse()
            .find((l) => l.includes("if [") || l.includes("elif [")) ?? ""
        );
      };
      expect(gateOf(postCapture!, 'POST_HELP="$(NO_COLOR=1')).toContain("$NIT_VISIBILITY_FLOOR");
      expect(gateOf(postCapture!, 'POST_HELP="$(NO_COLOR=1')).toContain("$REVIEW_ROUTE");
      expect(gateOf(postCapture!, 'POST_HELP="$(NO_COLOR=1')).toContain("findings/cloc-diff.txt");
      // $INLINE gates the reusable's --inline pass (a caller input); the example copy passes no
      // inline flag, so its gate intentionally omits the term (documented at its capture site).
      if (text.includes("$INLINE")) {
        expect(gateOf(postCapture!, 'POST_HELP="$(NO_COLOR=1')).toContain("$INLINE");
      }
      // The seed side captures on a real prior, in either channel.
      expect(gateOf(seedCapture!, 'SEED_HELP="$(NO_COLOR=1')).toContain("$HAS_PRIOR");
      expect(gateOf(seedCapture!, 'SEED_HELP="$(NO_COLOR=1')).toContain("$HAS_PRIOR_FINDINGS");
      // A "predates" warning may only fire when the help was actually captured — the nearest
      // if/elif guard above the warning must carry the _OK check (issue #236 r3).
      for (const script of scripts) {
        const lines = script.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.includes("predates") && lines[i]!.includes("::warning::")) {
            const guard = lines
              .slice(0, i)
              .reverse()
              .find((l) => l.includes("elif [") || l.includes("if ["));
            expect(guard, "a predates warning without its _OK gate").toContain("_OK");
          }
        }
      }
    }
  });
});
