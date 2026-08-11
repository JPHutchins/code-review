import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GhApi, PostInput, AnnounceInput } from "./post.js";
import { post, announce, reportIncomplete } from "./post.js";
import { findingPointer, parseRounds, parseSignalMarker } from "./surface.js";
import type {
  Findings,
  ResultEnvelope,
  PriceMap,
  Finding,
  ModelUsageEntry,
  TestSummary,
} from "./schema.js";
import type { RoundRecord } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Test helpers

const mkFinding = (overrides: Partial<Finding>): Finding => ({
  path: "src/foo.ts",
  start_line: 10,
  end_line: 10,
  severity: "minor",
  title: "Test finding",
  description: "Test description content.",
  reasoning: "Test reasoning content.",
  confidence: 0.7,
  ...overrides,
});

const mkFindings = (findings: Finding[]): Findings => ({
  schema_version: "0.4.0",
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
  schema_version: "0.4.0",
  findings: {
    schema_version: "0.4.0",
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

// The real bundled templates — exercise the actual shipped rendering (null-envelope degradation,
// severity grouping, effort segment, the inline disclosure fold), not hand-rolled duplicates that
// drift.
const template = readFileSync(resolve(__dirname, "..", "templates", "comment.eta"), "utf-8");
const inlineTemplate = readFileSync(resolve(__dirname, "..", "templates", "inline.eta"), "utf-8");

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
  writeFileSync(join(tmpDir, "inline.eta"), inlineTemplate);
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
  pricesProvided: true,
  templatePath: join(tmpDir, "comment.eta"),
  inlineTemplatePath: join(tmpDir, "inline.eta"),
  route: "full review",
  ...overrides,
});

const roundsMarkerFor = (n: number): string =>
  `<!-- code-review:rounds;base64 ${Buffer.from(
    JSON.stringify(Array.from({ length: n }, () => ({ critical: 0, major: 1, minor: 0, nit: 0 }))),
    "utf-8",
  ).toString("base64")} -->`;

// Shared by the sticky-precedence describes: the bot's own prior sticky + the post call surface.
const mkMocks = (stickyBody: string) => [
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
    response: `${JSON.stringify({ id: 999, body: stickyBody })}\n`,
  },
  {
    match: (a: readonly string[]) => a[0] === "repos/owner/repo/issues/comments/999",
    response: "",
  },
  // The answered-findings thread fetch (issue #151) — empty by default so existing tests exercise
  // the no-answers path.
  {
    match: (a: readonly string[]) =>
      a[0] === "repos/owner/repo/pulls/42/comments" && a.includes("--paginate"),
    response: "",
  },
  { match: (a: readonly string[]) => a[0] === "repos/owner/repo/pulls/42/reviews", response: "" },
];

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

describe("post — systemic problems (issue #134)", () => {
  it("renders the systemic section in the sticky and carries the array through the findings marker", async () => {
    const withSystemic: Findings = {
      ...mkFindings([mkFinding({ start_line: 10, end_line: 10 })]),
      systemic_problems: [
        {
          title: "Retry plumbing is inconsistent",
          description: "Three spots, three retry policies.",
          severity: "major",
          reasoning: "Each file implements its own policy.",
          confidence: 0.8,
          finding_codes: ["widened-type"],
          paths: ["src/foo.ts"],
        },
      ],
    };
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(withSystemic));

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
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments",
        response: '{"id": 1, "html_url": "https://github.com/o/r/pull/42#issuecomment-1"}\n',
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ]);

    await post(mkInput({}), api);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    expect(stickyCall).toBeDefined();
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("### 🔗 Systemic problems");
    expect(body.body).toContain("Retry plumbing is inconsistent");
    // The machine channel carries the systemic array verbatim, not just the rendered prose.
    const marker = /<!-- code-review:findings-json;base64 ([A-Za-z0-9+/=]+) -->/.exec(body.body);
    expect(marker).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(marker?.[1] ?? "", "base64").toString("utf-8")) as {
      systemic_problems?: readonly unknown[];
    };
    expect(decoded.systemic_problems).toHaveLength(1);
    expect(decoded.systemic_problems?.[0]).toEqual(withSystemic.systemic_problems?.[0]);
    // The convergence round entry carries the systemic severity too (one minor finding + one major
    // systemic item) — a systemic-only critical round can never masquerade as "clean".
    const lastRound = parseRounds(body.body).at(-1);
    expect(lastRound).toMatchObject({ critical: 0, major: 1, minor: 1, nit: 0 });
    // The systemic problem's finding_codes feed the round's mechanism map (issue #145) — a mechanism
    // surfaced only as a systemic problem is still visible to the streak detector — and the round
    // records the reviewed head sha so a same-head retry is recognizable as such.
    expect(lastRound?.codes).toEqual({ "widened-type": 1 });
    expect(lastRound?.sha).toBe("abc123def456");
  });

  it("warns to the run log when the whole-document marker degrades past the embed limit (issue #134 review)", async () => {
    const huge: Findings = {
      ...mkFindings([]),
      findings: Array.from({ length: 500 }, (_, i) =>
        mkFinding({ title: `Finding ${String(i)}`, description: "x".repeat(200) }),
      ),
    };
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(huge));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
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
          match: (a) => a[0] === "repos/owner/repo/issues/42/comments",
          response: '{"id": 1, "html_url": "https://github.com/o/r/pull/42#issuecomment-1"}\n',
        },
        {
          match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
          response: "",
        },
      ]);

      await post(mkInput({}), api);

      const stickyCall = calls().find(
        (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
      );
      expect(stickyCall).toBeDefined();
      const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
      // The marker is omitted entirely (no --json-url in this invocation) — the degradation must not
      // pass silently.
      expect(body.body).not.toContain("code-review:findings-json");
      expect(
        stderrSpy.mock.calls.some((c) => String(c[0]).includes("exceeds the embed limit")),
      ).toBe(true);
    } finally {
      // Restore even when an assertion above fails — a leaked spy swallows stderr for the rest of
      // the suite (vitest has no restoreMocks configured).
      stderrSpy.mockRestore();
    }
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

  it("posts a body-only COMMENT review even when there are no in-diff comments (issue #43)", async () => {
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
    expect(body.commit_id).toBe("abc123def456");
    // A body-only review: no in-diff comments, but the review still posts and its body carries the
    // code-review marker (points humans at the sticky, agents at the findings JSON).
    expect(body.comments).toEqual([]);
    expect(body.body).toContain("code-review");
  });
});

describe("post — suggestion handling (projected from a finding's patch)", () => {
  it("an all-deletion patch produces an empty (deletion) suggestion block", async () => {
    const findings = mkFindings([
      mkFinding({
        start_line: 10,
        end_line: 10,
        description: "Delete this line.",
        patch: ["@@ -10,1 +10,0 @@", "-old"].join("\n"),
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

  it("a finding with no patch produces no suggestion block", async () => {
    const findings = mkFindings([
      mkFinding({
        start_line: 10,
        end_line: 10,
        description: "Just a note.",
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

  it("warns and demotes a >10-line projected suggestion rather than posting it inline", async () => {
    const longAdded = Array.from({ length: 15 }, (_, i) => `line ${String(i)}`);
    const findings = mkFindings([
      mkFinding({
        start_line: 10,
        end_line: 10,
        description: "Large replacement.",
        patch: ["@@ -10 +10,15 @@", "-old", ...longAdded.map((l) => `+${l}`)].join("\n"),
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
  it("exits 0 when neither the commit endpoint nor any open PR matches the head SHA", async () => {
    const { api } = mkMockGhApi([
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
        response: "\n",
      },
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/pulls?state=open") ?? false,
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
    expect(body.body).toContain("🛠️ no review verdict");
    // An empty diff is incomplete, not a clean pass — never the clean-review line, never the marker.
    expect(body.body).not.toContain("clean review");
    expect(body.body).not.toContain("review-complete");

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
      JSON.stringify({ ...findings, schema_version: "0.4" }),
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

  it("an error-verdict findings doc with a lost envelope renders incomplete, never a false clean review (issue #117)", async () => {
    const { api, calls } = mkMockGhApi(mkBaseMocks());
    // A notice whose envelope was lost still carries verdict "error"; render derives incompleteness
    // from the verdict, so the sticky is a notice, not "No findings — clean review." with the marker.
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({
        schema_version: "0.5.0",
        summary:
          "### 🛠️ Security gate could not evaluate\n\nInfrastructure failure — not a verdict.",
        verdict: "error",
        findings: [],
      }),
    );

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    await expect(
      post(mkInput({ envelopePath: join(tmpDir, "no-envelope.json") }), api),
    ).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = JSON.parse(stickyCall!.stdin!) as CommentBody;
    expect(body.body).toContain("no review verdict");
    expect(body.body).not.toContain("clean review");
    expect(body.body).not.toContain("review-complete");

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

    // Two PATCHes land on the existing sticky: the initial pass (no disposition claim yet) and,
    // once the review is actually posted, the confirmed "posted inline" disposition (issue #21).
    const patchCalls = calls().filter((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCalls).toHaveLength(2);

    // The real inline review IS posted despite the matching marker (the bug was suppressing it).
    const inlineCall = calls().find(
      (c) =>
        c.args[0] === "repos/owner/repo/pulls/42/reviews" &&
        c.args.includes("--input") &&
        !c.args.includes("--paginate"),
    );
    expect(inlineCall).toBeDefined();
    const finalStickyBody = JSON.parse(patchCalls[1]!.stdin!) as CommentBody;
    expect(finalStickyBody.body).toContain("posted inline");
  });

  it("dismisses a prior bot review on the SAME head SHA and posts a fresh review (issue #53)", async () => {
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

    // The prior review on the SAME SHA is superseded, not left in place (issue #53).
    const dismissCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews/555/dismissals",
    );
    expect(dismissCall).toBeDefined();
    expect(dismissCall?.args).toContain("PUT");

    // A fresh review IS posted — the agent ran and paid, so its result must be surfaced, not skipped.
    const inlineCall = calls().find(
      (c) =>
        c.args[0] === "repos/owner/repo/pulls/42/reviews" &&
        c.args.includes("--input") &&
        !c.args.includes("--paginate"),
    );
    expect(inlineCall).toBeDefined();

    // The sticky no longer claims suppression.
    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCall).toBeDefined();
    const stickyBody = JSON.parse(patchCall!.stdin!) as CommentBody;
    expect(stickyBody.body).not.toContain("suppressed");
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
    writeFileSync(inlineTemplatePath, "CUSTOM INLINE: <%~ it.description %>");

    const { api, calls } = mkMockGhApi(inlineMocks);

    await post(mkInput({ inlineTemplatePath }), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    expect(body.comments[0]?.body).toContain("CUSTOM INLINE:");
    expect(body.comments[0]?.body).toContain("Test description content.");
  });

  it("uses the bundled inline.eta template — with its [!TIP] disclosure — when --inline-template is omitted (issue #22 regression)", async () => {
    const { api, calls } = mkMockGhApi(inlineMocks);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    const commentBody = body.comments[0]?.body ?? "";
    // The bundled default is inline.eta itself (not a plain built-in string) — it prepends a
    // single header line (emoji, bold title, confidence — issues #12, #27) AND the [!TIP]
    // disclosure fold (issue #16/#22), so the disclosure is no longer reachable only via an
    // explicit --inline-template.
    expect(commentBody).toContain("🔵 Minor: **Test finding** · 0.70 confidence");
    expect(commentBody).toContain("Test description content.");
    expect(commentBody).toContain("> [!TIP]");
    expect(commentBody).toContain("Generated by");
    expect(commentBody).not.toContain("CUSTOM INLINE:");
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
    expect(body.body).toContain("**route:** mechanic");
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
      response: JSON.stringify({
        id: 999,
        html_url: "https://github.com/owner/repo/issues/42#issuecomment-999",
      }),
    },
    {
      match: (a: readonly string[]) => a[0] === "repos/owner/repo/issues/comments/999",
      response: "",
    },
    {
      match: (a: readonly string[]) => a[0] === "repos/owner/repo/pulls/42/reviews",
      response: "",
    },
  ];

  // The sticky's TRUE final content — its first write never claims "posted" (issue #21), so
  // callers that care about the confirmed disposition need the LAST write, whichever endpoint
  // it landed on (the initial POST, or the follow-up PATCH once the review is confirmed).
  const stickyBodyOf = (calls: readonly RecordedCall[]): string => {
    const stickyCalls = calls.filter(
      (c) =>
        c.stdin !== undefined &&
        (c.args[0] === "repos/owner/repo/issues/42/comments" ||
          c.args[0] === "repos/owner/repo/issues/comments/999"),
    );
    return (JSON.parse(stickyCalls.at(-1)!.stdin!) as CommentBody).body;
  };

  it("renders a 'posted inline' pointer and NO per-finding findings table for in-diff findings", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({}), api);

    const body = stickyBodyOf(calls());
    expect(body).toContain("posted inline");
    expect(body).toContain("abc123d");
    expect(body).not.toContain("| Severity | File | Line | Summary |");
    expect(body).not.toContain("Findings summary");
    // The finding's description text belongs to the inline comment, never the sticky.
    expect(body).not.toContain("Test description content.");
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

    // Issue #43: the sticky keeps its none-in-diff wording, but a body-only COMMENT review is still
    // posted (empty comments[]) so tooling/agents get a review event.
    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewCall).toBeDefined();
    const reviewBody = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    expect(reviewBody.event).toBe("COMMENT");
    expect(reviewBody.comments).toEqual([]);
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

  it("prepends the findings-json marker to the review body itself, not just the sticky and inline comments (issue #19)", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    expect(body.body.startsWith("<!-- AGENTS: STOP")).toBe(true);
    expect(body.body).toContain("<!-- code-review:findings-json;base64 ");
    expect(body.body).toContain("Automated code review");
  });
});

describe("post — issue #11: bidirectional links between the sticky and the review", () => {
  const stickyHtmlUrl = "https://github.com/owner/repo/issues/42#issuecomment-999";
  const reviewHtmlUrl = "https://github.com/owner/repo/pull/42#pullrequestreview-1";

  it("links the review body to a newly-posted sticky, then re-patches the sticky with a link to the review", async () => {
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
        response: "", // no existing sticky — a new comment is posted
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: JSON.stringify({ id: 999, html_url: stickyHtmlUrl }),
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews" && a.includes("--paginate"),
        response: "[]",
      },
      {
        match: (a) =>
          a[0] === "repos/owner/repo/pulls/42/reviews" &&
          a.includes("--input") &&
          !a.includes("--paginate"),
        response: JSON.stringify({ html_url: reviewHtmlUrl }),
      },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/comments/999",
        response: JSON.stringify({ html_url: stickyHtmlUrl }),
      },
    ]);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    const reviewBody = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    expect(reviewBody.body).toContain(`[summary comment](${stickyHtmlUrl})`);

    // Sticky is written twice: the initial POST, then a PATCH linking it to the review.
    const patchCalls = calls().filter((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCalls).toHaveLength(1);
    const patchedBody = JSON.parse(patchCalls[0]!.stdin!) as CommentBody;
    expect(patchedBody.body).toContain(`[see the review](${reviewHtmlUrl})`);
  });

  it("re-patches an EXISTING sticky (not just a freshly-posted one) with the review link", async () => {
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
        // A real PATCH to an issue comment returns the full updated comment object (id included).
        match: (a) => a[0] === "repos/owner/repo/issues/comments/999",
        response: JSON.stringify({ id: 999, html_url: stickyHtmlUrl }),
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews" && a.includes("--paginate"),
        response: "[]",
      },
      {
        match: (a) =>
          a[0] === "repos/owner/repo/pulls/42/reviews" &&
          a.includes("--input") &&
          !a.includes("--paginate"),
        response: JSON.stringify({ html_url: reviewHtmlUrl }),
      },
    ]);

    await post(mkInput({}), api);

    const patchCalls = calls().filter((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCalls).toHaveLength(2);

    const firstPatchBody = JSON.parse(patchCalls[0]!.stdin!) as CommentBody;
    expect(firstPatchBody.body).not.toContain(reviewHtmlUrl);

    const secondPatchBody = JSON.parse(patchCalls[1]!.stdin!) as CommentBody;
    expect(secondPatchBody.body).toContain(`[see the review](${reviewHtmlUrl})`);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    const reviewBody = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    expect(reviewBody.body).toContain(`[summary comment](${stickyHtmlUrl})`);
  });

  it("degrades to a plain (non-linked) pointer and skips the re-patch when responses don't carry html_url", async () => {
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
        response: "", // malformed — no id/html_url to parse
      },
      {
        match: (a) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "", // malformed — no html_url to parse
      },
    ]);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    const reviewBody = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    expect(reviewBody.body).toContain("see the summary comment");
    expect(reviewBody.body).not.toContain("](");

    // No sticky id was ever recovered, so there is nothing to re-patch — no extra call is made
    // beyond the single initial POST.
    const stickyWrites = calls().filter(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    expect(stickyWrites).toHaveLength(1);
  });

  it("logs a warning and does not fail the job when the re-patch call itself rejects", async () => {
    const calls: RecordedCall[] = [];
    let stickyPatchCount = 0;
    const api: GhApi = (args, stdin, env) => {
      calls.push({ args: [...args], stdin, env });
      if (args[0]?.startsWith("repos/owner/repo/commits/")) {
        return Promise.resolve('{"number":42,"state":"open","headRef":"feature-branch"}\n');
      }
      if (args[0] === "repos/owner/repo/pulls/42" && args.includes("-H")) {
        return Promise.resolve(inlineDiff);
      }
      if (args[0] === "repos/owner/repo/issues/42/comments" && args.includes("--paginate")) {
        return Promise.resolve(
          `{"id": 999, "body": "<!-- code-review -->\\n<!-- reviewed-sha: abc123def456 -->\\nold"}\n`,
        );
      }
      if (args[0] === "repos/owner/repo/issues/comments/999") {
        stickyPatchCount += 1;
        return stickyPatchCount === 1
          ? Promise.resolve(JSON.stringify({ html_url: stickyHtmlUrl }))
          : Promise.reject(new Error("network hiccup"));
      }
      if (args[0] === "repos/owner/repo/pulls/42/reviews" && args.includes("--paginate")) {
        return Promise.resolve("[]");
      }
      if (
        args[0] === "repos/owner/repo/pulls/42/reviews" &&
        args.includes("--input") &&
        !args.includes("--paginate")
      ) {
        return Promise.resolve(JSON.stringify({ html_url: reviewHtmlUrl }));
      }
      return Promise.reject(new Error(`Unexpected gh api call: ${args.join(" ")}`));
    };

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(post(mkInput({}), api)).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to update the sticky summary"),
    );
    expect(stickyPatchCount).toBe(2);

    stderrSpy.mockRestore();
  });
});

describe("post — issue #14: markdown formatting pass before posting", () => {
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

  it("collapses multiple blank lines in the findings summary before posting the sticky", async () => {
    const findings = mkFindings([mkFinding({ start_line: 10, end_line: 10 })]);
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({ ...findings, summary: "Para one.\n\n\n\nPara two." }),
    );
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({}), api);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = (JSON.parse(stickyCall!.stdin!) as CommentBody).body;
    expect(body).not.toMatch(/\n\n\n/);
    expect(body).toContain("Para one.\n\nPara two.");
  });

  it("collapses multiple blank lines in a finding's description before posting the inline comment", async () => {
    const findings = mkFindings([
      mkFinding({ start_line: 10, end_line: 10, description: "Line one.\n\n\n\nLine two." }),
    ]);
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(findings));
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({}), api);

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    const body = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    const commentBody = body.comments[0]?.body ?? "";
    expect(commentBody).not.toMatch(/\n\n\n/);
    expect(commentBody).toContain("Line one.\n\nLine two.");
  });
});

describe("post — --run-url / --json-url threading", () => {
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

  it("threads --run-url into the sticky's LLM Disclosure run link", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({ runUrl: "https://ci.example.com/runs/123" }), api);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = (JSON.parse(stickyCall!.stdin!) as CommentBody).body;
    expect(body).toContain("[view the run & traces](https://ci.example.com/runs/123)");
  });

  it("embeds the whole-document marker on the sticky, and a per-finding marker on each inline comment, when small enough (issue #19 sticky, issue #31 inline)", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({ jsonUrl: "https://artifacts.example.com/findings.json" }), api);

    // Findings are small enough to embed, so every surface prefers the embed over the link — see
    // the size-fallback case below for the jsonUrl link path.
    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const stickyBody = (JSON.parse(stickyCall!.stdin!) as CommentBody).body;
    expect(stickyBody).toContain("<!-- code-review:findings-json;base64 ");
    expect(stickyBody).not.toContain("fetch the structured findings JSON");

    const reviewCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    const reviewBody = JSON.parse(reviewCall!.stdin!) as ReviewBody;
    const commentBody = reviewBody.comments[0]?.body ?? "";
    expect(commentBody.startsWith("<!-- AGENTS: STOP")).toBe(true);
    expect(commentBody).toContain("<!-- code-review:findings-json;base64 ");
    expect(commentBody).not.toContain("https://artifacts.example.com/findings.json");

    // The inline comment's marker carries only its OWN finding, not the whole document (issue #31).
    const match = /<!-- code-review:findings-json;base64 (\S+) -->/.exec(commentBody);
    const decoded = JSON.parse(Buffer.from(match?.[1] ?? "", "base64").toString("utf-8")) as {
      schema_version: string;
      summary?: string;
      findings: unknown[];
    };
    expect(decoded.findings).toHaveLength(1);
    expect(decoded.summary).toBeUndefined();
  });

  it("falls back to the --json-url link marker in the sticky when the findings are too large to embed (PR #17 review)", async () => {
    const largeFindings = mkFindings(
      Array.from({ length: 500 }, (_, i) =>
        mkFinding({
          start_line: 10,
          end_line: 10,
          title: `Finding ${String(i)}`,
          description: "x".repeat(200),
        }),
      ),
    );
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(largeFindings));
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({ jsonUrl: "https://artifacts.example.com/findings.json" }), api);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const stickyBody = (JSON.parse(stickyCall!.stdin!) as CommentBody).body;
    expect(stickyBody).toContain(
      "<!-- code-review:findings-json https://artifacts.example.com/findings.json -->",
    );
    // The FINDINGS marker fell back to the URL form; the rounds marker's own base64 is unrelated.
    expect(stickyBody).not.toContain("findings-json;base64");
  });

  it("omits the run link when it isn't given; the sticky still embeds the findings-json marker unconditionally (regression, PR #17 review)", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({}), api);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = (JSON.parse(stickyCall!.stdin!) as CommentBody).body;
    expect(body).not.toContain("view the run & traces");
    expect(body).toContain("<!-- code-review:findings-json;base64 ");
    expect(body).not.toContain("<!-- code-review:findings-json http");
  });
});

describe("post — postedAt threading (issue #28)", () => {
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

  it("renders the sticky's '**Reviewed** `<sha>` at <postedAt>' segment when postedAt is passed", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({ postedAt: "2026-07-07 18:42 UTC" }), api);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = (JSON.parse(stickyCall!.stdin!) as CommentBody).body;
    expect(body).toContain("**Reviewed** `abc123d` at 2026-07-07 18:42 UTC");
  });

  it("omits the Reviewed segment when postedAt is not passed", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({}), api);

    const stickyCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.stdin !== undefined,
    );
    const body = (JSON.parse(stickyCall!.stdin!) as CommentBody).body;
    expect(body).not.toContain("**Reviewed**");
  });
});

describe("post — absent price map renders cost as N/A with a footnote (SPEC §6.2)", () => {
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

  it("renders cost cells as N/A (never $0.00) and a footnote linking SPEC §6.2 when pricesProvided is false", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({ pricesProvided: false }), api);

    const body = stickyBodyOf(calls());
    expect(body).toContain("**cost:** N/A");
    expect(body).not.toContain("$0.00");
    expect(body).toContain(
      "[No `.github/prices.json`](https://github.com/JPHutchins/code-review/blob/main/schema/prices.example.json)",
    );
    // The per-model cost column is N/A too — real token counts still render (they need no rates).
    expect(body).toContain("| N/A |");
    expect(body).toContain("10,000");
  });

  it("renders real cost figures and no footnote when a real price map is provided", async () => {
    const { api, calls } = mkMockGhApi(okMocks);

    await post(mkInput({ pricesProvided: true }), api);

    const body = stickyBodyOf(calls());
    expect(body).toContain("**cost:** $");
    expect(body).not.toContain("N/A");
    expect(body).not.toContain("No `.github/prices.json`");
  });
});

describe("post — minimize prior inline comments (issue #31/#53)", () => {
  const node = (id: string, login: string, isMinimized: boolean): unknown => ({
    comments: { nodes: [{ id, isMinimized, author: { login } }] },
  });

  // The snapshot is taken BEFORE the fresh review is posted, so every bot comment here is a PRIOR
  // (stale) one regardless of which SHA it was authored against — C_prior_a and C_prior_b are both
  // the bot's own non-minimized comments and get minimized; C_user is not the bot; C_min is already
  // minimized. This is the #53 fix: a prior same-SHA review's threads are no longer left orphaned.
  const threadsResponse = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [
              node("C_prior_a", "github-actions", false),
              node("C_prior_b", "github-actions", false),
              node("C_user", "someuser", false),
              node("C_min", "github-actions", true),
            ],
          },
        },
      },
    },
  });

  const baseMocks = [
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

  const minimizedIdsOf = (calls: readonly RecordedCall[]): readonly string[] =>
    calls
      .filter((c) => c.args[0] === "graphql" && c.args.some((x) => x.includes("minimizeComment")))
      .map((c) => c.args.find((x) => x.startsWith("id="))?.slice("id=".length))
      .filter((x): x is string => x !== undefined);

  it("minimizes the bot's own non-minimized inline comments from prior reviews (any SHA)", async () => {
    const { api, calls } = mkMockGhApi([
      ...baseMocks,
      {
        match: (a) => a[0] === "graphql" && a.some((x) => x.includes("reviewThreads")),
        response: threadsResponse,
      },
      {
        match: (a) => a[0] === "graphql" && a.some((x) => x.includes("minimizeComment")),
        response: '{"data":{"minimizeComment":{"minimizedComment":{"isMinimized":true}}}}',
      },
    ]);

    await post(mkInput({}), api);

    expect(minimizedIdsOf(calls())).toEqual(["C_prior_a", "C_prior_b"]);
  });

  it("still posts the review when listing review threads fails (best-effort, never fails the post)", async () => {
    // No graphql match → the review-threads query rejects; minimize must swallow it, never fail post.
    const { api, calls } = mkMockGhApi(baseMocks);

    await expect(post(mkInput({}), api)).resolves.toBeUndefined();

    const reviewPost = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(reviewPost).toBeDefined();
    expect(minimizedIdsOf(calls())).toEqual([]);
  });
});

describe("post — inline review 422 salvage (issue #57)", () => {
  it("keeps the valid inline comments and demotes only the rejected finding to the sticky", async () => {
    // Two in-diff findings (lines 10 and 11 of inlineDiff's hunk). The batched review POST is
    // rejected (as GitHub does when ANY comment position is invalid); the fallback posts the review
    // body-only, then each comment individually — line 10 is accepted, line 11 is rejected.
    const findings = mkFindings([
      mkFinding({ path: "src/foo.ts", start_line: 10, end_line: 10, title: "Finding A" }),
      mkFinding({ path: "src/foo.ts", start_line: 11, end_line: 11, title: "Finding B" }),
    ]);
    const findingsPath = join(tmpDir, "findings-57.json");
    writeFileSync(findingsPath, JSON.stringify(findings));

    const calls: RecordedCall[] = [];
    const api: GhApi = (args, stdin, env) => {
      calls.push({ args: [...args], stdin, env });
      const a = [...args];
      if (a[0]?.startsWith("repos/owner/repo/commits/"))
        return Promise.resolve('{"number":42,"state":"open","headRef":"feature-branch"}\n');
      if (a[0] === "repos/owner/repo/pulls/42" && a.includes("-H"))
        return Promise.resolve(inlineDiff);
      if (a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate"))
        return Promise.resolve("");
      if (a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"))
        return Promise.resolve('{"id": 999, "html_url": "https://gh/sticky"}\n');
      if (a[0] === "repos/owner/repo/issues/comments/999")
        return Promise.resolve('{"id": 999, "html_url": "https://gh/sticky"}\n');
      if (a[0] === "repos/owner/repo/pulls/42/reviews" && a.includes("--paginate"))
        return Promise.resolve("[]");
      if (a[0] === "repos/owner/repo/pulls/42/reviews" && a.includes("--input")) {
        const body = JSON.parse(stdin ?? "{}") as ReviewBody;
        // The batched attempt (with comments) is what GitHub rejects; the body-only retry succeeds.
        return body.comments.length > 0
          ? Promise.reject(new Error("gh: Unprocessable Entity (HTTP 422)"))
          : Promise.resolve('{"html_url": "https://gh/review"}\n');
      }
      if (a[0] === "repos/owner/repo/pulls/42/comments" && a.includes("--input")) {
        const c = JSON.parse(stdin ?? "{}") as { line: number };
        return c.line === 11
          ? Promise.reject(new Error("gh: Unprocessable Entity (HTTP 422)"))
          : Promise.resolve('{"id": 1, "html_url": "https://gh/comment"}\n');
      }
      if (a[0] === "graphql") return Promise.resolve("");
      return Promise.reject(new Error(`Unexpected gh api call: ${a.join(" ")}`));
    };

    await expect(post(mkInput({ findingsPath }), api)).resolves.toBeUndefined();

    // The batched review was attempted, then a body-only review posted, then each comment individually.
    const reviewPosts = calls.filter(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.args.includes("--input"),
    );
    expect(reviewPosts).toHaveLength(2);
    expect((JSON.parse(reviewPosts[1]!.stdin!) as ReviewBody).comments).toEqual([]);
    const individualComments = calls.filter(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/comments" && c.args.includes("--input"),
    );
    expect(individualComments).toHaveLength(2);

    // The sticky's final state: the ONE anchored comment is reported truthfully, and only the
    // rejected finding (B) is surfaced in the sticky — the anchored one (A) is not.
    const stickyPatches = calls.filter((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    const finalBody = (JSON.parse(stickyPatches[stickyPatches.length - 1]!.stdin!) as CommentBody)
      .body;
    expect(finalBody).toContain("1 comment posted inline");
    expect(finalBody).toContain("couldn't be posted as inline");
    expect(finalBody).toContain("Finding B");
    expect(finalBody).not.toContain("Finding A");
  });
});

const mkAnnounceInput = (overrides: Partial<AnnounceInput> = {}): AnnounceInput => ({
  repo: "owner/repo",
  headSha: "abc123def456",
  botLogin: "github-actions[bot]",
  runUrl: "https://github.com/owner/repo/actions/runs/12345",
  ...overrides,
});

const AGENTS_DIRECTIVE =
  "<!-- AGENTS: STOP — do not parse the prose below; decode this findings JSON and read schema_version first. -->";
const FINDINGS_MARKER = "<!-- code-review:findings-json;base64 eyJhIjoxfQ== -->";
const REVIEWED_SHA_MARKER = `<!-- reviewed-sha: ${"a".repeat(40)} -->`;

describe("announce — in-progress sticky", () => {
  const openPr = {
    match: (a: readonly string[]) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
    response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
  };
  const commentsMatch = (a: readonly string[]): boolean =>
    a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate");

  it("POSTs a fresh placeholder linking the run when no sticky exists", async () => {
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: "" },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: '{"id": 555, "html_url": "https://example.com/c/555"}',
      },
    ]);

    await announce(mkAnnounceInput(), api);

    const postCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.args.includes("--input"),
    );
    expect(postCall).toBeDefined();
    const body = (JSON.parse(postCall!.stdin!) as CommentBody).body;
    expect(body).toContain("<!-- code-review -->");
    expect(body).toContain("Code review in progress");
    expect(body).toContain("abc123d");
    expect(body).toContain("https://github.com/owner/repo/actions/runs/12345");
    // No prior sticky ⇒ no findings/reviewed-sha markers to carry forward.
    expect(body).not.toContain("findings-json");
    expect(calls().some((c) => c.args[0]?.startsWith("repos/owner/repo/issues/comments/"))).toBe(
      false,
    );
  });

  it("PATCHes the existing sticky and carries its findings + reviewed-sha markers forward", async () => {
    const existing = [
      "<!-- code-review -->",
      "",
      "### 🟠 1 finding — prior round prose that will be replaced",
      "",
      AGENTS_DIRECTIVE,
      FINDINGS_MARKER,
      REVIEWED_SHA_MARKER,
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
      { match: (a) => a[0] === "repos/owner/repo/issues/comments/999", response: "" },
    ]);

    await announce(mkAnnounceInput(), api);

    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCall).toBeDefined();
    const body = (JSON.parse(patchCall!.stdin!) as CommentBody).body;
    expect(body).toContain("Code review in progress");
    // The re-review seed survives the prose swap.
    expect(body).toContain(FINDINGS_MARKER);
    expect(body).toContain(REVIEWED_SHA_MARKER);
    expect(body).toContain(AGENTS_DIRECTIVE);
    // The stale prose is gone.
    expect(body).not.toContain("prior round prose");
    // No NEW comment posted.
    expect(
      calls().some(
        (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.args.includes("--input"),
      ),
    ).toBe(false);
  });

  it("does nothing when there is no open PR", async () => {
    const { api, calls } = mkMockGhApi([
      { match: (a) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false, response: "\n" },
      {
        match: (a) => a[0]?.startsWith("repos/owner/repo/pulls?state=open") ?? false,
        response: "\n",
      },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await announce(mkAnnounceInput(), api);

    expect(calls().some((c) => c.args.includes("--input"))).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("nothing to announce"));
    stderrSpy.mockRestore();
  });

  it("leaves the sticky untouched when it already reflects a COMPLETED review of the current head (CI re-run / race)", async () => {
    const headSha = "abc123def4560000000000000000000000000000";
    const existing = [
      "<!-- code-review -->",
      "<!-- review-complete -->",
      "",
      "### 💬 comment — a completed review of this exact head",
      "",
      `<!-- reviewed-sha: ${headSha} -->`,
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await announce(mkAnnounceInput({ headSha }), api);

    // Neither a patch nor a post — the finished review stays visible.
    expect(calls().some((c) => c.args.includes("--input"))).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("already reflects a completed"));
    stderrSpy.mockRestore();
  });

  it("replaces a same-head INCOMPLETE notice with the in-progress placeholder on a re-run (#107)", async () => {
    const headSha = "abc123def4560000000000000000000000000000";
    // A prior run's "did not complete" notice: it stamps reviewed-sha but carries NO review-complete
    // marker, so it must not masquerade as a finished review that blocks the placeholder.
    const existing = [
      "<!-- code-review -->",
      "",
      "### ⚠️ Review did not complete",
      "",
      `<!-- reviewed-sha: ${headSha} -->`,
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
      { match: (a) => a[0] === "repos/owner/repo/issues/comments/999", response: "" },
    ]);

    await announce(mkAnnounceInput({ headSha }), api);

    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    expect(patchCall).toBeDefined();
    expect((JSON.parse(patchCall!.stdin!) as CommentBody).body).toContain(
      "Code review in progress",
    );
  });
});

describe("reportIncomplete — failed/cancelled review sticky", () => {
  const openPr = {
    match: (a: readonly string[]) => a[0]?.startsWith("repos/owner/repo/commits/") ?? false,
    response: '{"number":42,"state":"open","headRef":"feature-branch"}\n',
  };
  const commentsMatch = (a: readonly string[]): boolean =>
    a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--paginate");

  it("POSTs an attributed 'did not complete' notice when no sticky exists", async () => {
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: "" },
      {
        match: (a) => a[0] === "repos/owner/repo/issues/42/comments" && a.includes("--input"),
        response: '{"id": 555, "html_url": "https://example.com/c/555"}',
      },
    ]);

    await reportIncomplete(mkAnnounceInput(), api);

    const postCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/42/comments" && c.args.includes("--input"),
    );
    const body = (JSON.parse(postCall!.stdin!) as CommentBody).body;
    expect(body).toContain("<!-- code-review -->");
    expect(body).toContain("Code review did not complete");
    expect(body).toContain("Re-request");
    expect(body).toContain("abc123d");
  });

  it("overwrites its OWN in-progress placeholder and carries its re-review markers forward", async () => {
    const runUrl = "https://github.com/owner/repo/actions/runs/12345";
    const existing = [
      "<!-- code-review -->",
      "",
      `🔄 **Code review in progress** for \`abc123d\` — see the [workflow run](${runUrl})`,
      "",
      AGENTS_DIRECTIVE,
      FINDINGS_MARKER,
      REVIEWED_SHA_MARKER,
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
      { match: (a) => a[0] === "repos/owner/repo/issues/comments/999", response: "" },
    ]);

    await reportIncomplete(mkAnnounceInput({ runUrl }), api);

    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    const body = (JSON.parse(patchCall!.stdin!) as CommentBody).body;
    expect(body).toContain("Code review did not complete");
    expect(body).toContain(FINDINGS_MARKER);
    expect(body).toContain(REVIEWED_SHA_MARKER);
    expect(body).not.toContain("in progress");
  });

  it("leaves a SUPERSEDING run's live in-progress placeholder in place (no false 'did not complete')", async () => {
    // The sticky links a DIFFERENT run — a newer run announced it and is actively reviewing.
    const existing = [
      "<!-- code-review -->",
      "",
      "🔄 **Code review in progress** for `def4567` — see the [workflow run](https://github.com/owner/repo/actions/runs/99999)",
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await reportIncomplete(
      mkAnnounceInput({ runUrl: "https://github.com/owner/repo/actions/runs/12345" }),
      api,
    );

    expect(calls().some((c) => c.args.includes("--input"))).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("belongs to another run"));
    stderrSpy.mockRestore();
  });

  it("never buries a completed review — leaves a review-complete sticky in place", async () => {
    const existing = [
      "<!-- code-review -->",
      "<!-- review-complete -->",
      "",
      "### 💬 comment — a completed review",
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await reportIncomplete(mkAnnounceInput(), api);

    expect(calls().some((c) => c.args.includes("--input"))).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("already reflects a completed"));
    stderrSpy.mockRestore();
  });

  it("cancelled: posts the 'superseded' wording, NOT the failure wording, onto its OWN placeholder (issue #139)", async () => {
    const runUrl = "https://github.com/owner/repo/actions/runs/12345";
    const existing = [
      "<!-- code-review -->",
      "",
      `🔄 **Code review in progress** for \`abc123d\` — see the [workflow run](${runUrl})`,
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
      { match: (a) => a[0] === "repos/owner/repo/issues/comments/999", response: "" },
    ]);

    await reportIncomplete({ ...mkAnnounceInput({ runUrl }), cancelled: true }, api);

    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    const body = (JSON.parse(patchCall!.stdin!) as CommentBody).body;
    expect(body).toContain("<!-- code-review -->");
    expect(body).toContain("Code review superseded");
    expect(body).toContain("No action needed");
    expect(body).toContain("abc123d");
    // A superseded run is informational — never the crash/failure reading, never a re-request.
    expect(body).not.toContain("did not complete");
    expect(body).not.toContain("Re-request");
    expect(body).not.toContain("review-complete");
    // The wording must not over-assert: `cancelled` also fires for a manual cancel, so the cause is
    // hedged with "typically", and the run it links is this (cancelled) one, not a "latest" run it
    // cannot name.
    expect(body).not.toContain("latest run");
    expect(body).toContain("typically");
  });

  it("cancelled: does NOT create a lone superseded sticky when no placeholder exists (nothing superseded it)", async () => {
    const { api, calls } = mkMockGhApi([openPr, { match: commentsMatch, response: "" }]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await reportIncomplete({ ...mkAnnounceInput(), cancelled: true }, api);

    expect(calls().some((c) => c.args.includes("--input"))).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("no sticky to supersede"));
    stderrSpy.mockRestore();
  });

  it("cancelled: overwrites its OWN placeholder and carries re-review markers forward, with the superseded wording", async () => {
    const runUrl = "https://github.com/owner/repo/actions/runs/12345";
    const existing = [
      "<!-- code-review -->",
      "",
      `🔄 **Code review in progress** for \`abc123d\` — see the [workflow run](${runUrl})`,
      "",
      AGENTS_DIRECTIVE,
      FINDINGS_MARKER,
      REVIEWED_SHA_MARKER,
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
      { match: (a) => a[0] === "repos/owner/repo/issues/comments/999", response: "" },
    ]);

    await reportIncomplete({ ...mkAnnounceInput({ runUrl }), cancelled: true }, api);

    const patchCall = calls().find((c) => c.args[0] === "repos/owner/repo/issues/comments/999");
    const body = (JSON.parse(patchCall!.stdin!) as CommentBody).body;
    expect(body).toContain("Code review superseded");
    expect(body).toContain(FINDINGS_MARKER);
    expect(body).toContain(REVIEWED_SHA_MARKER);
    expect(body).not.toContain("did not complete");
    expect(body).not.toContain("in progress");
  });

  it("cancelled: leaves a SUPERSEDING run's live placeholder in place (no false notice of any kind)", async () => {
    const existing = [
      "<!-- code-review -->",
      "",
      "🔄 **Code review in progress** for `def4567` — see the [workflow run](https://github.com/owner/repo/actions/runs/99999)",
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await reportIncomplete(
      {
        ...mkAnnounceInput({ runUrl: "https://github.com/owner/repo/actions/runs/12345" }),
        cancelled: true,
      },
      api,
    );

    expect(calls().some((c) => c.args.includes("--input"))).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("belongs to another run"));
    stderrSpy.mockRestore();
  });

  it("cancelled: a successor whose numeric run id has this run's id as a prefix is NOT treated as this run", async () => {
    // This run is 123; the live placeholder links run 1234 (123 is a substring of 1234). The guard
    // must not mistake the successor's URL for this run's (issue #139 round-4 finding).
    const existing = [
      "<!-- code-review -->",
      "",
      "🔄 **Code review in progress** for `def4567` — see the [workflow run](https://github.com/owner/repo/actions/runs/1234)",
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await reportIncomplete(
      {
        ...mkAnnounceInput({ runUrl: "https://github.com/owner/repo/actions/runs/123" }),
        cancelled: true,
      },
      api,
    );

    expect(calls().some((c) => c.args.includes("--input"))).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("belongs to another run"));
    stderrSpy.mockRestore();
  });

  it("cancelled: never buries a completed review", async () => {
    const existing = [
      "<!-- code-review -->",
      "<!-- review-complete -->",
      "",
      "### 💬 comment — a completed review",
    ].join("\n");
    const { api, calls } = mkMockGhApi([
      openPr,
      { match: commentsMatch, response: `${JSON.stringify({ id: 999, body: existing })}\n` },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await reportIncomplete({ ...mkAnnounceInput(), cancelled: true }, api);

    expect(calls().some((c) => c.args.includes("--input"))).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("already reflects a completed"));
    stderrSpy.mockRestore();
  });
});

describe("post — incomplete result never buries a completed review (#107)", () => {
  const completeSticky = [
    "<!-- code-review -->",
    `<!-- reviewed-sha: ${"a".repeat(40)} -->`,
    "<!-- review-complete -->",
    "",
    "### 💬 comment — a real, completed review",
  ].join("\n");
  const inProgressSticky = [
    "<!-- code-review -->",
    `<!-- reviewed-sha: ${"a".repeat(40)} -->`,
    "",
    "🔄 Code review in progress",
  ].join("\n");

  const writeIncomplete = (): void => {
    writeFileSync(
      join(tmpDir, "envelope.json"),
      JSON.stringify({ ...baseEnvelope, models: [], incomplete: true }),
    );
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(mkFindings([])));
  };

  it("leaves a completed review in place — no patch, no review — when this run is incomplete", async () => {
    writeIncomplete();
    const { api, calls } = mkMockGhApi(mkMocks(completeSticky));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(post(mkInput({}), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(
      calls().some(
        (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
      ),
    ).toBe(false);
    expect(
      calls().some(
        (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
      ),
    ).toBe(false);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("overwrites a completed review when THIS run is also complete", async () => {
    // beforeEach wrote a 1-finding findings.json + a real (models-carrying) envelope.
    const { api, calls } = mkMockGhApi(mkMocks(completeSticky));
    await post(mkInput({}), api);
    expect(
      calls().some(
        (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
      ),
    ).toBe(true);
  });

  it("writes an incomplete notice over an in-progress placeholder (not a completed review)", async () => {
    writeIncomplete();
    const { api, calls } = mkMockGhApi(mkMocks(inProgressSticky));
    await post(mkInput({}), api);
    expect(
      calls().some(
        (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
      ),
    ).toBe(true);
  });

  it("the envelope-null branch runs its bury guard too — an error-verdict run whose envelope was lost never overwrites a completed review (#117)", async () => {
    // Envelope missing, findings doc carries verdict "error": the envelope===null branch derives
    // incompleteness from the verdict and must leave the completed review in place.
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({
        schema_version: "0.5.0",
        summary: "### 🛠️ notice",
        verdict: "error",
        findings: [],
      }),
    );
    const { api, calls } = mkMockGhApi(mkMocks(completeSticky));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      post(mkInput({ envelopePath: join(tmpDir, "no-envelope.json") }), api),
    ).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(
      calls().some(
        (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
      ),
    ).toBe(false);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("post — an empty CI-fix mechanic pass never buries a completed FULL review (#127)", () => {
  const stickyFrom = (markers: readonly string[]): string =>
    `<!-- code-review -->\n${markers.join("\n")}\n\n### 💬 comment — the prior review`;

  // A completed FULL review — its route marker, and (on older stickies that predate it) its rounds
  // history, are the two signals priorIsFullReview reads.
  const fullReviewSticky = stickyFrom([
    "<!-- review-complete -->",
    "<!-- reviewed-route: full review -->",
    roundsMarkerFor(1),
  ]);
  const oldCliFullReviewSticky = stickyFrom(["<!-- review-complete -->", roundsMarkerFor(1)]);
  const markerlessFullReviewSticky = stickyFrom(["<!-- review-complete -->"]);
  const mechanicSticky = stickyFrom([
    "<!-- review-complete -->",
    "<!-- reviewed-route: mechanic -->",
  ]);
  // A completed mechanic that carried a prior full review's round history forward — the route
  // marker must win over the carried rounds, or same-route superseding would be blocked.
  const mechanicWithCarriedRoundsSticky = stickyFrom([
    "<!-- review-complete -->",
    "<!-- reviewed-route: mechanic -->",
    roundsMarkerFor(1),
  ]);
  // The announce placeholder of a review of THIS run: the prior full review's markers are carried
  // forward verbatim, but review-complete is stripped (it is re-emitted only by a completed render).
  const placeholderOfFullReviewSticky = [
    "<!-- code-review -->",
    "<!-- reviewed-route: full review -->",
    roundsMarkerFor(1),
    FINDINGS_MARKER,
    "",
    "🔄 **Code review in progress** for `abc123d` — see the [workflow run](https://github.com/owner/repo/actions/runs/12345)",
  ].join("\n");
  // A first-review placeholder: no prior markers at all — an empty mechanic may supersede it.
  const firstReviewPlaceholderSticky = [
    "<!-- code-review -->",
    "",
    "🔄 **Code review in progress** for `abc123d`",
  ].join("\n");

  const writeEmptyMechanic = (): void => {
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({ schema_version: "0.5.0", summary: "s", verdict: "comment", findings: [] }),
    );
    writeFileSync(
      join(tmpDir, "envelope.json"),
      JSON.stringify({ ...baseEnvelope, route: "mechanic" }),
    );
  };

  const expectLeftInPlace = async (
    api: GhApi,
    calls: () => readonly RecordedCall[],
  ): Promise<void> => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(post(mkInput({ route: undefined }), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    // No patch, no new comment — the completed full review stays visible.
    expect(
      calls().some(
        (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
      ),
    ).toBe(false);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  };

  it("leaves a completed full review in place — the empty mechanic's clean pass is not a review round (route marker)", async () => {
    writeEmptyMechanic();
    const { api, calls } = mkMockGhApi(mkMocks(fullReviewSticky));
    await expectLeftInPlace(api, calls);
  });

  it("recognizes an OLD-CLI full review sticky (rounds history, no route marker) and still leaves it in place", async () => {
    writeEmptyMechanic();
    const { api, calls } = mkMockGhApi(mkMocks(oldCliFullReviewSticky));
    await expectLeftInPlace(api, calls);
  });

  it("does NOT leave a completed MECHANIC sticky in place — same-route superseding is normal", async () => {
    writeEmptyMechanic();
    const { api, calls } = mkMockGhApi(mkMocks(mechanicSticky));
    await post(mkInput({ route: undefined }), api);
    const patchCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
    );
    expect(patchCall).toBeDefined();
    const body = (JSON.parse(patchCall!.stdin!) as CommentBody).body;
    expect(body).toContain("**route:** mechanic");
  });

  it("the route marker WINS over carried round history — a mechanic that carried a full review's rounds is still superseded by an empty mechanic", async () => {
    writeEmptyMechanic();
    const { api, calls } = mkMockGhApi(mkMocks(mechanicWithCarriedRoundsSticky));
    await post(mkInput({ route: undefined }), api);
    const patchCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
    );
    expect(patchCall).toBeDefined();
    const body = (JSON.parse(patchCall!.stdin!) as CommentBody).body;
    expect(body).toContain("**route:** mechanic");
  });

  const postExpectingExit = async (
    api: GhApi,
    calls: () => readonly RecordedCall[],
  ): Promise<string> => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(post(mkInput({ route: undefined }), api)).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    const patchCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
    );
    expect(patchCall).toBeDefined();
    const body = (JSON.parse(patchCall!.stdin!) as CommentBody).body;
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    return body;
  };

  it("replaces the ANNOUNCE PLACEHOLDER with a compact honest notice instead of a clean pass or a stale 'in progress' — the full review's markers are carried forward (review-complete is stripped, route + rounds + findings carried)", async () => {
    writeEmptyMechanic();
    const { api, calls } = mkMockGhApi(mkMocks(placeholderOfFullReviewSticky));
    const body = await postExpectingExit(api, calls);
    // Honest prose — never "No findings — clean review."
    expect(body).toContain("CI-fix pass completed with no findings");
    expect(body).not.toContain("clean review");
    expect(body).not.toContain("in progress");
    // The preserved full review's machine-readable record survives the swap.
    expect(body).toContain("reviewed-route: full review");
    expect(body).toContain("code-review:rounds;base64");
    expect(body).toContain("code-review:findings-json");
  });

  it("protects a PRE-ROUTE/PRE-ROUNDS full review through the placeholder via the carried completed-ancestor marker — no false clean pass", async () => {
    writeEmptyMechanic();
    // A markerless completed full review, then the announce placeholder replaced it: only the
    // findings + reviewed-sha + the completed-ancestor marker survive (no route, no rounds).
    const ancestorPlaceholderSticky = [
      "<!-- code-review -->",
      "<!-- reviewed-sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
      "<!-- review-complete-ancestor -->",
      "",
      "🔄 **Code review in progress** for `abc123d`",
    ].join("\n");
    const { api, calls } = mkMockGhApi(mkMocks(ancestorPlaceholderSticky));
    const body = await postExpectingExit(api, calls);
    expect(body).toContain("CI-fix pass completed with no findings");
    expect(body).not.toContain("clean review");
  });

  it("recognizes a MARKERLESS completed full review (review-complete only, predating route and rounds markers) and leaves it in place", async () => {
    writeEmptyMechanic();
    const { api, calls } = mkMockGhApi(mkMocks(markerlessFullReviewSticky));
    await expectLeftInPlace(api, calls);
  });

  it("an empty mechanic MAY supersede a first-review in-progress placeholder (no prior full review to bury)", async () => {
    writeEmptyMechanic();
    const { api, calls } = mkMockGhApi(mkMocks(firstReviewPlaceholderSticky));
    await post(mkInput({ route: undefined }), api);
    const patchCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
    );
    expect(patchCall).toBeDefined();
  });

  it("an empty mechanic with a LOST result envelope still cannot bury a completed full review — the route travels as --route", async () => {
    writeEmptyMechanic();
    // Point the envelope at a missing file ⇒ loadEnvelope returns null ⇒ the envelope-less path.
    const { api, calls } = mkMockGhApi(mkMocks(fullReviewSticky));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      post(
        mkInput({ route: "mechanic", envelopePath: join(tmpDir, "missing-envelope.json") }),
        api,
      ),
    ).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(
      calls().some(
        (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
      ),
    ).toBe(false);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("a mechanic WITH findings still supersedes a completed full review (its fixes are the actionable output)", async () => {
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({
        schema_version: "0.5.0",
        summary: "s",
        verdict: "comment",
        findings: [mkFinding({ start_line: 10, end_line: 10, severity: "critical" })],
      }),
    );
    writeFileSync(
      join(tmpDir, "envelope.json"),
      JSON.stringify({ ...baseEnvelope, route: "mechanic" }),
    );
    const { api, calls } = mkMockGhApi(mkMocks(fullReviewSticky));
    await post(mkInput({ route: undefined }), api);
    const patchCall = calls().find(
      (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
    );
    expect(patchCall).toBeDefined();
    const body = (JSON.parse(patchCall!.stdin!) as CommentBody).body;
    expect(body).toContain("**route:** mechanic");
    expect(body).toContain("🔴");
  });
});

describe("post — convergence rounds (issue #125)", () => {
  // A prior sticky carrying `n` rounds; `complete` + `sha` model a re-review of an already-reviewed
  // head. Every prior round is {major: 1} — score 2 at the default threshold 1 — and the embedded
  // surfaced blob carries that round's signal (round `signalRound`, defaulting to the round count),
  // so a non-round post can carry it forward verbatim. `blobLink` models an oversized prior review:
  // the findings marker fell to the link form and only the compact signal marker remains.
  const mocksWithPriorSticky = (
    opts: {
      rounds?: number;
      complete?: boolean;
      sha?: string;
      signalRound?: number;
      blobLink?: boolean;
    } = {},
  ) => {
    const rounds = opts.rounds ?? 1;
    const signal = {
      round: opts.signalRound ?? rounds,
      convergence: { score: 2, threshold: 1, converged: false },
    };
    const priorBlob = JSON.stringify({
      schema_version: "0.7.0",
      summary: "prior review",
      verdict: "comment",
      findings: [],
      ...signal,
    });
    const findingsMarker = opts.blobLink
      ? `<!-- code-review:findings-json https://artifacts.example.com/prior.zip -->\\n<!-- code-review:signal;base64 ${Buffer.from(JSON.stringify({ schema_version: "0.7.0", ...signal }), "utf-8").toString("base64")} -->`
      : `<!-- code-review:findings-json;base64 ${Buffer.from(priorBlob, "utf-8").toString("base64")} -->`;
    const markers = [
      opts.complete ? "<!-- review-complete -->" : "",
      opts.sha ? `<!-- reviewed-sha: ${opts.sha} -->` : "",
      findingsMarker,
      roundsMarkerFor(rounds),
    ]
      .filter(Boolean)
      .join("\\n");
    return [
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
        response: `{"id": 999, "body": "<!-- code-review -->\\n${markers}\\nold"}\n`,
      },
      {
        match: (a: readonly string[]) => a[0] === "repos/owner/repo/issues/comments/999",
        response: "",
      },
      {
        match: (a: readonly string[]) =>
          a[0] === "repos/owner/repo/pulls/42/comments" && a.includes("--paginate"),
        response: "",
      },
      {
        match: (a: readonly string[]) => a[0] === "repos/owner/repo/pulls/42/reviews",
        response: "",
      },
    ];
  };

  const patchedBody = (calls: readonly RecordedCall[]): string =>
    (
      JSON.parse(
        calls.find((c) => c.args[0] === "repos/owner/repo/issues/comments/999")!.stdin!,
      ) as CommentBody
    ).body;

  // How many rounds the carried marker encodes — the append/carry signal that survives even when the
  // trajectory LINE is hidden (an incomplete notice embeds the marker but renders no line).
  const roundsInMarker = (body: string): number => {
    const b64 = /code-review:rounds;base64 ([A-Za-z0-9+/=]+)/.exec(body)?.[1];
    return b64 === undefined
      ? 0
      : (JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as unknown[]).length;
  };

  it("a full review APPENDS a round — the trajectory grows", async () => {
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    await post(mkInput({ route: "full review" }), api);
    expect(patchedBody(calls())).toContain("**Round 2**");
  });

  it("reads the route from the ENVELOPE when --route is absent (the production path)", async () => {
    // The workflow does not pass --route; the review job stamps it in the envelope. If the append
    // gated on input.route the feature would be inert in production — this pins the envelope path.
    writeFileSync(
      join(tmpDir, "envelope.json"),
      JSON.stringify({ ...baseEnvelope, route: "full review" }),
    );
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    await post(mkInput({ route: undefined }), api);
    const body = patchedBody(calls());
    expect(body).toContain("**Round 2**");
    // The production seam (issue #133): post passes an explicit convergenceRound=true, so the badge
    // renders through the real post→render path, not just render's fallback predicate.
    expect(body).toContain("**Convergence**");
  });

  it("a mechanic pass CARRIES the trajectory forward unchanged — not a review round", async () => {
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    await post(mkInput({ route: "mechanic" }), api);
    const body = patchedBody(calls());
    expect(body).toContain("**Round 1**");
    expect(body).not.toContain("**Round 2**");
    // post passes convergenceRound=false for a mechanic pass, so no badge (issue #133 r2/r3 fix).
    expect(body).not.toContain("**Convergence**");
  });

  it("an incomplete full review does NOT append a spurious 'clean' round", async () => {
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({ schema_version: "0.4.0", summary: "s", verdict: "error", findings: [] }),
    );
    writeFileSync(
      join(tmpDir, "envelope.json"),
      JSON.stringify({ ...baseEnvelope, route: "full review" }),
    );
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    await post(mkInput({ route: "full review" }), api);
    const body = patchedBody(calls());
    // The marker carries the prior round forward (not appended to 2), and a "did not complete" notice
    // renders no trajectory line at all.
    expect(roundsInMarker(body)).toBe(1);
    expect(body).not.toContain("**Round");
  });

  it("a same-head re-run APPENDS again — an identical chip reads as 'no change' (a reviewed-sha-keyed replace is unsafe: a mechanic stamps a new head without a round)", async () => {
    const sha = "a".repeat(40);
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 2, complete: true, sha }));
    await post(mkInput({ route: "full review", headSha: sha }), api);
    expect(patchedBody(calls())).toContain("**Round 3**");
  });

  it("a full review APPENDS a round carrying the round's mechanism codes (#145)", async () => {
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify(
        mkFindings([
          mkFinding({ code: "null-check-missing" }),
          mkFinding({ code: "null-check-missing" }),
        ]),
      ),
    );
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 0 }));
    await post(mkInput({ route: "full review" }), api);
    const body = patchedBody(calls());
    const b64 = /code-review:rounds;base64 ([A-Za-z0-9+/=]+)/.exec(body)?.[1];
    expect(b64).toBeDefined();
    const rounds = JSON.parse(Buffer.from(b64!, "base64").toString("utf-8")) as RoundRecord[];
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.codes).toEqual({ "null-check-missing": 2 });
  });

  it("a mechanic pass carries the trajectory forward with no code append (#145)", async () => {
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify(mkFindings([mkFinding({ code: "null-check-missing" })])),
    );
    // A prior round that DOES carry codes — the mechanic pass must preserve it verbatim (no round,
    // no code-map append), not degrade it to "undefined" (issue #145 r2 nit 6).
    const codedMarker = `<!-- code-review:rounds;base64 ${Buffer.from(
      JSON.stringify([
        { critical: 0, major: 1, minor: 0, nit: 0, codes: { "null-check-missing": 1 } },
      ]),
      "utf-8",
    ).toString("base64")} -->`;
    const { api, calls } = mkMockGhApi(mkMocks(`<!-- code-review -->\n${codedMarker}\nold`));
    await post(mkInput({ route: "mechanic" }), api);
    const body = patchedBody(calls());
    const b64 = /code-review:rounds;base64 ([A-Za-z0-9+/=]+)/.exec(body)?.[1];
    expect(b64).toBeDefined();
    const rounds = JSON.parse(Buffer.from(b64!, "base64").toString("utf-8")) as RoundRecord[];
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.codes).toEqual({ "null-check-missing": 1 });
  });

  it("renders a same-root note under a stray finding whose code recurred in a prior round (#145)", async () => {
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify(mkFindings([mkFinding({ path: "src/other.ts", code: "null-check-missing" })])),
    );
    const codedMarker = `<!-- code-review:rounds;base64 ${Buffer.from(
      JSON.stringify([
        { critical: 0, major: 0, minor: 1, nit: 0, codes: { "null-check-missing": 1 } },
      ]),
      "utf-8",
    ).toString("base64")} -->`;
    const { api, calls } = mkMockGhApi(mkMocks(`<!-- code-review -->\n${codedMarker}\nold`));
    await post(mkInput({ route: "full review" }), api);
    const body = patchedBody(calls());
    expect(body).toContain("Same mechanism as round 1");
  });

  interface DecodedBlob {
    readonly schema_version: string;
    readonly round?: number;
    readonly convergence?: {
      readonly score: number;
      readonly threshold: number;
      readonly converged: boolean;
    };
  }

  // The surfaced findings blob embedded in whichever sticky write this run made (patch or post).
  const decodedBlob = (calls: readonly RecordedCall[]): DecodedBlob => {
    const sticky = calls.find(
      (c) =>
        (c.args[0] === "repos/owner/repo/issues/comments/999" ||
          c.args[0] === "repos/owner/repo/issues/42/comments") &&
        c.stdin !== undefined,
    );
    const body = (JSON.parse(sticky?.stdin ?? "{}") as CommentBody).body;
    const b64 = /code-review:findings-json;base64 ([A-Za-z0-9+/=]+)/.exec(body)?.[1];
    if (b64 === undefined) throw new Error("no embedded findings marker in the sticky");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as DecodedBlob;
  };

  it("a full review's blob carries round + convergence from the round just appended (issue #141)", async () => {
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    await post(mkInput({ route: "full review" }), api);
    const blob = decodedBlob(calls());
    expect(blob.schema_version).toBe("0.7.0");
    expect(blob.round).toBe(2);
    // The default fixture findings are one minor → score 1 at the default threshold 1 → converged.
    expect(blob.convergence).toEqual({ score: 1, threshold: 1, converged: true });
  });

  it("the blob's convergence uses the ROUND counts (findings + systemic), never diverging from the badge — a systemic major beside a nit-only finding reads iterating (issue #134 merge)", async () => {
    // The round history (computeRoundCounts) folds systemic severities in; the blob signal must use
    // the SAME counts or a doc whose systemic items cross the threshold would embed `converged: true`
    // beside a badge that reads iterating.
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({
        ...mkFindings([mkFinding({ severity: "nit" })]),
        systemic_problems: [
          { title: "t", description: "d", severity: "major", reasoning: "r", confidence: 0.8 },
        ],
      }),
    );
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 0 }));
    await post(mkInput({ route: "full review" }), api);
    const blob = decodedBlob(calls());
    expect(blob.round).toBe(1);
    // major=2 > threshold 1 → iterating, exactly what the badge would render for this round.
    expect(blob.convergence).toEqual({ score: 2, threshold: 1, converged: false });
  });

  it("a mechanic pass carries the last completed round's convergence forward in its blob (issue #141 item 3)", async () => {
    // The prior round is {major: 1} → score 2 > threshold 1 → iterating; a mechanic is not a round.
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    await post(mkInput({ route: "mechanic" }), api);
    const blob = decodedBlob(calls());
    expect(blob.round).toBe(1);
    expect(blob.convergence).toEqual({ score: 2, threshold: 1, converged: false });
  });

  it("an incomplete full review embeds NO signal in its blob but preserves the prior signal in the compact marker (issue #141 review r2 + r3)", async () => {
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({ schema_version: "0.4.0", summary: "s", verdict: "error", findings: [] }),
    );
    writeFileSync(
      join(tmpDir, "envelope.json"),
      JSON.stringify({ ...baseEnvelope, route: "full review" }),
    );
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    await post(mkInput({ route: "full review" }), api);
    const blob = decodedBlob(calls());
    expect(blob.schema_version).toBe("0.7.0");
    expect(blob.convergence).toBeUndefined();
    expect(blob.round).toBeUndefined();
    // The notice never claims a signal itself, but the prior round's `converged` survives on the
    // sticky in the compact marker — the next post still reads it back via parseSignalMarker.
    const body = patchedBody(calls());
    expect(body).toContain("code-review:signal;base64");
    expect(parseSignalMarker(body)).toEqual({
      round: 1,
      convergence: { score: 2, threshold: 1, converged: false },
    });
  });

  it("a first-run mechanic pass (no prior round) embeds no convergence — there is no stop signal yet", async () => {
    const { api, calls } = mkMockGhApi([
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
    ]);
    await post(mkInput({ route: "mechanic" }), api);
    const blob = decodedBlob(calls());
    expect(blob.schema_version).toBe("0.7.0");
    expect(blob.convergence).toBeUndefined();
    expect(blob.round).toBeUndefined();
  });

  it("an incomplete run whose findings carry a non-error verdict still embeds NO signal — incompleteness, not the verdict, is the gate (issue #141 review r4)", async () => {
    // envelope.incomplete=true with a "comment" verdict: the run did not complete, so its blob must
    // not claim a carried "converged"; the prior signal survives in the compact marker instead.
    writeFileSync(
      join(tmpDir, "envelope.json"),
      JSON.stringify({ ...baseEnvelope, route: "full review", incomplete: true }),
    );
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    await post(mkInput({ route: "full review" }), api);
    const blob = decodedBlob(calls());
    expect(blob.convergence).toBeUndefined();
    expect(blob.round).toBeUndefined();
    const body = patchedBody(calls());
    expect(body).toContain("code-review:signal;base64");
    expect(parseSignalMarker(body)).toEqual({
      round: 1,
      convergence: { score: 2, threshold: 1, converged: false },
    });
  });

  it("a mechanic pass carries the prior round's signal VERBATIM — a changed current threshold must not flip it (issue #141 review)", async () => {
    // The prior round was judged at threshold 1 (score 2 → not converged); the operator now
    // configures threshold 3. Recomputing the carried signal would flip it to converged — the blob
    // must keep the round's own threshold and verdict.
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    await post(mkInput({ route: "mechanic", convergenceThreshold: 3 }), api);
    const blob = decodedBlob(calls());
    expect(blob.convergence).toEqual({ score: 2, threshold: 1, converged: false });
  });

  it("an envelope-loss NOTICE embeds no signal in its blob (same rule as every error-verdict post)", async () => {
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify({ schema_version: "0.4.0", summary: "s", verdict: "error", findings: [] }),
    );
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(
      post(mkInput({ envelopePath: join(tmpDir, "no-envelope.json") }), api),
    ).rejects.toThrow("exit");
    exitSpy.mockRestore();
    const blob = decodedBlob(calls());
    expect(blob.convergence).toBeUndefined();
    expect(blob.round).toBeUndefined();
  });

  it("an envelope-loss post of a REAL review carries the prior signal — the run is a review, its round history is the last completed round (issue #141 review r2)", async () => {
    // The default fixture findings (verdict comment, one minor) with the envelope missing: the
    // envelope-null branch renders a real review, and its blob carries the prior round's signal
    // verbatim — never re-derived, never dropped.
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1 }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(
      post(mkInput({ envelopePath: join(tmpDir, "no-envelope.json") }), api),
    ).rejects.toThrow("exit");
    exitSpy.mockRestore();
    const blob = decodedBlob(calls());
    expect(blob.round).toBe(1);
    expect(blob.convergence).toEqual({ score: 2, threshold: 1, converged: false });
  });

  it("a completing round never regresses the round counter — the carried count wins when the rounds marker lost an entry (issue #141 review r2)", async () => {
    // The prior blob's carried signal says round 2 while the rounds marker holds only 1 entry (a
    // corrupt round was filtered by parseRounds) — the new round must be 3, never 2 again.
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1, signalRound: 2 }));
    await post(mkInput({ route: "full review" }), api);
    const blob = decodedBlob(calls());
    expect(blob.round).toBe(3);
    expect(blob.convergence).toEqual({ score: 1, threshold: 1, converged: true });
  });

  it("an oversized prior review's signal survives via the compact marker — a mechanic still carries it (issue #141 review r2)", async () => {
    // The prior sticky's findings marker fell to the link form (payload over EMBED_LIMIT); only the
    // compact signal marker remains, and the carry must still find it.
    const { api, calls } = mkMockGhApi(mocksWithPriorSticky({ rounds: 1, blobLink: true }));
    await post(mkInput({ route: "mechanic" }), api);
    const blob = decodedBlob(calls());
    expect(blob.round).toBe(1);
    expect(blob.convergence).toEqual({ score: 2, threshold: 1, converged: false });
  });
});

describe("post — answered findings (issue #151)", () => {
  // The full post-call mock surface, with the answered-thread fetch returning the given rows. The
  // thread mock comes FIRST so it wins over mkMocks' default empty one (first match wins).
  const withThreads = (threads: string): ReturnType<typeof mkMocks> => [
    {
      match: (a: readonly string[]) =>
        a[0] === "repos/owner/repo/pulls/42/comments" && a.includes("--paginate"),
      response: threads,
    },
    ...mkMocks("<!-- code-review -->\nold"),
  ];

  const threadRows = (finding: Finding): string =>
    [
      JSON.stringify({
        id: 101,
        in_reply_to_id: null,
        user_login: "github-actions[bot]",
        body: findingPointer(finding, "0.6.0"),
        html_url: "https://github.com/owner/repo/pull/42#discussion_r101",
        path: "src/foo.ts",
        line: 10,
        created_at: "2026-07-01T00:00:00Z",
      }),
      JSON.stringify({
        id: 102,
        in_reply_to_id: 101,
        user_login: "alice",
        body: "Measured on the built extension: the claim does not hold.",
        html_url: "https://github.com/owner/repo/pull/42#discussion_r102",
        path: "src/foo.ts",
        line: 10,
        created_at: "2026-07-01T01:00:00Z",
      }),
    ].join("\n");

  const patchedBody = (calls: readonly RecordedCall[]): string =>
    (
      JSON.parse(
        calls.find((c) => c.args[0] === "repos/owner/repo/issues/comments/999")!.stdin!,
      ) as CommentBody
    ).body;

  const decodedBlob = (calls: readonly RecordedCall[]): { readonly convergence?: unknown } => {
    const sticky = calls.find(
      (c) => c.args[0] === "repos/owner/repo/issues/comments/999" && c.stdin !== undefined,
    );
    const body = (JSON.parse(sticky?.stdin ?? "{}") as CommentBody).body;
    const b64 = /code-review:findings-json;base64 ([A-Za-z0-9+/=]+)/.exec(body)?.[1];
    if (b64 === undefined) throw new Error("no embedded findings marker in the sticky");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as {
      readonly convergence?: unknown;
    };
  };

  it("treats a VERBATIM re-raise of an answered finding as closed — dropped from the review, the round counts, and the stop signal, named in the sticky", async () => {
    const answered = mkFinding({
      code: "recurring-a",
      title: "The same claim",
      reasoning: "The same reasoning.",
    });
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(mkFindings([answered])));
    const { api, calls } = mkMockGhApi(withThreads(threadRows(answered)));
    await post(mkInput({ route: "full review" }), api);
    const body = patchedBody(calls());
    // The finding itself is gone from the surfaced review…
    expect(body).not.toContain("The same claim");
    // …but the suppression is named, with the prior answer linked.
    expect(body).toContain("treated as answered");
    expect(body).toContain("discussion_r102");
    // The round counts and the stop signal reflect the dismissal: the dropped finding is a minor,
    // so this round is clean and reads converged — it does not block convergence.
    const blob = decodedBlob(calls()) as { readonly convergence?: { readonly score: number } };
    expect(blob.convergence).toEqual({ score: 0, threshold: 1, converged: true });
  });

  it("keeps a re-raise with NEW evidence and annotates it with the prior answer's link — inline and sticky", async () => {
    const answered = mkFinding({
      code: "recurring-a",
      title: "The same claim",
      reasoning: "The same reasoning.",
    });
    const changed = mkFinding({
      code: "recurring-a",
      title: "The same claim",
      reasoning: "NEW evidence: the regression persists on the built 3.14 extension.",
    });
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(mkFindings([changed])));
    const { api, calls } = mkMockGhApi(withThreads(threadRows(answered)));
    await post(mkInput({ route: "full review" }), api);
    const body = patchedBody(calls());
    // The finding is in-diff, so it posts inline — the sticky shows the count, never the drop note.
    expect(body).toContain("**Findings:** 🔵 1");
    expect(body).not.toContain("treated as answered");
    // The inline comment carries the finding AND the "re-raised; prior answer" annotation.
    const review = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(review).toBeDefined();
    const payload = JSON.parse(review!.stdin!) as ReviewBody;
    expect(payload.comments.some((c) => c.body.includes("The same claim"))).toBe(true);
    expect(payload.comments.some((c) => c.body.includes("Re-raised; prior answer at"))).toBe(true);
    expect(payload.comments.some((c) => c.body.includes("discussion_r102"))).toBe(true);
  });

  it("never drops a CRITICAL verbatim re-raise — kept with the annotation", async () => {
    const answered = mkFinding({
      severity: "critical",
      code: "recurring-a",
      title: "The same claim",
      reasoning: "The same reasoning.",
    });
    writeFileSync(join(tmpDir, "findings.json"), JSON.stringify(mkFindings([answered])));
    const { api, calls } = mkMockGhApi(withThreads(threadRows(answered)));
    await post(mkInput({ route: "full review" }), api);
    const body = patchedBody(calls());
    expect(body).toContain("**Findings:** 🔴 1");
    expect(body).not.toContain("treated as answered");
    // The kept critical posts inline, annotated.
    const review = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(review).toBeDefined();
    const payload = JSON.parse(review!.stdin!) as ReviewBody;
    expect(payload.comments.some((c) => c.body.includes("Re-raised; prior answer at"))).toBe(true);
  });

  it("a failed thread fetch degrades to an empty registry — the review posts unfiltered", async () => {
    writeFileSync(
      join(tmpDir, "findings.json"),
      JSON.stringify(mkFindings([mkFinding({ code: "recurring-a" })])),
    );
    // No mock for the thread endpoint ⇒ the fetch rejects ⇒ warning + empty registry.
    const { api, calls } = mkMockGhApi(mkMocks("<!-- code-review -->\nold"));
    await post(mkInput({ route: "full review" }), api);
    const body = patchedBody(calls());
    expect(body).not.toContain("treated as answered");
    // The finding posts normally, prose inline (the sticky's in-diff finding lives in the review).
    const review = calls().find(
      (c) => c.args[0] === "repos/owner/repo/pulls/42/reviews" && c.stdin !== undefined,
    );
    expect(review).toBeDefined();
    const payload = JSON.parse(review!.stdin!) as ReviewBody;
    expect(payload.comments.some((c) => c.body.includes("Test finding"))).toBe(true);
  });
});
