// Extraction ladder: recovers a schema-conforming candidate (findings or triage) from a native
// agent-CLI result envelope when structured-output enforcement is imperfect or absent. Rung order
// is a fixed priority: --agent-file > structured_output > pure-JSON result > fenced code blocks.
// The first rung producing exactly one distinct schema-validating candidate wins (fenced-block
// candidates are deduplicated by canonical value first — an exact duplicate is not a conflict); an
// error envelope (the agent run did not complete) short-circuits before any rung runs. See
// docs/adapters.md "Extraction ladder" for the security rationale (exactly-one-distinct-validating
// defeats block-injection).
//
// Candidate gate: ajv (via validateAgainstSchema, additionalProperties:false) rejects shape and
// injection attempts; the registry's io-ts codec (via resolve) then materializes the value,
// additionally enforcing invariants ajv cannot express (e.g. end_line >= start_line). A candidate
// must pass both to count as "validating".

import { readFileOrNull } from "./util.js";
import { resolve, schemaPathFor, defaultVersion } from "./registry.js";
import { validateAgainstSchema } from "./validate.js";

export type ExtractKind = "findings" | "triage";

export interface ExtractInput {
  readonly kind: ExtractKind;
  readonly native: unknown;
  /** Path to a file the agent was told to write its own validated JSON to (findings only — a
   *  documented no-op for triage, per the rung order's "agent-file wins" test). */
  readonly agentFilePath?: string;
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

/** is_error===true OR (subtype not null/undefined and != "success") OR api_error_status not null/undefined. */
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

/** Default `schema_version` onto a findings candidate when the agent omitted it; identity for triage. */
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
  /** The survivor after `schema_version` injection, pre-registry-normalize (identical for alpha) —
   *  what the extract CLI prints, per the registry seam ruling. */
  readonly candidate: unknown;
}

/** Recursively sort object keys so two values that differ only in key order canonicalize equal. */
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

/** Collapse gated candidates that are exact duplicates once canonicalized — a model re-emitting its
 *  answer verbatim is a plausible benign case, not a conflict. Two candidates that differ in any
 *  value still remain distinct, so the injection defense (refusing to pick a survivor among
 *  disagreeing candidates) is unweakened. */
const dedupCandidates = (candidates: readonly GatedCandidate[]): readonly GatedCandidate[] => {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = JSON.stringify(canonicalize(c.candidate));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Gate a raw candidate through ajv (shape + injection defense) then the registry's io-ts codec
 *  (materialization + cross-field invariants); null when either gate rejects it. */
const gateCandidate = (kind: ExtractKind, rawCandidate: unknown): GatedCandidate | null => {
  const candidate = normalizeCandidate(kind, rawCandidate);
  const schemaPath = safeSchemaPathFor(kind, candidateVersion(kind, candidate));
  if (schemaPath === null) return null;
  if (!validateAgainstSchema(candidate, schemaPath).valid) return null;
  const resolution = resolve(kind, candidate);
  return resolution.kind === "ok" ? { version: resolution.version, candidate } : null;
};

type ParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const tryParseJson = (text: string): ParseResult => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
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

/** Fold one line into the fence-scan state. Opens on a line whose first non-whitespace run is
 *  >=3 backticks (the rest of the line — an info string like "json" — is ignored); closes on the
 *  next line that, trimmed, is only backticks of length >= the opening fence. Line-based by
 *  design — no regex spans more than one line, so there is no catastrophic-backtracking surface. */
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

/** Extract fenced code-block contents from `text` (both ` ```json ` and bare ` ``` `); text before,
 *  between, and after fences (and an unterminated trailing fence) is discarded. */
export const scanFencedBlocks = (text: string): readonly string[] =>
  text.split("\n").reduce(scanLine, { blocks: [], openLength: null, buffer: [] }).blocks;

/** Operator-facing breakdown of what each rung actually saw when recovery fails — for stderr/logs,
 *  never for the fail-closed reasons (which stay generic). Turns an opaque "no candidate" into an
 *  actionable trace: a null structured_output points at a CLI not enforcing `--json-schema`. */
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

/** Render a non-"ok" ladder outcome as a single human-readable message. */
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

/** Run the extraction ladder. Pure aside from an optional `--agent-file` read. */
export const extractStructured = (input: ExtractInput): LadderOutcome => {
  const native = parseNativeForExtraction(input.native);

  if (isErrorEnvelope(native)) {
    return { kind: "error-envelope", detail: describeErrorEnvelope(native) };
  }

  if (input.kind === "findings" && input.agentFilePath !== undefined) {
    const fromFile = candidateFromJsonText(input.kind, readFileOrNull(input.agentFilePath));
    if (fromFile) return okOutcome(fromFile);
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

  return {
    kind: "none",
    detail: `no --agent-file, structured_output, JSON result, or fenced block validated against the ${input.kind} schema`,
  };
};
