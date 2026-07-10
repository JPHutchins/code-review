// Adapter: maps a coding-agent CLI's native result envelope onto the abstract
// result envelope (SPEC §6.1). Claude Code is the reference adapter — see docs/adapters.md.
// A present-but-wrong-shaped native surfaces as a Left; an *absent* native (undefined or null — the
// caller could not read/parse it, e.g. a wall-clock timeout killed `claude -p` mid-flush, issue #39)
// still recovers findings from --agent-file, and refills telemetry from the transcript fallback when
// the caller supplies one (issue #36) so cost is real, not $0.00. Never throws.

import * as t from "io-ts";
import type { Either } from "fp-ts/Either";
import { resolve } from "./registry.js";
import { extractStructured, describeLadderFailure } from "./extract.js";
import { DEFAULT_SCHEMA_VERSION, noticeFindings } from "./schema.js";
import type { Findings, ModelUsageEntry, ResultEnvelope } from "./schema.js";

// No value-level import from fp-ts (a bare "fp-ts/Either" subpath import breaks under strict
// Node ESM — see fp-ts's lack of a package.json "exports" map). Either values are constructed
// as plain tagged literals and consumed via ._tag, matching this codebase's existing convention
// (validate.ts, index.ts) of importing only the Either *type*.
const left = <A>(message: string): Either<string, A> => ({ _tag: "Left", left: message });
const right = <A>(value: A): Either<string, A> => ({ _tag: "Right", right: value });

export type AdapterName = "claude-code";

export const isAdapterName = (name: string): name is AdapterName => name === "claude-code";

const ClaudeCodeModelUsageEntryCodec = t.intersection([
  t.type({
    inputTokens: t.number,
    outputTokens: t.number,
  }),
  t.partial({
    cacheReadInputTokens: t.number,
    cacheCreationInputTokens: t.number,
    costUSD: t.number,
  }),
]);

export const ClaudeCodeEnvelopeCodec = t.intersection([
  t.type({
    modelUsage: t.record(t.string, ClaudeCodeModelUsageEntryCodec),
    num_turns: t.number,
    duration_ms: t.number,
  }),
  t.partial({
    total_cost_usd: t.union([t.number, t.null]),
    structured_output: t.unknown,
  }),
]);

type ClaudeCodeEnvelope = t.TypeOf<typeof ClaudeCodeEnvelopeCodec>;

const mapModelUsage = (modelUsage: ClaudeCodeEnvelope["modelUsage"]): ModelUsageEntry[] =>
  Object.entries(modelUsage).map(([model, entry]) => ({
    model,
    input_tokens: entry.inputTokens,
    output_tokens: entry.outputTokens,
    ...(entry.cacheReadInputTokens !== undefined
      ? { cache_read_tokens: entry.cacheReadInputTokens }
      : {}),
    ...(entry.cacheCreationInputTokens !== undefined
      ? { cache_write_tokens: entry.cacheCreationInputTokens }
      : {}),
  }));

/** Telemetry recovered from the session transcript tree, supplied by the caller. It is the source of
 *  the envelope's wall + turn count whenever a transcript is available (the native envelope reports
 *  only the main agent's active time/turns and under-reports a subagent fan-out — issue #59), and it
 *  refills per-model USAGE too when the native has none — a wall-clock kill leaves the native
 *  absent/empty (issue #39), yet the transcript still records the real spend (issue #36), so cost
 *  computes from real models×prices downstream instead of a false $0.00. */
export interface TranscriptTelemetry {
  readonly models: readonly ModelUsageEntry[];
  readonly turns: number;
  readonly durationMs: number;
}

/** Run context the caller stamps into the envelope: route/effort (SPEC §6.1) and an optional
 *  transcript telemetry fallback. The fallback is a THUNK — invoked once when supplied (the read can
 *  be megabytes on a large fan-out, so callers pass it only when a transcript path was given). */
export interface RunMeta {
  readonly route?: string;
  readonly effort?: string;
  readonly transcriptFallback?: () => TranscriptTelemetry;
}

/** The extraction ladder's outcome, reduced to what `buildEnvelope` needs: either a materialized
 *  findings document, or a reason findings are unavailable. Never a reason to drop telemetry
 *  (issue #18) — every ladder outcome maps onto a *findings* result, not a fatal one. */
type FindingsOutcome =
  | { readonly kind: "ok"; readonly version: string; readonly findings: Findings }
  | { readonly kind: "telemetry-only"; readonly reason: string };

const findingsOutcome = (native: unknown, agentFilePath: string | undefined): FindingsOutcome => {
  const ladder = extractStructured({ kind: "findings", native, agentFilePath });
  if (ladder.kind !== "ok")
    return { kind: "telemetry-only", reason: describeLadderFailure(ladder) };
  // The ladder already confirmed this candidate resolves via the registry; re-resolving here just
  // materializes the typed, normalized value it deliberately didn't keep (see extract.ts).
  const resolution = resolve("findings", ladder.candidate);
  return resolution.kind === "ok"
    ? { kind: "ok", version: resolution.version, findings: resolution.value }
    : {
        kind: "telemetry-only",
        reason:
          "internal error: the extraction ladder validated a candidate the registry then rejected",
      };
};

/** The abstract envelope's telemetry fields (SPEC §6.1), split out so both a decoded native
 *  envelope and an absent one (issue #39) assemble the same shape. */
interface Telemetry {
  readonly models: ModelUsageEntry[];
  readonly turns: number;
  readonly duration_ms: number;
  readonly vendor_cost_usd: number | null;
  readonly route?: string;
  readonly effort?: string;
}

const withMeta = (base: Omit<Telemetry, "route" | "effort">, meta: RunMeta): Telemetry => ({
  ...base,
  ...(meta.route ? { route: meta.route } : {}),
  ...(meta.effort ? { effort: meta.effort } : {}),
});

/** Assemble telemetry, taking each field from the source that is authoritative for it — NOT simply
 *  "always the transcript." Two sources, two strengths:
 *
 *  - WALL + TURNS come from the transcript whenever one is available. The native envelope reports only
 *    the MAIN agent's active time and turn count, which wildly under-report a review that fanned out
 *    subagents — a 12-subagent, ~12-minute run otherwise surfaces as "5 turns, 42s" (issue #59). The
 *    transcript tree spans the whole session (main + subagents), so its span is the true wall and its
 *    message count the real work.
 *  - Per-model USAGE stays native-authoritative when present. Claude Code's rollup already includes
 *    the subagents (issue #18), and it is MORE accurate than the transcript for output tokens: summing
 *    the per-message `usage` under-counts output badly (measured ~5.7× low on the #59 fixture —
 *    32,945 vs the native's 188,952 output tokens on the same run, while input + cache-read matched),
 *    because the transcript doesn't record every message's full output. So using the transcript for
 *    cost would under-count it several-fold — DO NOT "simplify" this to always-transcript. The
 *    transcript refills usage ONLY when the native has none (a `timeout` kill leaves it absent/empty —
 *    issues #39/#36), where an under-count still beats a false $0.00.
 *
 *  The vendor's own cost figure is carried through from the native whenever it had one. */
const resolveTelemetry = (
  native: {
    models: ModelUsageEntry[];
    turns: number;
    durationMs: number;
    vendorCostUsd: number | null;
  },
  meta: RunMeta,
): Telemetry => {
  // Reading the transcript must never fail the adapt step (§5.5) — a thunk that throws degrades to
  // "no transcript", i.e. the native's own figures.
  const fb = ((): TranscriptTelemetry | undefined => {
    try {
      return meta.transcriptFallback?.();
    } catch {
      return undefined;
    }
  })();
  // Wall + turns come from the transcript together (never one source for turns and another for the
  // wall) whenever it yields a real span; otherwise both from the native envelope.
  const wallTurns =
    fb !== undefined && fb.durationMs > 0
      ? { turns: fb.turns, duration_ms: fb.durationMs }
      : { turns: native.turns, duration_ms: native.durationMs };
  return withMeta(
    {
      models: native.models.length > 0 ? native.models : fb ? [...fb.models] : native.models,
      ...wallTurns,
      vendor_cost_usd: native.vendorCostUsd,
    },
    meta,
  );
};

/** Telemetry from a decoded native envelope: its per-model usage + vendor cost, plus wall/turns that
 *  `resolveTelemetry` overrides from the transcript when one is available (issue #59) or that the
 *  transcript refills entirely on a wall-kill that left the native empty (issues #39/#36/#18). */
const nativeTelemetry = (native: ClaudeCodeEnvelope, meta: RunMeta): Telemetry =>
  resolveTelemetry(
    {
      models: mapModelUsage(native.modelUsage),
      turns: native.num_turns,
      durationMs: native.duration_ms,
      vendorCostUsd: native.total_cost_usd ?? null,
    },
    meta,
  );

/** Telemetry when the native envelope is absent/unreadable (issue #39): a wall-clock `timeout` can
 *  kill `claude -p` mid-flush, leaving no parseable envelope. The transcript fallback (issue #36)
 *  refills real spend when present; otherwise zeros. Either way the findings ladder still runs (its
 *  --agent-file rung needs no native), so a checkpointed $DRAFT survives the cutoff. */
const absentTelemetry = (meta: RunMeta): Telemetry =>
  resolveTelemetry({ models: [], turns: 0, durationMs: 0, vendorCostUsd: null }, meta);

/** Assemble the abstract envelope (SPEC §6.1): `findings`/`schema_version` from the extraction
 *  ladder (which reads --agent-file and defensively reads the raw native), telemetry from the
 *  caller. A ladder miss becomes a "did not complete" notice — never a discarded envelope. */
const buildEnvelope = (
  telemetry: Telemetry,
  native: unknown,
  agentFilePath: string | undefined,
): ResultEnvelope => {
  const outcome = findingsOutcome(native, agentFilePath);
  switch (outcome.kind) {
    case "ok":
      return { schema_version: outcome.version, findings: outcome.findings, ...telemetry };
    case "telemetry-only":
      return {
        schema_version: DEFAULT_SCHEMA_VERSION,
        findings: noticeFindings(`### ⚠️ Review did not complete\n\n${outcome.reason}`),
        ...telemetry,
      };
  }
};

/** Map a native agent-CLI result envelope onto the abstract envelope (SPEC §6.1). `agentFilePath`
 *  is meaningful only for the findings recovery (a documented no-op otherwise). A `native` of
 *  `undefined` or `null` means the caller could not read/parse the envelope (empty/truncated, or a
 *  literal JSON `null` — issue #39): rather than fail the run, the adapter emits a no-telemetry
 *  envelope and still recovers findings from --agent-file. A *present* but wrong-shaped native is
 *  still a Left (a real adapter mismatch). */
export const adapt = (
  adapterName: AdapterName,
  native: unknown,
  agentFilePath?: string,
  meta: RunMeta = {},
): Either<string, ResultEnvelope> => {
  switch (adapterName) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhaustive by design; AdapterName grows (e.g. "opencode") without collapsing this switch to an if
    case "claude-code": {
      if (native === undefined || native === null)
        return right(buildEnvelope(absentTelemetry(meta), undefined, agentFilePath));
      const decoded = ClaudeCodeEnvelopeCodec.decode(native);
      if (decoded._tag === "Left")
        return left("native envelope does not match the Claude Code output shape");
      return right(buildEnvelope(nativeTelemetry(decoded.right, meta), native, agentFilePath));
    }
  }
};
