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
  body: "Test body content.",
  ...overrides,
});

/** A full findings document wrapping the given findings — needed to exercise the findings-json
 *  marker (issue #19), which embeds the whole document, not a single finding. */
const mkFindingsDoc = (findings: readonly Finding[]): Findings => ({
  schema_version: "0.2.0",
  summary: "A test summary.",
  verdict: "comment",
  findings: [...findings],
});

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
      mkFinding({
        path: "src/foo.ts",
        start_line: 22,
        end_line: 24,
        title: "multi-line",
      }),
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
      mkFinding({
        path: "src/foo.ts",
        start_line: 10,
        end_line: 10,
        title: "single-line",
      }),
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
      mkFinding({
        path: "src/foo.ts",
        start_line: 10,
        end_line: 10,
        side: "LEFT",
        title: "left-side",
      }),
    ];
    const { comments } = buildInlineComments(findings, inlineDiff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.side).toBe("LEFT");
  });

  it("defaults side to RIGHT when not specified", () => {
    const findings: Finding[] = [
      mkFinding({
        path: "src/foo.ts",
        start_line: 10,
        end_line: 10,
        side: undefined,
      }),
    ];
    const { comments } = buildInlineComments(findings, inlineDiff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments[0]!.side).toBe("RIGHT");
  });

  it("includes suggestion text in comment body", () => {
    const findings: Finding[] = [
      mkFinding({
        path: "src/foo.ts",
        start_line: 10,
        end_line: 10,
        body: "Use const.",
        suggestion: "const x = 1;",
      }),
    ];
    const { comments } = buildInlineComments(findings, inlineDiff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments[0]!.body).toContain("Use const.");
    expect(comments[0]!.body).toContain("const x = 1;");
    expect(comments[0]!.body).toContain("```suggestion");
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
      mkFinding({
        path: "src/bar.ts",
        start_line: 100,
        severity: "major",
        title: "Off-by-one possible.",
      }),
    ];
    const result = renderStraysSection(strays);
    expect(result).toContain("Findings on lines not in the diff");
    expect(result).toContain("src/bar.ts:100");
    expect(result).toContain("major");
    expect(result).toContain("Off-by-one possible.");
  });

  it("renders multiple stray findings", () => {
    const strays: Finding[] = [
      mkFinding({
        path: "src/a.ts",
        start_line: 1,
        severity: "critical",
        title: "Critical stray.",
      }),
      mkFinding({
        path: "src/b.ts",
        start_line: 2,
        severity: "minor",
        title: "Minor stray.",
      }),
      mkFinding({
        path: "src/c.ts",
        start_line: 3,
        severity: "nit",
        title: "Nit stray.",
      }),
    ];
    const result = renderStraysSection(strays);
    expect(result).toContain("critical");
    expect(result).toContain("Critical stray.");
    expect(result).toContain("minor");
    expect(result).toContain("Minor stray.");
    expect(result).toContain("nit");
    expect(result).toContain("Nit stray.");
    // All should be list items
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
    const result = renderStraysSection(strays);
    expect(result).toContain("**nit**");
  });
});

describe("buildInlineComments with custom template", () => {
  const inlineTemplate = `<%~ it.body %>

<% if (it.suggestion !== null && it.suggestion !== undefined) { %>
\`\`\`suggestion
<%~ it.suggestion %>
\`\`\`
<% } %>

<sub>🤖 AI-generated — advisory only</sub>`;

  it("renders comment bodies using the custom template", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;
    const findings: Finding[] = [
      mkFinding({
        path: "src/foo.ts",
        start_line: 2,
        end_line: 2,
        body: "Custom body text.",
        suggestion: null,
      }),
    ];

    const { comments, strays } = buildInlineComments(findings, diff, { inlineTemplate });
    expect(comments).toHaveLength(1);
    expect(strays).toHaveLength(0);
    expect(comments[0]!.body).toContain("Custom body text.");
    expect(comments[0]!.body).toContain("AI-generated — advisory only");
  });

  it("renders suggestion blocks in custom template", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;
    const findings: Finding[] = [
      mkFinding({
        path: "src/foo.ts",
        start_line: 2,
        end_line: 2,
        body: "Consider this approach.",
        suggestion: "const result = await fetch();",
      }),
    ];

    const { comments } = buildInlineComments(findings, diff, { inlineTemplate });
    expect(comments[0]!.body).toContain("```suggestion");
    expect(comments[0]!.body).toContain("const result = await fetch();");
    expect(comments[0]!.body).toContain("```");
  });

  it('renders a deletion block when suggestion is "" (empty string) via custom template', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;
    const findings: Finding[] = [
      mkFinding({
        path: "src/foo.ts",
        start_line: 2,
        end_line: 2,
        body: "Delete this line.",
        suggestion: "",
      }),
    ];

    const { comments } = buildInlineComments(findings, diff, { inlineTemplate });
    expect(comments[0]!.body).toContain("```suggestion");
    expect(comments[0]!.body).toContain("```");
    const match = /```suggestion\n([\s\S]*?)\n```/.exec(comments[0]!.body);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("");
  });

  it("renders no suggestion block when suggestion is null via custom template", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;
    const findings: Finding[] = [
      mkFinding({
        path: "src/foo.ts",
        start_line: 2,
        end_line: 2,
        body: "Just a note.",
        suggestion: null,
      }),
    ];

    const { comments } = buildInlineComments(findings, diff, { inlineTemplate });
    expect(comments[0]!.body).not.toContain("```suggestion");
  });

  it("escapes triple backticks in suggestion for custom template", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;
    const findings: Finding[] = [
      mkFinding({
        path: "src/foo.ts",
        start_line: 2,
        end_line: 2,
        body: "Broken suggestion.",
        suggestion: "```malicious```",
      }),
    ];

    const { comments } = buildInlineComments(findings, diff, { inlineTemplate });
    // Backticks should be escaped
    expect(comments[0]!.body).toContain("`` ` ``");
    expect(comments[0]!.body).not.toContain("```malicious```");
  });
});

describe("buildInlineComments with the bundled inline template (issues #12, #15, #16, #22)", () => {
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

  it("renders a severity header at the top, using the sticky's emoji mapping", () => {
    const { comments } = buildInlineComments(
      findingAt({ severity: "critical", title: "SQLi" }),
      diff,
      { inlineTemplate: bundledInlineTemplate },
    );
    expect(comments[0]!.body.startsWith("🔴 **critical** — SQLi")).toBe(true);
  });

  it("formats multiple models as backtick-wrapped, slash-joined names", () => {
    const { comments } = buildInlineComments(findingAt({}), diff, {
      inlineTemplate: bundledInlineTemplate,
      models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    });
    expect(comments[0]!.body).toContain("Generated by `deepseek-v4-pro`/`deepseek-v4-flash`");
  });

  it('falls back to "an AI model" when no models are known', () => {
    const { comments } = buildInlineComments(findingAt({}), diff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments[0]!.body).toContain("Generated by an AI model.");
  });

  it("appends the confidence clause only when confidence is a number, including 0", () => {
    const withConfidence = buildInlineComments(findingAt({ confidence: 0.75 }), diff, {
      inlineTemplate: bundledInlineTemplate,
    }).comments[0]!.body;
    expect(withConfidence).toContain("at 0.75 confidence.");

    const zeroConfidence = buildInlineComments(findingAt({ confidence: 0 }), diff, {
      inlineTemplate: bundledInlineTemplate,
    }).comments[0]!.body;
    expect(zeroConfidence).toContain("at 0 confidence.");

    const noConfidence = buildInlineComments(findingAt({}), diff, {
      inlineTemplate: bundledInlineTemplate,
    }).comments[0]!.body;
    expect(noConfidence).not.toContain("confidence.");
  });

  it("renders a collapsible reasoning fold only when reasoning is present", () => {
    const withReasoning = buildInlineComments(
      findingAt({ reasoning: "Because X causes Y." }),
      diff,
      { inlineTemplate: bundledInlineTemplate },
    ).comments[0]!.body;
    expect(withReasoning).toContain("<details>");
    expect(withReasoning).toContain("<summary>Reasoning</summary>");
    expect(withReasoning).toContain("Because X causes Y.");
    expect(withReasoning).toContain("</details>");

    const withoutReasoning = buildInlineComments(findingAt({}), diff, {
      inlineTemplate: bundledInlineTemplate,
    }).comments[0]!.body;
    expect(withoutReasoning).not.toContain("<details>");
  });

  it("escapes reasoning so it cannot break out of the fold", () => {
    const { comments } = buildInlineComments(
      findingAt({ reasoning: "</details><script>alert(1)</script>" }),
      diff,
      { inlineTemplate: bundledInlineTemplate },
    );
    expect(comments[0]!.body).not.toContain("</details><script>");
  });

  it("prefixes every alert line with '>' so the [!TIP] callout renders contiguously", () => {
    const { comments } = buildInlineComments(
      findingAt({ confidence: 0.5, reasoning: "Some justification." }),
      diff,
      { inlineTemplate: bundledInlineTemplate, models: ["m"] },
    );
    const body = comments[0]!.body;
    const alertBlock = body.slice(body.indexOf("> [!TIP]"));
    expect(
      alertBlock
        .split("\n")
        .filter((l) => l.length > 0)
        .every((l) => l.startsWith(">")),
    ).toBe(true);
  });

  it("keeps a multi-paragraph reasoning inside the alert — every fold line is '> '-prefixed", () => {
    const { comments } = buildInlineComments(
      findingAt({
        reasoning: "First paragraph of the reasoning.\n\nSecond paragraph.\nWrapped continuation.",
      }),
      diff,
      { inlineTemplate: bundledInlineTemplate },
    );
    const lines = comments[0]!.body.split("\n");
    const summaryIndex = lines.findIndex((l) => l.includes("<summary>Reasoning</summary>"));
    const closeIndex = lines.findIndex((l, i) => i > summaryIndex && l.includes("</details>"));
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(summaryIndex);
    // Every non-empty line between <summary> and </details> must stay in the blockquote (begin
    // with the '>' marker) — a continuation line at column 0 would terminate the [!TIP] alert
    // early (the reported bug). Bare separator lines are '>' (no trailing space), so the
    // invariant is the '>' marker, not literal '> '.
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
        body: "x".repeat(200),
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
        body: "x".repeat(200),
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
  it("handles pipe characters in finding title without breaking table", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;
    const findings: Finding[] = [
      mkFinding({
        path: "src/foo.ts",
        start_line: 2,
        end_line: 2,
        title: "Title | with | pipes",
        body: "Body text.",
      }),
    ];

    const { comments } = buildInlineComments(findings, diff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Body text.");
  });

  it("handles backtick sequences in finding body", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;
    const findings: Finding[] = [
      mkFinding({
        path: "src/foo.ts",
        start_line: 2,
        end_line: 2,
        body: "Here is `inline code` and ```a fence``` in body.",
      }),
    ];

    const { comments } = buildInlineComments(findings, diff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments[0]!.body).toContain("inline code");
    expect(comments[0]!.body).toContain("a fence");
  });

  it("handles angle brackets in finding body", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 line1
+added
`;
    const findings: Finding[] = [
      mkFinding({
        path: "src/foo.ts",
        start_line: 2,
        end_line: 2,
        body: "Check <script>alert(1)</script> for XSS.",
      }),
    ];

    const { comments } = buildInlineComments(findings, diff, {
      inlineTemplate: bundledInlineTemplate,
    });
    // Body is passed through as-is (GitHub sanitizes)
    expect(comments[0]!.body).toContain("<script>");
  });
});
