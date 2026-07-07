// Adapter: maps a coding-agent CLI's native result envelope onto the abstract
// result envelope (SPEC §6.1). Claude Code is the reference adapter — see docs/adapters.md.
// Pure mapping; a decode failure surfaces as a Left, never a throw.

import * as t from "io-ts";
import type { Either } from "fp-ts/Either";
import { resolve } from "./registry.js";
import { extractStructured, describeLadderFailure } from "./extract.js";
import { DEFAULT_SCHEMA_VERSION } from "./schema.js";
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

/** Route/effort the review ran under (SPEC §6.1 envelope fields). */
export interface RunMeta {
  readonly route?: string;
  readonly effort?: string;
}

/** The extraction ladder's outcome, reduced to what adaptClaudeCode needs: either a materialized
 *  findings document, or a reason findings are unavailable. Never a reason to drop telemetry
 *  (issue #18) — every ladder outcome maps onto a *findings* result, not a fatal one. */
type FindingsOutcome =
  | { readonly kind: "ok"; readonly version: string; readonly findings: Findings }
  | { readonly kind: "telemetry-only"; readonly reason: string };

const findingsOutcome = (
  native: ClaudeCodeEnvelope,
  agentFilePath: string | undefined,
): FindingsOutcome => {
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

/** A fail-open findings document for the telemetry-only case (SPEC §6.1 — never `Left`; the run's
 *  real telemetry must survive even when no findings could be recovered, issue #18). */
const notCompletedFindings = (reason: string): Findings => ({
  schema_version: DEFAULT_SCHEMA_VERSION,
  summary: `### ⚠️ Review did not complete\n\n${reason}`,
  verdict: "comment",
  findings: [],
});

/** Map Claude Code's native `--output-format json` envelope onto the abstract envelope (SPEC §6.1).
 *  `findings` and `schema_version` come from the extraction ladder when it recovers a candidate;
 *  every other envelope field (models, turns, duration, vendor cost) always comes from the native
 *  envelope itself, UNCONDITIONALLY — a findings-ladder miss never discards real telemetry. */
const adaptClaudeCode = (
  native: ClaudeCodeEnvelope,
  agentFilePath: string | undefined,
  meta: RunMeta,
): Either<string, ResultEnvelope> => {
  const telemetry = {
    models: mapModelUsage(native.modelUsage),
    turns: native.num_turns,
    duration_ms: native.duration_ms,
    vendor_cost_usd: native.total_cost_usd ?? null,
    ...(meta.route ? { route: meta.route } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
  };
  const outcome = findingsOutcome(native, agentFilePath);
  switch (outcome.kind) {
    case "ok":
      return right({
        schema_version: outcome.version,
        findings: outcome.findings,
        ...telemetry,
      });
    case "telemetry-only":
      return right({
        schema_version: DEFAULT_SCHEMA_VERSION,
        findings: notCompletedFindings(outcome.reason),
        ...telemetry,
      });
  }
};

/** Map a native agent-CLI result envelope onto the abstract envelope (SPEC §6.1). `agentFilePath`
 *  is meaningful only for the findings recovery (a documented no-op otherwise). */
export const adapt = (
  adapterName: AdapterName,
  native: unknown,
  agentFilePath?: string,
  meta: RunMeta = {},
): Either<string, ResultEnvelope> => {
  switch (adapterName) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhaustive by design; AdapterName grows (e.g. "opencode") without collapsing this switch to an if
    case "claude-code": {
      const decoded = ClaudeCodeEnvelopeCodec.decode(native);
      if (decoded._tag === "Left") {
        return left("native envelope does not match the Claude Code output shape");
      }
      return adaptClaudeCode(decoded.right, agentFilePath, meta);
    }
  }
};
