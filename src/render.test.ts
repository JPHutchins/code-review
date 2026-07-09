import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "./render.js";
import { formatConfidence } from "./surface.js";
import type {
  Findings,
  ResultEnvelope,
  PriceMap,
  Finding,
  ModelUsageEntry,
  TestSummary,
} from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(__dirname, "..", "templates", "comment.eta"), "utf-8");

const prices: PriceMap = {
  _updated: "2026-07-03",
  _unit: "USD per 1M tokens",
  models: {
    "pro-model": { in: 3.0, out: 15.0, cache_read: 0.3, cache_write: 0.6 },
  },
};

const mkEntry = (overrides: Partial<ModelUsageEntry>): ModelUsageEntry => ({
  model: "pro-model",
  input_tokens: 10000,
  output_tokens: 2000,
  cache_read_tokens: 5000,
  cache_write_tokens: 1000,
  ...overrides,
});

const baseEnvelope: ResultEnvelope = {
  schema_version: "0.4.0",
  findings: {
    schema_version: "0.4.0",
    summary: "test summary",
    verdict: "comment",
    findings: [],
  },
  models: [mkEntry({})],
  turns: 1,
  duration_ms: 30000,
  vendor_cost_usd: 0.042,
};

const mkFinding = (overrides: Partial<Finding>): Finding => ({
  path: "src/foo.ts",
  start_line: 42,
  end_line: 42,
  severity: "minor",
  title: "Test finding",
  description: "Test description content.",
  reasoning: "Test reasoning content.",
  confidence: 0.7,
  ...overrides,
});

const mkFindings = (
  findings: Finding[],
  overrides?: Partial<Omit<Findings, "findings">>,
): Findings => ({
  schema_version: "0.4.0",
  summary: "A test summary.",
  verdict: "comment",
  findings,
  ...overrides,
});

// Structural (not substring) assertions on rendered markdown — see the describe blocks below that
// use these. A blank line inserted mid-table (the shipped bug: `<% forEach %>` on its own line
// under Eta({autoTrim:false}) emitted one before every row) still lets `toContain` checks pass,
// since the broken table's text is all still present — it's just no longer contiguous rows GitHub
// recognizes as one table. These helpers make that contiguity itself the assertion.

/** Longest prefix of `items` for which `predicate` holds. */
const takeWhile = <T>(items: readonly T[], predicate: (item: T) => boolean): T[] => {
  const stopIndex = items.findIndex((item) => !predicate(item));
  return stopIndex === -1 ? [...items] : items.slice(0, stopIndex);
};

/** The contiguous run of lines starting at the first line matching `start`, while `keep` holds. */
const contiguousBlockFrom = (
  markdown: string,
  start: (line: string) => boolean,
  keep: (line: string) => boolean,
): string[] => {
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex(start);
  return startIndex === -1 ? [] : takeWhile(lines.slice(startIndex), keep);
};

/** Cell count of a `|`-delimited markdown table row (the outer pipes contribute no cell). */
const columnCount = (row: string): number => row.split("|").length - 2;

describe("formatConfidence (issue #26 — always 2 decimal places)", () => {
  it("pads a whole number to 2 decimal places", () => {
    expect(formatConfidence(1)).toBe("1.00");
  });

  it("pads a single decimal place", () => {
    expect(formatConfidence(0.6)).toBe("0.60");
  });

  it("truncates nothing already at 2 decimal places", () => {
    expect(formatConfidence(0.75)).toBe("0.75");
  });

  it("formats zero", () => {
    expect(formatConfidence(0)).toBe("0.00");
  });
});

describe("render", () => {
  it("produces output with the <!-- code-review --> marker", () => {
    const findings = mkFindings([]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
    expect(result).toContain("<!-- code-review -->");
  });

  it("renders the reviewed-sha when provided", () => {
    const findings = mkFindings([]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      reviewedSha: "abc123def456",
      route: "full review",
    });
    expect(result).toContain("abc123def456");
  });

  it("falls back to a zero-sha when reviewedSha is omitted", () => {
    const findings = mkFindings([]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
    expect(result).toContain("0000000000000000000000000000000000000000");
  });

  describe("sticky posted-at line (issue #28)", () => {
    it("renders 'Reviewed `<short-sha>` · <postedAt>' right under the verdict heading when postedAt is set", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        reviewedSha: "abc123def456",
        postedAt: "2026-07-07 18:42 UTC",
      });
      expect(result).toContain("Reviewed `abc123d` · 2026-07-07 18:42 UTC");
      const lines = result.split("\n");
      const headingIndex = lines.findIndex((l) => l.startsWith("### "));
      expect(lines[headingIndex + 1]).toBe("Reviewed `abc123d` · 2026-07-07 18:42 UTC");
    });

    it("omits the Reviewed line entirely when postedAt is not provided", () => {
      const findings = mkFindings([]);
      const result = render({ findings, envelope: baseEnvelope, prices, template });
      expect(result).not.toContain("Reviewed `");
    });
  });

  describe("findings-json marker (issue #15; embedded base64 — PR #17 review)", () => {
    it("embeds the findings JSON as base64 and omits the visible advisory", () => {
      const findings = mkFindings([mkFinding({ severity: "major", title: "M" })]);
      const result = render({ findings, envelope: baseEnvelope, prices, template });
      expect(result).toContain("<!-- code-review:findings-json;base64 ");
      expect(result).not.toContain("Reviewing agents: fetch");
    });

    it("round-trips the exact findings object through the embedded base64 marker", () => {
      const findings = mkFindings([
        mkFinding({ severity: "critical", title: "Round-trip me", description: "detail here" }),
      ]);
      const result = render({ findings, envelope: baseEnvelope, prices, template });
      const match = /<!-- code-review:findings-json;base64 (\S+) -->/.exec(result);
      expect(match).not.toBeNull();
      const decoded: unknown = JSON.parse(
        Buffer.from(match?.[1] ?? "", "base64").toString("utf-8"),
      );
      expect(decoded).toEqual(findings);
    });

    it("falls back to the jsonUrl link marker when the embedded payload is too large", () => {
      const findings = mkFindings(
        Array.from({ length: 500 }, (_, i) =>
          mkFinding({
            title: `Finding ${String(i)}`,
            description: "x".repeat(200),
          }),
        ),
      );
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        jsonUrl: "https://example.com/findings.json",
      });
      expect(result).toContain(
        "<!-- code-review:findings-json https://example.com/findings.json -->",
      );
      expect(result).not.toContain(";base64");
    });

    it("omits both markers when the embedded payload is too large and no jsonUrl is given", () => {
      const findings = mkFindings(
        Array.from({ length: 500 }, (_, i) =>
          mkFinding({
            title: `Finding ${String(i)}`,
            description: "x".repeat(200),
          }),
        ),
      );
      const result = render({ findings, envelope: baseEnvelope, prices, template });
      expect(result).not.toContain("findings-json");
    });

    it("keeps the <!-- code-review --> marker as the first line even when embedding findings", () => {
      const findings = mkFindings([]);
      const result = render({ findings, envelope: baseEnvelope, prices, template });
      expect(result.split("\n")[0]).toBe("<!-- code-review -->");
    });
  });

  describe("severity counts line (summary-only sticky)", () => {
    it("renders a per-severity count histogram, not a per-finding table", () => {
      const findings = mkFindings([
        mkFinding({ severity: "critical", title: "CRIT" }),
        mkFinding({ severity: "major", title: "MAJ-a" }),
        mkFinding({ severity: "major", title: "MAJ-b" }),
        mkFinding({ severity: "minor", title: "MIN" }),
      ]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });

      expect(result).toContain("**Findings:**");
      expect(result).toContain("🔴 1");
      expect(result).toContain("🟠 2");
      expect(result).toContain("🔵 1");
      // The redesigned sticky does not reproduce the per-finding list the review carries.
      expect(result).not.toContain("| Severity | File | Line | Summary |");
      expect(result).not.toContain("MAJ-a");
      expect(result).not.toContain("Findings summary");
    });

    it("omits zero-count severities from the histogram", () => {
      const findings = mkFindings([mkFinding({ severity: "nit", title: "NIT" })]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });

      expect(result).toContain("⚪ 1");
      expect(result).not.toContain("🔴");
      expect(result).not.toContain("🟠");
      expect(result).not.toContain("🔵");
    });

    it("computes the histogram from findings when no severityCounts override is passed", () => {
      const findings = mkFindings([
        mkFinding({ severity: "major", title: "M1" }),
        mkFinding({ severity: "major", title: "M2" }),
        mkFinding({ severity: "major", title: "M3" }),
      ]);
      const result = render({ findings, envelope: baseEnvelope, prices, template });
      expect(result).toContain("🟠 3");
    });

    it("uses a passed-in severityCounts override verbatim", () => {
      const findings = mkFindings([mkFinding({ severity: "minor", title: "one" })]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        severityCounts: { critical: 2, major: 0, minor: 5, nit: 0 },
      });
      expect(result).toContain("🔴 2");
      expect(result).toContain("🔵 5");
      expect(result).not.toContain("🟠");
    });
  });

  describe("inline-disposition pointer (honesty — fix #2)", () => {
    const findings = mkFindings([mkFinding({ severity: "minor" })]);

    it("states how many comments were posted inline, on the short SHA", () => {
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        inlineDisposition: { kind: "posted", count: 3, sha: "abc123def456" },
      });
      expect(result).toContain("posted inline");
      expect(result).toContain("abc123d");
    });

    it("links 'see the review' when reviewUrl is set (issue #11)", () => {
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        inlineDisposition: { kind: "posted", count: 1, sha: "abc123def456" },
        reviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-1",
      });
      expect(result).toContain(
        "[see the review](https://github.com/o/r/pull/1#pullrequestreview-1)",
      );
    });

    it("keeps 'see the review' as plain text when reviewUrl is absent (issue #11)", () => {
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        inlineDisposition: { kind: "posted", count: 1, sha: "abc123def456" },
      });
      expect(result).toContain("— see the review.");
      expect(result).not.toContain("[see the review]");
    });

    it("says no inline comments when all findings are outside the diff", () => {
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        inlineDisposition: { kind: "none-in-diff" },
      });
      expect(result).toContain("No inline comments");
      expect(result).not.toContain("posted inline");
    });

    it("says the inline review was suppressed for an already-reviewed SHA", () => {
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        inlineDisposition: { kind: "suppressed-existing-review", sha: "abc123def456" },
      });
      expect(result).toContain("suppressed");
      expect(result).toContain("abc123d");
      expect(result).not.toContain("posted inline");
    });

    it("emits no disposition pointer for no-envelope renders", () => {
      const result = render({
        findings,
        envelope: null,
        prices,
        template,
        inlineDisposition: { kind: "no-envelope" },
      });
      expect(result).not.toContain("posted inline");
      expect(result).not.toContain("suppressed");
      expect(result).not.toContain("No inline comments");
    });
  });

  describe("strays section (only per-finding detail in the sticky)", () => {
    it("lists strays with severity, path, line, and title plus a not-in-the-diff note", () => {
      const findings = mkFindings([mkFinding({ severity: "major", title: "in-diff-ish" })]);
      const strays = [
        mkFinding({ path: "src/bar.ts", start_line: 100, severity: "major", title: "Stray one" }),
      ];
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        strays,
        inlineDisposition: { kind: "posted", count: 1, sha: "abc123def456" },
      });
      expect(result).toContain("Findings outside the diff");
      expect(result).toContain("not in the diff");
      expect(result).toContain("src/bar.ts:100");
      expect(result).toContain("Stray one");
    });

    it("renders no strays section when there are none", () => {
      const findings = mkFindings([mkFinding({ severity: "minor" })]);
      const result = render({ findings, envelope: baseEnvelope, prices, template });
      expect(result).not.toContain("Findings outside the diff");
    });

    it("renders a multi-line stray range", () => {
      const findings = mkFindings([]);
      const strays = [
        mkFinding({ path: "src/x.ts", start_line: 10, end_line: 14, title: "range stray" }),
      ];
      const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
      expect(result).toContain("src/x.ts:10–14");
    });
  });

  describe("stray confidence and reasoning fold (issue #16; both required in 0.4)", () => {
    it("shows confidence on the bullet line, outside the fold", () => {
      const findings = mkFindings([]);
      const strays = [mkFinding({ title: "Stray conf", confidence: 0.82 })];
      const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
      const bulletLine = result.split("\n").find((line) => line.includes("Stray conf"));
      expect(bulletLine).toContain("confidence 0.82");
    });

    it("shows a zero confidence (falsy but valid) on the bullet line, at 2 decimal places (issue #26)", () => {
      const findings = mkFindings([]);
      const strays = [mkFinding({ title: "Stray zero conf", confidence: 0 })];
      const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
      const bulletLine = result.split("\n").find((line) => line.includes("Stray zero conf"));
      expect(bulletLine).toContain("confidence 0.00");
    });

    it("renders a collapsible reasoning fold under the bullet (reasoning is always present)", () => {
      const findings = mkFindings([]);
      const strays = [mkFinding({ title: "Stray reason", reasoning: "Because X causes Y." })];
      const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
      expect(result).toContain("<details><summary>Reasoning</summary>");
      expect(result).toContain("Because X causes Y.");
      expect(result).toContain("</details>");
    });

    it("keeps confidence out of the fold and reasoning out of the bullet line", () => {
      const findings = mkFindings([]);
      const strays = [
        mkFinding({ title: "Stray both", confidence: 0.4, reasoning: "Some justification." }),
      ];
      const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
      const bulletLine = result.split("\n").find((line) => line.includes("Stray both"));
      expect(bulletLine).toContain("confidence 0.40");
      expect(bulletLine).not.toContain("Some justification");
      expect(result).toContain("Some justification.");
    });

    it("orders the reasoning fold AFTER the recommended fix for a stray (issue #42)", () => {
      const findings = mkFindings([]);
      const strays = [
        mkFinding({
          title: "Stray order",
          recommendation: "Guard the input.",
          reasoning: "Because X causes Y.",
        }),
      ];
      const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
      const rec = result.indexOf("**Recommended fix:**");
      const reasoning = result.indexOf("<details><summary>Reasoning</summary>");
      // Guard against a vacuous pass: both must actually render before comparing positions.
      expect(rec).toBeGreaterThanOrEqual(0);
      expect(reasoning).toBeGreaterThanOrEqual(0);
      expect(rec).toBeLessThan(reasoning);
    });

    it("orders a stray's suggestion block between the recommended fix and the reasoning fold (issue #42)", () => {
      const findings = mkFindings([]);
      const strays = [
        mkFinding({
          title: "Stray patch order",
          recommendation: "Apply the patch.",
          patch: ["@@ -2 +2 @@", "-old", "+fixed line"].join("\n"),
          reasoning: "Because X causes Y.",
        }),
      ];
      const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
      const rec = result.indexOf("**Recommended fix:**");
      const fence = result.indexOf("```suggestion");
      const reasoning = result.indexOf("<details><summary>Reasoning</summary>");
      expect(rec).toBeGreaterThanOrEqual(0);
      expect(fence).toBeGreaterThanOrEqual(0);
      expect(reasoning).toBeGreaterThanOrEqual(0);
      expect(rec).toBeLessThan(fence);
      expect(fence).toBeLessThan(reasoning);
    });

    it("renders a **Recommended fix:** line only when the stray carries a recommendation", () => {
      const findings = mkFindings([]);
      const withRec = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        strays: [mkFinding({ title: "Stray rec", recommendation: "Guard the input." })],
      });
      expect(withRec).toContain("**Recommended fix:** Guard the input.");

      const withoutRec = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        strays: [mkFinding({ title: "Stray no rec" })],
      });
      expect(withoutRec).not.toContain("Recommended fix:");
    });

    it("projects a stray's patch into a ```suggestion block", () => {
      const findings = mkFindings([]);
      const strays = [
        mkFinding({
          title: "Stray patch",
          patch: ["@@ -2 +2 @@", "-old", "+fixed line"].join("\n"),
        }),
      ];
      const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
      expect(result).toContain("```suggestion");
      expect(result).toContain("fixed line");
    });

    it("indents every line of a multi-paragraph reasoning so continuation lines stay in the fold", () => {
      const findings = mkFindings([]);
      const strays = [
        mkFinding({
          title: "Stray multi",
          reasoning: "First paragraph of reasoning.\n\nSecond paragraph.\nWrapped continuation.",
        }),
      ];
      const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
      const lines = result.split("\n");
      const openIndex = lines.findIndex((l) => l.includes("<details><summary>Reasoning</summary>"));
      const closeIndex = lines.findIndex((l, i) => i > openIndex && l.trim() === "</details>");
      expect(openIndex).toBeGreaterThanOrEqual(0);
      expect(closeIndex).toBeGreaterThan(openIndex);
      // A continuation line at column 0 (the bug) would fall out of the list-item fold; every
      // non-empty content line must carry the 2-space list indent.
      const contentLines = lines
        .slice(openIndex + 1, closeIndex)
        .filter((l) => l.trim().length > 0);
      expect(contentLines.some((l) => l === "  Second paragraph.")).toBe(true);
      expect(contentLines.every((l) => l.startsWith("  "))).toBe(true);
    });
  });

  describe("zero findings", () => {
    it("shows 'No findings — clean review'", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("No findings — clean review");
    });
  });

  describe("verdict badges", () => {
    it('renders "approved" badge for approve verdict', () => {
      const findings = mkFindings([], { verdict: "approve" });
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("approved");
    });

    it('renders "comment" badge for comment verdict', () => {
      const findings = mkFindings([], { verdict: "comment" });
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("comment");
    });

    it('renders "changes requested" badge for changes verdict', () => {
      const findings = mkFindings([], { verdict: "changes" });
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("changes requested");
    });
  });

  describe("cost footer", () => {
    it("renders model name in the cost table", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("pro-model");
    });

    it("renders a Cache write column header", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("Cache write");
    });

    it("renders cache_write token counts in the table", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("1,000");
    });

    it("renders token counts with formatting", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("10,000");
      expect(result).toContain("2,000");
    });

    it("renders turn count and duration in the route line", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("turns:");
      expect(result).toContain("30s");
    });

    it("formats minutes+seconds for durations >= 60s", () => {
      const envelope: ResultEnvelope = {
        ...baseEnvelope,
        duration_ms: 125000,
      };
      const findings = mkFindings([]);
      const result = render({ findings, envelope, prices, template, route: "full review" });
      expect(result).toContain("2m 5s");
    });

    it("formats cost to two decimal places", () => {
      // pro-model @ 10,000 in / 2,000 out / 5,000 cache-read / 1,000 cache-write against `prices`
      // costs 0.0621 USD — a single-model run so the Total row shows the same figure.
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("$0.06");
      expect(result).not.toContain("$0.0621");
      expect(result).not.toContain("$0.062");
    });

    it("renders <$0.01 for a nonzero cost that rounds to $0.00 at two decimals", () => {
      const envelope: ResultEnvelope = {
        ...baseEnvelope,
        models: [
          mkEntry({
            input_tokens: 1,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          }),
        ],
      };
      const findings = mkFindings([]);
      const result = render({ findings, envelope, prices, template, route: "full review" });
      // The cost cell renders through Eta's escaping `<%=` tag (template is out of this task's
      // scope), so the literal "<" formatCost returns comes through HTML-entity-escaped; GitHub
      // still displays the escaped form as "<$0.01".
      expect(result).toContain("&lt;$0.01");
      expect(result).not.toContain("$0.00");
    });
  });

  describe("meta line — models and total cost (issue #6)", () => {
    it("appends models and cost to the meta line when usage is available", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("**models:** pro-model");
      expect(result).toContain("**cost:** $0.06");
    });

    it("omits models and cost from the meta line when usage is unavailable", () => {
      const findings = mkFindings([]);
      const result = render({ findings, envelope: null, prices, template, route: "full review" });
      expect(result).not.toContain("**models:**");
      expect(result).not.toContain("**cost:**");
    });
  });

  describe("absent price map → N/A cost + footnote (SPEC §6.2)", () => {
    it("renders every cost cell as N/A (never $0.00) when pricesProvided is false", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        pricesProvided: false,
        template,
        route: "full review",
      });
      expect(result).toContain("**cost:** N/A");
      expect(result).not.toContain("$0.00");
      expect(result).not.toContain("$0.06");
      // The per-model and Total Cost cells are N/A too.
      expect(result).toContain("| N/A |");
    });

    it("still renders the real token counts — those need no price map", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        pricesProvided: false,
        template,
        route: "full review",
      });
      expect(result).toContain("10,000");
      expect(result).toContain("2,000");
    });

    it("emits a footnote hyperlinking SPEC §6.2 when pricesProvided is false", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        pricesProvided: false,
        template,
        route: "full review",
      });
      expect(result).toContain(
        "[No `.github/prices.json`](https://github.com/JPHutchins/code-review/blob/main/schema/prices.example.json)",
      );
    });

    it("keeps the footnote inside the disclosure blockquote so the [!WARNING] alert stays contiguous", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        pricesProvided: false,
        template,
        route: "full review",
      });
      const footnoteLine = result.split("\n").find((l) => l.includes("No `.github/prices.json`"));
      expect(footnoteLine).toBeDefined();
      expect(footnoteLine!.startsWith(">")).toBe(true);
    });

    it("renders real $ costs and NO footnote when pricesProvided is true (or omitted)", () => {
      const findings = mkFindings([]);
      const provided = render({
        findings,
        envelope: baseEnvelope,
        prices,
        pricesProvided: true,
        template,
        route: "full review",
      });
      expect(provided).toContain("**cost:** $0.06");
      expect(provided).not.toContain("N/A");
      expect(provided).not.toContain("No `.github/prices.json`");

      const omitted = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(omitted).not.toContain("No `.github/prices.json`");
      expect(omitted).toContain("**cost:** $0.06");
    });
  });

  describe("LLM disclosure aside (issue #8 — [!WARNING], repo link, in-blockquote table)", () => {
    it("renders a [!WARNING] alert, not the old [!NOTE]", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("> [!WARNING]");
      expect(result).not.toContain("[!NOTE]");
    });

    it("links to the code-review repository", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("[code-review](https://github.com/JPHutchins/code-review)");
    });

    it("no longer renders the cost table in a standalone <sub> block", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).not.toContain("<sub>");
      expect(result).not.toContain("</sub>");
    });

    it("links to the workflow run when runUrl is set", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        runUrl: "https://example.com/actions/runs/1",
      });
      expect(result).toContain("[view the run & traces](https://example.com/actions/runs/1)");
    });

    it("omits the run link when runUrl is not set", () => {
      const findings = mkFindings([]);
      const result = render({ findings, envelope: baseEnvelope, prices, template });
      expect(result).not.toContain("view the run & traces");
    });

    it("renders a sensible disclosure without a table when the envelope is unavailable", () => {
      const findings = mkFindings([]);
      const result = render({ findings, envelope: null, prices, template });
      expect(result).toContain("[!WARNING]");
      expect(result).toContain("Usage/cost unavailable");
      expect(result).not.toContain("| Model |");
    });
  });

  describe("LLM disclosure wording is a single line (PR #17 review)", () => {
    it("renders the simplified one-line disclosure and drops the verbose sentence", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("> **LLM Disclosure** — this review was produced by pro-model.");
      expect(result).not.toContain("running");
      expect(result).not.toContain("egress-locked");
      expect(result).not.toContain("does not block merge");
    });

    it("still links the repo and the run, and keeps the cost table contiguous", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        runUrl: "https://example.com/actions/runs/1",
      });
      expect(result).toContain("[code-review](https://github.com/JPHutchins/code-review)");
      expect(result).toContain("[view the run & traces](https://example.com/actions/runs/1)");

      const block = contiguousBlockFrom(
        result,
        (line) => line.startsWith("> [!WARNING]"),
        (line) => line.startsWith(">"),
      );
      expect(block.length).toBeGreaterThan(0);
      expect(block.every((line) => line.startsWith(">"))).toBe(true);
      expect(block.at(-1)).toMatch(/^> _Generated by/);
    });
  });

  describe("LLM disclosure names the models from models[]", () => {
    it("names a single model from the envelope's models array", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("LLM Disclosure");
      expect(result).toContain("pro-model");
    });

    it("names multiple models from the envelope's models array", () => {
      const envelope: ResultEnvelope = {
        ...baseEnvelope,
        models: [
          mkEntry({ model: "deepseek-v4-pro", input_tokens: 1, output_tokens: 1 }),
          mkEntry({ model: "deepseek-v4-flash", input_tokens: 1, output_tokens: 1 }),
        ],
      };
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).toContain("deepseek-v4-pro, deepseek-v4-flash");
    });
  });

  describe("test report panel (format-agnostic — REQ-CO-9)", () => {
    it("omits the test results panel when no testReport is provided", () => {
      const findings = mkFindings([]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });
      expect(result).not.toContain("Test results");
      expect(result).not.toContain("no CTRF data");
      expect(result).not.toContain("no test report");
    });

    it("renders a test results panel when a TestSummary is provided", () => {
      const findings = mkFindings([]);
      const testReport: TestSummary = { passed: 12, failed: 2, total: 14 };
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
        testReport,
      });
      expect(result).toContain("Test results");
      expect(result).toContain("12 passed");
      expect(result).toContain("2 failed");
    });

    it("lists failing tests when failures are provided", () => {
      const findings = mkFindings([]);
      const testReport: TestSummary = {
        passed: 1,
        failed: 1,
        total: 2,
        failures: [{ name: "test_foo", message: "expected 1 got 2" }],
      };
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
        testReport,
      });
      expect(result).toContain("test_foo");
      expect(result).toContain("expected 1 got 2");
    });

    it("renders a pass summary when all tests pass", () => {
      const findings = mkFindings([]);
      const testReport: TestSummary = { passed: 5, failed: 0, total: 5 };
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
        testReport,
      });
      expect(result).toContain("All 5 tests passed");
    });
  });

  describe("empty models array", () => {
    it("renders successfully with no models entries", () => {
      const envelope: ResultEnvelope = {
        ...baseEnvelope,
        models: [],
        vendor_cost_usd: null,
      };
      const findings = mkFindings([]);
      const result = render({ findings, envelope, prices, template, route: "full review" });
      expect(result).toContain("<!-- code-review -->");
      // No per-model table at all — its empty body otherwise leaves a blank line that splits the
      // markdown table (the malformed-comment bug on skipped/error envelopes).
      expect(result).toContain("No per-model usage was recorded");
      expect(result).not.toContain("| Model | Input |");
      expect(result).not.toMatch(/\|---\|--:.*\n\s*\n\s*\| \*\*Total\*\*/);
    });
  });

  it("includes the findings summary text", () => {
    const f = mkFindings([], { summary: "Custom summary walkthrough." });
    const result = render({
      findings: f,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
    expect(result).toContain("Custom summary walkthrough.");
  });

  it("shows the route line without an effort segment when effort is omitted", () => {
    const findings = mkFindings([]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
    expect(result).toContain("Route:");
    expect(result).not.toContain("effort:");
  });

  it("renders the passed effort in the route line", () => {
    const findings = mkFindings([]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "mechanic",
      effort: "low",
    });
    expect(result).toContain("Route:");
    expect(result).toContain("**effort:** low");
  });

  it("shows LLM disclosure note", () => {
    const findings = mkFindings([]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
    expect(result).toContain("LLM Disclosure");
  });
});

describe("stray sanitization", () => {
  it("escapes pipe characters in stray titles for table safety", () => {
    const findings = mkFindings([]);
    const strays = [mkFinding({ severity: "major", title: "Title | with | pipes" })];
    const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
    expect(result).toContain("Title \\| with \\| pipes");
    expect(result).not.toContain("Title | with | pipes");
  });

  it("replaces backticks in stray file paths for inline code span safety", () => {
    const findings = mkFindings([]);
    const strays = [mkFinding({ path: "src/bad`path`.ts", title: "backtick path" })];
    const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
    expect(result).toContain("src/bad-path-.ts");
    expect(result).not.toContain("bad`path`");
  });
});

describe("number formatting guards", () => {
  it("formats NaN token counts as em-dash", () => {
    const envelope: ResultEnvelope = {
      ...baseEnvelope,
      models: [mkEntry({ model: "pro-model", input_tokens: NaN, output_tokens: NaN })],
    };
    const findings = mkFindings([]);
    const result = render({ findings, envelope, prices, template, route: "full review" });
    expect(result).toContain("—");
    expect(result).not.toContain("NaN");
  });

  it("formats Infinity token counts as em-dash", () => {
    const envelope: ResultEnvelope = {
      ...baseEnvelope,
      models: [mkEntry({ model: "pro-model", input_tokens: Infinity, output_tokens: Infinity })],
    };
    const findings = mkFindings([]);
    const result = render({ findings, envelope, prices, template, route: "full review" });
    expect(result).toContain("—");
    expect(result).not.toContain("∞");
  });

  it("handles negative token counts gracefully", () => {
    const envelope: ResultEnvelope = {
      ...baseEnvelope,
      models: [mkEntry({ model: "pro-model", input_tokens: -1000, output_tokens: -500 })],
    };
    const findings = mkFindings([]);
    const result = render({ findings, envelope, prices, template, route: "full review" });
    expect(result).toContain("—");
    expect(result).not.toContain("-1,000");
  });
});

describe("severity emoji", () => {
  it("uses a question mark for an unknown severity surfaced in the strays section", () => {
    const findings = mkFindings([]);
    const strays = [{ ...mkFinding({ severity: "critical" }), severity: "bogus" as "critical" }];
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
      strays,
    });
    expect(result).toContain("❓");
  });

  it("does not count an out-of-domain severity in the histogram", () => {
    const findings = mkFindings([
      { ...mkFinding({ severity: "critical" }), severity: "bogus" as "critical" },
    ]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
    expect(result).toContain("No findings — clean review");
  });
});

describe("usage unavailable (envelope missing — SPEC §5.5)", () => {
  it("renders a usage-unavailable note instead of the cost footer when envelope is null", () => {
    const findings = mkFindings([]);
    const result = render({ findings, envelope: null, prices, template, route: "full review" });
    expect(result).toContain("Usage/cost unavailable");
    expect(result).not.toContain("| Model | Input");
  });

  it("shows 'usage unavailable' in the route line instead of turns/wall", () => {
    const findings = mkFindings([]);
    const result = render({ findings, envelope: null, prices, template, route: "full review" });
    expect(result).toContain("usage unavailable");
    expect(result).not.toContain("turns:");
  });

  it("still renders the severity counts and summary when envelope is null", () => {
    const findings = mkFindings([mkFinding({ title: "Still counted", severity: "major" })], {
      summary: "Real summary text.",
    });
    const result = render({ findings, envelope: null, prices, template, route: "full review" });
    expect(result).toContain("🟠 1");
    expect(result).toContain("Real summary text.");
  });

  it("falls back to 'unknown model' in the LLM disclosure when envelope is null", () => {
    const findings = mkFindings([]);
    const result = render({ findings, envelope: null, prices, template, route: "full review" });
    expect(result).toContain("unknown model");
  });
});

describe("render — route/effort from the envelope (SSOT)", () => {
  const envWithMeta: ResultEnvelope = { ...baseEnvelope, route: "mechanic", effort: "low" };

  it("renders the envelope's route and effort when no override is passed", () => {
    const result = render({ findings: mkFindings([]), envelope: envWithMeta, prices, template });
    expect(result).toContain("**Route:** mechanic");
    expect(result).toContain("**effort:** low");
  });

  it("lets an explicit route/effort override the envelope's", () => {
    const result = render({
      findings: mkFindings([]),
      envelope: envWithMeta,
      prices,
      template,
      route: "full review",
      effort: "max",
    });
    expect(result).toContain("**Route:** full review");
    expect(result).toContain("**effort:** max");
    expect(result).not.toContain("mechanic");
  });

  it("omits the Route label when neither an override nor the envelope carries one", () => {
    const result = render({ findings: mkFindings([]), envelope: baseEnvelope, prices, template });
    expect(result).not.toContain("**Route:**");
  });
});

describe("cost-table structural integrity (regression guard for the blank-line-per-row bug)", () => {
  const pricesMulti: PriceMap = {
    _updated: "2026-07-03",
    _unit: "USD per 1M tokens",
    models: {
      "model-a": { in: 3.0, out: 15.0, cache_read: 0.3, cache_write: 0.6 },
      "model-b": { in: 1.0, out: 5.0, cache_read: 0.1, cache_write: 0.2 },
      "model-c": { in: 0.5, out: 2.5, cache_read: 0.05, cache_write: 0.1 },
    },
  };

  const multiModelEnvelope: ResultEnvelope = {
    ...baseEnvelope,
    models: [
      mkEntry({ model: "model-a" }),
      mkEntry({ model: "model-b", input_tokens: 20000, output_tokens: 3000 }),
      mkEntry({ model: "model-c", input_tokens: 5000, output_tokens: 500 }),
    ],
  };

  const renderCostTable = (): string =>
    render({
      findings: mkFindings([]),
      envelope: multiModelEnvelope,
      prices: pricesMulti,
      template,
    });

  const costTableBlock = (markdown: string): string[] =>
    contiguousBlockFrom(
      markdown,
      (line) => line.startsWith("> | Model |"),
      (line) => line.startsWith("> |"),
    );

  it("keeps the separator immediately after the header, with no blank line between", () => {
    const block = costTableBlock(renderCostTable());
    expect(block[0]).toMatch(/^> \| Model \|/);
    expect(block[1]).toMatch(/^> \|---\|/);
  });

  it("renders the header, separator, every model row, and the Total row as one contiguous run", () => {
    // Regression: under Eta({autoTrim:false}), a `<% forEach %>` on its own line emitted a blank
    // line before every row, so GitHub saw header+separator, then a blank line, and stopped
    // parsing the table right there — every row rendered as loose text instead. A contiguous
    // `|`-line run from the header through Total is exactly the shape that bug could never produce:
    // the first blank line truncates `contiguousBlockFrom`'s result short of the full row count.
    const block = costTableBlock(renderCostTable());
    // header + separator + 3 model rows + Total row
    expect(block).toHaveLength(1 + 1 + 3 + 1);
    expect(block.every((line) => line.trim().length > 0)).toBe(true);
    expect(block.at(-1)).toMatch(/^> \| \*\*Total\*\*/);
  });

  it("gives every row — header, separator, each model, and Total — the same column count, including the blockquote prefix", () => {
    const block = costTableBlock(renderCostTable());
    const counts = block.map(columnCount);
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(6);
    expect(block.every((line) => line.startsWith("> "))).toBe(true);
  });

  it("keeps the entire disclosure — warning, prose, table, and footer line — as one contiguous blockquote", () => {
    const markdown = renderCostTable();
    const block = contiguousBlockFrom(
      markdown,
      (line) => line.startsWith("> [!WARNING]"),
      (line) => line.startsWith(">"),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block.every((line) => line.startsWith(">"))).toBe(true);
    expect(block.at(-1)).toMatch(/^> _Generated by/);
  });
});

describe("summary-only sticky (regression guard against re-adding per-finding tables)", () => {
  it("renders no per-finding findings table or nits table header, even with mixed severities present", () => {
    const uniqueBody = "UNIQUE_DESCRIPTION_MARKER_must_not_leak_into_the_sticky_9f3d";
    const findings = mkFindings([
      mkFinding({ severity: "critical", title: "Crit finding", description: uniqueBody }),
      mkFinding({ severity: "major", title: "Major finding", description: uniqueBody }),
      mkFinding({ severity: "minor", title: "Minor finding", description: uniqueBody }),
      mkFinding({ severity: "nit", title: "Nit finding", description: uniqueBody }),
    ]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });

    expect(result).not.toContain("| Severity | File | Line | Summary |");
    expect(result).not.toContain("| File | Line | Summary |");
    // Per-finding description text belongs to the inline review now, not the sticky.
    expect(result).not.toContain(uniqueBody);
  });
});

describe("strays list structural integrity", () => {
  it("renders every stray's bullet and its reasoning fold, with no Eta blank-line-per-row artifact (issue #42 layout: reasoning last)", () => {
    const findings = mkFindings([]);
    const strays = [
      mkFinding({
        path: "src/a.ts",
        start_line: 1,
        severity: "critical",
        title: "Stray A",
        recommendation: "Fix A.",
      }),
      mkFinding({ path: "src/b.ts", start_line: 2, severity: "major", title: "Stray B" }),
      mkFinding({
        path: "src/c.ts",
        start_line: 3,
        severity: "minor",
        title: "Stray C",
        recommendation: "Fix C.",
      }),
    ];
    const result = render({ findings, envelope: baseEnvelope, prices, template, strays });
    const headingIdx = result.indexOf("Findings outside the diff");
    expect(headingIdx).toBeGreaterThanOrEqual(0); // fail clearly here, not via a garbage slice below
    const section = result.slice(headingIdx);

    // Every stray renders exactly one bullet and one reasoning fold — none collapsed or duplicated.
    // Anchor the bullet match on the backtick-wrapped path so a dash in prose can't inflate the count.
    expect(section.match(/^- .+ `[^`]+`/gm) ?? []).toHaveLength(3);
    expect(section.match(/<details><summary>Reasoning<\/summary>/g) ?? []).toHaveLength(3);
    // Within the list itself (first bullet → last fold), the Eta forEach must not leak a RUN of
    // blank lines (the per-row bug signature); inter-section spacing after the list is not in scope.
    const listStart = section.indexOf("\n- ");
    const listEnd = section.lastIndexOf("</details>");
    expect(listStart).toBeGreaterThanOrEqual(0);
    expect(listEnd).toBeGreaterThan(listStart);
    const list = section.slice(listStart, listEnd);
    expect(list).not.toMatch(/\n[ \t]*\n[ \t]*\n/);
  });
});
