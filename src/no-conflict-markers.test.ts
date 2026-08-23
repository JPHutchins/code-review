import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// A tracked file's content, or null when the gate could not obtain it — which is a FAILURE, not a
// pass. Exported shape rather than an inline closure so the fallback can be exercised directly: under
// a full CI checkout every tracked path reads from disk, so that branch would otherwise be dead code
// in the only place it runs.
export const readTracked = (
  path: string,
  fromDisk: (p: string) => string,
  fromIndex: (p: string) => string,
): string | null => {
  try {
    return fromDisk(path);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // A path that resolves to a directory has no blob to scan — a submodule's gitlink, or a tracked
    // file a directory now shadows. Absent from the worktree is different: the index still holds the
    // content, and a staged conflicted file's markers live exactly there, so read it rather than
    // clear it unread. Anything else is a file this gate could not open.
    if (code === "EISDIR") return "";
    if (code !== "ENOENT") return null;
    try {
      return fromIndex(path);
    } catch {
      return null;
    }
  }
};

const diskReader = (path: string): string => readFileSync(`${repoRoot}/${path}`, "utf-8");

// `:./path` is git's relative-path form. Bare `:path` would parse a name like `1:notes.md` as an
// index-stage spec and read a different file. maxBuffer because a tracked blob can exceed Node's 1MiB
// default — this repo has a 2.4MB fixture — and ENOBUFS would fail the gate rather than scan it.
export const indexReaderIn =
  (cwd: string) =>
  (path: string): string =>
    execFileSync("git", ["show", `:./${path}`], {
      cwd,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });

const indexReader = indexReaderIn(repoRoot);

const firstMarkerLine = (content: string): number =>
  content.split("\n").findIndex((line) => CONFLICT_MARKER.test(line));

describe("the working tree", () => {
  it("has no unresolved conflict markers in any tracked file", () => {
    const results = trackedFiles().map((path) => ({
      path,
      content: readTracked(path, diskReader, indexReader),
    }));
    const unreadable = results.filter((r) => r.content === null).map((r) => r.path);
    const offenders = results.flatMap(({ path, content }) =>
      content === null || firstMarkerLine(content) === -1
        ? []
        : [`${path}:${String(firstMarkerLine(content) + 1)}`],
    );

    expect(offenders).toEqual([]);
    // A file this gate could not open is not a file it cleared.
    expect(unreadable).toEqual([]);
  });

  it("reads a meaningful number of tracked files", () => {
    expect(trackedFiles().length).toBeGreaterThan(20);
  });

  // Under a full CI checkout every tracked path reads from disk, so the fallback never runs there.
  // These drive it directly, with the errors node actually throws.
  it("falls back to the index when the worktree lacks a tracked file", () => {
    const enoent = (): never => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    expect(readTracked("gone.md", enoent, () => "<<<<<<< HEAD\nstaged\n")).toContain("<<<<<<<");
    // The index cannot produce it either — unreadable, which the gate must FAIL on, not clear.
    expect(
      readTracked("gone.md", enoent, () => {
        throw new Error("fatal: path does not exist");
      }),
    ).toBeNull();
  });

  it("treats a directory as empty and any other error as unreadable", () => {
    const throwing = (code: string) => (): never => {
      throw Object.assign(new Error(code), { code });
    };
    const unused = (): never => {
      throw new Error("index must not be consulted");
    };

    expect(readTracked("submodule", throwing("EISDIR"), unused)).toBe("");
    expect(readTracked("locked.md", throwing("EACCES"), unused)).toBeNull();
  });

  it("reads a present file from disk without touching the index", () => {
    const unused = (): never => {
      throw new Error("index must not be consulted");
    };

    expect(readTracked("here.md", () => "plain content", unused)).toBe("plain content");
  });

  // The `:./` prefix is the whole point of this reader and the injected-reader tests cannot see it,
  // so this one drives real git against a real index — the case that motivated it is a filename git
  // would otherwise parse as an index-stage spec.
  it("reads the named file from the index, not a same-suffix stage spec", () => {
    const repo = mkdtempSync(join(tmpdir(), "conflict-gate-"));
    const git = (...args: readonly string[]): void => {
      execFileSync("git", [...args], { cwd: repo, encoding: "utf-8" });
    };
    try {
      git("init", "-q", ".");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      // `1:notes.md` and `notes.md`: `git show :1:notes.md` reads the SECOND as stage 1.
      writeFileSync(join(repo, "1:notes.md"), "<<<<<<< HEAD\nthe staged one\n");
      writeFileSync(join(repo, "notes.md"), "a different file\n");
      git("add", "-A");
      git("commit", "-qm", "x");
      rmSync(join(repo, "1:notes.md"));

      expect(indexReaderIn(repo)("1:notes.md")).toContain("the staged one");
      expect(indexReaderIn(repo)("1:notes.md")).not.toContain("a different file");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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
