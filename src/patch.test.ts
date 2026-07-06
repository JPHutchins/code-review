import { describe, it, expect } from "vitest";
import { lowerPatch } from "./patch.js";

describe("lowerPatch — simple replace", () => {
  it("lowers a 1-line replace to the exact range and text", () => {
    const fileLines = ["line1", "line2", "old line", "line4", "line5"];
    const patch = ["@@ -3 +3 @@", "-old line", "+new line"].join("\n");
    expect(lowerPatch(patch, fileLines)).toEqual({
      kind: "ok",
      startLine: 3,
      endLine: 3,
      suggestion: "new line",
    });
  });
});

describe("lowerPatch — multi-line replace", () => {
  it("lowers a 2-line-old / 3-line-new replace to the removed-line range", () => {
    const fileLines = ["line1", "line2", "old A", "old B", "line5"];
    const patch = ["@@ -3,2 +3,3 @@", "-old A", "-old B", "+new A", "+new B", "+new C"].join("\n");
    expect(lowerPatch(patch, fileLines)).toEqual({
      kind: "ok",
      startLine: 3,
      endLine: 4,
      suggestion: "new A\nnew B\nnew C",
    });
  });
});

describe("lowerPatch — surrounding context is trimmed", () => {
  it("uses only the removed lines' range, not the surrounding context", () => {
    const fileLines = ["ctx before", "old line", "ctx after"];
    const patch = ["@@ -1,3 +1,3 @@", " ctx before", "-old line", "+new line", " ctx after"].join(
      "\n",
    );
    expect(lowerPatch(patch, fileLines)).toEqual({
      kind: "ok",
      startLine: 2,
      endLine: 2,
      suggestion: "new line",
    });
  });
});

describe("lowerPatch — indentation is preserved verbatim", () => {
  it("carries leading tabs/spaces on added lines through to the suggestion (issue #10 fix)", () => {
    const fileLines = ["function foo() {", "  return 1;", "}"];
    const patch = ["@@ -2 +2,2 @@", "-  return 1;", "+\treturn 2;", "+    return 3;"].join("\n");
    const result = lowerPatch(patch, fileLines);
    expect(result).toEqual({
      kind: "ok",
      startLine: 2,
      endLine: 2,
      suggestion: "\treturn 2;\n    return 3;",
    });
  });
});

describe("lowerPatch — pure deletion", () => {
  it("returns an empty-string suggestion over the removed range", () => {
    const fileLines = ["a", "b", "c", "d"];
    const patch = ["@@ -2,2 +1,0 @@", "-b", "-c"].join("\n");
    expect(lowerPatch(patch, fileLines)).toEqual({
      kind: "ok",
      startLine: 2,
      endLine: 3,
      suggestion: "",
    });
  });
});

describe("lowerPatch — pure insertion", () => {
  it("drops — a suggestion must replace at least one existing line", () => {
    const fileLines = ["a", "b", "c"];
    const patch = ["@@ -1,0 +2,1 @@", "+inserted"].join("\n");
    const result = lowerPatch(patch, fileLines);
    expect(result.kind).toBe("drop");
    expect(result.kind === "drop" && result.reason).toContain("pure insertion");
  });
});

describe("lowerPatch — old-side mismatch", () => {
  it("drops when the patch's context/removed lines don't match the file exactly", () => {
    const fileLines = ["a", "b", "c"];
    const patch = ["@@ -2 +2 @@", "-WRONG", "+new"].join("\n");
    const result = lowerPatch(patch, fileLines);
    expect(result.kind).toBe("drop");
    expect(result.kind === "drop" && result.reason).toContain(
      "patch context does not match the file",
    );
  });

  it("drops when the hunk range runs past the end of the file", () => {
    const fileLines = ["a", "b"];
    const patch = ["@@ -5 +5 @@", "-x", "+y"].join("\n");
    const result = lowerPatch(patch, fileLines);
    expect(result.kind).toBe("drop");
  });
});

describe("lowerPatch — multi-hunk", () => {
  it("drops a patch with more than one hunk", () => {
    const fileLines = ["a", "b", "c", "d"];
    const patch = ["@@ -1 +1 @@", "-a", "+A", "@@ -3 +3 @@", "-c", "+C"].join("\n");
    const result = lowerPatch(patch, fileLines);
    expect(result.kind).toBe("drop");
    expect(result.kind === "drop" && result.reason).toContain("expected exactly one hunk, got 2");
  });
});

describe("lowerPatch — non-contiguous change", () => {
  it("drops when a context line sits between two removed/added groups", () => {
    const fileLines = ["x", "old1", "ctx", "old2", "y"];
    const patch = ["@@ -1,5 +1,5 @@", " x", "-old1", "+new1", " ctx", "-old2", "+new2", " y"].join(
      "\n",
    );
    const result = lowerPatch(patch, fileLines);
    expect(result.kind).toBe("drop");
    expect(result.kind === "drop" && result.reason).toContain("not a single contiguous block");
  });
});

describe("lowerPatch — malformed input", () => {
  it("drops a patch with no hunk header at all", () => {
    const result = lowerPatch("not a real diff\njust text", ["a", "b"]);
    expect(result.kind).toBe("drop");
    expect(result.kind === "drop" && result.reason).toContain("expected exactly one hunk, got 0");
  });

  it("drops a hunk body line with no recognizable marker, never throwing", () => {
    const patch = ["@@ -1 +1 @@", "garbled"].join("\n");
    expect(() => lowerPatch(patch, ["a"])).not.toThrow();
    expect(lowerPatch(patch, ["a"]).kind).toBe("drop");
  });

  it("ignores file-header lines and a trailing no-newline marker", () => {
    const fileLines = ["old line"];
    const patch = [
      "diff --git a/f.ts b/f.ts",
      "index abc..def 100644",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
      "\\ No newline at end of file",
    ].join("\n");
    expect(lowerPatch(patch, fileLines)).toEqual({
      kind: "ok",
      startLine: 1,
      endLine: 1,
      suggestion: "new line",
    });
  });
});
