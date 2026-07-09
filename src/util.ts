// Small shared helpers, extracted to keep a single definition instead of per-module copies.

import { readFileSync } from "node:fs";

/** Narrow an unknown to a plain object — not null, not an array — or null. */
export const asRecord = (u: unknown): Record<string, unknown> | null =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : null;

/** Read a file as UTF-8 text, or null if it cannot be read. Never throws. */
export const readFileOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
};
