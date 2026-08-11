import { readFileSync } from "node:fs";

export const asRecord = (u: unknown): Record<string, unknown> | null =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : null;

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A GitHub Actions workflow command (`::warning::…`) is single-line: a CR/LF in the message ends the
// annotation early, and a following `::…::` in the remainder would be parsed as another command.
// Collapse line breaks so an untrusted interpolation (e.g. `gh` stderr) can't break out of one.
export const annotationSafe = (msg: string): string => msg.replaceAll(/[\r\n]+/g, " ");

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
