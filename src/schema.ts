// io-ts codecs for de/serialization at the boundary.
// These ARE the source of truth for the data shapes — types are materialized via t.TypeOf<>.
// No hand-written DTO types exist elsewhere; import types from here.

import * as t from "io-ts";

// ---- Findings (from schema/findings.schema.json) ----

const SeverityCodec = t.union([
  t.literal("critical"),
  t.literal("major"),
  t.literal("minor"),
  t.literal("nit"),
]);

const SideCodec = t.union([t.literal("RIGHT"), t.literal("LEFT")]);

const VerdictCodec = t.union([t.literal("approve"), t.literal("comment"), t.literal("changes")]);

const LineNumber = t.refinement(
  t.number,
  (n): n is number => Number.isInteger(n) && n >= 1,
  "LineNumber",
);

const Confidence = t.refinement(t.number, (n): n is number => n >= 0 && n <= 1, "Confidence");

const FindingShape = t.intersection([
  t.type({
    path: t.string,
    start_line: LineNumber,
    end_line: LineNumber,
    severity: SeverityCodec,
    title: t.string,
    body: t.string,
  }),
  t.partial({
    side: SideCodec,
    suggestion: t.union([t.string, t.null]),
    confidence: Confidence,
    code: t.string,
    code_url: t.string,
  }),
]);

const EndGeStart = t.refinement(
  FindingShape,
  (f): f is t.TypeOf<typeof FindingShape> => f.end_line >= f.start_line,
  "EndGeStart",
);

export const FindingCodec = t.exact(EndGeStart);

export const FindingsCodec = t.exact(
  t.type({
    schema_version: t.string,
    summary: t.string,
    verdict: VerdictCodec,
    findings: t.array(FindingCodec),
  }),
);

// ---- Result envelope (abstract, vendor-neutral — SPEC §6.1) ----

const TokenCount = t.refinement(
  t.number,
  (n): n is number => Number.isInteger(n) && n >= 0,
  "TokenCount",
);

export const ModelUsageEntryCodec = t.intersection([
  t.type({
    model: t.string,
    input_tokens: TokenCount,
    output_tokens: TokenCount,
  }),
  t.partial({
    cache_read_tokens: TokenCount,
    cache_write_tokens: TokenCount,
  }),
]);

export const ResultEnvelopeCodec = t.intersection([
  t.type({
    schema_version: t.string,
    findings: FindingsCodec,
    models: t.array(ModelUsageEntryCodec),
    turns: TokenCount,
    duration_ms: TokenCount,
  }),
  t.partial({
    vendor_cost_usd: t.union([t.number, t.null]),
  }),
]);

// ---- Price map (from schema/prices.example.json) ----

export const ModelPricesCodec = t.type({
  in: t.number,
  out: t.number,
  cache_read: t.number,
  cache_write: t.number,
});

export const PriceMapCodec = t.type({
  _updated: t.string,
  _unit: t.string,
  models: t.record(t.string, ModelPricesCodec),
});

// ---- Materialized types (SSOT — no hand-written duplicates) ----

export type Finding = t.TypeOf<typeof FindingCodec>;
export type Findings = t.TypeOf<typeof FindingsCodec>;
export type Severity = t.TypeOf<typeof SeverityCodec>;
export type Side = t.TypeOf<typeof SideCodec>;
export type Verdict = t.TypeOf<typeof VerdictCodec>;
export type ModelUsageEntry = t.TypeOf<typeof ModelUsageEntryCodec>;
export type ResultEnvelope = t.TypeOf<typeof ResultEnvelopeCodec>;
export type ModelPrices = t.TypeOf<typeof ModelPricesCodec>;
export type PriceMap = t.TypeOf<typeof PriceMapCodec>;
