import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhApi, PostInput } from "./post.js";
import { post } from "./post.js";
import type { Findings, ResultEnvelope, PriceMap, Finding, ModelUsageEntry } from "./schema.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

const template = `<!-- code-review -->
<!-- reviewed-sha: <%= it.reviewedSha %> %>

### <%= it.verdictBadge(it.findings.verdict) %>

**Route:** <%~ it.route %> · **effort:** max · **turns:** <%= it.envelope.turns %> · **wall:** <%~ it.formatDuration(it.envelope.duration_ms) %>

<%~ it.findings.summary %>

---

<sub>

| Model | Input | Output | Cache read | Cache write | Cost |
|---|--:|--:|--:|--:|--:|
<% it.costReport.lines.forEach(function(l) { %>
| <%= l.model %> | <%= it.formatTokens(l.inputTokens) %> | <%= it.formatTokens(l.outputTokens) %> | <%= it.formatTokens(l.cacheReadTokens) %> | <%= it.formatTokens(l.cacheWriteTokens) %> | <%= it.formatCost(l.costUSD) %> |
<% }) %>
| **Total** | **<%= it.formatTokens(it.costReport.totalInputTokens) %>** | **<%= it.formatTokens(it.costReport.totalOutputTokens) %>** | **<%= it.formatTokens(it.costReport.totalCacheReadTokens) %>** | **<%= it.formatTokens(it.costReport.totalCacheWriteTokens) %>** | **<%= it.formatCost(it.costReport.totalCostUSD) %>** |

</sub>

> [!NOTE]
> **LLM Disclosure** — this review was produced by <%= it.modelNames || "unknown model" %> running
> headless in an ephemeral, egress-locked CI runner with no write access to the repository. It is
> advisory and does not block merge.
`;

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
  const api: GhApi = (args, stdin) => {
    calls.push({ args: [...args], stdin });
    for (const r of responses) {
      if (r.match(args)) return Promise.resolve(r.response);
    }
    return Promise.reject(new Error(`Unexpected gh api call: ${args.join(" ")}`));
  };
  return { api, calls: () => calls };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("post — upsert sticky comment", () => {
  it("PATCHes existing bot comment found by marker + author", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: "42\n",
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
        response: "42\n",
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
        response: "42\n",
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
        response: "42\n",
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

    const reviewCall = calls().find((c) => c.args[0] === "repos/owner/repo/pulls/42/reviews");
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
        response: "42\n",
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

    const reviewCall = calls().find((c) => c.args[0] === "repos/owner/repo/pulls/42/reviews");
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
        response: "42\n",
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

    const reviewCall = calls().find((c) => c.args[0] === "repos/owner/repo/pulls/42/reviews");
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
        response: "42\n",
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

    const reviewCall = calls().find((c) => c.args[0] === "repos/owner/repo/pulls/42/reviews");
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
        response: "42\n",
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

    const reviewCall = calls().find((c) => c.args[0] === "repos/owner/repo/pulls/42/reviews");
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
        match: (a) =>
          a[0]?.startsWith("repos/owner/repo/commits/") === true &&
          a.some((arg) => typeof arg === "string" && arg.includes(".[].number")),
        response: "42\n99\n",
      },
      {
        match: (a) =>
          a[0]?.startsWith("repos/owner/repo/commits/") === true &&
          a.some((arg) => typeof arg === "string" && arg.includes("head.ref")),
        response: "99\n",
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
        match: (a) => a[0] === "repos/owner/repo/pulls/99/reviews",
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
});

describe("post — injection discipline", () => {
  it("builds all API bodies with JSON.stringify (never shell-interpolated)", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: "42\n",
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
});
