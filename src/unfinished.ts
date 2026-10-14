// The unfinished checks a review draft names, carried onto its decoded document whatever the decode
// kept: a codec that predates the field, or a recovery that dropped a malformed list, never turns a
// round that named unfinished checks into a clean review.

import type { Findings } from "./schema.js";

export const UNREADABLE_UNFINISHED_ENTRY = "unreadable entries in the unfinished-checks list";

const isReadableCheck = (entry: unknown): entry is string =>
  typeof entry === "string" && entry.trim().length > 0;

export const readableUnfinishedChecks = (named: unknown): readonly string[] =>
  (Array.isArray(named) ? named : [named]).filter(isReadableCheck);

export const unfinishedNamedBy = (named: unknown): readonly string[] =>
  ((entries: readonly unknown[]) =>
    entries.every(isReadableCheck)
      ? entries
      : [
          UNREADABLE_UNFINISHED_ENTRY,
          ...readableUnfinishedChecks(entries).filter(
            (check) => check !== UNREADABLE_UNFINISHED_ENTRY,
          ),
        ])(Array.isArray(named) ? named : [named]);

export const withDraftUnfinished = (
  draft: unknown,
  findings: Findings,
  checksNamedBy: (named: unknown) => readonly string[] = unfinishedNamedBy,
): Findings =>
  typeof draft === "object" && draft !== null && Object.hasOwn(draft, "unfinished")
    ? {
        ...findings,
        unfinished: [...checksNamedBy((draft as { readonly unfinished: unknown }).unfinished)],
      }
    : findings;
