import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhApi } from "./gh.js";
import type { GatherInput, GitRun } from "./gather.js";
import { gather, renderOutputs } from "./gather.js";

const sampleDiff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line1
 line2
+added3
 line3
`;

const multibyteDiff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
 line1
+// … emoji: 🎉
 line2
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtemp();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const mkdtemp = (): string => {
  const dir = join(tmpdir(), `gather-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

interface RecordedCall {
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
}

const mkMockGhApi = (
  responses: ReadonlyArray<{
    readonly match: (args: readonly string[]) => boolean;
    readonly response: string | Error;
  }>,
): { readonly api: GhApi; readonly calls: () => readonly RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const api: GhApi = (args, stdin, env) => {
    calls.push({ args: [...args], stdin, env });
    for (const r of responses) {
      if (r.match(args)) {
        return r.response instanceof Error
          ? Promise.reject(r.response)
          : Promise.resolve(r.response);
      }
    }
    return Promise.reject(new Error(`Unexpected gh api call: ${args.join(" ")}`));
  };
  return { api, calls: () => calls };
};

const mkMockGit = (
  responses: ReadonlyArray<{
    readonly match: (args: readonly string[]) => boolean;
    readonly response: string | Error;
  }>,
): { readonly git: GitRun; readonly calls: () => readonly (readonly string[])[] } => {
  const calls: (readonly string[])[] = [];
  const git: GitRun = (args) => {
    calls.push([...args]);
    for (const r of responses) {
      if (r.match(args)) {
        return r.response instanceof Error
          ? Promise.reject(r.response)
          : Promise.resolve(r.response);
      }
    }
    return Promise.reject(new Error(`Unexpected git call: ${args.join(" ")}`));
  };
  return { git, calls: () => calls };
};

const mkInput = (overrides: Partial<GatherInput> = {}): GatherInput => ({
  repo: "owner/repo",
  headSha: "abc123",
  headBranch: "feature-branch",
  runId: "RUN1",
  conclusion: "success",
  botLogin: "github-actions[bot]",
  outDir: tmpDir,
  ...overrides,
});

const outFile = (name: string): string => readFileSync(join(tmpDir, name), "utf-8");
const hasOutFile = (name: string): boolean => existsSync(join(tmpDir, name));

const candidatesMatch = (a: readonly string[]): boolean =>
  a[0]?.startsWith("repos/owner/repo/commits/") ?? false;
const metaMatch =
  (pr: number) =>
  (a: readonly string[]): boolean =>
    a[0] === `repos/owner/repo/pulls/${String(pr)}` && a.includes("--jq");
const diffMatch =
  (pr: number) =>
  (a: readonly string[]): boolean =>
    a[0] === `repos/owner/repo/pulls/${String(pr)}` && a.includes("-H");
const commentsMatch =
  (pr: number) =>
  (a: readonly string[]): boolean =>
    a[0] === `repos/owner/repo/issues/${String(pr)}/comments` && a.includes("--paginate");
const jobsMatch = (a: readonly string[]): boolean =>
  a[0] === "repos/owner/repo/actions/runs/RUN1/jobs";
const logsMatch = (a: readonly string[]): boolean =>
  (a[0]?.startsWith("repos/owner/repo/actions/jobs/") ?? false) &&
  (a[0]?.endsWith("/logs") ?? false);

const mkMeta = (overrides: { changed_files?: number } = {}) =>
  JSON.stringify({
    changed_files: overrides.changed_files ?? 1,
    base_sha: "base",
    title: "T",
    body: "B",
  });

describe("gather — PR resolution", () => {
  it("resolves a single open PR and gathers its inputs", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta({ changed_files: 1 }) },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "[]" },
    ]);
    const { git, calls: gitCalls } = mkMockGit([]);

    const result = await gather(mkInput({}), api, git);

    expect(result).toEqual({
      kind: "gathered",
      pr: 42,
      conclusion: "success",
      diffSize: Buffer.byteLength(sampleDiff, "utf8"),
    });
    expect(outFile("pr.diff")).toBe(sampleDiff);
    expect(gitCalls()).toHaveLength(0);
    expect(
      calls().some((c) => c.args[0] === "repos/owner/repo/pulls/42" && c.args.includes("-H")),
    ).toBe(true);
  });

  it("disambiguates by head branch when multiple PRs share a commit", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: candidatesMatch,
        response:
          '{"number":42,"state":"open","headRef":"other"}\n{"number":99,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(99), response: mkMeta({ changed_files: 1 }) },
      { match: diffMatch(99), response: sampleDiff },
      { match: commentsMatch(99), response: "[]" },
    ]);

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    expect(result.kind).toBe("gathered");
    if (result.kind === "gathered") expect(result.pr).toBe(99);
    expect(calls().some((c) => c.args[0] === "repos/owner/repo/pulls/42")).toBe(false);
  });

  it("skips when no PR is found for the head SHA", async () => {
    const { api, calls } = mkMockGhApi([{ match: candidatesMatch, response: "\n" }]);

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    expect(result).toEqual({ kind: "skip" });
    expect(calls()).toHaveLength(1);
    expect(hasOutFile("pr.diff")).toBe(false);
  });

  it("skips when the resolved PR is not open", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"closed","headRef":"feature-branch"}\n',
      },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    expect(result).toEqual({ kind: "skip" });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("not open"));
    expect(calls()).toHaveLength(1);

    stderrSpy.mockRestore();
  });
});

describe("gather — diff resolution", () => {
  it("uses the API diff as-is when it is non-empty", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta({ changed_files: 1 }) },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "[]" },
    ]);
    const { git, calls: gitCalls } = mkMockGit([]);

    await gather(mkInput({}), api, git);

    expect(outFile("pr.diff")).toBe(sampleDiff);
    expect(gitCalls()).toHaveLength(0);
  });

  it("falls back to git diff when the API diff is empty and changed_files > 0", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta({ changed_files: 1 }) },
      { match: diffMatch(42), response: "" },
      { match: commentsMatch(42), response: "[]" },
    ]);
    const { git, calls: gitCalls } = mkMockGit([
      { match: (a) => a[0] === "fetch" && a[1] === "origin" && a[2] === "abc123", response: "" },
      {
        match: (a) => a[0] === "diff" && a[1] === "base" && a[2] === "abc123",
        response: "GIT DIFF TEXT",
      },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await gather(mkInput({}), api, git);

    expect(outFile("pr.diff")).toBe("GIT DIFF TEXT");
    expect(gitCalls()).toEqual([
      ["fetch", "origin", "abc123"],
      ["diff", "base", "abc123"],
    ]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("falling back to git diff"));
    expect(result.kind).toBe("gathered");
    if (result.kind === "gathered")
      expect(result.diffSize).toBe(Buffer.byteLength("GIT DIFF TEXT", "utf8"));

    stderrSpy.mockRestore();
  });

  it("falls back to git diff when the API diff fetch rejects", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta({ changed_files: 1 }) },
      { match: diffMatch(42), response: new Error("boom") },
      { match: commentsMatch(42), response: "[]" },
    ]);
    const { git } = mkMockGit([
      { match: (a) => a[0] === "fetch", response: "" },
      { match: (a) => a[0] === "diff", response: "GIT DIFF TEXT" },
    ]);

    await gather(mkInput({}), api, git);

    expect(outFile("pr.diff")).toBe("GIT DIFF TEXT");
  });

  it("does NOT fall back when the diff is empty but changed_files is 0", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta({ changed_files: 0 }) },
      { match: diffMatch(42), response: "" },
      { match: commentsMatch(42), response: "[]" },
    ]);
    const { git, calls: gitCalls } = mkMockGit([]);

    const result = await gather(mkInput({}), api, git);

    expect(outFile("pr.diff")).toBe("");
    expect(gitCalls()).toHaveLength(0);
    expect(result.kind).toBe("gathered");
    if (result.kind === "gathered") expect(result.diffSize).toBe(0);
  });

  it("rejects when the git fallback also fails", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta({ changed_files: 1 }) },
      { match: diffMatch(42), response: "" },
      { match: commentsMatch(42), response: "[]" },
    ]);
    const { git } = mkMockGit([
      { match: (a) => a[0] === "fetch", response: new Error("no network") },
    ]);

    await expect(gather(mkInput({}), api, git)).rejects.toThrow();
  });
});

describe("gather — prior review", () => {
  it("captures the last comment authored by the bot login", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      {
        match: commentsMatch(42),
        response: JSON.stringify([
          { id: 1, body: "first", user: { login: "someone" } },
          { id: 7, body: "latest bot", user: { login: "github-actions[bot]" } },
        ]),
      },
    ]);

    await gather(mkInput({}), api, mkMockGit([]).git);

    expect(JSON.parse(outFile("prior_review.json")) as unknown).toEqual({
      id: 7,
      body: "latest bot",
    });
  });

  it("writes literal null when there is no bot comment", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      {
        match: commentsMatch(42),
        response: JSON.stringify([{ id: 1, body: "x", user: { login: "human" } }]),
      },
    ]);

    await gather(mkInput({}), api, mkMockGit([]).git);

    expect(outFile("prior_review.json")).toBe("null");
  });

  it("degrades to null when the prior-review fetch fails", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: new Error("500") },
    ]);

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    expect(outFile("prior_review.json")).toBe("null");
    expect(result.kind).toBe("gathered");
  });

  it("honors a --bot-login override over the default", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      {
        match: commentsMatch(42),
        response: JSON.stringify([
          { id: 5, body: "mine", user: { login: "my-bot[bot]" } },
          { id: 6, body: "default", user: { login: "github-actions[bot]" } },
        ]),
      },
    ]);

    await gather(mkInput({ botLogin: "my-bot[bot]" }), api, mkMockGit([]).git);

    expect(JSON.parse(outFile("prior_review.json")) as unknown).toEqual({ id: 5, body: "mine" });
  });
});

describe("gather — failing-job logs", () => {
  it("downloads only the failing jobs' logs when conclusion is failure", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "[]" },
      {
        match: jobsMatch,
        response: JSON.stringify({
          jobs: [
            { id: 11, conclusion: "failure" },
            { id: 22, conclusion: "success" },
            { id: 33, conclusion: "failure" },
          ],
        }),
      },
      { match: logsMatch, response: "LOG for job" },
    ]);

    const result = await gather(mkInput({ conclusion: "failure" }), api, mkMockGit([]).git);

    expect(hasOutFile("job_11.log")).toBe(true);
    expect(hasOutFile("job_33.log")).toBe(true);
    expect(hasOutFile("job_22.log")).toBe(false);
    expect(result).toMatchObject({ kind: "gathered", conclusion: "failure" });
  });

  it("degrades on a per-job log download failure — warns, keeps the rest, still gathers", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "[]" },
      {
        match: jobsMatch,
        response: JSON.stringify({
          jobs: [
            { id: 11, conclusion: "failure" },
            { id: 33, conclusion: "failure" },
          ],
        }),
      },
      {
        match: (a) => a[0] === "repos/owner/repo/actions/jobs/11/logs",
        response: "LOG 11",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/actions/jobs/33/logs",
        response: new Error("404"),
      },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await gather(mkInput({ conclusion: "failure" }), api, mkMockGit([]).git);

    expect(hasOutFile("job_11.log")).toBe(true);
    expect(outFile("job_11.log")).toBe("LOG 11");
    expect(hasOutFile("job_33.log")).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed to download logs"));
    expect(result.kind).toBe("gathered");

    stderrSpy.mockRestore();
  });

  it("never calls the jobs endpoint when conclusion is success", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "[]" },
    ]);

    await gather(mkInput({ conclusion: "success" }), api, mkMockGit([]).git);

    expect(calls().some((c) => jobsMatch(c.args))).toBe(false);
    expect(hasOutFile("job_11.log")).toBe(false);
  });
});

describe("gather — pr_context.json", () => {
  it("preserves a null body", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: metaMatch(42),
        response: JSON.stringify({
          changed_files: 1,
          base_sha: "base",
          title: "My PR",
          body: null,
        }),
      },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "[]" },
    ]);

    await gather(mkInput({}), api, mkMockGit([]).git);

    expect(JSON.parse(outFile("pr_context.json")) as unknown).toEqual({
      title: "My PR",
      body: null,
    });
  });
});

describe("renderOutputs", () => {
  it("renders skip=true for the skip case", () => {
    expect(renderOutputs({ kind: "skip" })).toBe("skip=true\n");
  });

  it("renders pr, conclusion, diff_size for the gathered case", () => {
    expect(renderOutputs({ kind: "gathered", pr: 42, conclusion: "success", diffSize: 1234 })).toBe(
      "pr=42\nconclusion=success\ndiff_size=1234\n",
    );
  });
});

describe("gather — diff_size byte accuracy", () => {
  it("counts bytes, not UTF-16 code units", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: multibyteDiff },
      { match: commentsMatch(42), response: "[]" },
    ]);

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    expect(result.kind).toBe("gathered");
    if (result.kind === "gathered") {
      expect(result.diffSize).toBe(Buffer.byteLength(multibyteDiff, "utf8"));
      expect(result.diffSize).not.toBe(multibyteDiff.length);
    }
  });
});
