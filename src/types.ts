// Domain types NOT derived from io-ts codecs.
// For DTO types (Finding, Findings, ResultEnvelope, PriceMap, TestSummary, etc.) import from ./schema.js.

import type { Finding, Findings, Side, ResultEnvelope, PriceMap, TestSummary } from "./schema.js";

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

export interface RenderInput {
  readonly findings: Findings;
  /** null when the result envelope is unavailable or malformed — renders a "usage unavailable" note. */
  readonly envelope: ResultEnvelope | null;
  readonly prices: PriceMap;
  readonly template: string;
  readonly reviewedSha?: string;
  readonly route: string;
  readonly effort?: string;
  readonly testReport?: TestSummary;
}
