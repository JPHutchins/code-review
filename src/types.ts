// Domain types NOT derived from io-ts codecs.
// For DTO types (Finding, Findings, ResultEnvelope, PriceMap, TestSummary, etc.) import from ./schema.js.

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
}

export type SeverityCounts = Readonly<Record<Severity, number>>;

/** What actually happened to the inline review, so the sticky's pointer states the truth (SPEC §5.1). */
export type InlineDisposition =
  | { readonly kind: "posted"; readonly count: number; readonly sha: string }
  | { readonly kind: "none-in-diff" }
  | { readonly kind: "suppressed-existing-review"; readonly sha: string }
  | { readonly kind: "no-envelope" };

export interface RenderInput {
  readonly findings: Findings;
  /** null when the result envelope is unavailable or malformed — renders a "usage unavailable" note. */
  readonly envelope: ResultEnvelope | null;
  readonly prices: PriceMap;
  readonly template: string;
  readonly reviewedSha?: string;
  /** Overrides the envelope's `route`/`effort` (SPEC §6.1) when set; otherwise the envelope is the source. */
  readonly route?: string;
  readonly effort?: string;
  readonly testReport?: TestSummary;
  /** Severity histogram for the summary counts line; derived from `findings` when omitted. */
  readonly severityCounts?: SeverityCounts;
  /** Findings that couldn't be anchored inline (SPEC §5.2 rule 1) — the sticky's only per-finding detail. */
  readonly strays?: readonly Finding[];
  readonly inlineDisposition?: InlineDisposition;
  /** Workflow run URL (transcript/traces) — populated later by the wiring implementer. Renders a link in the LLM Disclosure aside when present, omitted otherwise. */
  readonly runUrl?: string;
  /** URL to the machine-readable findings JSON artifact — populated later by the wiring implementer. Emits a findings-json marker and a short advisory pointing agents at it when present, omitted otherwise. */
  readonly jsonUrl?: string;
  /** The inline review's `html_url` — populated later by the wiring implementer, which re-patches the sticky after the review posts. Turns "see the review" into a link when present. */
  readonly reviewUrl?: string;
}
