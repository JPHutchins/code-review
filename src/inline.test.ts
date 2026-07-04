import { describe, it, expect } from "vitest";
import { buildCommentBody, buildInlineComments, renderStraysSection } from "./inline.js";
import type { Finding } from "./schema.js";

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
  it("returns just the body when there is no suggestion", () => {
    const f = mkFinding({ body: "Just a body.", suggestion: undefined });
    expect(buildCommentBody(f)).toBe("Just a body.");
  });

  it("returns just the body when suggestion is null", () => {
    const f = mkFinding({ body: "Just a body.", suggestion: null });
    expect(buildCommentBody(f)).toBe("Just a body.");
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
    // Body (empty) is still present, just empty string
    expect(result.startsWith("\n\n") || result.startsWith("```")).toBe(true);
  });

  it("uses two newlines to separate body and suggestion", () => {
    const f = mkFinding({
      body: "Body text.",
      suggestion: "Fix here.",
    });
    const result = buildCommentBody(f);
    expect(result).toBe("Body text.\n\n```suggestion\nFix here.\n```");
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

// ---- Custom inline template rendering ----

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

    const { comments, strays } = buildInlineComments(findings, diff, inlineTemplate);
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

    const { comments } = buildInlineComments(findings, diff, inlineTemplate);
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

    const { comments } = buildInlineComments(findings, diff, inlineTemplate);
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

    const { comments } = buildInlineComments(findings, diff, inlineTemplate);
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

    const { comments } = buildInlineComments(findings, diff, inlineTemplate);
    // Backticks should be escaped
    expect(comments[0]!.body).toContain("`` ` ``");
    expect(comments[0]!.body).not.toContain("```malicious```");
  });
});

// ---- Template injection attempts ----

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
