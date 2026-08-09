import { describe, it, expect } from "vitest";
import {
  parseFindingsMarker,
  parseReviewedSha,
  parseReviewedRoute,
  parseReviewComplete,
  findingsPointer,
  parseRounds,
  roundsMarker,
  roundsSummary,
  carryForwardMarkers,
  convergenceScore,
  convergenceSummary,
  DEFAULT_CONVERGENCE_THRESHOLD,
} from "./surface.js";
import type { Findings } from "./schema.js";
import type { SeverityCounts } from "./types.js";

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
