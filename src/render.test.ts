import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "./render.js";
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
  schema_version: "0.2.0",
  findings: {
    schema_version: "0.2.0",
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
  body: "Test body content.",
  ...overrides,
});

const mkFindings = (
  findings: Finding[],
  overrides?: Partial<Omit<Findings, "findings">>,
): Findings => ({
  schema_version: "0.2.0",
  summary: "A test summary.",
  verdict: "comment",
  findings,
  ...overrides,
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

  describe("findings summary table", () => {
    it("renders a critical finding visibly, not folded in <details>", () => {
      const findings = mkFindings([
        mkFinding({ severity: "critical", title: "CRIT-1", start_line: 10 }),
      ]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });

      expect(result).toContain("Findings summary");
      expect(result).not.toContain("<details>");
      expect(result).toContain("CRIT-1");
      expect(result).toContain("🔴");
    });

    it("renders all severity levels in the table", () => {
      const findings = mkFindings([
        mkFinding({ severity: "critical", title: "CRIT" }),
        mkFinding({ severity: "major", title: "MAJ" }),
        mkFinding({ severity: "minor", title: "MIN" }),
        mkFinding({ severity: "nit", title: "NIT" }),
      ]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });

      expect(result).toContain("🔴");
      expect(result).toContain("🟠");
      expect(result).toContain("🔵");
      expect(result).toContain("⚪");
      expect(result).toContain("CRIT");
      expect(result).toContain("MAJ");
      expect(result).toContain("MIN");
      expect(result).toContain("NIT");
    });

    it("shows file count and finding count in summary", () => {
      const findings = mkFindings([
        mkFinding({ path: "src/a.ts", title: "A" }),
        mkFinding({ path: "src/b.ts", title: "B" }),
      ]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });

      expect(result).toContain("2 findings");
      expect(result).toContain("2 files");
    });

    it("shows line range for multi-line findings", () => {
      const findings = mkFindings([
        mkFinding({ start_line: 10, end_line: 42, title: "Range finding" }),
      ]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });

      expect(result).toContain("10–42");
    });

    it("mentions suggestion count when findings have suggestions", () => {
      const findings = mkFindings([
        mkFinding({ suggestion: "fix this", title: "Has suggestion" }),
        mkFinding({ title: "No suggestion" }),
      ]);
      const result = render({
        findings,
        envelope: baseEnvelope,
        prices,
        template,
        route: "full review",
      });

      expect(result).toContain("1 finding included suggestions");
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
      expect(result).toContain("Total");
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

  it("escapes triple backticks in suggestions for safe rendering", () => {
    const findings = mkFindings([
      mkFinding({
        severity: "major",
        title: "Escaped",
        body: "Has backticks.",
        suggestion: "code with ``` backticks",
      }),
    ]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
    expect(result).not.toContain("``` backticks```");
    expect(result).toContain("Escaped");
  });
});

describe("sanitization", () => {
  it("escapes pipe characters in finding titles for table safety", () => {
    const findings = mkFindings([mkFinding({ severity: "major", title: "Title | with | pipes" })]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
    expect(result).toContain("Title \\| with \\| pipes");
    expect(result).not.toContain("Title | with | pipes");
  });

  it("replaces backticks in file paths for inline code span safety", () => {
    const findings = mkFindings([mkFinding({ path: "src/bad`path`.ts", title: "backtick path" })]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
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
  it("uses question mark for unknown severity values", () => {
    const f = mkFindings([
      { ...mkFinding({ severity: "critical" }), severity: "bogus" as "critical" },
    ]);
    const result = render({
      findings: f,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
    expect(result).toContain("❓");
  });
});

describe("severity grouping (REC-CO-1)", () => {
  it("folds nits, and only nits, into a <details> block", () => {
    const findings = mkFindings([
      mkFinding({ severity: "critical", title: "CRIT" }),
      mkFinding({ severity: "major", title: "MAJ" }),
      mkFinding({ severity: "minor", title: "MIN" }),
      mkFinding({ severity: "nit", title: "NIT" }),
    ]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });

    expect(result).toContain("<details>");
    expect(result).toContain("nit");

    const detailsStart = result.indexOf("<details>");
    const detailsEnd = result.indexOf("</details>");
    const foldedSection = result.slice(detailsStart, detailsEnd);

    expect(foldedSection).toContain("NIT");
    expect(foldedSection).not.toContain("CRIT");
    expect(foldedSection).not.toContain("MAJ");
    expect(foldedSection).not.toContain("MIN");

    const visibleSection = result.slice(0, detailsStart);
    expect(visibleSection).toContain("CRIT");
    expect(visibleSection).toContain("MAJ");
    expect(visibleSection).toContain("MIN");
    expect(visibleSection).not.toContain("NIT");
  });

  it("omits the <details> fold when there are no nits", () => {
    const findings = mkFindings([mkFinding({ severity: "major", title: "MAJ-ONLY" })]);
    const result = render({
      findings,
      envelope: baseEnvelope,
      prices,
      template,
      route: "full review",
    });
    expect(result).not.toContain("<details>");
    expect(result).toContain("MAJ-ONLY");
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

  it("still renders findings and summary when envelope is null", () => {
    const findings = mkFindings([mkFinding({ title: "Still shown", severity: "major" })], {
      summary: "Real summary text.",
    });
    const result = render({ findings, envelope: null, prices, template, route: "full review" });
    expect(result).toContain("Still shown");
    expect(result).toContain("Real summary text.");
  });

  it("falls back to 'unknown model' in the LLM disclosure when envelope is null", () => {
    const findings = mkFindings([]);
    const result = render({ findings, envelope: null, prices, template, route: "full review" });
    expect(result).toContain("unknown model");
  });
});
