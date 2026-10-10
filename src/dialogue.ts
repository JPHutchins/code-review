// The review dialogue's carried state: the ids whose answer the reviewer rebutted, those a
// maintainer answered again after the rebuttal (contested), and those a maintainer overruled. Every answer is re-read each round, so
// an entry holds only what the answers cannot say again: which answer the reviewer rebutted, and
// the claim's title and severity for the rounds the reviewer does not re-raise it. An answer is
// known by its creation instant: an edited comment keeps it, and so does a rebased commit, whose
// URL changes with its SHA.

import * as t from "io-ts";
import { isRight } from "fp-ts/lib/Either.js";
import { SeverityCodec } from "./schema.js";
import type { Severity } from "./schema.js";
import { newestTrustedAnswersIn } from "./responses.js";
import type { Response } from "./responses.js";
import type { ResponseDisposition } from "./response-grammar.js";

const DialogueEntryCodec = t.type({
  id: t.string,
  state: t.keyof({ rebutted: null, contested: null, upheld: null, overruled: null }),
  answer: t.string,
  at: t.string,
  title: t.string,
  severity: SeverityCodec,
});

export type DialogueEntry = t.TypeOf<typeof DialogueEntryCodec>;

export const DIALOGUE_ENTRY_CAP = 32;

export interface DecodedDialogue {
  readonly entries: readonly DialogueEntry[];
  // The entries this version cannot read — a newer version's state, or damage — carried back out
  // verbatim so a rewrite never erases them.
  readonly undecoded: readonly unknown[];
  readonly skipped: number;
}

// Each entry decodes alone: a malformed one is skipped and counted, never the whole state.
export const decodeDialogue = (raw: unknown): DecodedDialogue => {
  const items: readonly unknown[] = Array.isArray(raw) ? raw : [];
  const decoded = items.map((item) => ({ item, entry: DialogueEntryCodec.decode(item) }));
  const entries = decoded.flatMap(({ entry }) => (isRight(entry) ? [entry.right] : []));
  const undecoded = decoded.flatMap(({ item, entry }) => (isRight(entry) ? [] : [item]));
  return { entries, undecoded, skipped: Array.isArray(raw) ? undecoded.length : 1 };
};

// What this round reported under an id, before any answered filter.
export interface DialogueItem {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly rebutted: boolean;
}

// The PR's answers as the state machine reads them: per id, the newest trusted answer, sorted by
// what it says.
export interface DialogueAnswers {
  readonly closures: ReadonlyMap<string, Response>;
  readonly overrulings: ReadonlyMap<string, Response>;
  readonly upholdings: ReadonlyMap<string, Response>;
  readonly fixed: ReadonlySet<string>;
}

export const dialogueAnswers = (
  responses: readonly Response[],
  isTrusted: (response: Response) => boolean,
): DialogueAnswers => {
  const newest = (dispositions: readonly ResponseDisposition[]): ReadonlyMap<string, Response> =>
    new Map(
      newestTrustedAnswersIn(responses, isTrusted, new Set(dispositions)).map((response) => [
        response.id,
        response,
      ]),
    );
  return {
    closures: newest(["refuted", "dismissed"]),
    overrulings: newest(["overruled"]),
    upholdings: newest(["upheld"]),
    fixed: new Set(newest(["fixed"]).keys()),
  };
};

const linked = (
  entry: DialogueEntry,
  answer: Response,
  state: DialogueEntry["state"],
): readonly DialogueEntry[] =>
  answer.created_at === null
    ? [entry]
    : [{ ...entry, state, answer: answer.source_url, at: answer.created_at }];

const isNewer = (answer: Response, entry: DialogueEntry): boolean =>
  answer.created_at !== null && Date.parse(answer.created_at) > Date.parse(entry.at);

const isOlder = (answer: Response, entry: DialogueEntry): boolean =>
  answer.created_at !== null && Date.parse(answer.created_at) < Date.parse(entry.at);

const advanceEntry = (
  entry: DialogueEntry,
  answers: DialogueAnswers,
  item: DialogueItem | undefined,
): readonly DialogueEntry[] => {
  if (answers.fixed.has(entry.id)) return [];
  const refreshed =
    item !== undefined && (entry.state === "contested" || item.rebutted)
      ? { ...entry, title: item.title, severity: item.severity }
      : entry;
  const closure = answers.closures.get(entry.id);
  switch (entry.state) {
    case "rebutted":
      return closure === undefined
        ? [refreshed]
        : linked(refreshed, closure, isNewer(closure, entry) ? "contested" : "rebutted");
    case "contested": {
      const overruling = answers.overrulings.get(entry.id);
      const upholding = answers.upholdings.get(entry.id);
      return upholding !== undefined
        ? linked(refreshed, upholding, "upheld")
        : overruling !== undefined
          ? linked(refreshed, overruling, "overruled")
          : closure === undefined
            ? [refreshed]
            : linked(refreshed, closure, isOlder(closure, entry) ? "rebutted" : "contested");
    }
    case "upheld": {
      const overruling = answers.overrulings.get(entry.id);
      return overruling !== undefined && isNewer(overruling, entry)
        ? linked(refreshed, overruling, "overruled")
        : [refreshed];
    }
    case "overruled": {
      const upholding = answers.upholdings.get(entry.id);
      return upholding !== undefined && isNewer(upholding, entry)
        ? linked(refreshed, upholding, "upheld")
        : [refreshed];
    }
  }
};

// One round of the state machine. A newest trusted `fixed` clears any entry. A rebutted entry
// becomes contested when the id's newest trusted closing answer is newer than the one the reviewer
// rebutted; an older one means that answer is gone, and the entry stays rebutted against the answer
// still standing. A contested entry whose contesting answer is gone falls back to rebutted the same
// way. A maintainer's ruling settles a contested entry: `upheld` keeps the finding open whatever
// older answer would close it, and `overruled` closes it. An id the reviewer re-raised with a
// rebuttal against a trusted closing answer opens as rebutted. Every entry links the newest answer
// that moved it, and a newer opposite ruling re-settles a ruled one. A re-raise the dialogue keeps —
// a contested one, or one carrying a rebuttal — refreshes its title and severity. The cap trims only
// rebutted entries: a contested or ruled one holds a maintainer's answer the PR still owes.
export const advanceDialogue = (
  prior: readonly DialogueEntry[],
  answers: DialogueAnswers,
  current: readonly DialogueItem[],
): readonly DialogueEntry[] => {
  const currentById = new Map(current.map((item) => [item.id, item]));
  const priorIds = new Set(prior.map((entry) => entry.id));
  const opened = [...currentById.values()].flatMap((item): readonly DialogueEntry[] => {
    const closure = answers.closures.get(item.id);
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
  const entries = [
    ...prior.flatMap((entry) => advanceEntry(entry, answers, currentById.get(entry.id))),
    ...opened,
  ];
  const held = entries.filter((entry) => entry.state !== "rebutted");
  return [
    ...held,
    ...entries
      .filter((entry) => entry.state === "rebutted")
      .slice(0, Math.max(0, DIALOGUE_ENTRY_CAP - held.length)),
  ];
};
