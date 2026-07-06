// Pure lowerer for the patch→suggestion pipeline (issue #10): a review agent's own unified-diff
// patch of an edit it actually made is validated against the real PR-head file and turned into an
// exact GitHub suggestion range + replacement text, or dropped — eliminating the bad-suggestion bug
// class caused by hand-authored suggestions with wrong indentation or too-wide ranges. Assumes LF
// line endings (the review runs on Linux); CRLF handling is out of scope.

export type LowerResult =
  | {
      readonly kind: "ok";
      readonly startLine: number;
      readonly endLine: number;
      readonly suggestion: string;
    }
  | { readonly kind: "drop"; readonly reason: string };

type BodyLine =
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "removed"; readonly text: string }
  | { readonly kind: "added"; readonly text: string };

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** The hunk's `-a` value when `line` is a hunk header, else null. */
const hunkOldStart = (line: string): number | null => {
  const raw = HUNK_HEADER_RE.exec(line)?.[1];
  return raw !== undefined ? Number(raw) : null;
};

/** Classify one hunk-body line by its leading marker char, stripping it; null when the line
 *  carries none of the three markers (malformed). */
const classifyBodyLine = (line: string): BodyLine | null => {
  if (line.startsWith(" ")) return { kind: "context", text: line.slice(1) };
  if (line.startsWith("-")) return { kind: "removed", text: line.slice(1) };
  if (line.startsWith("+")) return { kind: "added", text: line.slice(1) };
  return null;
};

/** The maximal run of non-context lines in the middle of `body`, once leading and trailing context
 *  is trimmed — empty when `body` is all context (no change at all). */
const trimmedMiddle = (body: readonly BodyLine[]): readonly BodyLine[] => {
  const first = body.findIndex((l) => l.kind !== "context");
  if (first === -1) return [];
  const last = body.findLastIndex((l) => l.kind !== "context");
  return body.slice(first, last + 1);
};

/** True when `middle` (already trimmed of outer context) is zero-or-more removed lines followed by
 *  zero-or-more added lines, with no context and no interleaving between them. */
const isContiguousChange = (middle: readonly BodyLine[]): boolean => {
  if (middle.some((l) => l.kind === "context")) return false;
  const firstAdded = middle.findIndex((l) => l.kind === "added");
  if (firstAdded === -1) return true;
  return (
    middle.slice(0, firstAdded).every((l) => l.kind === "removed") &&
    middle.slice(firstAdded).every((l) => l.kind === "added")
  );
};

interface RemovedRange {
  readonly lineNumber: number;
  readonly firstRemoved: number | null;
  readonly lastRemoved: number | null;
}

/** Fold over the hunk body tracking the old-side line number (advanced by context and removed
 *  lines, not by added lines), recording the first and last removed line's number. */
const removedRange = (body: readonly BodyLine[], oldStart: number): RemovedRange =>
  body.reduce<RemovedRange>(
    (acc, line) =>
      line.kind === "added"
        ? acc
        : {
            lineNumber: acc.lineNumber + 1,
            firstRemoved:
              line.kind === "removed" && acc.firstRemoved === null
                ? acc.lineNumber
                : acc.firstRemoved,
            lastRemoved: line.kind === "removed" ? acc.lineNumber : acc.lastRemoved,
          },
    { lineNumber: oldStart, firstRemoved: null, lastRemoved: null },
  );

const drop = (reason: string): LowerResult => ({ kind: "drop", reason });

/** Lower a single-hunk unified diff (against the PR-head file, whose lines are `fileLines`,
 *  0-indexed array of the file's lines WITHOUT trailing newlines) into an exact GitHub suggestion
 *  range + replacement text, or drop it. Pure. */
export const lowerPatch = (patch: string, fileLines: readonly string[]): LowerResult => {
  const rawLines = patch.split("\n");
  // A trailing newline in the patch text splits into a trailing "" element — not a line of content.
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;

  const headerHits = lines.reduce<readonly { readonly index: number; readonly oldStart: number }[]>(
    (acc, line, index) => {
      const oldStart = hunkOldStart(line);
      return oldStart !== null ? [...acc, { index, oldStart }] : acc;
    },
    [],
  );
  if (headerHits.length !== 1) {
    return drop(`expected exactly one hunk, got ${String(headerHits.length)}`);
  }
  const hit = headerHits[0];
  if (hit === undefined) return drop("malformed hunk header");

  // Header-preceding lines (diff --git/index/---/+++) are never examined — the hunk body starts
  // right after the header; a trailing "\ No newline at end of file" marker carries no content.
  const bodyRaw = lines.slice(hit.index + 1).filter((line) => !line.startsWith("\\"));
  const classified = bodyRaw.map(classifyBodyLine);
  if (classified.some((line) => line === null)) return drop("malformed hunk body line");
  const body = classified.filter((line): line is BodyLine => line !== null);

  const oldSideTexts = body.filter((l) => l.kind !== "added").map((l) => l.text);
  const expected = fileLines.slice(hit.oldStart - 1, hit.oldStart - 1 + oldSideTexts.length);
  const oldSideMatches =
    expected.length === oldSideTexts.length &&
    expected.every((line, i) => line === oldSideTexts[i]);
  if (!oldSideMatches) {
    return drop(
      `patch context does not match the file at lines ${String(hit.oldStart)}..${String(hit.oldStart + oldSideTexts.length - 1)}`,
    );
  }

  if (!isContiguousChange(trimmedMiddle(body))) {
    return drop("change is not a single contiguous block");
  }

  const removedCount = body.filter((l) => l.kind === "removed").length;
  const addedLines = body.filter((l) => l.kind === "added");
  if (removedCount === 0 && addedLines.length === 0) return drop("hunk contains no changes");
  if (removedCount === 0) return drop("pure insertion can't be expressed as a suggestion");

  const { firstRemoved, lastRemoved } = removedRange(body, hit.oldStart);
  if (firstRemoved === null || lastRemoved === null) return drop("malformed hunk body");

  return {
    kind: "ok",
    startLine: firstRemoved,
    endLine: lastRemoved,
    suggestion: addedLines.map((l) => l.text).join("\n"),
  };
};
