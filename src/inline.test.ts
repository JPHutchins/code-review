import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInlineComments, renderStraysSection } from "./inline.js";
import type { Finding, Findings } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The real bundled template — exercises the actual shipped rendering, not a hand-rolled
// duplicate that drifts (same rationale as post.test.ts's use of the bundled comment.eta).
const bundledInlineTemplate = readFileSync(
  resolve(__dirname, "..", "templates", "inline.eta"),
  "utf-8",
);

const mkFinding = (overrides: Partial<Finding>): Finding => ({
  path: "src/foo.ts",
  start_line: 10,
  end_line: 10,
  severity: "minor",
  title: "Test finding",
  description: "Test description content.",
  reasoning: "Test reasoning content.",
  confidence: 0.7,
  ...overrides,
});

/** A full findings document wrapping the given findings — needed to exercise the findings-json
 *  marker (issue #19), which embeds the whole document, not a single finding. */
const mkFindingsDoc = (findings: readonly Finding[]): Findings => ({
  schema_version: "0.4.0",
  summary: "A test summary.",
  verdict: "comment",
  findings: [...findings],
});

/** A single-hunk patch that lowers to the given replacement text over one removed line. */
const replacePatch = (added: string): string => ["@@ -2 +2 @@", "-old", `+${added}`].join("\n");

const inlineDiff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -8,3 +8,5 @@
 line8
 line9
 line10
+added11
+added12
@@ -20,2 +22,5 @@
 line20
 line21
+added22
+added23
+added24
`;

describe("buildInlineComments", () => {
  it("includes in-diff findings as comments", () => {
    const findings: Finding[] = [
      mkFinding({ path: "src/foo.ts", start_line: 10, end_line: 10, title: "on-line10" }),
    ];
    const { comments, strays } = buildInlineComments(findings, inlineDiff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.path).toBe("src/foo.ts");
    expect(comments[0]!.line).toBe(10);
    expect(comments[0]!.side).toBe("RIGHT");
    expect(strays).toHaveLength(0);
  });

  it("demotes findings on lines not in the diff to strays", () => {
    const findings: Finding[] = [
      mkFinding({ path: "src/foo.ts", start_line: 999, end_line: 999, title: "stray" }),
    ];
    const { comments, strays } = buildInlineComments(findings, inlineDiff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments).toHaveLength(0);
    expect(strays).toHaveLength(1);
    expect(strays[0]!.title).toBe("stray");
  });

  it("sets start_line and start_side for multi-line findings", () => {
    const findings: Finding[] = [
      mkFinding({ path: "src/foo.ts", start_line: 22, end_line: 24, title: "multi-line" }),
    ];
    const { comments } = buildInlineComments(findings, inlineDiff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.line).toBe(24); // end_line
    expect(comments[0]!.start_line).toBe(22); // start_line
    expect(comments[0]!.start_side).toBe("RIGHT");
  });

  it("does not set start_line for single-line findings", () => {
    const findings: Finding[] = [
      mkFinding({ path: "src/foo.ts", start_line: 10, end_line: 10, title: "single-line" }),
    ];
    const { comments } = buildInlineComments(findings, inlineDiff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.start_line).toBeUndefined();
    expect(comments[0]!.start_side).toBeUndefined();
  });

  it("respects explicit LEFT side", () => {
    const findings: Finding[] = [
      mkFinding({ path: "src/foo.ts", start_line: 10, end_line: 10, side: "LEFT" }),
    ];
    const { comments } = buildInlineComments(findings, inlineDiff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments[0]!.side).toBe("LEFT");
  });

  it("defaults side to RIGHT when not specified", () => {
    const findings: Finding[] = [
      mkFinding({ path: "src/foo.ts", start_line: 10, end_line: 10, side: undefined }),
    ];
    const { comments } = buildInlineComments(findings, inlineDiff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments[0]!.side).toBe("RIGHT");
  });

  it("correctly partitions mixed in-diff and stray findings", () => {
    const findings: Finding[] = [
      mkFinding({ start_line: 10, title: "in-diff" }),
      mkFinding({ start_line: 22, title: "also-in-diff" }),
      mkFinding({ start_line: 50, title: "stray-50" }),
    ];
    const { comments, strays } = buildInlineComments(findings, inlineDiff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments).toHaveLength(2);
    expect(strays).toHaveLength(1);
    expect(strays[0]!.title).toBe("stray-50");
  });
});

describe("renderStraysSection", () => {
  it("returns empty string for zero strays", () => {
    expect(renderStraysSection([])).toBe("");
  });

  it("renders a single stray finding", () => {
    const strays: Finding[] = [
      mkFinding({ path: "src/bar.ts", start_line: 100, severity: "major", title: "Off-by-one." }),
    ];
    const result = renderStraysSection(strays);
    expect(result).toContain("Findings on lines not in the diff");
    expect(result).toContain("src/bar.ts:100");
    expect(result).toContain("major");
    expect(result).toContain("Off-by-one.");
  });

  it("renders multiple stray findings", () => {
    const strays: Finding[] = [
      mkFinding({
        path: "src/a.ts",
        start_line: 1,
        severity: "critical",
        title: "Critical stray.",
      }),
      mkFinding({ path: "src/b.ts", start_line: 2, severity: "minor", title: "Minor stray." }),
      mkFinding({ path: "src/c.ts", start_line: 3, severity: "nit", title: "Nit stray." }),
    ];
    const result = renderStraysSection(strays);
    expect(result).toContain("Critical stray.");
    expect(result).toContain("Minor stray.");
    expect(result).toContain("Nit stray.");
    const itemCount = (result.match(/- \*\*/g) ?? []).length;
    expect(itemCount).toBe(3);
  });

  it("includes the severity in bold for each stray", () => {
    const strays: Finding[] = [
      mkFinding({
        path: "src/z.ts",
        start_line: 7,
        severity: "nit",
        title: "Trailing whitespace.",
      }),
    ];
    expect(renderStraysSection(strays)).toContain("**nit**");
  });
});

describe("buildInlineComments with a custom template (override still works)", () => {
  const inlineTemplate = `<%~ it.description %>

<sub>🤖 AI-generated — advisory only</sub>`;

  const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;

  it("renders comment bodies using the custom template's fields", () => {
    const findings: Finding[] = [
      mkFinding({ start_line: 2, end_line: 2, description: "Custom description text." }),
    ];
    const { comments, strays } = buildInlineComments(findings, diff, { inlineTemplate });
    expect(comments).toHaveLength(1);
    expect(strays).toHaveLength(0);
    expect(comments[0]!.body).toContain("Custom description text.");
    expect(comments[0]!.body).toContain("AI-generated — advisory only");
  });
});

describe("buildInlineComments with the bundled inline template (issues #12, #15, #16, #22, schema 0.4)", () => {
  const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;

  const findingAt = (overrides: Partial<Finding>): Finding[] => [
    mkFinding({ path: "src/foo.ts", start_line: 2, end_line: 2, ...overrides }),
  ];

  const bodyOf = (overrides: Partial<Finding>): string =>
    buildInlineComments(findingAt(overrides), diff, { inlineTemplate: bundledInlineTemplate })
      .comments[0]!.body;

  it("renders a single header line — emoji, severity label, bold title, confidence (issues #27, a11y)", () => {
    const body = bodyOf({ severity: "critical", title: "SQLi", confidence: 0.5 });
    expect(body.startsWith("🔴 Critical: **SQLi** · 0.50 confidence\n")).toBe(true);
  });

  it("renders the finding's description", () => {
    expect(bodyOf({ description: "The `file` may be undefined." })).toContain(
      "The `file` may be undefined.",
    );
  });

  it("renders a recommendation lead-in only when recommendation is present", () => {
    expect(bodyOf({ recommendation: "Add a null guard." })).toContain(
      "**Recommended fix:** Add a null guard.",
    );
    expect(bodyOf({})).not.toContain("Recommended fix:");
  });

  it("projects a lowerable patch into a ```suggestion block with the added text", () => {
    const body = bodyOf({ patch: replacePatch("const x = 1;") });
    expect(body).toContain("```suggestion");
    expect(body).toContain("const x = 1;");
    expect(body).not.toContain("```patch");
  });

  it("projects an all-deletion patch into an empty ```suggestion block", () => {
    const body = bodyOf({ patch: ["@@ -2,2 +1,0 @@", "-b", "-c"].join("\n") });
    const match = /```suggestion\n([\s\S]*?)\n```/.exec(body);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("");
  });

  it("falls back to a raw ```patch block when the patch can't be lowered (pure insertion)", () => {
    const body = bodyOf({ patch: ["@@ -1,0 +2,1 @@", "+inserted"].join("\n") });
    expect(body).toContain("```patch");
    expect(body).toContain("+inserted");
    expect(body).not.toContain("```suggestion");
  });

  it("renders neither a suggestion nor a patch block when the finding has no patch", () => {
    const body = bodyOf({});
    expect(body).not.toContain("```suggestion");
    expect(body).not.toContain("```patch");
  });

  it("escapes triple backticks in a projected suggestion so it can't break out", () => {
    const body = bodyOf({ patch: replacePatch("```malicious```") });
    expect(body).toContain("`` ` ``");
    expect(body).not.toContain("```malicious```");
  });

  it("formats multiple models as backtick-wrapped, slash-joined names", () => {
    const { comments } = buildInlineComments(findingAt({}), diff, {
      inlineTemplate: bundledInlineTemplate,
      models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    });
    expect(comments[0]!.body).toContain("Generated by `deepseek-v4-pro`/`deepseek-v4-flash`");
  });

  it('falls back to "an AI model" when no models are known', () => {
    expect(bodyOf({})).toContain("Generated by an AI model");
  });

  it("always renders the confidence clause (required in 0.4), including 0, at 2 decimal places (issue #26)", () => {
    expect(bodyOf({ confidence: 0.75 })).toContain("0.75 confidence");
    expect(bodyOf({ confidence: 0 })).toContain("0.00 confidence");
  });

  it("always renders the reasoning fold (required in 0.4)", () => {
    const body = bodyOf({ reasoning: "Because X causes Y." });
    expect(body).toContain("<details>");
    expect(body).toContain("<summary>Reasoning</summary>");
    expect(body).toContain("Because X causes Y.");
    expect(body).toContain("</details>");
  });

  it("escapes reasoning so it cannot break out of the fold", () => {
    expect(bodyOf({ reasoning: "</details><script>alert(1)</script>" })).not.toContain(
      "</details><script>",
    );
  });

  it("prefixes every alert line with '>' so the [!TIP] callout renders contiguously", () => {
    const body = bodyOf({ confidence: 0.5, reasoning: "Some justification." });
    const alertBlock = body.slice(body.indexOf("> [!TIP]"));
    expect(
      alertBlock
        .split("\n")
        .filter((l) => l.length > 0)
        .every((l) => l.startsWith(">")),
    ).toBe(true);
  });

  it("keeps a multi-paragraph reasoning inside the alert — every fold line is '>'-prefixed", () => {
    const body = bodyOf({
      reasoning: "First paragraph of the reasoning.\n\nSecond paragraph.\nWrapped continuation.",
    });
    const lines = body.split("\n");
    const summaryIndex = lines.findIndex((l) => l.includes("<summary>Reasoning</summary>"));
    const closeIndex = lines.findIndex((l, i) => i > summaryIndex && l.includes("</details>"));
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(summaryIndex);
    const foldLines = lines.slice(summaryIndex + 1, closeIndex);
    expect(foldLines.some((l) => l === "> Second paragraph.")).toBe(true);
    expect(foldLines.filter((l) => l.length > 0).every((l) => l.startsWith(">"))).toBe(true);
  });
});

describe("findings-json marker on inline comments (issue #19 — shared serializer)", () => {
  const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;

  const findingAt = (overrides: Partial<Finding>): Finding[] => [
    mkFinding({ path: "src/foo.ts", start_line: 2, end_line: 2, ...overrides }),
  ];

  it("embeds the findings JSON as base64 as the very first line when a findings document is given", () => {
    const findings = findingAt({});
    const { comments } = buildInlineComments(findings, diff, {
      inlineTemplate: bundledInlineTemplate,
      findings: mkFindingsDoc(findings),
    });
    expect(comments[0]!.body.startsWith("<!-- AGENTS: STOP")).toBe(true);
    expect(comments[0]!.body).toContain("<!-- code-review:findings-json;base64 ");
  });

  it("round-trips the exact findings document through the embedded base64 marker", () => {
    const findings = findingAt({ title: "Round-trip me" });
    const doc = mkFindingsDoc(findings);
    const { comments } = buildInlineComments(findings, diff, {
      inlineTemplate: bundledInlineTemplate,
      findings: doc,
    });
    const match = /<!-- code-review:findings-json;base64 (\S+) -->/.exec(comments[0]!.body);
    expect(match).not.toBeNull();
    const decoded: unknown = JSON.parse(Buffer.from(match?.[1] ?? "", "base64").toString("utf-8"));
    expect(decoded).toEqual(doc);
  });

  it("falls back to the jsonUrl link marker when the embedded payload is too large", () => {
    const large = Array.from({ length: 500 }, (_, i) =>
      mkFinding({
        path: "src/foo.ts",
        start_line: 2,
        end_line: 2,
        title: `Finding ${String(i)}`,
        description: "x".repeat(200),
      }),
    );
    const { comments } = buildInlineComments(large, diff, {
      inlineTemplate: bundledInlineTemplate,
      findings: mkFindingsDoc(large),
      jsonUrl: "https://example.com/findings.json",
    });
    expect(comments[0]!.body).toContain(
      "<!-- code-review:findings-json https://example.com/findings.json -->",
    );
    expect(comments[0]!.body).not.toContain(";base64");
  });

  it("omits the marker entirely when the embedded payload is too large and no jsonUrl is given", () => {
    const large = Array.from({ length: 500 }, (_, i) =>
      mkFinding({
        path: "src/foo.ts",
        start_line: 2,
        end_line: 2,
        title: `Finding ${String(i)}`,
        description: "x".repeat(200),
      }),
    );
    const { comments } = buildInlineComments(large, diff, {
      inlineTemplate: bundledInlineTemplate,
      findings: mkFindingsDoc(large),
    });
    expect(comments[0]!.body).not.toContain("findings-json");
  });

  it("omits the marker when no findings document is given, even if jsonUrl is set", () => {
    const { comments } = buildInlineComments(findingAt({}), diff, {
      inlineTemplate: bundledInlineTemplate,
      jsonUrl: "https://example.com/findings.json",
    });
    expect(comments[0]!.body).not.toContain("code-review:findings-json");
  });
});

describe("injection resistance", () => {
  const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;

  it("handles pipe characters in finding title without breaking the comment", () => {
    const findings: Finding[] = [
      mkFinding({
        start_line: 2,
        end_line: 2,
        title: "Title | with | pipes",
        description: "Description text.",
      }),
    ];
    const { comments } = buildInlineComments(findings, diff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Description text.");
  });

  it("handles backtick sequences in a finding description", () => {
    const findings: Finding[] = [
      mkFinding({
        start_line: 2,
        end_line: 2,
        description: "Here is `inline code` and ```a fence``` in the description.",
      }),
    ];
    const { comments } = buildInlineComments(findings, diff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments[0]!.body).toContain("inline code");
    expect(comments[0]!.body).toContain("a fence");
  });

  it("handles angle brackets in a finding description", () => {
    const findings: Finding[] = [
      mkFinding({
        start_line: 2,
        end_line: 2,
        description: "Check <script>alert(1)</script> for XSS.",
      }),
    ];
    const { comments } = buildInlineComments(findings, diff, {
      inlineTemplate: bundledInlineTemplate,
    });
    // Description is passed through as-is (GitHub sanitizes)
    expect(comments[0]!.body).toContain("<script>");
  });
});
