import { describe, it, expect } from "vitest";
import { advanceDialogue, decodeDialogue, DIALOGUE_ENTRY_CAP } from "./dialogue.js";
import type { DialogueAnswers, DialogueEntry, DialogueItem } from "./dialogue.js";
import type { Response } from "./responses.js";

const mkClosure = (overrides: Partial<Response> = {}): Response => ({
  id: "retry-plumbing",
  disposition: "refuted",
  reason: "Each policy matches its endpoint's contract.",
  channel: "comment",
  source_url: "https://github.com/o/r/pull/1#issuecomment-1",
  author: "alice",
  author_association: "OWNER",
  created_at: "2026-07-01T01:00:00Z",
  ...overrides,
});

const mkItem = (overrides: Partial<DialogueItem> = {}): DialogueItem => ({
  id: "retry-plumbing",
  title: "Retry plumbing is inconsistent",
  severity: "major",
  rebutted: true,
  ...overrides,
});

const answered = (
  closures: readonly Response[],
  more: Partial<Omit<DialogueAnswers, "closures">> = {},
): DialogueAnswers => ({
  closures: new Map(closures.map((closure) => [closure.id, closure])),
  overrulings: new Map(),
  upholdings: new Map(),
  fixed: new Set(),
  ...more,
});

const rebutted: DialogueEntry = {
  id: "retry-plumbing",
  state: "rebutted",
  answer: "https://github.com/o/r/pull/1#issuecomment-1",
  at: "2026-07-01T01:00:00Z",
  title: "Retry plumbing is inconsistent",
  severity: "major",
};

describe("advanceDialogue — one round of the review dialogue", () => {
  it("opens an id as rebutted when the reviewer re-raises it with a rebuttal against a trusted closure", () => {
    expect(advanceDialogue([], answered([mkClosure()]), [mkItem()])).toEqual([rebutted]);
  });

  it("opens nothing for a re-raise without a rebuttal, or a rebuttal no closure answers", () => {
    expect(advanceDialogue([], answered([mkClosure()]), [mkItem({ rebutted: false })])).toEqual([]);
    expect(advanceDialogue([], answered([]), [mkItem()])).toEqual([]);
  });

  it("keeps a rebutted id rebutted while the reviewer argues against the same answer", () => {
    expect(advanceDialogue([rebutted], answered([mkClosure()]), [mkItem()])).toEqual([rebutted]);
    expect(advanceDialogue([rebutted], answered([]), [])).toEqual([rebutted]);
  });

  it("contests a rebutted id once a newer trusted closure answers the rebuttal", () => {
    const answerAgain = mkClosure({
      source_url: "https://github.com/o/r/pull/1#issuecomment-2",
      created_at: "2026-07-02T01:00:00Z",
    });
    expect(advanceDialogue([rebutted], answered([answerAgain]), [])).toEqual([
      {
        ...rebutted,
        state: "contested",
        answer: answerAgain.source_url,
        at: answerAgain.created_at,
      },
    ]);
  });

  it("keeps a rebutted id rebutted when a rebase moves the same commit answer to a new URL", () => {
    const rebased = mkClosure({
      channel: "commit",
      source_url: "https://github.com/o/r/commit/def456",
    });
    expect(advanceDialogue([rebutted], answered([rebased]), [])).toEqual([
      { ...rebutted, answer: rebased.source_url },
    ]);
  });

  it("keeps a rebutted id rebutted when the rebutted answer is deleted, linking the one still standing", () => {
    const standing = mkClosure({
      source_url: "https://github.com/o/r/pull/1#issuecomment-0",
      created_at: "2026-06-30T01:00:00Z",
    });
    expect(advanceDialogue([rebutted], answered([standing]), [])).toEqual([
      { ...rebutted, answer: standing.source_url, at: standing.created_at },
    ]);
  });

  it("falls a contested id back to rebutted when the contesting answer is deleted", () => {
    const contested: DialogueEntry = {
      ...rebutted,
      state: "contested",
      at: "2026-07-02T01:00:00Z",
    };
    const rebuttedAnswer = mkClosure();
    expect(advanceDialogue([contested], answered([rebuttedAnswer]), [])).toEqual([
      {
        ...contested,
        state: "rebutted",
        answer: rebuttedAnswer.source_url,
        at: rebuttedAnswer.created_at,
      },
    ]);
  });

  it("never refreshes a rebutted entry from a re-raise carrying no rebuttal", () => {
    expect(
      advanceDialogue([rebutted], answered([mkClosure()]), [
        mkItem({ severity: "critical", rebutted: false }),
      ]),
    ).toEqual([rebutted]);
  });

  it("weighs a re-raise's own title and severity over the entry's", () => {
    const contested: DialogueEntry = { ...rebutted, state: "contested" };
    expect(
      advanceDialogue([contested], answered([]), [
        mkItem({ title: "Retry plumbing is unbounded", severity: "critical" }),
      ]),
    ).toEqual([{ ...contested, title: "Retry plumbing is unbounded", severity: "critical" }]);
  });

  it("keeps a contested id contested whether or not the reviewer re-raises it, linking the newest answer", () => {
    const contested: DialogueEntry = { ...rebutted, state: "contested" };
    const newest = mkClosure({
      source_url: "https://github.com/o/r/pull/1#issuecomment-3",
      created_at: "2026-07-03T01:00:00Z",
    });
    expect(advanceDialogue([contested], answered([]), [])).toEqual([contested]);
    expect(advanceDialogue([contested], answered([newest]), [mkItem()])).toEqual([
      { ...contested, answer: newest.source_url, at: newest.created_at },
    ]);
  });

  it("clears an entry whose newest trusted answer is fixed — the code changed, the argument starts over", () => {
    const contested: DialogueEntry = { ...rebutted, state: "contested" };
    expect(
      advanceDialogue(
        [rebutted, contested],
        answered([], { fixed: new Set(["retry-plumbing"]) }),
        [],
      ),
    ).toEqual([]);
  });

  it("holds a contested id a maintainer upholds, for good, linking the ruling", () => {
    const contested: DialogueEntry = { ...rebutted, state: "contested" };
    const ruling = mkClosure({
      disposition: "upheld",
      source_url: "https://github.com/o/r/pull/1#issuecomment-5",
      created_at: "2026-07-04T01:00:00Z",
    });
    const upheld = advanceDialogue(
      [contested],
      answered([], { upholdings: new Map([[ruling.id, ruling]]) }),
      [],
    );
    expect(upheld).toEqual([
      { ...contested, state: "upheld", answer: ruling.source_url, at: ruling.created_at },
    ]);
    const later = mkClosure({ created_at: "2026-07-05T01:00:00Z" });
    expect(advanceDialogue(upheld, answered([later]), [])).toEqual(upheld);
    expect(
      advanceDialogue(upheld, answered([], { fixed: new Set(["retry-plumbing"]) }), []),
    ).toEqual([]);
  });

  it("closes a contested id a maintainer overrules, for good, linking the ruling", () => {
    const contested: DialogueEntry = { ...rebutted, state: "contested" };
    const ruling = mkClosure({
      disposition: "overruled",
      source_url: "https://github.com/o/r/pull/1#issuecomment-4",
      created_at: "2026-07-04T01:00:00Z",
    });
    const overruled = advanceDialogue(
      [contested],
      answered([], { overrulings: new Map([[ruling.id, ruling]]) }),
      [],
    );
    expect(overruled).toEqual([
      { ...contested, state: "overruled", answer: ruling.source_url, at: ruling.created_at },
    ]);
    const later = mkClosure({ created_at: "2026-07-05T01:00:00Z" });
    expect(advanceDialogue(overruled, answered([later]), [mkItem()])).toEqual(overruled);
  });

  it("re-settles a ruled id on a newer opposite ruling, and only a newer one", () => {
    const upheld: DialogueEntry = { ...rebutted, state: "upheld", at: "2026-07-04T01:00:00Z" };
    const overruling = (created_at: string): Response =>
      mkClosure({ disposition: "overruled", source_url: "https://x/7", created_at });
    const later = overruling("2026-07-06T01:00:00Z");
    expect(
      advanceDialogue([upheld], answered([], { overrulings: new Map([[later.id, later]]) }), []),
    ).toEqual([{ ...upheld, state: "overruled", answer: later.source_url, at: later.created_at }]);
    const earlier = overruling("2026-07-03T01:00:00Z");
    expect(
      advanceDialogue(
        [upheld],
        answered([], { overrulings: new Map([[earlier.id, earlier]]) }),
        [],
      ),
    ).toEqual([upheld]);
  });

  it("trims only rebutted entries under the cap, never a held one", () => {
    const held = Array.from({ length: DIALOGUE_ENTRY_CAP + 1 }, (_, n): DialogueEntry => ({
      ...rebutted,
      id: `held-${String(n)}`,
      state: n % 2 === 0 ? "upheld" : "overruled",
    }));
    const next = advanceDialogue([...held, rebutted], answered([]), []);
    expect(next).toEqual(held);
  });

  it("ignores a ruling on an id that is not contested", () => {
    const ruling = mkClosure({ disposition: "overruled" });
    expect(
      advanceDialogue(
        [rebutted],
        answered([], {
          overrulings: new Map([[ruling.id, ruling]]),
          upholdings: new Map([[ruling.id, { ...ruling, disposition: "upheld" }]]),
        }),
        [],
      ),
    ).toEqual([rebutted]);
  });

  it("opens one entry for an id reported twice in a round", () => {
    expect(advanceDialogue([], answered([mkClosure()]), [mkItem(), mkItem()])).toEqual([rebutted]);
  });

  it("keeps contested entries ahead of rebutted ones under the cap", () => {
    const contested: DialogueEntry = { ...rebutted, id: "held", state: "contested" };
    const opening = Array.from({ length: DIALOGUE_ENTRY_CAP }, (_, n) =>
      mkItem({ id: `id-${String(n)}` }),
    );
    const closures = opening.map((item) => mkClosure({ id: item.id }));
    const next = advanceDialogue([contested], answered(closures), opening);
    expect(next).toHaveLength(DIALOGUE_ENTRY_CAP);
    expect(next[0]).toEqual(contested);
  });
});

describe("decodeDialogue — each entry decodes alone", () => {
  it("skips and counts a malformed entry, keeping the rest", () => {
    expect(decodeDialogue([rebutted, { id: "x", state: "argued" }])).toMatchObject({
      entries: [rebutted],
      skipped: 1,
    });
  });

  it("carries an entry it cannot read back out, untouched", () => {
    const future = { ...rebutted, state: "argued-further" };
    expect(decodeDialogue([rebutted, future])).toEqual({
      entries: [rebutted],
      undecoded: [future],
      skipped: 1,
    });
  });

  it("counts a marker that is not a list as one skipped state", () => {
    expect(decodeDialogue({ entries: [rebutted] })).toEqual({
      entries: [],
      undecoded: [],
      skipped: 1,
    });
    expect(decodeDialogue(undefined)).toEqual({ entries: [], undecoded: [], skipped: 1 });
  });
});
