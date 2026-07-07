// Pure patch helpers (issue #10): a review agent's own unified-diff patch of an edit it actually
// made is either validated against the real PR-head file (to align a finding's range and confirm it
// still applies) or projected into a GitHub suggestion's replacement text — two concerns split into
// two pure functions over one shared hunk parser (SSOT). Eliminates the bad-suggestion bug class
// caused by hand-authored suggestions with wrong indentation or too-wide ranges. Assumes LF line
// endings (the review runs on Linux); CRLF handling is out of scope.

/** The file-anchored range a patch's removed lines occupy — what a suggestion replaces. */
export type ValidateResult =
  | { readonly startLine: number; readonly endLine: number }
  | { readonly kind: "drop"; readonly reason: string };

/** The replacement text a patch's added lines carry — a suggestion's body. */
export type SuggestionResult = string | { readonly kind: "drop"; readonly reason: string };

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

const drop = (reason: string): { readonly kind: "drop"; readonly reason: string } => ({
  kind: "drop",
  reason,
});

type ParsedHunk =
  | { readonly kind: "ok"; readonly oldStart: number; readonly body: readonly BodyLine[] }
  | { readonly kind: "drop"; readonly reason: string };

/** Parse a single-hunk unified diff into its old-side start line + classified body — the SSOT both
 *  `validatePatch` and `patchToSuggestion` share. Drops on !=1 hunk or a malformed body line. */
const parseHunk = (patch: string): ParsedHunk => {
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

  return { kind: "ok", oldStart: hit.oldStart, body };
};

/** The issue-#10 guard: confirm a single-hunk unified diff still applies to the PR-head file
 *  (`fileLines`, 0-indexed lines WITHOUT trailing newlines) and return the exact
 *  `start_line..end_line` its removed lines occupy — for aligning the finding's range. Drops on a
 *  context mismatch, a non-contiguous change, or a change with no removed lines to anchor. Pure. */
export const validatePatch = (patch: string, fileLines: readonly string[]): ValidateResult => {
  const parsed = parseHunk(patch);
  if (parsed.kind === "drop") return parsed;
  const { oldStart, body } = parsed;

  const oldSideTexts = body.filter((l) => l.kind !== "added").map((l) => l.text);
  const expected = fileLines.slice(oldStart - 1, oldStart - 1 + oldSideTexts.length);
  const oldSideMatches =
    expected.length === oldSideTexts.length &&
    expected.every((line, i) => line === oldSideTexts[i]);
  if (!oldSideMatches) {
    return drop(
      `patch context does not match the file at lines ${String(oldStart)}..${String(oldStart + oldSideTexts.length - 1)}`,
    );
  }

  if (!isContiguousChange(trimmedMiddle(body))) {
    return drop("change is not a single contiguous block");
  }

  const removedCount = body.filter((l) => l.kind === "removed").length;
  const addedCount = body.filter((l) => l.kind === "added").length;
  if (removedCount === 0 && addedCount === 0) return drop("hunk contains no changes");
  if (removedCount === 0) return drop("pure insertion has no range to anchor a suggestion");

  const { firstRemoved, lastRemoved } = removedRange(body, oldStart);
  if (firstRemoved === null || lastRemoved === null) return drop("malformed hunk body");

  return { startLine: firstRemoved, endLine: lastRemoved };
};

/** Project a single-hunk unified diff into a GitHub suggestion's replacement text (the added lines
 *  alone) — no file needed. Drops a multi-hunk/malformed patch, a non-contiguous change, or a pure
 *  insertion (nothing to replace). An all-deletion hunk yields "" (delete the range). Pure. */
export const patchToSuggestion = (patch: string): SuggestionResult => {
  const parsed = parseHunk(patch);
  if (parsed.kind === "drop") return parsed;
  const { body } = parsed;

  if (!isContiguousChange(trimmedMiddle(body))) {
    return drop("change is not a single contiguous block");
  }

  const removedCount = body.filter((l) => l.kind === "removed").length;
  const addedLines = body.filter((l) => l.kind === "added");
  if (removedCount === 0 && addedLines.length === 0) return drop("hunk contains no changes");
  if (removedCount === 0) return drop("pure insertion can't be expressed as a suggestion");

  return addedLines.map((l) => l.text).join("\n");
};
