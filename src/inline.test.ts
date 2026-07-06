import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommentBody, buildInlineComments, renderStraysSection } from "./inline.js";
import type { Finding } from "./schema.js";

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

describe("buildCommentBody", () => {
  it("returns a severity header + body when there is no suggestion", () => {
    const f = mkFinding({ body: "Just a body.", suggestion: undefined });
    expect(buildCommentBody(f)).toBe("🔵 **minor** — Test finding\n\nJust a body.");
  });

  it("returns a severity header + body when suggestion is null", () => {
    const f = mkFinding({ body: "Just a body.", suggestion: null });
    expect(buildCommentBody(f)).toBe("🔵 **minor** — Test finding\n\nJust a body.");
  });

  it("includes a suggestion block when suggestion is provided", () => {
    const f = mkFinding({
      body: "Consider this change.",
      suggestion: "const x: number = 42;",
    });
    const result = buildCommentBody(f);
    expect(result).toContain("Consider this change.");
    expect(result).toContain("```suggestion");
    expect(result).toContain("const x: number = 42;");
    expect(result).toContain("```");
  });

  it("handles empty body with suggestion", () => {
    const f = mkFinding({
      body: "",
      suggestion: "// Replace whole block",
    });
    const result = buildCommentBody(f);
    expect(result).toContain("```suggestion");
    expect(result).toContain("// Replace whole block");
  });

  it("uses two newlines to separate header, body, and suggestion", () => {
    const f = mkFinding({
      body: "Body text.",
      suggestion: "Fix here.",
    });
    const result = buildCommentBody(f);
    expect(result).toBe(
      "🔵 **minor** — Test finding\n\nBody text.\n\n```suggestion\nFix here.\n```",
    );
  });

  it("prepends the severity header for each severity with the sticky's emoji mapping", () => {
    expect(buildCommentBody(mkFinding({ severity: "critical" }))).toContain("🔴 **critical** —");
    expect(buildCommentBody(mkFinding({ severity: "major" }))).toContain("🟠 **major** —");
    expect(buildCommentBody(mkFinding({ severity: "minor" }))).toContain("🔵 **minor** —");
    expect(buildCommentBody(mkFinding({ severity: "nit" }))).toContain("⚪ **nit** —");
  });

  it("emits the findings-json marker as the first line when jsonUrl is given", () => {
    const f = mkFinding({ body: "Body." });
    const result = buildCommentBody(f, "https://example.com/findings.json");
    expect(
      result.startsWith("<!-- code-review:findings-json https://example.com/findings.json -->"),
    ).toBe(true);
  });

  it("omits the findings-json marker when jsonUrl is absent", () => {
    const f = mkFinding({ body: "Body." });
    expect(buildCommentBody(f)).not.toContain("code-review:findings-json");
  });
});

describe("buildInlineComments", () => {
  it("includes in-diff findings as comments", () => {
    const findings: Finding[] = [
      mkFinding({ path: "src/foo.ts", start_line: 10, end_line: 10, title: "on-line10" }),
    ];
    const { comments, strays } = buildInlineComments(findings, inlineDiff);
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
    const { comments, strays } = buildInlineComments(findings, inlineDiff);
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
    const { comments } = buildInlineComments(findings, inlineDiff);
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
    const { comments } = buildInlineComments(findings, inlineDiff);
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
    const { comments } = buildInlineComments(findings, inlineDiff);
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
    const { comments } = buildInlineComments(findings, inlineDiff);
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
    const { comments } = buildInlineComments(findings, inlineDiff);
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
    const { comments, strays } = buildInlineComments(findings, inlineDiff);
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

describe("buildInlineComments with the bundled inline template (issues #12, #15, #16)", () => {
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

  it("emits the findings-json marker as the very first line when jsonUrl is set", () => {
    const { comments } = buildInlineComments(findingAt({}), diff, {
      inlineTemplate: bundledInlineTemplate,
      jsonUrl: "https://example.com/findings.json",
    });
    expect(
      comments[0]!.body.startsWith(
        "<!-- code-review:findings-json https://example.com/findings.json -->",
      ),
    ).toBe(true);
  });

  it("omits the findings-json marker when jsonUrl is absent", () => {
    const { comments } = buildInlineComments(findingAt({}), diff, {
      inlineTemplate: bundledInlineTemplate,
    });
    expect(comments[0]!.body).not.toContain("code-review:findings-json");
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

    const { comments } = buildInlineComments(findings, diff);
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

    const { comments } = buildInlineComments(findings, diff);
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

    const { comments } = buildInlineComments(findings, diff);
    // Body is passed through as-is (GitHub sanitizes)
    expect(comments[0]!.body).toContain("<script>");
  });
});
