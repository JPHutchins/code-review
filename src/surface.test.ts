import { describe, it, expect } from "vitest";
import { legacyEmbeddedMarker } from "./test-util.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainstSchema } from "./validate.js";
import {
  parseFindingsMarker,
  parseReviewedSha,
  parseReviewedRoute,
  parseReviewComplete,
  parseCompletedAncestor,
  COMPLETED_ANCESTOR_MARKER,
  isFullReviewSticky,
  AGENTS_STOP_DIRECTIVE,
  findingsPointer,
  findingPointer,
  parseRounds,
  roundsSummary,
  carryForwardMarkers,
  convergenceScore,
  convergenceSummary,
  convergenceSignal,
  changeSizeSummary,
  buildConvergence,
  parseConvergence,
  carriedConvergence,
  CONVERGENCE_TRAJECTORY_LIMIT,
  isBelowVisibilityFloor,
  priorBelowFloorNits,
  DEFAULT_NIT_VISIBILITY_FLOOR,
  stripSurfaceFields,
  parseSurfaceSignal,
  parseSignalMarker,
  SURFACE_SCHEMA_VERSION,
  SURFACE_SCHEMA_VERSIONS,
  DEFAULT_CONVERGENCE_THRESHOLD,
  computeCodeCounts,
  consecutiveCodeStreaks,
  metastasisNote,
  computeScopeMetastasis,
  SCOPE_METASTASIS_DECISION_PROMPT,
  computeSameRootNotes,
  MAX_CODES_PER_ROUND,
  reviewBodyPointer,
} from "./surface.js";
import { DEFAULT_SCHEMA_VERSION, FindingsCodec, ScopeMetastasisCodec } from "./schema.js";
import type { Finding, Findings, Severity } from "./schema.js";
import type { SurfaceSignal } from "./surface.js";
import type { RoundRecord, SeverityCounts } from "./types.js";

// The legacy surfaced-blob shape a pre-#156 sticky embedded — agent doc with pipeline round/convergence
// stripped, then surface version + stop signal + scope_metastasis stamped. Production no longer
// transforms the doc (the sticky now embeds the agent's COMPLETE document verbatim, issue #156), so
// this shape survives only in already-posted comments; the helper builds it to exercise the migration
// readers (stripSurfaceFields / parseSurfaceSignal / parseSignalMarker) that must still decode one.
type SurfacedTestDoc = Findings & {
  round?: number;
  convergence?: unknown;
  scope_metastasis?: unknown;
};
const surfacedDoc = (
  findings: Findings,
  signal: SurfaceSignal | null,
  scopeMetastasis?: unknown,
): SurfacedTestDoc =>
  ({
    ...Object.fromEntries(
      Object.entries(findings).filter(
        ([k]) => k !== "round" && k !== "convergence" && k !== "scope_metastasis",
      ),
    ),
    schema_version: SURFACE_SCHEMA_VERSION,
    ...(signal === null ? {} : signal),
    ...(scopeMetastasis === undefined || scopeMetastasis === null
      ? {}
      : { scope_metastasis: scopeMetastasis }),
  }) as unknown as SurfacedTestDoc;

// The legacy `code-review:rounds` marker parseRounds must still decode — production stopped writing it
// (issue #186), so the reader's tests hand-build the format here.
const mkRoundsMarker = (rounds: readonly RoundRecord[]): string =>
  `<!-- code-review:rounds;base64 ${Buffer.from(JSON.stringify(rounds), "utf-8").toString("base64")} -->`;

// The legacy `code-review:signal` marker parseSignalMarker + carryForwardMarkers must still decode
// (issue #186 retired the writer).
const mkSignalMarker = (signal: SurfaceSignal): string =>
  `<!-- code-review:signal;base64 ${Buffer.from(
    JSON.stringify({ schema_version: SURFACE_SCHEMA_VERSION, ...signal }),
    "utf-8",
  ).toString("base64")} -->`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundledSchemaPath = resolve(__dirname, "..", "schema", "findings.schema.json");

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
      likelihood: 1,
    },
  ],
} as unknown as Findings;

describe("parseFindingsMarker", () => {
  it("round-trips the whole findings document embedded by findingsPointer", () => {
    const body = `sticky prose\n${legacyEmbeddedMarker(findings)}\nmore prose`;
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
    const body = `sticky prose\n${legacyEmbeddedMarker(withSystemic)}\nmore prose`;
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
    const first = legacyEmbeddedMarker(findings);
    const second = legacyEmbeddedMarker({ ...findings, summary: "second" });
    expect(parseFindingsMarker(`${first}\n${second}`)).toEqual(findings);
  });
});

describe("findingsPointer — one form, always the artifact link (issue #217)", () => {
  it("emits the artifact link and never a base64 payload", () => {
    const marker = findingsPointer("https://api.github.com/repos/o/r/actions/artifacts/1/zip");

    expect(marker).toContain(
      "<!-- code-review:findings-json https://api.github.com/repos/o/r/actions/artifacts/1/zip -->",
    );
    expect(marker).not.toContain(";base64");
  });

  // A document's SIZE no longer changes the marker, which is the point: the form that used to appear
  // only past EMBED_LIMIT — and silently dropped the re-review seed when no url was given — is now the
  // only form, so there is no size at which a review loses its machine channel.
  it("emits the same marker regardless of how large the review is", () => {
    const huge = {
      ...findings,
      findings: Array.from({ length: 500 }, (_, i) => ({
        ...findings.findings[0],
        title: `F${String(i)}`,
        description: "x".repeat(200),
      })),
    } as unknown as Findings;
    const url = "https://api.github.com/repos/o/r/actions/artifacts/1/zip";

    expect(findingsPointer(url)).toBe(findingsPointer(url));
    expect(JSON.stringify(huge).length).toBeGreaterThan(40000);
  });

  it("gives a per-finding pointer the same whole-document artifact", () => {
    const url = "https://api.github.com/repos/o/r/actions/artifacts/1/zip";

    expect(findingPointer(url)).toBe(findingsPointer(url));
  });
});

describe("AGENTS stop directive — a rule, not an inventory (issues #171, #217)", () => {
  // It used to open by telling the agent to decode. The prose became the review, so decoding reaches
  // the same content the long way round — but only WHERE the comment is a review.
  it("sends the agent to the prose only where the prose is the review", () => {
    expect(AGENTS_STOP_DIRECTIVE).toContain("Read the prose when it is there");
    expect(AGENTS_STOP_DIRECTIVE.toUpperCase()).not.toContain("DECODE OR FETCH IT");
    expect(AGENTS_STOP_DIRECTIVE.toUpperCase()).not.toContain("DOWNLOAD AND READ THE FULL SCHEMA");
  });

  // This constant also rides the in-progress placeholder, the did-not-complete notice and the
  // empty-diff notice, whose prose is a status line. Telling an agent to read the prose there loses
  // the review, so the directive has to name that case.
  it("tells the agent to decode where the prose is not the review", () => {
    expect(AGENTS_STOP_DIRECTIVE).toContain("Decode the marker when the prose is not the review");
    expect(AGENTS_STOP_DIRECTIVE).toContain("status notice");
  });

  // Every inventory of what the prose holds was false on some surface: the cost is absent when the
  // envelope is lost, the convergence badge is suppressed on a CI-fix pass, and the prose DOES render
  // derived recurrence notes. So the directive states the rule and enumerates neither side.
  it("makes no claim about what either side contains", () => {
    for (const inventory of [
      "the cost",
      "convergence score",
      "recurrence signals",
      "below-visibility-floor nits",
      "everything the JSON does",
    ]) {
      expect(AGENTS_STOP_DIRECTIVE).not.toContain(inventory);
    }
    expect(AGENTS_STOP_DIRECTIVE).toContain("a field the prose does not render");
  });

  // Inline comments carry this verbatim and render no run link, so the summary is named without
  // promising a link this surface may not have.
  it("names the run summary for the rounds the prose carries only in part", () => {
    expect(AGENTS_STOP_DIRECTIVE).toContain("anchored to diff lines");
    expect(AGENTS_STOP_DIRECTIVE).toContain("too large to embed");
    expect(AGENTS_STOP_DIRECTIVE).toContain("workflow run's summary");
    expect(AGENTS_STOP_DIRECTIVE).not.toContain("linked at the foot");
  });

  // A carried blob may declare an older schema_version than the current file; resolving to THAT
  // version is what stops a decoder validating it against the wrong schema.
  it("resolves the schema by the document's own version, not the current URL alone", () => {
    expect(AGENTS_STOP_DIRECTIVE).toContain("schema_version");
    expect(AGENTS_STOP_DIRECTIVE).toContain("for THAT version");
    expect(AGENTS_STOP_DIRECTIVE).toContain("WHOLE findings document");
  });

  it("embeds the schema's OWN $id, so the directive URL can't drift from the canonical location", () => {
    // Derived from the schema file, not a hardcoded copy — the assertion FAILS if the two diverge,
    // binding the directive's URL to findings.schema.json's $id as the single source of truth.
    const schemaId = (JSON.parse(readFileSync(bundledSchemaPath, "utf-8")) as { $id: string }).$id;
    expect(typeof schemaId).toBe("string");
    expect(schemaId.length).toBeGreaterThan(0);
    expect(AGENTS_STOP_DIRECTIVE).toContain(schemaId);
    // The embedded URL is whitespace-bounded, never glued to punctuation — an agent that splits on
    // whitespace to fetch it must not capture a trailing '.'.
    expect(AGENTS_STOP_DIRECTIVE).toContain(`${schemaId} `);
    expect(AGENTS_STOP_DIRECTIVE).not.toContain(`${schemaId}.`);
  });

  // It rides EVERY per-finding inline comment, so its size is paid N times on an inline round.
  it("stays small enough to ride every inline comment", () => {
    expect(AGENTS_STOP_DIRECTIVE.length).toBeLessThan(1000);
  });

  it("stays a well-formed HTML comment — no bare '--' inside", () => {
    expect(AGENTS_STOP_DIRECTIVE.startsWith("<!--")).toBe(true);
    expect(AGENTS_STOP_DIRECTIVE.endsWith("-->")).toBe(true);
    expect(AGENTS_STOP_DIRECTIVE.slice(4, -3)).not.toContain("--");
  });

  it("rides ahead of BOTH the whole-document and the per-finding inline markers", () => {
    const url = "https://api.github.com/repos/o/r/actions/artifacts/1/zip";
    expect(findingsPointer(url).startsWith(AGENTS_STOP_DIRECTIVE)).toBe(true);
    expect(findingPointer(url).startsWith(AGENTS_STOP_DIRECTIVE)).toBe(true);
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
  const oneRound = mkRoundsMarker([{ critical: 0, major: 1, minor: 0, nit: 0 }]);

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

  it("round-trips a legacy rounds marker → parseRounds", () => {
    const rounds = [counts(1, 2, 0, 0), counts(0, 1, 3, 0), counts(0, 0, 0, 0)];
    expect(parseRounds(`prose\n${mkRoundsMarker(rounds)}\nmore`)).toEqual(rounds);
  });

  it("yields no rounds when there is no marker", () => {
    expect(parseRounds("no marker here")).toEqual([]);
  });

  it("decodes to no history for a malformed or wrong-shaped marker rather than throwing", () => {
    expect(parseRounds("<!-- code-review:rounds;base64 not$$base64 -->")).toEqual([]);
    const notArray = Buffer.from(JSON.stringify({ critical: 1 }), "utf-8").toString("base64");
    expect(parseRounds(`<!-- code-review:rounds;base64 ${notArray} -->`)).toEqual([]);
    const missingKey = Buffer.from(JSON.stringify([{ critical: 1 }]), "utf-8").toString("base64");
    expect(parseRounds(`<!-- code-review:rounds;base64 ${missingKey} -->`)).toEqual([]);
  });

  it("renders the trajectory as numeric per-round convergence scores (issue #174)", () => {
    expect(
      roundsSummary([
        { round: 1, score: 2.4 },
        { round: 2, score: 1.1 },
        { round: 3, score: 0.42 },
      ]),
    ).toBe("**Round 3** · 2.40 → 1.10 → 0.42");
  });

  it("shows the round number even for the first round, and nothing when there is no history", () => {
    expect(roundsSummary([{ round: 1, score: 0.5 }])).toBe("**Round 1** · 0.50");
    expect(roundsSummary([])).toBe("");
  });

  it("carryForwardMarkers preserves the rounds marker alongside findings + reviewed-sha", () => {
    const body = `x\n${mkRoundsMarker([counts(0, 0, 1, 0)])}\n<!-- reviewed-sha: ${"a".repeat(40)} -->`;
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
    const many = Array.from({ length: 12 }, (_, i) => ({ round: i + 1, score: (i + 1) / 10 }));
    const summary = roundsSummary(many);
    expect(summary.startsWith("**Round 12** · … → ")).toBe(true);
    // Only the last 8 scores are shown; the earliest (round 1, 0.10) is elided.
    expect(summary).toContain("1.20");
    expect(summary).not.toContain("0.10 →");
  });

  it("labels the round from an explicit count, and renders — for a legacy round with no stored score (issue #174)", () => {
    // A legacy rounds-marker round carries no score, so it renders "—", never a chip — the line never
    // mixes units. The explicit count still labels the round even when the history lost entries.
    expect(roundsSummary([{ round: 3 }], 3)).toBe("**Round 3** · —");
    expect(roundsSummary([{ round: 1 }, { round: 2, score: 0.4 }])).toBe("**Round 2** · — → 0.40");
  });

  it("keeps the label when every marker entry was filtered — the carried count still claims the round (issue #141 review r4)", () => {
    expect(roundsSummary([], 3)).toBe("**Round 3**");
    expect(roundsSummary([])).toBe("");
  });
});

describe("convergence score — per-finding weighting (issue #133 / #162)", () => {
  const docOf = (...items: ReadonlyArray<readonly [Severity, number, number?]>): Findings =>
    ({
      schema_version: DEFAULT_SCHEMA_VERSION,
      summary: "s",
      verdict: "comment",
      findings: items.map(([severity, confidence, likelihood = 1], i) => ({
        path: "src/x.ts",
        start_line: i + 1,
        end_line: i + 1,
        severity,
        title: "t",
        description: "d",
        reasoning: "r",
        confidence,
        likelihood,
      })),
    }) as unknown as Findings;

  it("scores floor + max(0, ceiling − floor) × confidence; confidence 1 recovers ceilings 4/2/1/0", () => {
    expect(DEFAULT_CONVERGENCE_THRESHOLD).toBe(1);
    expect(convergenceScore(docOf(["critical", 1]), 1)).toBe(4);
    expect(convergenceScore(docOf(["major", 1]), 1)).toBe(2);
    expect(convergenceScore(docOf(["minor", 1]), 1)).toBe(1);
    expect(convergenceScore(docOf(["nit", 1]), 1)).toBe(0);
    expect(convergenceScore(docOf(["major", 0.5]), 1)).toBe(1.25);
    // minor floor 0.1 + 0.9 × 0.4 = 0.46 (issue #178 gave minor a floor)
    expect(convergenceScore(docOf(["minor", 0.4]), 1)).toBe(0.46);
    expect(convergenceScore(docOf(["minor", 1], ["minor", 1]), 1)).toBe(2);
  });

  it("likelihood modulates the contribution alongside confidence (issue #163)", () => {
    // major, confidence 0.8, likelihood 0.5 → 0.5 + 1.5 × 0.8 × 0.5 = 1.1
    expect(convergenceScore(docOf(["major", 0.8, 0.5]), 1)).toBe(1.1);
    // a certain-but-never-triggered footgun (the `__slots__` case) is crushed toward its floor
    // (0.1 for a minor after issue #178): 0.1 + 0.9 × 0.02 = 0.118 → 0.12
    expect(convergenceScore(docOf(["minor", 1, 0.02]), 1)).toBe(0.12);
    // likelihood 0 zeroes the headroom entirely — only the floor survives
    expect(convergenceScore(docOf(["critical", 1, 0]), 1)).toBe(1.01);
    expect(convergenceScore(docOf(["minor", 1, 0]), 1)).toBe(0.1);
  });

  it("a nit never contributes, at any confidence", () => {
    expect(convergenceScore(docOf(["nit", 1], ["nit", 0.3]), 1)).toBe(0);
    expect(convergenceSummary(docOf(["nit", 1]), 1)).toBe(
      "**Convergence** 🏁 0.00 ≤ 1 — converged",
    );
  });

  it("an open critical never converges — its floor exceeds the threshold even at confidence 0", () => {
    expect(convergenceScore(docOf(["critical", 0]), 1)).toBe(1.01);
    expect(convergenceSummary(docOf(["critical", 0]), 1)).toBe(
      "**Convergence** 🔄 1.01 > 1 — iterating",
    );
    expect(convergenceSummary(docOf(["critical", 0]), 3)).toBe(
      "**Convergence** 🔄 3.01 > 3 — iterating",
    );
  });

  it("clamps the headroom so a threshold ≥ the critical ceiling cannot invert the score", () => {
    expect(convergenceScore(docOf(["critical", 1]), 5)).toBe(5.01);
    expect(convergenceScore(docOf(["critical", 0]), 5)).toBe(5.01);
  });

  it("rounds to 2 decimals and compares the boolean on that same rounded value", () => {
    // three minors at 0.1 + 0.9 × 0.26 = 0.334 each → raw 1.002, which rounds to 1.00 ≤ 1 (issue #178)
    expect(convergenceSummary(docOf(["minor", 0.26], ["minor", 0.26], ["minor", 0.26]), 1)).toBe(
      "**Convergence** 🏁 1.00 ≤ 1 — converged",
    );
  });

  it("respects a raised threshold as the single tolerance knob", () => {
    expect(convergenceSummary(docOf(["minor", 1], ["minor", 1]), 3)).toBe(
      "**Convergence** 🏁 2.00 ≤ 3 — converged",
    );
    expect(convergenceSummary(docOf(["major", 1]), 3)).toBe(
      "**Convergence** 🏁 2.00 ≤ 3 — converged",
    );
  });

  it("renders score and threshold exactly so the printed inequality matches the comparison (#135 review)", () => {
    expect(convergenceSummary(docOf(["minor", 1]), 1.5)).toBe(
      "**Convergence** 🏁 1.00 ≤ 1.5 — converged",
    );
    expect(convergenceSummary(docOf(["minor", 1]), 0.95)).toBe(
      "**Convergence** 🔄 1.00 > 0.95 — iterating",
    );
    // A threshold a lossy formatter (toFixed(1)) would round to "1.0" must print its true value, or
    // the converged line reads as a false inequality — the guard case from the pre-#162 suite.
    expect(convergenceSummary(docOf(["minor", 1]), 1.04)).toBe(
      "**Convergence** 🏁 1.00 ≤ 1.04 — converged",
    );
  });

  it("round-trips convergence through the blob so the next round reads it back (#174)", () => {
    // A completed round's stamp, appended to a prior trajectory, survives serialize -> parseFindingsMarker
    // -> parseConvergence, and carriedConvergence reads the SAME stamp — the round -> notice -> round path,
    // where the notice carries the prior convergence forward in its blob.
    const conv = buildConvergence(docOf(["minor", 0.7]), 1, [{ round: 1, score: 2 }], 2, {});
    expect(conv.rounds).toHaveLength(2);
    const decoded = parseFindingsMarker(
      legacyEmbeddedMarker({ ...docOf(["minor", 0.7]), convergence: conv }),
    );
    expect(parseConvergence(decoded)).toEqual(conv);
    expect(carriedConvergence(decoded, "")).toEqual(conv);
  });

  it("bounds the stamped trajectory to the most recent rounds without renumbering (#174)", () => {
    const prior = Array.from({ length: 70 }, (_, i) => ({ round: i + 1, score: i / 100 }));
    const conv = buildConvergence(docOf(["minor", 0.7]), 1, prior, 71, {});
    expect(conv.rounds).toHaveLength(CONVERGENCE_TRAJECTORY_LIMIT);
    // This round is the last entry, numbered correctly; the oldest rounds are dropped, but the survivors
    // keep their true round numbers — dropping never renumbers.
    expect(conv.rounds?.[conv.rounds.length - 1]?.round).toBe(71);
    expect(conv.rounds?.[0]?.round).toBe(71 - CONVERGENCE_TRAJECTORY_LIMIT + 1);
  });

  it("rejects a convergence with a non-finite score — Infinity serializes to null and would drop the trajectory (#185 review)", () => {
    expect(
      parseConvergence({
        convergence: {
          score: Infinity,
          threshold: 1,
          converged: false,
          rounds: [{ round: 1, score: 1 }],
        },
      }),
    ).toBeNull();
  });

  it("treats a convergence with an empty trajectory as absent, so it can't reset the round count (#185 review)", () => {
    expect(
      parseConvergence({ convergence: { score: 0, threshold: 1, converged: true, rounds: [] } }),
    ).toBeNull();
  });

  it("classifies a post-#174 notice carrying convergence only in its blob as full-review history (#185 review)", () => {
    // A notice: no route marker, no legacy rounds marker — the trajectory rides only the convergence
    // blob, so isFullReviewSticky must read it there or the empty-mechanic guard buries the review.
    const doc: Findings = {
      ...docOf(["minor", 0.7]),
      convergence: {
        score: 0.73,
        threshold: 1,
        converged: true,
        rounds: [{ round: 1, score: 0.73 }],
      },
    };
    const body = `<!-- code-review -->\n${legacyEmbeddedMarker(doc)}`;
    expect(body).not.toContain("reviewed-route");
    expect(isFullReviewSticky(body)).toBe(true);
  });
});

describe("nit visibility floor — issue #164", () => {
  const nit = (over: Partial<Finding> = {}): Finding =>
    ({
      path: "src/x.ts",
      start_line: 1,
      end_line: 1,
      severity: "nit",
      title: "t",
      description: "d",
      reasoning: "r",
      confidence: 0.5,
      likelihood: 0.4,
      ...over,
    }) as unknown as Finding;

  it("defaults the floor to 0.25", () => {
    expect(DEFAULT_NIT_VISIBILITY_FLOOR).toBe(0.25);
  });

  describe("isBelowVisibilityFloor", () => {
    it("flags a nit whose confidence × likelihood is below the floor", () => {
      // 0.5 × 0.4 = 0.20 < 0.25
      expect(isBelowVisibilityFloor(nit())).toBe(true);
    });

    it("does not flag a nit at or above the floor", () => {
      // 0.5 × 0.6 = 0.30 >= 0.25
      expect(isBelowVisibilityFloor(nit({ likelihood: 0.6 }))).toBe(false);
    });

    it("never flags a non-nit, however low its score (nit-only)", () => {
      for (const severity of ["minor", "major", "critical"] as const) {
        expect(isBelowVisibilityFloor(nit({ severity, confidence: 0.01, likelihood: 0.01 }))).toBe(
          false,
        );
      }
    });

    it("fails OPEN to visible when likelihood is missing (a pre-0.9 blob has none)", () => {
      const noLikelihood = { severity: "nit", confidence: 0.5 };
      expect(isBelowVisibilityFloor(noLikelihood)).toBe(false);
    });

    it("honors a custom floor", () => {
      // 0.5 × 0.4 = 0.20; below 0.5, at-or-above 0.1
      expect(isBelowVisibilityFloor(nit(), 0.5)).toBe(true);
      expect(isBelowVisibilityFloor(nit(), 0.1)).toBe(false);
    });
  });

  describe("priorBelowFloorNits", () => {
    const priorDoc = (fs: readonly unknown[]): unknown => ({
      schema_version: "0.9.0",
      summary: "s",
      verdict: "comment",
      findings: fs,
    });

    it("extracts the below-floor nits' identifying bits (code, title, path)", () => {
      const doc = priorDoc([
        nit({ code: "c1", title: "T1", path: "src/a.ts" }), // m 0.20 — below
        nit({ likelihood: 0.9, title: "T2" }), // m 0.45 — above
        nit({ severity: "minor", title: "T3" }), // not a nit
      ]);
      expect(priorBelowFloorNits(doc)).toEqual([{ title: "T1", code: "c1", path: "src/a.ts" }]);
    });

    it("omits code when absent (title-keyed) and drops a titleless entry", () => {
      const doc = priorDoc([
        nit({ title: "only-title" }),
        nit({ title: 123 as unknown as string }),
      ]);
      expect(priorBelowFloorNits(doc)).toEqual([{ title: "only-title", path: "src/x.ts" }]);
    });

    it("returns [] for an old blob whose nits have no likelihood (fails open)", () => {
      const doc = priorDoc([{ severity: "nit", title: "T", path: "p", confidence: 0.1 }]);
      expect(priorBelowFloorNits(doc)).toEqual([]);
    });

    it("returns [] for a non-object, a null, or a doc with no findings array", () => {
      expect(priorBelowFloorNits(null)).toEqual([]);
      expect(priorBelowFloorNits("nope")).toEqual([]);
      expect(priorBelowFloorNits({ findings: "not-an-array" })).toEqual([]);
    });
  });
});

describe("convergence score — calibration (issue #178)", () => {
  const mkFinding = (severity: Severity, confidence: number, likelihood = 1) => ({
    path: "src/x.ts",
    start_line: 1,
    end_line: 1,
    severity,
    title: "t",
    description: "d",
    reasoning: "r",
    confidence,
    likelihood,
  });
  const mkSystemic = (severity: Severity, confidence: number, likelihood: number) => ({
    title: "sys",
    description: "d",
    severity,
    reasoning: "r",
    confidence,
    likelihood,
  });
  const doc = (findings: readonly unknown[], systemic: readonly unknown[] = []): Findings =>
    ({
      schema_version: DEFAULT_SCHEMA_VERSION,
      summary: "s",
      verdict: "comment",
      findings,
      systemic_problems: systemic,
    }) as unknown as Findings;

  it("a minor carries a 0.1 floor the modulation cannot erode; a single solid minor still converges", () => {
    expect(convergenceScore(doc([mkFinding("minor", 1, 0)]), 1)).toBe(0.1);
    expect(convergenceScore(doc([mkFinding("minor", 0.8, 0.9)]), 1)).toBe(0.75);
  });

  it("a pile of low-likelihood minors resists convergence — count now matters", () => {
    const tiny = Array.from({ length: 10 }, () => mkFinding("minor", 0.6, 0.1));
    expect(convergenceScore(doc(tiny), 1)).toBe(1.54);
    expect(convergenceSignal(doc(tiny), 1).converged).toBe(false);
  });

  it("scores a systemic problem with likelihood 1, ignoring its written value", () => {
    // written 0.15, scored as if 1 → 0.1 + 0.9 × 0.75 = 0.78
    expect(convergenceScore(doc([], [mkSystemic("minor", 0.75, 0.15)]), 1)).toBe(0.78);
    expect(convergenceScore(doc([], [mkSystemic("minor", 0.75, 1)]), 1)).toBe(0.78);
    // a FINDING minor at the same numbers IS discounted: 0.1 + 0.9 × 0.75 × 0.15 = 0.2
    expect(convergenceScore(doc([mkFinding("minor", 0.75, 0.15)]), 1)).toBe(0.2);
  });

  it("the camas #283 scenario now iterates (field-validated)", () => {
    const findings = [
      mkFinding("minor", 0.85, 0.1),
      mkFinding("minor", 0.7, 0.05),
      mkFinding("minor", 0.7, 0.3),
      mkFinding("minor", 0.75, 0.5),
      mkFinding("minor", 0.6, 0.15),
    ];
    const sig = convergenceSignal(doc(findings, [mkSystemic("minor", 0.75, 0.15)]), 1);
    expect(sig.score).toBe(1.99);
    expect(sig.converged).toBe(false);
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
    likelihood: 1,
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

  it("parseRounds caps a round's decoded codes at the top-N by count", () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`code-${String(i)}`, 1]));
    const parsed = parseRounds(
      mkRoundsMarker([{ critical: 0, major: 0, minor: 0, nit: 0, codes: many }]),
    );
    expect(parsed[0]?.codes).toBeDefined();
    expect(Object.keys(parsed[0]?.codes ?? {})).toHaveLength(MAX_CODES_PER_ROUND);
  });

  it("parseRounds round-trips coded rounds and keeps count-only rounds beside them", () => {
    const rounds: RoundRecord[] = [
      counts(1, 0, 0, 0),
      coded(counts(0, 1, 0, 0), { "body-reconstruction": 2 }),
    ];
    expect(parseRounds(`prose\n${mkRoundsMarker(rounds)}\nmore`)).toEqual(rounds);
  });

  it("parseRounds chains the PRECEDING round's NORMALIZED codes as priorCodes across 3+ rounds", () => {
    const hi = (prefix: string): Record<string, number> =>
      Object.fromEntries(
        Array.from({ length: MAX_CODES_PER_ROUND }, (_, i) => [`${prefix}${String(i)}`, 5]),
      );
    // "watched" recurs at a low count and survives each round via the prior-kept pass; "dropme" appears
    // from round 2 but is cut from round 2's NORMALIZED output (not in round 1's prior), so it must NOT
    // reappear in round 3 — proving the chain feeds forward round 2's normalized codes, not its raw ones.
    const parsed = parseRounds(
      mkRoundsMarker([
        coded(counts(0, 0, 0, 0), { watched: 1 }),
        coded(counts(0, 0, 0, 0), { ...hi("h"), watched: 1, dropme: 1 }),
        coded(counts(0, 0, 0, 0), { ...hi("g"), watched: 1, dropme: 1 }),
      ]),
    );
    expect(parsed[1]?.codes?.["watched"]).toBe(1);
    expect(parsed[1]?.codes?.["dropme"]).toBeUndefined();
    expect(parsed[2]?.codes?.["watched"]).toBe(1);
    expect(parsed[2]?.codes?.["dropme"]).toBeUndefined();
  });

  it("parseRounds keeps a valid round number and drops an invalid one, preserving the counts", () => {
    expect(
      parseRounds(mkRoundsMarker([{ critical: 0, major: 1, minor: 0, nit: 0, round: 5 }]))[0]
        ?.round,
    ).toBe(5);
    const badRound = `<!-- code-review:rounds;base64 ${Buffer.from(
      JSON.stringify([{ critical: 0, major: 1, minor: 0, nit: 0, round: 1.5 }]),
      "utf-8",
    ).toString("base64")} -->`;
    expect(parseRounds(badRound)[0]).toEqual({ critical: 0, major: 1, minor: 0, nit: 0 });
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

  it("computeScopeMetastasis derives the same flagged codes as the prose note — one computation, two surfaces (issue #150)", () => {
    const twoStreak: RoundRecord[] = [
      coded(counts(0, 0, 0, 0), { a: 1 }),
      coded(counts(0, 0, 0, 0), { a: 1 }),
    ];
    expect(computeScopeMetastasis(twoStreak)).toBeNull();
    expect(computeScopeMetastasis(twoStreak, 2)).toEqual({
      decision_prompt: SCOPE_METASTASIS_DECISION_PROMPT,
      recurring: [{ code: "a", consecutive_rounds: 2, start_round: 1 }],
    });
  });

  it("computeScopeMetastasis reports per-code consecutive-round counts with the streak's start round", () => {
    // Streaks END at the last recorded round (a code absent there has no streak, like
    // consecutiveCodeStreaks): `a` runs rounds 3-5, `b` rounds 4-5.
    const rounds: RoundRecord[] = [
      coded(counts(0, 0, 0, 0), { a: 1 }),
      counts(0, 0, 0, 0), // no codes record — ends every streak
      coded(counts(0, 0, 0, 0), { a: 1 }),
      coded(counts(0, 0, 0, 0), { a: 1, b: 1 }),
      coded(counts(0, 0, 0, 0), { a: 1, b: 1 }),
    ];
    // Default threshold 3: only `a`'s 3-streak is flagged.
    expect(computeScopeMetastasis(rounds)).toEqual({
      decision_prompt: SCOPE_METASTASIS_DECISION_PROMPT,
      recurring: [{ code: "a", consecutive_rounds: 3, start_round: 3 }],
    });
    // A lower threshold admits `b`'s 2-streak too, with its own start round.
    expect(computeScopeMetastasis(rounds, 2)).toEqual({
      decision_prompt: SCOPE_METASTASIS_DECISION_PROMPT,
      recurring: [
        { code: "a", consecutive_rounds: 3, start_round: 3 },
        { code: "b", consecutive_rounds: 2, start_round: 4 },
      ],
    });
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
        likelihood: 1,
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

  it("parseRounds round-trips codes + sha across many rounds", () => {
    const rounds: RoundRecord[] = Array.from({ length: 10 }, (_, i) =>
      i === 9
        ? { ...coded(counts(0, 0, 0, 0), { a: 1 }), sha: "last" }
        : { ...coded(counts(0, 0, 0, 0), { [String(i)]: 1 }), sha: `sha${String(i)}` },
    );
    const parsed = parseRounds(mkRoundsMarker(rounds));
    expect(parsed).toHaveLength(10);
    expect(parsed[0]?.codes).toEqual({ "0": 1 });
    expect(parsed[0]?.sha).toBe("sha0");
    expect(parsed[9]?.codes).toEqual({ a: 1 });
    expect(parsed[9]?.sha).toBe("last");
  });

  it("parseRounds drops count-0 code entries so every consumer agrees 0 is absence", () => {
    const parsed = parseRounds(mkRoundsMarker([coded(counts(0, 0, 0, 0), { a: 0, b: 0, c: 1 })]));
    expect(parsed[0]?.codes).toEqual({ c: 1 });
  });

  it("parseRounds's per-round cap prefers codes that recurred in the previous round", () => {
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`code-${String(i)}`, 1]));
    const parsed = parseRounds(
      mkRoundsMarker([coded(counts(0, 0, 0, 0), { "code-8": 1 }), coded(counts(0, 0, 0, 0), nine)]),
    );
    expect(parsed[1]?.codes).toBeDefined();
    expect(parsed[1]?.codes?.["code-8"]).toBe(1);
    expect(Object.keys(parsed[1]?.codes ?? {})).toHaveLength(MAX_CODES_PER_ROUND);
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

  it("parseRounds's per-round cap never drops a code that recurred in the previous round, even at a low count (issue #145 r4)", () => {
    const codes: Record<string, number> = Object.fromEntries([
      ...Array.from({ length: 8 }, (_, i) => [`bulk-${String(i)}`, 5] as [string, number]),
      ["watched", 1] as [string, number],
    ]);
    const parsed = parseRounds(
      mkRoundsMarker([coded(counts(0, 0, 0, 0), { watched: 1 }), coded(counts(0, 0, 0, 0), codes)]),
    );
    expect(parsed[1]?.codes?.["watched"]).toBe(1);
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

describe("surface findings document — issue #141 (the legacy surfaced-blob shape the migration readers decode)", () => {
  const counts = (critical: number, major: number, minor: number, nit: number): SeverityCounts => ({
    critical,
    major,
    minor,
    nit,
  });
  const countsToDoc = (c: SeverityCounts): Findings =>
    ({
      schema_version: DEFAULT_SCHEMA_VERSION,
      summary: "s",
      verdict: "comment",
      findings: (["critical", "major", "minor", "nit"] as const).flatMap((severity) =>
        Array.from({ length: c[severity] }, (_, i) => ({
          path: "src/x.ts",
          start_line: i + 1,
          end_line: i + 1,
          severity,
          title: "t",
          description: "d",
          reasoning: "r",
          confidence: 1,
          likelihood: 1,
        })),
      ),
    }) as unknown as Findings;
  const signal = (round: number, c: SeverityCounts): SurfaceSignal => ({
    round,
    convergence: convergenceSignal(countsToDoc(c)),
  });

  it("stamps the current surface version on every surfaced document, keeping the agent's fields verbatim", () => {
    const doc = surfacedDoc(findings, null);
    expect(doc.schema_version).toBe(SURFACE_SCHEMA_VERSION);
    expect(doc).toEqual({ ...findings, schema_version: SURFACE_SCHEMA_VERSION });
  });

  it("every version surfacedDoc emits is one stripSurfaceFields recognizes — the emit and strip axes stay coupled (issue #141 review r3)", () => {
    expect(SURFACE_SCHEMA_VERSIONS).toContain(SURFACE_SCHEMA_VERSION);
    expect(stripSurfaceFields(surfacedDoc(findings, null))).toEqual({
      ...findings,
      schema_version: DEFAULT_SCHEMA_VERSION,
    });
  });

  it("embeds the given stop signal — converged as a literal boolean", () => {
    const doc = surfacedDoc(findings, signal(2, counts(0, 0, 0, 50)));
    expect(doc.round).toBe(2);
    expect(doc.convergence).toEqual({ score: 0, threshold: 1, converged: true });
  });

  it("omits convergence and round when the signal is null (no round has completed)", () => {
    const doc = surfacedDoc(findings, null);
    expect(doc.convergence).toBeUndefined();
    expect(doc.round).toBeUndefined();
  });

  it("stamps the given scope_metastasis entry and omits it when none is given (issue #150)", () => {
    const entry = {
      decision_prompt: "decide",
      recurring: [{ code: "a", consecutive_rounds: 3, start_round: 1 }],
    };
    expect(surfacedDoc(findings, null, entry).scope_metastasis).toEqual(entry);
    expect(surfacedDoc(findings, null).scope_metastasis).toBeUndefined();
  });

  it("the scope_metastasis codecs and the ajv gate reject the SAME extra keys — both sides asserted (issue #150 review r2)", () => {
    const clean = {
      decision_prompt: "decide",
      recurring: [{ code: "a", consecutive_rounds: 3, start_round: 1 }],
    };
    expect(ScopeMetastasisCodec.decode(clean)._tag).toBe("Right");
    expect(
      validateAgainstSchema({ ...findings, scope_metastasis: clean }, bundledSchemaPath).valid,
    ).toBe(true);
    // A seed-echoing draft smuggling extra keys into the entry (or its items) must fail BOTH gates
    // — the codec's Strict refinements and the schema's additionalProperties:false agree.
    const smuggledItem = {
      decision_prompt: "decide",
      recurring: [{ code: "a", consecutive_rounds: 3, start_round: 1, note: "x" }],
    };
    expect(ScopeMetastasisCodec.decode(smuggledItem)._tag).toBe("Left");
    expect(
      validateAgainstSchema({ ...findings, scope_metastasis: smuggledItem }, bundledSchemaPath)
        .valid,
    ).toBe(false);
    const smuggledTop = { decision_prompt: "decide", recurring: [], extra: 1 };
    expect(ScopeMetastasisCodec.decode(smuggledTop)._tag).toBe("Left");
    expect(
      validateAgainstSchema({ ...findings, scope_metastasis: smuggledTop }, bundledSchemaPath)
        .valid,
    ).toBe(false);
    // Non-safe integers: JSON Schema's "integer" alone would accept 1e21 (a whole number), so the
    // schema's maximum must bound it exactly where the codec's isSafeInteger does (issue #150
    // review r3) — both gates reject it, and both accept an integer-valued 3.0.
    const nonSafe = {
      decision_prompt: "decide",
      recurring: [{ code: "a", consecutive_rounds: 1e21, start_round: 1 }],
    };
    expect(ScopeMetastasisCodec.decode(nonSafe)._tag).toBe("Left");
    expect(
      validateAgainstSchema({ ...findings, scope_metastasis: nonSafe }, bundledSchemaPath).valid,
    ).toBe(false);
    const integerValued = {
      decision_prompt: "decide",
      recurring: [{ code: "a", consecutive_rounds: 3.0, start_round: 1 }],
    };
    expect(ScopeMetastasisCodec.decode(integerValued)._tag).toBe("Right");
    expect(
      validateAgainstSchema({ ...findings, scope_metastasis: integerValued }, bundledSchemaPath)
        .valid,
    ).toBe(true);
    // The tolerated draft-level field still decodes inside a findings doc (the seed-echo contract).
    const echoed = { ...findings, scope_metastasis: clean };
    expect(FindingsCodec.decode(echoed)._tag).toBe("Right");
  });

  it("drops a draft-carried scope_metastasis — the pipeline recomputes the entry from the rounds history, never reuses a stale echo (issue #150)", () => {
    const crafted = {
      ...findings,
      scope_metastasis: {
        decision_prompt: "stale",
        recurring: [{ code: "stale", consecutive_rounds: 9, start_round: 1 }],
      },
    };
    const entry = {
      decision_prompt: "fresh",
      recurring: [{ code: "fresh", consecutive_rounds: 3, start_round: 2 }],
    };
    const doc = surfacedDoc(crafted, null, entry);
    expect(doc.scope_metastasis).toEqual(entry);
  });

  it("drops a crafted draft's OWN round/convergence keys — only the pipeline signal may survive the stamp (issue #141 review r6)", () => {
    // A corrupt/crafted doc declaring 0.7.0 with round/convergence keys must not be read back as a
    // pipeline signal; surfacedDoc strips any pre-existing keys before stamping its own.
    const crafted = {
      ...findings,
      schema_version: "0.7.0",
      round: 99,
      convergence: { score: 0, threshold: 1, converged: true },
    };
    const doc = surfacedDoc(crafted, signal(2, counts(0, 0, 1, 0)));
    expect(doc.round).toBe(2);
    expect(doc.convergence).toEqual({ score: 1, threshold: 1, converged: true });
  });

  it("convergenceSignal computes score/threshold/converged from a round's findings", () => {
    expect(convergenceSignal(countsToDoc(counts(1, 0, 0, 0)))).toEqual({
      score: 4,
      threshold: 1,
      converged: false,
    });
    expect(convergenceSignal(countsToDoc(counts(0, 0, 0, 50)))).toEqual({
      score: 0,
      threshold: 1,
      converged: true,
    });
    expect(convergenceSignal(countsToDoc(counts(0, 1, 0, 0)), 3)).toEqual({
      score: 2,
      threshold: 3,
      converged: true,
    });
    // threshold 0: a zero-score doc still converges (0 ≤ 0) — the boundary the deleted signalForRound
    // test covered.
    expect(convergenceSignal(countsToDoc(counts(0, 0, 0, 0)), 0)).toEqual({
      score: 0,
      threshold: 0,
      converged: true,
    });
  });

  it("the findings-json marker round-trips the surfaced document, signal included", () => {
    const doc = surfacedDoc(findings, signal(1, counts(0, 0, 1, 0)));
    const body = `sticky prose\n${legacyEmbeddedMarker(doc)}\nmore prose`;
    expect(parseFindingsMarker(body)).toEqual(doc);
  });

  it("stripSurfaceFields drops the surface fields and restores the draft version on a surfaced doc", () => {
    const surfaced = surfacedDoc(findings, signal(1, counts(0, 0, 1, 0)));
    expect(stripSurfaceFields(surfaced)).toEqual({
      ...findings,
      schema_version: DEFAULT_SCHEMA_VERSION,
    });
  });

  it("stripSurfaceFields KEEPS the agent-facing scope_metastasis — the seed must deliver the recurrence data (issue #150)", () => {
    const entry = {
      decision_prompt: "decide",
      recurring: [{ code: "a", consecutive_rounds: 3, start_round: 1 }],
    };
    const surfaced = surfacedDoc(findings, signal(1, counts(0, 0, 1, 0)), entry);
    expect(stripSurfaceFields(surfaced)).toEqual({
      ...findings,
      schema_version: DEFAULT_SCHEMA_VERSION,
      scope_metastasis: entry,
    });
  });

  it("strips a superseded 0.7.0 surfaced blob too — the version list grows, never replaces (issue #150)", () => {
    const oldSurface = {
      ...findings,
      schema_version: "0.7.0",
      round: 1,
      convergence: { score: 1, threshold: 1, converged: false },
    };
    expect(stripSurfaceFields(oldSurface)).toEqual({
      ...findings,
      schema_version: DEFAULT_SCHEMA_VERSION,
    });
  });

  it("stripSurfaceFields passes unknown future versions (0.9.0) through untouched — the surface list grows with each emitted version", () => {
    const surfaced = {
      ...surfacedDoc(findings, signal(2, counts(0, 0, 1, 0))),
      schema_version: "0.9.0",
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
    expect(parseSurfaceSignal(surfacedDoc(findings, signal))).toEqual(signal);
  });

  it("returns null when the doc carries no signal (a pre-surface blob, or no round yet)", () => {
    expect(parseSurfaceSignal(findings)).toBeNull();
    expect(parseSurfaceSignal(surfacedDoc(findings, null))).toBeNull();
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
    const base = surfacedDoc(findings, signal);
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
    const base = surfacedDoc(findings, signal);
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

describe("signal marker — issue #141 (the legacy compact stop signal, still read back)", () => {
  const signal: SurfaceSignal = {
    round: 1,
    convergence: { score: 2, threshold: 1, converged: false },
  };

  it("parseSignalMarker round-trips a compact signal marker", () => {
    expect(parseSignalMarker(`prose\n${mkSignalMarker(signal)}\nmore`)).toEqual(signal);
  });

  it("parseSignalMarker returns null when the body carries no signal marker", () => {
    expect(parseSignalMarker("just prose")).toBeNull();
    expect(parseSignalMarker(legacyEmbeddedMarker(surfacedDoc(findings, signal)))).toBeNull();
  });

  it("carryForwardMarkers preserves the signal marker alongside the findings marker", () => {
    const body = `${legacyEmbeddedMarker(findings)}\n${mkSignalMarker(signal)}`;
    expect(carryForwardMarkers(body)).toContain("code-review:signal;base64");
    expect(carryForwardMarkers(body)).toContain("findings-json");
  });
});

describe("reviewBodyPointer — a bare pointer to the sticky and the run, never the blob (issues #161, #204)", () => {
  it("links the sticky and embeds no blob when a URL is present", () => {
    const pointer = reviewBodyPointer("abc1234def", "https://example.com/sticky", undefined, true);
    expect(pointer).not.toContain("code-review:findings-json");
    expect(pointer).not.toContain("AGENTS: STOP");
    expect(pointer).toContain("[summary comment](https://example.com/sticky)");
    expect(pointer).toContain("`abc1234`");
  });

  it("emits an unlinked pointer — still no blob — when the sticky URL is unavailable", () => {
    const pointer = reviewBodyPointer("abc1234def", undefined, undefined, true);
    expect(pointer).not.toContain("code-review:findings-json");
    expect(pointer).toContain("see the summary comment");
  });

  // Whichever surface a reader lands on should be one click from the run (issue #204) — the run page
  // outlasts the sticky's overwritten body, and the link is what the reader needs, whatever retention
  // has since pruned behind it.
  it("links the run alongside the sticky", () => {
    const pointer = reviewBodyPointer(
      "abc1234def",
      "https://example.com/sticky",
      "https://example.com/run/7",
      true,
    );
    expect(pointer).toContain("[summary comment](https://example.com/sticky)");
    expect(pointer).toContain("[workflow run](https://example.com/run/7)");
    expect(pointer).not.toContain("code-review:findings-json");
  });

  it("links the run even when the sticky URL is unavailable", () => {
    const pointer = reviewBodyPointer("abc1234def", undefined, "https://example.com/run/7", true);
    expect(pointer).toContain("see the summary comment");
    expect(pointer).toContain("[workflow run](https://example.com/run/7)");
  });

  // `post` outside Actions writes no run summary, so the sentence must not send the reader there for
  // a document that was never written.
  it("promises the run's review only when a summary was written", () => {
    const withSummary = reviewBodyPointer(
      "abc1234def",
      undefined,
      "https://example.com/run/7",
      true,
    );
    const without = reviewBodyPointer("abc1234def", undefined, "https://example.com/run/7", false);

    expect(withSummary).toContain("this round's review in full");
    expect(without).not.toContain("review in full");
    expect(without).toContain("[workflow run](https://example.com/run/7)");
    expect(without).toContain("findings artifact");
  });

  it("says nothing about a run when no run URL is available", () => {
    const pointer = reviewBodyPointer("abc1234def", "https://example.com/sticky", undefined, true);
    expect(pointer).not.toContain("workflow run");
    expect(pointer).not.toContain("undefined");
  });
});

describe("changeSizeSummary — the change-size line (issue #182)", () => {
  it("formats all three roles joined, in code/tests/docs order", () => {
    expect(
      changeSizeSummary({
        code: { added: 240, removed: 80 },
        tests: { added: 120, removed: 10 },
        docs: { added: 30, removed: 0 },
      }),
    ).toBe("+240 / −80 code · +120 / −10 tests · +30 / −0 docs");
  });

  it("drops a role the agent omitted", () => {
    expect(changeSizeSummary({ code: { added: 5, removed: 1 } })).toBe("+5 / −1 code");
  });

  it("is empty for an undefined field or an all-absent object", () => {
    expect(changeSizeSummary(undefined)).toBe("");
    expect(changeSizeSummary({})).toBe("");
  });
});
