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
    const read = (path: string): string | null => {
      try {
        return readFileSync(`${repoRoot}/${path}`, "utf-8");
      } catch (err) {
        const code = (err as { code?: string }).code;
        // A directory (a submodule's gitlink) has no content to scan. A path missing from the
        // worktree does — the index still holds its blob, and a staged conflicted file's markers live
        // exactly there — so fall back to the index rather than clearing it unread. Anything else is
        // a file the gate could not open, which is the signal.
        if (code === "EISDIR") return "";
        if (code === "ENOENT") {
          try {
            return execFileSync("git", ["show", `:${path}`], { cwd: repoRoot, encoding: "utf-8" });
          } catch {
            return null;
          }
        }
        return null;
      }
    };
    const results = trackedFiles().map((path) => ({ path, content: read(path) }));
    const unreadable = results.filter((r) => r.content === null).map((r) => r.path);
    const offenders = results.flatMap(({ path, content }) => {
      if (content === null) return [];
      const hit = content.split("\n").findIndex((line) => CONFLICT_MARKER.test(line));
      return hit === -1 ? [] : [`${path}:${String(hit + 1)}`];
    });

    expect(offenders).toEqual([]);
    // A file this gate could not open is not a file it cleared.
    expect(unreadable).toEqual([]);
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
