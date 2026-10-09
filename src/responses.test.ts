import { describe, it, expect } from "vitest";
import {
  harvestResponses,
  parseResponseLines,
  parseResponseTables,
  parseResponses,
  RESPONSE_REASON_CLIP_CHARS,
  RESPONSES_PER_CHANNEL,
  ResponsesFileCodec,
  type HarvestInput,
} from "./responses.js";
import {
  DISPOSITIONS,
  RESPONSE_FORM,
  RESPONSE_TABLE_HEADER,
  RESPONSE_TEACHING,
} from "./response-grammar.js";

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

describe("parseResponseTables — the verdict tables implementers post", () => {
  it("reads a camas-style table: emoji verdicts, a third action column, several ids in one row", () => {
    const table = [
      "| finding | verdict | action |",
      "|---|---|---|",
      "| `batch-predicate-duplicated-drift` | ✅ fixed | One doctested `is_batch_program(name)` now serves both. |",
      "| `pathlike-argv-crashes-end-to-end`, `pathlike-directory-spelling-erased` | ✅ resolved by removal | `Task.cmd` is `tuple[str, ...]`. |",
      "| `widened-argv-contract-undeclared` (nit) | ✅ moot | The path-like claim is gone. |",
    ].join("\n");
    expect(parseResponseTables(table).map((r) => [r.id, r.disposition])).toEqual([
      ["batch-predicate-duplicated-drift", "fixed"],
      ["pathlike-argv-crashes-end-to-end", "fixed"],
      ["pathlike-directory-spelling-erased", "fixed"],
      ["widened-argv-contract-undeclared", "fixed"],
    ]);
    expect(parseResponseTables(table)[0]?.reason).toBe(
      "✅ fixed — One doctested `is_batch_program(name)` now serves both.",
    );
  });

  it("reads a salix-style table: bold verbs, a deferral to a filed issue, a recorded nit, a refutation", () => {
    const table = [
      "| id | disposition |",
      "| --- | --- |",
      "| `parameterless-candidate-skips-diamond-check` (major) | **fixed by widening this PR**, which now closes #229. |",
      "| `dict-co-base-copy-drops-items` (minor, re-raised) | **reproduced after merge** and filed as #223. A struct segfaults. |",
      "| `declared-names-order-sensitive-compare` (hidden nit) | recorded. A delegate that reorders the annotations is refused. |",
      '| `unchecked-type-in-exception-fastsubclass` (minor) | **probed, not reached**. `META("C", (5,), {})` is refused first. |',
    ].join("\n");
    expect(parseResponseTables(table).map((r) => [r.id, r.disposition])).toEqual([
      ["parameterless-candidate-skips-diamond-check", "fixed"],
      ["dict-co-base-copy-drops-items", "dismissed"],
      ["declared-names-order-sensitive-compare", "dismissed"],
      ["unchecked-type-in-exception-fastsubclass", "refuted"],
    ]);
  });

  it("reads a jphfmt-style table: a resolution that names no verdict is unstated, a systemic id answers too, a title-only row names nothing", () => {
    const table = [
      "| finding | resolution |",
      "| --- | --- |",
      "| `scope-directives-cr-line-split` | `scope_directives` splits a lone `\\r` as the lexer does. |",
      "| hidden blank-class nit | `starts_logical_line` reads past blank pieces. |",
      "| systemic `line-splice-rule-multiply-spelled` | One snippet table runs through all three readings. |",
    ].join("\n");
    expect(parseResponseTables(table).map((r) => [r.id, r.disposition])).toEqual([
      ["scope-directives-cr-line-split", "unstated"],
      ["line-splice-rule-multiply-spelled", "unstated"],
    ]);
  });

  it("reads the taught table once its rows are filled in, for every disposition, ids bare or quoted", () => {
    const table = [
      RESPONSE_TABLE_HEADER,
      "| --- | --- | --- |",
      ...DISPOSITIONS.map((disposition) => `| x-${disposition} (minor) | ${disposition} | why |`),
      "| `a-b` | dismissed | tracked in #12 |",
    ].join("\n");
    expect(parseResponseTables(table)).toEqual([
      ...DISPOSITIONS.map((disposition) => ({
        id: `x-${disposition}`,
        disposition,
        reason: "why",
      })),
      { id: "a-b", disposition: "dismissed", reason: "tracked in #12" },
    ]);
    expect(RESPONSE_TEACHING).toContain(RESPONSE_TABLE_HEADER);
    expect(RESPONSE_TEACHING).toContain(RESPONSE_FORM);
  });

  it("ignores a table without an id and a disposition column, and a fenced copy of one", () => {
    const unrelated = [
      "| shape | stock | main | now |",
      "| --- | --- | --- | --- |",
      "| ClassVar removes `a` | fields `[w, p]` | slot shadowed | refused |",
    ].join("\n");
    const fenced = [
      "```",
      "| id | disposition |",
      "| --- | --- |",
      "| `x-y` | dismissed |",
      "```",
    ].join("\n");
    expect(parseResponseTables(unrelated)).toEqual([]);
    expect(parseResponseTables(fenced)).toEqual([]);
  });

  it("keeps a correction: a line and a table row with different verdicts for one id are both answers", () => {
    const text = [
      "Review-Response: x-y refuted — measured",
      "",
      "| id | disposition |",
      "| --- | --- |",
      "| `x-y` | fixed |",
      "| `x-y` | fixed |",
      "| `a-b` | recorded |",
    ].join("\n");
    expect(parseResponses(text).map((r) => [r.id, r.disposition])).toEqual([
      ["x-y", "refuted"],
      ["x-y", "fixed"],
      ["a-b", "dismissed"],
    ]);
  });

  it("never guesses a verdict: a negated, rejecting or empty cell is unstated", () => {
    const table = [
      "| id | verdict |",
      "| --- | --- |",
      "| `a` | not fixed — the patch was reverted |",
      "| `b` | rejected |",
      "| `c` |  |",
      "| `d` | won't fix |",
    ].join("\n");
    expect(parseResponseTables(table).map((r) => [r.id, r.disposition])).toEqual([
      ["a", "unstated"],
      ["b", "unstated"],
      ["c", "unstated"],
      ["d", "dismissed"],
    ]);
  });

  it("ends a table at the next table's header, so an adjacent legend table yields no phantom answers", () => {
    const text = [
      "| id | disposition |",
      "| --- | --- |",
      "| `a-b` | fixed |",
      "| verdict | meaning |",
      "| --- | --- |",
      "| fixed | the fix landed |",
    ].join("\n");
    expect(parseResponseTables(text).map((r) => r.id)).toEqual(["a-b"]);
  });

  it("reads only a verdict table: a status table is not one", () => {
    expect(
      parseResponseTables(["| id | status |", "| --- | --- |", "| `a-b` | open |"].join("\n")),
    ).toEqual([]);
  });

  it("reads bare dotted and comma-listed ids, escaped pipes, and rows without outer pipes", () => {
    const table = [
      "id | disposition | reason",
      "--- | --- | ---",
      "dotted.id | dismissed | the `a \\| b` form is intended",
      "a-b, c-d | refuted |  |",
    ].join("\n");
    expect(parseResponseTables(table)).toEqual([
      { id: "dotted.id", disposition: "dismissed", reason: "the `a | b` form is intended" },
      { id: "a-b", disposition: "refuted", reason: "" },
      { id: "c-d", disposition: "refuted", reason: "" },
    ]);
  });

  it("scans repeated headers in linear time", () => {
    const pair = ["| id | disposition |", "| --- | --- |"];
    const text = Array.from({ length: 20000 }, () => pair)
      .flat()
      .join("\n");
    const started = performance.now();
    expect(parseResponseTables(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
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
