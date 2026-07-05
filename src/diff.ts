// Pure functions for unified-diff parsing and line-in-diff validation.
// Uses parse-diff for parsing; exports only clean functional interfaces.

import parseDiff from "parse-diff";
import type { Finding, Side } from "./schema.js";

// A set of "path:line" keys present in the diff hunks (additions/changes).
// Used to validate findings before posting inline comments.
export type DiffLineIndex = ReadonlySet<string>;

const key = (path: string, line: number): string => `${path}:${String(line)}`;

/** Index a set of changes under a given file path. */
const indexChanges = (
  keys: Set<string>,
  fpath: string,
  changes: ReadonlyArray<{
    readonly type: "normal" | "add" | "del";
    readonly ln1?: number;
    readonly ln2?: number;
    readonly ln?: number;
  }>,
): void => {
  for (const change of changes) {
    if (change.type === "normal") {
      if (change.ln1 !== undefined) keys.add(key(fpath, change.ln1));
      if (change.ln2 !== undefined) keys.add(key(fpath, change.ln2));
    } else if (change.ln !== undefined) {
      keys.add(key(fpath, change.ln));
    }
  }
};

/** Parse a unified diff string into a set of "path:line" keys for every line in the diff.
 *  For renamed files, both old and new paths are indexed so findings on either path match. */
export const indexDiff = (diff: string): DiffLineIndex => {
  const files = parseDiff(diff);
  if (!Array.isArray(files)) return new Set();

  const keys = new Set<string>();
  for (const file of files) {
    // Deleted: file.to is /dev/null, use file.from
    // New: file.from is undefined, use file.to
    // Modified: both set and equal
    // Renamed: both set and differ → index both paths
    const primary = file.from ?? file.to;
    if (!primary) continue;

    indexChanges(
      keys,
      primary,
      file.chunks.flatMap((c) => c.changes),
    );

    // Also index under file.to for renames (when both paths exist and differ)
    if (file.to && file.to !== "/dev/null" && file.to !== primary) {
      indexChanges(
        keys,
        file.to,
        file.chunks.flatMap((c) => c.changes),
      );
    }
  }
  return keys;
};

/** Check whether a finding's anchor line appears in the diff. */
export const isInDiff = (index: DiffLineIndex, path: string, line: number): boolean =>
  index.has(key(path, line));

/** True for a diff with no content or no hunks — nothing to review or anchor inline comments to. */
export const isEmptyDiff = (diff: string): boolean => {
  if (diff.trim().length === 0) return true;
  const files = parseDiff(diff);
  return !Array.isArray(files) || files.length === 0 || files.every((f) => f.chunks.length === 0);
};

/** Default side for inline comments: RIGHT for additions, LEFT for deletions. */
export const defaultSide = (side: string | undefined): Side => (side === "LEFT" ? "LEFT" : "RIGHT");

/** Partition findings into in-diff and out-of-diff (strays). Strays get demoted to the summary. */
export const partitionFindings = (
  findings: readonly Finding[],
  index: DiffLineIndex,
): {
  readonly inDiff: readonly Finding[];
  readonly strays: readonly Finding[];
} => {
  const inDiff: Finding[] = [];
  const strays: Finding[] = [];
  for (const f of findings) {
    if (isInDiff(index, f.path, f.start_line) && isInDiff(index, f.path, f.end_line)) {
      inDiff.push(f);
    } else {
      strays.push(f);
    }
  }
  return { inDiff, strays };
};
