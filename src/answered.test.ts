import { describe, it, expect } from "vitest";
import { answeredRegistryFrom, applyAnswered, answeredReRaiseNote } from "./answered.js";
import type { AnsweredEntry, ThreadComment } from "./answered.js";
import { findingPointer } from "./surface.js";
import type { Finding } from "./schema.js";

const mkFinding = (overrides: Partial<Finding>): Finding => ({
  path: "src/foo.ts",
  start_line: 10,
  end_line: 10,
  severity: "minor",
  title: "The same claim",
  description: "The same description.",
  reasoning: "The same reasoning.",
  confidence: 0.8,
  code: "recurring-a",
  ...overrides,
});

const botComment = (id: number, finding: Finding): ThreadComment => ({
  id,
  in_reply_to_id: null,
  user_login: "github-actions[bot]",
  user_type: "Bot",
  // Each inline comment embeds its own finding via the per-finding marker (findingPointer).
  body: findingPointer(finding, "0.6.0"),
  html_url: `https://github.com/owner/repo/pull/1#discussion_r${String(id)}`,
  path: "src/foo.ts",
  line: 10,
  created_at: "2026-07-01T00:00:00Z",
});

const reply = (
  id: number,
  to: number,
  author: string,
  body = "Measured on 3.14: the claim does not hold — matrix green.",
): ThreadComment => ({
  id,
  in_reply_to_id: to,
  user_login: author,
  user_type: "User",
  body,
  html_url: `https://github.com/owner/repo/pull/1#discussion_r${String(id)}`,
  path: "src/foo.ts",
  line: 10,
  created_at: "2026-07-01T01:00:00Z",
});

const humanTopLevel = (id: number): ThreadComment => ({
  ...reply(id, 9999, "alice"),
  in_reply_to_id: null,
});

describe("answeredRegistryFrom — the 'already answered' state (issue #151)", () => {
  it("records a human reply on the bot's thread, decoding the finding from the embedded marker", () => {
    const finding = mkFinding({});
    const registry = answeredRegistryFrom(
      [botComment(1, finding), reply(2, 1, "alice")],
      "github-actions[bot]",
    );
    expect(registry).toHaveLength(1);
    const entry = registry[0]!;
    expect(entry.code).toBe("recurring-a");
    expect(entry.title).toBe("The same claim");
    expect(entry.reasoning).toBe("The same reasoning.");
    expect(entry.replyUrl).toContain("discussion_r2");
    expect(entry.threadUrl).toContain("discussion_r1");
    expect(entry.replyAuthor).toBe("alice");
  });

  it("follows a reply-to-reply chain — the human answering a human's reply on a bot thread counts", () => {
    const finding = mkFinding({});
    const registry = answeredRegistryFrom(
      [botComment(1, finding), reply(2, 1, "alice"), reply(3, 2, "bob")],
      "github-actions[bot]",
    );
    expect(registry).toHaveLength(1);
    expect(registry[0]!.replyUrl).toContain("discussion_r2");
  });

  it("ignores a bot thread with no human reply, a human's own top-level comment, and the bot replying to itself", () => {
    const finding = mkFinding({});
    const registry = answeredRegistryFrom(
      [
        botComment(1, finding),
        reply(2, 1, "github-actions[bot]"),
        humanTopLevel(3),
        botComment(4, finding),
      ],
      "github-actions[bot]",
    );
    expect(registry).toHaveLength(0);
  });

  it("excludes a reply from ANOTHER bot account (user.type Bot) — a CI/dependabot comment is not a human answer (issue #151 review r1)", () => {
    const finding = mkFinding({});
    const dependabot: ThreadComment = { ...reply(2, 1, "dependabot[bot]"), user_type: "Bot" };
    const registry = answeredRegistryFrom(
      [botComment(1, finding), dependabot],
      "github-actions[bot]",
    );
    expect(registry).toHaveLength(0);
    // The same thread WITH a human reply is answered.
    const withHuman = answeredRegistryFrom(
      [botComment(1, finding), dependabot, reply(3, 1, "alice")],
      "github-actions[bot]",
    );
    expect(withHuman).toHaveLength(1);
  });

  it("skips a thread whose bot comment carries no decodable finding marker", () => {
    const undecodable: ThreadComment = { ...botComment(1, mkFinding({})), body: "no marker here" };
    const registry = answeredRegistryFrom(
      [undecodable, reply(2, 1, "alice")],
      "github-actions[bot]",
    );
    expect(registry).toHaveLength(0);
  });

  it("keeps the MOST RECENT answer when the same code was answered in several threads", () => {
    const finding = mkFinding({});
    const registry = answeredRegistryFrom(
      [botComment(1, finding), reply(2, 1, "alice"), botComment(3, finding), reply(4, 3, "bob")],
      "github-actions[bot]",
    );
    expect(registry).toHaveLength(1);
    expect(registry[0]!.replyUrl).toContain("discussion_r4");
  });

  it("records a codeless answered finding with a title-only match key and clips the reply excerpt", () => {
    const finding = mkFinding({ code: undefined });
    const longReply = reply(2, 1, "alice", "x".repeat(500));
    const registry = answeredRegistryFrom(
      [botComment(1, finding), longReply],
      "github-actions[bot]",
    );
    expect(registry).toHaveLength(1);
    expect(registry[0]!.code).toBe("");
    expect(registry[0]!.replyExcerpt).toContain("… [truncated]");
  });
});

describe("applyAnswered — the deterministic re-raise backstop (issue #151)", () => {
  const entry = (overrides: Partial<AnsweredEntry> = {}): AnsweredEntry => ({
    code: "recurring-a",
    title: "The same claim",
    description: "The same description.",
    reasoning: "The same reasoning.",
    severity: "minor",
    threadUrl: "https://github.com/owner/repo/pull/1#discussion_r1",
    replyUrl: "https://github.com/owner/repo/pull/1#discussion_r2",
    replyAuthor: "alice",
    replyExcerpt: "Measured: does not hold.",
    repliedAt: "2026-07-01T01:00:00Z",
    path: "src/foo.ts",
    line: 10,
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

  it("dedups the dropped entries by code — two findings sharing one dropped code name the answer once (issue #151 review r2)", () => {
    const { findings, verbatimReRaised } = applyAnswered(
      [
        mkFinding({ path: "src/foo.ts" }),
        mkFinding({
          path: "src/bar.ts",
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
      [mkFinding({ code: "__proto__", reasoning: "NEW evidence." })],
      [entry({ code: "__proto__" })],
    );
    expect(findings).toHaveLength(1);
    expect(verbatimReRaised).toHaveLength(0);
    const own = Object.prototype.hasOwnProperty.call(reRaisedNotes, "__proto__");
    expect(own).toBe(true);
    expect(reRaisedNotes["__proto__"]).toContain("discussion_r2");
  });

  it("annotates a CODELESS kept re-raise under its title key — the annotation is not code-only (issue #151 review r1)", () => {
    const uncoded = entry({ code: "" });
    const { findings, reRaisedNotes, verbatimReRaised } = applyAnswered(
      [mkFinding({ code: undefined, reasoning: "NEW evidence: persists on 3.14." })],
      [uncoded],
    );
    expect(findings).toHaveLength(1);
    expect(verbatimReRaised).toHaveLength(0);
    expect(reRaisedNotes["title:The same claim"]).toContain("discussion_r2");
    expect(reRaisedNotes["recurring-a"]).toBeUndefined();
  });

  it("matches codeless findings by title (the issue's 'code (or title)' rule)", () => {
    const uncoded = entry({ code: "" });
    const { findings, verbatimReRaised } = applyAnswered(
      [mkFinding({ code: undefined, title: "The same claim" })],
      [uncoded],
    );
    expect(findings).toHaveLength(0);
    expect(verbatimReRaised).toHaveLength(1);
    // A code-bearing finding never matches a codeless answered entry.
    const { findings: coded } = applyAnswered([mkFinding({ code: "other-code" })], [uncoded]);
    expect(coded).toHaveLength(1);
  });

  it("leaves unmatched findings untouched", () => {
    const { findings, reRaisedNotes, verbatimReRaised } = applyAnswered(
      [mkFinding({ code: "fresh-code" }), mkFinding({ code: undefined })],
      [entry()],
    );
    expect(findings).toHaveLength(2);
    expect(verbatimReRaised).toHaveLength(0);
    expect(reRaisedNotes).toEqual({});
  });
});

describe("answeredReRaiseNote — the drop is never silent (issue #151)", () => {
  const entry: AnsweredEntry = {
    code: "recurring-a",
    title: "The same claim",
    description: "The same description.",
    reasoning: "The same reasoning.",
    severity: "minor",
    threadUrl: "https://github.com/owner/repo/pull/1#discussion_r1",
    replyUrl: "https://github.com/owner/repo/pull/1#discussion_r2",
    replyAuthor: "alice",
    replyExcerpt: "Measured: does not hold.",
    repliedAt: "2026-07-01T01:00:00Z",
    path: "src/foo.ts",
    line: 10,
  };

  it("is empty when nothing was dropped", () => {
    expect(answeredReRaiseNote([])).toBe("");
  });

  it("names the dropped finding's code and links the prior answer", () => {
    const note = answeredReRaiseNote([entry]);
    expect(note).toContain("treated as answered");
    expect(note).toContain("`recurring-a`");
    expect(note).toContain("discussion_r2");
  });
});
