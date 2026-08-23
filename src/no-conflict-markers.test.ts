import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./test-util.js";

// Conflict markers in a .ts file fail typecheck, and in a workflow they fail actionlint — so the gate
// already catches them everywhere it looks. It does not look at Markdown, JSON, or templates, and a
// merge resolved file-by-file against the compiler's complaints leaves exactly those behind. This
// asks git for every tracked file instead of trusting which ones the other checks happen to read.
const trackedFiles = (): readonly string[] =>
  execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8" })
    .split("\0")
    .filter((path) => path !== "");

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/;

describe("the working tree", () => {
  it("has no unresolved conflict markers in any tracked file", () => {
    const offenders = trackedFiles().flatMap((path) => {
      const content = (() => {
        try {
          return readFileSync(`${repoRoot}/${path}`, "utf-8");
        } catch {
          return "";
        }
      })();
      const lines = content.split("\n");
      const hit = lines.findIndex((line) => CONFLICT_MARKER.test(line));
      return hit === -1 ? [] : [`${path}:${String(hit + 1)}`];
    });

    expect(offenders).toEqual([]);
  });

  it("reads a meaningful number of tracked files", () => {
    expect(trackedFiles().length).toBeGreaterThan(20);
  });

  it("recognises each marker form", () => {
    expect(CONFLICT_MARKER.test("<<<<<<< HEAD")).toBe(true);
    expect(CONFLICT_MARKER.test("=======")).toBe(true);
    expect(CONFLICT_MARKER.test(">>>>>>> origin/main")).toBe(true);
    // A Markdown setext rule and a divider comment are not conflict markers.
    expect(CONFLICT_MARKER.test("======== not a marker")).toBe(false);
    expect(CONFLICT_MARKER.test("// ======= section")).toBe(false);
  });
});
