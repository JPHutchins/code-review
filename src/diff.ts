import parseDiff from "parse-diff";
import type { Finding, Side } from "./schema.js";

export type DiffLineIndex = ReadonlySet<string>;

const key = (path: string, line: number): string => `${path}:${String(line)}`;

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

// For renamed files, both old and new paths are indexed so a finding on either matches.
export const indexDiff = (diff: string): DiffLineIndex => {
  const files = parseDiff(diff);
  if (!Array.isArray(files)) return new Set();

  const keys = new Set<string>();
  for (const file of files) {
    // from ?? to covers deleted (to=/dev/null), new (from undefined), and modified; a rename differs
    // and is indexed under both paths.
    const primary = file.from ?? file.to;
    if (!primary) continue;

    indexChanges(
      keys,
      primary,
      file.chunks.flatMap((c) => c.changes),
    );

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

export const isInDiff = (index: DiffLineIndex, path: string, line: number): boolean =>
  index.has(key(path, line));

export const isEmptyDiff = (diff: string): boolean => {
  if (diff.trim().length === 0) return true;
  const files = parseDiff(diff);
  return !Array.isArray(files) || files.length === 0 || files.every((f) => f.chunks.length === 0);
};

export const defaultSide = (side: string | undefined): Side => (side === "LEFT" ? "LEFT" : "RIGHT");

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
