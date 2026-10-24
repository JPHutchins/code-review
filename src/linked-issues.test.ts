import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhApi } from "./gh.js";
import {
  COMMENT_READ_CONCURRENCY,
  LINKED_ISSUES_DIR,
  LINKED_ISSUES_INDEX,
  READABLE_LINE_CHARS,
  stageLinkedIssues,
} from "./linked-issues.js";

let outDir: string;
const spyOnStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);
let stderr: ReturnType<typeof spyOnStderr>;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "linked-issues-"));
  stderr = spyOnStderr();
});

afterEach(() => {
  stderr.mockRestore();
  rmSync(outDir, { recursive: true, force: true });
});

const issueNode = (
  repository: string,
  number: number,
  body: string | null = `body of ${String(number)}`,
) => ({
  number,
  title: `issue ${String(number)}`,
  body,
  url: `https://github.com/${repository}/issues/${String(number)}`,
  state: "OPEN",
  createdAt: "2026-10-01T00:00:00Z",
  authorAssociation: "NONE",
  author: { login: "reporter" },
  repository: { nameWithOwner: repository },
});

const commentRow = (author: string, body: string) =>
  JSON.stringify({
    author,
    author_association: "CONTRIBUTOR",
    created_at: "2026-10-02T00:00:00Z",
    url: "https://github.com/x/y/issues/1#issuecomment-1",
    body,
  });

type Reply = string | Error;

const ghWith = (closing: Reply, comments: Readonly<Record<string, Reply>> = {}) => {
  const calls: (readonly string[])[] = [];
  const api: GhApi = (args) => {
    calls.push(args);
    const reply =
      args[0] === "graphql"
        ? closing
        : (comments[args[0] ?? ""] ?? new Error(`unexpected ${args.join(" ")}`));
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { api, calls };
};

const closingReply = (nodes: readonly unknown[], totalCount = nodes.length): string =>
  JSON.stringify({ totalCount, nodes });

const staged = (...path: readonly string[]): string =>
  readFileSync(join(outDir, LINKED_ISSUES_DIR, ...path), "utf-8");
const stagedJson = (...path: readonly string[]): unknown => JSON.parse(staged(...path)) as unknown;
const folder = (): string => join(outDir, LINKED_ISSUES_DIR);

const warnings = (): readonly string[] =>
  stderr.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((line) => line.startsWith("::warning::"));

describe("stageLinkedIssues — every issue the PR closes, with every comment, one folder each", () => {
  it("stages this repo's issue and another's: who wrote what in issue.json, the text in body.md and comment files", async () => {
    const { api, calls } = ghWith(
      closingReply([issueNode("owner/repo", 7), issueNode("other-org/lib_x", 12)]),
      {
        "repos/owner/repo/issues/7/comments": [
          commentRow("alice", "first"),
          commentRow("bob", "a reply with the real repro\nline two"),
        ].join("\n"),
        "repos/other-org/lib_x/issues/12/comments": "",
      },
    );

    expect(await stageLinkedIssues("owner/repo", 3, outDir, api)).toMatchObject({
      issues: 2,
      comments: 2,
    });

    expect(stagedJson(LINKED_ISSUES_INDEX)).toEqual({
      closes: 2,
      issues: [
        expect.objectContaining({ number: 7, folder: "owner__repo__7", comments: 2 }),
        expect.objectContaining({
          repository: "other-org/lib_x",
          folder: "other-org__lib_x__12",
          comments: 0,
        }),
      ],
    });
    expect(stagedJson("owner__repo__7", "issue.json")).toMatchObject({
      title: "issue 7",
      author: "reporter",
      author_association: "NONE",
      body: "body.md",
      comments: [
        { author: "alice", author_association: "CONTRIBUTOR", file: "comment-001.md" },
        { author: "bob", file: "comment-002.md" },
      ],
    });
    expect(staged("owner__repo__7", "body.md")).toBe("body of 7");
    expect(staged("owner__repo__7", "comment-002.md")).toBe(
      "a reply with the real repro\nline two",
    );
    expect(readdirSync(join(folder(), "other-org__lib_x__12")).sort()).toEqual([
      "body.md",
      "issue.json",
    ]);
    expect(
      calls
        .filter((args) => args[0]?.endsWith("/comments"))
        .every((args) => args.includes("--paginate")),
    ).toBe(true);
    expect(warnings()).toEqual([]);
  });

  it("folds a long line so every character is reachable a line at a time, and drops none", async () => {
    const longLine = "ab🎉".repeat(READABLE_LINE_CHARS);
    const { api } = ghWith(closingReply([issueNode("owner/repo", 7, `head\n${longLine}`)]), {
      "repos/owner/repo/issues/7/comments": "",
    });
    await stageLinkedIssues("owner/repo", 3, outDir, api);
    const lines = staged("owner__repo__7", "body.md").split("\n");
    expect(lines.every((line) => Array.from(line).length <= READABLE_LINE_CHARS)).toBe(true);
    expect(lines.slice(1).join("")).toBe(longLine);
  });

  it("asks for the PR's closing issues by owner, name and number", async () => {
    const { api, calls } = ghWith(closingReply([]));
    await stageLinkedIssues("owner/repo", 42, outDir, api);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["graphql", "owner=owner", "name=repo", "number=42"]),
    );
    expect(calls[0]?.some((arg) => arg.includes("closingIssuesReferences"))).toBe(true);
  });

  it("writes no folder when the PR closes no issue, and clears one a previous gather left", async () => {
    mkdirSync(join(folder(), "owner__repo__1"), { recursive: true });
    writeFileSync(join(folder(), "owner__repo__1", "body.md"), "a previous PR's issue");
    const { api } = ghWith(closingReply([]));
    expect(await stageLinkedIssues("owner/repo", 3, outDir, api)).toEqual({
      issues: 0,
      comments: 0,
      bytes: 0,
    });
    expect(existsSync(folder())).toBe(false);
  });

  it("holds exactly the folders the index lists, whatever a previous gather left", async () => {
    mkdirSync(join(folder(), "owner__repo__1"), { recursive: true });
    const { api } = ghWith(closingReply([issueNode("owner/repo", 7)]), {
      "repos/owner/repo/issues/7/comments": "",
    });
    await stageLinkedIssues("owner/repo", 3, outDir, api);
    expect(readdirSync(folder()).sort()).toEqual([LINKED_ISSUES_INDEX, "owner__repo__7"]);
  });

  it.each([
    ["the read fails", new Error("HTTP 502\n::error::forged")],
    ["the reply has the wrong shape", "null"],
  ])("writes no folder and warns on one line when %s", async (_case, reply) => {
    const { api } = ghWith(reply);
    expect((await stageLinkedIssues("owner/repo", 3, outDir, api)).issues).toBe(0);
    expect(existsSync(folder())).toBe(false);
    expect(warnings()).toHaveLength(1);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toMatch(/\n::error::/);
  });

  it("stages an issue whose comments could not be read as comments: null, and warns", async () => {
    const { api } = ghWith(closingReply([issueNode("owner/repo", 7, null)]), {
      "repos/owner/repo/issues/7/comments": new Error("HTTP 404"),
    });
    expect(await stageLinkedIssues("owner/repo", 3, outDir, api)).toMatchObject({
      issues: 1,
      comments: 0,
    });
    expect(stagedJson("owner__repo__7", "issue.json")).toMatchObject({ comments: null });
    expect(staged("owner__repo__7", "body.md")).toBe("");
    expect(stagedJson(LINKED_ISSUES_INDEX)).toMatchObject({
      issues: [expect.objectContaining({ comments: null })],
    });
    expect(warnings()).toEqual([expect.stringContaining("owner/repo#7")]);
  });

  it.each([
    [
      "more issues than one read returns",
      [issueNode("owner/repo", 7)],
      60,
      "closes 60 issues; only 1",
    ],
    ["issues the token cannot see", [null, null], 2, "closes 2 issues; only 0"],
  ])(
    "names the cut when the PR closes %s, and the index says how many it closes",
    async (_case, nodes, total, cut) => {
      const { api } = ghWith(closingReply(nodes, total), {
        "repos/owner/repo/issues/7/comments": "",
      });
      await stageLinkedIssues("owner/repo", 3, outDir, api);
      expect(warnings()).toEqual([expect.stringContaining(cut)]);
      if (existsSync(folder()))
        expect(stagedJson(LINKED_ISSUES_INDEX)).toMatchObject({ closes: total });
    },
  );

  it("stages nothing and warns, never throws, when the folder cannot be written", async () => {
    const blocked = join(outDir, "not-a-dir");
    writeFileSync(blocked, "a file where the out-dir should be");
    const { api } = ghWith(closingReply([issueNode("owner/repo", 7)]), {
      "repos/owner/repo/issues/7/comments": "",
    });
    expect(await stageLinkedIssues("owner/repo", 3, blocked, api)).toEqual({
      issues: 0,
      comments: 0,
      bytes: 0,
    });
    expect(warnings()).toEqual([expect.stringContaining("could not stage")]);
  });

  it(`reads at most ${String(COMMENT_READ_CONCURRENCY)} issues' comments at once, and stages them all`, async () => {
    const issues = Array.from({ length: 20 }, (_, i) => issueNode("owner/repo", i + 1));
    const inFlight = { now: 0, peak: 0 };
    const api: GhApi = async (args) => {
      if (args[0] === "graphql") return closingReply(issues);
      inFlight.now += 1;
      inFlight.peak = Math.max(inFlight.peak, inFlight.now);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight.now -= 1;
      return "";
    };
    expect((await stageLinkedIssues("owner/repo", 3, outDir, api)).issues).toBe(20);
    expect(inFlight.peak).toBeLessThanOrEqual(COMMENT_READ_CONCURRENCY);
    expect(inFlight.peak).toBeGreaterThan(1);
    expect(readdirSync(folder())).toHaveLength(21);
  });
});
