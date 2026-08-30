import { readFileSync } from "node:fs";

export const asRecord = (u: unknown): Record<string, unknown> | null =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : null;

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
export const modelIdentity = (configuredModelId: string): string =>
  configuredModelId.replace(/\[[12]m\]$/i, "");

export type ParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

// Clip a body to `max` chars without splitting a code point (a lone high surrogate at the cut is
// dropped so the kept prefix stays well-formed UTF-16). Shared by gather's conversation bodies and
// the answered-registry reply excerpts.
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
