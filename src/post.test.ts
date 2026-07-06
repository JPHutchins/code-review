import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GhApi, PostInput } from "./post.js";
import { post } from "./post.js";
import type {
  Findings,
  ResultEnvelope,
  PriceMap,
  Finding,
  ModelUsageEntry,
  TestSummary,
} from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Test helpers

const mkFinding = (overrides: Partial<Finding>): Finding => ({
  path: "src/foo.ts",
  start_line: 10,
  end_line: 10,
  severity: "minor",
  title: "Test finding",
  body: "Test body content.",
  ...overrides,
});

const mkFindings = (findings: Finding[]): Findings => ({
  schema_version: "0.2.0",
  summary: "A test summary.",
  verdict: "comment",
  findings,
});

const mkEntry = (overrides: Partial<ModelUsageEntry>): ModelUsageEntry => ({
  model: "pro-model",
  input_tokens: 10000,
  output_tokens: 2000,
  cache_read_tokens: 5000,
  cache_write_tokens: 1000,
  ...overrides,
});

const baseEnvelope: ResultEnvelope = {
  schema_version: "0.2.0",
  findings: {
    schema_version: "0.2.0",
    summary: "test summary",
    verdict: "comment",
    findings: [],
  },
  models: [mkEntry({})],
  turns: 1,
  duration_ms: 30000,
  vendor_cost_usd: 0.042,
};

const prices: PriceMap = {
  _updated: "2026-07-03",
  _unit: "USD per 1M tokens",
  models: {
    "pro-model": { in: 3.0, out: 15.0, cache_read: 0.3, cache_write: 0.6 },
  },
};

// The real bundled template — exercises the actual shipped rendering (null-envelope
// degradation, severity grouping, effort segment), not a hand-rolled duplicate that drifts.
const template = readFileSync(resolve(__dirname, "..", "templates", "comment.eta"), "utf-8");

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
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtemp();
  const findings = mkFindings([mkFinding({ start_line: 10, end_line: 10 })]);
  writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(findings));
  writeFileSync(join(tmpDir, "envelope.json"), JSON.stringify(baseEnvelope));
  writeFileSync(join(tmpDir, "prices.json"), JSON.stringify(prices));
  writeFileSync(join(tmpDir, "comment.eta"), template);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const mkdtemp = (): string => {
  const dir = join(tmpdir(), `post-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const mkInput = (overrides: Partial<PostInput>): PostInput => ({
  repo: "owner/repo",
  headSha: "abc123def456",
  botLogin: "github-actions[bot]",
  findingsPath: join(tmpDir, "findings.json"),
  envelopePath: join(tmpDir, "envelope.json"),
  pricesPath: join(tmpDir, "prices.json"),
  templatePath: join(tmpDir, "comment.eta"),
  route: "full review",
  ...overrides,
});

interface RecordedCall {
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface ReviewBody {
  readonly body: string;
  readonly commit_id: string;
  readonly event: string;
  readonly comments: readonly {
    readonly path: string;
    readonly line: number;
    readonly side: string;
    readonly start_line?: number;
    readonly start_side?: string;
    readonly body: string;
  }[];
}

interface CommentBody {
  readonly body: string;
}

const mkMockGhApi = (
  responses: ReadonlyArray<{
    readonly match: (args: readonly string[]) => boolean;
    readonly response: string;
  }>,
): { readonly api: GhApi; readonly calls: () => readonly RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const api: GhApi = (args, stdin, env) => {
    calls.push({ args: [...args], stdin, env });
    for (const r of responses) {
      if (r.match(args)) return Promise.resolve(r.response);
    }
    return Promise.reject(new Error(`Unexpected gh api call: ${args.join(" ")}`));
  };
  return { api, calls: () => calls };
};

// Tests

describe("post — upsert sticky comment", () => {
  it("PATCHes existing bot comment found by marker + author", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: '{"id": 999, "body": "<!-- code-review -->\\nold content"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/comments/999",
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall!.stdin!) as CommentBody;
    expect(body.body).toContain("<!-- code-review -->");
    expect(body.body).toContain("full review");

    const postCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    expect(postCall).toBeUndefined();
  });

  it("POSTs new comment when no existing bot comment found", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const postCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall!.stdin!) as CommentBody;
    expect(body.body).toContain("<!-- code-review -->");
  });

  it("does NOT trust a non-bot comment with the marker (author identity, not marker)", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const patchCall = calls().find((c) =>
      c.args[0]?.startsWith("repos/owner/repo/issues/comments/"),
    );
    expect(patchCall).toBeUndefined();

    const postCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    expect(postCall).toBeDefined();
  });
});

describe("post — inline review", () => {
  it("posts inline review as COMMENT with commit_id = head SHA", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    expect(body.event).toBe("COMMENT");
    expect(body.event).not.toBe("REQUEST_CHANGES");
    expect(body.commit_id).toBe("abc123def456");
    expect(Array.isArray(body.comments)).toBe(true);
    expect(body.comments.length).toBeGreaterThan(0);

    for (const c of body.comments) {
      expect(c).toHaveProperty("path");
      expect(c).toHaveProperty("line");
      expect(c).toHaveProperty("side");
      expect(c).not.toHaveProperty("position");
    }
  });

  it("does not post inline review when there are no in-diff comments", async () => {
    const strayFindings = mkFindings([mkFinding({ start_line: 999, end_line: 999 })]);
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(strayFindings));

    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeUndefined();
  });
});

describe("post — suggestion handling", () => {
  it('suggestion "" produces a deletion suggestion block', async () => {
    const findings = mkFindings([
      mkFinding({
        start_line: 10,
        end_line: 10,
        body: "Delete this line.",
        suggestion: "",
      }),
    ]);
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(findings));

    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    const commentBody = body.comments[0]?.body ?? "";
    expect(commentBody).toContain("```suggestion");
    expect(commentBody).toContain("```");
    const suggestionMatch = /```suggestion\n([\s\S]*?)\n```/.exec(commentBody);
    expect(suggestionMatch).not.toBeNull();
    expect(suggestionMatch![1]).toBe("");
  });

  it("suggestion null produces no suggestion block", async () => {
    const findings = mkFindings([
      mkFinding({
        start_line: 10,
        end_line: 10,
        body: "Just a note.",
        suggestion: null,
      }),
    ]);
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(findings));

    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    const commentBody = body.comments[0]?.body ?? "";
    expect(commentBody).not.toContain("```suggestion");
  });

  it("warns and demotes a >10-line suggestion rather than posting it inline", async () => {
    const longSuggestion = Array.from({ length: 15 }, (_, i) => `line ${String(i)}`).join("\n");
    const findings = mkFindings([
      mkFinding({
        start_line: 10,
        end_line: 10,
        body: "Large replacement.",
        suggestion: longSuggestion,
      }),
    ]);
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(findings));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("exceeds"));

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    const commentBody = body.comments[0]?.body ?? "";
    expect(commentBody).toContain("omitted");
    expect(commentBody).not.toContain("line 0");

    const summaryCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    expect(summaryCall).toBeDefined();
    const summaryBody = JSON.parse(summaryCall!.stdin!) as CommentBody;
    expect(summaryBody.body).toContain("suggestion");

    stderrSpy.mockRestore();
  });
});

describe("post — PR resolution", () => {
  it("exits 0 when no open PR for the head SHA", async () => {
    const { api } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: "\n",
      },
    ]);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(post(mkInput({}), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  it("disambiguates by head_branch when multiple PRs share a commit", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response:
          '{"number":42,"state":"open","headRef":"other-branch"}\n{"number":99,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/99" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/99/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/99/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/99/reviews" && a.includes("--paginate"),
        response: "[]",
      },
      {
        match: (a) =>
          a[0] === "repos/owner/repo/pulls/99/reviews" &&
          a.includes("--input") &&
          !a.includes("--paginate"),
        response: "",
      },
    ]);

    await post(mkInput({ headBranch: "feature-branch" }), api);

    const diffCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/99" && c.args.includes("-H"),
    );
    expect(diffCall).toBeDefined();

    const diffCall42 = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42" && c.args.includes("-H"),
    );
    expect(diffCall42).toBeUndefined();
  });

  it("exits 0 without posting when the resolved PR is not open", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"closed","headRef":"feature-branch"}\n',
      },
    ]);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(post(mkInput({}), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("not open"));
    expect(calls()).toHaveLength(1); // only the PR-resolution read — nothing else, nothing posted

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe("post — injection discipline", () => {
  it("builds all API bodies with JSON.stringify (never shell-interpolated)", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    for (const c of calls()) {
      if (c.stdin !== undefined) {
        expect(() => JSON.parse(c.stdin ?? "") as unknown).not.toThrow();
      }
    }
  });

  it("passes bot login and marker to jq via env, never interpolated into the filter text (jq hardening)", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const findCommentsCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.args.includes("--paginate"),
    );
    expect(findCommentsCall).toBeDefined();
    expect(findCommentsCall?.args.some((a) => a.includes("github-actions[bot]"))).toBe(false);
    expect(
      findCommentsCall?.args.some(
        (a) => a.includes("env.CODE_REVIEW_BOT_LOGIN") && a.includes("env.CODE_REVIEW_MARKER"),
      ),
    ).toBe(true);
    expect(findCommentsCall?.env?.["CODE_REVIEW_BOT_LOGIN"]).toBe("github-actions[bot]");
    expect(findCommentsCall?.env?.["CODE_REVIEW_MARKER"]).toBe("<!-- code-review -->");
  });
});

describe("post — §5.5 error semantics", () => {
  const mkBaseMocks = (overrides: { readonly diff?: string } = {}) => [
    {
      match: (a: readonly string[]) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
      response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
    },
    {
      match: (a: readonly string[]) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
      response: overrides.diff ?? inlineDiff,
    },
    {
      match: (a: readonly string[]) =>
        a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
      response: "",
    },
    {
      match: (a: readonly string[]) =>
        a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
      response: "",
    },
  ];

  it("posts a sticky-only notice for an empty diff; no inline review; exit 0", async () => {
    const { api, calls } = mkMockGhApi(mkBaseMocks({ diff: "" }));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(post(mkInput({}), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    expect(stickyCall).toBeDefined();
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("diff for this PR is empty");
    expect(body.body).toContain("💬 comment");

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeUndefined();

    exitSpy.mockRestore();
  });

  it("posts a sticky-only notice when the findings file is corrupt (invalid JSON); exit 0", async () => {
    writeFileSync(join(tmpDir, "findings.json"), "{ not valid json");
    const { api, calls } = mkMockGhApi(mkBaseMocks());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(post(mkInput({}), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("did not complete");

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeUndefined();

    exitSpy.mockRestore();
  });

  it("posts a sticky-only notice when the findings file is absent; exit 0", async () => {
    const { api, calls } = mkMockGhApi(mkBaseMocks());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(
      post(mkInput({ findingsPath: join(tmpDir, "does-not-exist.json") }), api),
    ).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("did not complete");

    exitSpy.mockRestore();
  });

  it("posts a sticky-only notice when findings fail FindingsCodec (invalid shape); exit 0", async () => {
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify({ not: "findings shaped" }));
    const { api, calls } = mkMockGhApi(mkBaseMocks());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(post(mkInput({}), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("did not conform to the findings schema");

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeUndefined();

    exitSpy.mockRestore();
  });

  it("F3: posts the malformed notice for a schema_version missing its patch component (ajv/codec parity)", async () => {
    const findings = mkFindings([mkFinding({})]);
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({ ...findings, schema_version: "0.2" }),
    );
    const { api, calls } = mkMockGhApi(mkBaseMocks());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(post(mkInput({}), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("did not conform to the findings schema");

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeUndefined();

    exitSpy.mockRestore();
  });

  it("posts the malformed notice (missing-version) when schema_version is entirely absent; exit 0", async () => {
    const findings = mkFindings([mkFinding({})]);
    const withoutVersion: Record<string, unknown> = { ...findings };
    delete withoutVersion["schema_version"];
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(withoutVersion));
    const { api, calls } = mkMockGhApi(mkBaseMocks());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(post(mkInput({}), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("did not conform to the findings schema");

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeUndefined();

    exitSpy.mockRestore();
  });

  it("posts a sticky-only notice when schema_version major.minor is unsupported; exit 0", async () => {
    const unsupported = mkFindings([mkFinding({})]);
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({ ...unsupported, schema_version: "1.0.0" }),
    );
    const { api, calls } = mkMockGhApi(mkBaseMocks());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(post(mkInput({}), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain('schema_version "1.0.0"');
    expect(body.body).toContain("does not support");

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeUndefined();

    exitSpy.mockRestore();
  });

  it("posts a sticky-only notice with real findings when the envelope is absent; no inline; exit 0", async () => {
    const { api, calls } = mkMockGhApi(mkBaseMocks());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(
      post(mkInput({ envelopePath: join(tmpDir, "does-not-exist-envelope.json") }), api),
    ).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    // Real findings summary is preserved — this is not a synthetic notice.
    expect(body.body).toContain("A test summary.");
    expect(body.body).toContain("Usage/cost unavailable");

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeUndefined();

    exitSpy.mockRestore();
  });

  it("posts a sticky-only notice when the envelope file is corrupt (invalid JSON); exit 0", async () => {
    writeFileSync(join(tmpDir, "envelope.json"), "{ not valid json");
    const { api, calls } = mkMockGhApi(mkBaseMocks());

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(post(mkInput({}), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeUndefined();

    exitSpy.mockRestore();
  });
});

describe("post — re-run hygiene (REC-CO-2 / §5.2.6 — review identity, not the sticky marker)", () => {
  it("fix #5: posts the inline review when the sticky's marker matches the head SHA but no completed bot review exists at it", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        // A placeholder sticky already carrying THIS head SHA in its marker (the #5 trigger).
        response: `{"id": 999, "body": "<!-- code-review -->\\n<!-- reviewed-sha: abc123def456 -->\\nplaceholder"}\n`,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/comments/999",
        response: "",
      },
      {
        // No completed bot review exists at any SHA.
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews" && a.includes("--paginate"),
        response: "[]",
      },
      {
        match: (a) =>
          a[0] === "repos/owner/repo/pulls/42/reviews" &&
          a.includes("--input") &&
          !a.includes("--paginate"),
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCall).toBeDefined();

    // The real inline review IS posted despite the matching marker (the bug was suppressing it).
    const inlineCall = calls().find(
      (c) =>
        c.args[0] === "repos/owner/repo/pulls/42/reviews" &&
        c.args.includes("--input") &&
        !c.args.includes("--paginate"),
    );
    expect(inlineCall).toBeDefined();
    const stickyBody = JSON.parse(patchCall!.stdin!) as CommentBody;
    expect(stickyBody.body).toContain("posted inline");
  });

  it("suppresses the inline pass when a completed bot review already exists at the head SHA", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: `{"id": 999, "body": "<!-- code-review -->\\n<!-- reviewed-sha: abc123def456 -->\\nold"}\n`,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/comments/999",
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews" && a.includes("--paginate"),
        response: JSON.stringify([
          {
            id: 555,
            user: { login: "github-actions[bot]" },
            state: "COMMENTED",
            commit_id: "abc123def456",
          },
        ]),
      },
    ]);

    await post(mkInput({}), api);

    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCall).toBeDefined();
    const stickyBody = JSON.parse(patchCall!.stdin!) as CommentBody;
    expect(stickyBody.body).toContain("suppressed");

    // No fresh review is posted for a SHA that already has a completed bot review.
    const inlineCall = calls().find(
      (c) =>
        c.args[0] === "repos/owner/repo/pulls/42/reviews" &&
        c.args.includes("--input") &&
        !c.args.includes("--paginate"),
    );
    expect(inlineCall).toBeUndefined();
  });

  it("dismisses prior bot reviews and posts a fresh inline review when the head SHA differs", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: `{"id": 999, "body": "<!-- code-review -->\\n<!-- reviewed-sha: deadbeef00 -->\\nold"}\n`,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/comments/999",
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews" && a.includes("--paginate"),
        response: JSON.stringify([
          { id: 555, user: { login: "github-actions[bot]" }, state: "APPROVED" },
          { id: 556, user: { login: "someone-else" }, state: "APPROVED" },
        ]),
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews/555/dismissals",
        response: "",
      },
      {
        match: (a) =>
          a[0] === "repos/owner/repo/pulls/42/reviews" &&
          a.includes("--input") &&
          !a.includes("--paginate"),
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const dismissCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews/555/dismissals",
    );
    expect(dismissCall).toBeDefined();
    expect(dismissCall?.args).toContain("PUT");

    const notDismissed = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews/556/dismissals",
    );
    expect(notDismissed).toBeUndefined();

    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCall).toBeDefined();

    const inlineCall = calls().find(
      (c) =>
        c.args[0] === "repos/owner/repo/pulls/42/reviews" &&
        c.args.includes("--input") &&
        !c.args.includes("--paginate"),
    );
    expect(inlineCall).toBeDefined();
  });

  it("logs a dismissal failure and continues posting rather than failing the job", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: `{"id": 999, "body": "<!-- code-review -->\\n<!-- reviewed-sha: deadbeef00 -->\\nold"}\n`,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/comments/999",
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews" && a.includes("--paginate"),
        response: JSON.stringify([
          { id: 777, user: { login: "github-actions[bot]" }, state: "APPROVED" },
        ]),
      },
      // Deliberately no mock for the dismissals PUT call — it rejects as "unexpected".
      {
        match: (a) =>
          a[0] === "repos/owner/repo/pulls/42/reviews" &&
          a.includes("--input") &&
          !a.includes("--paginate"),
        response: "",
      },
    ]);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await post(mkInput({}), api);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed to dismiss"));

    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCall).toBeDefined();
    const inlineCall = calls().find(
      (c) =>
        c.args[0] === "repos/owner/repo/pulls/42/reviews" &&
        c.args.includes("--input") &&
        !c.args.includes("--paginate"),
    );
    expect(inlineCall).toBeDefined();

    stderrSpy.mockRestore();
  });
});

describe("post — CO-R3: never-partially-post ordering", () => {
  const normalMocks = [
    {
      match: (a: readonly string[]) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
      response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
    },
    {
      match: (a: readonly string[]) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
      response: inlineDiff,
    },
    {
      match: (a: readonly string[]) =>
        a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
      response: "",
    },
    {
      match: (a: readonly string[]) =>
        a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
      response: "",
    },
    {
      match: (a: readonly string[]) => a[0] === "repos/owner/repo/pulls/42/reviews",
      response: "",
    },
  ];

  it("posts the sticky before the inline review", async () => {
    const { api, calls } = mkMockGhApi(normalMocks);

    await post(mkInput({}), api);

    const stickyIndex = calls().findIndex(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const inlineIndex = calls().findIndex(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(stickyIndex).toBeGreaterThanOrEqual(0);
    expect(inlineIndex).toBeGreaterThan(stickyIndex);
  });

  it("propagates a posting failure (never partially posts) and never attempts the inline review", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        // The read of existing bot reviews (phase 1) succeeds…
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews" && a.includes("--paginate"),
        response: "[]",
      },
      // …but the sticky POST (first write) has no mock — it rejects as "unexpected gh api call".
    ]);

    await expect(post(mkInput({}), api)).rejects.toThrow(/Unexpected gh api call/);

    const inlineCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(inlineCall).toBeUndefined();
  });
});

describe("post — REQ-CO-9 test-report threading", () => {
  it("renders the test panel when --test-report is provided", async () => {
    const testReport: TestSummary = { passed: 3, failed: 1, total: 4 };
    writeFileSync(join(tmpDir, "test-report.json"), JSON.stringify(testReport));

    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({ testReportPath: join(tmpDir, "test-report.json") }), api);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("Test results");
    expect(body.body).toContain("3 passed, 1 failed");
  });

  it("omits the test panel and warns (but still posts) when --test-report is malformed", async () => {
    writeFileSync(join(tmpDir, "test-report.json"), "{ not valid json");

    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await post(mkInput({ testReportPath: join(tmpDir, "test-report.json") }), api);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("test report"));
    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    expect(stickyCall).toBeDefined();
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).not.toContain("Test results");

    stderrSpy.mockRestore();
  });
});

describe("post — --inline-template", () => {
  const inlineMocks = [
    {
      match: (a: readonly string[]) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
      response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
    },
    {
      match: (a: readonly string[]) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
      response: inlineDiff,
    },
    {
      match: (a: readonly string[]) =>
        a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
      response: "",
    },
    {
      match: (a: readonly string[]) =>
        a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
      response: "",
    },
    {
      match: (a: readonly string[]) => a[0] === "repos/owner/repo/pulls/42/reviews",
      response: "",
    },
  ];

  it("renders inline comment bodies with a custom Eta template", async () => {
    const inlineTemplatePath = join(tmpDir, "inline.eta");
    writeFileSync(inlineTemplatePath, "CUSTOM INLINE: <%~ it.body %>");

    const { api, calls } = mkMockGhApi(inlineMocks);

    await post(mkInput({ inlineTemplatePath }), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    expect(body.comments[0]?.body).toContain("CUSTOM INLINE:");
    expect(body.comments[0]?.body).toContain("Test body content.");
  });

  it("uses the built-in inline format when --inline-template is omitted (regression)", async () => {
    const { api, calls } = mkMockGhApi(inlineMocks);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    expect(body.comments[0]?.body).toBe("Test body content.");
    expect(body.comments[0]?.body).not.toContain("CUSTOM INLINE:");
  });
});

describe("post — --effort threading", () => {
  it("renders the passed effort in the sticky's route line", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({ effort: "low", route: "mechanic" }), api);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("**effort:** low");
    expect(body.body).toContain("mechanic");
  });

  it("renders route/effort from the envelope when no override is passed (SSOT)", async () => {
    writeFileSync(
      join(tmpDir, "envelope.json"),
      JSON.stringify({ ...baseEnvelope, route: "mechanic", effort: "low" }),
    );
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
        response: inlineDiff,
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: "",
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({ route: undefined }), api);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("**Route:** mechanic");
    expect(body.body).toContain("**effort:** low");
  });
});

describe("post — summary-only sticky & disposition honesty (fix #2)", () => {
  const okMocks = [
    {
      match: (a: readonly string[]) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
      response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
    },
    {
      match: (a: readonly string[]) => a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"),
      response: inlineDiff,
    },
    {
      match: (a: readonly string[]) =>
        a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"),
      response: "",
    },
    {
      match: (a: readonly string[]) =>
        a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
      response: "",
    },
    {
      match: (a: readonly string[]) => a[0] === "repos/owner/repo/pulls/42/reviews",
      response: "",
    },
  ];

  const stickyBodyOf = (calls: readonly RecordedCall[]): string => {
    const stickyCall = calls.find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    return (JSON.parse(stickyCall!.stdin!) as CommentBody).body;
  };

  it("renders a 'posted inline' pointer and NO per-finding findings table for in-diff findings", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({}), api);

    const body = stickyBodyOf(calls());
    expect(body).toContain("posted inline");
    expect(body).toContain("abc123d");
    expect(body).not.toContain("| Severity | File | Line | Summary |");
    expect(body).not.toContain("Findings summary");
    // The finding's body text belongs to the inline comment, never the sticky.
    expect(body).not.toContain("Test body content.");
  });

  it("renders a 'none-in-diff' pointer and the strays section (only) when all findings are out of diff", async () => {
    const strayFindings = mkFindings([
      mkFinding({ start_line: 999, end_line: 999, title: "Out of diff finding" }),
    ]);
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(strayFindings));

    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({}), api);

    const body = stickyBodyOf(calls());
    expect(body).toContain("No inline comments");
    expect(body).toContain("Findings outside the diff");
    expect(body).toContain("src/foo.ts:999");
    expect(body).toContain("Out of diff finding");

    const inlineCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(inlineCall).toBeUndefined();
  });

  it("gives the inline review a pointer body, not a duplicate of the walkthrough summary", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    expect(body.body).toContain("Automated code review");
    expect(body.body).toContain("abc123d");
    expect(body.body).not.toContain("A test summary.");
    expect(body.commit_id).toBe("abc123def456");
    expect(body.event).toBe("COMMENT");
  });
});
