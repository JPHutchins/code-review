// io-ts codecs for de/serialization at the boundary.
// These ARE the source of truth for the data shapes — types are materialized via t.TypeOf<>.
// No hand-written DTO types exist elsewhere; import types from here.

import * as t from "io-ts";

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

// Mirrors findings.schema.json's `schema_version.pattern` exactly, so `resolve()` (registry.ts,
// consumed by post.ts's §5.5 malformed-doc path) never accepts a value that ajv (validate.ts, the
// extraction ladder's candidate gate) would reject — e.g. a truncated "0.2" or an over-long "0.2.0.0".
const SCHEMA_VERSION_RE =
  /^(0|[1-9]\d*)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const SchemaVersion = t.refinement(
  t.string,
  (s): s is string => SCHEMA_VERSION_RE.test(s),
  "SchemaVersion",
);

const FindingShape = t.intersection([
  t.type({
    path: t.string,
    start_line: LineNumber,
    end_line: LineNumber,
    severity: SeverityCodec,
    title: t.string,
    description: t.string,
    reasoning: t.string,
    confidence: Confidence,
  }),
  t.partial({
    side: SideCodec,
    code: t.string,
    code_url: t.string,
    recommendation: t.string,
    patch: t.string,
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
    schema_version: SchemaVersion,
    summary: t.string,
    verdict: VerdictCodec,
    findings: t.array(FindingCodec),
  }),
);

export const TriageCodec = t.type({
  safe: t.boolean,
  reasons: t.string,
});

// Abstract, vendor-neutral result envelope (SPEC §6.1) — not any adapter's native shape.
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
    route: t.string,
    effort: t.string,
  }),
]);

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

// Format-agnostic test summary (SPEC §5.1 item 4, REQ-CO-9) — any conforming test report shape.
export const TestFailureCodec = t.intersection([
  t.type({ name: t.string }),
  t.partial({ message: t.string }),
]);

export const TestSummaryCodec = t.intersection([
  t.type({
    passed: t.number,
    failed: t.number,
    total: t.number,
  }),
  t.partial({
    failures: t.array(TestFailureCodec),
  }),
]);

// The supported-minor allowlist and version dispatch live in the registry (src/registry.ts),
// which sources its findings entry's defaultVersion from this constant.
/** Full semver used when an adapter's native output omits `schema_version` (SPEC §6.1). */
export const DEFAULT_SCHEMA_VERSION = "0.4.0";

export type Finding = t.TypeOf<typeof FindingCodec>;
export type Findings = t.TypeOf<typeof FindingsCodec>;

/** A valid, empty-findings document carrying `summary` as its only content — the single shape used
 *  for a sticky-only notice (post.ts, SPEC §5.5) and a "did not complete" degraded envelope
 *  (adapt.ts, issue #18). Callers supply the fully-formatted markdown summary. */
export const noticeFindings = (summary: string): Findings => ({
  schema_version: DEFAULT_SCHEMA_VERSION,
  summary,
  verdict: "comment",
  findings: [],
});
export type Triage = t.TypeOf<typeof TriageCodec>;
export type Severity = t.TypeOf<typeof SeverityCodec>;
export type Side = t.TypeOf<typeof SideCodec>;
export type Verdict = t.TypeOf<typeof VerdictCodec>;
export type ModelUsageEntry = t.TypeOf<typeof ModelUsageEntryCodec>;
export type ResultEnvelope = t.TypeOf<typeof ResultEnvelopeCodec>;
export type ModelPrices = t.TypeOf<typeof ModelPricesCodec>;
export type PriceMap = t.TypeOf<typeof PriceMapCodec>;
export type TestFailure = t.TypeOf<typeof TestFailureCodec>;
export type TestSummary = t.TypeOf<typeof TestSummaryCodec>;
