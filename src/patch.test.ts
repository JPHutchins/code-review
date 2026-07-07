import { describe, it, expect } from "vitest";
import { validatePatch, patchToSuggestion } from "./patch.js";

describe("validatePatch — range from the removed lines (needs the file)", () => {
  it("returns the exact 1-line range for a 1-line replace that matches the file", () => {
    const fileLines = ["line1", "line2", "old line", "line4", "line5"];
    const patch = ["@@ -3 +3 @@", "-old line", "+new line"].join("\n");
    expect(validatePatch(patch, fileLines)).toEqual({ startLine: 3, endLine: 3 });
  });

  it("returns the removed-line range for a 2-old/3-new replace", () => {
    const fileLines = ["line1", "line2", "old A", "old B", "line5"];
    const patch = ["@@ -3,2 +3,3 @@", "-old A", "-old B", "+new A", "+new B", "+new C"].join("\n");
    expect(validatePatch(patch, fileLines)).toEqual({ startLine: 3, endLine: 4 });
  });

  it("uses only the removed lines' range, not the surrounding context", () => {
    const fileLines = ["ctx before", "old line", "ctx after"];
    const patch = ["@@ -1,3 +1,3 @@", " ctx before", "-old line", "+new line", " ctx after"].join(
      "\n",
    );
    expect(validatePatch(patch, fileLines)).toEqual({ startLine: 2, endLine: 2 });
  });

  it("returns the removed range for a pure deletion", () => {
    const fileLines = ["a", "b", "c", "d"];
    const patch = ["@@ -2,2 +1,0 @@", "-b", "-c"].join("\n");
    expect(validatePatch(patch, fileLines)).toEqual({ startLine: 2, endLine: 3 });
  });

  it("drops a pure insertion — there is no removed range to anchor", () => {
    const fileLines = ["a", "b", "c"];
    const patch = ["@@ -1,0 +2,1 @@", "+inserted"].join("\n");
    const result = validatePatch(patch, fileLines);
    expect("kind" in result && result.kind).toBe("drop");
    if ("kind" in result) expect(result.reason).toContain("pure insertion");
  });

  it("drops when the patch's context/removed lines don't match the file exactly", () => {
    const fileLines = ["a", "b", "c"];
    const patch = ["@@ -2 +2 @@", "-WRONG", "+new"].join("\n");
    const result = validatePatch(patch, fileLines);
    expect("kind" in result && result.kind).toBe("drop");
    if ("kind" in result) expect(result.reason).toContain("patch context does not match the file");
  });

  it("drops when the hunk range runs past the end of the file", () => {
    const fileLines = ["a", "b"];
    const patch = ["@@ -5 +5 @@", "-x", "+y"].join("\n");
    expect("kind" in validatePatch(patch, fileLines)).toBe(true);
  });

  it("drops a patch with more than one hunk", () => {
    const fileLines = ["a", "b", "c", "d"];
    const patch = ["@@ -1 +1 @@", "-a", "+A", "@@ -3 +3 @@", "-c", "+C"].join("\n");
    const result = validatePatch(patch, fileLines);
    expect("kind" in result && result.kind).toBe("drop");
    if ("kind" in result) expect(result.reason).toContain("expected exactly one hunk, got 2");
  });

  it("drops a non-contiguous change (a context line between two removed/added groups)", () => {
    const fileLines = ["x", "old1", "ctx", "old2", "y"];
    const patch = ["@@ -1,5 +1,5 @@", " x", "-old1", "+new1", " ctx", "-old2", "+new2", " y"].join(
      "\n",
    );
    const result = validatePatch(patch, fileLines);
    expect("kind" in result && result.kind).toBe("drop");
    if ("kind" in result) expect(result.reason).toContain("not a single contiguous block");
  });

  it("drops a patch with no hunk header at all", () => {
    const result = validatePatch("not a real diff\njust text", ["a", "b"]);
    expect("kind" in result && result.kind).toBe("drop");
    if ("kind" in result) expect(result.reason).toContain("expected exactly one hunk, got 0");
  });

  it("drops a hunk body line with no recognizable marker, never throwing", () => {
    const patch = ["@@ -1 +1 @@", "garbled"].join("\n");
    expect(() => validatePatch(patch, ["a"])).not.toThrow();
    expect("kind" in validatePatch(patch, ["a"])).toBe(true);
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
    expect(validatePatch(patch, fileLines)).toEqual({ startLine: 1, endLine: 1 });
  });
});

describe("patchToSuggestion — replacement text from the added lines (no file)", () => {
  it("returns the added lines for a 1-line replace", () => {
    const patch = ["@@ -3 +3 @@", "-old line", "+new line"].join("\n");
    expect(patchToSuggestion(patch)).toBe("new line");
  });

  it("joins multiple added lines with newlines", () => {
    const patch = ["@@ -3,2 +3,3 @@", "-old A", "-old B", "+new A", "+new B", "+new C"].join("\n");
    expect(patchToSuggestion(patch)).toBe("new A\nnew B\nnew C");
  });

  it("preserves leading tabs/spaces on added lines verbatim (issue #10 fix)", () => {
    const patch = ["@@ -2 +2,2 @@", "-  return 1;", "+\treturn 2;", "+    return 3;"].join("\n");
    expect(patchToSuggestion(patch)).toBe("\treturn 2;\n    return 3;");
  });

  it("returns an empty string for a pure deletion (delete the range)", () => {
    const patch = ["@@ -2,2 +1,0 @@", "-b", "-c"].join("\n");
    expect(patchToSuggestion(patch)).toBe("");
  });

  it("drops a pure insertion — a suggestion must replace at least one existing line", () => {
    const patch = ["@@ -1,0 +2,1 @@", "+inserted"].join("\n");
    const result = patchToSuggestion(patch);
    expect(typeof result === "object" && result.kind).toBe("drop");
    if (typeof result === "object") expect(result.reason).toContain("pure insertion");
  });

  it("drops a multi-hunk patch", () => {
    const patch = ["@@ -1 +1 @@", "-a", "+A", "@@ -3 +3 @@", "-c", "+C"].join("\n");
    const result = patchToSuggestion(patch);
    expect(typeof result === "object" && result.kind).toBe("drop");
    if (typeof result === "object") expect(result.reason).toContain("expected exactly one hunk");
  });

  it("drops a non-contiguous change", () => {
    const patch = ["@@ -1,5 +1,5 @@", " x", "-old1", "+new1", " ctx", "-old2", "+new2", " y"].join(
      "\n",
    );
    const result = patchToSuggestion(patch);
    expect(typeof result === "object" && result.kind).toBe("drop");
    if (typeof result === "object")
      expect(result.reason).toContain("not a single contiguous block");
  });

  it("drops malformed input, never throwing", () => {
    expect(() => patchToSuggestion("not a real diff\njust text")).not.toThrow();
    expect(typeof patchToSuggestion("not a real diff") === "object").toBe(true);
  });

  it("ignores file-header lines and a trailing no-newline marker (no file needed)", () => {
    const patch = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
      "\\ No newline at end of file",
    ].join("\n");
    expect(patchToSuggestion(patch)).toBe("new line");
  });
});
