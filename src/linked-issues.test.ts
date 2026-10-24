import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhApi } from "./gh.js";
import { LINKED_ISSUES_DIR, LINKED_ISSUES_INDEX, stageLinkedIssues } from "./linked-issues.js";

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

const staged = (file: string): unknown =>
  JSON.parse(readFileSync(join(outDir, LINKED_ISSUES_DIR, file), "utf-8")) as unknown;

const warnings = (): readonly string[] =>
  stderr.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((line) => line.startsWith("::warning::"));

describe("stageLinkedIssues — every issue the PR closes, with every comment, in one folder", () => {
  it("stages each issue, this repo's and another's, with all its comments verbatim, and indexes them", async () => {
    const longBody = "x".repeat(70_000);
    const { api, calls } = ghWith(
      closingReply([issueNode("owner/repo", 7), issueNode("other-org/lib_x", 12, longBody)]),
      {
        "repos/owner/repo/issues/7/comments": [
          commentRow("alice", "first page"),
          commentRow("bob", "second page, a reply with the real repro"),
        ].join("\n"),
        "repos/other-org/lib_x/issues/12/comments": "",
      },
    );

    const result = await stageLinkedIssues("owner/repo", 3, outDir, api);

    expect(result).toMatchObject({ issues: 2, comments: 2 });
    expect(staged(LINKED_ISSUES_INDEX)).toEqual([
      expect.objectContaining({
        repository: "owner/repo",
        number: 7,
        comments: 2,
        file: "owner__repo__7.json",
      }),
      expect.objectContaining({
        repository: "other-org/lib_x",
        number: 12,
        comments: 0,
        file: "other-org__lib_x__12.json",
      }),
    ]);
    expect(staged("owner__repo__7.json")).toMatchObject({
      title: "issue 7",
      body: "body of 7",
      author: "reporter",
      comments: [
        expect.objectContaining({ author: "alice", body: "first page" }),
        expect.objectContaining({
          author: "bob",
          body: "second page, a reply with the real repro",
        }),
      ],
    });
    expect(staged("other-org__lib_x__12.json")).toMatchObject({ body: longBody, comments: [] });
    const commentReads = calls.filter((args) => args[0]?.endsWith("/comments"));
    expect(commentReads.every((args) => args.includes("--paginate"))).toBe(true);
    expect(warnings()).toEqual([]);
  });

  it("asks for the PR's closing issues by owner, name and number", async () => {
    const { api, calls } = ghWith(closingReply([]));
    await stageLinkedIssues("owner/repo", 42, outDir, api);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["graphql", "owner=owner", "name=repo", "number=42"]),
    );
    expect(calls[0]?.some((arg) => arg.includes("closingIssuesReferences"))).toBe(true);
  });

  it("writes no folder when the PR closes no issue", async () => {
    const { api } = ghWith(closingReply([]));
    expect(await stageLinkedIssues("owner/repo", 3, outDir, api)).toEqual({
      issues: 0,
      comments: 0,
      bytes: 0,
    });
    expect(existsSync(join(outDir, LINKED_ISSUES_DIR))).toBe(false);
  });

  it.each([
    ["the read fails", new Error("HTTP 502\n::error::forged")],
    ["the reply has the wrong shape", "null"],
  ])("writes no folder and warns on one line when %s", async (_case, reply) => {
    const { api } = ghWith(reply);
    expect((await stageLinkedIssues("owner/repo", 3, outDir, api)).issues).toBe(0);
    expect(existsSync(join(outDir, LINKED_ISSUES_DIR))).toBe(false);
    expect(warnings()).toHaveLength(1);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toMatch(/\n::error::/);
  });

  it("stages an issue whose comments could not be read, marked unread, and warns", async () => {
    const { api } = ghWith(closingReply([issueNode("owner/repo", 7, null)]), {
      "repos/owner/repo/issues/7/comments": new Error("HTTP 404"),
    });
    expect(await stageLinkedIssues("owner/repo", 3, outDir, api)).toMatchObject({
      issues: 1,
      comments: 0,
    });
    expect(staged("owner__repo__7.json")).toMatchObject({ body: "", comments: null });
    expect(staged(LINKED_ISSUES_INDEX)).toEqual([expect.objectContaining({ comments: null })]);
    expect(warnings()).toEqual([expect.stringContaining("owner/repo#7")]);
  });

  it("names the cut when the PR closes more issues than one read returns", async () => {
    const { api } = ghWith(closingReply([issueNode("owner/repo", 7)], 60), {
      "repos/owner/repo/issues/7/comments": "",
    });
    await stageLinkedIssues("owner/repo", 3, outDir, api);
    expect(warnings()).toEqual([expect.stringContaining("closes 60 issues; only the first 1")]);
    expect(readdirSync(join(outDir, LINKED_ISSUES_DIR)).sort()).toEqual([
      LINKED_ISSUES_INDEX,
      "owner__repo__7.json",
    ]);
  });
});
