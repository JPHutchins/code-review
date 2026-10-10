// The "already answered" state (issue #151): the deterministic registry of prior findings a
// maintainer's answer refuted or dismissed, plus the rule built on it — post() treats a VERBATIM
// re-raise as closed: identical match (id), identical claim TEXT (title + description + reasoning),
// identical severity, and identical location/fix (path + patch — the line is deliberately excluded,
// positional drift is not evidence), i.e. no new evidence by definition. A re-raise carrying a
// non-blank rebuttal answers the prior response, so it is never verbatim. The drop is removed from
// the surfaced review and NAMED in the sticky; a re-raise with any changed component is kept and
// annotated with the prior answer's link.

import { escapeCodeBackticks, linkSafeUrl } from "./surface.js";
import {
  isSynthesizedFindingId,
  resolveFindingId,
  resolveSystemicId,
  hasRebuttal,
} from "./schema.js";
import type { Finding, Findings, Severity, SystemicProblem } from "./schema.js";
import type { Response } from "./responses.js";

// The registry entry for one answered finding: the finding's identifying fields (the verbatim-match
// targets) and the answer that closed it.
export interface AnsweredEntry {
  // The answered finding's id; a pre-id prior finding resolves it the same way the registry's legacy
  // upcast does (code → id, else synthesized), so the entry keys to the identical claim next round.
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly reasoning: string;
  // The answered finding's severity — a re-raise ESCALATED in severity is not verbatim (the claim
  // weight changed), so it is kept and annotated rather than dropped (issue #151 review r1).
  readonly severity: Severity;
  // The answered finding's path and proposed patch — a re-raise RELOCATED to another file, or one
  // whose proposed fix changed, carries something new and is kept, not dropped (issue #151 review
  // r3). patch is null when the answered finding carried none. The LINE is deliberately NOT part of
  // the predicate: positional drift (a rebase moving the same claim) is not evidence, while a
  // genuinely new instance changes the claim text.
  readonly path: string;
  readonly patch: string | null;
  readonly answerUrl: string;
  readonly answerAuthor: string | null;
}

// A systemic problem has no location or fix: its claim is its text and its weight, and it binds by
// its own id alone — it carries no path to synthesize one from.
export type AnsweredSystemicEntry = Omit<AnsweredEntry, "path" | "patch">;

// Each closing answer paired with the prior item its id names: the verbatim comparison is against
// what the prior round reported. A closure naming no prior item has no claim to compare and pairs
// with nothing.
const closedPriorItems = <Item>(
  closures: readonly Response[],
  items: readonly Item[],
  idOf: (item: Item) => string | undefined,
): readonly (readonly [Item, Response])[] =>
  closures.flatMap((response) => {
    const item = items.find((candidate) => idOf(candidate) === response.id);
    return item === undefined ? [] : [[item, response] as const];
  });

const closedClaim = (
  item: Pick<SystemicProblem, "title" | "description" | "reasoning" | "severity">,
  response: Response,
): AnsweredSystemicEntry => ({
  code: response.id,
  title: item.title,
  description: item.description,
  reasoning: item.reasoning,
  severity: item.severity,
  answerUrl: response.source_url,
  answerAuthor: response.author,
});

export const answeredRegistryFrom = (
  closures: readonly Response[],
  prior: Findings | null,
): readonly AnsweredEntry[] =>
  closedPriorItems(closures, prior?.findings ?? [], resolveFindingId).map(
    ([finding, response]) => ({
      ...closedClaim(finding, response),
      path: finding.path,
      patch: finding.patch ?? null,
    }),
  );

export const answeredSystemicRegistryFrom = (
  closures: readonly Response[],
  prior: Findings | null,
): readonly AnsweredSystemicEntry[] =>
  closedPriorItems(closures, prior?.systemic_problems ?? [], resolveSystemicId).map(
    ([systemic, response]) => closedClaim(systemic, response),
  );

// The id match: 0.10 requires every finding to carry an id, and the legacy upcast gives every pre-id
// finding one (code → id, or synthesized), so two rounds of the same claim always key to equal ids.
// An EMPTY id resolves exactly the way the registry builder resolves a prior finding — the two sides
// share resolveFindingId, so a verbatim re-raise of an empty-id finding still matches the entry its
// prior finding synthesized. A TITLE match is the second chance the pre-0.10 "code (or title)" rule gave,
// RESTRICTED to entries whose code was synthesized (isSynthesizedFindingId): a codeless claim whose
// answer pre-dates ids can only recover its annotation when the re-raise is RELOCATED (the
// synthesized key is path-derived) or carries a fresh agent id — while an unrelated same-title entry
// with a real code can never mis-bind. The full-claim verbatim check still gates the drop.
const isSynthesizedTitleMatch = (f: Finding, e: Pick<AnsweredEntry, "code" | "title">): boolean =>
  isSynthesizedFindingId(e.code) && e.title === f.title;

const matches = (
  resolvedId: string,
  f: Finding,
  e: Pick<AnsweredEntry, "code" | "title">,
): boolean => e.code === resolvedId || isSynthesizedTitleMatch(f, e);

// Whether an answer naming this id could match any of the findings or systemic problems, before its
// claim is known: by id, or — a synthesized id only — by the title second chance, which needs the
// prior's title to decide.
export const couldMatch = (
  code: string,
  doc: Pick<Findings, "findings" | "systemic_problems">,
): boolean =>
  isSynthesizedFindingId(code) ||
  doc.findings.some((f) => resolveFindingId(f) === code) ||
  (doc.systemic_problems ?? []).some((s) => resolveSystemicId(s) === code);

// The ONE verbatim claim-field list: the six per-field comparisons consumed by both the full-claim
// predicate and the title-second-chance scorer. The VerbatimPick type DERIVES from the array, so
// adding a claim field is a single edit the compiler verifies — the type and the runtime list can
// never diverge (the same one-definition discipline as answeredNoteKey below).
const CLAIM_FIELDS = ["title", "description", "reasoning", "severity"] as const;
const VERBATIM_FIELDS = [...CLAIM_FIELDS, "path", "patch"] as const;
type VerbatimPick = Pick<AnsweredEntry, (typeof VERBATIM_FIELDS)[number]>;

const verbatimFieldEqual = (
  f: Finding,
  e: VerbatimPick,
  field: (typeof VERBATIM_FIELDS)[number],
): boolean => (field === "patch" ? (f.patch ?? null) === e.patch : f[field] === e[field]);

// A rebuttal answers the response the prior round's finding received, so a re-raise carrying one is
// never verbatim, however unchanged its claim fields are.
const isVerbatimReRaise = (f: Finding, e: VerbatimPick): boolean =>
  !hasRebuttal(f) && VERBATIM_FIELDS.every((field) => verbatimFieldEqual(f, e, field));

// Would post's answered-filter DROP this finding?
const isAnsweredDrop = (
  resolvedId: string,
  f: Finding,
  e: Pick<
    AnsweredEntry,
    "code" | "title" | "description" | "reasoning" | "severity" | "path" | "patch"
  >,
): boolean => matches(resolvedId, f, e) && isVerbatimReRaise(f, e) && f.severity !== "critical";

// How many of the verbatim claim fields a finding shares with an entry — the title-second-chance
// scorer: among several synthesized same-title entries (same title, different paths — their
// synthesized ids differ), the entry sharing the MOST fields is the answer the claim came from, so
// a kept re-raise's annotation link binds it rather than the first same-title entry in registry
// order.
const verbatimMatchCount = (f: Finding, e: VerbatimPick): number =>
  VERBATIM_FIELDS.reduce((count, field) => count + (verbatimFieldEqual(f, e, field) ? 1 : 0), 0);

// The ONE note-key contract: a finding's annotation key is its id; an empty id (a pre-id prior
// finding, or a reviewer-supplied empty id) falls back to "title:<title>" so the note still keys to
// something — written once here, consumed by applyAnswered and both renderers, so the
// key can never drift between the writer and the lookups (issue #151 review r2).
export const answeredNoteKey = (f: { id: string; title: string }): string =>
  f.id !== "" ? f.id : `title:${f.title}`;

// The title second chance, run ONLY on an id miss (the common case pays nothing): the synthesized
// same-title entry sharing the most verbatim claim fields, ties keeping registry order. Scored in
// one pass — each candidate once, strict > preserves the first on ties.
const bestTitleMatch = (
  f: Finding,
  registry: readonly AnsweredEntry[],
): AnsweredEntry | undefined => {
  let best: AnsweredEntry | undefined;
  let bestScore = -1;
  for (const e of registry) {
    if (!isSynthesizedTitleMatch(f, e)) continue;
    const score = verbatimMatchCount(f, e);
    if (score > bestScore) {
      best = e;
      bestScore = score;
      if (score === VERBATIM_FIELDS.length) break;
    }
  }
  return best;
};

// The author is a GitHub login or none; a code span keeps whatever it holds inert as markdown.
const byAuthor = (e: Pick<AnsweredEntry, "answerAuthor">): string =>
  e.answerAuthor === null ? "" : ` by \`${escapeCodeBackticks(e.answerAuthor)}\``;

// The per-finding "re-raised; prior answer at <link>" annotation for a kept (changed-evidence)
// re-raise of a closed finding: it links the answer and demands the new evidence be named.
const answeredNote = (e: Pick<AnsweredEntry, "answerUrl" | "answerAuthor">): string =>
  `Re-raised; prior answer at ${linkSafeUrl(e.answerUrl)}${byAuthor(e)} — cite the new evidence that invalidates it.`;

export interface AnsweredFilter {
  readonly findings: readonly Finding[];
  // code → note for KEPT re-raises with changed evidence; rendered under each such finding.
  readonly reRaisedNotes: Readonly<Record<string, string>>;
  // The entries whose findings were dropped: verbatim re-raises of an answered finding, named in the
  // sticky rather than silently vanishing. DEDUPED by ENTRY — several findings dropped against one
  // answer (an id repeated within a round, or same-title fresh-id re-raises of a synthesized entry)
  // list the answer once, never double-counted (issue #151 review r2).
  readonly verbatimReRaised: readonly AnsweredEntry[];
  // The dropped FINDINGS' ids (resolved): post strips these from systemic finding_ids — a title-
  // matched drop keys the entry's synthesized code, but the systemic list names the finding's own id,
  // so stripping by entry code alone would dangle a dropped finding (the two sides must agree on what
  // a drop removes).
  readonly droppedFindingIds: readonly string[];
  // The TRUE count of dropped findings (pre-dedup): the sticky's count must not understate the
  // suppression just because several findings shared one code (issue #151 review r5).
  readonly droppedCount: number;
}

// The deterministic backstop: an answered finding re-raised VERBATIM
// (identical title, description, and reasoning — no new evidence by definition) is treated as closed
// and dropped from this review, so the round's counts and stop signal reflect the dismissal. The
// claim TEXT is the evidence: a change to any of title/description/reasoning, or to the severity,
// means the re-raise carries something new and MUST be kept + annotated (issue #151 review r2 — the
// SPEC's "no new evidence" criterion, not just a title+reasoning byte-match). A re-raise carrying a
// non-blank rebuttal is kept too. A critical is never dropped — the pipeline must not suppress a
// critical from the surfaced review.
export const applyAnswered = (
  findings: readonly Finding[],
  registry: readonly AnsweredEntry[],
): AnsweredFilter => {
  const kept: Finding[] = [];
  // Built via Object.fromEntries (CreateDataProperty): a reviewer-supplied code like "__proto__"
  // must become an OWN data key, never a prototype write that silently no-ops the annotation (the
  // same invariant the codebase's other code-keyed maps hold — issue #151 review r1).
  const noteEntries: [string, string][] = [];
  const droppedByEntry = new Map<string, AnsweredEntry>();
  const droppedFindingIds: string[] = [];
  let droppedCount = 0;
  for (const f of findings) {
    // ID match first across the WHOLE registry, title second chance only against synthesized
    // entries: a finding title-matching an unrelated entry ahead of its true id-matched entry must
    // not mis-bind its annotation (the id match wins wherever it exists). The second chance picks
    // the synthesized same-title entry sharing the MOST verbatim claim fields (ties keep registry
    // order), so two codeless same-title answers under different paths cannot mis-bind a kept
    // re-raise. The chosen entry alone feeds the drop decision, through isAnsweredDrop (rebuttal rule
    // included). Because the scorer picks the entry, it changes suppression, not just annotation.
    const resolvedId = resolveFindingId(f);
    const idMatch = registry.find((e) => e.code === resolvedId);
    const titleMatch = idMatch === undefined ? bestTitleMatch(f, registry) : undefined;
    const entry = idMatch ?? titleMatch;
    if (entry === undefined) {
      kept.push(f);
      continue;
    }
    // The full claim: text (title/description/reasoning), weight (severity), AND location/fix
    // (path, patch) — a re-raise relocated to another file or proposing a different fix carries
    // something new. The line is deliberately excluded: positional drift (a rebase moving the same
    // claim) is not evidence (issue #151 review r3). patch is normalized (undefined → null) so an
    // absent patch on both sides compares equal. Both paths ask isAnsweredDrop, rebuttal rule
    // included.
    const dropped = isAnsweredDrop(resolvedId, f, entry);
    if (dropped) {
      droppedByEntry.set(entry.code, entry);
      droppedFindingIds.push(resolvedId);
      droppedCount += 1;
    } else {
      kept.push(f);
      noteEntries.push([answeredNoteKey(f), answeredNote(entry)]);
    }
  }
  return {
    findings: kept,
    reRaisedNotes: Object.fromEntries(noteEntries),
    verbatimReRaised: [...droppedByEntry.values()],
    droppedFindingIds,
    droppedCount,
  };
};

// A systemic problem's note key, apart from every finding's: an id a new finding shares with an
// annotated systemic never inherits its note.
export const answeredSystemicNoteKey = (s: {
  readonly id?: string;
  readonly title: string;
}): string => `systemic:${resolveSystemicId(s) ?? ""}`;

export interface AnsweredSystemicFilter {
  readonly systemic: readonly SystemicProblem[];
  readonly reRaisedNotes: Readonly<Record<string, string>>;
  readonly verbatimReRaised: readonly AnsweredSystemicEntry[];
  readonly droppedCount: number;
}

type SystemicVerdict =
  | { readonly kind: "unanswered"; readonly systemic: SystemicProblem }
  | {
      readonly kind: "dropped" | "annotated";
      readonly systemic: SystemicProblem;
      readonly entry: AnsweredSystemicEntry;
    };

const systemicVerdict = (
  systemic: SystemicProblem,
  registry: readonly AnsweredSystemicEntry[],
): SystemicVerdict => {
  const entry = registry.find((e) => e.code === resolveSystemicId(systemic));
  return entry === undefined
    ? { kind: "unanswered", systemic }
    : {
        kind:
          !hasRebuttal(systemic) &&
          systemic.severity !== "critical" &&
          CLAIM_FIELDS.every((field) => systemic[field] === entry[field])
            ? "dropped"
            : "annotated",
        systemic,
        entry,
      };
};

// applyAnswered's rule for systemic problems, by id alone: a closed id re-raised with its claim
// unchanged and no rebuttal is dropped, any other re-raise of it is kept and annotated, and a
// critical is never dropped.
export const applyAnsweredSystemic = (
  systemic: readonly SystemicProblem[],
  registry: readonly AnsweredSystemicEntry[],
): AnsweredSystemicFilter => {
  const verdicts = systemic.map((s) => systemicVerdict(s, registry));
  const dropped = verdicts.flatMap((v) => (v.kind === "dropped" ? [v.entry] : []));
  return {
    systemic: verdicts.flatMap((v) => (v.kind === "dropped" ? [] : [v.systemic])),
    reRaisedNotes: Object.fromEntries(
      verdicts.flatMap((v) =>
        v.kind === "annotated"
          ? [[answeredSystemicNoteKey(v.systemic), answeredNote(v.entry)] as const]
          : [],
      ),
    ),
    verbatimReRaised: [...new Map(dropped.map((e) => [e.code, e])).values()],
    droppedCount: dropped.length,
  };
};

// The sticky note naming what was dropped — the suppression is never silent (SPEC §3.3 truthful).
// The COUNT is the true pre-dedup finding count (several findings sharing one code count as several
// suppressions); the LINES stay deduped by key (issue #151 review r5). count is REQUIRED — a
// default would silently reintroduce the understated count for a caller that forgets it (issue
// #151 review r7).
export const answeredReRaiseNote = (
  entries: readonly Pick<AnsweredEntry, "code" | "title" | "answerUrl" | "answerAuthor">[],
  count: number,
): string => {
  if (entries.length === 0) return "";
  const label = (e: Pick<AnsweredEntry, "code" | "title">): string =>
    e.code !== "" ? `\`${escapeCodeBackticks(e.code)}\`` : `“${escapeCodeBackticks(e.title)}”`;
  const lines = entries.map(
    (e) => `> - ${label(e)} — [prior answer](${linkSafeUrl(e.answerUrl)})${byAuthor(e)}`,
  );
  return [
    `> ↩️ **${String(count)} finding(s) re-raised without new evidence — treated as answered** (a maintainer refuted or dismissed each):`,
    ...lines,
  ].join("\n");
};
