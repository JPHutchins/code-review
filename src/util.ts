import { readFileSync } from "node:fs";

export const asRecord = (u: unknown): Record<string, unknown> | null =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : null;

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

import type { ModelUsageEntry } from "./schema.js";

// A GitHub Actions workflow command (`::warning::…`) is single-line: a CR/LF in the message ends the
// annotation early, and a following `::…::` in the remainder would be parsed as another command.
// Collapse line breaks so an untrusted interpolation (e.g. `gh` stderr) can't break out of one.
export const annotationSafe = (msg: string): string => msg.replaceAll(/[\r\n]+/g, " ");

// A caller declares a model's real context window to the agent CLI by suffixing the id it configures
// (`deepseek-v4-pro[1m]`). The CLI strips that before the request and it is absent from the price
// map, so it is a directive rather than part of the model's identity — but the CLI does key its own
// usage telemetry by the configured id. Every ingress that reads a model id from the agent
// canonicalizes it here: carried through, it misses the price map, prices the run at $0, and voids
// the spend clamp that steers off those same entries.
// The context-window suffix grammar — ONE definition, consumed by the canonicalizer, the
// context-window guard, and the cost ingresses. UNANCHORED on purpose, matching the agent CLI's
// own resolver (the CLI grants the 1M window wherever the suffix appears, so the canonicalizer
// must strip wherever it appears). NON-global: a stateful /g in a .test() alternates true/false
// across calls; the canonicalizer re-flags it (issue #209).
export const CONTEXT_SUFFIX_RE = /\[[12]m\]/i;
// The canonicalizer's global form, DERIVED from the shared source — one grammar, one literal
// (a global regex in .test() would alternate on its stateful lastIndex, hence the two objects).
const MODEL_IDENTITY_SUFFIX_RE = new RegExp(CONTEXT_SUFFIX_RE.source, "gi");
// The 1M-WINDOW declaration pattern, the agent CLI's documented grant (/\[1m\]/i): the guard
// polices THIS suffix specifically — a [2m] suffix is canonicalized but never claims the 1M
// window the declaration test exists to protect (issue #209 review r2).
export const ONE_M_SUFFIX_RE = /\[[1]m\]/i;
export const modelIdentity = (configuredModelId: string): string =>
  configuredModelId.replace(MODEL_IDENTITY_SUFFIX_RE, "");

// The per-model accumulation adapt's fold uses (issue #209): the cache fields take the always-0
// convention the transcript fold's entries carry, so FOLDED rows cannot drift on absent-vs-0.
// (The transcript fold accumulates its own Totals shape; the shared convention covers the folded
// path.) The spread keeps any field ModelUsageEntry gains.
export const addModelUsage = (prior: ModelUsageEntry, entry: ModelUsageEntry): ModelUsageEntry => ({
  ...prior,
  input_tokens: prior.input_tokens + entry.input_tokens,
  output_tokens: prior.output_tokens + entry.output_tokens,
  cache_read_tokens: (prior.cache_read_tokens ?? 0) + (entry.cache_read_tokens ?? 0),
  cache_write_tokens: (prior.cache_write_tokens ?? 0) + (entry.cache_write_tokens ?? 0),
});

export type ParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

// Clip a body to `max` chars without splitting a code point (a lone high surrogate at the cut is
// dropped so the kept prefix stays well-formed UTF-16).
export const clipText = (body: string, max: number): string => {
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${safe}\n… [truncated]`;
};

// The shared clip cap for bodies that travel whole: gather clips each conversation body to it, and
// render clips each carried suppressed-nit field to it. One constant so the two caps cannot drift
// (the carried clip must match the conversation clip the seeded agent already saw, issue #217
// review r7).
export const BODY_CLIP_CHARS = 4000;

export const tryParseJson = (text: string): ParseResult => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

export const readFileOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
};
