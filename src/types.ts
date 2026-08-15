// Domain types NOT derived from io-ts codecs. For DTO types (Finding, Findings, ResultEnvelope,
// PriceMap, TestSummary, etc.) import from ./schema.js.

import type {
  Finding,
  Findings,
  Side,
  Severity,
  ResultEnvelope,
  PriceMap,
  TestSummary,
} from "./schema.js";

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly side: Side;
  readonly start_line?: number;
  readonly start_side?: Side;
  readonly body: string;
}

export interface InlineResult {
  readonly comments: readonly InlineComment[];
  readonly strays: readonly Finding[];
  // Surfaced in the sticky (as extra strays) when the inline review falls back to body-only.
  readonly inDiff: readonly Finding[];
}

export type SeverityCounts = Readonly<Record<Severity, number>>;

// The per-mechanism finding counts a round records: code → number of findings carrying that code this
// round (capped at MAX_CODES_PER_ROUND distinct codes). Absent on rounds recorded before the
// same-root/metastasis feature, and on rounds with no coded findings — absence is "unknown", not
// "zero", so a recurrence across an uncoded round is never counted as consecutive.
export type CodeCounts = Readonly<Record<string, number>>;

// One round's cross-round mechanism record: the severity counts plus, optionally, the round's
// code-frequency map and the reviewed head SHA (short form). The enrichment is ADDITIVE — a count-only
// round (pre-feature, or a round with no coded findings) is a valid RoundRecord with `codes` absent,
// so the trajectory marker stays backward-compatible and a future-shaped round is never a parse
// failure. The sha lets the streak detector recognize a same-head CI retry (which appends an identical
// round) as the same review iteration re-examined, not new evidence of recurrence.
export type RoundRecord = SeverityCounts & {
  readonly codes?: CodeCounts;
  readonly sha?: string;
  // The TRUE completed-round number (1-indexed) this record represents. The rounds marker's array
  // position can drift from it when parseRounds filters a corrupt entry, and the trajectory label
  // (and the compact signal marker) number rounds by the carried count — so the same-root annotation must
  // reference this, not the parsed index. Absent on pre-feature rounds ⇒ the parsed index + 1.
  readonly round?: number;
};

// A code's recurrence streak ending at the last recorded round: how many consecutive rounds carried a
// finding with that code, and the 1-indexed round number where the streak began.
export interface CodeStreak {
  readonly streak: number;
  readonly startRound: number;
}

export type InlineDisposition =
  | { readonly kind: "posted"; readonly count: number; readonly sha: string }
  | { readonly kind: "none-in-diff" }
  | { readonly kind: "inline-unavailable" }
  | { readonly kind: "no-envelope" };

export interface RenderInput {
  readonly findings: Findings;
  readonly envelope: ResultEnvelope | null;
  // An explicit signal, never inferred from the map: an absent (all-zero) map renders cost as N/A,
  // never a false $0.00. Omitted ⇒ treated as provided.
  readonly pricesProvided?: boolean;
  readonly prices: PriceMap;
  readonly template: string;
  readonly reviewedSha?: string;
  // Computed at the IO boundary so render() stays pure/clockless. Omitted ⇒ segment suppressed.
  readonly postedAt?: string;
  readonly route?: string;
  readonly effort?: string;
  readonly testReport?: TestSummary;
  readonly severityCounts?: SeverityCounts;
  // Per-full-review-round records (oldest first, this run's record last when it is a full review):
  // the severity counts plus each round's mechanism-frequency map, rendered as the convergence
  // TRAJECTORY, the advisory scope-metastasis note, and re-embedded as the carried-forward marker.
  // Omitted/empty ⇒ no trajectory line or metastasis note. The convergence BADGE is independent of
  // this (it reads the current run's counts under `convergenceRound`), so an empty history no longer
  // implies no badge.
  readonly rounds?: readonly RoundRecord[];
  // Code → "same mechanism as round N" note for findings whose mechanism recurred in a PRIOR round,
  // computed at the IO boundary (post has the prior-round history; the standalone render command
  // derives it from rounds.slice(0, -1)). Omitted ⇒ derived. Rendered as an advisory one-liner under
  // each such finding (sticky strays + inline comments); never alters severity or verdict.
  readonly sameRootNotes?: Readonly<Record<string, string>>;
  // Code → "Re-raised; prior answer at <link>" note for KEPT findings whose code matches an
  // answered prior inline thread but whose evidence changed (issue #151) — the reviewer re-raised
  // with new evidence, so it stays, annotated with the prior answer's link. Omitted/empty ⇒ none.
  readonly answeredNotes?: Readonly<Record<string, string>>;
  // The sticky note naming findings dropped as verbatim re-raises of answered findings (issue #151):
  // the suppression is never silent. Built by post from the dropped entries; omitted ⇒ no note.
  readonly answeredReRaiseNote?: string;
  // The true completed-round count for the trajectory label, when it differs from `rounds.length`
  // (post derives it from the carried signal, which survives corrupt rounds-marker entries that
  // parseRounds filters). Omitted ⇒ the parsed history length.
  readonly roundCount?: number;
  // The advisory convergence tolerance — the per-finding convergence score at or below which the round
  // reads as "converged" (default 1). Omitted ⇒ the default.
  readonly convergenceThreshold?: number;
  // Whether THIS run is a convergence-defining full-review round (post computes it once and passes it
  // here, using it for BOTH the round append and the badge so the two can't drift). Omitted ⇒ derived
  // from route + incompleteness, the fallback the standalone `render` command relies on.
  readonly convergenceRound?: boolean;
  readonly strays?: readonly Finding[];
  // How many of `strays` are in-diff findings GitHub rejected inline, rather than out-of-diff; > 0
  // titles the section "Findings" and notes they couldn't be posted inline. Omitted/0 ⇒ all out-of-diff.
  readonly unanchoredCount?: number;
  readonly inlineDisposition?: InlineDisposition;
  readonly runUrl?: string;
  // Findings-json marker's fallback when the embedded form is too large.
  readonly jsonUrl?: string;
  // Precomputed marker used verbatim (empty string = no marker), so post() base64-encodes once and
  // reuses it across surfaces. Omitted ⇒ computed here.
  readonly findingsPointer?: string;
  readonly reviewUrl?: string;
  // The run produced a notice, not a completed review. Overrides the envelope's own flag (set for the
  // null-envelope notice paths, where there is no envelope to read it from). Omitted ⇒ read from the
  // envelope, defaulting to a completed review.
  readonly incomplete?: boolean;
}
