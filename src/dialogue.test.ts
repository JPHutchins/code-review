import { describe, it, expect } from "vitest";
import { advanceDialogue, decodeDialogue, DIALOGUE_ENTRY_CAP } from "./dialogue.js";
import type { DialogueEntry, DialogueItem } from "./dialogue.js";
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
    expect(advanceDialogue([], [mkClosure()], new Set(), [mkItem()])).toEqual([rebutted]);
  });

  it("opens nothing for a re-raise without a rebuttal, or a rebuttal no closure answers", () => {
    expect(advanceDialogue([], [mkClosure()], new Set(), [mkItem({ rebutted: false })])).toEqual(
      [],
    );
    expect(advanceDialogue([], [], new Set(), [mkItem()])).toEqual([]);
  });

  it("keeps a rebutted id rebutted while the reviewer argues against the same answer", () => {
    expect(advanceDialogue([rebutted], [mkClosure()], new Set(), [mkItem()])).toEqual([rebutted]);
    expect(advanceDialogue([rebutted], [], new Set(), [])).toEqual([rebutted]);
  });

  it("contests a rebutted id once a newer trusted closure answers the rebuttal", () => {
    const answerAgain = mkClosure({
      source_url: "https://github.com/o/r/pull/1#issuecomment-2",
      created_at: "2026-07-02T01:00:00Z",
    });
    expect(advanceDialogue([rebutted], [answerAgain], new Set(), [])).toEqual([
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
    expect(advanceDialogue([rebutted], [rebased], new Set(), [])).toEqual([
      { ...rebutted, answer: rebased.source_url },
    ]);
  });

  it("keeps a contested id contested whether or not the reviewer re-raises it, linking the newest answer", () => {
    const contested: DialogueEntry = { ...rebutted, state: "contested" };
    const newest = mkClosure({
      source_url: "https://github.com/o/r/pull/1#issuecomment-3",
      created_at: "2026-07-03T01:00:00Z",
    });
    expect(advanceDialogue([contested], [], new Set(), [])).toEqual([contested]);
    expect(advanceDialogue([contested], [newest], new Set(), [mkItem()])).toEqual([
      { ...contested, answer: newest.source_url, at: newest.created_at },
    ]);
  });

  it("clears an entry whose newest trusted answer is fixed — the code changed, the argument starts over", () => {
    const contested: DialogueEntry = { ...rebutted, state: "contested" };
    expect(advanceDialogue([rebutted, contested], [], new Set(["retry-plumbing"]), [])).toEqual([]);
  });

  it("opens one entry for an id reported twice in a round", () => {
    expect(advanceDialogue([], [mkClosure()], new Set(), [mkItem(), mkItem()])).toEqual([rebutted]);
  });

  it("keeps contested entries ahead of rebutted ones under the cap", () => {
    const contested: DialogueEntry = { ...rebutted, id: "held", state: "contested" };
    const opening = Array.from({ length: DIALOGUE_ENTRY_CAP }, (_, n) =>
      mkItem({ id: `id-${String(n)}` }),
    );
    const closures = opening.map((item) => mkClosure({ id: item.id }));
    const next = advanceDialogue([contested], closures, new Set(), opening);
    expect(next).toHaveLength(DIALOGUE_ENTRY_CAP);
    expect(next[0]).toEqual(contested);
  });
});

describe("decodeDialogue — each entry decodes alone", () => {
  it("skips and counts a malformed entry, keeping the rest", () => {
    expect(decodeDialogue([rebutted, { id: "x", state: "argued" }])).toEqual({
      entries: [rebutted],
      skipped: 1,
    });
  });

  it("counts a marker that is not a list as one skipped state", () => {
    expect(decodeDialogue({ entries: [rebutted] })).toEqual({ entries: [], skipped: 1 });
    expect(decodeDialogue(undefined)).toEqual({ entries: [], skipped: 1 });
  });
});
