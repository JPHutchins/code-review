// Domain types NOT derived from io-ts codecs.
// For DTO types (Finding, Findings, ResultEnvelope, PriceMap, etc.) import from ./schema.js.

import type { Finding, Findings, Side, ResultEnvelope, PriceMap } from "./schema.js";

// ---- Inline review output (built programmatically, not from JSON input) ----

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

// ---- Test summary (format-agnostic — SPEC §5.1 item 4, REQ-CO-9) ----

export interface TestFailure {
  readonly name: string;
  readonly message?: string;
}

export interface TestSummary {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly failures?: readonly TestFailure[];
}

// ---- Render input ----

export interface RenderInput {
  readonly findings: Findings;
  readonly envelope: ResultEnvelope;
  readonly prices: PriceMap;
  readonly template: string;
  readonly reviewedSha?: string;
  readonly route: string;
  readonly testReport?: TestSummary;
}
