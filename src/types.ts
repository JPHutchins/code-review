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

/** The sticky↔review hyperlinks (issue #21) — each populated only once its target is known to
 *  actually exist, never optimistically. */
export interface CrossLinks {
  readonly stickyUrl?: string;
  readonly reviewUrl?: string;
}

export interface RenderInput {
  readonly findings: Findings;
  /** null when the result envelope is unavailable or malformed — renders a "usage unavailable" note. */
  readonly envelope: ResultEnvelope | null;
  readonly prices: PriceMap;
  /** Whether `prices` is a real, caller-supplied price map (`true`) or the bundled all-zero example
   *  standing in for an absent one (`false`). An explicit signal the render layer is TOLD — never
   *  inferred from the map's contents or path — so cost renders as `N/A` (never a false `$0.00`)
   *  with a "no price map" footnote when absent (SPEC §6.2). Omitted ⇒ treated as provided. */
  readonly pricesProvided?: boolean;
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
  /** URL to the machine-readable findings JSON artifact — the findings-json marker's fallback when
   *  the embedded form is too large (issue #19). */
  readonly jsonUrl?: string;
  /** The sticky↔review hyperlinks (issue #21) — `reviewUrl` turns "see the review" into a link
   *  once the review is known to exist; populated by the wiring implementer's post-review pass. */
  readonly crossLinks?: CrossLinks;
}
