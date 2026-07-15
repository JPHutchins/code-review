// Maps a coding-agent CLI's native result envelope onto the abstract envelope. An absent native
// (undefined/null — the caller couldn't read/parse it, e.g. a wall-clock kill hit `claude -p`
// mid-flush) still recovers findings from --agent-file and refills telemetry from the transcript
// fallback; a present-but-wrong-shaped native is a Left. Never throws.

import * as t from "io-ts";
import type { Either } from "fp-ts/Either";
import { resolve } from "./registry.js";
import { extractStructured, describeLadderFailure } from "./extract.js";
import { DEFAULT_SCHEMA_VERSION, noticeFindings } from "./schema.js";
import type { Findings, ModelUsageEntry, ResultEnvelope } from "./schema.js";

// No value-level fp-ts import: a bare "fp-ts/Either" subpath import breaks under strict Node ESM
// (fp-ts ships no "exports" map), so Either values are plain tagged literals, as in validate.ts.
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

export interface TranscriptTelemetry {
  readonly models: readonly ModelUsageEntry[];
  readonly turns: number;
  readonly durationMs: number;
}

// transcriptFallback is a THUNK — the read can be megabytes on a large fan-out, so callers pass it
// only when a transcript path was given.
export interface RunMeta {
  readonly route?: string;
  readonly effort?: string;
  readonly transcriptFallback?: () => TranscriptTelemetry;
  // Last valid draft snapshot, recovered when the live agent-file no longer validates (e.g. a
  // wall-kill truncated it).
  readonly agentFileFallbackPath?: string;
}

// Every ladder outcome maps onto a findings result, never a fatal one — a findings miss must not
// drop telemetry.
type FindingsOutcome =
  | { readonly kind: "ok"; readonly version: string; readonly findings: Findings }
  | { readonly kind: "telemetry-only"; readonly reason: string };

const findingsOutcome = (
  native: unknown,
  agentFilePath: string | undefined,
  agentFileFallbackPath: string | undefined,
): FindingsOutcome => {
  const ladder = extractStructured({
    kind: "findings",
    native,
    agentFilePath,
    agentFileFallbackPath,
  });
  if (ladder.kind !== "ok")
    return { kind: "telemetry-only", reason: describeLadderFailure(ladder) };
  // Re-resolving materializes the typed, normalized value the ladder deliberately didn't keep.
  const resolution = resolve("findings", ladder.candidate);
  return resolution.kind === "ok"
    ? { kind: "ok", version: resolution.version, findings: resolution.value }
    : {
        kind: "telemetry-only",
        reason:
          "internal error: the extraction ladder validated a candidate the registry then rejected",
      };
};

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

// Each field from whichever source is authoritative for it — NOT always the transcript:
//   - Wall + turns: the transcript when available. The native envelope reports only the main agent's
//     active time/turns and wildly under-reports a fan-out (a 12-subagent ~12-min run reads as "5
//     turns, 42s"); the transcript tree spans the whole session.
//   - Per-model usage: native-authoritative when present. Summing the transcript's per-message usage
//     under-counts output badly (measured ~5.7× low), so DO NOT "simplify" this to always-transcript;
//     the transcript refills usage ONLY when the native has none (a `timeout` kill left it empty).
// The vendor's own cost figure is carried through from the native whenever it had one.
const resolveTelemetry = (
  native: {
    models: ModelUsageEntry[];
    turns: number;
    durationMs: number;
    vendorCostUsd: number | null;
  },
  meta: RunMeta,
): Telemetry => {
  // A thunk that throws degrades to "no transcript" (the native's own figures) — never fails adapt.
  const fb = ((): TranscriptTelemetry | undefined => {
    try {
      return meta.transcriptFallback?.();
    } catch {
      return undefined;
    }
  })();
  // Wall + turns move together — never one source for turns and another for the wall.
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

// Native absent/unreadable (a wall-clock kill can leave no parseable envelope): the transcript
// fallback refills real spend when present, else zeros. The findings ladder still runs (its
// --agent-file rung needs no native), so a checkpointed $DRAFT survives the cutoff.
const absentTelemetry = (meta: RunMeta): Telemetry =>
  resolveTelemetry({ models: [], turns: 0, durationMs: 0, vendorCostUsd: null }, meta);

// A ladder miss becomes a "did not complete" notice, never a discarded envelope.
const buildEnvelope = (
  telemetry: Telemetry,
  native: unknown,
  agentFilePath: string | undefined,
  agentFileFallbackPath: string | undefined,
): ResultEnvelope => {
  const outcome = findingsOutcome(native, agentFilePath, agentFileFallbackPath);
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

// native undefined/null ⇒ the caller couldn't read/parse the envelope: emit a no-telemetry envelope
// and still recover findings from --agent-file, rather than failing the run. A present but
// wrong-shaped native is a Left (a real adapter mismatch).
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
        return right(
          buildEnvelope(
            absentTelemetry(meta),
            undefined,
            agentFilePath,
            meta.agentFileFallbackPath,
          ),
        );
      const decoded = ClaudeCodeEnvelopeCodec.decode(native);
      if (decoded._tag === "Left")
        return left("native envelope does not match the Claude Code output shape");
      return right(
        buildEnvelope(
          nativeTelemetry(decoded.right, meta),
          native,
          agentFilePath,
          meta.agentFileFallbackPath,
        ),
      );
    }
  }
};
