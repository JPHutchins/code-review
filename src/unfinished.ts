// The unfinished checks a review draft names, carried onto its decoded document whatever the decode
// kept: a codec that predates the field, or a recovery that dropped a malformed list, never turns a
// round that named unfinished checks into a clean review.

import type { Findings } from "./schema.js";

export const UNREADABLE_UNFINISHED_ENTRY = "unreadable entries in the unfinished-checks list";

const isReadableCheck = (entry: unknown): entry is string =>
  typeof entry === "string" && entry.trim().length > 0;

const entriesOf = (named: unknown): readonly unknown[] => (Array.isArray(named) ? named : [named]);

export const readableUnfinishedChecks = (named: unknown): readonly string[] =>
  entriesOf(named).filter(
    (entry): entry is string => isReadableCheck(entry) && entry !== UNREADABLE_UNFINISHED_ENTRY,
  );

export const unfinishedNamedBy = (named: unknown): readonly string[] =>
  ((readable: readonly string[]) =>
    readable.length === entriesOf(named).length
      ? readable
      : [UNREADABLE_UNFINISHED_ENTRY, ...readable])(readableUnfinishedChecks(named));

const withoutUnfinished = ({ unfinished: _dropped, ...findings }: Findings): Findings => findings;

export const withDraftUnfinished = (
  draft: unknown,
  findings: Findings,
  checksNamedBy: (named: unknown) => readonly string[] = unfinishedNamedBy,
): Findings =>
  typeof draft === "object" && draft !== null && Object.hasOwn(draft, "unfinished")
    ? ((checks: readonly string[]) =>
        checks.length > 0 ? { ...findings, unfinished: [...checks] } : withoutUnfinished(findings))(
        checksNamedBy((draft as { readonly unfinished: unknown }).unfinished),
      )
    : findings;
