// These codecs ARE the source of truth for the data shapes (types via t.TypeOf<>); no hand-written
// DTO types exist elsewhere — import types from here.

import * as t from "io-ts";

const SeverityCodec = t.union([
  t.literal("critical"),
  t.literal("major"),
  t.literal("minor"),
  t.literal("nit"),
]);

const SideCodec = t.union([t.literal("RIGHT"), t.literal("LEFT")]);

const VerdictCodec = t.union([
  t.literal("approve"),
  t.literal("comment"),
  t.literal("changes"),
  t.literal("error"),
]);

const LineNumber = t.refinement(
  t.number,
  (n): n is number => Number.isInteger(n) && n >= 1,
  "LineNumber",
);

const Confidence = t.refinement(t.number, (n): n is number => n >= 0 && n <= 1, "Confidence");

// Mirrors findings.schema.json's schema_version.pattern exactly, so resolve() never accepts a value
// the ajv gate would reject (e.g. a truncated "0.2" or an over-long "0.2.0.0").
const SCHEMA_VERSION_RE =
  /^(0|[1-9]\d*)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const SchemaVersion = t.refinement(
  t.string,
  (s): s is string => SCHEMA_VERSION_RE.test(s),
  "SchemaVersion",
);

// The stable rule identifier pair, shared by findings and systemic problems so the two shapes can
// never diverge on it.
const FindingRuleCodec = t.partial({
  code: t.string,
  code_url: t.string,
});

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
  FindingRuleCodec,
  t.partial({
    side: SideCodec,
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

// Cross-cutting observations that tie findings together, with no required line anchor — mirrors
// findings.schema.json's systemic_problems items exactly, reusing the shared rule-identifier pair.
const SystemicProblemShape = t.intersection([
  t.type({
    title: t.string,
    description: t.string,
  }),
  FindingRuleCodec,
  t.partial({
    severity: SeverityCodec,
    finding_codes: t.array(t.string),
    paths: t.array(t.string),
  }),
]);

export const SystemicProblemCodec = t.exact(SystemicProblemShape);

export const FindingsCodec = t.exact(
  t.intersection([
    t.type({
      schema_version: SchemaVersion,
      summary: t.string,
      verdict: VerdictCodec,
      findings: t.array(FindingCodec),
    }),
    t.partial({
      systemic_problems: t.array(SystemicProblemCodec),
    }),
  ]),
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
    // The run produced a notice rather than a completed review (security-gate block, agent kill, no
    // recoverable findings). An empty `findings` array alone can't say this — a genuine clean review
    // is also empty — so the render suppresses "clean review" and the sticky precedence guard refuses
    // to bury a completed review under it. Absent ⇒ a completed review.
    incomplete: t.boolean,
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

// Used when an adapter's native output omits schema_version; the registry sources its findings
// defaultVersion from this.
export const DEFAULT_SCHEMA_VERSION = "0.6.0";

export type Finding = t.TypeOf<typeof FindingCodec>;
export type SystemicProblem = t.TypeOf<typeof SystemicProblemCodec>;
export type Findings = t.TypeOf<typeof FindingsCodec>;
export type Verdict = t.TypeOf<typeof VerdictCodec>;

// The initial $DRAFT scaffold: an empty, neutral findings doc the review agent is told to fill in. It
// carries "comment" (never the pipeline-only "error"), so an agent that populates it and forgets to
// touch the verdict still ships a valid review. A dead-agent recovery of this untouched scaffold is
// caught by `adapt`'s seed-marker check, not by its verdict — so the verdict stays a plain template.
export const emptyFindings = (summary: string): Findings => ({
  schema_version: DEFAULT_SCHEMA_VERSION,
  summary,
  verdict: "comment",
  findings: [],
});

// The findings shape for a run that produced no code-review verdict — an operational failure, a
// security refusal, or an empty diff with nothing to review. `verdict: "error"` is the machine-readable
// signal that the blob a consumer decodes is NOT a clean pass (verdict "comment", findings []), so an
// agent following the decode-the-JSON contract cannot mistake "no verdict was produced" for "nothing
// found". A completed review carries approve/comment/changes.
export const incompleteFindings = (summary: string): Findings => ({
  schema_version: DEFAULT_SCHEMA_VERSION,
  summary,
  verdict: "error",
  findings: [],
});

// The one predicate for "this findings doc is a no-verdict notice, not a completed review", shared by
// render and the sticky-precedence guard so the rule lives in a single place. Requires an EMPTY
// findings array: a doc that carries real findings is a real review whatever its verdict says, so a
// spurious "error" verdict alongside findings can never silently suppress them.
export const isIncompleteFindings = (findings: Findings): boolean =>
  findings.verdict === "error" && findings.findings.length === 0;
export type Triage = t.TypeOf<typeof TriageCodec>;
export type Severity = t.TypeOf<typeof SeverityCodec>;
export type Side = t.TypeOf<typeof SideCodec>;
export type ModelUsageEntry = t.TypeOf<typeof ModelUsageEntryCodec>;
export type ResultEnvelope = t.TypeOf<typeof ResultEnvelopeCodec>;
export type ModelPrices = t.TypeOf<typeof ModelPricesCodec>;
export type PriceMap = t.TypeOf<typeof PriceMapCodec>;
export type TestFailure = t.TypeOf<typeof TestFailureCodec>;
export type TestSummary = t.TypeOf<typeof TestSummaryCodec>;
