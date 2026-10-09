import { describe, it, expect } from "vitest";
import {
  DISPOSITIONS,
  harvestResponses,
  parseResponseLines,
  RESPONSE_REASON_CLIP_CHARS,
  RESPONSE_FORM,
  RESPONSES_PER_CHANNEL,
  ResponsesFileCodec,
  MAINTAINER_ASSOCIATIONS,
  closingResponses,
  isTrustedResponse,
  type HarvestInput,
  type Response,
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

  it("unwraps an id written the way the sticky displays it, in backticks or quotes", () => {
    expect(parseResponseLines("Review-Response: `x-y` fixed — done").map((r) => r.id)).toEqual([
      "x-y",
    ]);
    expect(parseResponseLines("Review-Response: 'x-y' fixed").map((r) => r.id)).toEqual(["x-y"]);
  });

  it("drops the prose punctuation that follows an id", () => {
    expect(
      parseResponseLines(
        ["Review-Response: x-y, fixed", "Review-Response: `a-b`: refuted — measured"].join("\n"),
      ).map((r) => [r.id, r.disposition]),
    ).toEqual([
      ["x-y", "fixed"],
      ["a-b", "refuted"],
    ]);
  });

  it("ignores a verb outside the vocabulary", () => {
    expect(parseResponseLines("Review-Response: x-y accepted — fine")).toEqual([]);
    expect(DISPOSITIONS).toEqual(["fixed", "refuted", "dismissed"]);
  });

  it("reads the taught form once its placeholders are filled in, for every verb", () => {
    expect(RESPONSE_FORM).toBe("Review-Response: <id> fixed|refuted|dismissed — <reason>");
    expect(
      DISPOSITIONS.flatMap((verb) =>
        parseResponseLines(
          RESPONSE_FORM.replace("<id>", "x-y")
            .replace(DISPOSITIONS.join("|"), verb)
            .replace("<reason>", "why"),
        ),
      ),
    ).toEqual(DISPOSITIONS.map((disposition) => ({ id: "x-y", disposition, reason: "why" })));
  });

  it("never reads a half-filled form, its alternation left in place, as the first verb", () => {
    expect(
      parseResponseLines(RESPONSE_FORM.replace("<id>", "x-y").replace("<reason>", "why")),
    ).toEqual([]);
    expect(parseResponseLines("Review-Response: x-y fixed | refuted | dismissed — why")).toEqual(
      [],
    );
  });

  it("never reads a quoted, inline-code, indented-code, or fenced copy of the grammar as a response", () => {
    const quoting = [
      "> Review-Response: quoted fixed — someone else's line",
      "Write `Review-Response: inline fixed` to answer.",
      "    Review-Response: indented-code fixed — four spaces is a code block",
      "```",
      "Review-Response: fenced fixed — an example",
      "~~~",
      "Review-Response: tilde-inside-backticks fixed — still fenced",
      "```",
      "````md",
      "```",
      "Review-Response: inner-fence fixed — a shorter marker never closes a longer fence",
      "````",
      "   Review-Response: real fixed — three spaces is still a paragraph",
    ].join("\n");
    expect(parseResponseLines(quoting)).toEqual([
      { id: "real", disposition: "fixed", reason: "three spaces is still a paragraph" },
    ]);
  });

  it("treats an unclosed fence as running to the end, as CommonMark does", () => {
    expect(parseResponseLines("```\nReview-Response: x fixed")).toEqual([]);
  });

  it("never opens a backtick fence whose info string holds a backtick, as CommonMark does", () => {
    expect(
      parseResponseLines("``` not`a fence\nReview-Response: x fixed").map((r) => r.id),
    ).toEqual(["x"]);
    expect(parseResponseLines("~~~ a`tilde fence\nReview-Response: x fixed")).toEqual([]);
  });

  it("splits lines at every line terminator, so a U+2028 never voids a response", () => {
    expect(
      parseResponseLines("intro Review-Response: x-y fixed — after a line separator").map(
        (r) => r.id,
      ),
    ).toEqual(["x-y"]);
  });

  it("clips a long reason and marks the cut", () => {
    const [line] = parseResponseLines(`Review-Response: x refuted ${"r".repeat(1000)}`);
    expect(line?.reason.startsWith("r".repeat(RESPONSE_REASON_CLIP_CHARS))).toBe(true);
    expect(line?.reason).toContain("[truncated]");
  });
});

describe("harvestResponses — the implementer's answers to the prior round", () => {
  const human = { login: "dev", type: "User" };
  const input = (overrides: Partial<HarvestInput> = {}): HarvestInput => ({
    repo: "o/r",
    prNumber: 7,
    botLogin: "github-actions[bot]",
    priorIds: new Set(["known-id", "a-class", "dotted.id"]),
    commits: [],
    comments: [],
    ...overrides,
  });

  it("keeps responses to ids the prior round reported, with each source's link, author and time", () => {
    const harvest = harvestResponses(
      input({
        commits: [
          {
            sha: "abc123",
            message: "fix\n\nReview-Response: known-id fixed — guarded",
            author: "Dev",
            date: "2026-10-02T00:00:00Z",
          },
        ],
        comments: [
          {
            id: 99,
            body: "Review-Response: a-class dismissed — out of scope",
            user: { login: "maintainer", type: "User" },
            created_at: "2026-10-01T00:00:00Z",
            author_association: "OWNER",
          },
        ],
      }),
    );
    expect(harvest.file.responses).toEqual([
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
        created_at: "2026-10-02T00:00:00Z",
      },
    ]);
    expect(harvest.file.unmatched).toEqual([]);
    expect(harvest.dropped).toBe(0);
    expect(ResponsesFileCodec.is(harvest.file)).toBe(true);
    expect(ResponsesFileCodec.is({ ...harvest.file, extra: true })).toBe(false);
  });

  it("matches any prior id as written, and echoes only an id-shaped unknown one as unmatched", () => {
    const harvest = harvestResponses(
      input({
        commits: [
          {
            sha: "s",
            message: [
              "Review-Response: dotted.id fixed",
              "Review-Response: typo-id fixed",
              "Review-Response: <id> fixed — the sticky's template, copied",
            ].join("\n"),
            author: null,
          },
        ],
      }),
    );
    expect(harvest.file.responses.map((r) => r.id)).toEqual(["dotted.id"]);
    expect(harvest.file.unmatched).toEqual([
      { id: "typo-id", channel: "commit", source_url: "https://github.com/o/r/commit/s" },
    ]);
  });

  it("only a human account answers — the pipeline's bot and any other bot are skipped", () => {
    const harvest = harvestResponses(
      input({
        comments: [
          {
            id: 1,
            body: "Review-Response: known-id fixed",
            user: { login: "github-actions[bot]", type: "Bot" },
          },
          {
            id: 2,
            body: "Review-Response: known-id fixed",
            user: { login: "dependabot[bot]", type: "Bot" },
          },
          { id: 3, body: "Review-Response: known-id fixed", user: { login: "typeless" } },
        ],
      }),
    );
    expect(harvest.file.responses).toEqual([]);
  });

  it("keeps the newest answers when a channel exceeds the cap, and counts what it dropped", () => {
    const many = RESPONSES_PER_CHANNEL + 5;
    const harvest = harvestResponses(
      input({
        comments: Array.from({ length: many }, (_, i) => ({
          id: i,
          body: `Review-Response: known-id fixed — comment ${String(i)}`,
          user: human,
          created_at: `2026-10-01T00:00:${String(i).padStart(2, "0")}Z`,
        })),
        commits: Array.from({ length: many }, (_, i) => ({
          sha: `c${String(i)}`,
          message: `Review-Response: known-id fixed — commit ${String(i)}`,
          author: null,
        })),
      }),
    );
    const comments = harvest.file.responses.filter((r) => r.channel === "comment");
    const commits = harvest.file.responses.filter((r) => r.channel === "commit");
    expect(comments).toHaveLength(RESPONSES_PER_CHANNEL);
    expect(commits).toHaveLength(RESPONSES_PER_CHANNEL);
    expect(comments[0]?.reason).toBe(`comment ${String(many - 1)}`);
    expect(commits[0]?.reason).toBe(`commit ${String(many - 1)}`);
    expect(commits.at(-1)?.reason).toBe(`commit ${String(many - RESPONSES_PER_CHANNEL)}`);
    expect(harvest.dropped).toBe(10);
  });

  it("breaks a same-second tie by the newer comment id, so the cap never keeps the older answer", () => {
    const harvest = harvestResponses(
      input({
        comments: Array.from({ length: RESPONSES_PER_CHANNEL + 1 }, (_, i) => ({
          id: i,
          body: `Review-Response: known-id fixed — comment ${String(i)}`,
          user: human,
          created_at: "2026-10-01T00:00:00Z",
        })),
      }),
    );
    expect(harvest.file.responses[0]?.reason).toBe(`comment ${String(RESPONSES_PER_CHANNEL)}`);
    expect(harvest.file.responses.map((r) => r.reason)).not.toContain("comment 0");
  });
});

describe("isTrustedResponse — only a maintainer's answer can close a finding", () => {
  const answer = (overrides: Partial<Response>): Response => ({
    id: "x-y",
    disposition: "dismissed",
    reason: "tracked in #12",
    channel: "comment",
    source_url: "https://github.com/o/r/pull/1#issuecomment-1",
    author: "alice",
    author_association: "OWNER",
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  });

  it("trusts a comment by its author's role, and only the maintainer roles", () => {
    expect(
      MAINTAINER_ASSOCIATIONS.map((role) =>
        isTrustedResponse(answer({ author_association: role }), false),
      ),
    ).toEqual([true, true, true]);
    expect(
      ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", null].map((role) =>
        isTrustedResponse(answer({ author_association: role }), true),
      ),
    ).toEqual([false, false, false, false, false]);
  });

  it("trusts a commit only when the PR's head branch is in the base repo", () => {
    const commit = answer({ channel: "commit", author_association: null });
    expect(isTrustedResponse(commit, true)).toBe(true);
    expect(isTrustedResponse(commit, false)).toBe(false);
  });
});

describe("closingResponses — the newest trusted answer per id decides", () => {
  const answer = (overrides: Partial<Response>): Response => ({
    id: "x-y",
    disposition: "dismissed",
    reason: "tracked in #12",
    channel: "comment",
    source_url: "https://github.com/o/r/pull/1#issuecomment-1",
    author: "alice",
    author_association: "OWNER",
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  });
  const maintainer = (response: Response): boolean => response.author_association === "OWNER";

  it("closes an id its newest trusted answer refutes or dismisses, never one it calls fixed", () => {
    expect(
      closingResponses(
        [
          answer({ id: "a", disposition: "refuted" }),
          answer({ id: "b", disposition: "dismissed" }),
          answer({ id: "c", disposition: "fixed" }),
        ],
        maintainer,
      ).map((r) => r.id),
    ).toEqual(["a", "b"]);
  });

  it("lets a newer fixed reopen an id, and a newer dismissal close it again", () => {
    const dismissed = answer({ created_at: "2026-10-01T00:00:00Z" });
    const reopened = answer({ disposition: "fixed", created_at: "2026-10-01T01:00:00Z" });
    expect(closingResponses([dismissed, reopened], maintainer)).toEqual([]);
    const closedAgain = answer({ created_at: "2026-10-01T03:00:00Z", source_url: "u2" });
    expect(closingResponses([dismissed, reopened, closedAgain], maintainer)).toEqual([closedAgain]);
  });

  it("orders answers by instant, not by spelling, so a timezone offset cannot reorder them", () => {
    const dismissed = answer({ created_at: "2026-10-01T01:30:00Z" });
    const earlierFixed = answer({ disposition: "fixed", created_at: "2026-10-01T02:00:00+01:00" });
    expect(closingResponses([earlierFixed, dismissed], maintainer)).toEqual([dismissed]);
  });

  it("never closes an id on an untrusted answer, an unreadable time, or a same-instant tie with fixed", () => {
    expect(closingResponses([answer({ author_association: "NONE" })], maintainer)).toEqual([]);
    expect(closingResponses([answer({ created_at: null })], maintainer)).toEqual([]);
    expect(closingResponses([answer({ created_at: "not a time" })], maintainer)).toEqual([]);
    expect(closingResponses([answer({}), answer({ disposition: "fixed" })], maintainer)).toEqual(
      [],
    );
  });

  it("ignores an untrusted fixed, so it cannot reopen a maintainer's closure", () => {
    const closed = answer({});
    const outsider = answer({
      disposition: "fixed",
      author_association: "NONE",
      created_at: "2026-10-02T00:00:00Z",
    });
    expect(closingResponses([closed, outsider], maintainer)).toEqual([closed]);
  });
});
