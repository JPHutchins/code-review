// Extraction ladder: recovers a schema-conforming candidate (findings or triage) from a native
// agent-CLI envelope when structured-output enforcement is imperfect or absent. Security rationale:
// a rung wins only on EXACTLY ONE distinct schema-validating candidate (fenced blocks deduped by
// canonical value first), which defeats block-injection; disagreeing candidates are refused. Every
// candidate must pass BOTH gates — ajv (shape + additionalProperties:false) and the registry's io-ts
// codec (cross-field invariants ajv can't express, e.g. end_line >= start_line).

import { readFileOrNull, tryParseJson } from "./util.js";
import { resolve, schemaPathFor, defaultVersion } from "./registry.js";
import { validateAgainstSchema } from "./validate.js";

export type ExtractKind = "findings" | "triage";

export interface ExtractInput {
  readonly kind: ExtractKind;
  // findings only — a documented no-op for triage.
  readonly agentFilePath?: string;
  // Last valid draft snapshot, tried after agentFilePath and before the native envelope.
  readonly agentFileFallbackPath?: string;
  readonly native: unknown;
}

export type LadderOutcome =
  | { readonly kind: "ok"; readonly version: string; readonly candidate: unknown }
  | { readonly kind: "error-envelope"; readonly detail: string }
  | { readonly kind: "none"; readonly detail: string }
  | { readonly kind: "ambiguous"; readonly detail: string };

interface NativeForExtraction {
  readonly result: unknown;
  readonly structuredOutput: unknown;
  readonly isError: unknown;
  readonly subtype: unknown;
  readonly apiErrorStatus: unknown;
}

const fieldOf = (raw: unknown, key: string): unknown =>
  typeof raw === "object" && raw !== null && key in raw
    ? (raw as Record<string, unknown>)[key]
    : undefined;

const parseNativeForExtraction = (raw: unknown): NativeForExtraction => ({
  result: fieldOf(raw, "result"),
  structuredOutput: fieldOf(raw, "structured_output"),
  isError: fieldOf(raw, "is_error"),
  subtype: fieldOf(raw, "subtype"),
  apiErrorStatus: fieldOf(raw, "api_error_status"),
});

const isNullish = (value: unknown): boolean => value === null || value === undefined;

const isErrorEnvelope = (native: NativeForExtraction): boolean =>
  native.isError === true ||
  (!isNullish(native.subtype) && native.subtype !== "success") ||
  !isNullish(native.apiErrorStatus);

const describeErrorEnvelope = (native: NativeForExtraction): string => {
  const parts: readonly string[] = [
    ...(native.isError === true ? ["is_error=true"] : []),
    ...(!isNullish(native.subtype) && native.subtype !== "success"
      ? [`subtype=${JSON.stringify(native.subtype)}`]
      : []),
    ...(!isNullish(native.apiErrorStatus)
      ? [`api_error_status=${JSON.stringify(native.apiErrorStatus)}`]
      : []),
  ];
  return `agent run did not complete successfully (${parts.join(", ")})`;
};

export const withDefaultSchemaVersion = (candidate: unknown): unknown =>
  typeof candidate === "object" &&
  candidate !== null &&
  !Array.isArray(candidate) &&
  !("schema_version" in candidate)
    ? { ...candidate, schema_version: defaultVersion("findings") }
    : candidate;

const normalizeCandidate = (kind: ExtractKind, candidate: unknown): unknown =>
  kind === "findings" ? withDefaultSchemaVersion(candidate) : candidate;

const candidateVersion = (kind: ExtractKind, candidate: unknown): string | undefined => {
  if (kind !== "findings") return undefined;
  const version = fieldOf(candidate, "schema_version");
  return typeof version === "string" ? version : undefined;
};

const safeSchemaPathFor = (kind: ExtractKind, version: string | undefined): string | null => {
  try {
    return schemaPathFor(kind, version);
  } catch {
    return null;
  }
};

interface GatedCandidate {
  readonly version: string;
  // Pre-registry-normalize (identical for alpha) — what the extract CLI prints, per the registry seam.
  readonly candidate: unknown;
}

// Sort keys recursively so two values differing only in key order canonicalize equal.
const canonicalize = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalize)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonicalize(v)]),
        )
      : value;

// A model re-emitting its answer verbatim is benign, not a conflict; candidates differing in any
// value stay distinct, so the injection defense (refusing a survivor among disagreeing candidates) holds.
const dedupCandidates = (candidates: readonly GatedCandidate[]): readonly GatedCandidate[] => {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = JSON.stringify(canonicalize(c.candidate));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Both gates: ajv (shape + injection defense) then the registry's io-ts codec (materialization +
// cross-field invariants). Null when either rejects.
const gateCandidate = (kind: ExtractKind, rawCandidate: unknown): GatedCandidate | null => {
  const candidate = normalizeCandidate(kind, rawCandidate);
  const schemaPath = safeSchemaPathFor(kind, candidateVersion(kind, candidate));
  if (schemaPath === null) return null;
  if (!validateAgainstSchema(candidate, schemaPath).valid) return null;
  const resolution = resolve(kind, candidate);
  return resolution.kind === "ok" ? { version: resolution.version, candidate } : null;
};

const candidateFromJsonText = (kind: ExtractKind, text: string | null): GatedCandidate | null => {
  if (text === null) return null;
  const parsed = tryParseJson(text);
  return parsed.ok ? gateCandidate(kind, parsed.value) : null;
};

interface FenceScanState {
  readonly blocks: readonly string[];
  readonly openLength: number | null;
  readonly buffer: readonly string[];
}

const FENCE_OPEN = /^\s*(`{3,})/;
const FENCE_MARKER_ONLY = /^`+$/;

// Line-based by design — no regex spans more than one line, so no catastrophic-backtracking surface.
const scanLine = (state: FenceScanState, line: string): FenceScanState => {
  if (state.openLength === null) {
    const opened = FENCE_OPEN.exec(line)?.[1]?.length;
    return opened !== undefined ? { blocks: state.blocks, openLength: opened, buffer: [] } : state;
  }
  const trimmed = line.trim();
  const closes = FENCE_MARKER_ONLY.test(trimmed) && trimmed.length >= state.openLength;
  return closes
    ? { blocks: [...state.blocks, state.buffer.join("\n")], openLength: null, buffer: [] }
    : { ...state, buffer: [...state.buffer, line] };
};

export const scanFencedBlocks = (text: string): readonly string[] =>
  text.split("\n").reduce(scanLine, { blocks: [], openLength: null, buffer: [] }).blocks;

// Operator-facing trace for stderr/logs (never the fail-closed reasons, which stay generic): e.g. a
// null structured_output points at a CLI not enforcing --json-schema.
export const ladderFailureDiagnostics = (input: ExtractInput): string => {
  const native = parseNativeForExtraction(input.native);
  const preview = (s: string): string => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
  };
  const lines: string[] = [];
  if (input.kind === "findings") {
    lines.push(
      input.agentFilePath === undefined
        ? "agent-file rung: no --agent-file given"
        : `agent-file rung: ${input.agentFilePath} did not validate (or was unreadable)`,
    );
    if (input.agentFileFallbackPath !== undefined)
      lines.push(
        `last-valid rung: ${input.agentFileFallbackPath} did not validate (or was absent)`,
      );
  }
  lines.push(
    isNullish(native.structuredOutput)
      ? "structured_output rung: absent (null) — the CLI's --json-schema likely did not enforce"
      : "structured_output rung: present but did not validate against the schema",
  );
  lines.push(
    typeof native.result === "string"
      ? `result rung: ${String(native.result.length)} chars, ${String(scanFencedBlocks(native.result).length)} fenced JSON block(s), none validated; preview: ${preview(native.result)}`
      : "result rung: absent or not a string",
  );
  return lines.join("\n");
};

export const describeLadderFailure = (outcome: Exclude<LadderOutcome, { kind: "ok" }>): string => {
  switch (outcome.kind) {
    case "error-envelope":
      return `review did not complete: ${outcome.detail}`;
    case "none":
      return `could not recover a validating candidate: ${outcome.detail}`;
    case "ambiguous":
      return `ambiguous candidates: ${outcome.detail}`;
  }
};

const okOutcome = (gated: GatedCandidate): LadderOutcome => ({
  kind: "ok",
  version: gated.version,
  candidate: gated.candidate,
});

// Pure aside from an optional --agent-file read.
export const extractStructured = (input: ExtractInput): LadderOutcome => {
  const native = parseNativeForExtraction(input.native);

  if (isErrorEnvelope(native)) {
    return { kind: "error-envelope", detail: describeErrorEnvelope(native) };
  }

  if (input.kind === "findings") {
    for (const path of [input.agentFilePath, input.agentFileFallbackPath]) {
      if (path === undefined) continue;
      const fromFile = candidateFromJsonText(input.kind, readFileOrNull(path));
      if (fromFile) return okOutcome(fromFile);
    }
  }

  if (native.structuredOutput !== undefined) {
    const fromStructured = gateCandidate(input.kind, native.structuredOutput);
    if (fromStructured) return okOutcome(fromStructured);
  }

  if (typeof native.result === "string") {
    const fromResult = candidateFromJsonText(input.kind, native.result.trim());
    if (fromResult) return okOutcome(fromResult);

    const fencedCandidates = dedupCandidates(
      scanFencedBlocks(native.result)
        .map((block) => candidateFromJsonText(input.kind, block))
        .filter((gated): gated is GatedCandidate => gated !== null),
    );

    const [survivor, ...rest] = fencedCandidates;
    if (survivor !== undefined && rest.length === 0) return okOutcome(survivor);
    if (survivor !== undefined) {
      return {
        kind: "ambiguous",
        detail: `${String(fencedCandidates.length)} distinct fenced JSON blocks each validate against the ${input.kind} schema — refusing to pick one`,
      };
    }
  }

  const fallbackRung = input.agentFileFallbackPath ? ", last-valid snapshot" : "";
  return {
    kind: "none",
    detail: `no --agent-file${fallbackRung}, structured_output, JSON result, or fenced block validated against the ${input.kind} schema`,
  };
};
