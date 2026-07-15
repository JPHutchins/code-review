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
}
