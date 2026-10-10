import { describe, it, expect } from "vitest";
import {
  answeredRegistryFrom,
  answeredSystemicRegistryFrom,
  applyAnswered,
  applyAnsweredSystemic,
  applyOverruled,
  answeredReRaiseNote,
  answeredSystemicNoteKey,
  couldMatch,
} from "./answered.js";
import type { AnsweredEntry, AnsweredSystemicEntry } from "./answered.js";
import { synthesizedFindingId, synthesizedSystemicId } from "./schema.js";
import type { Finding, Findings, SystemicProblem } from "./schema.js";
import type { Response } from "./responses.js";

const mkFinding = (overrides: Partial<Finding>): Finding => ({
  path: "src/foo.ts",
  id: "recurring-a",
  start_line: 10,
  end_line: 10,
  severity: "minor",
  title: "The same claim",
  description: "The same description.",
  reasoning: "The same reasoning.",
  confidence: 0.8,
  likelihood: 1,
  ...overrides,
});

const mkResponse = (overrides: Partial<Response>): Response => ({
  id: "recurring-a",
  disposition: "refuted",
  reason: "Measured: the claim does not hold.",
  channel: "comment",
  source_url: "https://github.com/owner/repo/pull/1#issuecomment-2",
  author: "alice",
  author_association: "OWNER",
  created_at: "2026-07-01T01:00:00Z",
  ...overrides,
});

const mkSystemic = (overrides: Partial<SystemicProblem>): SystemicProblem => ({
  id: "retry-plumbing",
  title: "Retry plumbing is inconsistent",
  description: "Each caller retries with its own policy.",
  severity: "minor",
  reasoning: "Three call sites, three policies.",
  confidence: 0.8,
  likelihood: 1,
  ...overrides,
});

const mkPrior = (findings: readonly Finding[]): Findings => ({
  schema_version: "0.11.0",
  summary: "The prior round.",
  verdict: "comment",
  findings: [...findings],
});

describe("answeredRegistryFrom — a closing answer, against the prior finding it names", () => {
  it("carries the prior finding's claim fields and the answer's link and author", () => {
    const prior = mkFinding({ patch: "diff --git a/src/foo.ts b/src/foo.ts" });
    expect(answeredRegistryFrom([mkResponse({})], mkPrior([prior]))).toEqual([
      {
        code: "recurring-a",
        title: prior.title,
        description: prior.description,
        reasoning: prior.reasoning,
        severity: prior.severity,
        path: prior.path,
        patch: "diff --git a/src/foo.ts b/src/foo.ts",
        answerUrl: "https://github.com/owner/repo/pull/1#issuecomment-2",
        answerAuthor: "alice",
      },
    ]);
  });

  it("makes no entry for a closure naming no prior finding, or when the prior did not resolve", () => {
    expect(
      answeredRegistryFrom([mkResponse({ id: "unknown-id" })], mkPrior([mkFinding({})])),
    ).toEqual([]);
    expect(answeredRegistryFrom([mkResponse({})], null)).toEqual([]);
  });

  it("names a pre-id prior finding by its synthesized id, the id the harvest matched", () => {
    const id = synthesizedFindingId("src/foo.ts", "The same claim");
    expect(
      answeredRegistryFrom([mkResponse({ id })], mkPrior([mkFinding({ id: "" })])).map(
        (e) => e.code,
      ),
    ).toEqual([id]);
  });
});

describe("couldMatch — the download gate asks the matcher's own question", () => {
  it("admits an id a finding carries, and a synthesized id whose title second chance needs the prior", () => {
    const findings = [mkFinding({ id: "recurring-a" })];
    expect(couldMatch("recurring-a", { findings })).toBe(true);
    expect(couldMatch("another-id", { findings })).toBe(false);
    expect(
      couldMatch(synthesizedFindingId("src/elsewhere.ts", "The same claim"), { findings }),
    ).toBe(true);
  });

  it("admits a systemic problem's id, and an id-less systemic's synthesized one", () => {
    const doc = {
      findings: [],
      systemic_problems: [mkSystemic({}), mkSystemic({ id: undefined, title: "Untitled class" })],
    };
    expect(couldMatch("retry-plumbing", doc)).toBe(true);
    expect(couldMatch(synthesizedSystemicId("Untitled class"), doc)).toBe(true);
    expect(couldMatch("another-id", doc)).toBe(false);
  });

  it("agrees with applyAnswered: an entry couldMatch rejects is never matched", () => {
    const findings = [mkFinding({ id: "recurring-a" })];
    const entry: AnsweredEntry = {
      code: "another-id",
      title: "The same claim",
      description: "The same description.",
      reasoning: "The same reasoning.",
      severity: "minor",
      path: "src/foo.ts",
      patch: null,
      answerUrl: "u",
      answerAuthor: null,
    };
    expect(couldMatch(entry.code, { findings })).toBe(false);
    expect(applyAnswered(findings, [entry]).verbatimReRaised).toEqual([]);
  });
});

describe("applyAnswered — the deterministic re-raise backstop (issue #151)", () => {
  const entry = (overrides: Partial<AnsweredEntry> = {}): AnsweredEntry => ({
    code: "recurring-a",
    title: "The same claim",
    description: "The same description.",
    reasoning: "The same reasoning.",
    severity: "minor",
    path: "src/foo.ts",
    patch: null,
    answerUrl: "https://github.com/owner/repo/pull/1#discussion_r2",
    answerAuthor: "alice",
    ...overrides,
  });

  it("drops a VERBATIM re-raise (identical code + title + reasoning — no new evidence) and names it", () => {
    const { findings, reRaisedNotes, verbatimReRaised } = applyAnswered([mkFinding({})], [entry()]);
    expect(findings).toHaveLength(0);
    expect(verbatimReRaised).toHaveLength(1);
    expect(reRaisedNotes).toEqual({});
  });

  it("keeps a re-raise with changed evidence, annotated with the prior answer's link", () => {
    const { findings, reRaisedNotes, verbatimReRaised } = applyAnswered(
      [mkFinding({ reasoning: "NEW evidence: the 3.14 regression persists." })],
      [entry()],
    );
    expect(findings).toHaveLength(1);
    expect(verbatimReRaised).toHaveLength(0);
    expect(reRaisedNotes["recurring-a"]).toContain("discussion_r2");
    expect(reRaisedNotes["recurring-a"]).toContain("new evidence");
  });

  it("keeps a re-raise whose DESCRIPTION changed — the claim text is the evidence, so a description-level change is not verbatim (issue #151 review r2)", () => {
    const { findings, verbatimReRaised, reRaisedNotes } = applyAnswered(
      [mkFinding({ description: "Measured on 3.14: reproduces — matrix link." })],
      [entry()],
    );
    expect(findings).toHaveLength(1);
    expect(verbatimReRaised).toHaveLength(0);
    expect(reRaisedNotes["recurring-a"]).toBeDefined();
  });

  it("keeps a re-raise RELOCATED to another file, or one whose proposed fix changed — location and fix are part of the claim (issue #151 review r3)", () => {
    const relocated = applyAnswered([mkFinding({ path: "src/other.ts" })], [entry()]);
    expect(relocated.findings).toHaveLength(1);
    expect(relocated.verbatimReRaised).toHaveLength(0);
    const newFix = applyAnswered(
      [mkFinding({ patch: "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n" })],
      [entry({ patch: "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+other\n" })],
    );
    expect(newFix.findings).toHaveLength(1);
    expect(newFix.verbatimReRaised).toHaveLength(0);
    // An absent patch on both sides compares equal (undefined vs null normalized) — still verbatim.
    const noPatch = applyAnswered([mkFinding({})], [entry()]);
    expect(noPatch.findings).toHaveLength(0);
    expect(noPatch.verbatimReRaised).toHaveLength(1);
  });

  it("dedups the dropped entries by code — two findings sharing one dropped code name the answer once (issue #151 review r2)", () => {
    const { findings, verbatimReRaised } = applyAnswered(
      [
        mkFinding({ start_line: 10, end_line: 10 }),
        mkFinding({
          start_line: 20,
          end_line: 20,
          title: "The same claim",
          description: "The same description.",
          reasoning: "The same reasoning.",
        }),
      ],
      [entry()],
    );
    expect(findings).toHaveLength(0);
    expect(verbatimReRaised).toHaveLength(1);
  });

  it("keeps a re-raise that carries a rebuttal — it answers the prior response, so it is never verbatim", () => {
    const rebuttal = "The reply measured 3.12; the defect reproduces only on 3.14.";
    const byId = applyAnswered([mkFinding({ rebuttal })], [entry()]);
    expect(byId.findings).toHaveLength(1);
    expect(byId.verbatimReRaised).toHaveLength(0);
    // The title second chance asks the same predicate: a fresh id, the synthesized entry's claim.
    const synthesized = entry({ code: synthesizedFindingId("src/foo.ts", "The same claim") });
    const byTitle = applyAnswered([mkFinding({ id: "fresh-id", rebuttal })], [synthesized]);
    expect(byTitle.findings).toHaveLength(1);
    expect(byTitle.verbatimReRaised).toHaveLength(0);
    const withoutRebuttal = applyAnswered([mkFinding({ id: "fresh-id" })], [synthesized]);
    expect(withoutRebuttal.findings).toHaveLength(0);
  });

  it("still drops a verbatim re-raise whose rebuttal is blank", () => {
    const { findings, verbatimReRaised } = applyAnswered(
      [mkFinding({ rebuttal: " \n " })],
      [entry()],
    );
    expect(findings).toHaveLength(0);
    expect(verbatimReRaised).toHaveLength(1);
  });

  it("never drops a CRITICAL verbatim re-raise — it is kept with the annotation", () => {
    const { findings, verbatimReRaised, reRaisedNotes } = applyAnswered(
      [mkFinding({ severity: "critical" })],
      [entry({ severity: "critical" })],
    );
    expect(findings).toHaveLength(1);
    expect(verbatimReRaised).toHaveLength(0);
    expect(reRaisedNotes["recurring-a"]).toBeDefined();
  });

  it("keeps a severity-ESCALATED re-raise — a changed claim weight is not verbatim (issue #151 review r1)", () => {
    const { findings, verbatimReRaised, reRaisedNotes } = applyAnswered(
      [mkFinding({ severity: "major" })],
      [entry({ severity: "minor" })],
    );
    expect(findings).toHaveLength(1);
    expect(verbatimReRaised).toHaveLength(0);
    expect(reRaisedNotes["recurring-a"]).toBeDefined();
  });

  it("annotates a finding whose code is `__proto__` — the notes map is built via Object.fromEntries, never a prototype write (issue #151 review r1)", () => {
    const { findings, reRaisedNotes, verbatimReRaised } = applyAnswered(
      [mkFinding({ id: "__proto__", reasoning: "NEW evidence." })],
      [entry({ code: "__proto__" })],
    );
    expect(findings).toHaveLength(1);
    expect(verbatimReRaised).toHaveLength(0);
    const own = Object.prototype.hasOwnProperty.call(reRaisedNotes, "__proto__");
    expect(own).toBe(true);
    expect(reRaisedNotes["__proto__"]).toContain("discussion_r2");
  });

  it("keys a kept re-raise with an EMPTY id under its title — the note key never vanishes (issue #151 review r1)", () => {
    const synthesized = entry({ code: synthesizedFindingId("src/foo.ts", "The same claim") });
    const { findings, reRaisedNotes, verbatimReRaised } = applyAnswered(
      [mkFinding({ id: "", reasoning: "NEW evidence: persists on 3.14." })],
      [synthesized],
    );
    expect(findings).toHaveLength(1);
    expect(verbatimReRaised).toHaveLength(0);
    expect(reRaisedNotes["title:The same claim"]).toContain("discussion_r2");
    expect(reRaisedNotes["recurring-a"]).toBeUndefined();
  });

  it("an empty-id finding resolves to the synthesized id and matches the entry its marker produced", () => {
    const synthesized = entry({ code: synthesizedFindingId("src/foo.ts", "The same claim") });
    const { findings, verbatimReRaised } = applyAnswered(
      [mkFinding({ id: "", title: "The same claim" })],
      [synthesized],
    );
    expect(findings).toHaveLength(0);
    expect(verbatimReRaised).toHaveLength(1);
    // A DIFFERENT claim (fresh id AND fresh title) never matches.
    const { findings: coded } = applyAnswered(
      [mkFinding({ id: "other-code", title: "A different claim" })],
      [synthesized],
    );
    expect(coded).toHaveLength(1);
  });

  it("a RELOCATED re-raise of a pre-id codeless claim keeps its prior-answer annotation via the title second chance", () => {
    const synthesized = entry({ code: synthesizedFindingId("src/foo.ts", "The same claim") });
    // Same claim text, different path: not verbatim (the location changed), so it is kept — but the
    // annotation must survive even though the synthesized key is path-derived and the agent's id is
    // fresh.
    const { findings, verbatimReRaised, reRaisedNotes } = applyAnswered(
      [mkFinding({ id: "fresh-agent-id", path: "src/other.ts" })],
      [synthesized],
    );
    expect(findings).toHaveLength(1);
    expect(verbatimReRaised).toHaveLength(0);
    expect(reRaisedNotes["fresh-agent-id"]).toContain("discussion_r2");
  });

  it("the ID match wins over a title-matched synthesized entry — an unrelated same-title answer never mis-binds the annotation", () => {
    const unrelated = entry({
      code: synthesizedFindingId("src/elsewhere.ts", "The same claim"),
      answerUrl: "https://github.com/owner/repo/pull/1#discussion_r5",
    });
    // The id-matched entry comes AFTER the unrelated title match in the registry order.
    const { findings, verbatimReRaised, reRaisedNotes } = applyAnswered(
      [mkFinding({ id: "recurring-a" })],
      [unrelated, entry()],
    );
    expect(findings).toHaveLength(0);
    expect(verbatimReRaised).toHaveLength(1);
    expect(verbatimReRaised[0]!.answerUrl).toContain("discussion_r2");
    expect(reRaisedNotes).toEqual({});
  });

  it("the title second chance binds the synthesized same-title entry sharing the MOST claim fields, not the first in registry order", () => {
    // Two codeless same-title answers under different paths — their synthesized ids both match the
    // title. The finding's path and description match only the SECOND entry; binding the first
    // would link the wrong thread.
    const first = entry({
      code: synthesizedFindingId("src/elsewhere.ts", "The same claim"),
      description: "A different description.",
      answerUrl: "https://github.com/owner/repo/pull/1#discussion_r5",
    });
    const second = entry({
      code: synthesizedFindingId("src/foo.ts", "The same claim"),
      answerUrl: "https://github.com/owner/repo/pull/1#discussion_r6",
    });
    const { findings, verbatimReRaised, reRaisedNotes } = applyAnswered(
      [mkFinding({ id: "fresh-agent-id", reasoning: "NEW evidence." })],
      [first, second],
    );
    expect(findings).toHaveLength(1);
    expect(verbatimReRaised).toHaveLength(0);
    expect(reRaisedNotes["fresh-agent-id"]).toContain("discussion_r6");
  });

  it("equal-scored synthesized same-title entries keep the registry order", () => {
    // Two codeless same-title answers under DIFFERENT paths, each scoring 5/6 against the finding's
    // third path: ONLY the strict-> first-wins registry order breaks the tie.
    const first = entry({
      code: synthesizedFindingId("src/bar.ts", "The same claim"),
      answerUrl: "https://github.com/owner/repo/pull/1#discussion_r7",
    });
    const second = entry({
      code: synthesizedFindingId("src/baz.ts", "The same claim"),
      answerUrl: "https://github.com/owner/repo/pull/1#discussion_r8",
    });
    const { reRaisedNotes } = applyAnswered(
      [mkFinding({ id: "fresh-agent-id", path: "src/other.ts", reasoning: "NEW evidence." })],
      [first, second],
    );
    expect(reRaisedNotes["fresh-agent-id"]).toContain("discussion_r7");
  });

  it("the title second chance never fires for an entry whose code is REAL, only synthesized", () => {
    // A real-code entry with the same title must NOT match a fresh-id finding by title alone.
    const { findings } = applyAnswered(
      [mkFinding({ id: "some-other-id" })],
      [entry({ code: "recurring-a", title: "The same claim" })],
    );
    expect(findings).toHaveLength(1);
  });

  it("leaves unmatched findings untouched", () => {
    const { findings, reRaisedNotes, verbatimReRaised } = applyAnswered(
      [
        mkFinding({ id: "fresh-code", title: "A different claim" }),
        mkFinding({ id: "", title: "Another different claim" }),
      ],
      [entry()],
    );
    expect(findings).toHaveLength(2);
    expect(verbatimReRaised).toHaveLength(0);
    expect(reRaisedNotes).toEqual({});
  });
});

describe("answeredSystemicRegistryFrom — a closing answer, against the prior systemic it names", () => {
  const prior = (systemic: readonly SystemicProblem[]): Findings => ({
    ...mkPrior([]),
    systemic_problems: [...systemic],
  });

  it("carries the prior systemic's claim fields and the answer's link and author", () => {
    const systemic = mkSystemic({});
    expect(
      answeredSystemicRegistryFrom([mkResponse({ id: "retry-plumbing" })], prior([systemic])),
    ).toEqual([
      {
        code: "retry-plumbing",
        title: systemic.title,
        description: systemic.description,
        reasoning: systemic.reasoning,
        severity: systemic.severity,
        answerUrl: "https://github.com/owner/repo/pull/1#issuecomment-2",
        answerAuthor: "alice",
      },
    ]);
  });

  it("makes no entry for a closure naming a finding, or naming nothing the prior reported", () => {
    const doc = { ...prior([mkSystemic({})]), findings: [mkFinding({})] };
    expect(answeredSystemicRegistryFrom([mkResponse({ id: "recurring-a" })], doc)).toEqual([]);
    expect(answeredSystemicRegistryFrom([mkResponse({ id: "gone" })], doc)).toEqual([]);
    expect(answeredSystemicRegistryFrom([mkResponse({ id: "retry-plumbing" })], null)).toEqual([]);
  });

  it("names an id-less prior systemic by its synthesized id, the id the harvest matched", () => {
    const idLess = mkSystemic({ id: undefined });
    const code = synthesizedSystemicId(idLess.title);
    expect(
      answeredSystemicRegistryFrom([mkResponse({ id: code })], prior([idLess])).map((e) => e.code),
    ).toEqual([code]);
  });
});

describe("applyAnsweredSystemic — a closed systemic id, re-raised", () => {
  const entry = (overrides: Partial<AnsweredSystemicEntry> = {}): AnsweredSystemicEntry => ({
    code: "retry-plumbing",
    title: "Retry plumbing is inconsistent",
    description: "Each caller retries with its own policy.",
    severity: "minor",
    reasoning: "Three call sites, three policies.",
    answerUrl: "https://github.com/owner/repo/pull/1#issuecomment-9",
    answerAuthor: "alice",
    ...overrides,
  });

  it("drops a verbatim re-raise and names the answer", () => {
    const result = applyAnsweredSystemic([mkSystemic({})], [entry()]);
    expect(result.systemic).toEqual([]);
    expect(result.verbatimReRaised).toEqual([entry()]);
    expect(result.droppedCount).toBe(1);
    expect(result.reRaisedNotes).toEqual({});
  });

  it("drops a verbatim re-raise whose finding_ids and paths moved — neither is part of the claim", () => {
    const moved = mkSystemic({ finding_ids: ["new-instance"], paths: ["src/elsewhere.ts"] });
    expect(applyAnsweredSystemic([moved], [entry()]).systemic).toEqual([]);
  });

  it.each<readonly [string, Partial<SystemicProblem>, Partial<AnsweredSystemicEntry>]>([
    ["the title", { title: "Retry plumbing is now unbounded" }, {}],
    ["the description", { description: "A fourth caller retries forever." }, {}],
    ["the reasoning", { reasoning: "Measured: four call sites." }, {}],
    ["the severity", { severity: "major" }, {}],
    ["a rebuttal", { rebuttal: "The dismissal predates the fourth caller." }, {}],
    ["a critical severity on both sides", { severity: "critical" }, { severity: "critical" }],
  ])("keeps a re-raise with %s, annotated with the prior answer", (_, current, closed) => {
    const systemic = mkSystemic(current);
    const closedAt = entry(closed);
    const result = applyAnsweredSystemic([systemic], [closedAt]);
    expect(result.systemic).toEqual([systemic]);
    expect(result.droppedCount).toBe(0);
    expect(result.reRaisedNotes[answeredSystemicNoteKey(systemic)]).toContain(closedAt.answerUrl);
  });

  it("leaves a systemic no answer closed untouched", () => {
    const other = mkSystemic({ id: "other-class" });
    expect(applyAnsweredSystemic([other], [entry()])).toEqual({
      systemic: [other],
      reRaisedNotes: {},
      verbatimReRaised: [],
      droppedCount: 0,
    });
  });

  it("names a repeated dropped id once and counts every drop", () => {
    const result = applyAnsweredSystemic([mkSystemic({}), mkSystemic({})], [entry()]);
    expect(result.verbatimReRaised).toHaveLength(1);
    expect(result.droppedCount).toBe(2);
  });
});

describe("applyOverruled — an overruled id is closed for good", () => {
  const ruling = {
    code: "recurring-a",
    title: "The same claim",
    answerUrl: "https://github.com/owner/repo/pull/1#issuecomment-4",
    answerAuthor: "alice",
  };
  const rulings = new Map([[ruling.code, ruling]]);

  it("drops every re-raise of the id, rebuttal or not, naming the ruling once", () => {
    const result = applyOverruled(
      [mkFinding({}), mkFinding({ rebuttal: "The ruling missed the cold path." })],
      rulings,
      (f) => f.id,
      (f) => f.id,
    );
    expect(result.kept).toEqual([]);
    expect(result.verbatimReRaised).toEqual([ruling]);
    expect(result.droppedCount).toBe(2);
  });

  it("keeps a critical re-raise, linked to the ruling, and leaves other ids alone", () => {
    const critical = mkFinding({ severity: "critical" });
    const other = mkFinding({ id: "other" });
    const result = applyOverruled(
      [critical, other],
      rulings,
      (f) => f.id,
      (f) => f.id,
    );
    expect(result.kept).toEqual([critical, other]);
    expect(result.droppedCount).toBe(0);
    expect(result.reRaisedNotes["recurring-a"]).toContain(ruling.answerUrl);
    expect(result.reRaisedNotes["other"]).toBeUndefined();
  });
});

describe("answeredReRaiseNote — the drop is never silent (issue #151)", () => {
  it("counts the TRUE pre-dedup dropped findings while the lines stay deduped by key (issues #151 review r5 + r7)", () => {
    const note = answeredReRaiseNote([entry], 3);
    expect(note).toContain("**3 re-raise(s)");
    // The deduped lines still list the single entry once.
    expect(note.match(/prior answer/g)).toHaveLength(1);
  });

  const entry: AnsweredEntry = {
    code: "recurring-a",
    title: "The same claim",
    description: "The same description.",
    reasoning: "The same reasoning.",
    severity: "minor",
    path: "src/foo.ts",
    patch: null,
    answerUrl: "https://github.com/owner/repo/pull/1#discussion_r2",
    answerAuthor: "alice",
  };

  it("is empty when nothing was dropped", () => {
    expect(answeredReRaiseNote([], 0)).toBe("");
  });

  it("renders the answer's author inside a code span — inert as markdown whatever it holds", () => {
    const spoofed = { ...entry, answerAuthor: "[maintainer](https://example.com) @owner" };
    expect(answeredReRaiseNote([spoofed], 1)).toContain(
      "by `[maintainer](https://example.com) @owner`",
    );
    expect(answeredReRaiseNote([{ ...entry, answerAuthor: null }], 1)).not.toContain(" by ");
  });

  it("names the dropped finding's code and links the prior answer", () => {
    const note = answeredReRaiseNote([entry], 1);
    expect(note).toContain("treated as answered");
    expect(note).toContain("`recurring-a`");
    expect(note).toContain("discussion_r2");
  });
});
