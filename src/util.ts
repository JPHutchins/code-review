import { readFileSync } from "node:fs";

export const asRecord = (u: unknown): Record<string, unknown> | null =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : null;

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type ParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

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
