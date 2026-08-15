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
const Likelihood = t.refinement(t.number, (n): n is number => n >= 0 && n <= 1, "Likelihood");

// A convergence score/threshold must be FINITE: io-ts's t.number accepts Infinity/NaN (JSON.parse("1e400")
// yields Infinity), which JSON.stringify then coerces to null — silently dropping the carried convergence
// on the next hop. parseSurfaceSignal guards the same vector; the convergence codec must too.
const FiniteNumber = t.refinement(t.number, (n): n is number => Number.isFinite(n), "FiniteNumber");

// Mirrors findings.schema.json's schema_version.pattern exactly, so resolve() never accepts a value
// the ajv gate would reject (e.g. a truncated "0.2" or an over-long "0.2.0.0").
const SCHEMA_VERSION_RE =
  /^(0|[1-9]\d*)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const SchemaVersion = t.refinement(
  t.string,
  (s): s is string => SCHEMA_VERSION_RE.test(s),
  "SchemaVersion",
);

// Mirrors ajv-formats' `uri` format (an absolute, RFC 3986 URI) so the codec gate and the ajv gate
// agree on code_url — the extraction ladder runs both gates, and post's decode-only path must not
// accept what ajv rejects. Verified against ajv-formats over the URI corpus; the whitespace check
// closes the one divergence (URL() auto-encodes raw spaces that a URI cannot contain).
const UriString = t.refinement(
  t.string,
  (s): s is string => !/\s/.test(s) && URL.canParse(s),
  "UriString",
);

// The stable rule identifier pair, shared by findings and systemic problems so the two shapes can
// never diverge on it.
const FindingRuleCodec = t.partial({
  code: t.string,
  code_url: UriString,
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
    likelihood: Likelihood,
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
// severity/reasoning/confidence are required (owner direction on #134).
const SystemicRequired = t.type({
  title: t.string,
  description: t.string,
  severity: SeverityCodec,
  reasoning: t.string,
  confidence: Confidence,
  likelihood: Likelihood,
});

const SystemicOptional = t.partial({
  finding_codes: t.array(t.string),
  paths: t.array(t.string),
});

const SystemicProblemShape = t.intersection([SystemicRequired, FindingRuleCodec, SystemicOptional]);

// The schema declares additionalProperties: false, but t.exact only strips unknown keys on encode —
// on decode it accepts them. The refinement closes the gap so the codec gate rejects exactly what
// the ajv gate rejects (the extraction ladder runs both gates). The key set is derived from the
// shape's own members, so it cannot drift from the declared fields.
const SYSTEMIC_KEYS = new Set([
  ...Object.keys(SystemicRequired.props),
  ...Object.keys(FindingRuleCodec.props),
  ...Object.keys(SystemicOptional.props),
]);

const SystemicProblemStrict = t.refinement(
  SystemicProblemShape,
  (s): s is t.TypeOf<typeof SystemicProblemShape> =>
    Object.keys(s).every((k) => SYSTEMIC_KEYS.has(k)),
  "SystemicProblemStrict",
);

export const SystemicProblemCodec = t.exact(SystemicProblemStrict);

const RecurringShape = t.type({
  code: t.string,
  consecutive_rounds: t.refinement(
    t.number,
    (n): n is number => Number.isSafeInteger(n) && n >= 1,
    "ConsecutiveRounds",
  ),
  start_round: t.refinement(
    t.number,
    (n): n is number => Number.isSafeInteger(n) && n >= 1,
    "StartRound",
  ),
});

// The schema declares additionalProperties: false on recurring items, but t.exact only strips
// unknown keys on encode — on decode it accepts them. The refinement closes the gap so the codec
// gate rejects exactly what the ajv gate rejects (the same invariant SystemicProblemStrict
// establishes — a seed-echoing draft smuggling an extra key into a recurring item must not pass one
// gate and fail the other).
const RECURRING_KEYS = new Set(Object.keys(RecurringShape.props));

const RecurringCodec = t.refinement(
  RecurringShape,
  (r): r is t.TypeOf<typeof RecurringShape> => Object.keys(r).every((k) => RECURRING_KEYS.has(k)),
  "RecurringStrict",
);

// The scope-metastasis entry (issue #150): per-code consecutive-round recurrence counts plus the
// decision prompt, computed from the rounds history. The agent never writes it — the re-review seed
// re-derives it from the carried convergence trajectory and delivers it to the next-round agent — but
// the draft schema tolerates it so a seed-echoing agent's draft still validates.
const ScopeMetastasisShape = t.type({
  decision_prompt: t.string,
  recurring: t.array(RecurringCodec),
});

const SCOPE_METASTASIS_KEYS = new Set(Object.keys(ScopeMetastasisShape.props));

const ScopeMetastasisStrict = t.refinement(
  ScopeMetastasisShape,
  (s): s is t.TypeOf<typeof ScopeMetastasisShape> =>
    Object.keys(s).every((k) => SCOPE_METASTASIS_KEYS.has(k)),
  "ScopeMetastasisStrict",
);

export const ScopeMetastasisCodec = t.exact(ScopeMetastasisStrict);

// One round's trajectory entry (issue #174): the round number and its convergence score, plus the
// mechanism-frequency map and reviewed head SHA the recurrence signals read. Prior rounds are carried
// verbatim, so a threshold change never rewrites a past score.
const RoundNumber = t.refinement(
  t.number,
  (n): n is number => Number.isSafeInteger(n) && n >= 1,
  "RoundNumber",
);

const CodeFrequency = t.record(
  t.string,
  t.refinement(t.number, (n): n is number => Number.isSafeInteger(n) && n >= 0, "CodeFrequency"),
);

const ConvergenceRoundRequired = t.type({ round: RoundNumber });
const ConvergenceRoundOptional = t.partial({
  score: FiniteNumber,
  codes: CodeFrequency,
  sha: t.string,
});
const ConvergenceRoundShape = t.intersection([ConvergenceRoundRequired, ConvergenceRoundOptional]);

// Strict-key refinement (see SystemicProblemStrict): the ajv gate rejects unknown keys but t.exact
// accepts them on decode, so the codec gate must reject exactly what ajv rejects.
const CONVERGENCE_ROUND_KEYS = new Set([
  ...Object.keys(ConvergenceRoundRequired.props),
  ...Object.keys(ConvergenceRoundOptional.props),
]);

const ConvergenceRoundStrict = t.refinement(
  ConvergenceRoundShape,
  (r): r is t.TypeOf<typeof ConvergenceRoundShape> =>
    Object.keys(r).every((k) => CONVERGENCE_ROUND_KEYS.has(k)),
  "ConvergenceRoundStrict",
);

export const ConvergenceRoundCodec = t.exact(ConvergenceRoundStrict);

// The convergence signal (issue #174): the current round's score, the threshold it is judged against,
// whether it converged, and the per-round trajectory. Pipeline-stamped like scope_metastasis — the
// agent never writes it; the pipeline computes the score deterministically from the findings and stamps
// it so the JSON document is the sole source of the convergence data a decoding agent reads, no
// side-channel marker. score AND threshold are both carried so the number is interpretable on its own.
const ConvergenceCoreShape = t.type({
  score: FiniteNumber,
  threshold: FiniteNumber,
  converged: t.boolean,
});

const ConvergenceOptional = t.partial({ rounds: t.array(ConvergenceRoundCodec) });
const ConvergenceShape = t.intersection([ConvergenceCoreShape, ConvergenceOptional]);

const CONVERGENCE_KEYS = new Set([
  ...Object.keys(ConvergenceCoreShape.props),
  ...Object.keys(ConvergenceOptional.props),
]);

const ConvergenceStrict = t.refinement(
  ConvergenceShape,
  (c): c is t.TypeOf<typeof ConvergenceShape> =>
    Object.keys(c).every((k) => CONVERGENCE_KEYS.has(k)),
  "ConvergenceStrict",
);

export const ConvergenceCodec = t.exact(ConvergenceStrict);

// The change-size breakdown (issue #182): per-role added/removed line counts. UNLIKE
// convergence/scope_metastasis (pipeline-stamped), this IS the agent's own judgment — a LOW-effort
// path bucketing of the diff into code / tests / docs (a tests dir / *.test.* is tests, *.md / docs/
// is docs, everything else is code; no file introspection). All roles optional and best-effort; an
// absent role renders nothing. The deterministic cloc table beside it is pipeline-seeded, not here.
const LineDelta = t.refinement(
  t.number,
  (n): n is number => Number.isInteger(n) && n >= 0,
  "LineDelta",
);
const ChangeLinesCodec = t.exact(t.type({ added: LineDelta, removed: LineDelta }));
export const ChangeSizeCodec = t.exact(
  t.partial({ code: ChangeLinesCodec, tests: ChangeLinesCodec, docs: ChangeLinesCodec }),
);

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
      // Pipeline-stamped only (issue #150); see ScopeMetastasisCodec.
      scope_metastasis: ScopeMetastasisCodec,
      // Pipeline-stamped only (issue #174); see ConvergenceCodec.
      convergence: ConvergenceCodec,
      // Agent-written best-effort (issue #182); see ChangeSizeCodec.
      change_size: ChangeSizeCodec,
    }),
  ]),
);

// The optional document fields safe to strip to RECOVER a findings doc when the in-force schema or the
// codec rejects it — rather than lose the whole review (post's loadFindings) or all prior seed context
// (the seed's barePrior fallback). PIPELINE_STAMPED_FIELDS are re-derived/re-stamped after load; the
// agent's best-effort chrome (change_size, issue #182) is dropped because it never affects the verdict.
// ONE definition so the two recovery sites can never diverge on the key set (issue #182 review r2).
export const PIPELINE_STAMPED_FIELDS: ReadonlySet<string> = new Set([
  "convergence",
  "scope_metastasis",
]);
export const RECOVERABLE_OPTIONAL_FIELDS: ReadonlySet<string> = new Set([
  ...PIPELINE_STAMPED_FIELDS,
  "change_size",
]);

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
export const DEFAULT_SCHEMA_VERSION = "0.9.0";

export type Finding = t.TypeOf<typeof FindingCodec>;
export type SystemicProblem = t.TypeOf<typeof SystemicProblemCodec>;
export type Findings = t.TypeOf<typeof FindingsCodec>;
export type ScopeMetastasis = t.TypeOf<typeof ScopeMetastasisCodec>;
export type Convergence = t.TypeOf<typeof ConvergenceCodec>;
export type ChangeSize = t.TypeOf<typeof ChangeSizeCodec>;
export type ConvergenceRound = t.TypeOf<typeof ConvergenceRoundCodec>;
export type ConvergenceCore = t.TypeOf<typeof ConvergenceCoreShape>;
export type Verdict = t.TypeOf<typeof VerdictCodec>;

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
