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
const SEMVER_SUFFIX =
  "(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const SCHEMA_VERSION_RE = new RegExp(`^(0|[1-9]\\d*)\\.(\\d+)\\.(\\d+)${SEMVER_SUFFIX}$`);

// The enforcement copy printableSchema injects: the general pattern narrowed to the in-force minor,
// admitting exactly the stamps (patch, prerelease, build) the registry dispatches to the live entry.
export const anchoredSchemaVersionPattern = (version: string): string =>
  `^${version.split(".").slice(0, 2).join("\\.")}\\.[0-9]+${SEMVER_SUFFIX}$`;

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

// The ONE strict+exact discipline shared by every strict-keyed codec in this file: the ajv gate
// rejects unknown keys (additionalProperties: false), while t.exact strips them SILENTLY on both
// encode and decode — so without the refinement the codec gate would accept-and-drop exactly what
// the ajv gate rejects. The refinement makes the codec gate reject instead, with the key set derived
// from the passed members. `members` MUST be exactly the shape's prop-bearing leaves (each shape's
// own component codecs): an omitted leaf would silently reject that leaf's fields on every decode —
// the key set cannot drift only if the list cannot.
const strictExact = <C extends t.HasProps>(
  name: string,
  shape: C,
  members: readonly { props: t.Props }[],
): t.ExactC<t.RefinementC<C>> => {
  const keys = new Set(members.flatMap((m) => Object.keys(m.props)));
  return t.exact(
    t.refinement(shape, (x): x is t.TypeOf<C> => Object.keys(x).every((k) => keys.has(k)), name),
  );
};

// The stable mechanism identifier pair, shared by findings and systemic problems so the two shapes
// can never diverge on it. The `id` itself is REQUIRED on a finding (trackability across rounds and
// discussions); the optional half of the pair is the URL documenting the rule it names.
const RuleUrlCodec = t.partial({
  code_url: UriString,
});

// The finding's REQUIRED fields minus its identity, shared by BOTH suites: the 0.10 shape adds
// `id` required (FindingIdRequired), the legacy shape adds the tolerant LegacyRuleCodec instead.
const FindingCoreRequired = t.type({
  path: t.string,
  start_line: LineNumber,
  end_line: LineNumber,
  severity: SeverityCodec,
  title: t.string,
  description: t.string,
  reasoning: t.string,
  confidence: Confidence,
  likelihood: Likelihood,
});

const FindingIdRequired = t.type({ id: t.string });

const FindingOptional = t.partial({
  side: SideCodec,
  recommendation: t.string,
  patch: t.string,
});

// ONE line-anchor refinement shared by BOTH finding shapes — they differ only in their identity
// field, so the end>=start gate rides a minimal anchor shape each intersection includes.
// ONE line-anchor gate shared by BOTH finding shapes — they differ only in their identity field.
// Applied as a WRAPPER refinement around each shape (not an intersection member), so an inner shape
// failure short-circuits with the outer context (`0.findings.0`) — an intersection member would fail
// under a bare numeric index and dump the whole finding into the stop-gate message the next-round
// agent reads.
const EndGeStart = <C extends t.HasProps>(shape: C): t.RefinementC<C> =>
  t.refinement(shape, (f): f is t.TypeOf<C> => f.end_line >= f.start_line, "EndGeStart");

// Strict-key refinement (see strictExact): t.exact would silently strip unknown keys, so the
// codec gate must reject exactly what ajv rejects instead of accepting-and-dropping — a removed
// `code` key must not pass one gate and fail the other.
const FindingShape = t.intersection([
  FindingCoreRequired,
  FindingIdRequired,
  RuleUrlCodec,
  FindingOptional,
]);

export const FindingCodec = strictExact("FindingStrict", EndGeStart(FindingShape), [
  FindingCoreRequired,
  FindingIdRequired,
  RuleUrlCodec,
  FindingOptional,
]);

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

// The schema declares additionalProperties: false; strictExact makes the codec gate reject exactly
// what the ajv gate rejects instead of silently stripping (the extraction ladder runs both gates).
export const SystemicProblemCodec = strictExact("SystemicProblemStrict", SystemicProblemShape, [
  SystemicRequired,
  RuleUrlCodec,
  SystemicOptional,
]);

// Shared by BOTH suites' recurring items (issue #150): the 0.10 shape requires `id`, the legacy
// shape swaps it for the tolerant code/id pair.
const ConsecutiveRounds = t.refinement(
  t.number,
  (n): n is number => Number.isSafeInteger(n) && n >= 1,
  "ConsecutiveRounds",
);
const StartRound = t.refinement(
  t.number,
  (n): n is number => Number.isSafeInteger(n) && n >= 1,
  "StartRound",
);

const RecurringShape = t.type({
  id: t.string,
  consecutive_rounds: ConsecutiveRounds,
  start_round: StartRound,
});

// The schema declares additionalProperties: false on recurring items; strictExact makes the codec
// gate reject exactly what the ajv gate rejects instead of silently stripping (a seed-echoing draft
// smuggling an extra key into a recurring item must not pass one gate and fail the other).
const RecurringCodec = strictExact("RecurringStrict", RecurringShape, [RecurringShape]);

// The scope-metastasis entry (issue #150): per-code consecutive-round recurrence counts plus the
// decision prompt, computed from the rounds history. The agent never writes it — the re-review seed
// re-derives it from the carried convergence trajectory and delivers it to the next-round agent — but
// the draft schema tolerates it so a seed-echoing agent's draft still validates.
const ScopeMetastasisShape = t.type({
  decision_prompt: t.string,
  recurring: t.array(RecurringCodec),
});

export const ScopeMetastasisCodec = strictExact("ScopeMetastasisStrict", ScopeMetastasisShape, [
  ScopeMetastasisShape,
]);

// One round's trajectory entry (issue #174): the round number and its convergence score, plus the
// mechanism-frequency map and reviewed head SHA the recurrence signals read. Prior rounds are carried
// verbatim, so a threshold change never rewrites a past score.
const RoundNumber = t.refinement(
  t.number,
  (n): n is number => Number.isSafeInteger(n) && n >= 1,
  "RoundNumber",
);

// t.record decodes by plain assignment into a fresh object, and assigning a number to `__proto__`
// hits the inherited accessor and silently no-ops — a reviewer-supplied `__proto__` id (which every
// writer-side map preserves via Object.fromEntries) would vanish on the round-trip. The custom codec
// rebuilds the map with Object.fromEntries, so the decode preserves exactly the keys the writer wrote.
// Values: negative counts are REJECTED (the ajv gates carry minimum: 0, and the codec gate mirrors
// them), while a 0-valued entry is DROPPED — 0 means "no findings this round" and every round reader
// treats it as absence, so the decode and the readers agree without rejecting the whole document.
const idFrequencyCodec = (
  name: string,
): t.Type<Readonly<Record<string, number>>, Readonly<Record<string, number>>> =>
  new t.Type<Readonly<Record<string, number>>, Readonly<Record<string, number>>>(
    name,
    (u): u is Readonly<Record<string, number>> =>
      typeof u === "object" && u !== null && !Array.isArray(u),
    (u, c) => {
      if (typeof u !== "object" || u === null || Array.isArray(u)) return t.failure(u, c);
      const entries: [string, number][] = [];
      for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return t.failure(v, c);
        if (v === 0) continue;
        entries.push([k, v]);
      }
      return t.success(Object.fromEntries(entries));
    },
    (a) => a,
  );

const IdFrequency = idFrequencyCodec("IdFrequency");

const ConvergenceRoundRequired = t.type({ round: RoundNumber });
const ConvergenceRoundOptional = t.partial({
  score: FiniteNumber,
  ids: IdFrequency,
  sha: t.string,
});
const ConvergenceRoundShape = t.intersection([ConvergenceRoundRequired, ConvergenceRoundOptional]);

export const ConvergenceRoundCodec = strictExact("ConvergenceRoundStrict", ConvergenceRoundShape, [
  ConvergenceRoundRequired,
  ConvergenceRoundOptional,
]);

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

export const ConvergenceCodec = strictExact("ConvergenceStrict", ConvergenceShape, [
  ConvergenceCoreShape,
  ConvergenceOptional,
]);

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

// Exactly the shape synthesizedFindingId emits (`f-` + 12 base64url chars) — the answered matcher's
// title second chance applies ONLY to entries whose code was synthesized (the pre-0.10 codeless
// pair), so a reviewer-supplied id that merely starts with `f-` can never open the fallback.
export const isSynthesizedFindingId = (id: string): boolean => /^f-[A-Za-z0-9_-]{12}$/.test(id);

// The ONE resolution a finding's id goes through: an explicit id wins, and an empty one resolves to
// the same synthesized id the legacy upcast derives — shared by the answered-registry builder and the
// answered match, so the two sides can never disagree on what an empty id means.
export const resolveFindingId = (f: { id: string; path: string; title: string }): string =>
  f.id !== "" ? f.id : synthesizedFindingId(f.path, f.title);

// The ONE legacy-spelling precedence for a RAW record (id → code → synthesized when a path exists):
// shared by the legacy upcast, the answered-registry marker reader, and the below-floor nit reader,
// so the three raw-document sites can never drift on which spelling wins. undefined only when the
// record carries no usable spelling AND no path to synthesize from (a systemic's shape).
export const resolveRuleId = (rec: {
  readonly id?: string;
  readonly code?: string;
  readonly path?: string;
  readonly title: string;
}): string | undefined =>
  rec.id !== undefined && rec.id !== ""
    ? rec.id
    : rec.code !== undefined && rec.code !== ""
      ? rec.code
      : rec.path !== undefined
        ? synthesizedFindingId(rec.path, rec.title)
        : undefined;

// The ONE "usable counts map" predicate every round reader shares: every entry a positive safe
// integer — a present-but-malformed/empty/all-zero map is absence, so a valid legacy `codes` map
// sitting beside a bad `ids` takes over wherever a round's mechanism map is read (the round readers
// and the legacy upcast both apply it, so they can never disagree on what a usable map is).
export const usableCountsMap = (v: unknown): Readonly<Record<string, number>> | undefined => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Record<string, unknown>).filter(
    (e): e is [string, number] =>
      typeof e[1] === "number" && Number.isSafeInteger(e[1]) && e[1] > 0,
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

// The ONE dual-spelling resolution for a round's mechanism map: when BOTH spellings carry usable
// maps, their entries MERGE — the current `ids` spelling wins every shared key (the writer stopped
// emitting `codes`, so a stale legacy count must never displace the current one), and `codes`
// supplies only the keys `ids` lacks, so a merely-usable `ids` cannot discard a more complete
// legacy map's names. Shared by the legacy upcast, the surface convergence migration, and
// parseRounds so the dual-spelling readers can never drift.
export const mergedCountsMaps = (
  ids: unknown,
  codes: unknown,
): Readonly<Record<string, number>> | undefined => {
  const idsMap = usableCountsMap(ids);
  const codesMap = usableCountsMap(codes);
  if (idsMap === undefined) return codesMap;
  if (codesMap === undefined) return idsMap;
  const merged = new Map<string, number>(Object.entries(codesMap));
  for (const [k, v] of Object.entries(idsMap)) merged.set(k, v);
  return Object.fromEntries(merged);
};

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

const FindingShapeV09 = t.intersection([FindingCoreRequired, LegacyRuleCodec, FindingOptional]);

// The legacy finding stays tolerant-in on KEYS — no strict-key gate, unlike its 0.10 counterpart —
// because the legacy route's contract is tolerant-in/strict-out (normalizeV09 rewrites to the strict
// 0.10 shape); only the end>=start anchor and the exact-strip run here.
const FindingCodecV09 = t.exact(EndGeStart(FindingShapeV09));

const SystemicV09Optional = t.partial({
  finding_codes: t.array(t.string),
  finding_ids: t.array(t.string),
  paths: t.array(t.string),
});

const SystemicV09Shape = t.intersection([SystemicRequired, LegacyRuleCodec, SystemicV09Optional]);

const SystemicProblemCodecV09 = strictExact("SystemicV09Strict", SystemicV09Shape, [
  SystemicRequired,
  LegacyRuleCodec,
  SystemicV09Optional,
]);

const RecurringV09Identity = t.partial({ code: t.string, id: t.string });
const RecurringV09Counts = t.type({
  consecutive_rounds: ConsecutiveRounds,
  start_round: StartRound,
});
const RecurringV09Shape = t.intersection([RecurringV09Identity, RecurringV09Counts]);
const RecurringCodecV09 = strictExact("RecurringV09Strict", RecurringV09Shape, [
  RecurringV09Identity,
  RecurringV09Counts,
]);

const ScopeMetastasisV09Shape = t.type({
  decision_prompt: t.string,
  recurring: t.array(RecurringCodecV09),
});

const ScopeMetastasisCodecV09 = strictExact("ScopeMetastasisV09Strict", ScopeMetastasisV09Shape, [
  ScopeMetastasisV09Shape,
]);

const CodeFrequencyV09 = idFrequencyCodec("CodeFrequencyV09");

const ConvergenceRoundV09Optional = t.partial({
  score: FiniteNumber,
  codes: CodeFrequencyV09,
  ids: CodeFrequencyV09,
  sha: t.string,
});

const ConvergenceRoundV09Shape = t.intersection([
  ConvergenceRoundRequired,
  ConvergenceRoundV09Optional,
]);

const ConvergenceRoundCodecV09 = strictExact(
  "ConvergenceRoundV09Strict",
  ConvergenceRoundV09Shape,
  [ConvergenceRoundRequired, ConvergenceRoundV09Optional],
);

const ConvergenceV09Optional = t.partial({ rounds: t.array(ConvergenceRoundCodecV09) });
const ConvergenceV09Shape = t.intersection([ConvergenceCoreShape, ConvergenceV09Optional]);

const ConvergenceCodecV09 = strictExact("ConvergenceV09Strict", ConvergenceV09Shape, [
  ConvergenceCoreShape,
  ConvergenceV09Optional,
]);

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
      resolveRuleId({ id, code, path: f.path, title: f.title }) ??
      synthesizedFindingId(f.path, f.title),
  }));
  const systemic_problems = doc.systemic_problems?.map(
    ({ code, id, finding_codes, finding_ids, ...s }) => ({
      ...s,
      id: resolveRuleId({ id, code, title: s.title }) ?? synthesizedSystemicId(s.title),
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
                rounds: doc.convergence.rounds.map((r) => {
                  // mergedCountsMaps: the upcast, the surface migration, and parseRounds
                  // share ONE dual-spelling resolution, so a merely-usable new spelling can never
                  // discard a more complete legacy one (or diverge from the marker channel).
                  const ids = mergedCountsMaps(r.ids, r.codes);
                  return {
                    round: r.round,
                    ...(r.score !== undefined ? { score: r.score } : {}),
                    ...(ids !== undefined ? { ids } : {}),
                    ...(r.sha !== undefined ? { sha: r.sha } : {}),
                  };
                }),
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
const FlatModelPricesCodec = strictExact("FlatModelPricesStrict", FlatModelPricesShape, [
  FlatModelPricesShape,
]);

// HH:MM in UTC (00:00–23:59). The pattern string is byte-identical to prices.schema.json's slot-time
// pattern so the codec + ajv gates cannot silently disagree (issue #170 review).
const UTC_HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const UtcHHMM = t.refinement(t.string, (s): s is string => UTC_HHMM_RE.test(s), "UtcHHMM");

// One UTC time-of-day slot (issue #170): a [utc_from, utc_to) half-open window — wrapping past midnight
// when utc_to <= utc_from — carrying the same per-token fields as the flat shape. cost.ts selects the
// slot covering the run's UTC instant; a model's slots must partition the 24h day with no gap or overlap.
const PriceSlotAnchor = t.type({ utc_from: UtcHHMM, utc_to: UtcHHMM });
const PriceSlotShape = t.intersection([PriceSlotAnchor, FlatModelPricesShape]);
const PriceSlotCodec = strictExact("PriceSlotStrict", PriceSlotShape, [
  PriceSlotAnchor,
  FlatModelPricesShape,
]);

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
const SlottedModelPricesCodec = strictExact("SlottedModelPricesStrict", SlottedShape, [
  SlottedRequired,
  SlottedOptional,
]);

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
