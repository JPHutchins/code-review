// The review dialogue's carried state: the ids whose answer the reviewer rebutted, and those a
// maintainer answered again after the rebuttal (contested). Every answer is re-read each round, so
// an entry holds only what the answers cannot say again: which answer the reviewer rebutted, and
// the claim's title and severity for the rounds the reviewer does not re-raise it. An answer is
// known by its creation instant: an edited comment keeps it, and so does a rebased commit, whose
// URL changes with its SHA.

import * as t from "io-ts";
import { isRight } from "fp-ts/lib/Either.js";
import { SeverityCodec } from "./schema.js";
import type { Severity } from "./schema.js";
import type { Response } from "./responses.js";

const DialogueEntryCodec = t.type({
  id: t.string,
  state: t.keyof({ rebutted: null, contested: null }),
  answer: t.string,
  at: t.string,
  title: t.string,
  severity: SeverityCodec,
});

export type DialogueEntry = t.TypeOf<typeof DialogueEntryCodec>;

export const DIALOGUE_ENTRY_CAP = 32;

export interface DecodedDialogue {
  readonly entries: readonly DialogueEntry[];
  readonly skipped: number;
}

// Each entry decodes alone: a malformed one is skipped and counted, never the whole state.
export const decodeDialogue = (raw: unknown): DecodedDialogue => {
  const items: readonly unknown[] = Array.isArray(raw) ? raw : [];
  const entries = items.flatMap((item) => {
    const decoded = DialogueEntryCodec.decode(item);
    return isRight(decoded) ? [decoded.right] : [];
  });
  return { entries, skipped: Array.isArray(raw) ? items.length - entries.length : 1 };
};

// What this round reported under an id, before any answered filter.
export interface DialogueItem {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly rebutted: boolean;
}

// One round of the state machine. A newest trusted `fixed` clears an entry. A rebutted entry
// becomes contested when the id's newest trusted closing answer is newer than the one the reviewer
// rebutted; an older one means that answer is gone, and the entry stays rebutted against the answer
// still standing. An id the reviewer re-raised with a rebuttal against a trusted closing answer
// opens as rebutted. Every entry links the newest closing answer, and a re-raise refreshes its
// title and severity. Contested entries keep their place ahead of rebutted ones under the cap.
export const advanceDialogue = (
  prior: readonly DialogueEntry[],
  closures: readonly Response[],
  fixedIds: ReadonlySet<string>,
  current: readonly DialogueItem[],
): readonly DialogueEntry[] => {
  const closureById = new Map(closures.map((closure) => [closure.id, closure]));
  const currentById = new Map(current.map((item) => [item.id, item]));
  const advanced = prior.flatMap((entry): readonly DialogueEntry[] => {
    const item = currentById.get(entry.id);
    const refreshed =
      item === undefined ? entry : { ...entry, title: item.title, severity: item.severity };
    const closure = closureById.get(entry.id);
    const at = closure?.created_at ?? null;
    return fixedIds.has(entry.id)
      ? []
      : closure === undefined || at === null
        ? [refreshed]
        : [
            {
              ...refreshed,
              state:
                entry.state === "rebutted" && Date.parse(at) > Date.parse(entry.at)
                  ? "contested"
                  : entry.state,
              answer: closure.source_url,
              at,
            },
          ];
  });
  const priorIds = new Set(prior.map((entry) => entry.id));
  const opened = [...currentById.values()].flatMap((item): readonly DialogueEntry[] => {
    const closure = closureById.get(item.id);
    const at = closure?.created_at ?? null;
    return priorIds.has(item.id) || !item.rebutted || closure === undefined || at === null
      ? []
      : [
          {
            id: item.id,
            state: "rebutted",
            answer: closure.source_url,
            at,
            title: item.title,
            severity: item.severity,
          },
        ];
  });
  const entries = [...advanced, ...opened];
  return [
    ...entries.filter((entry) => entry.state === "contested"),
    ...entries.filter((entry) => entry.state === "rebutted"),
  ].slice(0, DIALOGUE_ENTRY_CAP);
};
