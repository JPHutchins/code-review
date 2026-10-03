import { describe, it, expect } from "vitest";
import {
  harvestResponses,
  parseResponseLines,
  RESPONSE_REASON_CLIP_CHARS,
  RESPONSES_PER_CHANNEL,
  ResponsesFileCodec,
  type HarvestInput,
} from "./responses.js";

describe("parseResponseLines — the response grammar", () => {
  it("reads the id, the disposition and the reason, whatever separator follows the verb", () => {
    expect(
      parseResponseLines(
        [
          "Review-Response: null-check-missing fixed — guarded at the call site",
          "Review-Response: retry-unbounded refuted: the loop is bounded by MAX_TRIES",
          "Review-Response: a-class dismissed - tracked in #12",
          "Review-Response: other fixed—no space before the dash",
        ].join("\n"),
      ),
    ).toEqual([
      { id: "null-check-missing", disposition: "fixed", reason: "guarded at the call site" },
      {
        id: "retry-unbounded",
        disposition: "refuted",
        reason: "the loop is bounded by MAX_TRIES",
      },
      { id: "a-class", disposition: "dismissed", reason: "tracked in #12" },
      { id: "other", disposition: "fixed", reason: "no space before the dash" },
    ]);
  });

  it("matches the key and the verb case-insensitively, like a git trailer", () => {
    expect(parseResponseLines("review-response: x-y FIXED")).toEqual([
      { id: "x-y", disposition: "fixed", reason: "" },
    ]);
  });

  it("ignores a verb outside the vocabulary, and an id that is not id-shaped", () => {
    expect(parseResponseLines("Review-Response: x-y accepted — fine")).toEqual([]);
    expect(parseResponseLines("Review-Response: <id> fixed — the template")).toEqual([]);
    expect(parseResponseLines("Review-Response: src/a.ts fixed")).toEqual([]);
  });

  it("never reads a quoted, inline-code, or fenced copy of the grammar as a response", () => {
    const quoting = [
      "> Review-Response: quoted fixed — someone else's line",
      "Write `Review-Response: inline fixed` to answer.",
      "```",
      "Review-Response: fenced fixed — an example",
      "```",
      "~~~",
      "Review-Response: tilde-fenced fixed",
      "~~~",
      "Review-Response: real fixed — after the fences",
    ].join("\n");
    expect(parseResponseLines(quoting)).toEqual([
      { id: "real", disposition: "fixed", reason: "after the fences" },
    ]);
  });

  it("clips a long reason and marks the cut", () => {
    const [line] = parseResponseLines(`Review-Response: x refuted ${"r".repeat(1000)}`);
    expect(line?.reason.startsWith("r".repeat(RESPONSE_REASON_CLIP_CHARS))).toBe(true);
    expect(line?.reason).toContain("[truncated]");
  });
});

describe("harvestResponses — the implementer's answers to the prior round", () => {
  const input = (overrides: Partial<HarvestInput> = {}): HarvestInput => ({
    repo: "o/r",
    prNumber: 7,
    botLogin: "github-actions[bot]",
    priorIds: new Set(["known-id", "a-class"]),
    commits: [],
    comments: [],
    ...overrides,
  });

  it("keeps responses to ids the prior round reported, with each source's link and author", () => {
    const harvest = harvestResponses(
      input({
        commits: [
          {
            sha: "abc123",
            message: "fix\n\nReview-Response: known-id fixed — guarded",
            author: "Dev",
          },
        ],
        comments: [
          {
            id: 99,
            body: "Review-Response: a-class dismissed — out of scope",
            user: { login: "maintainer" },
            created_at: "2026-10-01T00:00:00Z",
            author_association: "OWNER",
          },
        ],
      }),
    );
    expect(harvest.responses).toEqual([
      {
        id: "a-class",
        disposition: "dismissed",
        reason: "out of scope",
        channel: "comment",
        source_url: "https://github.com/o/r/pull/7#issuecomment-99",
        author: "maintainer",
        author_association: "OWNER",
        created_at: "2026-10-01T00:00:00Z",
      },
      {
        id: "known-id",
        disposition: "fixed",
        reason: "guarded",
        channel: "commit",
        source_url: "https://github.com/o/r/commit/abc123",
        author: "Dev",
        author_association: null,
        created_at: null,
      },
    ]);
    expect(harvest.unmatched).toEqual([]);
    expect(ResponsesFileCodec.is(harvest)).toBe(true);
  });

  it("echoes a response to an id the prior round never reported as unmatched, never dropping it silently", () => {
    const harvest = harvestResponses(
      input({ commits: [{ sha: "s", message: "Review-Response: typo-id fixed", author: null }] }),
    );
    expect(harvest.responses).toEqual([]);
    expect(harvest.unmatched).toEqual([
      { id: "typo-id", channel: "commit", source_url: "https://github.com/o/r/commit/s" },
    ]);
  });

  it("skips the bot's own comments", () => {
    const harvest = harvestResponses(
      input({
        comments: [
          {
            id: 1,
            body: "Review-Response: known-id fixed",
            user: { login: "github-actions[bot]" },
          },
        ],
      }),
    );
    expect(harvest.responses).toEqual([]);
  });

  it("keeps the newest answers when a channel exceeds the cap — comments by time, commits by order", () => {
    const many = RESPONSES_PER_CHANNEL + 5;
    const harvest = harvestResponses(
      input({
        comments: Array.from({ length: many }, (_, i) => ({
          id: i,
          body: `Review-Response: known-id fixed — comment ${String(i)}`,
          user: { login: "dev" },
          created_at: `2026-10-01T00:00:${String(i).padStart(2, "0")}Z`,
        })),
        commits: Array.from({ length: many }, (_, i) => ({
          sha: `c${String(i)}`,
          message: `Review-Response: known-id fixed — commit ${String(i)}`,
          author: null,
        })),
      }),
    );
    const comments = harvest.responses.filter((r) => r.channel === "comment");
    const commits = harvest.responses.filter((r) => r.channel === "commit");
    expect(comments).toHaveLength(RESPONSES_PER_CHANNEL);
    expect(commits).toHaveLength(RESPONSES_PER_CHANNEL);
    expect(comments[0]?.reason).toBe(`comment ${String(many - 1)}`);
    expect(commits[0]?.reason).toBe(`commit ${String(many - 1)}`);
    expect(commits.at(-1)?.reason).toBe(`commit ${String(many - RESPONSES_PER_CHANNEL)}`);
  });
});
