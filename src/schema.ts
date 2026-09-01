// These codecs ARE the source of truth for the data shapes (types via t.TypeOf<>); no hand-written
// DTO types exist elsewhere — import types from here.

import * as t from "io-ts";
import { createHash } from "node:crypto";

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

// A non-negative price (USD per 1M tokens). Mirrors prices.schema.json's `minimum: 0` so the codec
// gate rejects a negative rate exactly as the ajv gate does — else a negative price prices negative cost.
const NonNegativePrice = t.refinement(t.number, (n): n is number => n >= 0, "NonNegativePrice");

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

// The stable mechanism identifier pair, shared by findings and systemic problems so the two shapes
// can never diverge on it. The `id` itself is REQUIRED on a finding (trackability across rounds and
// discussions); the optional half of the pair is the URL documenting the rule it names.
const RuleUrlCodec = t.partial({
  code_url: UriString,
});

const FindingShape = t.intersection([
  t.type({
    id: t.string,
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
  RuleUrlCodec,
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
  id: t.string,
  finding_ids: t.array(t.string),
  paths: t.array(t.string),
});

const SystemicProblemShape = t.intersection([SystemicRequired, RuleUrlCodec, SystemicOptional]);

// The schema declares additionalProperties: false, but t.exact only strips unknown keys on encode —
// on decode it accepts them. The refinement closes the gap so the codec gate rejects exactly what
// the ajv gate rejects (the extraction ladder runs both gates). The key set is derived from the
// shape's own members, so it cannot drift from the declared fields.
const SYSTEMIC_KEYS = new Set([
  ...Object.keys(SystemicRequired.props),
  ...Object.keys(RuleUrlCodec.props),
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
  id: t.string,
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

const IdFrequency = t.record(
  t.string,
  t.refinement(t.number, (n): n is number => Number.isSafeInteger(n) && n >= 0, "IdFrequency"),
);

const ConvergenceRoundRequired = t.type({ round: RoundNumber });
const ConvergenceRoundOptional = t.partial({
  score: FiniteNumber,
  ids: IdFrequency,
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

// The content-derived identity a finding WITHOUT an id resolves to: deterministic across rounds (the
// same path + title always synthesizes the same id), so a pre-id finding re-raised next round keys to
// the same ledger entry. A systemic problem has no path; its synthesized id keys on the title alone.
const synthesizedId = (parts: readonly string[], prefix: string): string =>
  `${prefix}${createHash("sha256").update(parts.join("\u0000")).digest("base64url").slice(0, 12)}`;

export const synthesizedFindingId = (path: string, title: string): string =>
  synthesizedId([path, title], "f-");

export const synthesizedSystemicId = (title: string): string => synthesizedId([title], "s-");

// The ONE resolution a finding's id goes through: an explicit id wins, and an empty one resolves to
// the same synthesized id the legacy upcast derives — shared by the answered-registry builder and the
// answered match, so the two sides can never disagree on what an empty id means.
export const resolveFindingId = (f: { id: string; path: string; title: string }): string =>
  f.id !== "" ? f.id : synthesizedFindingId(f.path, f.title);

// The pre-0.10 shape (schema/v0.9/findings.schema.json): findings carried an OPTIONAL `code` and no
// `id`. Decoded only as a migration input — the registry's pre-0.10 entries normalize it to the 0.10
// shape (code → id, or the synthesized content-derived id when a finding carried none). `id` is
// accepted too: the legacy route is tolerant-in/strict-out, so a doc that already carries one passes
// it through untouched.
const LegacyRuleCodec = t.partial({
  code: t.string,
  id: t.string,
  code_url: UriString,
});

const FindingShapeV09 = t.intersection([
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
  LegacyRuleCodec,
  t.partial({
    side: SideCodec,
    recommendation: t.string,
    patch: t.string,
  }),
]);

const EndGeStartV09 = t.refinement(
  FindingShapeV09,
  (f): f is t.TypeOf<typeof FindingShapeV09> => f.end_line >= f.start_line,
  "EndGeStartV09",
);

const FindingCodecV09 = t.exact(EndGeStartV09);

const SystemicV09Optional = t.partial({
  finding_codes: t.array(t.string),
  finding_ids: t.array(t.string),
  paths: t.array(t.string),
});

const SystemicV09Shape = t.intersection([SystemicRequired, LegacyRuleCodec, SystemicV09Optional]);

const SYSTEMIC_V09_KEYS = new Set([
  ...Object.keys(SystemicRequired.props),
  ...Object.keys(LegacyRuleCodec.props),
  ...Object.keys(SystemicV09Optional.props),
]);

const SystemicV09Strict = t.refinement(
  SystemicV09Shape,
  (s): s is t.TypeOf<typeof SystemicV09Shape> =>
    Object.keys(s).every((k) => SYSTEMIC_V09_KEYS.has(k)),
  "SystemicV09Strict",
);

const SystemicProblemCodecV09 = t.exact(SystemicV09Strict);

const RecurringV09Shape = t.intersection([
  t.partial({ code: t.string, id: t.string }),
  t.type({
    consecutive_rounds: t.refinement(
      t.number,
      (n): n is number => Number.isSafeInteger(n) && n >= 1,
      "ConsecutiveRoundsV09",
    ),
    start_round: t.refinement(
      t.number,
      (n): n is number => Number.isSafeInteger(n) && n >= 1,
      "StartRoundV09",
    ),
  }),
]);

const ScopeMetastasisV09Shape = t.type({
  decision_prompt: t.string,
  recurring: t.array(RecurringV09Shape),
});

const SCOPE_METASTASIS_V09_KEYS = new Set(Object.keys(ScopeMetastasisV09Shape.props));

const ScopeMetastasisV09Strict = t.refinement(
  ScopeMetastasisV09Shape,
  (s): s is t.TypeOf<typeof ScopeMetastasisV09Shape> =>
    Object.keys(s).every((k) => SCOPE_METASTASIS_V09_KEYS.has(k)),
  "ScopeMetastasisV09Strict",
);

const ScopeMetastasisCodecV09 = t.exact(ScopeMetastasisV09Strict);

const CodeFrequencyV09 = t.record(
  t.string,
  t.refinement(t.number, (n): n is number => Number.isSafeInteger(n) && n >= 0, "CodeFrequencyV09"),
);

const ConvergenceRoundV09Shape = t.intersection([
  t.type({ round: RoundNumber }),
  t.partial({ score: FiniteNumber, codes: CodeFrequencyV09, ids: CodeFrequencyV09, sha: t.string }),
]);

const CONVERGENCE_ROUND_V09_KEYS = new Set(["round", "score", "codes", "ids", "sha"]);

const ConvergenceRoundV09Strict = t.refinement(
  ConvergenceRoundV09Shape,
  (r): r is t.TypeOf<typeof ConvergenceRoundV09Shape> =>
    Object.keys(r).every((k) => CONVERGENCE_ROUND_V09_KEYS.has(k)),
  "ConvergenceRoundV09Strict",
);

const ConvergenceRoundCodecV09 = t.exact(ConvergenceRoundV09Strict);

const ConvergenceV09Shape = t.intersection([
  ConvergenceCoreShape,
  t.partial({ rounds: t.array(ConvergenceRoundCodecV09) }),
]);

const CONVERGENCE_V09_KEYS = new Set([...Object.keys(ConvergenceCoreShape.props), "rounds"]);

const ConvergenceV09Strict = t.refinement(
  ConvergenceV09Shape,
  (c): c is t.TypeOf<typeof ConvergenceV09Shape> =>
    Object.keys(c).every((k) => CONVERGENCE_V09_KEYS.has(k)),
  "ConvergenceV09Strict",
);

const ConvergenceCodecV09 = t.exact(ConvergenceV09Strict);

const FindingsV09Shape = t.intersection([
  t.type({
    // Any pre-0.10 minor — the registry dispatches on major.minor before decoding, so the codec
    // accepts every legacy patch version (0.4.x through 0.9.x) through the one tolerant shape.
    // SchemaVersion keeps the F3 strictness: a patch-less "0.4" or over-long "0.4.0.0" still fails
    // the codec gate exactly as the ajv gate rejects it.
    schema_version: SchemaVersion,
    summary: t.string,
    verdict: VerdictCodec,
    findings: t.array(FindingCodecV09),
  }),
  t.partial({
    systemic_problems: t.array(SystemicProblemCodecV09),
    scope_metastasis: ScopeMetastasisCodecV09,
    convergence: ConvergenceCodecV09,
    change_size: ChangeSizeCodec,
  }),
]);

export const FindingsCodecV09 = t.exact(FindingsV09Shape);

// The registry's 0.9 upcast: a 0.9 document becomes a valid 0.10 document. `code` maps to `id`; a
// finding (or systemic) without one gains the synthesized content-derived id, so pre-id findings
// stay trackable across the migration boundary.
export const normalizeV09 = (doc: t.TypeOf<typeof FindingsCodecV09>): Findings => {
  const findings = doc.findings.map(({ code, id, ...f }) => ({
    ...f,
    id:
      id !== undefined && id !== ""
        ? id
        : code !== undefined && code !== ""
          ? code
          : synthesizedFindingId(f.path, f.title),
  }));
  const systemic_problems = doc.systemic_problems?.map(
    ({ code, id, finding_codes, finding_ids, ...s }) => ({
      ...s,
      id:
        id !== undefined && id !== ""
          ? id
          : code !== undefined && code !== ""
            ? code
            : synthesizedSystemicId(s.title),
      ...(finding_ids !== undefined && finding_ids.length > 0
        ? { finding_ids }
        : finding_codes !== undefined
          ? { finding_ids: finding_codes }
          : {}),
    }),
  );
  const scope_metastasis =
    doc.scope_metastasis === undefined
      ? undefined
      : {
          decision_prompt: doc.scope_metastasis.decision_prompt,
          // A legacy recurring item carrying neither code nor id names nothing — drop it rather than
          // synthesize an id with nothing to key it on.
          recurring: doc.scope_metastasis.recurring.flatMap((r) => {
            const carried = r.id !== undefined && r.id !== "" ? r.id : r.code;
            return carried === undefined || carried === ""
              ? []
              : [
                  {
                    id: carried,
                    consecutive_rounds: r.consecutive_rounds,
                    start_round: r.start_round,
                  },
                ];
          }),
        };
  const convergence =
    doc.convergence === undefined
      ? undefined
      : {
          score: doc.convergence.score,
          threshold: doc.convergence.threshold,
          converged: doc.convergence.converged,
          ...(doc.convergence.rounds !== undefined
            ? {
                rounds: doc.convergence.rounds.map((r) => ({
                  round: r.round,
                  ...(r.score !== undefined ? { score: r.score } : {}),
                  // A present-but-EMPTY new spelling must not discard a populated legacy one — the
                  // hybrid the tolerant-in contract exists for (same rule as the finding_ids pair).
                  ...(r.ids !== undefined && Object.keys(r.ids).length > 0
                    ? { ids: r.ids }
                    : r.codes !== undefined
                      ? { ids: r.codes }
                      : {}),
                  ...(r.sha !== undefined ? { sha: r.sha } : {}),
                })),
              }
            : {}),
        };
  return {
    schema_version: DEFAULT_SCHEMA_VERSION,
    summary: doc.summary,
    verdict: doc.verdict,
    findings,
    ...(systemic_problems !== undefined ? { systemic_problems } : {}),
    ...(scope_metastasis !== undefined ? { scope_metastasis } : {}),
    ...(convergence !== undefined ? { convergence } : {}),
    ...(doc.change_size !== undefined ? { change_size: doc.change_size } : {}),
  };
};

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
    // The ISO-8601 UTC instant the run completed (stamped by `adapt` when it built this envelope, issue
    // #170). Cost recomputation prices a time-slotted model at THIS instant, so the same envelope prices
    // to the same slot deterministically wherever it is re-rendered — not at each command's wall clock.
    // Absent on a pre-#170 envelope (cost then falls back to the caller's instant).
    generated_at: t.string,
    // The run produced a notice rather than a completed review (security-gate block, agent kill, no
    // recoverable findings). An empty `findings` array alone can't say this — a genuine clean review
    // is also empty — so the render suppresses "clean review" and the sticky precedence guard refuses
    // to bury a completed review under it. Absent ⇒ a completed review.
    incomplete: t.boolean,
  }),
]);

const FlatModelPricesShape = t.type({
  in: NonNegativePrice,
  out: NonNegativePrice,
  cache_read: NonNegativePrice,
  cache_write: NonNegativePrice,
});

// The prices codecs mirror the ajv gate exactly, the same two-gates-agree discipline as
// SystemicProblemStrict et al. (issue #170 review): t.exact strips unknown keys on encode, and a
// key-set refinement rejects them on DECODE (ajv's additionalProperties:false) — so a hybrid entry that
// carries BOTH flat fields and `slots` is rejected by both variants and the union never ambiguates,
// rather than decoding as flat while being priced as slotted.
const FLAT_PRICE_KEYS = new Set(Object.keys(FlatModelPricesShape.props));
const FlatModelPricesStrict = t.refinement(
  FlatModelPricesShape,
  (p): p is t.TypeOf<typeof FlatModelPricesShape> =>
    Object.keys(p).every((k) => FLAT_PRICE_KEYS.has(k)),
  "FlatModelPricesStrict",
);
const FlatModelPricesCodec = t.exact(FlatModelPricesStrict);

// HH:MM in UTC (00:00–23:59). The pattern string is byte-identical to prices.schema.json's slot-time
// pattern so the codec + ajv gates cannot silently disagree (issue #170 review).
const UTC_HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const UtcHHMM = t.refinement(t.string, (s): s is string => UTC_HHMM_RE.test(s), "UtcHHMM");

// One UTC time-of-day slot (issue #170): a [utc_from, utc_to) half-open window — wrapping past midnight
// when utc_to <= utc_from — carrying the same per-token fields as the flat shape. cost.ts selects the
// slot covering the run's UTC instant; a model's slots must partition the 24h day with no gap or overlap.
const PriceSlotShape = t.intersection([
  t.type({ utc_from: UtcHHMM, utc_to: UtcHHMM }),
  FlatModelPricesShape,
]);
const PRICE_SLOT_KEYS = new Set(["utc_from", "utc_to", ...Object.keys(FlatModelPricesShape.props)]);
const PriceSlotStrict = t.refinement(
  PriceSlotShape,
  (s): s is t.TypeOf<typeof PriceSlotShape> => Object.keys(s).every((k) => PRICE_SLOT_KEYS.has(k)),
  "PriceSlotStrict",
);
const PriceSlotCodec = t.exact(PriceSlotStrict);

// `slots` must be non-empty (the ajv gate's minItems: 1) — an empty array is a misconfiguration, not a
// zero-cost model.
const NonEmptyPriceSlots = t.refinement(
  t.array(PriceSlotCodec),
  (a): a is t.TypeOf<typeof PriceSlotCodec>[] => a.length >= 1,
  "NonEmptyPriceSlots",
);
// `weekend_slots` overrides `slots` on Saturdays and Sundays, BEIJING time — DeepSeek bills off-peak
// all weekend from 2026-08-23 (issue #216). Optional and additive: a map without it behaves exactly as
// before. Two arrays rather than a weekday field on a slot, because that shape would make a
// partition-with-a-Saturday-gap newly expressible. Each array is independently a 24h partition and the
// existing "exactly one covering slot" check applies unchanged — but only to whichever array a given
// run selects, so a broken `weekend_slots` stays quiet until a weekend run reaches it. The warning
// names the array it consulted for that reason.
const SlottedRequired = t.type({ slots: NonEmptyPriceSlots });
const SlottedOptional = t.partial({ weekend_slots: NonEmptyPriceSlots });
const SlottedShape = t.intersection([SlottedRequired, SlottedOptional]);
const SLOTTED_KEYS = new Set([
  ...Object.keys(SlottedRequired.props),
  ...Object.keys(SlottedOptional.props),
]);
const SlottedModelPricesStrict = t.refinement(
  SlottedShape,
  (s): s is t.TypeOf<typeof SlottedShape> => Object.keys(s).every((k) => SLOTTED_KEYS.has(k)),
  "SlottedModelPricesStrict",
);
const SlottedModelPricesCodec = t.exact(SlottedModelPricesStrict);

// A model's price is EITHER flat (one all-day rate — unchanged, fully backward-compatible) OR a set of
// UTC time-of-day slots (issue #170), for a provider with peak/off-peak rates (DeepSeek). Both variants
// are strict-keyed (above), so the union rejects a hybrid entry instead of silently resolving it to one.
export const ModelPricesCodec = t.union([FlatModelPricesCodec, SlottedModelPricesCodec]);

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
export const DEFAULT_SCHEMA_VERSION = "0.10.0";

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
export type FlatModelPrices = t.TypeOf<typeof FlatModelPricesCodec>;
export type PriceSlot = t.TypeOf<typeof PriceSlotCodec>;
export type ModelPrices = t.TypeOf<typeof ModelPricesCodec>;
export type PriceMap = t.TypeOf<typeof PriceMapCodec>;
export type TestFailure = t.TypeOf<typeof TestFailureCodec>;
export type TestSummary = t.TypeOf<typeof TestSummaryCodec>;
