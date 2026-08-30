import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhApi } from "./gh.js";
import type { GatherInput, GitRun } from "./gather.js";
import { gather, renderOutputs } from "./gather.js";
import { AGENTS_STOP_DIRECTIVE } from "./surface.js";
import { runCli } from "./test-util.js";
import { priorContextPath } from "./budget.js";

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
    // The compare-commits fetch (default...head) runs for every PR now; default it to an empty
    // NDJSON stream (no commits) unless a test mocks it explicitly above.
    if ((args[0]?.startsWith("repos/owner/repo/compare/") ?? false) && args.includes("--jq")) {
      return Promise.resolve("");
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
  defaultBranch: "main",
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
const openPrsMatch = (a: readonly string[]): boolean =>
  a[0]?.startsWith("repos/owner/repo/pulls?state=open") ?? false;
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
const reviewCommentsMatch =
  (pr: number) =>
  (a: readonly string[]): boolean =>
    a[0] === `repos/owner/repo/pulls/${String(pr)}/comments` && a.includes("--paginate");
const reviewsMatch =
  (pr: number) =>
  (a: readonly string[]): boolean =>
    a[0] === `repos/owner/repo/pulls/${String(pr)}/reviews` && a.includes("--paginate");
const compareDiffMatch = (a: readonly string[]): boolean =>
  (a[0]?.startsWith("repos/owner/repo/compare/main...") ?? false) && a.includes("-H");
const compareCommitsMatch = (a: readonly string[]): boolean =>
  (a[0]?.startsWith("repos/owner/repo/compare/main...") ?? false) && a.includes("--jq");
const jobsMatch = (a: readonly string[]): boolean =>
  a[0] === "repos/owner/repo/actions/runs/RUN1/jobs" && a.includes("--paginate");
// What `gh api --paginate --jq '.jobs[] | …'` actually emits: one job per line, across all pages.
const jobRows = (...jobs: ReadonlyArray<{ id: number; conclusion: string | null }>): string =>
  jobs.map((j) => JSON.stringify(j)).join("\n") + "\n";
const logsMatch = (a: readonly string[]): boolean =>
  (a[0]?.startsWith("repos/owner/repo/actions/jobs/") ?? false) &&
  (a[0]?.endsWith("/logs") ?? false);

const mkMeta = (overrides: { changed_files?: number; base_ref?: string } = {}) =>
  JSON.stringify({
    changed_files: overrides.changed_files ?? 1,
    base_sha: "base",
    base_ref: overrides.base_ref ?? "main",
    title: "T",
    body: "B",
  });

// gather fetches issue comments with `--paginate --jq`, which streams NDJSON (one object per line),
// not a JSON array — mirror that here.
const ndjson = (rows: readonly unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

describe("gather — PR resolution", () => {
  it("resolves a single open PR and gathers its inputs", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta({ changed_files: 1 }) },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "" },
    ]);
    const { git, calls: gitCalls } = mkMockGit([]);

    const result = await gather(mkInput({}), api, git);

    expect(result).toEqual({
      kind: "gathered",
      pr: 42,
      conclusion: "success",
      diffSize: Buffer.byteLength(sampleDiff, "utf8"),
      stacked: false,
      baseSha: "base",
      // A success-route run never looks for failing-job logs.
      stagedJobLogs: 0,
      failingJobs: 0,
    });
    expect(outFile("pr.diff")).toBe(sampleDiff);
    // A non-stacked PR reuses pr.diff as the full (triage) diff — no separate compare fetch.
    expect(outFile("full.diff")).toBe(sampleDiff);
    expect(gitCalls()).toHaveLength(0);
    expect(
      calls().some((c) => c.args[0] === "repos/owner/repo/pulls/42" && c.args.includes("-H")),
    ).toBe(true);
  });

  it("resolves a fork PR via the open-PR fallback when the commit endpoint is empty", async () => {
    const { api } = mkMockGhApi([
      { match: candidatesMatch, response: "\n" },
      {
        match: openPrsMatch,
        response:
          '{"number":7,"state":"open","headRef":"fork-branch","headSha":"abc123"}\n{"number":8,"state":"open","headRef":"other","headSha":"zzz999"}\n',
      },
      { match: metaMatch(7), response: mkMeta({ changed_files: 1 }) },
      { match: diffMatch(7), response: sampleDiff },
      { match: commentsMatch(7), response: "" },
    ]);

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    expect(result.kind).toBe("gathered");
    if (result.kind === "gathered") expect(result.pr).toBe(7);
    expect(outFile("pr.diff")).toBe(sampleDiff);
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
      { match: commentsMatch(99), response: "" },
    ]);

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    expect(result.kind).toBe("gathered");
    if (result.kind === "gathered") expect(result.pr).toBe(99);
    expect(calls().some((c) => c.args[0] === "repos/owner/repo/pulls/42")).toBe(false);
  });

  it("skips when neither the commit endpoint nor any open PR matches the head SHA", async () => {
    const { api, calls } = mkMockGhApi([
      { match: candidatesMatch, response: "\n" },
      { match: openPrsMatch, response: "\n" },
    ]);

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    expect(result).toEqual({ kind: "skip" });
    expect(calls()).toHaveLength(2);
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
      { match: commentsMatch(42), response: "" },
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
      { match: commentsMatch(42), response: "" },
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
      { match: commentsMatch(42), response: "" },
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
      { match: commentsMatch(42), response: "" },
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
      { match: commentsMatch(42), response: "" },
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
        response: ndjson([
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

  // The prior DOCUMENT is resolved here, where the token is — the agentic-review step has none by
  // design (issue #217). It is gated on the prior being a full review, because seed-draft discards a
  // mechanic pass's findings anyway: fetching there spends a download and an unzip on a document
  // nothing reads.
  it("stages no prior findings when the prior sticky was a mechanic pass", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      {
        match: commentsMatch(42),
        response: ndjson([
          {
            id: 7,
            // A link-form marker: resolving it would need a fetch, so a fetch attempt here would fail
            // the mock's "unexpected call" guard — which is exactly the assertion.
            body: "<!-- code-review -->\n<!-- reviewed-route: mechanic -->\n<!-- code-review:findings-json https://api.github.com/repos/o/r/actions/artifacts/1/zip -->",
            user: { login: "github-actions[bot]" },
          },
        ]),
      },
    ]);

    // The reader must not be consulted at all — a fetch that merely FAILS also stages null, so
    // observing the absence of the call is the only assertion that separates the two.
    const consulted: string[] = [];
    await gather(mkInput({}), api, mkMockGit([]).git, (url) => {
      consulted.push(url);
      return Promise.resolve(null);
    });

    expect(consulted).toEqual([]);
    expect(outFile("prior_findings.json")).toBe("null");
  });

  // The other half of the route gate, and the routine case: a CI-fix round following a completed
  // review. The workflow's mechanic branch invokes seed-draft with no --prior-findings at all, so
  // resolving here would download and unzip an artifact nothing is ever handed.
  it("stages no prior findings when THIS run is a mechanic pass", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: jobsMatch, response: jobRows({ id: 11, conclusion: "success" }) },
      {
        match: commentsMatch(42),
        response: ndjson([
          {
            id: 7,
            body: "<!-- code-review -->\n<!-- reviewed-route: full review -->\n<!-- code-review:findings-json https://api.github.com/repos/o/r/actions/artifacts/9/zip -->",
            user: { login: "github-actions[bot]" },
          },
        ]),
      },
    ]);

    const consulted: string[] = [];
    await gather(mkInput({ conclusion: "failure" }), api, mkMockGit([]).git, (url) => {
      consulted.push(url);
      return Promise.resolve("{}");
    });

    expect(consulted).toEqual([]);
    expect(outFile("prior_findings.json")).toBe("null");
  });

  it("resolves and stages the prior findings when the prior sticky WAS a full review", async () => {
    const doc = { schema_version: "0.9.0", summary: "prior", verdict: "comment", findings: [] };
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      {
        match: commentsMatch(42),
        response: ndjson([
          {
            id: 7,
            body: "<!-- code-review -->\n<!-- reviewed-route: full review -->\n<!-- code-review:findings-json https://api.github.com/repos/o/r/actions/artifacts/9/zip -->",
            user: { login: "github-actions[bot]" },
          },
        ]),
      },
    ]);

    const consulted: string[] = [];
    await gather(mkInput({}), api, mkMockGit([]).git, (url) => {
      consulted.push(url);
      return Promise.resolve(JSON.stringify(doc));
    });

    expect(consulted).toEqual(["https://api.github.com/repos/o/r/actions/artifacts/9/zip"]);
    expect(JSON.parse(outFile("prior_findings.json")) as unknown).toEqual(doc);
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
        response: ndjson([{ id: 1, body: "x", user: { login: "human" } }]),
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
        response: ndjson([
          { id: 5, body: "mine", user: { login: "my-bot[bot]" } },
          { id: 6, body: "default", user: { login: "github-actions[bot]" } },
        ]),
      },
    ]);

    await gather(mkInput({ botLogin: "my-bot[bot]" }), api, mkMockGit([]).git);

    expect(JSON.parse(outFile("prior_review.json")) as unknown).toEqual({ id: 5, body: "mine" });
  });
});

interface Conversation {
  readonly issue_comments: readonly { readonly author: string; readonly body: string }[];
  readonly review_comments: readonly {
    readonly author: string;
    readonly path: string | null;
    readonly line: number | null;
    readonly body: string;
  }[];
  readonly reviews: readonly {
    readonly author: string;
    readonly state: string | null;
    readonly body: string;
  }[];
}

describe("gather — PR conversation", () => {
  const withDiscussion = (opts: {
    issue?: string | Error;
    reviewComments?: string | Error;
    reviews?: string | Error;
  }) =>
    mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: opts.issue ?? "" },
      { match: reviewCommentsMatch(42), response: opts.reviewComments ?? "" },
      { match: reviewsMatch(42), response: opts.reviews ?? "" },
    ]);

  const conversation = (): Conversation =>
    JSON.parse(outFile("pr_conversation.json")) as Conversation;

  it("stages issue comments, inline review comments, and reviews — excluding the review bot", async () => {
    const { api } = withDiscussion({
      issue: ndjson([
        {
          id: 1,
          body: "That's a false positive; here's the file list.",
          user: { login: "alice" },
          created_at: "2026-07-01T00:00:00Z",
          author_association: "OWNER",
        },
        {
          id: 2,
          body: "prior review sticky",
          user: { login: "github-actions[bot]" },
          created_at: "2026-07-01T00:05:00Z",
          author_association: "NONE",
        },
      ]),
      reviewComments: ndjson([
        {
          body: "Intentional — see the docstring I added.",
          user: { login: "alice" },
          created_at: "2026-07-02T00:00:00Z",
          author_association: "OWNER",
          path: "src/foo.ts",
          line: 42,
        },
        {
          body: "🔴 major finding",
          user: { login: "github-actions[bot]" },
          created_at: "2026-07-01T23:00:00Z",
          author_association: "NONE",
          path: "src/foo.ts",
          line: 42,
        },
      ]),
      reviews: ndjson([
        {
          body: "Looks good once the null check lands.",
          user: { login: "carol" },
          submitted_at: "2026-07-02T01:00:00Z",
          author_association: "MEMBER",
          state: "COMMENTED",
        },
        {
          body: "🤖 see summary comment",
          user: { login: "github-actions[bot]" },
          submitted_at: "2026-07-01T23:30:00Z",
          author_association: "NONE",
          state: "COMMENTED",
        },
      ]),
    });

    await gather(mkInput({}), api, mkMockGit([]).git);

    expect(conversation()).toEqual({
      issue_comments: [
        {
          author: "alice",
          author_association: "OWNER",
          created_at: "2026-07-01T00:00:00Z",
          body: "That's a false positive; here's the file list.",
        },
      ],
      review_comments: [
        {
          author: "alice",
          author_association: "OWNER",
          created_at: "2026-07-02T00:00:00Z",
          path: "src/foo.ts",
          line: 42,
          body: "Intentional — see the docstring I added.",
        },
      ],
      reviews: [
        {
          author: "carol",
          author_association: "MEMBER",
          submitted_at: "2026-07-02T01:00:00Z",
          state: "COMMENTED",
          body: "Looks good once the null check lands.",
        },
      ],
    });
  });

  it("defaults optional fields to null and skips empty/whitespace bodies", async () => {
    const { api } = withDiscussion({
      issue: ndjson([
        { id: 1, body: "   ", user: { login: "alice" } },
        { id: 2, body: null, user: { login: "alice" } },
        { id: 3, body: "real disposition", user: { login: "alice" } },
      ]),
      reviewComments: ndjson([{ body: "anchored reply", user: { login: "bob" } }]),
    });

    await gather(mkInput({}), api, mkMockGit([]).git);

    const c = conversation();
    expect(c.issue_comments).toEqual([
      { author: "alice", author_association: null, created_at: null, body: "real disposition" },
    ]);
    expect(c.review_comments).toEqual([
      {
        author: "bob",
        author_association: null,
        created_at: null,
        path: null,
        line: null,
        body: "anchored reply",
      },
    ]);
    expect(c.reviews).toEqual([]);
  });

  it("writes empty arrays for every channel when there is no discussion", async () => {
    const { api } = withDiscussion({});

    await gather(mkInput({}), api, mkMockGit([]).git);

    expect(conversation()).toEqual({ issue_comments: [], review_comments: [], reviews: [] });
  });

  it("degrades each channel independently (and prior review to null) when its fetch fails", async () => {
    const { api } = withDiscussion({
      issue: new Error("500"),
      reviewComments: ndjson([{ body: "still here", user: { login: "alice" } }]),
      reviews: new Error("500"),
    });

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    const c = conversation();
    expect(c.issue_comments).toEqual([]);
    expect(c.reviews).toEqual([]);
    expect(c.review_comments.map((r) => r.body)).toEqual(["still here"]);
    expect(outFile("prior_review.json")).toBe("null");
    expect(result.kind).toBe("gathered");
  });

  it("caps a long thread at the most recent 50 comments", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      body: `comment ${String(i + 1)}`,
      user: { login: "alice" },
    }));
    const { api } = withDiscussion({ issue: ndjson(many) });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await gather(mkInput({}), api, mkMockGit([]).git);

    const staged = conversation().issue_comments;
    expect(staged).toHaveLength(50);
    expect(staged[0]?.body).toBe("comment 11");
    expect(staged[49]?.body).toBe("comment 60");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("most recent 50"));

    stderrSpy.mockRestore();
  });

  it("clips a very long comment body", async () => {
    const { api } = withDiscussion({
      issue: ndjson([{ id: 1, body: "x".repeat(5000), user: { login: "alice" } }]),
    });

    await gather(mkInput({}), api, mkMockGit([]).git);

    const body = conversation().issue_comments[0]?.body ?? "";
    expect(body.length).toBeLessThan(5000);
    expect(body).toContain("[truncated]");
  });

  it("clips without splitting a surrogate pair at the boundary", async () => {
    // A 😀 (U+1F600, a surrogate pair) straddles the 4000-char cut: the high surrogate is the last
    // kept unit. The clip must drop it, not leave a lone half.
    const { api } = withDiscussion({
      issue: ndjson([
        { id: 1, body: `${"x".repeat(3999)}😀${"y".repeat(50)}`, user: { login: "a" } },
      ]),
    });

    await gather(mkInput({}), api, mkMockGit([]).git);

    const body = conversation().issue_comments[0]?.body ?? "";
    expect(body).toContain("[truncated]");
    expect(/[\uD800-\uDBFF]/.test(body)).toBe(false);
    expect(body.startsWith("x".repeat(3999))).toBe(true);
  });

  it("drops only the malformed rows (e.g. a deleted account's null login) without losing the valid ones", async () => {
    const { api } = withDiscussion({
      issue: ndjson([
        { id: 1, body: "before the ghost", user: { login: "alice" } },
        { id: 2, body: "from a deleted account", user: { login: null } },
        { body: "no id and no user at all" },
        { id: 3, body: "after the ghost", user: { login: "bob" } },
      ]),
    });

    await gather(mkInput({}), api, mkMockGit([]).git);

    expect(conversation().issue_comments.map((c) => c.body)).toEqual([
      "before the ghost",
      "after the ghost",
    ]);
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
      { match: commentsMatch(42), response: "" },
      {
        match: jobsMatch,
        response: jobRows(
          { id: 11, conclusion: "failure" },
          { id: 22, conclusion: "success" },
          { id: 33, conclusion: "failure" },
        ),
      },
      { match: logsMatch, response: "LOG for job" },
    ]);

    const result = await gather(mkInput({ conclusion: "failure" }), api, mkMockGit([]).git);

    expect(hasOutFile("job_11.log")).toBe(true);
    expect(hasOutFile("job_33.log")).toBe(true);
    expect(hasOutFile("job_22.log")).toBe(false);
    expect(result).toMatchObject({ kind: "gathered", conclusion: "failure" });
  });

  // Uncapped, a matrix that fails in hundreds of jobs downloads hundreds of logs one at a time into
  // the step that precedes the fast-fix route — the route that exists to be fast, in a step the
  // workflow does not wrap in a timeout.
  it("caps the staged logs and says how many it left behind", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "" },
      {
        match: jobsMatch,
        response: jobRows(
          ...Array.from({ length: 25 }, (_, i) => ({ id: i + 1, conclusion: "failure" })),
        ),
      },
      { match: logsMatch, response: "LOG" },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await gather(mkInput({ conclusion: "failure" }), api, mkMockGit([]).git);

    expect(result).toMatchObject({ kind: "gathered", stagedJobLogs: 20, failingJobs: 25 });
    expect(hasOutFile("job_20.log")).toBe(true);
    expect(hasOutFile("job_21.log")).toBe(false);
    expect(calls().filter((c) => logsMatch(c.args))).toHaveLength(20);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("::warning::25 failing job(s)"));

    stderrSpy.mockRestore();
  });

  it("degrades on a per-job log download failure — warns, keeps the rest, still gathers", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "" },
      {
        match: jobsMatch,
        response: jobRows({ id: 11, conclusion: "failure" }, { id: 33, conclusion: "failure" }),
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

  // gh refuses raw responses containing terminal escapes unless told to — a refusal that silently
  // emptied the fast-fix route's staged logs. The download must ask for the escapes (they are
  // written to a FILE, never echoed) and stage the colored log verbatim.
  it("downloads each job log with --allow-escape-sequences, staging ANSI-colored logs verbatim", async () => {
    const colored = "2026-01-01T00:00:00.000Z [31mfailing test[0m\n";
    const { api, calls } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "" },
      { match: jobsMatch, response: jobRows({ id: 11, conclusion: "failure" }) },
      { match: logsMatch, response: colored },
    ]);

    const result = await gather(mkInput({ conclusion: "failure" }), api, mkMockGit([]).git);

    expect(result).toMatchObject({ kind: "gathered", stagedJobLogs: 1 });
    expect(outFile("job_11.log")).toBe(colored);
    const logCalls = calls().filter((c) => logsMatch(c.args));
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]!.args).toContain("--allow-escape-sequences");
  });

  // ghs that predate the escape refusal also predate the flag — the plain call is the fallback.
  it("falls back to the plain call when the gh predates --allow-escape-sequences", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "" },
      { match: jobsMatch, response: jobRows({ id: 11, conclusion: "failure" }) },
      {
        match: (a) => logsMatch(a) && a.includes("--allow-escape-sequences"),
        response: new Error("unknown flag: --allow-escape-sequences"),
      },
      { match: logsMatch, response: "LOG 11" },
    ]);

    const result = await gather(mkInput({ conclusion: "failure" }), api, mkMockGit([]).git);

    expect(result).toMatchObject({ kind: "gathered", stagedJobLogs: 1 });
    expect(outFile("job_11.log")).toBe("LOG 11");
    expect(calls().filter((c) => logsMatch(c.args))).toHaveLength(2);
  });

  // The fast-fix route exists to read the failing logs; with none staged it reasons from the diff
  // alone, which is the thing it replaces. That has to be said out loud, not left for a reader to
  // notice in the agent's prose (issue #154).
  // One failing job whose log download either works or doesn't — the only axis these two care about.
  const oneFailingJob = (log: string | Error) => [
    {
      match: candidatesMatch,
      response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
    },
    { match: metaMatch(42), response: mkMeta() },
    { match: diffMatch(42), response: sampleDiff },
    { match: commentsMatch(42), response: "" },
    { match: jobsMatch, response: jobRows({ id: 11, conclusion: "failure" }) },
    {
      match: (a: readonly string[]) => a[0] === "repos/owner/repo/actions/jobs/11/logs",
      response: log,
    },
  ];

  it("counts the logs it staged, and says nothing extra when it got them", async () => {
    const { api } = mkMockGhApi(oneFailingJob("LOG 11"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await gather(mkInput({ conclusion: "failure" }), api, mkMockGit([]).git);

    expect(result).toMatchObject({ kind: "gathered", stagedJobLogs: 1 });
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining("::warning::"));

    stderrSpy.mockRestore();
  });

  // On STDERR, not stdout: this command's stdout is the step's $GITHUB_OUTPUT, so an annotation
  // written there would never render AND would corrupt the outputs — failing the step in exactly the
  // case this warning exists for.
  it("annotates a ::warning:: on stderr when a failing run stages no logs at all", async () => {
    const { api } = mkMockGhApi(oneFailingJob(new Error("403")));
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await gather(mkInput({ conclusion: "failure" }), api, mkMockGit([]).git);

    expect(result).toMatchObject({ kind: "gathered", stagedJobLogs: 0 });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("::warning::No failing-job logs could be staged"),
    );
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining("::warning::"));

    stdoutSpy.mockRestore();
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
      { match: commentsMatch(42), response: "" },
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
          base_ref: "main",
          title: "My PR",
          body: null,
        }),
      },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "" },
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

  it("renders pr, conclusion, diff_size, stacked, base_sha, staged_job_logs, failing_jobs for the gathered case", () => {
    expect(
      renderOutputs({
        kind: "gathered",
        pr: 42,
        conclusion: "success",
        diffSize: 1234,
        stacked: false,
        baseSha: "abc1234",
        stagedJobLogs: 0,
        failingJobs: 0,
      }),
    ).toBe(
      "pr=42\nconclusion=success\ndiff_size=1234\nstacked=false\nbase_sha=abc1234\nstaged_job_logs=0\nfailing_jobs=0\n",
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
      { match: commentsMatch(42), response: "" },
    ]);

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    expect(result.kind).toBe("gathered");
    if (result.kind === "gathered") {
      expect(result.diffSize).toBe(Buffer.byteLength(multibyteDiff, "utf8"));
      expect(result.diffSize).not.toBe(multibyteDiff.length);
    }
  });
});

describe("gather — stacked PR (base is not the default branch)", () => {
  const stackFullDiff = `diff --git a/base.ts b/base.ts
index 111..222 100644
--- a/base.ts
+++ b/base.ts
@@ -1 +1,2 @@
 base
+from the base PR
`;

  it("keeps pr.diff as the review scope and fetches default...head as the full triage/checkout diff", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta({ base_ref: "feature-base" }) },
      { match: diffMatch(42), response: sampleDiff },
      { match: compareDiffMatch, response: stackFullDiff },
      {
        match: compareCommitsMatch,
        response: ndjson([
          { sha: "c1", message: "base PR commit", author: "Dev", email: "dev@example.com" },
        ]),
      },
      { match: commentsMatch(42), response: "" },
    ]);

    const result = await gather(mkInput({}), api, mkMockGit([]).git);

    expect(result.kind).toBe("gathered");
    if (result.kind === "gathered") expect(result.stacked).toBe(true);
    // The review scope is the PR's own diff; triage/checkout see the whole default...head surface,
    // and its commit messages are scanned too.
    expect(outFile("pr.diff")).toBe(sampleDiff);
    expect(outFile("full.diff")).toBe(stackFullDiff);
    const commits = JSON.parse(outFile("commits.json")) as { message: string }[];
    expect(commits).toHaveLength(1);
    expect(commits[0]!.message).toBe("base PR commit");
  });
});

describe("gather — commit-message triage surface", () => {
  it("writes commits.json from the default...head compare commits (the git-log surface a checkout exposes)", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      {
        match: compareCommitsMatch,
        response: ndjson([
          { sha: "c1", message: "feat: the thing", author: "Dev", email: "dev@example.com" },
          { sha: "c2", message: "fix: the bug", author: "Dev", email: "dev@example.com" },
        ]),
      },
      { match: commentsMatch(42), response: "" },
    ]);

    await gather(mkInput({}), api, mkMockGit([]).git);

    const commits = JSON.parse(outFile("commits.json")) as { message: string }[];
    expect(commits).toHaveLength(2);
    expect(commits[0]!.message).toBe("feat: the thing");
    expect(commits[1]!.message).toBe("fix: the bug");
  });

  it("fails closed when the commit fetch errors — never a silent empty scan", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: compareCommitsMatch, response: new Error("gh: compare commits 502") },
      { match: commentsMatch(42), response: "" },
    ]);

    await expect(gather(mkInput({}), api, mkMockGit([]).git)).rejects.toThrow(/502/);
  });
});

describe("gather — answered-findings registry (issue #151)", () => {
  const withThreadRows = (rows: string) =>
    mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "" },
      { match: reviewCommentsMatch(42), response: rows },
      { match: reviewsMatch(42), response: "" },
    ]);

  const answered = (): readonly unknown[] => JSON.parse(outFile("answered.json")) as unknown[];

  it("stages the answered registry: the prior bot inline finding whose thread a human reply answered", async () => {
    const botBody = `${AGENTS_STOP_DIRECTIVE}\n<!-- code-review:findings-json;base64 ${Buffer.from(
      JSON.stringify({
        schema_version: "0.6.0",
        findings: [
          {
            path: "src/foo.ts",
            start_line: 42,
            end_line: 42,
            severity: "minor",
            title: "The same claim",
            description: "d",
            reasoning: "The same reasoning.",
            confidence: 0.8,
            code: "recurring-a",
          },
        ],
      }),
      "utf-8",
    ).toString("base64")} -->`;
    const { api } = withThreadRows(
      ndjson([
        {
          id: 101,
          in_reply_to_id: null,
          user_login: "github-actions[bot]",
          user_type: "Bot",
          body: botBody,
          html_url: "https://github.com/owner/repo/pull/42#discussion_r101",
          path: "src/foo.ts",
          line: 42,
          created_at: "2026-07-01T00:00:00Z",
        },
        {
          id: 102,
          in_reply_to_id: 101,
          user_login: "alice",
          user_type: "User",
          body: "Measured: the claim does not hold.",
          html_url: "https://github.com/owner/repo/pull/42#discussion_r102",
          path: "src/foo.ts",
          line: 42,
          created_at: "2026-07-01T01:00:00Z",
        },
      ]),
    );
    await gather(mkInput({}), api, mkMockGit([]).git);
    expect(answered()).toEqual([
      {
        code: "recurring-a",
        title: "The same claim",
        description: "d",
        reasoning: "The same reasoning.",
        severity: "minor",
        path: "src/foo.ts",
        patch: null,
        replied_at: "2026-07-01T01:00:00Z",
        reply_id: 102,
        thread_url: "https://github.com/owner/repo/pull/42#discussion_r101",
        reply_url: "https://github.com/owner/repo/pull/42#discussion_r102",
        reply_author: "alice",
        reply_excerpt: "Measured: the claim does not hold.",
      },
    ]);
  });

  it("serves BOTH consumers from the JQ-shaped rows — the conversation's review_comments survive the shared projection (issue #151 review r1)", async () => {
    // The mocks bypass jq, so a fixture in the API shape cannot prove the projection satisfies the
    // consumers. Feed the rows exactly as THREAD_COMMENT_JQ emits them (flat user_login/user_type +
    // nested user + author_association): the conversation codec must still decode them (with
    // author_association intact — the review prompt weighs claims by it) AND the registry must.
    const botBody = `${AGENTS_STOP_DIRECTIVE}\n<!-- code-review:findings-json;base64 ${Buffer.from(
      JSON.stringify({
        schema_version: "0.6.0",
        findings: [
          {
            path: "src/foo.ts",
            start_line: 42,
            end_line: 42,
            severity: "minor",
            title: "The same claim",
            description: "d",
            reasoning: "The same reasoning.",
            confidence: 0.8,
            code: "recurring-a",
          },
        ],
      }),
      "utf-8",
    ).toString("base64")} -->`;
    const { api } = withThreadRows(
      ndjson([
        {
          id: 101,
          in_reply_to_id: null,
          user: { login: "github-actions[bot]" },
          user_login: "github-actions[bot]",
          user_type: "Bot",
          body: botBody,
          html_url: "https://github.com/owner/repo/pull/42#discussion_r101",
          path: "src/foo.ts",
          line: 42,
          created_at: "2026-07-01T00:00:00Z",
          author_association: "NONE",
        },
        {
          id: 102,
          in_reply_to_id: 101,
          user: { login: "alice" },
          user_login: "alice",
          user_type: "User",
          body: "Measured: the claim does not hold.",
          html_url: "https://github.com/owner/repo/pull/42#discussion_r102",
          path: "src/foo.ts",
          line: 42,
          created_at: "2026-07-01T01:00:00Z",
          author_association: "OWNER",
        },
      ]),
    );
    await gather(mkInput({}), api, mkMockGit([]).git);
    const conversation = JSON.parse(outFile("pr_conversation.json")) as {
      review_comments: readonly {
        readonly author: string;
        readonly author_association: string | null;
        readonly body: string;
      }[];
    };
    expect(conversation.review_comments).toHaveLength(1);
    expect(conversation.review_comments[0]).toMatchObject({
      author: "alice",
      author_association: "OWNER",
      body: "Measured: the claim does not hold.",
    });
    expect(answered()).toHaveLength(1);
  });

  it("stages an empty registry when the threads hold no answered finding (no replies, or no bot threads)", async () => {
    const { api } = withThreadRows(
      ndjson([
        {
          id: 101,
          in_reply_to_id: null,
          user_login: "github-actions[bot]",
          user_type: "Bot",
          body: "just prose, no marker",
          html_url: "https://github.com/owner/repo/pull/42#discussion_r101",
          path: "src/foo.ts",
          line: 42,
          created_at: "2026-07-01T00:00:00Z",
        },
      ]),
    );
    await gather(mkInput({}), api, mkMockGit([]).git);
    expect(answered()).toEqual([]);
  });

  it("stages an empty registry when the thread fetch fails — the review then relies on the conversation alone", async () => {
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      { match: commentsMatch(42), response: "" },
      { match: reviewCommentsMatch(42), response: new Error("network down") },
      { match: reviewsMatch(42), response: "" },
    ]);
    await gather(mkInput({}), api, mkMockGit([]).git);
    expect(answered()).toEqual([]);
  });
});

// The two halves are each tested in isolation — gather writes prior_findings.json (above), seed-draft
// reads --prior-findings (index.test.ts) — but nothing asserted the FILE the one writes is the FILE
// the other reads. This runs the REAL gather and the REAL seed-draft back to back over one temp dir,
// through the shared runCli harness so a harness fix reaches both (issue #232 + r1).
describe("gather → seed-draft seam (issue #232)", () => {
  it("seed-draft consumes the prior_findings.json gather staged from an artifact-named marker", async () => {
    const doc = {
      schema_version: "0.9.0",
      summary: "Prior review summary.",
      verdict: "changes",
      findings: [
        {
          path: "src/a.ts",
          start_line: 3,
          end_line: 3,
          severity: "major",
          title: "Prior finding",
          description: "carried over from the prior review",
          reasoning: "still worth checking",
          confidence: 0.8,
          likelihood: 1,
        },
      ],
    };
    const { api } = mkMockGhApi([
      {
        match: candidatesMatch,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      { match: metaMatch(42), response: mkMeta() },
      { match: diffMatch(42), response: sampleDiff },
      {
        match: commentsMatch(42),
        response: ndjson([
          {
            id: 7,
            body: "<!-- code-review -->\n<!-- reviewed-route: full review -->\n<!-- code-review:findings-json https://api.github.com/repos/o/r/actions/artifacts/9/zip -->\nold sticky",
            user: { login: "github-actions[bot]" },
          },
        ]),
      },
    ]);

    await gather(mkInput({}), api, mkMockGit([]).git, (url) => {
      expect(url).toBe("https://api.github.com/repos/o/r/actions/artifacts/9/zip");
      return Promise.resolve(JSON.stringify(doc));
    });

    const prior = join(tmpDir, "prior_review.json");
    const staged = join(tmpDir, "prior_findings.json");
    expect(JSON.parse(readFileSync(staged, "utf-8")) as unknown).toEqual(doc);

    const out = join(tmpDir, "draft.json");
    const { stdout, stderr } = await runCli([
      "seed-draft",
      "--prior",
      prior,
      "--prior-findings",
      staged,
      "--out",
      out,
    ]);
    expect(stdout.trim()).toBe("prior-new");
    // The stderr success line is the seam's real signal: seed-draft never calls process.exit, so
    // a null-exit assertion could not falsify any outcome, while this line distinguishes a seeded
    // prior from every degraded path (issue #232 r1).
    expect(stderr).toContain("wrote the prior review (1 finding(s))");
    const context = JSON.parse(readFileSync(priorContextPath(out), "utf-8")) as typeof doc;
    expect(context.findings[0]!.title).toBe("Prior finding");
  });
});
