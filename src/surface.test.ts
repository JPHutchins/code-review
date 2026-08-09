import { describe, it, expect } from "vitest";
import {
  parseFindingsMarker,
  parseReviewedSha,
  parseReviewedRoute,
  parseReviewComplete,
  parseCompletedAncestor,
  COMPLETED_ANCESTOR_MARKER,
  isFullReviewSticky,
  findingsPointer,
  findingsMarkerForm,
  parseRounds,
  roundsMarker,
  roundsSummary,
  carryForwardMarkers,
  convergenceScore,
  convergenceSummary,
  convergenceSignal,
  signalForRound,
  surfaceFindings,
  surfacedFindingsPointer,
  stripSurfaceFields,
  parseSurfaceSignal,
  parseSignalMarker,
  SURFACE_SCHEMA_VERSION,
  SURFACE_SCHEMA_VERSIONS,
  DEFAULT_CONVERGENCE_THRESHOLD,
  computeCodeCounts,
  roundRecord,
  consecutiveCodeStreaks,
  metastasisNote,
  computeSameRootNotes,
  MAX_CODES_PER_ROUND,
} from "./surface.js";
import { DEFAULT_SCHEMA_VERSION } from "./schema.js";
import type { Finding, Findings } from "./schema.js";
import type { SurfaceSignal } from "./surface.js";
import type { RoundRecord, SeverityCounts } from "./types.js";

const findings = {
  schema_version: "0.4.0",
  summary: "s",
  verdict: "comment",
  findings: [
    {
      path: "src/x.ts",
      start_line: 1,
      end_line: 1,
      severity: "minor",
      title: "t",
      description: "d",
      reasoning: "r",
      confidence: 0.5,
    },
  ],
} as unknown as Findings;

describe("parseFindingsMarker", () => {
  it("round-trips the whole findings document embedded by findingsPointer", () => {
    const body = `sticky prose\n${findingsPointer(findings, undefined)}\nmore prose`;
    expect(parseFindingsMarker(body)).toEqual(findings);
  });

  it("round-trips systemic_problems through the marker (issue #134 — the machine channel carries them)", () => {
    const withSystemic = {
      ...findings,
      systemic_problems: [
        {
          title: "Retry inconsistency",
          description: "Three policies in three spots.",
          severity: "major",
          reasoning: "Each file implements its own policy.",
          confidence: 0.8,
          finding_codes: ["widened-type"],
          paths: ["src/a.ts"],
        },
      ],
    } as unknown as Findings;
    const body = `sticky prose\n${findingsPointer(withSystemic, undefined)}\nmore prose`;
    const decoded = parseFindingsMarker(body) as {
      systemic_problems?: readonly unknown[];
    };
    expect(decoded.systemic_problems).toHaveLength(1);
    expect(decoded.systemic_problems?.[0]).toEqual(withSystemic.systemic_problems?.[0]);
  });

  it("returns null when the body carries no findings marker", () => {
    expect(parseFindingsMarker("just a comment, nothing embedded")).toBeNull();
  });

  it("returns null on an empty body", () => {
    expect(parseFindingsMarker("")).toBeNull();
  });

  it("returns null for the jsonUrl-link fallback (no inline base64 to decode)", () => {
    expect(
      parseFindingsMarker("<!-- code-review:findings-json https://example/x.zip -->"),
    ).toBeNull();
  });

  it("returns null when the base64 payload is not valid JSON", () => {
    const notJson = Buffer.from("not json", "utf-8").toString("base64");
    expect(parseFindingsMarker(`<!-- code-review:findings-json;base64 ${notJson} -->`)).toBeNull();
  });

  it("returns null when the base64 is truncated (decode/parse fails)", () => {
    const full = Buffer.from(JSON.stringify(findings), "utf-8").toString("base64");
    const truncated = full.slice(0, Math.floor(full.length / 2));
    expect(
      parseFindingsMarker(`<!-- code-review:findings-json;base64 ${truncated} -->`),
    ).toBeNull();
  });

  it("decodes the first marker when a body somehow carries more than one", () => {
    const first = findingsPointer(findings, undefined);
    const second = findingsPointer({ ...findings, summary: "second" }, undefined);
    expect(parseFindingsMarker(`${first}\n${second}`)).toEqual(findings);
  });
});

describe("findingsMarkerForm", () => {
  it("reports embedded when the document fits under the limit", () => {
    expect(findingsMarkerForm(findings, undefined)).toBe("embedded");
  });

  it("reports link when the document exceeds the limit and a jsonUrl is given", () => {
    const huge = {
      ...findings,
      findings: [
        ...findings.findings,
        ...Array.from({ length: 500 }, (_, i) => ({
          ...findings.findings[0],
          title: `F${String(i)}`,
          description: "x".repeat(200),
        })),
      ],
    } as unknown as Findings;
    expect(findingsMarkerForm(huge, "https://example.com/findings.zip")).toBe("link");
  });

  it("reports omitted when the document exceeds the limit and no jsonUrl is given", () => {
    const huge = {
      ...findings,
      findings: [
        ...findings.findings,
        ...Array.from({ length: 500 }, (_, i) => ({
          ...findings.findings[0],
          title: `F${String(i)}`,
          description: "x".repeat(200),
        })),
      ],
    } as unknown as Findings;
    expect(findingsMarkerForm(huge, undefined)).toBe("omitted");
  });

  it("agrees with what findingsPointer actually emits (embedded form is the decodable one)", () => {
    expect(findingsMarkerForm(findings, undefined)).toBe("embedded");
    expect(findingsPointer(findings, undefined)).toContain("code-review:findings-json;base64");
  });
});

describe("parseReviewedSha", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("extracts the reviewed-sha the comment template embeds, lowercased", () => {
    expect(parseReviewedSha(`<!-- reviewed-sha: ${sha.toUpperCase()} -->\nsticky`)).toBe(sha);
  });

  it("returns null when the body carries no reviewed-sha marker", () => {
    expect(parseReviewedSha("just prose, no marker")).toBeNull();
  });

  it("returns null for the all-zeros placeholder (no head SHA was stamped)", () => {
    expect(parseReviewedSha(`<!-- reviewed-sha: ${"0".repeat(40)} -->`)).toBeNull();
  });
});

describe("parseReviewedRoute", () => {
  it("reads the completed review's route marker", () => {
    expect(parseReviewedRoute("<!-- reviewed-route: full review -->\nsticky")).toBe("full review");
    expect(parseReviewedRoute("<!-- reviewed-route: mechanic -->\nsticky")).toBe("mechanic");
  });

  it("returns null when the body carries no route marker (a notice, or an older sticky)", () => {
    expect(parseReviewedRoute("<!-- code-review -->\nplain")).toBeNull();
    expect(parseReviewedRoute("<!-- reviewed-route: -->\nempty")).toBeNull();
  });
});

describe("isFullReviewSticky — post's full-review predicate (issue #127)", () => {
  const oneRound = roundsMarker([{ critical: 0, major: 1, minor: 0, nit: 0 }]);

  it("route marker 'full review' wins, even with no round history", () => {
    expect(isFullReviewSticky("<!-- reviewed-route: full review -->")).toBe(true);
  });

  it("route marker 'mechanic' is NEVER a full review — even when it carries a full review's round history forward", () => {
    expect(isFullReviewSticky(`<!-- reviewed-route: mechanic -->\n${oneRound}`)).toBe(false);
  });

  it("round history is the pre-route-marker fallback — only a completed full review APPENDS a round (a mechanic can only carry one)", () => {
    expect(isFullReviewSticky(oneRound)).toBe(true);
  });

  it("no signal at all is not a full review (a notice, an in-progress placeholder, or a pre-marker mechanic)", () => {
    expect(isFullReviewSticky("<!-- code-review -->\nplain")).toBe(false);
  });
});

describe("completed-ancestor marker — the placeholder's completed-review ancestry (issue #127)", () => {
  it("parseCompletedAncestor is true only when the marker is present", () => {
    expect(parseCompletedAncestor(COMPLETED_ANCESTOR_MARKER)).toBe(true);
    expect(parseCompletedAncestor("<!-- code-review -->\nplain")).toBe(false);
    // review-complete itself is NOT the ancestor marker — the two are distinct signals.
    expect(parseCompletedAncestor("<!-- review-complete -->")).toBe(false);
  });

  it("carryForwardMarkers emits the ancestor marker when the replaced sticky was a completed review — and carries it onward through chained placeholders", () => {
    const fromCompleted = carryForwardMarkers("<!-- code-review -->\n<!-- review-complete -->\nx");
    expect(fromCompleted).toContain(COMPLETED_ANCESTOR_MARKER);
    const fromPlaceholder = carryForwardMarkers(
      `<!-- code-review -->\n${COMPLETED_ANCESTOR_MARKER}\nx`,
    );
    expect(fromPlaceholder).toContain(COMPLETED_ANCESTOR_MARKER);
    // A notice's sticky never carries it.
    expect(
      carryForwardMarkers("<!-- code-review -->\n### ⚠️ Review did not complete"),
    ).not.toContain(COMPLETED_ANCESTOR_MARKER);
  });
});

describe("parseReviewComplete", () => {
  it("true only when the completed-review marker is present", () => {
    expect(parseReviewComplete("<!-- code-review -->\n<!-- review-complete -->\nreal review")).toBe(
      true,
    );
  });

  it("false for an incomplete notice or an in-progress placeholder (no marker)", () => {
    expect(parseReviewComplete("<!-- code-review -->\n🔄 Code review in progress")).toBe(false);
    expect(parseReviewComplete("<!-- code-review -->\n### ⚠️ Review did not complete")).toBe(false);
  });
});

describe("rounds trajectory — issue #125", () => {
  const counts = (critical: number, major: number, minor: number, nit: number): SeverityCounts => ({
    critical,
    major,
    minor,
    nit,
  });

  it("round-trips through roundsMarker → parseRounds", () => {
    const rounds = [counts(1, 2, 0, 0), counts(0, 1, 3, 0), counts(0, 0, 0, 0)];
    expect(parseRounds(`prose\n${roundsMarker(rounds)}\nmore`)).toEqual(rounds);
  });

  it("yields no rounds for an empty history and never emits an empty marker", () => {
    expect(roundsMarker([])).toBe("");
    expect(parseRounds("no marker here")).toEqual([]);
  });

  it("decodes to no history for a malformed or wrong-shaped marker rather than throwing", () => {
    expect(parseRounds("<!-- code-review:rounds;base64 not$$base64 -->")).toEqual([]);
    const notArray = Buffer.from(JSON.stringify({ critical: 1 }), "utf-8").toString("base64");
    expect(parseRounds(`<!-- code-review:rounds;base64 ${notArray} -->`)).toEqual([]);
    const missingKey = Buffer.from(JSON.stringify([{ critical: 1 }]), "utf-8").toString("base64");
    expect(parseRounds(`<!-- code-review:rounds;base64 ${missingKey} -->`)).toEqual([]);
  });

  it("renders the trajectory: emoji chips per round, 'clean' for a round with no findings", () => {
    expect(roundsSummary([counts(1, 2, 0, 0), counts(0, 1, 0, 0), counts(0, 0, 0, 0)])).toBe(
      "**Round 3** · 🔴1 🟠2 → 🟠1 → clean",
    );
  });

  it("shows the round number even for the first round, and nothing when there is no history", () => {
    expect(roundsSummary([counts(0, 0, 5, 0)])).toBe("**Round 1** · 🔵5");
    expect(roundsSummary([])).toBe("");
  });

  it("carryForwardMarkers preserves the rounds marker alongside findings + reviewed-sha", () => {
    const body = `x\n${roundsMarker([counts(0, 0, 1, 0)])}\n<!-- reviewed-sha: ${"a".repeat(40)} -->`;
    expect(carryForwardMarkers(body)).toContain("code-review:rounds;base64");
    expect(carryForwardMarkers(body)).toContain("reviewed-sha:");
  });

  it("carryForwardMarkers preserves the reviewed-route marker — the seed chain's route-awareness survives the prose swap", () => {
    const body =
      "x\n<!-- reviewed-route: mechanic -->\n<!-- code-review:findings-json;base64 YQ== -->";
    const carried = carryForwardMarkers(body);
    expect(carried).toContain("<!-- reviewed-route: mechanic -->");
    expect(carried).toContain("code-review:findings-json");
  });

  it("rejects rounds with negative, fractional, or unsafe-integer counts", () => {
    const marker = (round: unknown): string =>
      `<!-- code-review:rounds;base64 ${Buffer.from(JSON.stringify([round]), "utf-8").toString("base64")} -->`;
    expect(parseRounds(marker({ critical: -1, major: 0, minor: 0, nit: 0 }))).toEqual([]);
    expect(parseRounds(marker({ critical: 1.5, major: 0, minor: 0, nit: 0 }))).toEqual([]);
    expect(parseRounds(marker({ critical: 1e308, major: 0, minor: 0, nit: 0 }))).toEqual([]);
  });

  it("drops only the malformed round, keeping the valid ones — one bad entry can't erase the history", () => {
    const mixed = Buffer.from(
      JSON.stringify([counts(0, 1, 0, 0), { critical: 1 }, counts(0, 0, 2, 0)]),
      "utf-8",
    ).toString("base64");
    expect(parseRounds(`<!-- code-review:rounds;base64 ${mixed} -->`)).toEqual([
      counts(0, 1, 0, 0),
      counts(0, 0, 2, 0),
    ]);
  });

  it("caps the visible trajectory with a leading ellipsis while keeping the true round number", () => {
    const many = Array.from({ length: 12 }, (_, i) => counts(0, 0, i + 1, 0));
    const summary = roundsSummary(many);
    expect(summary.startsWith("**Round 12** · … → ")).toBe(true);
    // Only the last 8 chips are shown; the earliest (🔵1) is elided.
    expect(summary).toContain("🔵12");
    expect(summary).not.toContain("🔵1 →");
  });

  it("labels the round from an explicit count when the history lost an entry — the trajectory and the blob's round stay equal (issue #141 review r3)", () => {
    // The marker holds 1 parseable round, but the carried signal says round 3 was completed.
    expect(roundsSummary([counts(0, 1, 0, 0)], 3)).toBe("**Round 3** · 🟠1");
  });

  it("keeps the label when every marker entry was filtered — the carried count still claims the round (issue #141 review r4)", () => {
    expect(roundsSummary([], 3)).toBe("**Round 3**");
    expect(roundsSummary([])).toBe("");
  });
});

describe("convergence score — issue #133", () => {
  const counts = (critical: number, major: number, minor: number, nit: number): SeverityCounts => ({
    critical,
    major,
    minor,
    nit,
  });

  it("defaults to the naive weights: crit 4 · major 2 · minor 1 · nit 0", () => {
    expect(DEFAULT_CONVERGENCE_THRESHOLD).toBe(1);
    expect(convergenceScore(counts(1, 0, 0, 0))).toBe(4);
    expect(convergenceScore(counts(0, 1, 0, 0))).toBe(2);
    expect(convergenceScore(counts(0, 0, 1, 0))).toBe(1);
    expect(convergenceScore(counts(0, 0, 0, 99))).toBe(0);
    expect(convergenceScore(counts(1, 1, 1, 1))).toBe(7);
  });

  it("treats the nit floor as free — unlimited nits stay converged", () => {
    expect(convergenceSummary(counts(0, 0, 0, 50))).toBe("**Convergence** 🏁 0 ≤ 1 — converged");
  });

  it("tolerates exactly one minor at the default threshold, but not two", () => {
    expect(convergenceSummary(counts(0, 0, 1, 3))).toBe("**Convergence** 🏁 1 ≤ 1 — converged");
    expect(convergenceSummary(counts(0, 0, 2, 0))).toBe("**Convergence** 🔄 2 > 1 — iterating");
  });

  it("never converges past a single major or critical", () => {
    expect(convergenceSummary(counts(0, 1, 0, 0))).toBe("**Convergence** 🔄 2 > 1 — iterating");
    expect(convergenceSummary(counts(1, 0, 0, 0))).toBe("**Convergence** 🔄 4 > 1 — iterating");
  });

  it("a clean review reads as converged (score 0)", () => {
    expect(convergenceSummary(counts(0, 0, 0, 0))).toBe("**Convergence** 🏁 0 ≤ 1 — converged");
  });

  it("respects a raised threshold as the single tolerance knob", () => {
    expect(convergenceSummary(counts(0, 0, 2, 0), 3)).toBe("**Convergence** 🏁 2 ≤ 3 — converged");
    expect(convergenceSummary(counts(0, 1, 0, 0), 3)).toBe("**Convergence** 🏁 2 ≤ 3 — converged");
    expect(convergenceSummary(counts(1, 0, 0, 0), 3)).toBe("**Convergence** 🔄 4 > 3 — iterating");
  });

  it("renders score and threshold exactly so the printed inequality matches the comparison (#135 review)", () => {
    expect(convergenceSummary(counts(0, 0, 1, 0), 1.5)).toBe(
      "**Convergence** 🏁 1 ≤ 1.5 — converged",
    );
    expect(convergenceSummary(counts(0, 0, 2, 0), 1.5)).toBe(
      "**Convergence** 🔄 2 > 1.5 — iterating",
    );
    // A threshold that toFixed(1) would round to "1.0" must print its true value, or the line reads
    // as a false inequality (1 > 1.0 / 1 ≤ 1.0).
    expect(convergenceSummary(counts(0, 0, 1, 0), 0.95)).toBe(
      "**Convergence** 🔄 1 > 0.95 — iterating",
    );
    expect(convergenceSummary(counts(0, 0, 1, 0), 1.04)).toBe(
      "**Convergence** 🏁 1 ≤ 1.04 — converged",
    );
  });
});

describe("mechanism frequency rounds — issue #145", () => {
  const counts = (critical: number, major: number, minor: number, nit: number): SeverityCounts => ({
    critical,
    major,
    minor,
    nit,
  });
  const mkFinding = (overrides: Partial<Finding>): Finding => ({
    path: "src/x.ts",
    start_line: 1,
    end_line: 1,
    severity: "minor",
    title: "t",
    description: "d",
    reasoning: "r",
    confidence: 0.5,
    ...overrides,
  });
  const coded = (c: SeverityCounts, codes: Record<string, number>): RoundRecord => ({
    ...c,
    codes,
  });

  it("computeCodeCounts counts findings by code, ignoring uncoded and empty-code findings", () => {
    expect(
      computeCodeCounts([
        mkFinding({ code: "null-check-missing" }),
        mkFinding({ code: "null-check-missing" }),
        mkFinding({ code: "body-reconstruction" }),
        mkFinding({}),
        mkFinding({ code: "" }),
      ]),
    ).toEqual({ "null-check-missing": 2, "body-reconstruction": 1 });
  });

  it("roundRecord omits the codes field when no finding carried a code (pre-feature marker shape)", () => {
    expect(roundRecord(counts(1, 0, 0, 0), {})).toEqual({
      critical: 1,
      major: 0,
      minor: 0,
      nit: 0,
    });
  });

  it("roundRecord adds the codes map when present", () => {
    expect(roundRecord(counts(1, 0, 0, 0), { "null-check-missing": 1 })).toEqual({
      critical: 1,
      major: 0,
      minor: 0,
      nit: 0,
      codes: { "null-check-missing": 1 },
    });
  });

  it("caps a round's recorded codes at the top-N by count", () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`code-${String(i)}`, 1]));
    const record = roundRecord(counts(0, 0, 0, 0), many);
    expect(record.codes).toBeDefined();
    expect(Object.keys(record.codes ?? {})).toHaveLength(MAX_CODES_PER_ROUND);
  });

  it("parseRounds round-trips coded rounds and keeps count-only rounds beside them", () => {
    const rounds: RoundRecord[] = [
      counts(1, 0, 0, 0),
      coded(counts(0, 1, 0, 0), { "body-reconstruction": 2 }),
    ];
    expect(parseRounds(`prose\n${roundsMarker(rounds)}\nmore`)).toEqual(rounds);
  });

  it("parseRounds strips a malformed codes shape but keeps the round's severity counts", () => {
    const bad = Buffer.from(
      JSON.stringify([{ critical: 0, major: 0, minor: 0, nit: 0, codes: "garbage" }]),
      "utf-8",
    ).toString("base64");
    expect(parseRounds(`<!-- code-review:rounds;base64 ${bad} -->`)).toEqual([
      { critical: 0, major: 0, minor: 0, nit: 0 },
    ]);
  });

  it("consecutiveCodeStreaks counts trailing rounds per code and stops at an uncoded round", () => {
    const rounds: RoundRecord[] = [
      coded(counts(0, 0, 0, 0), { a: 1 }),
      counts(0, 0, 0, 0), // no codes record — ends every streak
      coded(counts(0, 0, 0, 0), { a: 1 }),
      coded(counts(0, 0, 0, 0), { a: 1, b: 1 }),
    ];
    expect(consecutiveCodeStreaks(rounds)).toEqual({
      a: { streak: 2, startRound: 3 },
      b: { streak: 1, startRound: 4 },
    });
  });

  it("metastasisNote is empty below the streak threshold and names the mechanism above it", () => {
    const twoStreak: RoundRecord[] = [
      coded(counts(0, 0, 0, 0), { a: 1 }),
      coded(counts(0, 0, 0, 0), { a: 1 }),
    ];
    expect(metastasisNote(twoStreak)).toBe("");

    const threeStreak: RoundRecord[] = [
      coded(counts(0, 0, 0, 0), { a: 1 }),
      coded(counts(0, 0, 0, 0), { a: 1 }),
      coded(counts(0, 0, 0, 0), { a: 1 }),
    ];
    const note = metastasisNote(threeStreak);
    expect(note).toContain("Scope metastasis");
    expect(note).toContain("`a`");
    expect(note).toContain("3 consecutive rounds");
    // No round range: a retry-containing history would make any X–Y range inconsistent with the
    // streak count (issue #145 r3).
    expect(note).not.toContain("rounds ");
  });

  it("metastasisNote honors a custom minStreak", () => {
    const twoStreak: RoundRecord[] = [
      coded(counts(0, 0, 0, 0), { a: 1 }),
      coded(counts(0, 0, 0, 0), { a: 1 }),
    ];
    expect(metastasisNote(twoStreak, 2)).toContain("Scope metastasis");
    expect(metastasisNote(twoStreak, 3)).toBe("");
  });

  it("computeSameRootNotes names the most recent prior round for each recurring code", () => {
    const prior: RoundRecord[] = [
      coded(counts(0, 0, 0, 0), { a: 1 }),
      counts(0, 0, 0, 0),
      coded(counts(0, 0, 0, 0), { a: 1, b: 1 }),
    ];
    const notes = computeSameRootNotes(prior, [
      mkFinding({ code: "a" }),
      mkFinding({ code: "b" }),
      mkFinding({}),
    ]);
    expect(notes["a"]).toContain("round 3");
    expect(notes["b"]).toContain("round 3");
    expect(notes["c"]).toBeUndefined();
  });

  it("computeCodeCounts folds in systemic problem finding_codes AND code so a systemic-only mechanism is visible", () => {
    const systemic = [
      {
        title: "s",
        description: "d",
        severity: "major" as const,
        reasoning: "r",
        confidence: 0.8,
        code: "body-reconstruction",
        finding_codes: ["null-check-missing"],
      },
    ];
    expect(computeCodeCounts([mkFinding({ code: "null-check-missing" })], systemic)).toEqual({
      "null-check-missing": 2,
      "body-reconstruction": 1,
    });
  });

  it("computeCodeCounts treats prototype-collision codes as ordinary own keys", () => {
    expect(
      computeCodeCounts([
        mkFinding({ code: "constructor" }),
        mkFinding({ code: "constructor" }),
        mkFinding({ code: "__proto__" }),
      ]),
    ).toEqual(
      Object.fromEntries([
        ["constructor", 2],
        ["__proto__", 1],
      ]),
    );
  });

  it("consecutiveCodeStreaks treats a same-head retry (identical sha) as one iteration, not new evidence", () => {
    const rounds: RoundRecord[] = [
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "abc123" },
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "abc123" },
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "abc123" },
    ];
    expect(consecutiveCodeStreaks(rounds)).toEqual({ a: { streak: 1, startRound: 1 } });
  });

  it("consecutiveCodeStreaks counts a new commit after a same-sha retry as a fresh round", () => {
    const rounds: RoundRecord[] = [
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "sha1" },
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "sha1" },
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "sha2" },
    ];
    expect(consecutiveCodeStreaks(rounds)).toEqual({ a: { streak: 2, startRound: 1 } });
  });

  it("consecutiveCodeStreaks counts a code NEW in a same-sha retry round (issue #145 r2)", () => {
    const rounds: RoundRecord[] = [
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "sha1" },
      { ...coded(counts(0, 0, 0, 0), { a: 1, b: 1 }), sha: "sha1" },
    ];
    expect(consecutiveCodeStreaks(rounds)).toEqual({
      a: { streak: 1, startRound: 1 },
      b: { streak: 1, startRound: 2 },
    });
  });

  it("roundsMarker keeps the full mechanism history under the size cap", () => {
    const rounds: RoundRecord[] = Array.from({ length: 10 }, (_, i) =>
      i === 9
        ? { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "last" }
        : { ...coded(counts(0, 0, 0, 0), { [String(i)]: 1 }), sha: `sha${String(i)}` },
    );
    const parsed = parseRounds(roundsMarker(rounds));
    expect(parsed).toHaveLength(10);
    expect(parsed[0]?.codes).toEqual({ "0": 1 });
    expect(parsed[0]?.sha).toBe("sha0");
    expect(parsed[9]?.codes).toEqual({ a: 1 });
    expect(parsed[9]?.sha).toBe("last");
  });

  it("roundsMarker degrades the OLDEST rounds' codes first when the marker would exceed the size cap", () => {
    const longCode = (n: number): string =>
      `mechanism-with-a-very-long-name-that-bloats-the-marker-${String(n).padStart(3, "0")}`;
    const rounds: RoundRecord[] = Array.from({ length: 20 }, (_, i) =>
      coded(
        counts(0, 0, 0, 0),
        Object.fromEntries(Array.from({ length: 8 }, (_, k) => [longCode(i * 8 + k), 1])),
      ),
    );
    const parsed = parseRounds(roundsMarker(rounds));
    expect(parsed).toHaveLength(20);
    expect(parsed[0]?.codes).toBeUndefined();
    expect(Object.keys(parsed[19]?.codes ?? {})).toHaveLength(8);
  });

  it("normalizeCodeCounts drops count-0 entries so every consumer agrees 0 is absence", () => {
    const record = roundRecord(counts(0, 0, 0, 0), { a: 0, b: 0, c: 1 });
    expect(record.codes).toEqual({ c: 1 });
  });

  it("the per-round cap prefers codes that recurred in the previous round", () => {
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`code-${String(i)}`, 1]));
    const priorCodes = { "code-8": 1 };
    const record = roundRecord(counts(0, 0, 0, 0), nine, priorCodes);
    expect(record.codes).toBeDefined();
    expect(record.codes?.["code-8"]).toBe(1);
    expect(Object.keys(record.codes ?? {})).toHaveLength(MAX_CODES_PER_ROUND);
  });

  it("computeSameRootNotes skips a same-sha prior round so a CI retry doesn't self-annotate", () => {
    const prior: RoundRecord[] = [
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "sha1" },
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "sha1" },
    ];
    // currentSha sha1 → every prior round is a retry of the current commit → nothing to name.
    expect(computeSameRootNotes(prior, [mkFinding({ code: "a" })], "sha1")["a"]).toBeUndefined();
    // currentSha sha2 → r2 is a retry of r1 (collapsed), so the last real prior round is round 1.
    expect(computeSameRootNotes(prior, [mkFinding({ code: "a" })], "sha2")["a"]).toContain(
      "round 1",
    );
    expect(computeSameRootNotes(prior, [mkFinding({ code: "a" })], "sha2")["a"]).not.toContain(
      "round 2",
    );
  });

  it("computeSameRootNotes names the TRUE round number from the record, not the parsed index (issue #145 r4)", () => {
    // The rounds marker lost a corrupt entry, so position 1 actually represents round 5 — the
    // record's `round` field must win over the array index.
    const prior: RoundRecord[] = [{ ...coded(counts(0, 0, 0, 0), { a: 1 }), round: 5 }];
    expect(computeSameRootNotes(prior, [mkFinding({ code: "a" })])["a"]).toContain("round 5");
  });

  it("the per-round cap never drops a code that recurred in the previous round, even at a low count (issue #145 r4)", () => {
    const codes: Record<string, number> = Object.fromEntries([
      ...Array.from({ length: 8 }, (_, i) => [`bulk-${String(i)}`, 5] as [string, number]),
      ["watched", 1] as [string, number],
    ]);
    const record = roundRecord(counts(0, 0, 0, 0), codes, { watched: 1 });
    expect(record.codes?.["watched"]).toBe(1);
  });

  it("computeSameRootNotes also collapses a same-sha retry DEEPER in the history (issue #145 r3)", () => {
    // r2 is a retry of r1 (same sha); the mechanism's last real occurrence is round 1 — the retry
    // must not be named as "round 2" (the streak detector collapses it too, so the two advisory
    // signals agree about whether the round is evidence).
    const prior: RoundRecord[] = [
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "sha1" },
      { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "sha1" },
    ];
    expect(computeSameRootNotes(prior, [mkFinding({ code: "a" })], "sha2")["a"]).toContain(
      "round 1",
    );
    expect(computeSameRootNotes(prior, [mkFinding({ code: "a" })], "sha2")["a"]).not.toContain(
      "round 2",
    );
  });
});

describe("surface findings document — issue #141 (the stop signal in the blob agents read)", () => {
  const counts = (critical: number, major: number, minor: number, nit: number): SeverityCounts => ({
    critical,
    major,
    minor,
    nit,
  });
  const signal = (round: number, c: SeverityCounts): SurfaceSignal => ({
    round,
    convergence: convergenceSignal(c),
  });

  it("stamps the 0.6.0 surface version on every surfaced document, keeping the agent's fields verbatim", () => {
    const doc = surfaceFindings(findings, null);
    expect(doc.schema_version).toBe(SURFACE_SCHEMA_VERSION);
    expect(doc).toEqual({ ...findings, schema_version: SURFACE_SCHEMA_VERSION });
  });

  it("every version surfaceFindings emits is one stripSurfaceFields recognizes — the emit and strip axes stay coupled (issue #141 review r3)", () => {
    expect(SURFACE_SCHEMA_VERSIONS).toContain(SURFACE_SCHEMA_VERSION);
    expect(stripSurfaceFields(surfaceFindings(findings, null))).toEqual({
      ...findings,
      schema_version: DEFAULT_SCHEMA_VERSION,
    });
  });

  it("embeds the given stop signal — converged as a literal boolean", () => {
    const doc = surfaceFindings(findings, signal(2, counts(0, 0, 0, 50)));
    expect(doc.round).toBe(2);
    expect(doc.convergence).toEqual({ score: 0, threshold: 1, converged: true });
  });

  it("omits convergence and round when the signal is null (no round has completed)", () => {
    const doc = surfaceFindings(findings, null);
    expect(doc.convergence).toBeUndefined();
    expect(doc.round).toBeUndefined();
  });

  it("drops a crafted draft's OWN round/convergence keys — only the pipeline signal may survive the stamp (issue #141 review r6)", () => {
    // A corrupt/crafted doc declaring 0.7.0 with round/convergence keys must not be read back as a
    // pipeline signal; surfaceFindings strips any pre-existing keys before stamping its own.
    const crafted = {
      ...findings,
      schema_version: "0.7.0",
      round: 99,
      convergence: { score: 0, threshold: 1, converged: true },
    };
    const doc = surfaceFindings(crafted, signal(2, counts(0, 0, 1, 0)));
    expect(doc.round).toBe(2);
    expect(doc.convergence).toEqual({ score: 1, threshold: 1, converged: true });
  });

  it("convergenceSignal computes score/threshold/converged from one round's counts", () => {
    expect(convergenceSignal(counts(1, 0, 0, 0))).toEqual({
      score: 4,
      threshold: 1,
      converged: false,
    });
    expect(convergenceSignal(counts(0, 0, 0, 50))).toEqual({
      score: 0,
      threshold: 1,
      converged: true,
    });
    expect(convergenceSignal(counts(0, 1, 0, 0), 3)).toEqual({
      score: 2,
      threshold: 3,
      converged: true,
    });
  });

  it("signalForRound builds the full {round, convergence} shape from one round's counts", () => {
    expect(signalForRound(2, counts(0, 1, 0, 0))).toEqual({
      round: 2,
      convergence: { score: 2, threshold: 1, converged: false },
    });
    expect(signalForRound(1, counts(0, 0, 0, 0), 0)).toEqual({
      round: 1,
      convergence: { score: 0, threshold: 0, converged: true },
    });
  });

  it("the findings-json marker round-trips the surfaced document, signal included", () => {
    const doc = surfaceFindings(findings, signal(1, counts(0, 0, 1, 0)));
    const body = `sticky prose\n${findingsPointer(doc, undefined)}\nmore prose`;
    expect(parseFindingsMarker(body)).toEqual(doc);
  });

  it("budgets the surfaced overhead — a doc at the old embed boundary still embeds as base64 (issue #141 review)", () => {
    let doc = { ...findings, summary: "x".repeat(20000) };
    const b64 = (d: Findings): number =>
      Buffer.from(
        JSON.stringify(surfaceFindings(d, signal(1, counts(0, 0, 1, 0)))),
        "utf-8",
      ).toString("base64").length;
    // Grow the summary until the SURFACED marker crosses the old 40000 limit.
    while (b64(doc) <= 40000) {
      doc = { ...doc, summary: `${doc.summary}x` };
    }
    // The raised limit budgets the ~100-char stop signal, so a review that previously embedded as
    // base64 still does — it doesn't fall to the link form and lose the seed + signal.
    expect(b64(doc)).toBeLessThanOrEqual(40200);
    expect(
      findingsPointer(surfaceFindings(doc, signal(1, counts(0, 0, 1, 0))), undefined),
    ).toContain(";base64");
  });

  it("stripSurfaceFields drops the surface fields and restores the draft version on a 0.7.0 doc", () => {
    const surfaced = surfaceFindings(findings, signal(1, counts(0, 0, 1, 0)));
    expect(stripSurfaceFields(surfaced)).toEqual({
      ...findings,
      schema_version: DEFAULT_SCHEMA_VERSION,
    });
  });

  it("stripSurfaceFields passes unknown future versions (0.8.0) through untouched — the surface list grows with each emitted version", () => {
    const surfaced = {
      ...surfaceFindings(findings, signal(2, counts(0, 0, 1, 0))),
      schema_version: "0.8.0",
    };
    // An unknown version is not classified as surfaced (it could equally be a future draft); schema
    // validation downstream rejects it rather than silently rewriting it to a valid-looking draft.
    expect(stripSurfaceFields(surfaced)).toEqual(surfaced);
  });

  it("stripSurfaceFields leaves draft-version blobs untouched — even one carrying a 'round' key", () => {
    expect(stripSurfaceFields(findings)).toEqual(findings);
    expect(stripSurfaceFields({ ...findings, round: 7 })).toEqual({ ...findings, round: 7 });
  });

  it("stripSurfaceFields passes non-objects and versionless docs through for downstream validation", () => {
    expect(stripSurfaceFields("junk")).toBe("junk");
    expect(stripSurfaceFields([1, 2])).toEqual([1, 2]);
    expect(stripSurfaceFields(null)).toBeNull();
    const noVersion = { summary: "s", verdict: "comment", findings: [] };
    expect(stripSurfaceFields(noVersion)).toEqual(noVersion);
  });
});

describe("parseSurfaceSignal — issue #141 (verbatim carry of the prior round's signal)", () => {
  const signal: SurfaceSignal = {
    round: 2,
    convergence: { score: 1, threshold: 1, converged: true },
  };

  it("parses a well-formed signal from a surfaced blob", () => {
    expect(parseSurfaceSignal(surfaceFindings(findings, signal))).toEqual(signal);
  });

  it("returns null when the doc carries no signal (a pre-surface blob, or no round yet)", () => {
    expect(parseSurfaceSignal(findings)).toBeNull();
    expect(parseSurfaceSignal(surfaceFindings(findings, null))).toBeNull();
  });

  it("rejects a draft-version doc carrying round/convergence keys — the carry channel is version-gated like the seed channel (issue #141 review r3)", () => {
    expect(
      parseSurfaceSignal({
        ...findings,
        round: 1,
        convergence: { score: 0, threshold: 1, converged: true },
      }),
    ).toBeNull();
    expect(
      parseSurfaceSignal({
        ...findings,
        schema_version: "0.5.0",
        round: 1,
        convergence: { score: 0, threshold: 1, converged: true },
      }),
    ).toBeNull();
  });

  it("returns null on malformed signals rather than carrying corruption forward", () => {
    const base = surfaceFindings(findings, signal);
    expect(parseSurfaceSignal({ ...base, round: 1.5 })).toBeNull();
    expect(parseSurfaceSignal({ ...base, round: 0 })).toBeNull();
    expect(
      parseSurfaceSignal({ ...base, convergence: { score: "0", threshold: 1, converged: true } }),
    ).toBeNull();
    expect(
      parseSurfaceSignal({ ...base, convergence: { score: 0, threshold: 1, converged: "yes" } }),
    ).toBeNull();
    expect(parseSurfaceSignal("junk")).toBeNull();
  });

  it("rejects non-finite score/threshold (JSON.parse('1e400') is Infinity) — never carried one hop then silently dropped", () => {
    const base = surfaceFindings(findings, signal);
    expect(
      parseSurfaceSignal({
        ...base,
        convergence: { score: Infinity, threshold: 1, converged: true },
      }),
    ).toBeNull();
    expect(
      parseSurfaceSignal({
        ...base,
        convergence: { score: 1, threshold: Infinity, converged: true },
      }),
    ).toBeNull();
  });
});

describe("signal marker — issue #141 (the stop signal survives an oversized review)", () => {
  const signal: SurfaceSignal = {
    round: 1,
    convergence: { score: 2, threshold: 1, converged: false },
  };

  it("emits ONLY the compact signal marker when the whole-doc payload is too large and no jsonUrl is given", () => {
    let doc = { ...findings, summary: "x".repeat(20000) };
    while (
      Buffer.from(JSON.stringify(surfaceFindings(doc, signal)), "utf-8").toString("base64")
        .length <= 40200
    ) {
      doc = { ...doc, summary: `${doc.summary}x` };
    }
    const pointer = surfacedFindingsPointer(doc, signal, undefined);
    expect(pointer).not.toContain("findings-json;base64");
    expect(pointer).toContain("code-review:signal;base64");
    expect(parseSignalMarker(pointer)).toEqual(signal);
  });

  it("emits the link marker PLUS the compact signal marker when a jsonUrl fallback is available", () => {
    let doc = { ...findings, summary: "x".repeat(20000) };
    while (
      Buffer.from(JSON.stringify(surfaceFindings(doc, signal)), "utf-8").toString("base64")
        .length <= 40200
    ) {
      doc = { ...doc, summary: `${doc.summary}x` };
    }
    const pointer = surfacedFindingsPointer(doc, signal, "https://example.com/findings.zip");
    expect(pointer).toContain(
      "<!-- code-review:findings-json https://example.com/findings.zip -->",
    );
    expect(pointer).toContain("code-review:signal;base64");
  });

  it("embeds no signal marker when the whole-doc payload embeds as base64", () => {
    const pointer = surfacedFindingsPointer(findings, signal, undefined);
    expect(pointer).toContain("findings-json;base64");
    expect(pointer).not.toContain("code-review:signal;base64");
  });

  it("parseSignalMarker returns null when the body carries no signal marker", () => {
    expect(parseSignalMarker("just prose")).toBeNull();
    expect(
      parseSignalMarker(findingsPointer(surfaceFindings(findings, signal), undefined)),
    ).toBeNull();
  });

  it("carryForwardMarkers preserves the signal marker alongside the findings marker", () => {
    let doc = { ...findings, summary: "x".repeat(20000) };
    while (
      Buffer.from(JSON.stringify(surfaceFindings(doc, signal)), "utf-8").toString("base64")
        .length <= 40200
    ) {
      doc = { ...doc, summary: `${doc.summary}x` };
    }
    const pointer = surfacedFindingsPointer(doc, signal, "https://example.com/findings.zip");
    expect(pointer).toContain("code-review:signal;base64");
    expect(carryForwardMarkers(pointer)).toContain("code-review:signal;base64");
    expect(carryForwardMarkers(pointer)).toContain("findings-json");
  });
});
