import { describe, it, expect } from "vitest";
import { indexDiff, isInDiff, partitionFindings, defaultSide } from "./diff.js";
import type { Finding } from "./schema.js";

const sampleDiff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,5 @@
 line1
 line2
+added1
+added2
@@ -10,4 +12,5 @@
 line10
 line11
 line12
+added3
`;

const finding = (overrides: Partial<Finding>): Finding => ({
  path: "src/foo.ts",
  start_line: 1,
  end_line: 1,
  severity: "minor",
  title: "test",
  body: "test body",
  suggestion: null,
  ...overrides,
});

describe("indexDiff", () => {
  const index = indexDiff(sampleDiff);

  it("indexes normal lines at their new line numbers", () => {
    expect(isInDiff(index, "src/foo.ts", 1)).toBe(true);
    expect(isInDiff(index, "src/foo.ts", 2)).toBe(true);
  });

  it("indexes added lines at their new line numbers", () => {
    expect(isInDiff(index, "src/foo.ts", 3)).toBe(true);
    expect(isInDiff(index, "src/foo.ts", 4)).toBe(true);
  });

  it("does NOT index lines outside the diff", () => {
    expect(isInDiff(index, "src/foo.ts", 999)).toBe(false);
    expect(isInDiff(index, "src/foo.ts", 50)).toBe(false);
  });

  it("does NOT index files not in the diff", () => {
    expect(isInDiff(index, "src/bar.ts", 1)).toBe(false);
  });
});

describe("partitionFindings", () => {
  const index = indexDiff(sampleDiff);

  it("partitions findings into in-diff and strays", () => {
    const findings: Finding[] = [
      finding({ path: "src/foo.ts", start_line: 1, title: "in-diff context" }),
      finding({ path: "src/foo.ts", start_line: 3, title: "in-diff addition" }),
      finding({ path: "src/foo.ts", start_line: 999, title: "stray" }),
      finding({ path: "src/bar.ts", start_line: 1, title: "wrong file" }),
    ];

    const { inDiff, strays } = partitionFindings(findings, index);

    expect(inDiff).toHaveLength(2);
    expect(inDiff[0]!.title).toBe("in-diff context");
    expect(inDiff[1]!.title).toBe("in-diff addition");

    expect(strays).toHaveLength(2);
    expect(strays[0]!.title).toBe("stray");
    expect(strays[1]!.title).toBe("wrong file");
  });

  it("returns empty strays when all findings are in-diff", () => {
    const findings: Finding[] = [
      finding({ path: "src/foo.ts", start_line: 1 }),
      finding({ path: "src/foo.ts", start_line: 3 }),
    ];

    const { inDiff, strays } = partitionFindings(findings, index);

    expect(inDiff).toHaveLength(2);
    expect(strays).toHaveLength(0);
  });
});

// ---- LEFT-side findings ----

const leftSideDiff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,1 @@
 line1
-line2
-line3
@@ -10,2 +9,3 @@
 line10
+added1
+added2
`;

describe("LEFT-side (deletion) line indexing", () => {
  it("indexes deleted lines so LEFT-side findings can match", () => {
    const index = indexDiff(leftSideDiff);
    // Deleted lines 2 and 3 from the first hunk (old file)
    expect(isInDiff(index, "src/foo.ts", 2)).toBe(true);
    expect(isInDiff(index, "src/foo.ts", 3)).toBe(true);
  });

  it("also indexes added lines in the same diff", () => {
    const index = indexDiff(leftSideDiff);
    // Added lines in second hunk (new file)
    expect(isInDiff(index, "src/foo.ts", 10)).toBe(true);
    expect(isInDiff(index, "src/foo.ts", 11)).toBe(true);
  });

  it("partitions LEFT-side findings correctly against deletion lines", () => {
    const index = indexDiff(leftSideDiff);
    const findings: Finding[] = [
      finding({ path: "src/foo.ts", start_line: 2, side: "LEFT", title: "on-deleted-line" }),
      finding({ path: "src/foo.ts", start_line: 3, side: "LEFT", title: "another-deleted" }),
      finding({ path: "src/foo.ts", start_line: 50, side: "LEFT", title: "not-in-diff" }),
    ];
    const { inDiff, strays } = partitionFindings(findings, index);
    expect(inDiff).toHaveLength(2);
    expect(inDiff[0]!.title).toBe("on-deleted-line");
    expect(strays).toHaveLength(1);
  });
});

// ---- Multi-file diffs with overlapping line numbers ----

const multiFileDiff = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 line1
+addedInA
@@ -5,1 +6,2 @@
 line5
+addedInA2
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,2 @@
 line1
+addedInB
`;

describe("multi-file diff indexing", () => {
  const index = indexDiff(multiFileDiff);

  it("scopes line numbers per file path", () => {
    // Both files have line 2, but they should be distinct by path
    expect(isInDiff(index, "src/a.ts", 2)).toBe(true);
    expect(isInDiff(index, "src/b.ts", 2)).toBe(true);
  });

  it("does not cross-contaminate files", () => {
    // line 6 only exists in a.ts
    expect(isInDiff(index, "src/a.ts", 6)).toBe(true);
    expect(isInDiff(index, "src/b.ts", 6)).toBe(false);
  });

  it("partitions findings across files correctly", () => {
    const findings: Finding[] = [
      finding({ path: "src/a.ts", start_line: 2, title: "a-line2" }),
      finding({ path: "src/b.ts", start_line: 2, title: "b-line2" }),
      finding({ path: "src/a.ts", start_line: 6, title: "a-line6" }),
      finding({ path: "src/b.ts", start_line: 6, title: "b-line6-stray" }),
    ];
    const { inDiff, strays } = partitionFindings(findings, index);
    expect(inDiff).toHaveLength(3);
    expect(strays).toHaveLength(1);
    expect(strays[0]!.title).toBe("b-line6-stray");
  });
});

// ---- Empty diff input ----

describe("empty diff input", () => {
  it("returns an empty index for an empty string", () => {
    const index = indexDiff("");
    expect(index.size).toBe(0);
  });

  it("returns an empty index for whitespace-only", () => {
    const index = indexDiff("   \n  \n  ");
    expect(index.size).toBe(0);
  });

  it("partitions all findings as strays with empty diff", () => {
    const index = indexDiff("");
    const findings: Finding[] = [
      finding({ path: "src/foo.ts", start_line: 1 }),
      finding({ path: "src/bar.ts", start_line: 10 }),
    ];
    const { inDiff, strays } = partitionFindings(findings, index);
    expect(inDiff).toHaveLength(0);
    expect(strays).toHaveLength(2);
  });
});

// ---- Diff with only deleted files ----

const deleteOnlyDiff = `diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
index abc..0000000
--- a/src/removed.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3
`;

describe("deleted-files-only diff", () => {
  it("indexes deleted lines even without new file path", () => {
    const index = indexDiff(deleteOnlyDiff);
    // Lines from the old file (deleted) should still be indexed
    expect(isInDiff(index, "src/removed.ts", 1)).toBe(true);
    expect(isInDiff(index, "src/removed.ts", 2)).toBe(true);
    expect(isInDiff(index, "src/removed.ts", 3)).toBe(true);
  });
});

// ---- Renamed file diff ----

const renameDiff = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,3 @@
 line1
 line2
+addedInRename
`;

describe("renamed file diff", () => {
  const index = indexDiff(renameDiff);

  it("indexes lines under the old path", () => {
    expect(isInDiff(index, "src/old.ts", 1)).toBe(true);
    expect(isInDiff(index, "src/old.ts", 2)).toBe(true);
  });

  it("indexes lines under the new path", () => {
    expect(isInDiff(index, "src/new.ts", 1)).toBe(true);
    expect(isInDiff(index, "src/new.ts", 2)).toBe(true);
    expect(isInDiff(index, "src/new.ts", 3)).toBe(true);
  });

  it("finds findings on either old or new path", () => {
    const findings: Finding[] = [
      finding({ path: "src/old.ts", start_line: 1, title: "old-path" }),
      finding({ path: "src/new.ts", start_line: 3, title: "new-path" }),
    ];
    const { inDiff, strays } = partitionFindings(findings, index);
    expect(inDiff).toHaveLength(2);
    expect(strays).toHaveLength(0);
  });
});

// ---- defaultSide ----

describe("defaultSide", () => {
  it('returns "RIGHT" when side is undefined', () => {
    expect(defaultSide(undefined)).toBe("RIGHT");
  });

  it('returns "LEFT" when side is "LEFT"', () => {
    expect(defaultSide("LEFT")).toBe("LEFT");
  });

  it('returns "RIGHT" when side is "RIGHT"', () => {
    expect(defaultSide("RIGHT")).toBe("RIGHT");
  });

  it('returns "RIGHT" for any unrecognized string', () => {
    expect(defaultSide("BOTH")).toBe("RIGHT");
  });
});
